import { describe, expect, it } from "vitest";
import {
  attachmentDirName,
  attachmentFileName,
  attachmentPrompt,
  type PlaceDeps,
  placeAttachments,
} from "./attachments";
import type { AttachmentFetch } from "./frames";
import { isAttachmentDir, PATH_SEGMENT_PATTERN } from "./supervisor-protocol";

const ROOT = "/var/lib/oncue/attachments";

function fetchOf(overrides: Partial<AttachmentFetch> = {}): AttachmentFetch {
  return {
    artifactId: "att_1",
    name: "screen.png",
    contentType: "image/png",
    byteSize: 4,
    url: "https://oncue.example/api/sessions/s/attachments/att_1/content",
    token: "tok_1",
    ...overrides,
  };
}

describe("attachmentDirName", () => {
  it("is one path segment the supervisor accepts, whatever the message id holds", () => {
    const name = attachmentDirName("../msg id/with:odd*chars", "5b8c-uuid-1");
    expect(PATH_SEGMENT_PATTERN.test(name)).toBe(true);
    expect(isAttachmentDir(`${ROOT}/${name}`, ROOT)).toBe(true);
    expect(name).toBe("m___msg_id_with_odd_chars-5b8c-uuid-1");
  });

  it("stays within the segment limit for a long id", () => {
    const name = attachmentDirName("x".repeat(500), "0123456789abcdef0123456789abcdef0123");
    expect(name.length).toBeLessThanOrEqual(128);
    expect(PATH_SEGMENT_PATTERN.test(name)).toBe(true);
  });
});

describe("attachmentFileName", () => {
  it("numbers the file and keeps only safe characters", () => {
    expect(attachmentFileName(0, "screen shot (1).png")).toBe("1-screen_shot__1_.png");
    expect(attachmentFileName(2, "notes.md")).toBe("3-notes.md");
  });

  it("never starts with a dot and never names nothing", () => {
    expect(attachmentFileName(0, "..hidden")).toBe("1-hidden");
    expect(attachmentFileName(1, "...")).toBe("2-attachment");
    expect(attachmentFileName(0, "a".repeat(300))).toHaveLength(102);
  });
});

describe("attachmentPrompt", () => {
  it("adds nothing for a message without attachments", () => {
    expect(attachmentPrompt([], true)).toEqual({ note: "", files: [] });
  });

  it("sends an image as a file part to a model that reads images, and lists every file by path", () => {
    const told = attachmentPrompt(
      [
        { fetch: fetchOf(), path: `${ROOT}/m1-x/1-screen.png` },
        {
          fetch: fetchOf({
            artifactId: "att_2",
            name: "notes.md",
            contentType: "text/markdown",
            byteSize: 2048,
          }),
          path: `${ROOT}/m1-x/2-notes.md`,
        },
        {
          fetch: fetchOf({ artifactId: "att_3", name: "big.pdf", byteSize: 3 * 1024 * 1024 }),
          path: null,
        },
      ],
      true,
    );
    expect(told.files).toEqual([
      {
        type: "file",
        mime: "image/png",
        url: `file://${ROOT}/m1-x/1-screen.png`,
        filename: "screen.png",
      },
    ]);
    expect(told.note).toContain("The user attached these files.");
    expect(told.note).toContain(
      `- ${ROOT}/m1-x/1-screen.png (image/png, 4 B), "screen.png", included above as an image.`,
    );
    expect(told.note).toContain(`- ${ROOT}/m1-x/2-notes.md (text/markdown, 2 KB), "notes.md".`);
    expect(told.note).toContain("- big.pdf: could not be delivered to the sandbox.");
    expect(told.note).not.toContain("cannot view images");
  });

  it("lists an image as a file, and says so, for a model that does not read images", () => {
    const told = attachmentPrompt(
      [{ fetch: fetchOf({ byteSize: 3 * 1024 * 1024 }), path: `${ROOT}/m1-x/1-screen.png` }],
      false,
    );
    expect(told.files).toEqual([]);
    expect(told.note).toContain(`(image/png, 3.0 MB), "screen.png", an image.`);
    expect(told.note).toContain("This model cannot view images.");
  });
});

interface Recorded {
  readonly dirs: string[];
  readonly writes: Array<{ path: string; bytes: number }>;
  readonly handed: string[];
  readonly logs: string[];
}

