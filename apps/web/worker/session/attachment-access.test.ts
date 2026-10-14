import type { ProtocolCommand } from "@oncue/protocol";
import { makeCommand } from "@oncue/protocol/testing";
import { describe, expect, it } from "vitest";
import { commandAttachments, withAttachments } from "./attachment-access";

const REF = {
  artifactId: "att_1",
  kind: "file" as const,
  contentType: "image/png",
  byteSize: 12,
  label: "screen.png",
} as unknown as Parameters<typeof withAttachments>[1][number];

describe("commandAttachments and withAttachments", () => {
  it("read and replace a run.start's instruction attachments", () => {
    const command = makeCommand("run.start") as ProtocolCommand;
    expect(commandAttachments(command)).toEqual([]);
    const replaced = withAttachments(command, [REF]);
    expect(commandAttachments(replaced)).toEqual([REF]);
    expect(commandAttachments(command)).toEqual([]);
  });

  it("read and replace a follow-up's attachments", () => {
    const command = makeCommand("run.follow_up") as ProtocolCommand;
    expect(commandAttachments(withAttachments(command, [REF]))).toEqual([REF]);
  });

  it("leave every other command as it is", () => {
    const command = makeCommand("run.cancel") as ProtocolCommand;
    expect(commandAttachments(command)).toEqual([]);
    expect(withAttachments(command, [REF])).toBe(command);
  });
});
