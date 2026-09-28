# Terminal host (ptyd) and terminal CLI

ptyd owns every managed Claude process and its terminal state, independent of the web daemon
(closing the browser or restarting `foremand` never touches agents; a ptyd crash kills them).
Open this when touching PTYs, snapshots/replay, the socket protocol, or `foreman run/attach/ls/kill`.

## Where it lives

| File | Role |
|---|---|
| `src/shared/ptyproto.ts` | Protocol v1 types + NDJSON framing (`FrameReader`), limits, base64 helpers. |
| `src/ptyd/server.ts` | Unix socket server (`run/ptyd.sock`), connections, op dispatch, `terminal` broadcasts. |
| `src/ptyd/terminal.ts` | One PTY: `Bun.spawn({terminal})` + `@xterm/headless` + serialize, seq stream, delta ring, viewers, writer lease, idle `submit`. |
| `src/ptyd/readiness.ts` | Reads Claude's idle-prompt state from the emulator: OSC 9;4 progress + input-box layout. **Version-coupled** — recheck after a Claude Code upgrade. |
| `src/shared/ptyclient.ts` | `PtyClient` used by the CLI, daemon and tests; `Outbox` (bounded send queue) shared with the server. |
| `src/cli/services.ts` | `ensurePtyd`, `startDetached` (detached service start, logs in `~/.foreman/logs/`). |
| `src/cli/commands/{run,attach,ls,kill,ptyd}.ts` | CLI. Detach prefix is `Ctrl-]` then `d` (`t` takeover, `Ctrl-]` literal). |

## How it works

- Output, resize and exit share one ordered `seq` per terminal; each ptyd process has a new
  `stream_epoch`. A 4 MiB delta ring serves reconnects (`attach` with `after_seq` + same epoch →
  `mode: "replay"`); otherwise a snapshot: `snapshot_begin{seq N}` → chunks → `snapshot_end`,
  then ring entries > N, then live.
- **Snapshot boundary trick:** `xt.write("", cb)` — inside the callback the emulator has parsed
  exactly the chunks queued before it, so `serialize()` there is "state after seq N".
- Incomplete trailing UTF-8 is held back so every frame/snapshot ends on a character boundary
  (a snapshot can't carry the decoder's partial byte — this lost characters before the fix).
- One writer/resize lease per terminal (`control acquire|release|takeover`; `control` never errors,
  check `writer === your viewer_id`). Attaching never resizes. Only the leaseholder writes/resizes.
- Query responder: the headless emulator answers terminal queries only while nobody holds the
  lease (small documented race on lease change).
- Slow viewers: live output beyond 1 MiB queued on a connection → `resync_required`, viewers on
  that connection detached; the child is never blocked. Snapshot/replay frames are exempt.
- Env: caller env is used in memory only; `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`,
  `CLAUDE_EFFORT`, `CMUX_*`, `C11_*` are scrubbed (a leaked `CLAUDE_CODE_CHILD_SESSION` turns off
  Claude's transcript saving); ptyd's own `FOREMAN_HOME` wins so hooks write where its daemon reads.
- `bind` (daemon connections only) is compare-and-swap on the terminal's `target`.

## Idle delivery and Stop (`input_state` / `submit` / `interrupt`, daemon-only)

Built and proven in phase 0; the daemon's idle worker (`src/daemon/idle-worker.ts`, see
[daemon-and-ui.md](daemon-and-ui.md)) calls them.

- **Readiness is ptyd's own reading** of its emulator (not a daemon assertion, as the plan first
  specified): ptyd holds the screen, so it re-checks at write time with no read-then-write gap.
  Ready ⇔ Claude's last OSC `9;4` was state 0 **and** bracketed paste is on **and** the cursor sits
  at column 2 of an empty `❯` row framed by `─` rules (dim cells = placeholder, not a draft).
  Anything else is `ready:false` with a reason (busy / dialog or unknown layout / draft).
  The OSC `9;4` state rides `TerminalInfo.progress` in `terminal` broadcasts, so the daemon sees
  busy→idle without polling.
