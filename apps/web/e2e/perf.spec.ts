import { expect, test } from "@playwright/test";
import { appOrigin } from "./app-origin";
import { laneIdentity } from "./lane-auth";
import { queryD1 } from "./local-d1";
import {
  PROVIDER_DOUBLE_ORIGIN,
  type RunningDouble,
  startProviderDouble,
} from "./provider-double-server";

/**
 * Session first paint must stay under 400 ms. A seven-event render is reported
 * for scale only. `perf-500` is the session harness fixture replaying 500
 * committed events and then streaming 200 transient deltas.
 */

const FIRST_PAINT_CEILING_MS = 400;

const MAX_DROPPED_FRAME_RATIO = 0.05;
const TARGET_FPS = 60;

/**
 * From navigation start to the first painted timeline row, after a warm-up
 * visit: the dev server transforms modules on first request, and that cost is
 * Vite's, not the timeline's.
 */
async function firstPaintMs(page: import("@playwright/test").Page, url: string): Promise<number> {
  await page.goto(url);
  await page.locator("[data-testid^='row-']").first().waitFor({ state: "visible" });

  const samples: number[] = [];
  for (let run = 0; run < 3; run += 1) {
    await page.goto("about:blank");
    const started = Date.now();
    await page.goto(url);
    await page.locator("[data-testid^='row-']").first().waitFor({ state: "visible" });
    samples.push(Date.now() - started);
  }
  return samples.sort((a, b) => a - b)[1] ?? 0;
}

test("first timeline paint with 500 committed events stays inside the budget", async ({ page }) => {
  const reference = await firstPaintMs(page, "/dev/session?fixture=working");
  const head = await firstPaintMs(page, "/dev/session?fixture=perf-500");
  const ratio = reference === 0 ? 0 : head / reference;

  console.log(
    `perf: seven-event reference ${reference}ms, 500-event median paint ${head}ms, ratio ${ratio.toFixed(2)}x`,
  );

  // Only the absolute ceiling is asserted; the ratio above is context.
  expect(
    head,
    `first paint ${head}ms exceeded the ${FIRST_PAINT_CEILING_MS}ms ceiling`,
  ).toBeLessThanOrEqual(FIRST_PAINT_CEILING_MS);
});

test("streaming 200 deltas drops under five percent of frames", async ({ page }) => {
  await page.goto("/dev/session?fixture=perf-500");

  const frames = await page.evaluate(async () => {
    const timestamps: number[] = [];
    let running = true;
    const record = (time: number) => {
      timestamps.push(time);
      if (running) {
        requestAnimationFrame(record);
      }
    };
    requestAnimationFrame(record);
    while (document.body.dataset.perfStreaming !== "done") {
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    running = false;
    return timestamps;
  });

  expect(frames.length, "the delta stream never ran").toBeGreaterThan(10);

  const elapsed = (frames.at(-1) ?? 0) - (frames[0] ?? 0);
  const expected = Math.round((elapsed / 1000) * TARGET_FPS);
  const dropped = Math.max(0, expected - frames.length);
  const ratio = expected === 0 ? 0 : dropped / expected;

  console.log(
    `perf: ${frames.length} frames in ${Math.round(elapsed)}ms, ${dropped} dropped of ${expected} expected (${(ratio * 100).toFixed(1)}%)`,
  );

  expect(
    ratio,
    `${(ratio * 100).toFixed(1)} percent of frames dropped while streaming`,
  ).toBeLessThanOrEqual(MAX_DROPPED_FRAME_RATIO);
});

/**
 * The review panel opens on a 3,000-line diff, the most it draws line by line,
 * within 500 ms to interactive. Timed inside the page so Playwright's round
 * trips are excluded: one warm-up open, then the median of five.
 */
const REVIEW_OPEN_CEILING_MS = 500;
const REVIEW_DIFF_LINES = 3_000;

test("the review panel opens on a 3,000-line diff inside the budget", async ({ page }) => {
  await page.goto("/dev/session?fixture=review-3000");
  const button = page.getByTestId("rail-changes");
  await button.waitFor({ state: "visible" });

  const openOnce = () =>
    page.evaluate(async (lines) => {
      const trigger = document.querySelector<HTMLButtonElement>("[data-testid='rail-changes']");
      if (trigger === null) {
        throw new Error("no Changes row");
      }
      const started = performance.now();
      trigger.click();
      await new Promise<void>((resolve) => {
        const ready = () =>
          document.querySelectorAll("[data-testid='review-panel'] [data-testid='diff-line']")
            .length >= lines &&
          document.querySelector("[data-testid='review-panel'] input") !== null;
        const poll = () => {
          if (ready()) {
            // The next frame is the one that paints what the check found.
            requestAnimationFrame(() => setTimeout(resolve, 0));
          } else {
            requestAnimationFrame(poll);
          }
        };
        poll();
      });
      return performance.now() - started;
    }, REVIEW_DIFF_LINES);

  const closeOnce = async () => {
    await page.getByRole("button", { name: "Close panel" }).click();
    await page.getByTestId("review-panel").waitFor({ state: "detached" });
  };

  await openOnce();
  await closeOnce();
  const samples: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    samples.push(await openOnce());
    await closeOnce();
  }
  const open = median(samples);
  console.log(
    `perf: review panel open on a ${REVIEW_DIFF_LINES}-line diff, median ${open.toFixed(1)}ms of ${samples.map((sample) => sample.toFixed(0)).join(", ")}ms`,
  );

  expect(
    open,
    `review panel open ${open.toFixed(1)}ms exceeded the ${REVIEW_OPEN_CEILING_MS}ms ceiling`,
  ).toBeLessThanOrEqual(REVIEW_OPEN_CEILING_MS);
});

