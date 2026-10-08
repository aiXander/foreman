import { describe, expect, test } from "bun:test";
import { lineHunks } from "../src/daemon/line-diff";
import { renderEdits } from "../src/daemon/page-edits";

describe("line diff", () => {
  test("equal texts: no hunks; a one-line change: one hunk with 1 line of context", () => {
    expect(lineHunks("a\nb\n", "a\nb\n")).toEqual([]);
    const h = lineHunks("1\n2\n3\n4\n5\n6\n7\n", "1\n2\n3\nX\n5\n6\n7\n")!;
    expect(h.length).toBe(1);
    expect(h[0]!.header).toBe("@@ -3,3 +3,3 @@");
    expect(h[0]!.lines).toEqual([" 3", "-4", "+X", " 5"]);
  });

  test("insertions, deletions and separate hunks; nearby changes merge", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const b = [...a];
    b.splice(2, 1); // delete l2
    b.splice(15, 0, "new"); // insert before l16 (indices shifted by one)
    const h = lineHunks(a.join("\n"), b.join("\n"))!;
    expect(h.map((x) => x.header)).toEqual(["@@ -2,3 +2,2 @@", "@@ -16,2 +15,3 @@"]);
    expect(h[1]!.lines).toEqual([" l15", "+new", " l16"]);
    expect(lineHunks("a\nb\nc", "a\nB\nC")!.length).toBe(1);
  });

  test("the hunk header names where it sits from indentation (a JSON record by its first key)", () => {
    const before = '{\n  "contacts": [\n    {\n      "id": "voka",\n      "log": [\n        {\n          "date": "2026-10-07",\n          "text": "a"\n        }\n      ]\n    }\n  ]\n}';
    const h = lineHunks(before, before.replace('"text": "a"', '"text": "b"'))!;
    expect(h[0]!.header).toBe('@@ -7,3 +7,3 @@ "id": "voka" › "log" › "date": "2026-10-07"');
  });

  test("a rewrite beyond the edit limit is null, not a huge diff", () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`).join("\n");
    expect(lineHunks(a, b, 20)).toBeNull();
    expect(lineHunks(a, b)!.length).toBe(1);
  });
});

describe("renderEdits", () => {
  test("nothing in effect → null; a rewrite says so; created files show name and size", () => {
    expect(renderEdits([["a.json", [{ before: "x", after: "x", etag: "", bytes: 1 }]]])).toBeNull();
    const big = (p: string) => Array.from({ length: 1500 }, (_, i) => `${p}${i}`).join("\n");
    expect(renderEdits([["a.txt", [{ before: big("a"), after: big("b"), etag: "", bytes: 1 }]]])).toContain("a.txt: rewritten (1500 → 1500 lines), too different to diff; read the file");
    expect(renderEdits([["inbox/t.md", [{ before: null, after: null, etag: "", bytes: 2048 }]]])).toContain("inbox/t.md: new file (2.0 KB), not shown");
  });
});

test("long lines are cut: context at 80 characters, changed lines at 400", () => {
  const long = "x".repeat(500);
  const h = lineHunks(`${long}\nold\n`, `${long}\nnew\n`)!;
  expect(h[0]!.lines[0]).toBe(` ${"x".repeat(79)}…`);
  const c = lineHunks(`${long}\n`, `${long}y\n`)!;
  expect(c[0]!.lines.every((l) => l.length === 401)).toBe(true);
});
