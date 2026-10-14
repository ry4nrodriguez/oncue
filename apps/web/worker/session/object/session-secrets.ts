// Development secrets (record 08): the pinned declaration, secret grants and
// their deadline, and the object's own redactor.

import { buildGrantFrame } from "@oncue/bridge";
import {
  buildEvent,
  type PayloadOf,
  type ProtocolEvent,
  type ProtocolEventOf,
} from "@oncue/protocol";
import { log } from "../../log";
import { cachedCredentialKeyring } from "../../routes/credential-keyring";
import {
  type OpenedSecret,
  openDevelopmentSecrets,
  openSecretsById,
  repositoryConnectionIdFor,
} from "../../secrets/store";
import {
  DISPATCH_COLUMN_KIND,
  type DispatchKind,
  type DispatchPlan,
  type OutboundFrame,
} from "../dispatch";
import { earliest, grantDeliverable } from "../lifecycle";
import { MAX_SECRET_WITHHOLDINGS, SECRET_GRANT_ACK_MS, SECRET_GRANT_TTL_MS } from "./constants";
import type { SessionHost } from "./host";
import { readAttachment, readStopRow } from "./store-lifecycle";
import type { CreateSessionSecretsRecord, SessionRow } from "./types";

/**
 * The declaration pinned at launch and which names were supplied (record 08).
 * A mid-run request is judged against these rows for the session's life, never
 * the bridge's later read of the file. Names only, never a value.
 */
export function pinDeclaration(
  host: SessionHost,
  session: SessionRow,
  secrets: CreateSessionSecretsRecord | null,
  now: string,
): void {
  if (secrets === null) {
    return;
  }
  const names = (selected: boolean, kind: "required" | "optional") =>
    secrets.pinned
      .filter((entry) => entry.kind === kind && entry.selected === selected)
      .map((entry) => entry.name);
  const disclosed = buildEvent("secrets.disclosed", {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    runId: null,
    sandboxGeneration: session.sandboxGeneration,
    runtimeSequence: null,
    occurredAt: now,
    payload: {
      baseSha: secrets.baseSha,
      supplied: [...names(true, "required"), ...names(true, "optional")],
      withheld: names(false, "optional"),
      missing: [...secrets.missingRequired],
      invalid: secrets.declarationInvalid,
    },
  });
  host.commitControlEvents(session, [disclosed], now, () => {
    host.objectCtx.storage.sql.exec(
      "INSERT OR REPLACE INTO session_declaration (id, invalid) VALUES (1, ?)",
      secrets.declarationInvalid ? 1 : 0,
    );
    for (const entry of secrets.pinned) {
      host.objectCtx.storage.sql.exec(
        "INSERT OR IGNORE INTO session_secret (name, kind, selected, supplied_generation) VALUES (?, ?, ?, NULL)",
        entry.name,
        entry.kind,
        entry.selected ? 1 : 0,
      );
    }
  });
}

/** The names the user ticked at launch are owed to every generation, since a new sandbox starts with none. */
export async function requestLaunchSecrets(host: SessionHost, now: string): Promise<void> {
  const names = host.objectCtx.storage.sql
    .exec<{ name: string }>("SELECT name FROM session_secret WHERE selected = 1 ORDER BY name")
    .toArray()
    .map((row) => row.name);
  if (names.length > 0) {
    await host.dispatch({
      kind: "secrets_requested",
      grantId: crypto.randomUUID(),
      names,
      requestRef: null,
      approvalId: null,
      now,
    });
  }
}

/** The user approved: the one name the stored request holds is owed to the generation that asked. */
export async function requestApprovedSecret(
  host: SessionHost,
  session: SessionRow,
  approvalId: string,
  now: string,
): Promise<void> {
  // An admitted approval always has its request row. Without one there is no
  // name to send, and none is guessed.
  const row = host.objectCtx.storage.sql
    .exec<{ sandbox_ref: string; secret_name: string; requested_generation: number }>(
      "SELECT r.sandbox_ref, r.secret_name, a.requested_generation FROM approval a JOIN approval_request r ON r.approval_id = a.id WHERE a.id = ?",
      approvalId,
    )
    .toArray()[0];
  if (row === undefined || row.requested_generation !== session.sandboxGeneration) {
    return;
  }
  await host.dispatch({
    kind: "secrets_requested",
    grantId: crypto.randomUUID(),
    names: [row.secret_name],
    requestRef: row.sandbox_ref,
    approvalId,
    now,
  });
}

/**
 * Opens the values and sends them. Rows hold names; a value exists only
 * between the envelope and the socket, and in the redactor. Anything that
 * does not open is reported at once as not delivered, so an approval's
 * waiting call does not sit until the deadline.
 */
