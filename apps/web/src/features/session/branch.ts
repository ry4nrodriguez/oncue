/**
 * The session's task branch (record 07). There is none until the first push
 * names it; before that `repository.status` reports the base branch. The
 * latest push names it, else the session record's column, so a reloaded page
 * learns a name given while it was closed.
 */
import type { SessionView } from "@oncue/protocol";

export function namedBranch(view: SessionView, taskBranch: string | null): string | null {
  let latest: string | null = null;
  for (const push of view.git.pushes.values()) {
    latest = push.branch;
  }
  return latest ?? taskBranch;
}
