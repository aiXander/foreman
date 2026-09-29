# Storage and identity

How Foreman persists state and decides which Claude conversation an event belongs to.
Open this when touching journals, locks, `~/.foreman/`, session/run registration or the reducer.

## Where it lives

| File | Role |
|---|---|
| `src/shared/paths.ts` | Every path under `~/.foreman/` (`FOREMAN_HOME` overrides; tests always set it). |
| `src/shared/lock.ts` | Cross-process writer lock: an atomic directory with `owner.json` (PID + process start). |
| `src/shared/journal.ts` | Append-only JSONL writer/reader: seq, torn-line repair, request-id idempotency, fsync. |
| `src/shared/events.ts` | Zod schemas for every journal event type. Same schemas validate writes and replay. Declared-work and batch/delivery events reuse `protocol.ts` schemas — see [protocol.md](protocol.md). |
| `src/shared/store.ts` | `appendSessionEvents` (validated append), manifest cache, by-native lookup, lock timeouts. |
| `src/shared/registration.ts` | SessionStart/SessionEnd identity logic (plan §6.2) under the global registration lock. |
| `src/shared/reducer.ts` | Pure fold: journal → `JournalState` (activity state, counters, recent paths, activity ring; `work` = `work.ts` fold of brief/items/batches). |
| `src/shared/proc.ts` | Process identity and liveness (`alive` / `dead` / `unknown`). |
| `src/shared/native.ts` | Reads Claude's own registry `~/.claude/sessions/*.json` (never `.key` files or sockets). |
| `src/shared/project.ts` | Project = `git rev-parse --show-toplevel` realpath, else the cwd. |

## Layout (`~/.foreman/`, dirs 0700, files 0600)

`sessions/<uuid>/events.jsonl` is the only authority. Everything else is rebuildable:
`sessions/<uuid>/manifest.json` (latest identity), `sessions/by-native/claude-<native id>`
(→ Foreman UUID), `sessions/by-terminal/<terminal id>.json` (→ `{session, run}`),
`sessions/by-target/<target>` (→ Foreman UUID, for MCP routing),
`cache/projection.sqlite` (daemon), `run/{ptyd,foremand}.json` (service records), `secrets/ui-token`.
`ui/events.jsonl` is the second authority: human-side UI state that isn't a session event — today the
send trays (`tray.set`, written by the daemon; see [daemon-and-ui.md](daemon-and-ui.md)).

## Identity model

- **Session** = one Claude conversation (native `session_id`); Foreman mints its own UUID.
- **Run** = one incarnation. Every non-`compact` SessionStart starts a new run with a new
  `target` UUID (the routing handle for MCP tool calls and ptyd `bind`; the model never sees it — the
  PreToolUse hook stamps it onto Foreman calls, see [protocol.md](protocol.md)); `compact` keeps run +
  target and logs `run.compacted`.
  A still-open previous run is ended first (`reason: "superseded"`) — two live runs never merge.
- **Managed** iff the hook sees `FOREMAN_TERMINAL_ID` in its env (set by ptyd). SessionEnd ends
  the run once (1 s lock budget: Claude gives all SessionEnd hooks 1.5 s). In-TUI `/clear` and
  `/resume` fire SessionEnd (`clear` / `resume`) on the old conversation *before* the new
  SessionStart, so the old run normally ends with that reason; `run.ended{reason:"rebound"}` is the
  backstop when SessionStart finds the terminal still bound to a live run (e.g. SessionEnd was dropped).
  The daemon then `bind`s the terminal to the new target (verified live in phase 0).
- `claude_pid`/`claude_start` come from walking the hook's parent chain — corroboration only,
  never routing.

## Journal rules (load-bearing)

- One writer at a time via the directory lock; `seq` is assigned under it. Timestamps never order.
- Passive telemetry: 250 ms lock budget, no fsync, dropped + logged on timeout. Explicit
  mutations: 2 s, fsync before returning.
- A final line without `\n` is a write that was never acknowledged: moved to `events.jsonl.torn-*`
  and truncated. An unparseable *complete* line = interior corruption → journal is read-only
  (writer throws `CORRUPT`; daemon projection stops folding and logs it).
- Lines ≤ 64 KiB. `request_id` replay returns the original events; a different payload → `CONFLICT`
  (currently a full-journal scan; fine at phase-1 volumes).
- `Journal.transact(decide, …)` = read → decide → append under one lock hold. Use it whenever the
  write depends on current state (revisions, limits, delivery claims); its idempotency compares a
  hash of the caller's input (`request_hash`), not the computed payload. `decide` must not do I/O
  outside the journal — the lock is held.
- Replay validates every record with `parseEvent`; an unknown `v` stops the fold visibly.

## Traps already hit

- **Never `rm -r` a lock in place.** macOS `rename()` replaces an *empty* directory, so a
  half-deleted lock let a second writer in (duplicate seq). Release/break = rename away, then delete.
- **Process start time must be read with `TZ=UTC ps -o lstart=`** — that string is byte-identical
  to Claude's registry `procStart`. Local-time output is 2 h off and makes every PID look reused.
- `kill(pid,0)` → `EPERM` means alive-but-not-ours; missing start data means `unknown`, never dead.
- Registry rows are shown only when PID + start time verify live: many stale `.json` files remain
  after Claude exits.
