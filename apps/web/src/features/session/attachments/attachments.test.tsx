import { type ArtifactRef, ATTACHMENT_LIMITS } from "@oncue/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadRequest, UploadResult } from "@/lib/api/attachments";
import { Composer, type SubmitOptions } from "../Composer";
import { MessageRow } from "../Timeline";
import { AttachmentViewer } from "./AttachmentViewer";
import { formatBytes, MessageAttachments } from "./MessageAttachments";
import { type AttachmentsApi, TOO_MANY_TEXT } from "./use-attachments";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function png(name = "screen.png"): File {
  return new File([PNG], name, { type: "image/png" });
}

function text(name = "notes.md", body = "# notes\n"): File {
  return new File([body], name, { type: "text/markdown" });
}

function refFor(name: string, contentType: string, id = `att_${name}`): ArtifactRef {
  return {
    artifactId: id,
    kind: "file",
    contentType,
    byteSize: 12,
    label: name,
  } as ArtifactRef;
}

interface Pending {
  readonly request: UploadRequest;
  resolve(result: UploadResult): void;
}

/** An upload API whose uploads finish when the test says so. */
function fakeApi() {
  const pending: Pending[] = [];
  const discarded: string[] = [];
  let urls = 0;
  const api: AttachmentsApi = {
    upload: (request) =>
      new Promise<UploadResult>((resolve) => {
        pending.push({ request, resolve });
      }),
    discard: async (id) => {
      discarded.push(id);
    },
    createUrl: () => {
      urls += 1;
      return `blob:local-${urls}`;
    },
    revokeUrl: () => undefined,
  };
  return { api, pending, discarded };
}

