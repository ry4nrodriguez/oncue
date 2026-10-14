// The session object keeps only the bootstrap credential's SHA-256, so a test
// that seeds a session row directly seeds the hash too. `TEST_BOOTSTRAP` is a
// fixture shaped like a minted value.

import { runInDurableObject } from "cloudflare:test";
import type { SessionObject } from "../index";

export const TEST_BOOTSTRAP = "test-bootstrap-credential";

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Records `credential` as the bootstrap credential for `generation`, the way `provisionSandbox` does, and returns it. */
export async function seedBridgeCredential(
  stub: DurableObjectStub<SessionObject>,
  generation: number,
  credential: string = TEST_BOOTSTRAP,
): Promise<string> {
  const hash = await sha256Hex(credential);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "INSERT OR REPLACE INTO bridge_credential (generation, credential_sha256, created_at) VALUES (?,?,?)",
      generation,
      hash,
      new Date().toISOString(),
    );
  });
  return credential;
}
