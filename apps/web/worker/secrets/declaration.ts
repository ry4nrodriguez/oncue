// The secrets a repository declares, read by the control plane before any
// sandbox exists and pinned to that commit (record 08). The disclosure card,
// the launch check, and mid-run approvals are judged against this read, not
// the bridge's. The file is untrusted: a regular file only, size-capped, parsed
// strictly, names only. "Could not read" is never reported as "declares
// nothing", which would skip the card.

import { PROJECT_FILE_PATH, readProjectYaml } from "@oncue/bridge";
import { decodeBase64Url } from "../base64url";
import { githubFetch, githubHeaders } from "../github/app";

/** A project file is a few dozen lines; anything near this is not one. */
export const MAX_PROJECT_FILE_BYTES = 64 * 1024;

export interface DeclaredSecrets {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export type DeclarationRead =
  /** No project file, or one with no `secrets` block. */
  | { readonly kind: "none" }
  | { readonly kind: "declared"; readonly secrets: DeclaredSecrets }
  /** The reader refused the file: shown to the user with its line, and nothing is supplied. */
  | { readonly kind: "invalid"; readonly line: number; readonly reason: string }
  | {
      readonly kind: "unreadable";
      readonly category:
        | "unreachable"
        | "rejected"
        | "not_a_file"
        | "too_large"
        | "malformed_response";
    };

export interface DeclarationDeps {
  readonly fetchImpl: typeof fetch;
  readonly apiOrigin: string;
}

// GitHub sends line-broken standard base64; the helper reads the URL-safe alphabet.
function decodeContent(content: string): string | null {
  const bytes = decodeBase64Url(
    content.replace(/\s+/g, "").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
  );
  if (bytes === null) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Reads `.oncue/project.yaml` under the caller's `contents: read` token. `sha`
 * is a commit the control plane resolved, never a ref name.
 */
export async function readDeclaredSecrets(
  deps: DeclarationDeps,
  token: string,
  repositoryFullName: string,
  sha: string,
): Promise<DeclarationRead> {
  const upstream = await githubFetch(
    deps.fetchImpl,
    `${deps.apiOrigin}/repos/${repositoryFullName}/contents/${PROJECT_FILE_PATH}?ref=${encodeURIComponent(sha)}`,
    { method: "GET", headers: githubHeaders(token) },
  );
  if (upstream === null) {
    return { kind: "unreadable", category: "unreachable" };
  }
  if (upstream.status === 404) {
    return { kind: "none" };
  }
  if (upstream.status !== 200) {
    return { kind: "unreadable", category: "rejected" };
  }
  const body: unknown = await upstream.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    // GitHub answers an array for a directory.
    return {
      kind: "unreadable",
      category: Array.isArray(body) ? "not_a_file" : "malformed_response",
    };
  }
  const entry = body as Record<string, unknown>;
  if (entry.type !== "file") {
    // A symlink or a submodule: never followed.
    return { kind: "unreadable", category: "not_a_file" };
  }
  if (typeof entry.size !== "number" || entry.size > MAX_PROJECT_FILE_BYTES) {
    return { kind: "unreadable", category: "too_large" };
  }
  if (entry.encoding !== "base64" || typeof entry.content !== "string") {
    return { kind: "unreadable", category: "malformed_response" };
  }
  if (entry.content.length > MAX_PROJECT_FILE_BYTES * 2) {
    // The size field is GitHub's word; the bytes are what is parsed.
    return { kind: "unreadable", category: "too_large" };
  }
  const text = decodeContent(entry.content);
  if (text === null) {
    return { kind: "unreadable", category: "malformed_response" };
  }
  const parsed = readProjectYaml(text);
  if (parsed.kind === "error") {
    return { kind: "invalid", line: parsed.error.line, reason: parsed.error.reason };
  }
  const secrets = parsed.file.secrets;
  if (secrets === undefined || secrets.required.length + secrets.optional.length === 0) {
    return { kind: "none" };
  }
  return { kind: "declared", secrets };
}

export interface DisclosedSecret {
  readonly name: string;
  /** A usable value is saved for this workspace and repository. */
  readonly saved: boolean;
  /** Not in the declaration the user last launched this repository with. */
  readonly isNew: boolean;
}

export interface Disclosure {
  readonly required: readonly DisclosedSecret[];
  readonly optional: readonly DisclosedSecret[];
}

/** The card's three groups, from names alone: Required and Optional here, Missing is `saved: false`. */
export function planDisclosure(
  declared: DeclaredSecrets,
  savedNames: readonly string[],
  lastDisclosedNames: readonly string[] | null,
): Disclosure {
  const entry = (name: string): DisclosedSecret => ({
    name,
    saved: savedNames.includes(name),
    isNew: lastDisclosedNames !== null && !lastDisclosedNames.includes(name),
  });
  return { required: declared.required.map(entry), optional: declared.optional.map(entry) };
}

/** What the user confirmed on the card, as the create request carries it. Names only. */
export interface SecretSelection {
  /** The optional names the user ticked. */
  readonly optional: readonly string[];
  /** "Start anyway" with a required name missing. */
  readonly startWithoutMissing: boolean;
}

export interface PinnedSecret {
  readonly name: string;
  readonly kind: "required" | "optional";
  /** Supplied at launch. An optional name left unticked stays pinned, so the agent may ask for it mid-run. */
  readonly selected: boolean;
}

export type LaunchJudgement =
  | {
      readonly kind: "launch";
      readonly pinned: readonly PinnedSecret[];
      /** Required names with nothing saved, which the user chose to start without. */
      readonly missingRequired: readonly string[];
    }
  | {
      readonly kind: "refuse";
      readonly reason:
        | "disclosure_required"
        | "undeclared_name"
        | "unsaved_name"
        | "missing_required";
    };

/**
 * The launch check against the control plane's own read; the browser's
 * selection is only a claim. A declaring repository needs a selection, a
 * ticked name must be declared optional and saved, and a missing required name
 * needs an explicit "start anyway".
 */
export function judgeLaunch(
  declared: DeclaredSecrets | null,
  savedNames: readonly string[],
  selection: SecretSelection | null,
): LaunchJudgement {
  if (declared === null) {
    return { kind: "launch", pinned: [], missingRequired: [] };
  }
  if (selection === null) {
    return { kind: "refuse", reason: "disclosure_required" };
  }
  for (const name of selection.optional) {
    if (!declared.optional.includes(name)) {
      return { kind: "refuse", reason: "undeclared_name" };
    }
    if (!savedNames.includes(name)) {
      return { kind: "refuse", reason: "unsaved_name" };
    }
  }
  const missingRequired = declared.required.filter((name) => !savedNames.includes(name));
  if (missingRequired.length > 0 && !selection.startWithoutMissing) {
    return { kind: "refuse", reason: "missing_required" };
  }
  return {
    kind: "launch",
    pinned: [
      ...declared.required.map((name) => ({
        name,
        kind: "required" as const,
        selected: savedNames.includes(name),
      })),
      ...declared.optional.map((name) => ({
        name,
        kind: "optional" as const,
        selected: selection.optional.includes(name),
      })),
    ],
    missingRequired,
  };
}