function deps(overrides: Partial<PlaceDeps> = {}): { deps: PlaceDeps; recorded: Recorded } {
  const recorded: Recorded = { dirs: [], writes: [], handed: [], logs: [] };
  return {
    recorded,
    deps: {
      root: ROOT,
      dirName: "m1-x",
      download: async () => ({ kind: "ok", bytes: new Uint8Array(4) }),
      makeDir: async (path) => {
        recorded.dirs.push(path);
      },
      writeNew: async (path, bytes) => {
        recorded.writes.push({ path, bytes: bytes.byteLength });
      },
      handOver: async (dir) => {
        recorded.handed.push(dir);
        return true;
      },
      log: (line) => recorded.logs.push(line),
      ...overrides,
    },
  };
}

describe("placeAttachments", () => {
  it("does nothing for no attachments", async () => {
    const { deps: d, recorded } = deps();
    expect(await placeAttachments([], d)).toEqual([]);
    expect(recorded.dirs).toEqual([]);
  });

  it("fetches each with its own token, writes it under one directory, and hands the directory over", async () => {
    const tokens: string[] = [];
    const { deps: d, recorded } = deps({
      download: async (request) => {
        tokens.push(request.token);
        return { kind: "ok", bytes: new Uint8Array(4) };
      },
    });
    const placed = await placeAttachments(
      [fetchOf(), fetchOf({ artifactId: "att_2", name: "b.png", token: "tok_2" })],
      d,
    );
    expect(tokens).toEqual(["tok_1", "tok_2"]);
    expect(recorded.dirs).toEqual([`${ROOT}/m1-x`]);
    expect(recorded.writes).toEqual([
      { path: `${ROOT}/m1-x/1-screen.png`, bytes: 4 },
      { path: `${ROOT}/m1-x/2-b.png`, bytes: 4 },
    ]);
    expect(recorded.handed).toEqual([`${ROOT}/m1-x`]);
    expect(placed.map((entry) => entry.path)).toEqual([
      `${ROOT}/m1-x/1-screen.png`,
      `${ROOT}/m1-x/2-b.png`,
    ]);
  });

  it("marks one it could not fetch, or whose size is not the recorded size, as missing", async () => {
    let call = 0;
    const { deps: d, recorded } = deps({
      download: async () => {
        call += 1;
        return call === 1 ? { kind: "failed" } : { kind: "ok", bytes: new Uint8Array(9) };
      },
    });
    const placed = await placeAttachments([fetchOf(), fetchOf({ artifactId: "att_2" })], d);
    expect(placed.map((entry) => entry.path)).toEqual([null, null]);
    expect(recorded.writes).toEqual([]);
    expect(recorded.logs).toEqual([
      "bridge: attachment 1 could not be fetched",
      "bridge: attachment 2 could not be fetched",
    ]);
  });

  it("marks one it could not write as missing and keeps the rest", async () => {
    let call = 0;
    const { deps: d, recorded } = deps({
      writeNew: async () => {
        call += 1;
        if (call === 1) {
          throw new Error("EEXIST");
        }
      },
    });
    const placed = await placeAttachments([fetchOf(), fetchOf({ artifactId: "att_2" })], d);
    expect(placed.map((entry) => entry.path)).toEqual([null, `${ROOT}/m1-x/2-screen.png`]);
    expect(recorded.logs).toEqual(["bridge: attachment 1 could not be written"]);
  });

  it("places nothing when the directory cannot be made", async () => {
    const { deps: d, recorded } = deps({
      makeDir: async () => {
        throw new Error("EACCES");
      },
    });
    const placed = await placeAttachments([fetchOf()], d);
    expect(placed).toEqual([{ fetch: fetchOf(), path: null }]);
    expect(recorded.logs).toEqual(["bridge: could not make the attachments directory"]);
  });

  it("places nothing when the supervisor will not hand the directory to the agent", async () => {
    const { deps: d, recorded } = deps({ handOver: async () => false });
    const placed = await placeAttachments([fetchOf()], d);
    expect(placed).toEqual([{ fetch: fetchOf(), path: null }]);
    expect(recorded.logs).toEqual(["bridge: could not hand the attachments to the agent"]);
  });

  it("never logs a token", async () => {
    const { deps: d, recorded } = deps({ download: async () => ({ kind: "failed" }) });
    await placeAttachments([fetchOf({ token: "secret-token-value" })], d);
    expect(recorded.logs.join("\n")).not.toContain("secret-token-value");
  });
});