export async function sendSecretGrant(
  host: SessionHost,
  session: SessionRow,
  frame: Extract<OutboundFrame, { kind: "secret_grant" }>,
): Promise<void> {
  const { names, requestRef, approvalId } = frame.need;
  const opened = await openSessionSecrets(host, session, names);
  // A stop can reach its revoke step during those reads, so a value goes only
  // to a generation that may still be handed credentials (`grantDeliverable`).
  const generation = session.sandboxGeneration;
  const bridge = host.currentBridge(session);
  if (
    bridge === null ||
    !grantDeliverable(
      readAttachment(host.objectCtx.storage.sql, generation),
      readStopRow(host.objectCtx.storage.sql, generation),
    )
  ) {
    host.leavePending(session, frame.intentId, "secret_grant", "generation_stopping");
    return;
  }
  const unavailable = names.filter((name) => !opened.some((secret) => secret.name === name));
  if (unavailable.length > 0) {
    host.recordSecretsSettled(session, { names: unavailable, approvalId, accepted: false });
  }
  if (opened.length === 0) {
    host.objectCtx.storage.sql.exec(
      "UPDATE bridge_dispatch SET state = 'rejected', settled_at = ? WHERE intent_id = ?",
      new Date().toISOString(),
      frame.intentId,
    );
    if (requestRef !== null) {
      host.sendApprovalFrame(session, requestRef, "unavailable", null);
    }
    return;
  }
  // The ack settles the names that were sent, not the ones that were asked for.
  host.objectCtx.storage.sql.exec(
    "UPDATE bridge_dispatch SET payload_json = ? WHERE intent_id = ?",
    JSON.stringify({ ...frame.need, names: opened.map((secret) => secret.name) }),
    frame.intentId,
  );
  host.pendingRedactionSecrets = [
    ...new Set([...host.pendingRedactionSecrets, ...opened.map((secret) => secret.value)]),
  ];
  // Recorded before the frame leaves: the redactor is rebuilt after a wake from
  // what this generation was sent, acknowledged or not. A name sent under two
  // rows (the value was replaced) keeps both, since the sandbox may hold either.
  host.objectCtx.storage.transactionSync(() => {
    for (const secret of opened) {
      host.objectCtx.storage.sql.exec(
        "INSERT OR IGNORE INTO secret_sent (generation, secret_id, name) VALUES (?, ?, ?)",
        generation,
        secret.secretId,
        secret.name,
      );
    }
  });
  const nowMs = Date.now();
  const known = host.readSecretGrantDeadlineMs();
  host.secretGrantDeadlineMs = Math.min(
    known ?? Number.POSITIVE_INFINITY,
    nowMs + SECRET_GRANT_ACK_MS,
  );
  bridge.ws.send(
    JSON.stringify(
      buildGrantFrame(
        { sessionId: session.id, generation },
        {
          kind: "secret",
          grantId: frame.intentId,
          expiresAt: new Date(nowMs + SECRET_GRANT_TTL_MS).toISOString(),
          secrets: opened.map(({ name, value }) => ({ name, value })),
          requestRef,
        },
      ),
    ),
  );
  await host.rearm();
}

/** The in-memory deadline, loaded from the rows once per wake. Zero reads on the rearm path after that. */
export function readSecretGrantDeadlineMs(host: SessionHost): number | null {
  if (!host.secretGrantDeadlineLoaded) {
    host.secretGrantDeadlineLoaded = true;
    host.secretGrantDeadlineMs = host.computeSecretGrantDeadlineMs();
  }
  return host.secretGrantDeadlineMs;
}

/**
 * The earliest deadline among unacknowledged secret grants, from the rows so
 * hibernation cannot lose it and a second grant cannot push out the first.
 * One read on the open-rows index, on a wake, an ack, or a settle; never per frame.
 */
export function computeSecretGrantDeadlineMs(host: SessionHost): number | null {
  const session = host.readSession();
  if (session === null) {
    return null;
  }
  const rows = host.objectCtx.storage.sql
    .exec<{ payload_json: string; created_at: string }>(
      "SELECT payload_json, created_at FROM bridge_dispatch WHERE generation = ? AND state = 'sent' AND kind = ?",
      session.sandboxGeneration,
      DISPATCH_COLUMN_KIND.secret_grant,
    )
    .toArray()
    .filter((row) => (JSON.parse(row.payload_json) as DispatchKind).kind === "secret_grant");
  const first = earliest(rows.map((row) => Date.parse(row.created_at)));
  return first === null ? null : first + SECRET_GRANT_ACK_MS;
}

