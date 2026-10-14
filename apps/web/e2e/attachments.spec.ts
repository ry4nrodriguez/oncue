import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";
import {
  DOUBLE_MODAL_PAIR,
  existingIdsFor,
  SEED_ACCOUNT_LOGIN,
  SEED_GITHUB_LOGIN,
  SEED_GITHUB_USER_ID,
  SEED_INSTALLATION_ID,
  SEED_REPOSITORIES,
  SEED_USER_TOKEN,
  seedStatements,
} from "../scripts/seed-local";
import { appOrigin, DEFAULT_APP_ORIGIN } from "./app-origin";
import { createSeedRepository } from "./github-bare-repo";
import { startGitHubDouble } from "./github-double-server";
import { devVars } from "./lane-auth";
import { queryD1 } from "./local-d1";
import {
  PROVIDER_DOUBLE_ORIGIN,
  type RecordedDoubleCall,
  startProviderDouble,
} from "./provider-double-server";
import { type RunningControllerDouble, startControllerDouble } from "./sandbox-controller-double";
import { DEV_SUBJECT } from "./setup-local-auth.mjs";

/**
 * Composer attachments end to end against the real Worker and the three
 * doubles (docs/decisions.md). Attaches two images and a text file, sends,
 * and checks the message keeps them across a reload. The session runs the real
 * bridge and OpenCode, so the provider double's count of image blocks proves
 * the images reached the model.
 *
 * Runs in its own project because it sets the GitHub double's state and serves
 * the controller double's fixed port. `ONCUE_SHOTS=1` also writes screenshots.
 */

let ORIGIN = DEFAULT_APP_ORIGIN;
const closers: Array<() => Promise<void>> = [];

test.beforeAll(async () => {
  ORIGIN = await appOrigin();
  const github = await startGitHubDouble();
  closers.push(() => github.close());
  // The seed's GitHub world, as `e2e/dev-services.ts` serves it, with a real
  // bare repository behind each so a session's clone finds one.
  const seeded = SEED_REPOSITORIES.map((repository) => ({
    repository,
    seed: createSeedRepository(repository.fullName, "main"),
  }));
  await github.setState({
    users: [{ id: SEED_GITHUB_USER_ID, login: SEED_GITHUB_LOGIN }],
    installations: [
      {
        installationId: SEED_INSTALLATION_ID,
        account: { login: SEED_ACCOUNT_LOGIN, type: "Organization" },
        appSlug: "oncue-local",
        visibleToUserIds: [SEED_GITHUB_USER_ID],
      },
    ],
    repositoriesByInstallation: {
      [SEED_INSTALLATION_ID]: seeded.map(({ repository, seed }) => ({
        ...repository,
        cloneUrl: seed.cloneUrl,
      })),
    },
    refsByRepository: Object.fromEntries(
      seeded.map(({ repository, seed }) => [repository.fullName, { main: seed.sha }]),
    ),
    userTokens: { [SEED_USER_TOKEN]: SEED_GITHUB_USER_ID },
  });
  const provider = await startProviderDouble();
  closers.push(() => provider.close());
  const controller: RunningControllerDouble = await startControllerDouble({
    controlPlaneOrigin: ORIGIN,
  });
  closers.push(() => controller.close());

  const statements = await seedStatements({
    subject: DEV_SUBJECT,
    keyringSecret: devVars().get("ONCUE_BROKER_KEYRING") as string,
    modalPair: DOUBLE_MODAL_PAIR,
    modalWorkspaceName: "oncue-local-double",
    existing: await existingIdsFor(DEV_SUBJECT, queryD1),
  });
  // Through the dev server's own D1 (`local-d1.ts`), never a second process
  // opening the file it holds.
  await queryD1(statements);
});

test.afterAll(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
});

const SHOTS = process.env.ONCUE_SHOTS === "1";
const SHOTS_DIR = fileURLToPath(
  new URL("../test-results/screenshots/composer-attachments/", import.meta.url),
);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real PNG, a diagonal gradient between two colours, so a thumbnail is visibly an image. */
function gradientPng(
  size: number,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      const t = (x + y) / (2 * (size - 1));
      for (let channel = 0; channel < 3; channel += 1) {
        row[1 + x * 3 + channel] = Math.round(
          (from[channel] as number) * (1 - t) + (to[channel] as number) * t,
        );
      }
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Large enough that the viewer shows an image the size a screenshot would be. */
const IMAGE_SIZE = 360;

const FILES = [
  {
    name: "sunrise.png",
    mimeType: "image/png",
    buffer: gradientPng(IMAGE_SIZE, [255, 170, 60], [200, 40, 120]),
  },
  {
    name: "lagoon.png",
    mimeType: "image/png",
    buffer: gradientPng(IMAGE_SIZE, [40, 180, 200], [20, 60, 160]),
  },
  {
    name: "notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Notes\n\nThe header should match the second image.\n"),
  },
];

