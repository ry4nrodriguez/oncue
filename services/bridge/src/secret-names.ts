/**
 * Which names and values a development secret may have (record 08). Shared: the
 * control plane checks at save and launch, and the supervisor checks again
 * before root writes anything, because a name reaches it through the bridge.
 *
 * A name becomes an environment variable and a file name under the secrets
 * directory. The refusals keep out variables that change how a process loads
 * code, and the platform's own credentials, which reach a sandbox only through
 * the Model Broker and the exact-ref push.
 */

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Variables the agent's allowlisted environment already owns, or that steer a shell, a loader, or a runtime. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TERM",
  "TMPDIR",
  "CI",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "IFS",
  "ENV",
  "BASH_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "PERL5OPT",
  "JAVA_TOOL_OPTIONS",
]);

const RESERVED_PREFIXES: readonly string[] = [
  "LD_",
  "DYLD_",
  "GIT_",
  "XDG_",
  "LC_",
  "ONCUE_",
  "OPENCODE_",
];

/** Model-provider, forge, and infrastructure credentials. A development secret is never one of these. */
const PLATFORM_CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_APP_PRIVATE_KEY",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "CLERK_SECRET_KEY",
  "CLOUDFLARE_API_TOKEN",
]);

/** The shape alone. What a repository's file may declare and the interface may render. */
export function isSecretName(value: string): boolean {
  return SECRET_NAME.test(value);
}

export type SecretNameRefusal = "malformed" | "reserved" | "platform_credential";

/** As many secrets as a project may declare, a grant may carry, and the supervisor will write. */
export const MAX_SECRETS = 20;

/** Null when the name may be saved and supplied. */
export function refuseSecretName(name: string): SecretNameRefusal | null {
  if (!isSecretName(name)) {
    return "malformed";
  }
  if (RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return "reserved";
  }
  if (PLATFORM_CREDENTIAL_NAMES.has(name)) {
    return "platform_credential";
  }
  return null;
}

/** Below this the redactor cannot protect a value (`packages/protocol/src/redact.ts`), so it is never stored. */
export const MIN_SECRET_VALUE_CHARS = 8;
/** Half the supervisor's cap on one environment value, so a supplied value always fits. */
export const MAX_SECRET_VALUE_BYTES = 32 * 1024;

export type SecretValueRefusal = "too_short" | "too_long" | "control_character";

/**
 * A newline or a NUL cannot survive as one environment value or one line of
 * a file a shell reads, and either would let a value smuggle a second one.
 */
export function refuseSecretValue(value: string): SecretValueRefusal | null {
  if (value.length < MIN_SECRET_VALUE_CHARS) {
    return "too_short";
  }
  if (new TextEncoder().encode(value).byteLength > MAX_SECRET_VALUE_BYTES) {
    return "too_long";
  }
  if (/[\0\r\n]/.test(value)) {
    return "control_character";
  }
  return null;
}
