/**
 * Gives the test subject's workspace a sealed Modal connection, since session
 * creation refuses a workspace without one. Kept out of `lane-auth.ts`, which
 * is in the node typecheck project, because the seed pulls in Worker code.
 */
import {
  DOUBLE_MODAL_PAIR,
  existingIdsFor,
  modalConnectionStatements,
  workspaceStatements,
} from "../scripts/seed-local";
import { devVars, SETUP_HINT } from "./lane-auth";
import { queryD1 } from "./local-d1";

export async function laneModalConnectionStatements(): Promise<string[]> {
  const vars = devVars();
  const subject = vars.get("ONCUE_LANE_SUBJECT");
  const keyringSecret = vars.get("ONCUE_BROKER_KEYRING");
  if (subject === undefined || keyringSecret === undefined) {
    throw new Error(`no lane subject or keyring in apps/web/.dev.vars; ${SETUP_HINT}`);
  }
  return [
    ...(await workspaceStatements(subject)),
    ...(await modalConnectionStatements({
      subject,
      keyringSecret,
      modalPair: DOUBLE_MODAL_PAIR,
      modalWorkspaceName: "oncue-local-double",
      existing: await existingIdsFor(subject, queryD1),
    })),
  ];
}