/**
 * A secret grant the bridge never answered is settled as not delivered after
 * two minutes: nothing else would close the waiting call's card, and the
 * bridge is told the value is unavailable so the call ends. A reconnect
 * within the generation re-sends an open row before then.
 */
export function settleUnansweredSecretGrants(
  host: SessionHost,
  session: SessionRow,
  nowMs: number,
): void {
  const open = host.objectCtx.storage.sql
    .exec<{ intent_id: string; payload_json: string }>(
      "SELECT intent_id, payload_json FROM bridge_dispatch WHERE generation = ? AND kind = ? AND state = 'sent' AND created_at <= ?",
      session.sandboxGeneration,
      DISPATCH_COLUMN_KIND.secret_grant,
      new Date(nowMs - SECRET_GRANT_ACK_MS).toISOString(),
    )
    .toArray()
    .map((row) => ({
      intentId: row.intent_id,
      kind: JSON.parse(row.payload_json) as DispatchKind,
    }))
    .filter(
      (row): row is { intentId: string; kind: Extract<DispatchKind, { kind: "secret_grant" }> } =>
        row.kind.kind === "secret_grant",
    );
  for (const row of open) {
    host.objectCtx.storage.sql.exec(
      "UPDATE bridge_dispatch SET state = 'rejected', settled_at = ? WHERE intent_id = ? AND state = 'sent'",
      new Date().toISOString(),
      row.intentId,
    );
    host.recordSecretsSettled(session, {
      names: row.kind.names,
      approvalId: row.kind.approvalId,
      accepted: false,
    });
    if (row.kind.requestRef !== null) {
      host.sendApprovalFrame(session, row.kind.requestRef, "unavailable", null);
    }
  }
  host.secretGrantDeadlineMs = host.computeSecretGrantDeadlineMs();
  host.secretGrantDeadlineLoaded = true;
}

/** To a sender every failure reads the same: the name did not open. The store marks an envelope that would not open. */
async function openSessionSecrets(
  host: SessionHost,
  session: SessionRow,
  names: readonly string[],
): Promise<readonly OpenedSecret[]> {
  return (await readSessionSecrets(host, session, names)) ?? [];
}

/** Null when the deployment's keyring could not be read, the one failure that says nothing about the values. */
async function readSessionSecrets(
  host: SessionHost,
  session: SessionRow,
  names: readonly string[],
): Promise<readonly OpenedSecret[] | null> {
  const keyring = await cachedCredentialKeyring(host.objectEnv.ONCUE_BROKER_KEYRING);
  if (keyring.kind !== "ok") {
    return null;
  }
  const repository = host.objectCtx.storage.sql
    .exec<{ repository_id: number }>("SELECT repository_id FROM session_repository LIMIT 1")
    .toArray()[0];
  if (repository === undefined) {
    return [];
  }
  const connectionId = await repositoryConnectionIdFor(
    host.objectEnv.DB,
    session.workspaceId,
    repository.repository_id,
  );
  if (connectionId === null) {
    return [];
  }
  const result = await openDevelopmentSecrets(
    host.objectEnv.DB,
    keyring.keyring,
    { workspaceId: session.workspaceId, repositoryConnectionId: connectionId },
    names,
  );
  return result.opened;
}

/**
 * The object's redactor is the second layer under the bridge's, and its values
 * live only in memory. Before the first frame after a wake it is rebuilt from
 * names (acknowledged, or sent and unanswered) under `blockConcurrencyWhile`,
 * so no frame is stored first.
 *
 * It fails closed only on an unreadable keyring: the caller closes the socket
 * and the bridge reconnects. A value the user deleted or replaced is skipped
 * with a log line; the bridge's layer still holds it. Once the generation is
 * built, nothing here runs per frame.
 */
export function ensureRedactor(host: SessionHost, session: SessionRow): true | Promise<boolean> {
  const generation = session.sandboxGeneration;
  if (host.redactorGeneration === generation) {
    // Synchronous on purpose: any `await` yields, and a second frame could then
    // read the sequence cursor before this one advanced it.
    return true;
  }
  return host.objectCtx.blockConcurrencyWhile(async () => {
    // A throw would reset the whole object. Every failure means not rebuilt, so
    // the socket closes and the bridge reconnects; logged, or a persistent
    // failure would be a silent reconnect loop.
    let rebuilt = false;
    let errorCategory = "rebuild_threw";
    try {
      rebuilt = await rebuildRedactor(host, session, generation);
      errorCategory = "keyring_unavailable";
    } catch {
      rebuilt = false;
    }
    if (!rebuilt) {
      log({
        timestamp: new Date().toISOString(),
        severity: "warn",
        service: "session-object",
        release: host.objectEnv.ONCUE_RELEASE,
        environment: host.objectEnv.ONCUE_ENV,
        operation: "session.redactor",
        result: "failed",
        errorCategory,
        sandboxGeneration: String(generation),
        sessionId: session.id,
      });
    }
    return rebuilt;
  });
}

