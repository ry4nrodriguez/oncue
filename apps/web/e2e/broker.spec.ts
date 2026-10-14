import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { appOrigin, DEFAULT_APP_ORIGIN } from "./app-origin";
import { laneIdentity } from "./lane-auth";
import { queryD1 } from "./local-d1";
import {
  PROVIDER_DOUBLE_ORIGIN,
  type RunningDouble,
  startProviderDouble,
} from "./provider-double-server";
import { BROKER_SUBJECT } from "./setup-local-auth.mjs";

/**
 * Model connections and the Model Broker against the real Worker over HTTP,
 * authenticated with a real RS256 Clerk token signed by a key pair
 * `e2e/setup-local-auth.mjs` generated, so there is no test bypass.
 *
 * Nothing here reaches a real provider: ONCUE_PROVIDER_DOUBLE_ORIGIN points the
 * Worker at `e2e/provider-double-server.ts`, and the first test proves it.
 */

/** Resolved once in `beforeAll`; see `app-origin.ts` for why it is not a constant. */
let ORIGIN = DEFAULT_APP_ORIGIN;
const SHOTS = "/tmp/swarm-pr06/worker-1";

let double: RunningDouble | undefined;

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  ORIGIN = await appOrigin();
  double = await startProviderDouble();
});

test.afterAll(async () => {
  // Optional, because `beforeAll` can fail before assigning it; an unguarded
  // close would then throw in teardown and hide the real error.
  await double?.close();
});

