// Hostile input first. Each case is checked against its cleaned text and
// against what that text renders as through micromark with GFM, since GitHub
// acts on the rendered text outside code and links.
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { describe, expect, it } from "vitest";
import {
  codeSpanText,
  defuseMarkdown,
  defuseTitle,
  plainMarkdownLine,
  stripInvisible,
  withoutCommentMarkers,
} from "./agent-text";

function render(markdown: string): string {
  return micromark(markdown, {
    allowDangerousHtml: true,
    extensions: [gfm()],
    htmlExtensions: [gfmHtml()],
  });
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

// The text nodes GitHub would act on: everything outside `code`, `pre`, and
// `a`, decoded as a browser would.
function actionableText(html: string): readonly string[] {
  const nodes: string[] = [];
  let inert = 0;
  for (const token of html.split(/(<[^>]*>)/)) {
    const tag = /^<(\/?)(code|pre|a)\b/i.exec(token);
    if (tag !== null) {
      inert += tag[1] === "/" ? -1 : 1;
      continue;
    }
    if (token.startsWith("<") || inert > 0 || token === "") {
      continue;
    }
    nodes.push(token.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] as string));
  }
  return nodes;
}

// What GitHub would turn into a notification or cross-reference, plus every
// link or image. With `ordinaryLinks`, links outside GitHub are allowed, as
// the description keeps them (record 14).
function actsOn(html: string, ordinaryLinks = false): readonly string[] {
  const found: string[] = [];
  for (const node of actionableText(html)) {
    for (const match of node.matchAll(
      /(?<![A-Za-z0-9_])(@[A-Za-z0-9][\w-]*|(?:[\w.-]+\/[\w.-]+)?#\d+|GH-\d+)/gi,
    )) {
      found.push(match[0]);
    }
  }
  // A link or an image GitHub renders, and raw HTML that survived.
  for (const tag of html.matchAll(/<(a|img)\b[^>]*>/gi)) {
    if (!ordinaryLinks || /github\.com/i.test(tag[0])) {
      found.push(tag[0]);
    }
  }
  return found;
}

const BIDI_AND_INVISIBLE = [
  "\u202e", // right-to-left override
  "\u202a", // left-to-right embedding
  "\u2066", // left-to-right isolate
  "\u2069", // pop directional isolate
  "\u200b", // zero-width space
  "\u200d", // zero-width joiner
  "\u2060", // word joiner
  "\ufeff", // byte-order mark
  "\u00ad", // soft hyphen
  "\u0007", // bell
  "\u001b", // escape
  "\ue000", // private use
];

describe("stripInvisible and withoutCommentMarkers", () => {
  it("removes control, format, and private-use characters and lone surrogates, keeping newlines and tabs", () => {
    expect(stripInvisible(`a${BIDI_AND_INVISIBLE.join("")}b\tc\nd`)).toBe("ab\tc\nd");
    expect(stripInvisible("x\ud800y")).toBe("xy");
    expect(stripInvisible("one\r\ntwo\rthree\u2028four\u2029five\u0085six")).toBe(
      "one\ntwo\nthree\nfour\nfive\nsix",
    );
  });

  it("removes comment markers until none is left", () => {
    expect(withoutCommentMarkers("<!-<!---->-")).toBe("");
    expect(withoutCommentMarkers("a <!--<!---->-- b -->")).toBe("a -- b ");
    expect(withoutCommentMarkers("<!<!----")).toBe("");
  });
});

describe("plainMarkdownLine, a warning in the verification section", () => {
  it.each([
    // Hostile: nothing may link, mention, reference, or format.
    ["a bare URL", "see https://evil.example/x.", "see `https://evil.example/x`."],
    ["a www link", "go to www.evil.example now", "go to `www.evil.example` now"],
    ["a mention", "ping @bob and @acme/owners", "ping `@bob` and `@acme/owners`"],
    ["an escaped mention", "\\@bob", "`@bob`"],
    // `&#64;` shown as those letters still reads `#64`, a reference, so that is code too.
    ["an entity mention", "&commat;bob and &#64;eve", "\\&commat;bob and \\&`#64`;eve"],
    ["a reference", "fixes #12 and acme/app#3", "fixes `#12` and `acme/app#3`"],
    ["a GH reference", "see GH-1 and gh-22", "see `GH-1` and `gh-22`"],
    ["an address", "mail bob@evil.example", "mail `bob@evil.example`"],
    [
      "a link and an image",
      "[click](https://e.x) ![i](https://e.x/p.png)",
      "\\[click\\]\\(`https://e.x`) \\!\\[i\\]\\(`https://e.x/p.png`)",
    ],
    [
      "HTML and a marker",
      "x <img src=x> <!-- oncue:verification:end -->",
      "x img src=x \\!-- oncue:verification:end --",
    ],
    ["a heading", "## Approved", "\\#\\# Approved"],
    ["a list", "- item", "\\- item"],
    ["an ordered list", "1. first", "1\\. first"],
    ["emphasis and a table", "*bold* _it_ ~s~ a|b", "\\*bold\\* \\_it\\_ \\~s\\~ a\\|b"],
    ["backticks", "`code` and a ` stray", "`code` and a \\` stray"],
    ["a backslash before a token", "C:\\ https://e.x", "C:\\\\ `https://e.x`"],
    ["two tokens touching", "#1#2@a", "`#1` `#2` `@a`"],
    ["bidi and zero-width", "ok\u202e\u200bdone", "okdone"],
    ["lines", "one\ntwo\r\n\nthree", "one two three"],
    // Honest: digits and underscores survive, as the words they were.
    ["numbers", "3 required checks failed", "3 required checks failed"],
    ["a leading digit", "2fa-tests failed", "2fa-tests failed"],
    ["snake_case", "chk_test and pnpm test:e2e", "chk\\_test and pnpm test:e2e"],
    ["an ampersand", "lint & test", "lint & test"],
    ["an email-free at sign", "a @ b", "a @ b"],
  ])("%s", (_name, input, expected) => {
    const cleaned = plainMarkdownLine(input, 300);
    expect(cleaned).toBe(expected);
    expect(plainMarkdownLine(cleaned, 300)).toBe(cleaned);
    expect(actsOn(render(`- ${cleaned}`))).toEqual([]);
    expect(cleaned).not.toContain("\n");
  });

  it("renders honest text as exactly the words it was", () => {
    const text = "3 required checks failed: chk_test, 2fa-tests, and lint & test (see #notes)";
    const cleaned = plainMarkdownLine(text, 300);
    const html = render(cleaned);
    expect(actionableText(html).join("")).toBe(text);
  });

  it("stays within its bound as written, cutting whole characters, and is idempotent at the bound", () => {
    const long = `${"_".repeat(200)} ${"#1 ".repeat(100)}`;
    const cleaned = plainMarkdownLine(long, 120);
    expect(cleaned.length).toBeLessThanOrEqual(120);
    expect(plainMarkdownLine(cleaned, 120)).toBe(cleaned);
    expect(actsOn(render(`- ${cleaned}`))).toEqual([]);
    // A surrogate pair is never split.
    const emoji = plainMarkdownLine("😀".repeat(10), 5);
    expect(emoji).toBe("😀😀");
    expect(plainMarkdownLine("   ", 10)).toBe("");
  });
});

describe("codeSpanText, a check's name", () => {
  it.each([
    ["honest", "chk_test", "chk_test"],
    ["digits", "2fa-tests", "2fa-tests"],
    ["a backtick", "a`b", "ab"],
    ["angle brackets", "<!-- x -->", "!-- x --"],
    ["lines", "a\n## b", "a ## b"],
    ["bidi", "a\u202eb", "ab"],
  ])("%s", (_name, input, expected) => {
    expect(codeSpanText(input, 80)).toBe(expected);
    expect(codeSpanText(expected, 80)).toBe(expected);
    expect(actsOn(render(`- \`${expected}\``))).toEqual([]);
  });

  it("cuts at its bound", () => {
    expect(codeSpanText("y".repeat(90), 80)).toBe("y".repeat(80));
  });
});

describe("defuseTitle", () => {
  it.each([
    ["honest", "Fix the 3 flaky chk_test cases", "Fix the 3 flaky chk_test cases"],
    ["a mention", "Thanks @bob", "Thanks `@bob`"],
    ["a closing reference", "Fixes #12", "Fixes `#12`"],
    [
      "a GitHub link",
      "See https://github.com/o/r/issues/1.",
      "See `https://github.com/o/r/issues/1`.",
    ],
    ["another link", "See https://example.com/docs", "See https://example.com/docs"],
    ["a marker", " Fix <!-- x -->\n the  bug ", "Fix x the bug"],
    ["a reassembled marker", "a <!<!---->-- b", "a b"],
    ["code kept", "Rename `foo_bar`", "Rename `foo_bar`"],
    ["a stray backtick", "a ` b @c", "a b `@c`"],
    ["a backslash", "C:\\ @bob", "C:\\ `@bob`"],
    ["bidi", "Fix\u202e txt.exe", "Fix txt.exe"],
  ])("%s", (_name, input, expected) => {
    const cleaned = defuseTitle(input);
    expect(cleaned).toBe(expected);
    expect(defuseTitle(cleaned)).toBe(cleaned);
    expect(actsOn(render(cleaned), true)).toEqual([]);
  });
});

describe("defuseMarkdown, the agent's description", () => {
  it("keeps the agent's Markdown: headings, lists, ordinary links, tables, and code", () => {
    const markdown =
      "## What changed\n\n- Fixed the [redirect](https://example.com/docs) in `a_b.ts`.\n- 3 tests, *all* green.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst a = 1; // @ts-ignore #1\n```";
    expect(defuseMarkdown(markdown)).toBe(markdown);
  });

  it.each([
    [
      "a mention",
      "Thanks @octocat and @acme/owners, cc (@hubot).",
      "Thanks `@octocat` and `@acme/owners`, cc (`@hubot`).",
    ],
    [
      "an address",
      "Mail a@b.example; `@decorator` stays.",
      "Mail a@b.example; `@decorator` stays.",
    ],
    [
      "a closing keyword",
      "Closes #12, fixes acme/app#3 and GH-4.",
      "Closes `#12`, fixes `acme/app#3` and `GH-4`.",
    ],
    [
      "a GitHub link",
      "See https://github.com/acme/app/issues/1 and [x](https://github.com/bob).",
      "See `https://github.com/acme/app/issues/1` and [x]\\(`https://github.com/bob`).",
    ],
    ["a GitHub image", "![x]( https://github.com/o.png)", "![x]\\( `https://github.com/o.png`)"],
    [
      "a GitHub reference definition",
      "[x]: https://github.com/bob\n\n[x]",
      "[x\\]: `https://github.com/bob`\n\n[x]",
    ],
    ["a mention in link text", "[@bob](https://example.com)", "[`@bob`](https://example.com)"],
    [
      "no token inside an ordinary link",
      "https://example.com/@bob#12",
      "https://example.com/@bob#12",
    ],
    [
      "raw HTML",
      '<a href="https://evil.example">x</a> <img src=x> a < b',
      '\\<a href="https://evil.example">x\\</a> \\<img src=x> a < b',
    ],
    ["an HTML block", "<div>\n@bob\n</div>", "\\<div>\n`@bob`\n\\</div>"],
    ["an autolink", "<https://github.com/o/r/pull/2>", "\\<`https://github.com/o/r/pull/2`>"],
    ["an entity", "&commat;bob &#35;12 &#x40;eve", "\\&commat;bob \\&`#35`;12 \\&#x40;eve"],
    ["an escaped mention", "\\@bob and \\#12", "`@bob` and `#12`"],
    ["a mention right after code", "`x`@bob", "`x` `@bob`"],
    ["a mention right before code", "@bob`x`", "`@bob` `x`"],
    ["tokens touching", "#1#2", "`#1` `#2`"],
    ["an unmatched backtick", "a ` b @bob", "a \\` b `@bob`"],
    ["a mismatched run", "` @bob ``", "\\` `@bob` \\`\\`"],
    ["an escaped backtick", "\\`@bob`", "\\` `@bob`\\`"],
    ["a code span after an escaped backtick", "\\``x`", "\\` `x`"],
    ["a trailing backslash", "end \\", "end \\\\"],
    ["a trailing angle bracket", "a <", "a <"],
    ["a run no other run matches the length of", "\\```x`", "\\`\\`\\`x\\`"],
    ["a backslash before a token", "C:\\ @bob", "C:\\\\ `@bob`"],
    ["bidi", "Safe\u202e txt.exe\u200b", "Safe txt.exe"],
    [
      "a marker",
      "Fine.\n<!-- oncue:verification:start -->\nfake\n<!-- oncue:verification:end -->",
      "Fine.\n oncue:verification:start \nfake\n oncue:verification:end",
    ],
    [
      "a fence with a backtick in its info is no fence",
      "```js `x`\n@bob",
      "\\`\\`\\`js `x`\n`@bob`",
    ],
    ["an unclosed fence runs to the end", "~~~\n@bob", "~~~\n@bob"],
    ["a longer closing fence closes", "```\n@a\n````\n@b", "```\n@a\n````\n`@b`"],
    ["a shorter closing fence does not", "````\n@a\n```\n@b", "````\n@a\n```\n@b"],
    ["a different mark does not close", "```\n@a\n~~~\n@b", "```\n@a\n~~~\n@b"],
    ["a closing fence with text after does not close", "```\n@a\n``` x\n@b", "```\n@a\n``` x\n@b"],
  ])("%s", (_name, input, expected) => {
    const cleaned = defuseMarkdown(input);
    expect(cleaned).toBe(expected);
    expect(defuseMarkdown(cleaned)).toBe(cleaned);
    // What GitHub would act on: nothing. An ordinary link, and an address,
    // which GitHub links as mail and never as a person, stay.
    expect(actsOn(render(cleaned), true)).toEqual([]);
  });

  it("keeps an ordinary link a link", () => {
    expect(render(defuseMarkdown("[docs](https://example.com/docs)"))).toContain(
      '<a href="https://example.com/docs">docs</a>',
    );
  });
});