async function providerCalls(): Promise<RecordedDoubleCall[]> {
  const answer = await fetch(`${PROVIDER_DOUBLE_ORIGIN}/__calls`);
  return ((await answer.json()) as { calls: RecordedDoubleCall[] }).calls;
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) {
    return;
  }
  mkdirSync(SHOTS_DIR, { recursive: true });
  // The theme and the dialog both fade; a picture taken mid-fade shows neither state.
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS_DIR}${name}.png` });
}

async function expectMessageAttachments(page: Page): Promise<void> {
  const message = page.getByTestId("row-message-user").first();
  await expect(message.getByTestId("message-attachment-image")).toHaveCount(2);
  await expect(message.getByTestId("message-attachment-file")).toHaveCount(1);
  await expect(message.getByRole("link", { name: "Download notes.md" })).toBeVisible();
  // The thumbnails are the uploaded bytes served by the Worker, not a broken image.
  for (const name of ["sunrise.png", "lagoon.png"]) {
    await expect
      .poll(() =>
        message
          .getByRole("img", { name })
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(IMAGE_SIZE);
  }
}

test("attach two images and a text file, send, see them on the message, reload, and open the viewer from history", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const imagesBefore = (await providerCalls()).reduce(
    (total, call) => total + (call.images ?? 0),
    0,
  );

  // The dev sign-in mints the subject's session cookie and lands on the real
  // app, against the real Worker (`vite-plugins/dev-harness.ts`).
  await page.goto(`${ORIGIN}/dev/sign-in?as=${DEV_SUBJECT}`);
  const field = page.getByRole("textbox", { name: "Message" });
  await expect(field).toBeVisible();

  await page.getByTestId("composer-file-input").setInputFiles(FILES);
  const strip = page.getByTestId("composer-attachments");
  await expect(strip.getByTestId("composer-attachment")).toHaveCount(3);
  await expect(strip.locator("[data-status='ready']")).toHaveCount(3);
  await field.fill("What do these two images have in common? The notes say more.");
  await shot(page, "composer-strip-light");
  if (SHOTS) {
    await page.setViewportSize({ width: 375, height: 812 });
    await shot(page, "composer-strip-mobile");
    await page.setViewportSize({ width: 1280, height: 720 });
  }

  // The composer's own viewer shows the local copy before anything is sent.
  await strip.getByRole("button", { name: "View lagoon.png" }).click();
  await expect(page.getByTestId("attachment-viewer")).toContainText("Image 2 of 2");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("attachment-viewer")).toBeHidden();

  await page.getByLabel("Send message").click();
  await page.waitForURL(/\/sessions\/[^/]+$/, { timeout: 30_000 });
  await expectMessageAttachments(page);

  // Scrolled away and back after a reload: the attachments are part of the
  // committed message, replayed from the session's own events.
  await page.reload();
  await expectMessageAttachments(page);
  await shot(page, "message-attachments-light");

  const message = page.getByTestId("row-message-user").first();
  await message.getByRole("button", { name: "View lagoon.png" }).click();
  const viewer = page.getByTestId("attachment-viewer");
  await expect(viewer).toContainText("Image 2 of 2");
  await expect(viewer.getByRole("link", { name: "Download lagoon.png" })).toBeVisible();
  await shot(page, "viewer-light");
  await page.keyboard.press("ArrowRight");
  await expect(viewer).toContainText("Image 1 of 2");
  await expect(viewer.getByTestId("attachment-viewer-image")).toHaveAttribute("alt", "sunrise.png");
  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();

  if (SHOTS) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.locator("body").click({ position: { x: 5, y: 400 } });
    await shot(page, "message-attachments-dark");
    await message.getByRole("button", { name: "View sunrise.png" }).click();
    await expect(viewer).toContainText("Image 1 of 2");
    await shot(page, "viewer-dark");
    await page.keyboard.press("Escape");
    await expect(viewer).toBeHidden();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: "light" });
    // The rail floats over the timeline at this width; unpinned, the message shows.
    const unpin = page.getByLabel("Unpin session details");
    if (await unpin.isVisible()) {
      await unpin.click();
    }
    await shot(page, "message-attachments-mobile");
  }

  // The images reached the model as images: the provider double counted
  // them in a request the Model Broker forwarded from this session's sandbox.
  await expect
    .poll(
      async () =>
        (await providerCalls()).reduce((total, call) => total + (call.images ?? 0), 0) -
        imagesBefore,
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(2);
});