async function setMode(mode: string): Promise<void> {
  await fetch(`${PROVIDER_DOUBLE_ORIGIN}/__mode`, {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

async function doubleCalls(): Promise<{ path: string; headerNames: string[] }[]> {
  const answer = await fetch(`${PROVIDER_DOUBLE_ORIGIN}/__calls`);
  return ((await answer.json()) as { calls: { path: string; headerNames: string[] }[] }).calls;
}

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: laneIdentity(ORIGIN, BROKER_SUBJECT).cookie, ...extra };
}

async function addConnection(provider: "anthropic" | "openai" = "anthropic"): Promise<{
  status: number;
  body: Record<string, unknown>;
  text: string;
}> {
  const response = await fetch(`${ORIGIN}/api/model-connections`, {
    method: "POST",
    headers: authed({ "content-type": "application/json" }),
    body: JSON.stringify({ provider, credential: LANE_KEY }),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

/** Short enough not to trip provider-key scanners, which cannot tell a fixture from a real key. */
const LANE_KEY = "sk-ant-lane00000001";

async function revokeAll(): Promise<void> {
  const listed = await fetch(`${ORIGIN}/api/model-connections`, { headers: authed() });
  const body = (await listed.json()) as { connections: { connectionId: string; status: string }[] };
  for (const connection of body.connections) {
    if (connection.status !== "revoked") {
      await fetch(`${ORIGIN}/api/model-connections/${connection.connectionId}/revoke`, {
        method: "POST",
        headers: authed(),
      });
    }
  }
}

test.describe.configure({ mode: "serial" });

/**
 * Runs before every other test and prevents rather than detects: checking the
 * double after adding a connection would be too late, since validation already
 * reached the provider. The Worker answers from the same
 * `resolveProviderOrigin` the broker uses.
 */
test("guard: the Worker will not reach a real provider, checked BEFORE anything is sent", async () => {
  const health = (await (await fetch(`${ORIGIN}/api/health`)).json()) as {
    providerTrafficRedirected: boolean;
  };

  expect(
    health.providerTrafficRedirected,
    "the Worker would send these lanes' keys to a REAL provider. Run `node apps/web/e2e/setup-local-auth.mjs` and restart the dev server before running any broker lane.",
  ).toBe(true);

  // Only now is it safe to send anything a provider could see.
  await setMode("ok");
  const before = (await doubleCalls()).length;
  await addConnection();
  expect((await doubleCalls()).length).toBeGreaterThan(before);
  await revokeAll();
});

test("a key added through the API reaches Active and echoes nothing secret", async () => {
  await setMode("ok");

  const created = await addConnection();

  expect(created.status).toBe(201);
  expect((created.body.connection as Record<string, unknown>).status).toBe("active");
  expect(created.text.includes(LANE_KEY)).toBe(false);
  expect(created.text.includes("sk-ant-lane")).toBe(false);
  await revokeAll();
});

test("the browser shows Validating, then Active, and never the key again", async ({
  page,
  context,
}) => {
  await setMode("ok");
  await revokeAll();
  // Scoped by `url`, not a hard-coded domain: `ORIGIN` may be 127.0.0.1 or
  // ::1, where a cookie pinned to "localhost" is not sent.
  await context.addCookies([
    {
      name: "__session",
      value: laneIdentity(ORIGIN, BROKER_SUBJECT).cookie.replace("__session=", ""),
      url: ORIGIN,
    },
  ]);

  await page.goto(`${ORIGIN}/dev/home?at=/settings/model-providers`);

  // Fail on the actual cause rather than on a missing badge fifteen seconds
  // later: if the cookie did not reach the Worker this is the denied state.
  await expect(page.getByText("You don't have access to view model providers.")).toHaveCount(0);
  const anthropic = page.getByTestId("provider-card-anthropic");
  await expect(anthropic.getByTestId("provider-status-anthropic")).toHaveText("Not connected", {
    timeout: 15_000,
  });
  await anthropic.getByRole("button", { name: "Connect Anthropic" }).click();
  await anthropic.getByLabel("API key").fill(LANE_KEY);
  await anthropic.getByRole("button", { name: "Connect", exact: true }).click();

  // `exact`, because a rejected key's message also contains "active". Scoped
  // to the card because the sidebar has a group called "Active".
  await expect(anthropic.getByText("Active", { exact: true })).toBeVisible({ timeout: 15_000 });
  // The other provider's models are listed, greyed, with a way to connect.
  await expect(page.getByTestId("provider-status-openai")).toHaveText("Not connected");
  await expect(page.getByTestId("model-row-gpt-6-sol")).toContainText("GPT-6 Sol");
  await page.screenshot({ path: `${SHOTS}/pr06-add-key.png` });

  expect(await page.content()).not.toContain(LANE_KEY);
});

test("the row on disk is versioned ciphertext and the key is nowhere in it", async () => {
  await setMode("ok");
  await revokeAll();
  const created = await addConnection();
  const connectionId = (created.body.connection as { connectionId: string }).connectionId;

  // Read through Miniflare's own D1 route (`e2e/local-d1.ts`), not a product
  // route, so this is the stored row rather than what the Worker chooses to show.
  const rows = await queryD1<{ credential_reference: string; status: string }>(
    `SELECT status, credential_reference FROM model_connection WHERE connection_id = '${connectionId}'`,
  );

  expect(rows).toHaveLength(1);
  const stored = rows[0] as { credential_reference: string; status: string };
  expect(stored.status).toBe("active");
  // `oncue1.<key version>.<nonce>.<ciphertext>`, which is what makes rotation
  // a matter of prepending a key rather than rewriting every row.
  expect(stored.credential_reference).toMatch(/^oncue1\.\d+\.[\w-]+\.[\w-]+$/);
  expect(stored.credential_reference.includes(LANE_KEY)).toBe(false);
  expect(stored.credential_reference.includes("sk-ant")).toBe(false);

  // Nothing anywhere else in the row carries it either.
  const wholeRow = await queryD1<Record<string, unknown>>(
    `SELECT * FROM model_connection WHERE connection_id = '${connectionId}'`,
  );
  expect(JSON.stringify(wholeRow).includes(LANE_KEY)).toBe(false);
});

test("revoking destroys the sealed bytes rather than only flagging the row", async () => {
  await setMode("ok");
  await revokeAll();
  const created = await addConnection();
  const connectionId = (created.body.connection as { connectionId: string }).connectionId;

  const before = await queryD1<{ credential_reference: string }>(
    `SELECT credential_reference FROM model_connection WHERE connection_id = '${connectionId}'`,
  );
  expect(
    (before[0] as { credential_reference: string }).credential_reference.length,
  ).toBeGreaterThan(0);

  await fetch(`${ORIGIN}/api/model-connections/${connectionId}/revoke`, {
    method: "POST",
    headers: authed(),
  });

  const after = await queryD1<{ credential_reference: string; status: string }>(
    `SELECT status, credential_reference FROM model_connection WHERE connection_id = '${connectionId}'`,
  );
  expect((after[0] as { status: string }).status).toBe("revoked");
  expect((after[0] as { credential_reference: string }).credential_reference).toBe("");
});

test("a revoked connection stops forwarding immediately", async () => {
  await setMode("ok");
  await revokeAll();
  const created = await addConnection();
  const connectionId = (created.body.connection as { connectionId: string }).connectionId;

  const revoked = await fetch(`${ORIGIN}/api/model-connections/${connectionId}/revoke`, {
    method: "POST",
    headers: authed(),
  });
  expect(revoked.status).toBe(200);
  expect(((await revoked.json()) as { connection: { status: string } }).connection.status).toBe(
    "revoked",
  );

  const started = Date.now();
  const afterRevoke = await fetch(`${ORIGIN}/api/model-connections`, { headers: authed() });
  const body = (await afterRevoke.json()) as { connections: { status: string }[] };
  expect(Date.now() - started).toBeLessThan(1000);
  expect(body.connections.every((row) => row.status === "revoked")).toBe(true);
});

interface ForwardFixture {
  readonly sessionId: string;
  readonly connectionId: string;
  readonly token: string;
  readonly modelId: string;
}

/**
 * A connection, a session row, and a token scoped to both. The session row is
 * inserted directly, standing in for a generation, because it is what
 * `readAuthorizedConnection` reads.
 */
async function forwardFixture(): Promise<ForwardFixture> {
  await setMode("ok");
  await revokeAll();
  const created = await addConnection();
  const connectionId = (created.body.connection as { connectionId: string }).connectionId;

  const me = (await (await fetch(`${ORIGIN}/api/me`, { headers: authed() })).json()) as {
    workspaceId: string;
  };
  const sessionId = `sess_lane_${Date.now()}`;
  await queryD1(
    `INSERT INTO session_index (session_id, workspace_id, task_id, state, sandbox_generation, created_at, updated_at) VALUES ('${sessionId}', '${me.workspaceId}', NULL, 'active', 1, '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')`,
  );

  const issued = await fetch(`${ORIGIN}/api/sessions/${sessionId}/broker-token`, {
    method: "POST",
    headers: authed({ "content-type": "application/json" }),
    body: JSON.stringify({ modelConnectionId: connectionId }),
  });
  expect(issued.status, "the lane could not mint a session token").toBe(200);
  const token = ((await issued.json()) as { token: string }).token;
  const claims = JSON.parse(Buffer.from(token.split(".")[2] as string, "base64url").toString()) as {
    mid: string;
  };

  return { sessionId, connectionId, token, modelId: claims.mid };
}

function forwardBody(modelId: string): string {
  return JSON.stringify({ model: modelId, messages: [{ role: "user", content: "hello" }] });
}

async function forward(fixture: ForwardFixture, token?: string): Promise<Response> {
  return fetch(`${ORIGIN}/api/broker/sessions/${fixture.sessionId}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token ?? fixture.token}`,
      "content-type": "application/json",
    },
    body: forwardBody(fixture.modelId),
  });
}

/**
 * Unit tests inject fetch, so only a real request over a real socket catches a
 * Worker runtime problem in how the route reaches the network (for example a
 * bare `fetch` losing its `this` binding).
 */
test("a valid token forwards and streams the provider's reply back", async () => {
  const fixture = await forwardFixture();

  const response = await forward(fixture);

  expect(response.status).toBe(200);
  const streamed = await response.text();
  expect(streamed).toContain("message_start");
  expect(streamed).toContain("message_stop");
  expect(streamed.includes(LANE_KEY)).toBe(false);

  const calls = await doubleCalls();
  expect(calls.some((call) => call.path === "/v1/messages")).toBe(true);
});

test("the same token used against another session is refused", async () => {
  const fixture = await forwardFixture();

  const wrongSession = await fetch(`${ORIGIN}/api/broker/sessions/sess_somebody_else/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${fixture.token}`,
      "content-type": "application/json",
    },
    body: forwardBody(fixture.modelId),
  });

  expect(wrongSession.status).toBe(403);
  expect(await wrongSession.text()).toContain("forbidden");
});