/**
 * Broker overhead per request: time to first byte through the broker minus
 * straight to the provider double, over 100 pairs, failing when the median
 * exceeds 40 ms. The pairs are interleaved so load drift affects both paths
 * equally.
 */

const BROKER_OVERHEAD_CEILING_MS = 40;
const PAIRS = 100;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Time until the first byte of the body, not the headers. The status is
 * checked because a refused request answers in microseconds and would look
 * faster than the provider.
 */
async function timeToFirstByteMs(url: string, init: RequestInit): Promise<number> {
  const started = performance.now();
  const response = await fetch(url, init);
  if (response.status !== 200) {
    throw new Error(
      `perf: ${url} answered ${response.status} (${await response.text()}), so this reading times a refusal rather than a forward`,
    );
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    await response.arrayBuffer();
    return performance.now() - started;
  }
  await reader.read();
  const elapsed = performance.now() - started;
  await reader.cancel();
  return elapsed;
}

test("broker overhead per request stays inside the budget", async () => {
  const origin = await appOrigin();
  const cookie = laneIdentity(origin).cookie;
  let double: RunningDouble | undefined;
  let createdConnectionId: string | undefined;

  try {
    double = await startProviderDouble();

    // One key per provider: the seeded workspace already holds an Anthropic
    // key on a `pnpm dev` stack, and a second is refused. Use the one there
    // is and leave it; create one only on an empty database, and revoke that.
    const listed = (await (
      await fetch(`${origin}/api/model-connections`, { headers: { cookie } })
    ).json()) as { connections: { connectionId: string; provider: string; status: string }[] };
    const existing = listed.connections.find(
      (row) => row.provider === "anthropic" && row.status === "active",
    );
    let connectionId = existing?.connectionId;
    if (connectionId === undefined) {
      const created = await fetch(`${origin}/api/model-connections`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", credential: "sk-ant-perf00000001" }),
      });
      expect(created.status, "the perf lane could not create a connection").toBe(201);
      connectionId = ((await created.json()) as { connection: { connectionId: string } }).connection
        .connectionId;
      createdConnectionId = connectionId;
    }

    const me = (await (await fetch(`${origin}/api/me`, { headers: { cookie } })).json()) as {
      workspaceId: string;
    };
    const sessionId = `sess_perf_${Date.now()}`;
    await queryD1(
      `INSERT INTO session_index (session_id, workspace_id, task_id, state, sandbox_generation, created_at, updated_at) VALUES ('${sessionId}', '${me.workspaceId}', NULL, 'active', 1, '2026-09-05T00:00:00.000Z', '2026-09-05T00:00:00.000Z')`,
    );

    const issued = await fetch(`${origin}/api/sessions/${sessionId}/broker-token`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ modelConnectionId: connectionId }),
    });
    expect(issued.status, "the perf lane could not mint a token").toBe(200);
    const token = ((await issued.json()) as { token: string }).token;
    // The model the token was minted for: the connection's recommended row,
    // which has an effort level, so each forward pays for the broker's
    // parse and rewrite of the body as a real run's requests do. A body
    // naming another model is refused, not timed.
    const claims = JSON.parse(
      Buffer.from(token.split(".")[2] as string, "base64url").toString(),
    ) as { mid: string };

    const body = JSON.stringify({
      model: claims.mid,
      messages: [{ role: "user", content: "hello" }],
    });

    const overheads: number[] = [];
    const brokerTimes: number[] = [];
    const directTimes: number[] = [];

    for (let pair = 0; pair < PAIRS; pair += 1) {
      const throughBroker = await timeToFirstByteMs(
        `${origin}/api/broker/sessions/${sessionId}/v1/messages`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body,
        },
      );
      const direct = await timeToFirstByteMs(`${PROVIDER_DOUBLE_ORIGIN}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      brokerTimes.push(throughBroker);
      directTimes.push(direct);
      overheads.push(throughBroker - direct);
    }

    const overhead = median(overheads);
    console.log(
      `perf: broker TTFB median ${median(brokerTimes).toFixed(1)}ms, direct-to-double median ${median(directTimes).toFixed(1)}ms, overhead median ${overhead.toFixed(1)}ms over ${PAIRS} interleaved pairs. Trunk has no broker, so there is no baseline; the direct reading is it.`,
    );

    expect(
      overhead,
      `median broker overhead ${overhead.toFixed(1)}ms exceeded the ${BROKER_OVERHEAD_CEILING_MS}ms ceiling`,
    ).toBeLessThanOrEqual(BROKER_OVERHEAD_CEILING_MS);
  } finally {
    // In `finally`, so a failed reading still revokes the connection; other
    // tests need the subject to hold none.
    try {
      if (createdConnectionId !== undefined) {
        await fetch(`${origin}/api/model-connections/${createdConnectionId}/revoke`, {
          method: "POST",
          headers: { cookie },
        });
      }
    } finally {
      // A revoke that throws (the dev server gone) must not leak the double's port.
      await double?.close();
    }
  }
});