async function rebuildRedactor(
  host: SessionHost,
  session: SessionRow,
  generation: number,
): Promise<boolean> {
  {
    // What this generation was sent, by row id, acknowledged or not, even if the
    // user has since replaced the value.
    const sent = host.objectCtx.storage.sql
      .exec<{ secret_id: string }>(
        "SELECT secret_id FROM secret_sent WHERE generation = ?",
        generation,
      )
      .toArray()
      .map((row) => row.secret_id);
    if (sent.length > 0) {
      const keyring = await cachedCredentialKeyring(host.objectEnv.ONCUE_BROKER_KEYRING);
      if (keyring.kind !== "ok") {
        return false;
      }
      const opened = await openSecretsById(
        host.objectEnv.DB,
        keyring.keyring,
        session.workspaceId,
        sent,
      );
      if (opened.length < sent.length) {
        log({
          timestamp: new Date().toISOString(),
          severity: "warn",
          service: "session-object",
          release: host.objectEnv.ONCUE_RELEASE,
          environment: host.objectEnv.ONCUE_ENV,
          operation: "session.redactor",
          result: "degraded",
          errorCategory: "supplied_value_unavailable",
          sandboxGeneration: String(generation),
          sessionId: session.id,
        });
      }
      host.pendingRedactionSecrets = [
        ...new Set([...host.pendingRedactionSecrets, ...opened.map((secret) => secret.value)]),
      ];
    }
    host.redactorGeneration = generation;
    return true;
  }
}

/**
 * Approved and supplied are different facts; this records supplied, from the
 * bridge's answer (or a value that never left). Names only;
 * `supplied_generation` moves only when every file was written.
 */
export function recordSecretsSettled(
  host: SessionHost,
  session: SessionRow,
  settled: NonNullable<DispatchPlan["secretsSettled"]>,
): void {
  const now = new Date().toISOString();
  host.commitControlEvents(
    session,
    [
      buildEvent("secrets.supplied", {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        runId: null,
        sandboxGeneration: session.sandboxGeneration,
        runtimeSequence: null,
        occurredAt: now,
        payload: {
          names: [...settled.names],
          approvalId: settled.approvalId as PayloadOf<"secrets.supplied">["approvalId"],
          delivered: settled.accepted,
        },
      }),
    ],
    now,
    () => {
      if (!settled.accepted) {
        return;
      }
      for (const name of settled.names) {
        host.objectCtx.storage.sql.exec(
          "UPDATE session_secret SET supplied_generation = ? WHERE name = ?",
          session.sandboxGeneration,
          name,
        );
      }
      host.objectCtx.storage.sql.exec(
        "UPDATE approval_request SET delivered_generation = ? WHERE approval_id = ?",
        session.sandboxGeneration,
        settled.approvalId,
      );
    },
  );
}

/**
 * The one push report nobody asked for: a checkpoint that published nothing
 * because the changes hold a development secret. It is a warning and moves
 * nothing, and is heard only from a generation that was supplied a secret,
 * so a sandbox with none cannot use it to write rows.
 */
export function isSecretWithholding(
  host: SessionHost,
  session: SessionRow,
  event: ProtocolEvent,
): boolean {
  if (
    event.type !== "git.push.failed" ||
    (event as ProtocolEventOf<"git.push.failed">).payload.category !== "secret_in_changes"
  ) {
    return false;
  }
  const supplied =
    host.objectCtx.storage.sql
      .exec<{ found: number }>(
        "SELECT EXISTS(SELECT 1 FROM session_secret WHERE supplied_generation = ?) AS found",
        session.sandboxGeneration,
      )
      .one().found === 1;
  if (!supplied) {
    return false;
  }
  // Bounded: an honest bridge reports one per withheld checkpoint. Past the
  // bound it is treated as the unrequested push it looks like.
  const stored = host.objectCtx.storage.sql
    .exec<{ stored: number }>(
      "INSERT INTO secret_withholding_count (generation, stored) VALUES (?, 1) ON CONFLICT (generation) DO UPDATE SET stored = stored + 1 RETURNING stored",
      session.sandboxGeneration,
    )
    .one().stored;
  return stored <= MAX_SECRET_WITHHOLDINGS;
}
