# Foreman

## Mission

Foreman is a local supervision layer for many parallel **Claude Code** sessions: a Bun terminal
host (`ptyd`) runs real Claude TUIs, a Claude plugin's hooks record what each session is doing,
and a local web daemon (`foremand`) + React UI show every session as a card with one click to its
live terminal. The goal is lowering the human's supervision effort, not replacing Claude's TUI.
Single user, local only, macOS first, MIT. Nothing is deployed.

**Built:** phase 1 "host + see" — managed terminals, session journals, passive hooks, daemon with
auth, session list/card/terminal UI, minimal launcher — plus ptyd's idle-delivery ops
(`input_state`/`submit`) from the phase-0 spike, which proved every delivery/identity gate.
Phase 2 is done (exit evidence 12/12 live): the agent protocol (SessionStart contract, stdio MCP sidecar with the
`foreman_*` tools whose session `target` a PreToolUse hook stamps, `foreman:foreman` skill,
batch/claim queue on the journal), human batch delivery
(PostToolUse/Stop hooks, daemon idle worker, Retry on the card), steering from the card (persisted send
tray → Send, Pause, Stop = one ESC, retarget/cancel, brief/progress/items/handover sections, safe
Markdown), and per-project peers (contract block + `foreman_peers`; messaging is Claude's native
`SendMessage`). **Next:** phase 3 (global inbox + attention). Plan: `docs/TODO/`.

## Blast radius

Everything is local. Free to run without asking: `bun test`, typecheck, builds, `fallow`,
`scripts/phase1-demo.ts` (spawns idle Claude TUIs in a temp `FOREMAN_HOME`; costs nothing until
a prompt is sent), and services under a temporary `FOREMAN_HOME`.
Ask first: anything that writes `~/.claude/` (installing the plugin user-wide, settings, hooks),
sending prompts to real Claude sessions beyond a one-line `--model haiku` smoke (this includes the
`scripts/spike/gate*.ts` probes: each runs a few haiku turns under `/tmp/fh`),
`scripts/phase2-delivery-demo.ts` (~7 haiku turns), `scripts/phase2-exit-demo.ts` (~10 haiku turns, two named sessions that message each other), and `foreman down --ptyd` / killing ptyd
against the real `~/.foreman` (it ends every managed agent).

## Documentation map

| Doc | Open it when |
|---|---|
| [docs/reference/storage-and-identity.md](docs/reference/storage-and-identity.md) | touching journals, locks, `~/.foreman/` layout, session/run registration, the reducer or liveness |
| [docs/reference/terminal-host.md](docs/reference/terminal-host.md) | touching ptyd, the socket protocol, snapshots/replay, idle delivery (`input_state`/`submit`, readiness), Stop (`interrupt`) or `foreman run/attach/ls/kill` |
| [docs/reference/protocol.md](docs/reference/protocol.md) | touching the MCP tools/schemas (`protocol.ts`, `tools.ts`), the SessionStart contract, the skill, declared work (`work.ts`), peers (`peers.ts`) or the batch queue/claims (`delivery.ts`) |
| [docs/reference/plugin-hooks.md](docs/reference/plugin-hooks.md) | touching `plugin/` or `src/hooks/`, building hook delivery / MCP / skill (verified mechanisms and namespaces), or after a Claude Code upgrade changes hook payloads |
| [docs/reference/daemon-and-ui.md](docs/reference/daemon-and-ui.md) | touching the daemon, auth, the API contract, SSE, the terminal WebSocket, the idle-delivery worker, delivery display/Retry, the send tray / Send / Pause / Stop routes, or the UI card |
| [docs/TODO/](docs/TODO/) | planning the next phase; the build plan's contracts for unbuilt work live there |

## Debugging priors

- Session shows nothing / wrong state → is `plugin/dist/hook.js` built (`bun run build:plugin`),
  and did the hook write where the daemon reads? ptyd forces its own `FOREMAN_HOME` onto children.
- A process looks dead or reused when it isn't → start-time mismatch; it must be `TZ=UTC ps -o lstart=`.
- Hosted Claude behaves oddly (no transcript, wrong surface) → env leaked from a parent agent;
  check the scrub list in `src/ptyd/terminal.ts`.
- Foreman tools missing / "server failed" in Claude → `plugin/dist/mcp.js` not built, or bun not
  found by `plugin/bin/foreman-mcp` (it logs to stderr). A Foreman call refused with "could not
  identify this session" or prompting for permission → the PreToolUse hook didn't stamp it
  (`plugin/dist/hook.js` not built; `src/hooks/stamp.ts`). The model never passes `target` itself.
- A batch sits queued on an idle managed session → the card's "Sent to the agent" line carries the
  idle worker's reason (writer lease held, draft in the box, dialog); nothing is typed on a guess.
- A hosted Claude never registers (no SessionStart) in a new cwd → it is sitting on the folder-trust
  dialog; accepting writes Claude's config (ask first) — run experiments in an already-trusted folder.
