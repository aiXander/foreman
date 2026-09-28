// A stand-in for the Claude TUI's input box, reproducing only what ptyd's idle-submit relies on
// (layout and signals measured against Claude Code 2.1.283 in scripts/spike/): `─` rules framing a
// `❯` + U+00A0 prompt with a dim placeholder, bracketed paste on, OSC 9;4;0 when idle and 9;4;3
// while a turn runs. Every paste and every submitted draft is appended to <record> as JSON lines.
// `working` starts mid-turn (9;4;3); an ESC then ends the turn and puts the prompt back as a draft,
// like an ESC before Claude's first token. Every ESC is recorded as {esc: true}.
// Usage: bun fake-claude.ts <record> [normal|deaf|slow|dialog|working]
import { appendFileSync } from "node:fs";

const [record, initialMode = "normal"] = process.argv.slice(2);
let mode = initialMode;
const out = (s: string) => process.stdout.write(s);
const rule = "─".repeat(60);
let draft = "";

function draw(): void {
  const lines = draft ? draft.split("\n") : [""];
  out("\x1b[2J\x1b[H\x1b[10;1H" + rule);
  lines.forEach((l, i) => out(`\x1b[${11 + i};1H${i === 0 ? "❯ " : "  "}${l || (i === 0 && !draft ? "\x1b[2mTry something\x1b[22m" : "")}`));
  out(`\x1b[${11 + lines.length};1H${rule}`);
  out(`\x1b[${10 + lines.length};${3 + lines.at(-1)!.length}H`);
}

out("\x1b[?2004h");
if (mode === "dialog") out("\x1b[2J\x1b[H Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n\x1b]9;4;3;\x07");
else if (mode === "working") (draw(), out("\x1b]9;4;3;\x07"));
else (draw(), out("\x1b]9;4;0;\x07"));

process.stdin.setRawMode(true);
let buf = "";
let paste: string | null = null;
for await (const chunk of process.stdin) {
  if (mode === "deaf" || mode === "dialog") continue;
  buf += new TextDecoder().decode(chunk);
  while (buf) {
    if (paste !== null) {
      const end = buf.indexOf("\x1b[201~");
      if (end < 0) break;
      paste += buf.slice(0, end);
      buf = buf.slice(end + 6);
      draft += paste;
      appendFileSync(record!, JSON.stringify({ paste }) + "\n");
      paste = null;
      if (mode === "slow") await Bun.sleep(400);
      draw();
    } else if (buf.startsWith("\x1b[200~")) {
      paste = "";
      buf = buf.slice(6);
    } else {
      const c = buf[0]!;
      buf = buf.slice(1);
      if (c === "\r" && draft) {
        appendFileSync(record!, JSON.stringify({ submitted: draft }) + "\n");
        draft = "";
        out("\x1b]9;4;3;\x07");
        draw();
        setTimeout(() => out("\x1b]9;4;0;\x07"), 150);
      } else if (c === "\x1b") {
        appendFileSync(record!, JSON.stringify({ esc: true }) + "\n");
        if (mode === "working") {
          mode = "normal";
          draft = "the interrupted prompt";
          draw();
          out("\x1b]9;4;0;\x07");
        }
      } else if (c === "\x15") draft = "";
      else if (c === "\x7f") draft = draft.slice(0, -1);
      else if (c >= " ") draft += c;
      draw();
    }
  }
}
