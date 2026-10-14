import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import type { GitHubRecordedCall } from "../worker/test/github-double";
import {
  EDIT_FILE_CONTENT,
  EDIT_FILE_PATH,
  REQUESTED_SECRET_NAME,
} from "../worker/test/provider-double";
import { scan } from "./a11y-scan";
import { appOrigin, DEFAULT_APP_ORIGIN } from "./app-origin";
import { cascadeDelete } from "./cascade-delete";
import { createSeedRepository } from "./github-bare-repo";
import { GITHUB_DOUBLE_ORIGIN, startGitHubDouble } from "./github-double-server";
import { laneIdentity } from "./lane-auth";
import { queryD1Batch } from "./local-d1";
import {
  PROVIDER_DOUBLE_ORIGIN,
  type RecordedDoubleCall,
  startProviderDouble,
} from "./provider-double-server";
import { expectRuntimeReady } from "./runtime-ready";
import {
  DOUBLE_WORKSPACE_NAME,
  type RunningControllerDouble,
  startControllerDouble,
} from "./sandbox-controller-double";
import { openModalPanel, pinSessionDetails } from "./session-details";
import { LANE_IDLE_ALARM_SECONDS, WALKTHROUGH_SUBJECT } from "./setup-local-auth.mjs";

/**
 * The path a person walks: sign in, connect GitHub, add a model key, connect
 * Modal, send a task, and follow the session through checks, a push, an idle
 * stop, and a resume. Every step is a real click against the real Worker; only
 * GitHub, the model provider, and Modal are doubles, and the Modal double runs
 * the real bridge bundle. A double never covers for our own code.
 *
 * Runs in its own project, after every other, because it needs all three
 * doubles on their fixed ports and its own subject's workspace emptied.
 */

let ORIGIN = DEFAULT_APP_ORIGIN;
const SHOTS = "/tmp/walkthrough-lane";

// Its own GitHub user and installation: record 07 links a GitHub identity to
// one OnCue user, and `github.spec.ts` leaves octocat linked to `user_lane`.
const GITHUB_USER_ID = 4242;
const INSTALLATION_ID = 4002;

/**
 * Empties the walkthrough subject's workspace so setup starts from step 1,
 * finding referencing rows from the schema (`e2e/cascade-delete.ts`).
 */
async function emptyWalkthroughWorkspace(): Promise<void> {
  const where = `workspace_id IN (SELECT w.id FROM workspace w JOIN external_identity e ON e.user_id = w.owner_user_id WHERE e.subject = '${WALKTHROUGH_SUBJECT}')`;
  await cascadeDelete(
    [
      { table: "session_index", where },
      { table: "github_installation", where },
      { table: "model_connection", where },
      { table: "modal_connection", where },
    ],
    queryD1Batch,
  );
}

let closers: Array<() => Promise<void>> = [];
let controllerDouble: RunningControllerDouble | null = null;
let widgetsBareDir = "";

/** What the double's bare repository holds at `ref:path`, as GitHub would serve it. */
let providerDouble: Awaited<ReturnType<typeof startProviderDouble>> | null = null;

interface PullRequestOnGitHub {
  readonly draft: boolean;
  readonly base: string;
  readonly head: string;
  readonly body: string;
}

async function pullRequestsOnGitHub(): Promise<PullRequestOnGitHub[]> {
  const answer = await fetch(`${GITHUB_DOUBLE_ORIGIN}/__pulls`);
  return ((await answer.json()) as { pullRequests: PullRequestOnGitHub[] }).pullRequests;
}

async function githubCallLog(): Promise<GitHubRecordedCall[]> {
  const answer = await fetch(`${GITHUB_DOUBLE_ORIGIN}/__calls`);
  return ((await answer.json()) as { calls: GitHubRecordedCall[] }).calls;
}

async function providerCallLog(): Promise<RecordedDoubleCall[]> {
  const answer = await fetch(`${PROVIDER_DOUBLE_ORIGIN}/__calls`);
  return ((await answer.json()) as { calls: RecordedDoubleCall[] }).calls;
}

/** The levels the provider double saw on the model requests among `calls`, as one set. */
function effortsSeen(calls: readonly RecordedDoubleCall[], path: string): Set<string | null> {
  const model = calls.filter((call) => call.path === path);
  expect(model.length, `no ${path} request reached the provider double`).toBeGreaterThan(0);
  return new Set(model.map((call) => call.effort));
}

const MODEL_TRIGGER = "button[aria-label^='Model:']";

async function railText(page: Page): Promise<string> {
  await pinSessionDetails(page);
  return page.getByTestId("context-rail").innerText();
}

