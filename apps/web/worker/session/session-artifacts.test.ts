// The object's artifact policy (record 03): a declaration gets a one-time
// upload grant or `artifact.failed`, and the upload endpoint's calls back into
// the object are driven directly. The bytes are `worker/artifacts/upload.test.ts`'s.

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ARTIFACT_LIMITS } from "../artifacts/policy";
import { sha256Hex } from "../test/bridge-credential";
import {
  ageProbe,
  ageStop,
  connectBridge,
  dispatchRows,
  eventsOfType,
  eventTypes,
  finishRun,
  fireAlarm,
  MODAL_CREDENTIAL,
  probeRow,
  readyBridge,
  registerSessionWorlds,
  sessionOnRealDriver,
  settle,
  type TestBridge,
  waitFor,
} from "../test/session-world";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

type World = Awaited<ReturnType<typeof sessionOnRealDriver>>;

const MIB = 1024 * 1024;
const SHA256 = "ab".repeat(32);

async function callObject<T>(world: World, operation: string, body: unknown): Promise<T> {
  const response = await world.stub.fetch(`https://do/internal/artifacts/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as T;
}

function declare(
  bridge: TestBridge,
  artifactId: string,
  overrides: {
    declaredBytes?: number;
    kind?: "log" | "patch";
    producer?: "tool" | "checkpoint";
  } = {},
): void {
  bridge.send(
    bridge.event("artifact.uploading", {
      runId: "run_1",
      payload: {
        artifactId,
        kind: overrides.kind ?? "log",
        contentType: "text/plain",
        declaredBytes: overrides.declaredBytes ?? 1024,
        producer: overrides.producer ?? "tool",
      },
    }),
  );
}

async function grantFor(bridge: TestBridge, artifactId: string): Promise<Record<string, unknown>> {
  await waitFor(
    () => bridge.grants("upload").some((grant) => grant.artifactId === artifactId),
    `the upload grant for ${artifactId}`,
  );
  return bridge.grants("upload").find((grant) => grant.artifactId === artifactId) as Record<
    string,
    unknown
  >;
}

async function artifactRow(world: World, artifactId: string) {
  const rows = await runInDurableObject(world.stub, (_instance, state) => [
    ...state.storage.sql.exec<{ state: string; object_key: string; checksum: string | null }>(
      "SELECT state, object_key, checksum FROM artifact WHERE id = ?",
      artifactId,
    ),
  ]);
  return rows[0] ?? null;
}

async function accessRows(world: World, artifactId: string) {
  return runInDurableObject(world.stub, (_instance, state) => [
    ...state.storage.sql.exec<{ purpose: string; used_at: string | null; token_sha256: string }>(
      "SELECT purpose, used_at, token_sha256 FROM artifact_access WHERE artifact_id = ? ORDER BY rowid ASC",
      artifactId,
    ),
  ]);
}

const authorize = (world: World, artifactId: string, token: unknown, purpose = "upload") =>
  callObject<{ kind: string }>(world, "authorize", { artifactId, token, purpose });

describe("declaring an artifact", () => {
  it("within policy: a one-time grant, spent once, and a redelivered grant refused once the first was spent", async () => {
    const world = await sessionOnRealDriver("sess_artifact_grant");
    const bridge = await readyBridge(world);

    declare(bridge, "art_1");
    const grant = await grantFor(bridge, "art_1");
    const issuedAt = Date.now();
    expect(grant).toMatchObject({
      kind: "upload",
      sessionId: world.sessionId,
      sandboxGeneration: 1,
      artifactId: "art_1",
      url: `https://do/api/sessions/${world.sessionId}/artifacts/art_1`,
      maxBytes: 1024,
    });
    expect(Date.parse(String(grant.expiresAt)) - issuedAt).toBeLessThanOrEqual(
      ARTIFACT_LIMITS.tokenTtlMs,
    );
    expect(await artifactRow(world, "art_1")).toEqual({
      state: "uploading",
      object_key: `workspaces/ws_1/sessions/${world.sessionId}/runs/run_1/art_1`,
      checksum: null,
    });
    const access = await accessRows(world, "art_1");
    expect(access).toEqual([
      { purpose: "upload", used_at: null, token_sha256: expect.any(String) },
    ]);
    expect(access[0]?.token_sha256).not.toBe(grant.token);

    expect(await authorize(world, "art_1", grant.token)).toEqual({
      kind: "authorized",
      objectKey: `workspaces/ws_1/sessions/${world.sessionId}/runs/run_1/art_1`,
      contentType: "text/plain",
      declaredBytes: 1024,
    });
    expect(await authorize(world, "art_1", grant.token)).toEqual({ kind: "refused" });

    // The grant was never acknowledged, so a reconnecting bridge is sent it
    // again with a fresh token; that token cannot start a second upload.
    bridge.close();
    const again = await connectBridge(world);
    await again.hello();
    const redelivered = await grantFor(again, "art_1");
    expect(redelivered.token).not.toBe(grant.token);
    expect(await authorize(world, "art_1", redelivered.token)).toEqual({ kind: "refused" });

    const completed = await callObject<{ kind: string; index: Record<string, unknown> }>(
      world,
      "complete",
      { artifactId: "art_1", byteSize: 1024, sha256: SHA256 },
    );
    expect(completed).toEqual({
      kind: "created",
      index: {
        artifactId: "art_1",
        workspaceId: "ws_1",
        sessionId: world.sessionId,
        runId: "run_1",
        kind: "log",
        producer: "tool",
        contentType: "text/plain",
        byteSize: 1024,
        sha256: SHA256,
        classification: "temporary",
        objectKey: `workspaces/ws_1/sessions/${world.sessionId}/runs/run_1/art_1`,
        expiresAt: expect.any(String),
        createdAt: expect.any(String),
      },
    });
    expect(
      Date.parse(String(completed.index.expiresAt)) - Date.parse(String(completed.index.createdAt)),
    ).toBe(ARTIFACT_LIMITS.temporaryRetentionMs);
    expect((await eventsOfType(world.stub, "artifact.created"))[0]).toMatchObject({
      runId: "run_1",
      payload: {
        artifact: { artifactId: "art_1", kind: "log", byteSize: 1024, label: "Log" },
        checksum: { algorithm: "sha256", value: SHA256 },
        classification: "temporary",
      },
    });
    expect(await artifactRow(world, "art_1")).toMatchObject({ state: "created", checksum: SHA256 });
    expect(await callObject(world, "read", { artifactId: "art_1" })).toEqual({
      kind: "found",
      objectKey: `workspaces/ws_1/sessions/${world.sessionId}/runs/run_1/art_1`,
      contentType: "text/plain",
      artifactKind: "log",
      byteSize: 1024,
    });

    // Created is final: neither a second completion nor a failure changes it.
    expect(
      await callObject(world, "complete", { artifactId: "art_1", byteSize: 1024, sha256: SHA256 }),
    ).toEqual({ kind: "refused" });
    expect(
      await callObject(world, "fail", { artifactId: "art_1", stage: "upload", reason: "late" }),
    ).toEqual({ kind: "refused" });
    expect(await eventsOfType(world.stub, "artifact.failed")).toEqual([]);

    // A duplicate declaration is ignored.
    const rowsBefore = (await dispatchRows(world.stub)).length;
    declare(again, "art_1");
    await waitFor(
      async () => (await eventsOfType(world.stub, "artifact.uploading")).length >= 2,
      "the duplicate declaration",
    );
    await settle();
    expect((await dispatchRows(world.stub)).length).toBe(rowsBefore);
    expect(again.grants("upload")).toHaveLength(1);
  });

  it("over the per-artifact or per-run limit commits artifact.failed at authorize and sends no grant", async () => {
    const world = await sessionOnRealDriver("sess_artifact_limits");
    const bridge = await readyBridge(world);

    declare(bridge, "art_big", { declaredBytes: ARTIFACT_LIMITS.perArtifactBytes + 1 });
    await waitFor(
      async () => (await eventsOfType(world.stub, "artifact.failed")).length >= 1,
      "the refusal",
    );
    expect((await eventsOfType(world.stub, "artifact.failed"))[0]).toMatchObject({
      runId: "run_1",
      payload: {
        artifactId: "art_big",
        stage: "authorize",
        reason: expect.stringMatching(/byte limit for one artifact/),
        retryable: false,
      },
    });
    expect(await artifactRow(world, "art_big")).toMatchObject({ state: "failed" });

    for (const artifactId of ["art_a", "art_b", "art_c", "art_d"]) {
      declare(bridge, artifactId, { declaredBytes: 25 * MIB });
      await grantFor(bridge, artifactId);
    }
    declare(bridge, "art_e", { declaredBytes: 1 });
    await waitFor(
      async () => (await eventsOfType(world.stub, "artifact.failed")).length >= 2,
      "the per-run refusal",
    );
    expect((await eventsOfType(world.stub, "artifact.failed"))[1]?.payload).toMatchObject({
      artifactId: "art_e",
      stage: "authorize",
      reason: expect.stringMatching(/byte limit for one run/),
    });
    await settle();
    expect(bridge.grants("upload").map((grant) => grant.artifactId)).toEqual([
      "art_a",
      "art_b",
      "art_c",
      "art_d",
    ]);
  });
});

