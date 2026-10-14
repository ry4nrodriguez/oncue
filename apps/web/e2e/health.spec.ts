import { expect, test } from "@playwright/test";

// The app sits behind Clerk sign-in, which this suite cannot drive, so it
// asserts that the gate renders and the app does not. It matches the app's own
// surfaces, not the word "OnCue": Clerk's heading reads "Sign in to OnCue".
test("a signed-out visitor sees the sign-in gate, not the app", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("sign-in-gate")).toBeVisible();
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
});
