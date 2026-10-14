/**
 * The workspace's approval settings for a screen that shows the mode. Read on
 * mount and again whenever the window regains focus, since another tab or
 * Settings may have changed them; a change this screen saves replaces them
 * with the server's answer, which is what is in force. Saves go one at a time
 * and the latest choice wins. While a save is out, and after one finished, an
 * older read cannot put back what was there before.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ApprovalSettings,
  type ApprovalSettingsResult,
  readApprovalSettings,
  setApprovalDefault,
} from "@/lib/api/approval-settings";

export type DefaultMode = "ask" | "always";

export interface ApprovalSettingsState {
  /** Null until a read answers. */
  readonly settings: ApprovalSettings | null;
  /** `failed`: the last read or save could not say what is in force. */
  readonly status: "loading" | "read" | "failed";
  /**
   * The default to show: the choice on its way while a save is out, else the
   * last answer, else null when nothing could be read, which the picker shows
   * as unknown rather than claiming a mode.
   */
  readonly defaultMode: DefaultMode | null;
  /** Saves the default; the server's answer replaces what is shown. */
  readonly save: (mode: DefaultMode) => void;
  /** Applies a result from a change this screen made itself (Settings' Remove). */
  readonly apply: (result: ApprovalSettingsResult) => void;
}

export function useApprovalSettings(
  read: () => Promise<ApprovalSettingsResult> = readApprovalSettings,
  write: (mode: DefaultMode) => Promise<ApprovalSettingsResult> = setApprovalDefault,
): ApprovalSettingsState {
  const [settings, setSettings] = useState<ApprovalSettings | null>(null);
  const [status, setStatus] = useState<"loading" | "read" | "failed">("loading");
  const [pending, setPending] = useState<DefaultMode | null>(null);
  // Bumped by every save, so a read that started before one is dropped.
  const epoch = useRef(0);
  const saving = useRef(false);
  const queued = useRef<DefaultMode | null>(null);
  const live = useRef(true);
  // Refs, so a caller's inline functions do not read again on every render.
  const readRef = useRef(read);
  readRef.current = read;
  const writeRef = useRef(write);
  writeRef.current = write;

  const apply = useCallback((result: ApprovalSettingsResult) => {
    if (result.kind === "read") {
      setSettings(result.settings);
      setStatus("read");
    } else {
      setStatus("failed");
    }
  }, []);

  const refresh = useCallback(() => {
    const started = epoch.current;
    void readRef.current().then((result) => {
      if (live.current && !saving.current && started === epoch.current) {
        apply(result);
      }
    });
  }, [apply]);

  useEffect(() => {
    live.current = true;
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      live.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const save = useCallback(
    (mode: DefaultMode) => {
      epoch.current += 1;
      setPending(mode);
      if (saving.current) {
        queued.current = mode;
        return;
      }
      saving.current = true;
      const send = async (next: DefaultMode) => {
        let current = next;
        let result = await writeRef.current(current);
        while (queued.current !== null) {
          current = queued.current;
          queued.current = null;
          result = await writeRef.current(current);
        }
        saving.current = false;
        if (!live.current) {
          return;
        }
        setPending(null);
        if (result.kind === "read") {
          apply(result);
          return;
        }
        // The save may or may not have landed: show what the server says now.
        setStatus("failed");
        refresh();
      };
      void send(mode);
    },
    [apply, refresh],
  );

  const defaultMode = pending ?? (status === "failed" ? null : (settings?.defaultMode ?? null));
  return { settings, status, defaultMode, save, apply };
}