- ptyd "Failed to listen" → socket path over 103 bytes (long `FOREMAN_HOME`).
- Tray shows a conflict / Send refused 409 → the agent revised or resolved that item after it was
  staged (`staleReason`); remove and restage. Stop disabled → ptyd doesn't read the terminal as busy
  (`SessionView.terminal_progress`); ptyd refuses an ESC into an idle prompt by design.
- `submit` always `NOT_READY` after a Claude Code upgrade → the TUI layout or OSC 9;4 signal moved;
  re-run `scripts/spike/gate1-idle.ts` and fix `src/ptyd/readiness.ts` (it fails closed by design).

## Layout

- `src/shared/` — contracts and storage used by every process: paths, lock, journal, event schemas,
  registration, reducer, ptyd protocol + client, daemon API types (`api.ts`), the agent protocol
  (`protocol.ts` schemas, `tools.ts` handlers, `work.ts` fold, `delivery.ts` queue, `contract.ts`).
- `src/ptyd/` — terminal host. No model or journal work here.
- `src/daemon/` — projection, evidence merge, HTTP/SSE/WS, launcher, idle-delivery worker, delivery display,
  send trays (`trays.ts`, in `ui/events.jsonl`), Stop (`stopper.ts`).
- `src/hooks/` — hook entrypoint, bundled into `plugin/dist/hook.js`.
- `src/mcp/` — stdio MCP sidecar, bundled into `plugin/dist/mcp.js` (MCP TS SDK v2).
- `src/cli/` — `foreman` CLI; `main.ts` lazily loads `commands/*`.
- `src/ui/` — React SPA; built to `dist/ui/` (gitignored) and served by the daemon.
- `plugin/` — the Claude plugin package (hooks, `.mcp.json`, `skills/foreman/`; its `reference.md` is
  generated by `scripts/gen-skill-reference.ts`). `scripts/` — exit-evidence demos; `scripts/spike/` holds
  the phase-0 gate probes and a spike plugin (real Claude; not product code). `test/` — `bun test`
  suites; `test/fixtures/fake-claude.ts` imitates Claude's input box for the submit tests.

## Load-bearing rules

1. Session journals are the only authority; SQLite, manifests and by-* maps must stay rebuildable
   from them. Never report a mutation before it is appended (and fsynced when acknowledged).
2. Hooks always exit 0; their only model-visible output is deliberate protocol context (the
   SessionStart contract, batch delivery). They store only names/paths/counts — never prompts,
   tool bodies or messages. A hook claims a batch in the journal before it prints it.
3. Unknown is shown as unknown: never treat a registry file, a silent PTY or a Stop event as proof
   of liveness or input readiness. Nothing pastes into a terminal on a guess (phase 2 gate).
4. Terminal bytes travel as base64 frames and viewers resync by snapshot; never send a raw byte
   tail as a substitute.
5. Every browser-reachable route goes through `src/daemon/auth.ts`; no permissive CORS, no secrets
   in the SPA, agent strings rendered as text only.
6. Other agents often work in this tree at the same time: stage your own files by path.

## Definition of done

`bun test` green (run twice for anything touching ptyd, locks or timing),
`bun run typecheck` clean, `bun run build` succeeds, `fallow audit` clean for changed files
(known false positives: daemon class members reached through `Deps`), UI changes checked in a
real browser (see the daemon doc's headless-Chrome recipe), and the doc pass done: reference docs
updated, the TODO plan drained. Commits only when asked.

## Invariants

- One journal writer at a time per session (directory lock); `seq` orders events, timestamps don't.
- ptyd outlives the daemon and the browser; the daemon reconnects to ptyd and re-mirrors terminals.
- A managed session is routed by `FOREMAN_TERMINAL_ID` → SessionStart → `run.started.target`,
  then the daemon `bind`s that target onto the terminal. A Foreman tool call is routed by the
  PreToolUse hook's `session_id` → current target (`src/hooks/stamp.ts`); the model never supplies it.
  Never route by cwd or "most recent".

## Commands

```bash
bun install
bun run build                 # plugin bundles (hook + MCP sidecar) + UI
bun test                      # all suites (~13 s)
bun run typecheck             # server + UI tsconfigs
bun src/cli/main.ts up        # start ptyd + foremand (logs in ~/.foreman/logs/)
bun src/cli/main.ts open      # sign the browser in (one-use 60 s link)
bun src/cli/main.ts run claude [args]   # managed Claude; detach Ctrl-] d
bun src/cli/main.ts ls | attach <id> | kill <id> | status | down [--ptyd]
bun src/cli/main.ts call <tool> '<json>'  # protocol tool via CLI (MCP mirror)
bun scripts/gen-skill-reference.ts       # regenerate the skill's schema reference after schema edits
bun scripts/phase1-demo.ts    # real-Claude phase-1 exit evidence (isolated home)
bun scripts/phase2-delivery-demo.ts  # real-haiku delivery exit evidence in /tmp/fh (ask first)
bun scripts/phase2-exit-demo.ts      # real-haiku phase-2 exit evidence: task loop, peers, Stop (ask first)
```
Isolate any experiment with `FOREMAN_HOME=/tmp/fh FOREMAN_PORT=7801` (keep the path short).
