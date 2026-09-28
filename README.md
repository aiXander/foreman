# Foreman

**Run ten Claude Codes. Read ten cards, not ten terminals.**

Foreman is a local dashboard for supervising many parallel [Claude Code](https://claude.com/claude-code) sessions. Every session becomes a card showing what it's working on, how far along it is, and what it needs from you. You answer by clicking, press **Send**, and Foreman delivers it the moment that agent can take it. When you need the real thing, one click opens the live terminal.

It doesn't replace Claude's TUI. Every session is a real `claude` process with slash commands, permission prompts and everything else intact. Foreman just makes it cheap to keep an eye on all of them.

> 🚧 **Early and personal.** macOS, single user, runs on `localhost`, nothing leaves your machine. The name is provisional.

---

## What a card shows

```
┌─ api-refactor ─────────────────────────────── ● working ─ [Pause] [Stop] ┐
│ Goal     Move auth into middleware                                       │
│ Done when all routes pass the auth test suite                            │
│ ████████████░░░░░░  62%  · ETA 15–25 min · now: fixing 3 failing routes  │
│                                                                          │
│ Needs you (2)                                                            │
│   ? Keep the legacy /v1 token path?   [Keep it] [Drop it]  default: keep │
│   ◆ Decision: jose over jsonwebtoken     [Mark reviewed] [Revisit…]      │
│                                                                          │
│ 2 staged                                                   [Send tray →] │
└──────────────────────────────────────────────────────── open terminal ↗ ─┘
```

- **Brief and progress**: the goal, the success criterion, a checklist, and the agent's own estimate of % done and ETA.
- **Items**: questions (with a default, so work keeps moving), decisions it made that you might want changed, blockers, issues, deliverables, and commands for you to run.
- **Handover**: a short review package when it finishes, so you don't have to read the transcript.
- **Steering**: stage answers in a tray, then **Send** them as one batch. You can also **Pause** or **Stop** (one ESC) the session.

## How it works

```
  browser (React UI)
        │  auth'd HTTP · SSE · terminal WebSocket
        ▼
  foremand ── web daemon: reads the journals, builds the cards, delivers your batches
        │
        ▼
  ptyd ────── terminal host: owns the real `claude` PTYs and outlives everything else
        │
        ▼
  claude ×N ─ each loaded with the Foreman plugin:
               • hooks log what the session is doing
               • MCP tools (foreman_brief, _progress, _ask, _post, _handover…) let it report
               • a skill teaches it the protocol
        │
        ▼
  ~/.foreman/  one append-only journal per session: the only source of truth
```

A few rules keep it trustworthy:

- **Nothing is typed on a guess.** A batch goes into a terminal only when Foreman can verify the input box is idle and empty. Otherwise it waits and tells you why.
- **Unknown stays unknown.** A quiet terminal isn't assumed to be alive or ready.
- **Files are truth.** Agents can still report while the daemon or UI is down. Every database is rebuildable from the journals.
- **Private by construction.** Hooks record names, paths and counts, never your prompts or tool output.

## Quickstart

Requires [Bun](https://bun.sh) ≥ 1.3.5 and Claude Code.

```bash
bun install
bun run build                            # plugin bundles + UI

bun src/cli/main.ts up                   # start ptyd + the daemon (http://127.0.0.1:7717)
bun src/cli/main.ts open                 # sign the browser in (one-use link)
bun src/cli/main.ts run claude           # start a managed session (detach: Ctrl-] d)
```

Managed sessions get the plugin loaded automatically. You can also launch them from the UI. To have a session you started yourself show up as a card, start it with `claude --plugin-dir <this-repo>/plugin`.

| Command | What it does |
|---|---|
| `foreman up` / `down [--ptyd]` | Start or stop the services. `--ptyd` also ends every managed agent. |
| `foreman run claude [args]` | Launch a managed Claude and attach to it |
| `foreman ls` · `attach <id>` · `kill <id>` | List, re-attach to or kill managed terminals |
| `foreman open` · `status` | Open the UI, show service health |
| `foreman call <tool> '<json>'` | Call a protocol tool from the shell |

(`foreman` = `bun src/cli/main.ts` until it's linked.)

## Status

| | |
|---|---|
| ✅ **Host + see** | Managed terminals, hooks, journals, authenticated daemon, cards and live terminals |
| ✅ **Protocol + steering** | Agent MCP tools and skill, send tray → Send, reliable batch delivery, Pause and Stop |
| 🔨 **Next** | Peers: sessions in the same project aware of each other |
| 🔜 **Then** | A global inbox across all sessions, then a week of dogfooding |

## Development

```bash
bun test              # all suites
bun run typecheck
bun run dev:ui        # UI with hot reload
```

`CLAUDE.md` and `docs/` are written for coding agents working on Foreman. They're dense, but they're the full technical reference.

## License

MIT
