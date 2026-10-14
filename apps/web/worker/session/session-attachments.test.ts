// Composer attachments through the session object (docs/decisions.md): uploads
// are claimed before planning, the committed message carries the control
// plane's record rather than the browser's, and the bridge gets one single-use
// fetch per attachment.

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { attachmentObjectKey } from "../attachments/store";
import { sha256Hex } from "../test/bridge-credential";
import {
  eventsOfType,
  finishRun,
  followUpCommand,
  openClient,
  readyBridge,
  registerSessionWorlds,
  runStartCommand,
  type SessionWorld,
  sessionOnRealDriver,
  stubFor,
  type TestBridge,
  waitFor,
} from "../test/session-world";
import { ATTACHMENT_TOKEN_TTL_MS } from "./attachment-access";

vi.setConfig({ testTimeout: 60_000 });
registerSessionWorlds();

/** An upload the Worker would have written: unclaimed, in `workspaceId`. */
async function upload(
  workspaceId: string,
  options: { readonly name?: string; readonly contentType?: string; readonly kind?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO message_attachment (attachment_id, workspace_id, uploaded_by_user_id, session_id, name,
       content_type, kind, byte_size, sha256, object_key, created_at, claimed_at)
     VALUES (?, ?, 'user_1', NULL, ?, ?, ?, 12, 'abc', ?, '2026-09-27T00:00:00.000Z', NULL)`,
  )
    .bind(
      id,
      workspaceId,
      options.name ?? "screen.png",
      options.contentType ?? "image/png",
      options.kind ?? "image",
      attachmentObjectKey(workspaceId, id),
    )
    .run();
  return id;
}

/** What a browser sends: the id it was given, and a content type and label it may have made up. */
function browserRef(id: string) {
  return {
    artifactId: id,
    kind: "file",
    contentType: "text/html",
    byteSize: 999_999,
    label: "<b>not the name</b>",
  };
}

async function sessionOf(id: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT session_id FROM message_attachment WHERE attachment_id = ?",
  )
    .bind(id)
    .first<{ session_id: string | null }>();
  return row?.session_id ?? null;
}

async function runningWorld(
  sessionId: string,
): Promise<{ world: SessionWorld; bridge: TestBridge }> {
  const world = await sessionOnRealDriver(sessionId);
  const bridge = await readyBridge(world);
  bridge.send(bridge.event("run.started", { runId: "run_1" }));
  return { world, bridge };
}

function steer(messageId: string, attachments: unknown[], delivery = "steer_current_run") {
  const command = followUpCommand(
    `cmd_${messageId}`,
    messageId,
    "run_1",
    "running",
    delivery as "steer_current_run" | "run_next",
  );
  return { ...command, payload: { ...command.payload, attachments } };
}

describe("a steer's attachments", () => {
  it("are claimed for the session, committed in the control plane's words, and sent with one fetch each", async () => {
    const { world, bridge } = await runningWorld("sess_attach_steer");
    const image = await upload(world.workspaceId);
    const notes = await upload(world.workspaceId, {
      name: "notes.md",
      contentType: "text/markdown",
      kind: "file",
    });
    const client = await openClient(world);
    await client.send(steer("msg_steer", [browserRef(image), browserRef(notes)]));

    const [queued] = await eventsOfType(world.stub, "message.queued");
    expect(queued?.payload).toMatchObject({
      messageId: "msg_steer",
      attachments: [
        {
          artifactId: image,
          kind: "file",
          contentType: "image/png",
          byteSize: 12,
          label: "screen.png",
        },
        {
          artifactId: notes,
          kind: "file",
          contentType: "text/markdown",
          byteSize: 12,
          label: "notes.md",
        },
      ],
    });
    expect(await sessionOf(image)).toBe(world.sessionId);
    expect(await sessionOf(notes)).toBe(world.sessionId);

    await waitFor(() => bridge.commands("run.follow_up").length === 1, "the steer");
    const frame = bridge.commands("run.follow_up")[0] as {
      attachments: Array<{ artifactId: string; url: string; token: string; name: string }>;
    };
    expect(frame.attachments.map((entry) => entry.artifactId)).toEqual([image, notes]);
    expect(frame.attachments[0]?.name).toBe("screen.png");
    expect(frame.attachments[0]?.url).toMatch(
      new RegExp(`/api/sessions/${world.sessionId}/attachments/${image}/content$`),
    );

    // Each token opens its own attachment, once, for this generation.
    const stub = stubFor(world.sessionId);
    const token = frame.attachments[0]?.token as string;
    const authorize = (attachmentId: string, presented: string) =>
      runInDurableObject(stub, (instance) =>
        instance.authorizeAttachmentFetch(attachmentId, presented),
      );
    expect(await authorize(notes, token)).toEqual({ kind: "refused" });
    expect(await authorize(image, token)).toEqual({ kind: "authorized" });
    expect(await authorize(image, token)).toEqual({ kind: "refused" });
    // Only the hash is stored.
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ token_sha256: string }>("SELECT token_sha256 FROM attachment_access")
        .toArray(),
    );
    expect(stored.map((row) => row.token_sha256)).toContain(await sha256Hex(token));
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("are refused, and nothing is committed as the message, when one is not this workspace's or is another session's", async () => {
    const { world } = await runningWorld("sess_attach_refused");
    const elsewhere = await upload("ws_somebody_else");
    const client = await openClient(world);
    await client.send(steer("msg_foreign", [browserRef(elsewhere)]));
    const rejected = await eventsOfType(world.stub, "command.rejected");
    expect(rejected.at(-1)?.payload).toMatchObject({
      commandId: "cmd_msg_foreign",
      reason: "unsupported",
      detail: "an attachment is not available; upload it again",
    });
    expect(await eventsOfType(world.stub, "message.queued")).toEqual([]);
    expect(await sessionOf(elsewhere)).toBeNull();

    const taken = await upload(world.workspaceId);
    await env.DB.prepare(
      "UPDATE message_attachment SET session_id = 'sess_other' WHERE attachment_id = ?",
    )
      .bind(taken)
      .run();
    await client.send(steer("msg_taken", [browserRef(taken)]));
    expect((await eventsOfType(world.stub, "command.rejected")).at(-1)?.payload).toMatchObject({
      commandId: "cmd_msg_taken",
      reason: "unsupported",
    });
  });

  it("claim nothing for a command from someone who does not own the session", async () => {
    const { world } = await runningWorld("sess_attach_stranger");
    const id = await upload(world.workspaceId);
    // The Worker and the upgrade both refuse a stranger's socket, so the
    // object's own check is reached by relabelling an owner's socket.
    const client = await openClient(world);
    await runInDurableObject(world.stub, (_instance, state) =>
      state.getWebSockets("client").at(-1)?.serializeAttachment("user_stranger"),
    );
    await client.send(steer("msg_stranger", [browserRef(id)]));
    expect((await eventsOfType(world.stub, "command.rejected")).at(-1)?.payload).toMatchObject({
      reason: "not_owner",
    });
    expect(await sessionOf(id)).toBeNull();
  });

  it("held for the next run mint no fetch now, and ride on the run.start that releases them", async () => {
    const { world, bridge } = await runningWorld("sess_attach_run_next");
    const id = await upload(world.workspaceId);
    const client = await openClient(world);
    await client.send(steer("msg_next", [browserRef(id)], "run_next"));
    // Held in the object: nothing reaches the bridge, so no fetch is minted.
    expect(bridge.commands("run.follow_up")).toEqual([]);
    const minted = await runInDurableObject(world.stub, (_instance, state) =>
      state.storage.sql.exec("SELECT token_sha256 FROM attachment_access").toArray(),
    );
    expect(minted).toEqual([]);

    bridge.send(bridge.event("run.completed_with_warnings", { runId: "run_1" }));
    await waitFor(() => bridge.commands("run.start").length === 2, "the released run");
    const released = bridge.commands("run.start")[1] as {
      command: { payload: { instruction: { attachments: Array<{ artifactId: string }> } } };
      attachments: Array<{ artifactId: string }>;
    };
    expect(released.command.payload.instruction.attachments.map((ref) => ref.artifactId)).toEqual([
      id,
    ]);
    expect(released.attachments.map((entry) => entry.artifactId)).toEqual([id]);
  });
});

describe("a new run's attachments", () => {
  it("are claimed and committed on run.queued, and its command carries their fetches", async () => {
    const world = await sessionOnRealDriver("sess_attach_start");
    const bridge = await readyBridge(world);
    await finishRun(world, bridge);
    const id = await upload(world.workspaceId);
    const client = await openClient(world);
    const command = runStartCommand("cmd_start_2", "msg_start_2", "Look at this");
    await client.send({
      ...command,
      payload: {
        ...command.payload,
        continuesRunId: "run_1",
        instruction: { ...command.payload.instruction, attachments: [browserRef(id)] },
      },
    });
    const queued = (await eventsOfType(world.stub, "run.queued")).at(-1);
    expect(queued?.payload).toMatchObject({
      instruction: {
        messageId: "msg_start_2",
        attachments: [{ artifactId: id, contentType: "image/png", label: "screen.png" }],
      },
    });
    await waitFor(() => bridge.commands("run.start").length === 2, "the second run.start");
    expect(
      (bridge.commands("run.start")[1] as { attachments: unknown[] }).attachments,
    ).toHaveLength(1);
    // The first run.start named none and carries no field at all.
    expect("attachments" in (bridge.commands("run.start")[0] as object)).toBe(false);
  });
});

describe("authorizeAttachmentFetch", () => {
  it("refuses on an object with no session, and a token past its ten minutes", async () => {
    const empty = stubFor("sess_attach_none");
    expect(
      await runInDurableObject(empty, (instance) => instance.authorizeAttachmentFetch("a", "t")),
    ).toEqual({ kind: "refused" });

    const world = await sessionOnRealDriver("sess_attach_expired");
    const token = "expired-token";
    await runInDurableObject(world.stub, async (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO attachment_access (token_sha256, attachment_id, generation, expires_at_ms, used_at) VALUES (?,?,1,?,NULL)",
        await sha256Hex(token),
        "att_1",
        Date.now() - ATTACHMENT_TOKEN_TTL_MS,
      );
    });
    expect(
      await runInDurableObject(world.stub, (instance) =>
        instance.authorizeAttachmentFetch("att_1", token),
      ),
    ).toEqual({ kind: "refused" });
  });
});