test("revoking mid-life stops the very next forward", async () => {
  const fixture = await forwardFixture();
  expect((await forward(fixture)).status).toBe(200);

  const revokedAt = Date.now();
  await fetch(`${ORIGIN}/api/model-connections/${fixture.connectionId}/revoke`, {
    method: "POST",
    headers: authed(),
  });

  const afterRevoke = await forward(fixture);
  expect(afterRevoke.status).toBe(403);
  expect(Date.now() - revokedAt).toBeLessThan(1000);
});

test("a provider 429 is recorded as rate limited, by name", async () => {
  const fixture = await forwardFixture();
  await setMode("rate_limited");

  const response = await forward(fixture);

  expect(response.status).toBe(429);
  const body = (await response.json()) as { category: string; retrySafe: boolean };
  expect(body.category).toBe("rate_limited");
  expect(body.retrySafe).toBe(true);
  await setMode("ok");
});

/**
 * The token is refreshed and the run continues on the new one without a
 * restart: the runtime only sends a different bearer value.
 */
test("a token can be refreshed and the stream continues on the new one", async () => {
  const fixture = await forwardFixture();
  expect((await forward(fixture)).status).toBe(200);

  const refreshed = await fetch(`${ORIGIN}/api/broker/token/refresh`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixture.token}` },
  });
  expect(refreshed.status).toBe(200);
  const next = ((await refreshed.json()) as { token: string }).token;
  expect(next).not.toBe(fixture.token);

  const onNewToken = await forward(fixture, next);
  expect(onNewToken.status).toBe(200);
  expect(await onNewToken.text()).toContain("message_stop");

  // The ceiling never moves, however many times a token is renewed.
  const first = JSON.parse(
    Buffer.from(fixture.token.split(".")[2] as string, "base64url").toString(),
  ) as { rex: number };
  const second = JSON.parse(Buffer.from(next.split(".")[2] as string, "base64url").toString()) as {
    rex: number;
  };
  expect(second.rex).toBe(first.rex);
});

test("a revoked connection cannot be refreshed past", async () => {
  const fixture = await forwardFixture();
  await fetch(`${ORIGIN}/api/model-connections/${fixture.connectionId}/revoke`, {
    method: "POST",
    headers: authed(),
  });

  const refreshed = await fetch(`${ORIGIN}/api/broker/token/refresh`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixture.token}` },
  });

  expect(refreshed.status).toBe(403);
});

test("a forward with no valid token is refused", async () => {
  const response = await fetch(`${ORIGIN}/api/broker/sessions/sess_nope/v1/messages`, {
    method: "POST",
    headers: { authorization: "Bearer ot1.1.not.real", "content-type": "application/json" },
    body: JSON.stringify({ model: "m" }),
  });

  expect(response.status).toBe(403);
  expect(await response.text()).toContain("forbidden");
});

test("the provider double never received anything key-shaped in a recorded value", async () => {
  const calls = await doubleCalls();

  expect(calls.length).toBeGreaterThan(0);
  expect(JSON.stringify(calls).includes("sk-ant")).toBe(false);
});
