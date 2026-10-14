// Secrets and per-deployment bindings that `wrangler types` cannot generate
// from `wrangler.jsonc`, checked in so a clean machine sees them.

// Declared twice: Worker code reads the global `Env`, and tests reading
// "cloudflare:test" get `Cloudflare.Env`. Both must be augmented.
declare global {
  namespace Cloudflare {
    interface Env {
      readonly ONCUE_BROKER_KEYRING?: string;
      readonly ONCUE_PROVIDER_DOUBLE_ORIGIN?: string;
      readonly ONCUE_GITHUB_APP_ID?: string;
      readonly ONCUE_GITHUB_APP_SLUG?: string;
      readonly ONCUE_GITHUB_APP_PRIVATE_KEY?: string;
      readonly ONCUE_GITHUB_CLIENT_ID?: string;
      readonly ONCUE_GITHUB_CLIENT_SECRET?: string;
      readonly ONCUE_GITHUB_WEBHOOK_SECRET?: string;
      readonly ONCUE_GITHUB_API_ORIGIN?: string;
      readonly ONCUE_SANDBOX_CONTROLLER_ORIGIN?: string;
      readonly ONCUE_SANDBOX_CONTROLLER_TOKEN?: string;
    }
  }

  interface Env {
    /**
     * The broker's keyring, `"<version>:<base64url 32 bytes>,..."`, newest first.
     * The first entry seals and signs; any entry opens what names it, so rotation
     * is a prepend. A secret, never a var, so a test value cannot ship.
     */
    readonly ONCUE_BROKER_KEYRING?: string;

    /**
     * Local only: redirects provider traffic to the provider double. Compared
     * against the environment name as a plain string, since `env.ONCUE_ENV` is
     * typed as the literal "local".
     */
    readonly ONCUE_PROVIDER_DOUBLE_ORIGIN?: string;

    /** The GitHub App's id, for the App JWT; kept beside the private key it accompanies. */
    readonly ONCUE_GITHUB_APP_ID?: string;

    /** The App's public slug in its install URL; per deployment, so not a var. */
    readonly ONCUE_GITHUB_APP_SLUG?: string;

    /**
     * The GitHub App's private key (PKCS#8 PEM), which signs the App JWT. It
     * never leaves the control plane: not the sandbox, D1, R2, logs, or artifacts.
     */
    readonly ONCUE_GITHUB_APP_PRIVATE_KEY?: string;

    /** The App's OAuth client id; kept beside the client secret. */
    readonly ONCUE_GITHUB_CLIENT_ID?: string;

    /** The App's OAuth client secret. Never logged or stored; only the tokens it yields are sealed. */
    readonly ONCUE_GITHUB_CLIENT_SECRET?: string;

    /** Verifies `X-Hub-Signature-256` on an inbound webhook before any of it is acted on. */
    readonly ONCUE_GITHUB_WEBHOOK_SECRET?: string;

    /** Local only, like `ONCUE_PROVIDER_DOUBLE_ORIGIN`: redirects GitHub API traffic to the double. */
    readonly ONCUE_GITHUB_API_ORIGIN?: string;

    /** The sandbox controller's `*.modal.run` origin. Without it or the token, sessions use the fake driver. */
    readonly ONCUE_SANDBOX_CONTROLLER_ORIGIN?: string;

    /**
     * Authenticates the control plane to its sandbox controller and grants no
     * Modal authority. There is deliberately no deployment-wide Modal token:
     * each workspace's own pair comes from its `modal_connection` row.
     */
    readonly ONCUE_SANDBOX_CONTROLLER_TOKEN?: string;
  }
}

export {};
