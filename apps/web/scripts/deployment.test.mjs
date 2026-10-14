// @vitest-environment node
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clerkFrontendApi,
  DEPLOYMENT_EXAMPLE_FILE,
  DEPLOYMENT_FIELDS,
  parseDeployment,
  readDeployment,
  readDeploymentFile,
  writeDeploymentFile,
} from "./deployment.mjs";

const PEM = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).publicKey;

/** A publishable key is the Clerk host, base64-encoded with a trailing `$`. */
function publishableKey(host, kind = "test") {
  return `pk_${kind}_${Buffer.from(`${host}$`).toString("base64")}`;
}

const VALID = {
  d1DatabaseName: "oncue-hosted",
  d1DatabaseId: "11111111-2222-4333-8444-555555555555",
  r2BucketName: "oncue-hosted-artifacts",
  clerkPublishableKey: publishableKey("example.clerk.accounts.dev"),
  clerkJwtKey: PEM,
};

function tempFile(contents) {
  const path = join(mkdtempSync(join(tmpdir(), "oncue-deployment-")), "deployment.json");
  if (contents !== undefined) {
    writeFileSync(path, contents);
  }
  return path;
}

describe("parseDeployment", () => {
  it("accepts a complete deployment and returns it unchanged", () => {
    expect(parseDeployment(VALID)).toEqual(VALID);
  });

  it("keeps the PEM's line breaks, which are part of the key", () => {
    expect(parseDeployment(VALID).clerkJwtKey).toBe(PEM);
    expect(PEM.endsWith("\n")).toBe(true);
  });

  it("trims stray whitespace around the plain values", () => {
    expect(parseDeployment({ ...VALID, d1DatabaseId: ` ${VALID.d1DatabaseId}\n` })).toEqual(VALID);
  });

  it("refuses the example file as it ships, naming every empty value at once", () => {
    const example = JSON.parse(readFileSync(DEPLOYMENT_EXAMPLE_FILE, "utf8"));
    expect(() => parseDeployment(example)).toThrow(
      /"d1DatabaseId".*"clerkPublishableKey".*"clerkJwtKey"/,
    );
  });

  it("refuses an unknown field, so a secret cannot be parked in the file", () => {
    expect(() => parseDeployment({ ...VALID, ONCUE_BROKER_KEYRING: "1:abc" })).toThrow(
      'unknown field "ONCUE_BROKER_KEYRING"',
    );
  });

  it.each(["d1DatabaseName", "r2BucketName"])("refuses an empty %s", (name) => {
    expect(() => parseDeployment({ ...VALID, [name]: "  " })).toThrow(`"${name}" is empty`);
    expect(() => parseDeployment({ ...VALID, [name]: 7 })).toThrow(`"${name}" is empty`);
  });

  it.each(["", "local-placeholder-db-id", "oncue-hosted"])("refuses %j as a database id", (id) => {
    expect(() => parseDeployment({ ...VALID, d1DatabaseId: id })).toThrow('"d1DatabaseId"');
  });

  it.each(["", "sk_test_abc", "pk_test_"])("refuses %j as a publishable key", (key) => {
    expect(() => parseDeployment({ ...VALID, clerkPublishableKey: key })).toThrow(
      '"clerkPublishableKey"',
    );
  });

  it("accepts a production Clerk application's key", () => {
    const key = publishableKey("clerk.example.com", "live");
    expect(parseDeployment({ ...VALID, clerkPublishableKey: key }).clerkPublishableKey).toBe(key);
  });

  it.each(["", "not a key", undefined])(
    "refuses %j as the JWT key and says how to get one",
    (key) => {
      expect(() => parseDeployment({ ...VALID, clerkJwtKey: key })).toThrow(
        "pnpm clerk:jwt-key --write",
      );
    },
  );
});

describe("the deployment file", () => {
  it("says to copy the example when there is no file", () => {
    expect(() => readDeploymentFile(tempFile())).toThrow("deployment.example.json");
  });

  it("refuses a file that is not JSON", () => {
    expect(() => readDeploymentFile(tempFile("{ d1DatabaseName: "))).toThrow("not valid JSON");
  });

  it.each(["[]", "null", '"text"'])("refuses %s, which is not an object", (text) => {
    expect(() => readDeploymentFile(tempFile(text))).toThrow("one JSON object");
  });

  it("round-trips a deployment, PEM included", () => {
    const path = tempFile();
    writeDeploymentFile(VALID, path);
    expect(readDeployment(path)).toEqual(VALID);
  });

  it("reads an incomplete file as written, for the step that completes it", () => {
    const path = tempFile(JSON.stringify({ clerkPublishableKey: VALID.clerkPublishableKey }));
    expect(readDeploymentFile(path)).toEqual({ clerkPublishableKey: VALID.clerkPublishableKey });
    expect(() => readDeployment(path)).toThrow("apps/web/deployment.json:");
  });

  it("ships an example naming exactly the fields a deployment has", () => {
    const example = JSON.parse(readFileSync(DEPLOYMENT_EXAMPLE_FILE, "utf8"));
    expect(Object.keys(example)).toEqual(DEPLOYMENT_FIELDS);
  });
});

describe("clerkFrontendApi", () => {
  it("decodes the host from a development key", () => {
    expect(clerkFrontendApi(publishableKey("example.clerk.accounts.dev"))).toBe(
      "example.clerk.accounts.dev",
    );
  });

  it("decodes the host from a production key", () => {
    expect(clerkFrontendApi(publishableKey("clerk.example.com", "live"))).toBe("clerk.example.com");
  });

  it("tolerates a key encoded without the trailing marker", () => {
    const key = `pk_test_${Buffer.from("example.clerk.accounts.dev").toString("base64")}`;
    expect(clerkFrontendApi(key)).toBe("example.clerk.accounts.dev");
  });

  it("refuses anything that is not a publishable key", () => {
    expect(() => clerkFrontendApi("sk_test_abc")).toThrow("not a Clerk publishable key");
  });

  it("refuses a key that decodes to something other than a host", () => {
    const key = `pk_test_${Buffer.from("evil.example/path?x=$").toString("base64")}`;
    expect(() => clerkFrontendApi(key)).toThrow("does not decode to a host name");
  });
});