function branchOf(rail: string): string {
  return /oncue\/[A-Za-z0-9._-]+/.exec(rail)?.[0] as string;
}

function bareRefs(): string[] {
  return execFileSync("git", ["--git-dir", widgetsBareDir, "for-each-ref", "--format=%(refname)"], {
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

function bareFile(ref: string, path: string): string {
  return execFileSync("git", ["--git-dir", widgetsBareDir, "show", `${ref}:${path}`], {
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");
}

// A real OpenCode boots twice, once per generation, with an idle stop between,
// which does not fit the suite's default budget.
test.setTimeout(480_000);

test.afterEach(async ({ page }, info) => {
  if (info.status !== "passed") {
    const text = await page
      .evaluate(() => document.body.innerText)
      .catch((error: unknown) => `(no page text: ${String(error)})`);
    console.log(`page text at failure:\n${text}`);
  }
});

test.beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  ORIGIN = await appOrigin();

  // A real bare repository behind the double, so the bridge's clone finds a
  // tree at the recorded base sha. It declares one optional development
  // secret and no required one.
  const widgets = createSeedRepository("acme/widgets", "main", {
    ".oncue/project.yaml": [
      "version: 1",
      "secrets:",
      "  optional:",
      `    - ${REQUESTED_SECRET_NAME}`,
      "",
    ].join("\n"),
  });
  widgetsBareDir = widgets.bareDir;
  const github = await startGitHubDouble(undefined, ORIGIN);
  await github.setState({
    users: [{ id: GITHUB_USER_ID, login: "walkthrough" }],
    installations: [
      {
        installationId: INSTALLATION_ID,
        account: { login: "acme", type: "Organization" },
        appSlug: "oncue-local",
        visibleToUserIds: [GITHUB_USER_ID],
      },
    ],
    repositoriesByInstallation: {
      [INSTALLATION_ID]: [
        { id: 501, fullName: "acme/widgets", defaultBranch: "main", cloneUrl: widgets.cloneUrl },
      ],
    },
    refsByRepository: { "acme/widgets": { main: widgets.sha } },
  });
  const provider = await startProviderDouble();
  providerDouble = provider;
  // The model asks OpenCode to write a file, so the idle checkpoint below has
  // real work to push and the resumed generation has something to restore.
  await provider.setMode("edit_file");
  const controller = await startControllerDouble({
    controlPlaneOrigin: ORIGIN,
    // Printed, so the log shows what the bridge and OpenCode said when a boot
    // is slow.
    bridgeStdio: "inherit",
  });
  controllerDouble = controller;
  closers = [() => github.close(), () => provider.close(), () => controller.close()];

  await emptyWalkthroughWorkspace();
});

test.afterAll(async () => {
  for (const close of closers) {
    await close();
  }
});

test("sign in, connect everything, send a task, watch the sandbox settle, go idle, checkpoint, stop, and resume with the work", async ({
  page,
  context,
}) => {
  // Sign in: the cookie the Worker verifies with its real Clerk verification
  // against the local key pair, set by the same route a developer uses.
  await context.addCookies([
    {
      name: "__session",
      value: laneIdentity(ORIGIN, WALKTHROUGH_SUBJECT).cookie.replace("__session=", ""),
      url: ORIGIN,
    },
    { name: "oncue_dev_app", value: "1", url: ORIGIN },
  ]);
  // The provider double's call log is never cleared (the test may be attached
  // to `pnpm dev`'s), so every count below is relative to this point.
  const callsAtStart = (await providerCallLog()).length;
  // `commit` rather than `load`: the dev server may reload the page once while
  // it optimizes a dependency, and every assertion below waits on its own.
  await page.goto(`${ORIGIN}/`, { waitUntil: "commit" });

  // Step 1 of 3: the gate sends an empty workspace to setup, and the install
  // button goes to the App's install page, which the double answers by
  // sending the browser back to the real callback with a code it minted.
  await expect(page.getByText("Step 1 of 3")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/1-connect-github.png` });
  await page.getByRole("button", { name: "Install the OnCue GitHub App" }).click();

  // The callback redirects to the repositories screen, and the gate sends a
  // workspace with no Modal connection to the Modal step. Step 3 of 3: the
  // Modal pair, tested against the controller double.
  await expect(page.getByText("Step 3 of 3")).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("Token ID").fill("ak-walkthrough");
  await page.getByLabel("Token secret").fill("as-walkthrough");
  await page.screenshot({ path: `${SHOTS}/2-connect-modal.png` });
  await page.getByRole("button", { name: "Test and connect" }).click();

  // Home, with the skippable model step offered from the canvas. Step 2 of 3:
  // a model key validated against the provider double.
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("home-guidance")).toContainText("model connection");
  await page.screenshot({ path: `${SHOTS}/3-home-without-model.png` });
  await page.getByRole("link", { name: "Finish setup" }).click();
  await expect(page.getByText("Step 2 of 3")).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("API key").fill("sk-ant-walkthrough-key");
  await page.screenshot({ path: `${SHOTS}/4-add-model-key.png` });
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Home again, fully set up: the composer, the repository picked, no guidance.
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("home-guidance")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/5-home.png` });
  await composer.fill("Add a health endpoint");
  await page.getByRole("button", { name: "Send message" }).click();

  // The repository declares a development secret, so the launch stops at the
  // disclosure card. Nothing is saved yet, so the name is Missing, and the
  // session starts without it on a click.
  const disclosure = page.getByTestId("disclosure-card");
  await expect(disclosure).toContainText("acme/widgets asks for development secrets", {
    timeout: 15_000,
  });
  await expect(disclosure.getByTestId("disclosure-missing")).toContainText(REQUESTED_SECRET_NAME);
  await expect(disclosure.getByTestId("disclosure-required")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/5a-disclosure.png`, fullPage: true });
  // Record 13's accessibility bar, on the real card with a real workspace behind it.
  expect(await scan(page, "disclosure card")).toEqual([]);
  await disclosure.getByRole("button", { name: "Start session" }).click();

  // The row appears once the object commits `sandbox.provisioning`, and
  // settles once the spawned bridge sends `runtime.connected` itself.
  await expect(page).toHaveURL(/\/sessions\//, { timeout: 15_000 });
  const row = page.getByTestId("row-sandbox");
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toContainText("Bridge connected, waiting for the agent runtime", {
    timeout: 20_000,
  });
  await expect(row).toHaveAttribute("data-state-kind", "running");
  // Only a real OpenCode answering its health check puts this label on the
  // row. Then the provider double's three chunks arrive as one message.
  await expectRuntimeReady(row);
  // The agent chip shows the recommended model at its default effort, both
  // recorded on the run (records 06 and 15).
  await expect(page.locator(MODEL_TRIGGER)).toContainText("Opus 5.5");
  await expect(page.getByTestId("agent-chip-effort")).toHaveText("medium");
  // The run's start row is folded inside the first activity group (record 13).
  await expect(page.getByText("Run started")).toBeAttached({ timeout: 30_000 });
  await expect(
    page.getByTestId("row-message-assistant").filter({ hasText: "chunk-0 chunk-1 chunk-2" }),
  ).toBeVisible({ timeout: 60_000 });

  // The model's tool call wrote one file, so the bridge's Git measured a turn
  // diff and the response ends with a change card naming it.
  const firstCard = page.getByTestId("row-changes").first();
  await expect(firstCard).toContainText("Edited 1 file", { timeout: 60_000 });
  await expect(firstCard.getByTestId("change-card-file")).toHaveCount(1);
  await expect(firstCard.getByTestId("change-card-file")).toContainText(EDIT_FILE_PATH);
  // The object accepts `run.verified` only because both required checks have
  // a passing record with its log committed.
  // `row-run` also marks "Run started"; only an outcome carries `data-outcome`.
  const outcomes = page.locator("[data-testid='row-run'][data-outcome]");
  const firstOutcome = outcomes.first();
  await expect(firstOutcome).toHaveAttribute("data-outcome", "verified", { timeout: 90_000 });
  await expect(firstOutcome).toContainText("Verified");
  // The Model Broker wrote the run's effort into every request as
  // `output_config.effort` (record 06).
  expect(effortsSeen((await providerCallLog()).slice(callsAtStart), "/v1/messages")).toEqual(
    new Set(["medium"]),
  );
  await expect(firstOutcome.getByTestId("outcome-evidence")).toContainText(
    "test passed, typecheck passed",
  );
  await page.screenshot({ path: `${SHOTS}/6a-verified.png`, fullPage: true });

  // The review pane from the rail's Changes row: every change in the session.
  await pinSessionDetails(page);
  await page.getByTestId("rail-changes").click();
  const review = page.getByTestId("review-panel");
  await expect(review).toBeVisible();
  await expect(review.getByTestId("review-scope")).toHaveText("All changes");
  await expect(review.getByTestId("review-diff-scroll")).toContainText(EDIT_FILE_PATH);
  await expect(review.getByTestId("review-diff-scroll")).toContainText(EDIT_FILE_CONTENT);
  await page.screenshot({ path: `${SHOTS}/6b-review-all-changes.png`, fullPage: true });

  // Its Tests tab: both checks passed, and each full output is the uploaded
  // log served by the authorized download route.
  await review.getByRole("tab", { name: "Tests" }).click();
  const checks = review.getByTestId("tests-check");
  await expect(checks).toHaveCount(2);
  await expect(checks.filter({ hasText: "typecheck" })).toContainText("passed");
  await expect(checks.filter({ hasNotText: "typecheck" })).toContainText("passed");
  // Each row starts closed; its output and the Full output link wait behind
  // the chevron.
  await expect(review.getByTestId("check-full-output")).toHaveCount(0);
  for (const row of await checks.all()) {
    await row.getByRole("button", { expanded: false }).click();
  }
  await expect(review.getByTestId("check-full-output")).toHaveCount(2);
  const [download, artifactResponse] = await Promise.all([
    page.waitForEvent("download"),
    page.waitForResponse((response) => /\/api\/sessions\/[^/]+\/artifacts\//.test(response.url())),
    review.getByTestId("check-full-output").first().click(),
  ]);
  expect(artifactResponse.status()).toBe(200);
  expect(download.suggestedFilename().length).toBeGreaterThan(0);
  await expect(review.getByTestId("artifact-unavailable")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/6c-tests.png`, fullPage: true });
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(review).toBeHidden();
  // Modal's mark, because the session ran on the Modal driver (against the
  // double); the fake driver's glyph would mean the wrong driver ran.
  await expect(row.locator("button svg").first()).toHaveAttribute("viewBox", "0 0 404 211");
  // Still one row: the lifecycle updates it in place.
  await expect(page.getByTestId("row-sandbox")).toHaveCount(1);
  // The side panel's Modal tab reads as running and shows what the
  // controller answered; the composer says nothing about the sandbox.
  await expect(page.getByTestId("composer-strip")).not.toContainText("Modal");
  // The button that opens the side panel carries the sandbox's dot while it runs.
  await expect(page.getByTestId("panel-sandbox-dot")).toHaveAttribute("data-phase", "running");
  await openModalPanel(page);
  await expect(page.getByTestId("panel-modal-phase")).toHaveText("Running");
  await expect(page.getByTestId("panel-modal-output")).toContainText("answered in");
  await expect(page.getByTestId("stop-sandbox")).toBeVisible();
  // The rail gives way to the panel while one is open; closing it brings the
  // rail back. No branch exists yet: it is named at the first push.
  await page.getByRole("button", { name: "Close panel" }).click();
  await pinSessionDetails(page);
  await expect(page.getByTestId("context-rail")).toContainText("Branch named at the first push");
  await page.screenshot({ path: `${SHOTS}/6-session-bridge-connected.png`, fullPage: true });

  // "Push this and open a draft PR". A fresh session neither pushes nor opens
  // a pull request. The model calls OnCue's policy tool, served to OpenCode by
  // the bridge, which only asks above the composer; nothing reaches GitHub
  // until the click.
  await expect(page.getByTestId("rail-git-behavior")).toHaveText("Commits · Does not push");
  await providerDouble?.setMode("propose_push");
  await composer.fill("Push this and open a draft PR");
  await page.getByRole("button", { name: "Send message" }).click();
  const card = page.getByTestId("policy-card");
  await expect(card).toBeVisible({ timeout: 90_000 });
  await expect(card).toHaveText(
    /Allow pushes after each run and a draft PR after each push on acme\/widgets\?/,
  );
  // The run changed no files, so it ends Done with no checks (record 14), the
  // card still waits, and GitHub has no pull request.
  await expect(outcomes).toHaveCount(2, { timeout: 90_000 });
  await expect(outcomes.nth(1)).toHaveAttribute("data-outcome", "completed");
  await expect(outcomes.nth(1)).toContainText("Done");
  await expect(outcomes.nth(1).getByTestId("outcome-no-changes")).toBeVisible();
  await expect(card).toBeVisible();
  // With the rail pinned open over the conversation's right edge, the card's
  // buttons are still in plain view: nothing covers the point a person clicks.
  const confirm = card.getByRole("button", { name: "Allow" });
  const box = (await confirm.boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  const topmost = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x as number, y as number)?.textContent ?? "",
    [box.x + box.width / 2, box.y + box.height / 2],
  );
  expect(topmost).toBe("Allow");
  expect(await pullRequestsOnGitHub()).toEqual([]);
  // No branch exists yet: it is named at the first push. The Pull request tab
  // prefills the name with a four-hex suffix after the fixed `oncue/` prefix.
  expect(await railText(page)).not.toMatch(/oncue\//);
  expect(bareRefs().filter((ref) => ref.startsWith("refs/heads/oncue/"))).toEqual([]);
  await expect(card.getByTestId("branch-name-input")).toHaveCount(0);
  await page.getByTestId("rail-pull-request-open").click();
  const branchInput = page.getByTestId("panel-pull-request").getByTestId("branch-name-input");
  await expect(branchInput).toHaveValue(/^[a-z0-9-]+-[0-9a-f]{4}$/);
  const chosenBranch = `oncue/${await branchInput.inputValue()}`;
  await expect(page.getByTestId("panel-pull-request")).toContainText("None yet");
  await page.getByLabel("Close panel").click();
  await page.screenshot({ path: `${SHOTS}/6d-policy-card.png`, fullPage: true });

  // One click: the bridge pushes the session branch and nothing else, and the
  // control plane opens the draft with the run's verification section.
  const clickedAt = Date.now();
  await card.getByRole("button", { name: "Allow" }).click();
  await expect(page.getByTestId("row-policy-updated")).toContainText(
    "You confirmed a Git behavior change",
  );
  await expect(page.getByTestId("row-commit")).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId("row-push").last()).toContainText("completed");
  await expect(page.getByTestId("row-pull-request")).toContainText("#1 created", {
    timeout: 30_000,
  });
  console.log(`[walkthrough] click to pull_request.created: ${Date.now() - clickedAt} ms`);
  await expect(page.getByTestId("rail-git-behavior")).toHaveText(
    "Commits · Pushes · Draft pull request",
  );
  const publishedBranch = branchOf(await railText(page));
  expect(publishedBranch).toBe(chosenBranch);
  expect(bareFile(`refs/heads/${publishedBranch}`, EDIT_FILE_PATH).trim()).toBe(EDIT_FILE_CONTENT);
  const [pullRequest] = await pullRequestsOnGitHub();
  expect(pullRequest).toMatchObject({ draft: true, base: "main", head: publishedBranch });
  expect(pullRequest?.body).toContain("<!-- oncue:verification:start -->");
  expect(pullRequest?.body).toContain("Every required check passed.");
  expect(pullRequest?.body).toContain("- `test`: passed");
  expect(pullRequest?.body).toContain("- `typecheck`: passed");
  expect(pullRequest?.body).toContain(
    `/sessions/${new URL(page.url()).pathname.split("/").at(-1)}`,
  );
  // Both tokens were narrowed and both were revoked: the push's and the pull request's.
  const githubCalls = await githubCallLog();
  // `contents: write` once, for this push; session creation mints only the
  // project-file read.
  expect(
    githubCalls.filter((call) => call.tokenNarrowing?.permissions.contents === "write"),
  ).toHaveLength(1);
  expect(
    githubCalls.filter((call) => call.tokenNarrowing?.permissions.pull_requests === "write"),
  ).toHaveLength(1);
  expect(githubCalls.at(-1)).toMatchObject({ path: "/installation/token", tokenRevoked: true });
  // By the double's clock, the push token lives under five seconds from mint
  // to revocation.
  const pushMintAt = githubCalls
    .filter((call) => call.tokenNarrowing?.permissions.contents === "write")
    .at(-1)?.atMs as number;
  const pushRevokedAt = githubCalls.find(
    (call) => call.tokenRevoked === true && call.atMs >= pushMintAt,
  )?.atMs as number;
  expect(pushRevokedAt - pushMintAt).toBeGreaterThanOrEqual(0);
  expect(pushRevokedAt - pushMintAt).toBeLessThan(5_000);
  console.log(`[walkthrough] push token lived ${pushRevokedAt - pushMintAt} ms`);

  // The rail names the session's pull request and opens the panel's Pull
  // request tab, where the branch is now fixed and GitHub is a link away.
  await pinSessionDetails(page);
  await expect(page.getByTestId("rail-pull-request")).toContainText("#1");
  await expect(page.getByTestId("rail-pull-request")).toContainText("draft");
  await page.getByTestId("rail-pull-request-open").click();
  await expect(page.getByTestId("panel-branch-name")).toHaveText(chosenBranch);
  await expect(page.getByTestId("pull-request-link")).toHaveAttribute(
    "href",
    "https://github.com/acme/widgets/pull/1",
  );
  await page.screenshot({ path: `${SHOTS}/6e-draft-pull-request.png`, fullPage: true });

  // A development secret. The value is obviously fake and long enough that
  // finding it anywhere is no accident.
  const FAKE_SECRET = "fake-stripe-test-key-walkthrough-0001";
  const sessionPath = new URL(page.url()).pathname;
  const sessionId = sessionPath.split("/").at(-1) as string;
  // Saved once per repository under Settings; the value never comes back.
  await page.goto(`${ORIGIN}/settings/repositories`);
  await page.getByRole("button", { name: "Secrets", exact: true }).first().click();
  const secretsSection = page.getByTestId("repository-secrets");
  await expect(secretsSection).toContainText("No secrets saved");
  await secretsSection.getByLabel("Name").fill(REQUESTED_SECRET_NAME);
  await secretsSection.getByLabel("Value").fill(FAKE_SECRET);
  await page.screenshot({ path: `${SHOTS}/6f-settings-secret.png`, fullPage: true });
  expect(await scan(page, "settings secrets")).toEqual([]);
  await secretsSection.getByRole("button", { name: "Save" }).click();
  await expect(secretsSection.getByTestId("secret-row")).toContainText(REQUESTED_SECRET_NAME);
  expect(await page.content()).not.toContain(FAKE_SECRET);
  await page.goto(`${ORIGIN}${sessionPath}`, { waitUntil: "commit" });
  await expect(composer).toBeVisible({ timeout: 15_000 });

  // The model calls OnCue's secret tool for the unsupplied name. OpenCode
  // holds the call behind its permission gate and the control plane writes
  // the card from its own rows; nothing is in the sandbox yet.
  await expect(page.getByTestId("row-secrets-disclosed")).toContainText(
    `Not supplied: ${REQUESTED_SECRET_NAME}`,
  );
  await providerDouble?.setMode("request_secret");
  await composer.fill(`Use ${REQUESTED_SECRET_NAME} to check the billing sandbox`);
  await page.getByRole("button", { name: "Send message" }).click();
  const approval = page.getByTestId("approval-card");
  await expect(approval).toBeVisible({ timeout: 90_000 });
  await expect(approval.getByTestId("approval-target")).toHaveText(REQUESTED_SECRET_NAME);
  await expect(approval.getByTestId("approval-scope")).toContainText("generation 1");
  await expect(approval.getByTestId("approval-expiry")).toBeVisible();
  await pinSessionDetails(page);
  await expect(page.getByTestId("needs-you")).toContainText("An approval is waiting");
  const beforeApproval = await controllerDouble?.readHomeFiles(sessionId, 1);
  expect(JSON.stringify(beforeApproval)).not.toContain(FAKE_SECRET);
  expect(await page.content()).not.toContain(FAKE_SECRET);
  await page.screenshot({ path: `${SHOTS}/6g-approval-card.png`, fullPage: true });
  expect(await scan(page, "approval card")).toEqual([]);

  // One click: the value goes as a grant, and only after the bridge
  // acknowledges does the card say supplied and the held call run.
  await approval.getByRole("button", { name: "Approve" }).click();
  const approved = page.getByTestId("row-approval-approved");
  await expect(approved).toContainText(`You approved ${REQUESTED_SECRET_NAME}`);
  await expect(approved).toContainText("Supplied to this sandbox", { timeout: 30_000 });
  await pinSessionDetails(page);
  await expect(page.getByTestId("needs-you")).toHaveCount(0);
  await expect(outcomes).toHaveCount(3, { timeout: 90_000 });
  // The value is in its one file under the sandbox's home, and nowhere in
  // the work tree, the check logs, or anything the browser was sent.
  const afterApproval = (await controllerDouble?.readHomeFiles(sessionId, 1)) ?? {};
  const holders = Object.entries(afterApproval)
    .filter(([, text]) => text.includes(FAKE_SECRET))
    .map(([path]) => path);
  expect(holders).toEqual([`secrets/${REQUESTED_SECRET_NAME}`]);
  expect(await page.content()).not.toContain(FAKE_SECRET);
  // The agent prints the file. The bridge redacts the tool's output before it
  // leaves the sandbox, so the stored result holds the marker.
  await providerDouble?.setMode("print_secret");
  await composer.fill(`Print ${REQUESTED_SECRET_NAME}`);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(outcomes).toHaveCount(4, { timeout: 90_000 });
  await expect(page.getByTestId("row-tool").last()).toContainText("bash");
  // The opened row shows what the command printed (the marker), not the
  // command again.
  const printRow = page.getByTestId("row-tool").last();
  const printGroup = page
    .getByTestId("row-activity")
    .filter({ has: page.getByTestId("row-tool").filter({ hasText: "bash" }) })
    .last();
  if ((await printGroup.getAttribute("data-open")) === "false") {
    await printGroup.getByTestId("activity-trigger").click();
  }
  await printRow.getByRole("button").first().click();
  await expect(printRow.getByTestId("action-output")).toContainText("[REDACTED]");
  await expect(printRow.getByTestId("action-panel")).not.toContainText("Result");
  expect(await page.content()).not.toContain(FAKE_SECRET);
  await page.screenshot({ path: `${SHOTS}/6i-agent-reads-redacted.png`, fullPage: true });
  // Everything the browser is ever sent for this session: a fresh socket's
  // replay from the first event, read in the page as the app would read it.
  const replay = await page.evaluate(
    (id) =>
      new Promise<string>((resolve, reject) => {
        const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(
          `${scheme}//${window.location.host}/ws/sessions/${id}/client?after=0`,
        );
        const frames: string[] = [];
        let quiet: ReturnType<typeof setTimeout> | null = null;
        socket.onmessage = (event) => {
          frames.push(String(event.data));
          if (quiet !== null) clearTimeout(quiet);
          quiet = setTimeout(() => {
            socket.close();
            resolve(frames.join("\n"));
          }, 1_500);
        };
        socket.onerror = () => reject(new Error("the replay socket failed"));
      }),
    sessionId,
  );
  expect(replay).toContain("secrets.supplied");
  // The agent's `cat` of its own file, as the bridge sent it: the marker, not the value.
  expect(replay).toContain('"output":"[REDACTED]"');
  expect(replay).not.toContain(FAKE_SECRET);
  await page.screenshot({ path: `${SHOTS}/6h-secret-supplied.png`, fullPage: true });

  await providerDouble?.setMode("edit_file");

  // Record 11's idle stop: once quiet for the test's idle setting, the bridge
  // checkpoints the work under a push grant, the object takes back the
  // sandbox's credentials, and only then stops it.
  await pinSessionDetails(page);
  const branch = /oncue\/[A-Za-z0-9._-]+/.exec(
    await page.getByTestId("context-rail").innerText(),
  )?.[0] as string;
  const firstRow = page.getByTestId("row-sandbox").first();
  await expect(firstRow).toContainText("Sandbox stopped after going idle", {
    timeout: (LANE_IDLE_ALARM_SECONDS + 120) * 1000,
  });
  // A stopped sandbox leaves no dot on the side panel's button.
  await expect(page.getByTestId("panel-sandbox-dot")).toHaveCount(0);
  await expect(page.getByTestId("panel-toggle")).toHaveAccessibleName("Open side panel");
  await openModalPanel(page);
  await expect(page.getByTestId("panel-modal-phase")).toHaveText("Stopped after going idle");
  await page.getByRole("button", { name: "Close panel" }).click();
  await firstRow.getByRole("button").first().click();
  await expect(firstRow).toContainText("Pushed the session's branch");
  await expect(firstRow).toContainText("Took back the sandbox's credentials");
  expect(bareFile(`refs/heads/${branch}`, EDIT_FILE_PATH).trim()).toBe(EDIT_FILE_CONTENT);
  await page.screenshot({ path: `${SHOTS}/7-idle-stopped.png`, fullPage: true });

  // A follow-up resumes on generation 2, which clones the checkpoint, so the
  // first generation's edit is in the work tree. The effort may change on the
  // message (record 15), so generation 2's run records `high`.
  const chipEffort = page.getByTestId("agent-chip-effort");
  await expect(chipEffort).toHaveText("medium");
  await page.getByTestId("agent-chip").click();
  // The session keeps its harness; between runs the panel offers the models and the effort.
  await expect(page.getByTestId("agent-panel").getByTestId("model-picker")).toBeVisible();
  await page.getByRole("button", { name: "high", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(chipEffort).toHaveText("high");
  const callsBeforeResume = (await providerCallLog()).length;
  await composer.fill("Check the health file is still there");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("row-sandbox")).toHaveCount(2, { timeout: 30_000 });
  const resumedRow = page.getByTestId("row-sandbox").nth(1);
  await expectRuntimeReady(resumedRow);
  await resumedRow.getByRole("button").first().click();
  await expect(resumedRow).toContainText("Starting a sandbox to resume this session");
  expect((await controllerDouble?.readWorkspaceFile(sessionId, 2, EDIT_FILE_PATH))?.trim()).toBe(
    EDIT_FILE_CONTENT,
  );
  // The follow-up leaves the work tree as the checkpoint restored it, so there
  // is no second change card, and it ends Done with no checks (record 14).
  await expect(outcomes).toHaveCount(5, { timeout: 90_000 });
  await expect(outcomes.nth(4)).toHaveAttribute("data-outcome", "completed");
  await expect(outcomes.nth(4).getByTestId("outcome-evidence")).toHaveCount(0);
  await expect(page.getByTestId("row-changes")).toHaveCount(1);
  // The rail's Run checks starts a checks-only run that prompts nobody, and
  // both required checks pass on the restored tree.
  if ((await page.getByLabel("Close panel").count()) > 0) {
    await page.getByLabel("Close panel").click();
  }
  const callsBeforeChecks = (await providerCallLog()).length;
  await pinSessionDetails(page);
  await page.getByTestId("rail-run-checks").click();
  await expect(outcomes).toHaveCount(6, { timeout: 90_000 });
  await expect(outcomes.nth(5)).toHaveAttribute("data-outcome", "verified");
  await expect(outcomes.nth(5).getByTestId("outcome-evidence")).toContainText(
    "test passed, typecheck passed",
  );
  expect((await providerCallLog()).length).toBe(callsBeforeChecks);
  // Every request of the resumed run carried the new level, and the composer
  // now shows it as the run's own.
  expect(effortsSeen((await providerCallLog()).slice(callsBeforeResume), "/v1/messages")).toEqual(
    new Set(["high"]),
  );
  await expect(chipEffort).toHaveText("high");
  // The policy is the session's: generation 2's verified run publishes too,
  // updating the same pull request at the same head.
  await expect(page.getByTestId("row-pull-request").last()).toContainText("#1 updated", {
    timeout: 60_000,
  });
  const afterResume = await pullRequestsOnGitHub();
  expect(afterResume).toHaveLength(1);
  expect(afterResume[0]?.body.match(/oncue:verification:start/g)).toHaveLength(1);
  await page.screenshot({ path: `${SHOTS}/8-resumed.png`, fullPage: true });

  // The other provider: an OpenAI connection puts GPT-6 Sol in the picker, and
  // a session on it at `low` exercises the Responses path and the broker's
  // `reasoning.effort` injection. The double's OpenAI arm streams text only.
  await providerDouble?.setMode("ok");
  const savedOpenAI = await fetch(`${ORIGIN}/api/model-connections`, {
    method: "POST",
    headers: {
      cookie: laneIdentity(ORIGIN, WALKTHROUGH_SUBJECT).cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ provider: "openai", credential: "sk-openai-walkthrough-key" }),
  });
  expect(savedOpenAI.status, "the lane could not save an OpenAI connection").toBe(201);
  await page.goto(`${ORIGIN}/`, { waitUntil: "commit" });
  await expect(composer).toBeVisible({ timeout: 15_000 });
  // One panel holds the model and the effort. Picking a model closes it; the effort is set on reopening.
  await page.locator(MODEL_TRIGGER).click();
  await page
    .getByTestId("agent-panel")
    .getByRole("button", { name: /GPT-6 Sol/ })
    .click();
  await expect(page.locator(MODEL_TRIGGER)).toContainText("GPT-6 Sol");
  await expect(page.getByTestId("agent-panel")).toBeHidden();
  await page.locator(MODEL_TRIGGER).click();
  await page.getByRole("button", { name: "low", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("agent-chip-effort")).toHaveText("low");
  await page.screenshot({ path: `${SHOTS}/9-home-openai.png` });
  const callsBeforeOpenAI = (await providerCallLog()).length;
  await composer.fill("Say hello");
  await page.getByRole("button", { name: "Send message" }).click();
  const secondDisclosure = page.getByTestId("disclosure-card");
  await expect(secondDisclosure).toBeVisible({ timeout: 15_000 });
  await secondDisclosure.getByRole("button", { name: "Start session" }).click();
  await expect(page).toHaveURL(/\/sessions\//, { timeout: 15_000 });
  const openaiRow = page.getByTestId("row-sandbox");
  await expect(openaiRow).toHaveCount(1, { timeout: 15_000 });
  await expectRuntimeReady(openaiRow);
  await expect(page.locator(MODEL_TRIGGER)).toContainText("GPT-6 Sol");
  await expect(page.getByTestId("agent-chip-effort")).toHaveText("low");
  await expect(
    page.getByTestId("row-message-assistant").filter({ hasText: "chunk-0 chunk-1 chunk-2" }),
  ).toBeVisible({ timeout: 60_000 });
  const openaiCalls = (await providerCallLog()).slice(callsBeforeOpenAI);
  expect(effortsSeen(openaiCalls, "/v1/responses")).toEqual(new Set(["low"]));
  expect(openaiCalls.some((call) => call.path === "/v1/messages")).toBe(false);
  await page.screenshot({ path: `${SHOTS}/10-openai-session.png`, fullPage: true });

  await page.goto(`${ORIGIN}/settings/modal`);
  await expect(page.getByText(DOUBLE_WORKSPACE_NAME)).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/11-settings-modal.png` });
});