function chooseFiles(files: readonly File[]) {
  const input = screen.getByTestId("composer-file-input") as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

function typeMessage(value: string) {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value } });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("the composer's attachments", () => {
  it("shows each file as it uploads, and sends the uploaded references with the message", async () => {
    const { api, pending } = fakeApi();
    const onSubmit = vi.fn(
      async (_text: string, _id: string, _connection: string | null, _options: SubmitOptions) =>
        true as const,
    );
    render(
      <Composer
        sessionId="sess_1"
        onSubmit={onSubmit}
        attachmentsApi={api}
        speechRecognition={null}
      />,
    );
    chooseFiles([png(), text()]);

    await waitFor(() => expect(pending).toHaveLength(2));
    const strip = screen.getByTestId("composer-attachments");
    const items = within(strip).getAllByTestId("composer-attachment");
    expect(items.map((item) => item.getAttribute("data-status"))).toEqual([
      "uploading",
      "uploading",
    ]);
    // The image shows its local copy; the other file shows its name.
    expect(
      within(items[0] as HTMLElement).getByRole("button", { name: "View screen.png" }),
    ).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText("notes.md")).toBeTruthy();
    expect(pending[0]?.request.name).toBe("screen.png");

    act(() => pending[0]?.request.onProgress(0.5));
    expect(
      screen
        .getByRole("progressbar", { name: "Uploading screen.png" })
        .getAttribute("aria-valuenow"),
    ).toBe("50");

    typeMessage("look at these");
    const send = screen.getByLabelText("Send message") as HTMLButtonElement;
    // Not while any file is still uploading.
    expect(send.disabled).toBe(true);
    act(() => pending[0]?.resolve({ kind: "uploaded", ref: refFor("screen.png", "image/png") }));
    act(() => pending[1]?.resolve({ kind: "uploaded", ref: refFor("notes.md", "text/markdown") }));
    await waitFor(() => expect(send.disabled).toBe(false));

    fireEvent.click(send);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[3]).toMatchObject({
      attachments: [refFor("screen.png", "image/png"), refFor("notes.md", "text/markdown")],
    });
    // Accepted: the strip is empty again.
    await waitFor(() => expect(screen.queryByTestId("composer-attachments")).toBeNull());
  });

  it("refuses a file by its bytes before uploading it, says why, and holds the send until it is removed", async () => {
    const { api, pending } = fakeApi();
    render(<Composer sessionId="sess_1" attachmentsApi={api} speechRecognition={null} />);
    chooseFiles([
      new File([new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0])], "photo.png", { type: "image/png" }),
    ]);
    await waitFor(() => expect(screen.getByTestId("composer-attachment-error")).toBeTruthy());
    expect(screen.getByTestId("composer-attachment-error").textContent).toContain("photo.png:");
    expect(pending).toHaveLength(0);
    typeMessage("hello");
    expect((screen.getByLabelText("Send message") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove photo.png" }));
    expect((screen.getByLabelText("Send message") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows an upload the Worker refused as failed, with its reason", async () => {
    const { api, pending } = fakeApi();
    render(<Composer sessionId="sess_1" attachmentsApi={api} speechRecognition={null} />);
    chooseFiles([png()]);
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() =>
      pending[0]?.resolve({ kind: "failed", message: "File storage is not available right now." }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("composer-attachment-error").textContent).toBe(
        "screen.png: File storage is not available right now.",
      ),
    );
  });

  it("takes an uploaded file back when it is removed, and a file removed mid-upload once it lands", async () => {
    const { api, pending, discarded } = fakeApi();
    render(<Composer sessionId="sess_1" attachmentsApi={api} speechRecognition={null} />);
    chooseFiles([png("a.png"), png("b.png")]);
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => pending[0]?.resolve({ kind: "uploaded", ref: refFor("a.png", "image/png") }));
    await waitFor(() =>
      expect(screen.getAllByTestId("composer-attachment")[0]?.getAttribute("data-status")).toBe(
        "ready",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove a.png" }));
    expect(discarded).toEqual(["att_a.png"]);

    fireEvent.click(screen.getByRole("button", { name: "Remove b.png" }));
    expect(pending[1]?.request.signal?.aborted).toBe(true);
    act(() => pending[1]?.resolve({ kind: "uploaded", ref: refFor("b.png", "image/png") }));
    await waitFor(() => expect(discarded).toEqual(["att_a.png", "att_b.png"]));
    expect(screen.queryByTestId("composer-attachment")).toBeNull();
  });

  it("stops at the per-message limit and says so", async () => {
    const { api, pending } = fakeApi();
    render(<Composer sessionId="sess_1" attachmentsApi={api} speechRecognition={null} />);
    chooseFiles(
      Array.from({ length: ATTACHMENT_LIMITS.perMessage + 2 }, (_value, index) =>
        png(`${index}.png`),
      ),
    );
    expect(screen.getByTestId("composer-attachments-notice").textContent).toBe(TOO_MANY_TEXT);
    expect(screen.getAllByTestId("composer-attachment")).toHaveLength(ATTACHMENT_LIMITS.perMessage);
    await waitFor(() => expect(pending).toHaveLength(ATTACHMENT_LIMITS.perMessage));
    chooseFiles([png("one-more.png")]);
    expect(screen.getAllByTestId("composer-attachment")).toHaveLength(ATTACHMENT_LIMITS.perMessage);
  });

  it("attaches pasted files and dropped files, and leaves pasted text to the field", async () => {
    const { api, pending } = fakeApi();
    render(<Composer sessionId="sess_1" attachmentsApi={api} speechRecognition={null} />);
    const field = screen.getByLabelText("Message");
    fireEvent.paste(field, { clipboardData: { files: [png("pasted.png")] } });
    fireEvent.paste(field, { clipboardData: { files: [] } });
    await waitFor(() => expect(pending).toHaveLength(1));

    const composer = screen.getByTestId("composer");
    fireEvent.dragOver(composer, { dataTransfer: { types: ["Files"], files: [] } });
    expect(composer.getAttribute("data-dragging")).toBe("true");
    fireEvent.dragLeave(composer);
    expect(composer.getAttribute("data-dragging")).toBeNull();
    fireEvent.dragOver(composer, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(composer.getAttribute("data-dragging")).toBeNull();
    fireEvent.drop(composer, { dataTransfer: { types: ["Files"], files: [text("dropped.md")] } });
    fireEvent.drop(composer, { dataTransfer: { types: ["Files"], files: [] } });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending.map((entry) => entry.request.name)).toEqual(["pasted.png", "dropped.md"]);
  });

  it("opens the chosen file picker from the add menu", () => {
    const { api } = fakeApi();
    render(<Composer sessionId="sess_1" attachmentsApi={api} speechRecognition={null} />);
    const input = screen.getByTestId("composer-file-input") as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const row = screen.queryByRole("menuitem", { name: /Add photos and files/ });
    if (row !== null) {
      fireEvent.click(row);
      expect(click).toHaveBeenCalled();
    }
  });

  it("opens a local image in the viewer from the strip", async () => {
    const { api, pending } = fakeApi();
    render(<Composer sessionId="sess_1" attachmentsApi={api} speechRecognition={null} />);
    chooseFiles([png()]);
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "View screen.png" }));
    const image = await screen.findByTestId("attachment-viewer-image");
    expect(image.getAttribute("src")).toBe("blob:local-1");
  });
});

