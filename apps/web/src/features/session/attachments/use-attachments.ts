/**
 * The composer's attachments until the message carrying them is accepted.
 * Files are checked against the protocol's rules first only to save a wasted
 * upload; the Worker checks again.
 */

import {
  type ArtifactRef,
  ATTACHMENT_LIMITS,
  ATTACHMENT_REFUSAL_TEXT,
  cleanAttachmentName,
  sniffAttachment,
} from "@oncue/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Discarder, Uploader } from "@/lib/api/attachments";

export type AttachmentStatus = "uploading" | "ready" | "failed";

export interface ComposerAttachment {
  /** The composer's own key; the Worker's id is `ref.artifactId` once uploaded. */
  readonly localId: string;
  readonly name: string;
  readonly kind: "image" | "file";
  readonly contentType: string;
  readonly byteSize: number;
  /** A local object URL for an image, so it shows before it uploads. */
  readonly previewUrl: string | null;
  readonly status: AttachmentStatus;
  /** From 0 to 1 while uploading. */
  readonly progress: number;
  readonly error: string | null;
  readonly ref: ArtifactRef | null;
}

export const TOO_MANY_TEXT = `A message can carry up to ${ATTACHMENT_LIMITS.perMessage} files.`;

export interface AttachmentsApi {
  readonly upload: Uploader;
  readonly discard: Discarder;
  /** Object URLs, injectable because a test runner has none. */
  readonly createUrl?: (file: Blob) => string;
  readonly revokeUrl?: (url: string) => void;
  readonly newId?: () => string;
}

function defaultCreateUrl(file: Blob): string {
  return URL.createObjectURL(file);
}

function defaultRevokeUrl(url: string): void {
  URL.revokeObjectURL(url);
}

async function bytesOf(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export interface UseAttachments {
  readonly items: readonly ComposerAttachment[];
  /** What the message will carry: every uploaded attachment, in the order added. */
  readonly refs: readonly ArtifactRef[];
  /** True while any file is uploading or failed: the message waits until each is sent or removed. */
  readonly blocking: boolean;
  /** Why the last files could not all be added, or null. */
  readonly notice: string | null;
  add(files: readonly File[]): void;
  remove(localId: string): void;
  /** The message was accepted: the attachments are its now, so nothing is discarded. */
  clear(): void;
}

export function useAttachments(api: AttachmentsApi): UseAttachments {
  const [items, setItems] = useState<readonly ComposerAttachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const controllers = useRef(new Map<string, AbortController>());
  const createUrl = api.createUrl ?? defaultCreateUrl;
  const revokeUrl = api.revokeUrl ?? defaultRevokeUrl;
  const newId = api.newId ?? (() => crypto.randomUUID());

  const update = useCallback((localId: string, change: Partial<ComposerAttachment>) => {
    setItems((current) =>
      current.map((item) => (item.localId === localId ? { ...item, ...change } : item)),
    );
  }, []);

  // Revokes the object URLs on unmount.
  useEffect(
    () => () => {
      for (const item of itemsRef.current) {
        if (item.previewUrl !== null) {
          revokeUrl(item.previewUrl);
        }
      }
      for (const controller of controllers.current.values()) {
        controller.abort();
      }
    },
    [revokeUrl],
  );

  const start = useCallback(
    async (localId: string, file: File, name: string) => {
      const controller = new AbortController();
      controllers.current.set(localId, controller);
      const result = await api.upload({
        file,
        name,
        onProgress: (progress) => update(localId, { progress }),
        signal: controller.signal,
      });
      controllers.current.delete(localId);
      if (controller.signal.aborted) {
        // Removed while uploading: an upload that landed anyway is taken back.
        if (result.kind === "uploaded") {
          void api.discard(result.ref.artifactId);
        }
        return;
      }
      update(
        localId,
        result.kind === "uploaded"
          ? { status: "ready", progress: 1, ref: result.ref, error: null }
          : { status: "failed", error: result.message },
      );
    },
    [api, update],
  );

  const add = useCallback(
    (files: readonly File[]) => {
      setNotice(null);
      const room = ATTACHMENT_LIMITS.perMessage - itemsRef.current.length;
      if (files.length > room) {
        setNotice(TOO_MANY_TEXT);
      }
      const accepted = files.slice(0, Math.max(0, room)).map((file) => ({
        file,
        localId: newId(),
        name: cleanAttachmentName(file.name),
      }));
      // Placed at once so the count holds against a second drop and nothing
      // reorders while the bytes are read.
      const placed: ComposerAttachment[] = accepted.map(({ file, localId, name }) => ({
        localId,
        name,
        kind: file.type.startsWith("image/") ? "image" : "file",
        contentType: file.type,
        byteSize: file.size,
        previewUrl: null,
        status: "uploading",
        progress: 0,
        error: null,
        ref: null,
      }));
      itemsRef.current = [...itemsRef.current, ...placed];
      setItems(itemsRef.current);
      for (const { file, localId, name } of accepted) {
        void bytesOf(file).then((bytes) => {
          if (!itemsRef.current.some((item) => item.localId === localId)) {
            // Removed while its bytes were read: nothing to check or send.
            return;
          }
          const sniffed = sniffAttachment(bytes, name);
          if (!sniffed.ok) {
            update(localId, {
              kind: "file",
              status: "failed",
              error: ATTACHMENT_REFUSAL_TEXT[sniffed.reason],
            });
            return;
          }
          update(localId, {
            kind: sniffed.kind,
            contentType: sniffed.contentType,
            previewUrl: sniffed.kind === "image" ? createUrl(file) : null,
          });
          void start(localId, file, name);
        });
      }
    },
    [createUrl, newId, start, update],
  );

  const remove = useCallback(
    (localId: string) => {
      const item = itemsRef.current.find((entry) => entry.localId === localId);
      if (item === undefined) {
        return;
      }
      controllers.current.get(localId)?.abort();
      if (item.previewUrl !== null) {
        revokeUrl(item.previewUrl);
      }
      if (item.ref !== null) {
        void api.discard(item.ref.artifactId);
      }
      setNotice(null);
      itemsRef.current = itemsRef.current.filter((entry) => entry.localId !== localId);
      setItems(itemsRef.current);
    },
    [api, revokeUrl],
  );

  const clear = useCallback(() => {
    for (const item of itemsRef.current) {
      if (item.previewUrl !== null) {
        revokeUrl(item.previewUrl);
      }
    }
    setNotice(null);
    itemsRef.current = [];
    setItems([]);
  }, [revokeUrl]);

  const refs = items.flatMap((item) => (item.ref === null ? [] : [item.ref]));
  const blocking = items.some((item) => item.status !== "ready");
  return { items, refs, blocking, notice, add, remove, clear };
}
