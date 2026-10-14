import { useState } from "react";
import { fetchArtifact } from "@/lib/api/sessions";

/**
 * A download file name from the artifact's label, with path separators
 * replaced so it cannot name a directory; an empty label falls back to the id.
 */
export function artifactFileName(label: string | null, artifactId: string): string {
  const cleaned = (label ?? "").replace(/[\\/]/g, "_").trim();
  return cleaned.length > 0 ? cleaned : artifactId;
}

/** Hands a fetched blob to the browser as a download. */
function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next tick, once the browser has started reading the URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Downloads an artifact through the Worker, which serves only the session's
 * owner (record 13). Any failure sets `unavailable` rather than throwing.
 */
export function useArtifactDownload(
  sessionId: string | null,
  artifactId: string,
  label: string | null,
) {
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  async function download() {
    setBusy(true);
    setUnavailable(false);
    try {
      const result =
        sessionId === null
          ? ({ kind: "unavailable" } as const)
          : await fetchArtifact(sessionId, artifactId);
      if (result.kind === "fetched") {
        saveBlob(result.blob, artifactFileName(label, artifactId));
      } else {
        setUnavailable(true);
      }
    } catch {
      setUnavailable(true);
    } finally {
      setBusy(false);
    }
  }

  return { busy, unavailable, download };
}