describe("spending a token", () => {
  it("refuses an unknown token, another artifact's token, the wrong purpose, and an expired one", async () => {
    const world = await sessionOnRealDriver("sess_artifact_refusals");
    const bridge = await readyBridge(world);
    declare(bridge, "art_x");
    declare(bridge, "art_y");
    const x = await grantFor(bridge, "art_x");
    const y = await grantFor(bridge, "art_y");

    expect(await authorize(world, "art_x", "not-a-token")).toEqual({ kind: "refused" });
    expect(await authorize(world, "art_missing", x.token)).toEqual({ kind: "refused" });
    expect(await authorize(world, "art_y", x.token)).toEqual({ kind: "refused" });
    expect(await authorize(world, "art_x", x.token, "restore")).toEqual({ kind: "refused" });
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE artifact_access SET expires_at_ms = ? WHERE artifact_id = 'art_y'",
        Date.now() - 1,
      );
    });
    expect(await authorize(world, "art_y", y.token)).toEqual({ kind: "refused" });
    expect(await authorize(world, "art_x", x.token)).toMatchObject({ kind: "authorized" });
  });

  it("refuses a redelivered token once the upload has failed, and reports what failed", async () => {
    const world = await sessionOnRealDriver("sess_artifact_failed_state");
    const bridge = await readyBridge(world);
    declare(bridge, "art_z");
    const first = await grantFor(bridge, "art_z");
    bridge.close();
    const again = await connectBridge(world);
    await again.hello();
    const second = await grantFor(again, "art_z");

    expect(await authorize(world, "art_z", first.token)).toMatchObject({ kind: "authorized" });
    expect(
      await callObject(world, "fail", {
        artifactId: "art_z",
        stage: "validate",
        reason: "The upload did not carry the declared length and a SHA-256 checksum.",
      }),
    ).toEqual({ kind: "failed" });
    expect((await eventsOfType(world.stub, "artifact.failed"))[0]).toMatchObject({
      runId: "run_1",
      payload: { artifactId: "art_z", stage: "validate", retryable: false },
    });
    expect(await artifactRow(world, "art_z")).toMatchObject({ state: "failed" });
    expect(await authorize(world, "art_z", second.token)).toEqual({ kind: "refused" });
    expect(await callObject(world, "read", { artifactId: "art_z" })).toEqual({ kind: "not_found" });
  });

  it("completion needs the declared size; a missing or unfinished artifact is neither completed, failed, nor readable", async () => {
    const world = await sessionOnRealDriver("sess_artifact_complete");
    const bridge = await readyBridge(world);
    declare(bridge, "art_m", { declaredBytes: 100 });
    const grant = await grantFor(bridge, "art_m");
    expect(await authorize(world, "art_m", grant.token)).toMatchObject({ kind: "authorized" });

    expect(
      await callObject(world, "complete", { artifactId: "art_m", byteSize: 99, sha256: SHA256 }),
    ).toEqual({ kind: "refused" });
    expect(
      await callObject(world, "complete", { artifactId: "art_none", byteSize: 1, sha256: SHA256 }),
    ).toEqual({ kind: "refused" });
    expect(
      await callObject(world, "fail", { artifactId: "art_none", stage: "upload", reason: "x" }),
    ).toEqual({ kind: "refused" });
    expect(await callObject(world, "read", { artifactId: "art_none" })).toEqual({
      kind: "not_found",
    });
    expect(await callObject(world, "read", { artifactId: "art_m" })).toEqual({ kind: "not_found" });
    expect(await eventsOfType(world.stub, "artifact.created")).toEqual([]);
  });

  it("a stop revokes an outstanding upload token, fails the upload that never started, and leaves one under way to its endpoint", async () => {
    const world = await sessionOnRealDriver("sess_artifact_revoked");
    const bridge = await readyBridge(world, 1, { closeOnShutdown: true });
    await finishRun(world, bridge);
    declare(bridge, "art_s");
    declare(bridge, "art_t");
    const grant = await grantFor(bridge, "art_s");
    const underWay = await grantFor(bridge, "art_t");
    expect(await authorize(world, "art_t", underWay.token)).toMatchObject({ kind: "authorized" });

    await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    );

    expect(
      (await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]?.payload,
    ).toMatchObject({
      grants: expect.arrayContaining([{ kind: "upload", outcome: "revoked" }]),
    });
    expect(await accessRows(world, "art_s")).toEqual([
      expect.objectContaining({ purpose: "upload", used_at: "revoked" }),
    ]);
    expect(await authorize(world, "art_s", grant.token)).toEqual({ kind: "refused" });
    // Never silently absent: nothing is left that could upload `art_s`, so it
    // is recorded as failed, and no longer counts against the run's budget.
    const failed = await eventsOfType(world.stub, "artifact.failed");
    expect(failed).toEqual([
      expect.objectContaining({
        runId: "run_1",
        payload: {
          artifactId: "art_s",
          stage: "upload",
          reason:
            "The sandbox ended before this artifact was uploaded, so the upload was cancelled.",
          retryable: false,
        },
      }),
    ]);
    expect(await artifactRow(world, "art_s")).toMatchObject({ state: "failed" });
    expect(await artifactRow(world, "art_t")).toMatchObject({ state: "uploading" });
    const types = await eventTypes(world.stub);
    expect(types.indexOf("artifact.failed")).toBeLessThan(
      types.indexOf("sandbox.credentials_revoked"),
    );
  });

  it("a stop revokes the generation's restore tokens too, and a token of an ended generation is refused even if it escaped", async () => {
    const world = await sessionOnRealDriver("sess_artifact_ended_generation");
    const bridge = await readyBridge(world, 1, { closeOnShutdown: true });
    await finishRun(world, bridge);
    declare(bridge, "art_r");
    const grant = await grantFor(bridge, "art_r");
    expect(await authorize(world, "art_r", grant.token)).toMatchObject({ kind: "authorized" });
    expect(
      await callObject(world, "complete", { artifactId: "art_r", byteSize: 1024, sha256: SHA256 }),
    ).toMatchObject({ kind: "created" });
    // Restore tokens for the created artifact, as this generation's git grant mints them.
    const seedRestore = (token: string) =>
      runInDurableObject(world.stub, async (_instance, state) => {
        state.storage.sql.exec(
          "INSERT INTO artifact_access (token_sha256, artifact_id, purpose, generation, expires_at_ms, used_at) VALUES (?, 'art_r', 'restore', 1, ?, NULL)",
          await sha256Hex(token),
          Date.now() + ARTIFACT_LIMITS.tokenTtlMs,
        );
      });
    await seedRestore("restore-while-live");
    expect(await authorize(world, "art_r", "restore-while-live", "restore")).toMatchObject({
      kind: "authorized",
    });
    await seedRestore("restore-unspent");

    await runInDurableObject(world.stub, (instance) =>
      instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
    );

    expect(await accessRows(world, "art_r")).toContainEqual(
      expect.objectContaining({ purpose: "restore", used_at: "revoked" }),
    );
    expect(await authorize(world, "art_r", "restore-unspent", "restore")).toEqual({
      kind: "refused",
    });
    // As though a grant still in flight had minted it after the revocation:
    // unspent and unexpired, and refused only because its generation ended.
    await runInDurableObject(world.stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE artifact_access SET used_at = NULL WHERE token_sha256 = ?",
        await sha256Hex("restore-unspent"),
      );
    });
    expect(await authorize(world, "art_r", "restore-unspent", "restore")).toEqual({
      kind: "refused",
    });
  });

  it("fails at once an artifact declared once the stop is taking credentials back, and sweeps one declared in between after the terminate", async () => {
    const world = await sessionOnRealDriver("sess_artifact_declared_while_stopping", {
      controller: (operation) =>
        operation === "stop"
          ? Response.json(
              { kind: "error", category: "unknown", message: "restarting", retryable: true },
              { status: 503 },
            )
          : undefined,
    });
    // The bridge stays connected through the refused terminate.
    const bridge = await readyBridge(world, 1, { closeOnShutdown: false });
    await finishRun(world, bridge);
    const stop = () =>
      runInDurableObject(world.stub, (instance) =>
        instance.stopSandbox({ requestedByUserId: "user_1", modalCredential: MODAL_CREDENTIAL }),
      );
    expect(await stop()).toMatchObject({ kind: "failed" });

    // The bridge's slow checkpoint declares its patch while the terminate backs off.
    declare(bridge, "art_late", { kind: "patch", producer: "checkpoint" });
    await waitFor(
      async () => (await eventsOfType(world.stub, "artifact.failed")).length >= 1,
      "the refusal",
    );
    expect((await eventsOfType(world.stub, "artifact.failed"))[0]).toMatchObject({
      runId: "run_1",
      payload: {
        artifactId: "art_late",
        stage: "authorize",
        reason: "The sandbox was stopping, so the artifact's upload was not authorized.",
        retryable: false,
      },
    });
    expect(await artifactRow(world, "art_late")).toMatchObject({ state: "failed" });
    await settle();
    expect(bridge.grants("upload")).toEqual([]);

    // As though one was admitted in the moment before the revoke step began,
    // after the revocation had already swept.
    const between = bridge.event("artifact.uploading", {
      runId: "run_1",
      payload: {
        artifactId: "art_between",
        kind: "log",
        contentType: "text/plain",
        declaredBytes: 64,
        producer: "tool",
      },
    });
    await runInDurableObject(world.stub, (_instance, state) => {
      const next =
        state.storage.sql
          .exec<{ sequence: number }>("SELECT MAX(session_sequence) AS sequence FROM event")
          .one().sequence + 1;
      const now = new Date().toISOString();
      state.storage.sql.exec(
        `INSERT INTO event (session_sequence, event_id, event_type, run_id, sandbox_generation, runtime_sequence, occurred_at, committed_at, envelope_json)
         VALUES (?, ?, 'artifact.uploading', 'run_1', 1, NULL, ?, ?, ?)`,
        next,
        String(between.eventId),
        now,
        now,
        JSON.stringify({ ...between, sessionSequence: next, committedAt: now }),
      );
      state.storage.sql.exec(
        `INSERT INTO artifact (id, session_id, run_id, kind, content_type, byte_size, checksum, state, classification, object_key, created_at)
         VALUES ('art_between', ?, 'run_1', 'log', 'text/plain', 64, NULL, 'uploading', 'temporary', 'key', ?)`,
        world.sessionId,
        now,
      );
    });

    world.setController(null);
    await ageStop(world.stub, 1);
    expect(await stop()).toEqual({ kind: "stopped", generation: 1 });

    expect(await artifactRow(world, "art_between")).toMatchObject({ state: "failed" });
    expect((await eventsOfType(world.stub, "artifact.failed"))[1]?.payload).toMatchObject({
      artifactId: "art_between",
      stage: "upload",
      reason: "The sandbox ended before this artifact was uploaded, so the upload was cancelled.",
    });
  });

  it("a lost sandbox fails the upload it never started and revokes its token", async () => {
    const world = await sessionOnRealDriver("sess_artifact_lost");
    const bridge = await readyBridge(world);
    declare(bridge, "art_l");
    const grant = await grantFor(bridge, "art_l");
    bridge.close();
    await waitFor(async () => (await probeRow(world.stub, 1)) !== null, "the probe");
    world.setController((operation) =>
      operation === "getStatus" ? Response.json({ kind: "ok", value: "stopped" }) : undefined,
    );

    await ageProbe(world.stub, 1);
    await fireAlarm(world.stub);

    expect((await eventsOfType(world.stub, "artifact.failed"))[0]?.payload).toMatchObject({
      artifactId: "art_l",
      stage: "upload",
    });
    expect(await artifactRow(world, "art_l")).toMatchObject({ state: "failed" });
    expect(
      (await eventsOfType(world.stub, "sandbox.credentials_revoked"))[0]?.payload,
    ).toMatchObject({
      reason: "disappeared",
      grants: expect.arrayContaining([{ kind: "upload", outcome: "revoked" }]),
    });
    expect(await authorize(world, "art_l", grant.token)).toEqual({ kind: "refused" });
  });

  it("fails uploads whose tokens all expired unspent before it counts the run's budget", async () => {
    const world = await sessionOnRealDriver("sess_artifact_expired_budget");
    const bridge = await readyBridge(world);
    for (const artifactId of ["art_a", "art_b", "art_c", "art_d"]) {
      declare(bridge, artifactId, { declaredBytes: 25 * MIB });
      await grantFor(bridge, artifactId);
    }
    const underWay = await grantFor(bridge, "art_d");
    expect(await authorize(world, "art_d", underWay.token)).toMatchObject({ kind: "authorized" });
    await runInDurableObject(world.stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE artifact_access SET expires_at_ms = ?", Date.now() - 1);
    });

    // Four declared at 25 MB fill the run's 100 MB, but three were never
    // uploaded and never will be: they are failed, and the new one fits.
    declare(bridge, "art_e", { declaredBytes: 25 * MIB });
    await grantFor(bridge, "art_e");

    const failed = await eventsOfType(world.stub, "artifact.failed");
    expect(
      failed.map((event) => (event.payload as { artifactId: string }).artifactId).sort(),
    ).toEqual(["art_a", "art_b", "art_c"]);
    expect(failed[0]?.payload).toMatchObject({
      stage: "upload",
      reason: "The upload token expired before the upload started, so the artifact was not stored.",
    });
    expect(await artifactRow(world, "art_d")).toMatchObject({ state: "uploading" });
    expect(await artifactRow(world, "art_e")).toMatchObject({ state: "uploading" });
  });
});