- **`input_epoch`** bumps on every viewer write, every rebind and every submit. `submit` is a CAS
  on `target` + `expected_input_epoch`, refuses while a viewer holds the writer lease, and is
  idempotent per `attempt_id` (a retry returns the first outcome; checked before the CAS).
- **Sequence:** re-check readiness (else `NOT_READY`, nothing written) → paste `lead + "\n"` →
  paste `text` → wait until the box shows it (echo) → if Claude is still idle, `\r` → wait for
  OSC 9;4 busy. Viewer `write`/`resize` get `CONFLICT` for the whole sequence. No echo or no busy
  within the bound → `status: "uncertain"` (bytes may be in the box; never auto-retried).
- **Why two pastes:** Claude collapses a paste over **800 chars or 4+ lines** into
  `[Pasted text #n]` and gives it to the model inside `<pasted_content>` tags, which Haiku then
  treats as data, not an instruction. The short `lead` (one line ≤ 300 chars, must start with a
  letter/digit/`[`/`(` so it can't trigger `/` `!` `#` `@` `&` modes) stays the user's own words
  and says to act on the block. Text is printable + `\n`/`\t` only (no ESC: it could end the frame).
- **`interrupt`** (daemon-only, the card's Stop): one ESC, only while the terminal's last OSC 9;4 is
  busy (else `NOT_READY`, nothing written), CAS on `target`, refused while a submit is typing, and
  idempotent per `interrupt_id`. A second interrupt within 1.5 s is refused (`CONFLICT`): two quick ESCs
  open Claude's rewind menu. Bumps `input_epoch`. Tested against the fake TUI's `working` mode.
- Exited terminals stay listed (≤ 50); their emulator is freed 60 s after exit, keeping a final snapshot.

## Verified facts (2026-09-27, Bun 1.3.5, Claude Code 2.1.283)

- Claude runs its TUI on the alternate screen; serialize → restore into a second emulator is
  identical, including after resize. Bracketed-paste and application-cursor modes survive.
- Claude exits ~0.9 s after SIGTERM with code 143, no signal (it handles SIGTERM itself).
- Unix socket paths are capped at 103 bytes on macOS: a long `FOREMAN_HOME` cannot host ptyd
  (it now fails with an explicit message).

## Verified TUI facts for idle delivery (2026-09-28, Claude Code 2.1.283, fullscreen TUI)

Evidence: `scripts/spike/gate1-idle.ts` (real haiku) and `test/ptyd-submit.test.ts` (fake TUI).

- Busy/idle: OSC `9;4;3` at turn start, kept through tool calls **and permission dialogs**;
  `9;4;0` at the end and at startup. The title glyph (`✳` idle, spinner busy) is **not** usable:
  it shows `✳` while a permission dialog is open.
- The prompt is `❯` + U+00A0 (no-break space); the empty box shows a dim suggestion.
- One `submit` = one turn = one `UserPromptSubmit`: multiline, Unicode and a 16 KiB body arrive
  byte-exact (the big one wrapped in `<pasted_content>`); echo ~20–40 ms, busy ~20–50 ms after `\r`.
- Interrupt: a single ESC (or Ctrl-C) stops a streaming turn in ~100 ms, keeps the conversation and
  fires no Stop hook. ESC during a tool also works, but a background-task notice then starts a short
  follow-up turn (Stop fires). ESC before the first token puts the prompt back in the box as a
  draft, which blocks idle delivery until cleared. A lone ESC on an idle empty prompt does nothing;
  never send two (double-ESC opens rewind) or Ctrl-C on an idle prompt (first press of "exit").

## Known gaps

- Readiness is verified against the **fullscreen** TUI only (Xander's `"tui": "fullscreen"`); any
  other layout reads as "no input prompt" and fails closed (never ready).
- CLI shows "terminal exited (code N)" without a `claude --resume <id>` hint (it doesn't know the session).
- No resume action yet for managed sessions whose ptyd died.
