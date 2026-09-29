// The card's Markdown subset (plan §16): what renders, and that agent text can never become markup
// or a non-http(s) link.
import { expect, test } from "bun:test";
import { parseInline, parseMarkdown, safeHref } from "../src/ui/markdown";

test("blocks: paragraphs, headings, lists, fenced code", () => {
  const md = "## Summary\nFirst line\nsecond line\n\n- one\n- **two**\n  continued\n\n3. c\n4. d\n\n```\n<b>x</b>\n```";
  expect(parseMarkdown(md)).toEqual([
    { t: "h", c: [{ t: "text", v: "Summary" }] },
    { t: "p", c: [{ t: "text", v: "First line\nsecond line" }] },
    { t: "ul", items: [[{ t: "text", v: "one" }], [{ t: "strong", c: [{ t: "text", v: "two" }] }, { t: "text", v: " continued" }]] },
    { t: "ol", start: 3, items: [[{ t: "text", v: "c" }], [{ t: "text", v: "d" }]] },
    { t: "pre", v: "<b>x</b>" },
  ]);
});

test("inline: code, bold, italic; snake_case and lone markers stay literal", () => {
  expect(parseInline("run `bun test` **now**, *really*")).toEqual([
    { t: "text", v: "run " },
    { t: "code", v: "bun test" },
    { t: "text", v: " " },
    { t: "strong", c: [{ t: "text", v: "now" }] },
    { t: "text", v: ", " },
    { t: "em", c: [{ t: "text", v: "really" }] },
  ]);
  expect(parseInline("open_items_carried and 2 * 3 * 4")).toEqual([{ t: "text", v: "open_items_carried and 2 * 3 * 4" }]);
});

test("raw HTML is text; only absolute http(s) targets become links", () => {
  expect(parseInline('<img src=x onerror="alert(1)">')).toEqual([{ t: "text", v: '<img src=x onerror="alert(1)">' }]);
  expect(parseInline("[docs](https://example.com/a b)")).toEqual([{ t: "link", href: "https://example.com/a%20b", c: [{ t: "text", v: "docs" }] }]);
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "/relative", "vbscript:x"]) {
    expect(parseInline(`[click](${bad})`)).toEqual([{ t: "text", v: `click (${bad})` }]);
    expect(safeHref(bad)).toBeNull();
  }
});