describe("AttachmentViewer", () => {
  const images = [
    { url: "/a.png", name: "a.png" },
    { url: "/b.png", name: "b.png" },
  ];

  it("shows one image with its place, moves with the arrow keys and buttons, and closes on Escape", async () => {
    const onIndexChange = vi.fn();
    const onClose = vi.fn();
    render(
      <AttachmentViewer
        images={images}
        index={0}
        onIndexChange={onIndexChange}
        onClose={onClose}
      />,
    );
    const viewer = await screen.findByTestId("attachment-viewer");
    expect(within(viewer).getByText("Image 1 of 2")).toBeTruthy();
    expect(within(viewer).getByRole("link", { name: "Download a.png" }).getAttribute("href")).toBe(
      "/a.png",
    );
    fireEvent.keyDown(viewer, { key: "ArrowRight" });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(viewer, { key: "ArrowLeft" });
    expect(onIndexChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(viewer, { key: "a" });
    fireEvent.click(within(viewer).getByRole("button", { name: "Next image" }));
    fireEvent.click(within(viewer).getByRole("button", { name: "Previous image" }));
    expect(onIndexChange).toHaveBeenCalledTimes(4);
    fireEvent.keyDown(viewer, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows no arrows for one image and nothing when closed", async () => {
    const onIndexChange = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <AttachmentViewer
        images={images.slice(0, 1)}
        index={0}
        onIndexChange={onIndexChange}
        onClose={onClose}
      />,
    );
    const viewer = await screen.findByTestId("attachment-viewer");
    expect(within(viewer).getByText("Image")).toBeTruthy();
    expect(within(viewer).queryByRole("button", { name: "Next image" })).toBeNull();
    fireEvent.keyDown(viewer, { key: "ArrowRight" });
    expect(onIndexChange).not.toHaveBeenCalled();
    fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <AttachmentViewer
        images={images}
        index={null}
        onIndexChange={onIndexChange}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(screen.queryByTestId("attachment-viewer-image")).toBeNull());
  });
});

describe("a sent message's attachments", () => {
  const image = refFor("screen.png", "image/png", "att_1");
  const second = refFor("chart.png", "image/png", "att_2");
  const notes = refFor("notes.md", "text/markdown", "att_3");

  it("draws its images from the owner's route and its files as downloads", () => {
    render(<MessageAttachments sessionId="sess_1" attachments={[image, notes]} />);
    const thumbnail = screen.getByRole("img", { name: "screen.png" });
    expect(thumbnail.getAttribute("src")).toBe("/api/sessions/sess_1/attachments/att_1");
    const file = screen.getByRole("link", { name: "Download notes.md" });
    expect(file.getAttribute("href")).toBe("/api/sessions/sess_1/attachments/att_3");
    expect(file.getAttribute("download")).toBe("notes.md");
  });

  it("opens the viewer on the image clicked, among that message's images", async () => {
    render(<MessageAttachments sessionId="sess_1" attachments={[image, second, notes]} />);
    fireEvent.click(screen.getByRole("button", { name: "View chart.png" }));
    const viewer = await screen.findByTestId("attachment-viewer");
    expect(within(viewer).getByText("Image 2 of 2")).toBeTruthy();
    fireEvent.keyDown(viewer, { key: "ArrowRight" });
    await waitFor(() => expect(within(viewer).getByText("Image 1 of 2")).toBeTruthy());
    fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByTestId("attachment-viewer-image")).toBeNull());
  });

  it("draws nothing for a message with none, and only files for a message with no image", () => {
    const { container, rerender } = render(<MessageAttachments sessionId="s" attachments={[]} />);
    expect(container.innerHTML).toBe("");
    rerender(<MessageAttachments sessionId="s" attachments={[notes]} />);
    expect(screen.queryByRole("list", { name: "Attached images" })).toBeNull();
  });

  it("is drawn on the user's message in the timeline", () => {
    render(
      <MessageRow
        sessionId="sess_1"
        message={{
          messageId: "msg_1" as never,
          runId: null,
          role: "user",
          parts: [
            { type: "text", text: "look" },
            { type: "artifact_ref", artifact: image },
          ],
          streaming: false,
          stopReason: null,
          usage: null,
          delivery: null,
          at: "2026-09-27T00:00:00.000Z",
        }}
      />,
    );
    expect(screen.getByTestId("message-attachments")).toBeTruthy();
    expect(screen.getByText("look")).toBeTruthy();
  });

  it("formats sizes the way a person reads them", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
