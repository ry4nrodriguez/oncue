// The additional data a Modal token half is sealed under, reusing the broker's
// envelope; separation comes from this context, not a new key purpose. It binds
// `connection_id | workspace_id | modal_<half>`, so a ciphertext from another
// table, another workspace, or the other half of the same row fails the AEAD
// tag. The halves share a row and a shape, hence a per-half discriminator. The
// `Record` over the closed union makes a third half a compile error.

import type { CredentialContext } from "../broker/envelope";

export type ModalTokenHalf = "token_id" | "token_secret";

const PROVIDER: Readonly<Record<ModalTokenHalf, string>> = {
  token_id: "modal_token_id",
  token_secret: "modal_token_secret",
};

/**
 * `connectionId` is OnCue's own id, not Modal's: a bound value must be one the
 * control plane created, since an outside identifier can be chosen by its sender.
 */
export function modalTokenContext(
  connectionId: string,
  workspaceId: string,
  half: ModalTokenHalf,
): CredentialContext {
  return {
    connectionId,
    workspaceId,
    provider: PROVIDER[half],
  };
}
