import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * The accessibility audit `a11y.spec.ts` runs, shared so the walkthrough can
 * audit surfaces that need a real workspace (the secret disclosure card,
 * settings section, and approval card). Only axe's `serious` and `critical`
 * impacts fail; moderate and minor findings are printed.
 */

export const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

/**
 * Audits whatever the page shows now, in `theme`, once its colours have
 * settled. `within` narrows the audit to one region, for a lane about that
 * region on a page whose other findings are not its own.
 */
export async function scan(
  page: Page,
  label: string,
  theme: "light" | "dark" = "light",
  within?: string,
) {
  // `data-theme` is set from an effect and `transition-colors` eases between
  // palettes, so an audit mid-flip reports contrast no user sees. Wait for the
  // attribute, then for transitions only: the running dot animates forever.
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.constructor.name !== "CSSTransition" || animation.playState !== "running",
      ),
  );

  const audit = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
  const results = await (within === undefined ? audit : audit.include(within)).analyze();

  const blocking = results.violations.filter((violation) =>
    BLOCKING_IMPACTS.has(violation.impact ?? ""),
  );
  const advisory = results.violations.filter(
    (violation) => !BLOCKING_IMPACTS.has(violation.impact ?? ""),
  );

  for (const violation of advisory) {
    console.log(
      `a11y advisory (${violation.impact}) ${label}: ${violation.id} — ${violation.help}`,
    );
  }

  return blocking.map((violation) => {
    const where = violation.nodes
      .map((node) => `\n    ${node.target.join(" ")}\n      ${node.failureSummary ?? ""}`)
      .join("");
    return `${violation.id} (${violation.impact}, ${violation.nodes.length} nodes): ${violation.help}${where}`;
  });
}
