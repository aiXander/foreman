// Idle-prompt readiness for a hosted Claude TUI, read from ptyd's own emulator (phase-0 spike,
// verified on Claude Code 2.1.283 with the fullscreen TUI). Three signals must all hold:
//  1. Claude's own progress report: the last OSC 9;4 it emitted is state 0 (cleared). It emits
//     9;4;3 when a turn starts and keeps it through tool calls AND permission dialogs; the title
//     glyph (✳ vs spinner) is NOT usable — it shows ✳ while a permission dialog is open.
//  2. The input box: the cursor row is `❯` + no-break space at column 0, cursor at column 2, framed by `─` rules
//     directly above and below, and nothing typed (every cell after the prompt is blank or dim —
//     the dim text is Claude's placeholder suggestion).
//  3. Bracketed paste is enabled, so the batch can be framed as one paste.
// Anything else (dialog, draft, busy, unknown version/layout) is `blocked` with a reason.
import type { Terminal as XTerm } from "@xterm/headless";
import type { Progress } from "../shared/ptyproto";

/** OSC 9;4;<state>: 0 cleared, 1 value, 2 error, 3 indeterminate, 4 paused. */
export function progressFromOsc(data: string): Progress | null {
  const m = /^4;(\d)/.exec(data);
  if (!m) return null;
  return ({ "0": "idle", "1": "busy", "2": "error", "3": "busy", "4": "paused" } as const)[m[1] as "0"] ?? null;
}

export type Readiness = { ready: true } | { ready: false; reason: string };

// Claude draws the prompt as U+276F + U+00A0 (a no-break space, not 0x20).
const PROMPT = /^❯[\u00a0 ]/;
const PROMPT_COLS = 2;
const isRule = (s: string) => /^─{8,}/.test(s);
/** A multi-line draft wraps into continuation rows; look this far from the cursor for the frame. */
const MAX_BOX_ROWS = 40;

/** Input-box state of the current screen. Call only once the emulator has parsed all queued output. */
export function inputBox(xt: XTerm): "empty" | "draft" | "absent" {
  const b = xt.buffer.active;
  const line = (y: number) => b.getLine(y)?.translateToString(true) ?? "";
  const y = b.viewportY + b.cursorY;
  // The box: a `❯` row with a rule directly above, the cursor on or below it, a rule below the cursor.
  let top = y;
  while (top > y - MAX_BOX_ROWS && top > 0 && !PROMPT.test(line(top))) top--;
  if (!PROMPT.test(line(top)) || !isRule(line(top - 1))) return "absent";
  let bottom = y + 1;
  while (bottom < y + MAX_BOX_ROWS && !isRule(line(bottom))) bottom++;
  if (!isRule(line(bottom))) return "absent";
  if (top !== y || bottom !== y + 1 || b.cursorX !== PROMPT_COLS) return "draft";
  const row = b.getLine(y);
  const cell = b.getNullCell();
  for (let x = PROMPT_COLS; x < xt.cols; x++) {
    row!.getCell(x, cell);
    const ch = cell.getChars();
    if (ch && ch !== " " && ch !== "\u00a0" && !cell.isDim()) return "draft";
  }
  return "empty";
}

export function readiness(xt: XTerm, progress: Progress): Readiness {
  if (progress !== "idle") return { ready: false, reason: progress === "none" ? "no progress report yet" : `claude reports ${progress}` };
  if (!xt.modes.bracketedPasteMode) return { ready: false, reason: "bracketed paste is off" };
  const box = inputBox(xt);
  if (box === "absent") return { ready: false, reason: "no input prompt on screen (dialog or unknown layout)" };
  if (box === "draft") return { ready: false, reason: "input box holds a draft" };
  return { ready: true };
}
