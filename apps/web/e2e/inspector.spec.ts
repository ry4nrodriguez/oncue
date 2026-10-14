import { expect, test } from "@playwright/test";

// /dev/inspect requires a real Clerk sign-in, which this suite cannot drive,
// so it asserts that a signed-out visitor is gated.
test("a signed-out visitor sees the sign-in gate, not the inspector", async ({ page }) => {
  await page.goto("/dev/inspect");

  await expect(page.getByTestId("sign-in-gate")).toBeVisible();
  await expect(page.getByText("OnCue inspector")).not.toBeVisible();
});
