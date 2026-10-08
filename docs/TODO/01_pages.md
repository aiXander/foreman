# Pages: a session can show a plain HTML page that the human uses and the agent maintains

**Phase 3**, before the inbox (phase 4), as decided by Xander on 2026-10-08. First user: Xander's CRM
(`~/Documents/me/CRM/`); that folder's side of the work is in its own `docs/TODO/agentic_crm.md` (read it
for P2). Replaces vision-plan §13 ("Panels"). How pages work **today** (P1, shipped):
[../reference/pages.md](../reference/pages.md). Read it before building anything here.

## The model: two channels

Decided 2026-10-08 after P1 and shipped in P1b: direct edits are saved by the page itself through
Foreman's page listener (no agent turn); talking and page-code changes are tells to the agent. The table,
the rules (no structure on top of HTML, only declared non-code files writable, neither side clobbers the
other, the agent is not told about direct edits) and how it works: [reference/pages.md](../reference/pages.md).

## Open work

| Step | Work | Exit evidence | Estimate |
|---|---|---|---|
| **P2 · CRM** | The CRM folder's side: direct edits through `PUT`, Tell boxes, transcript drop into `inbox/`, the CRM agent's rules in the CRM's `CLAUDE.md` (no write helper: the agent uses Grep/`jq`, Read and Edit; `contacts.json` is in git), retire `serve.py`. Spec: `~/Documents/me/CRM/docs/TODO/agentic_crm.md`. P1b is done. | The CRM's exit check (direct edits, Voka talk, transcript, no clobber) | ~0.5–1 d |
| **P3 · Point at it** | Alt-click any element → tell with its selector + trimmed `outerHTML` ("this one, smaller"). Needs a small injected script, the one exception to "no injection"; decide then. | — | ~0.5 d |

## Constraints from P1 that P1b, P2 and P3 must respect

- **Tells:** sent from inside the click or keypress handler while the frame has focus (the host refuses
  otherwise, so never on load, a timer or a field's blur, which often fires because the human clicked
  outside the frame); ≤ 5 per 10 s per frame; text + context ≤ 2,000 characters.
- **View state** that must survive a reload lives in `sessionStorage`, prefixed per page: the reload resets
  the URL, hash included. All pages share one origin (`localhost:<page_port>`), so storage keys need a
  per-page prefix, and anything injected (P3) must not widen what that origin can reach.
- **Any non-dot file change in the page's folder reloads the frame**, except the page's own `PUT` writes.
- **Page writes:** only declared non-code files (≤ 8 entries), whole-file replace with `If-Match` (412 → re-read
  and re-apply), 4 MiB, 30 writes / 10 s per pin; long input through a writable inbox dir + a short tell.
- Automation: click inside page frames with CDP, not Claude-in-Chrome.

## Deliberately not here

Agent-side write helpers, formats or rituals beyond what Claude Code's own tools do (decided 2026-10-08),
record- or field-level write APIs, server-side merge logic, schema or domain validation in Foreman,
data-change events pushed into the page (it reloads, or it already knows because it wrote), page versioning
beyond the last-5 backups (the folder's git is the undo), notifying the agent of direct edits, a component
library.

## Shipped

**P1 · Host (2026-10-08).** `foreman_page` + `page.set` + `SessionView.page`; a read-only page listener
on `http://localhost:<port+1>` (`/p/<token>/<path>`, realpath-bounded, no dotfiles, GET/HEAD only);
the session's Page mode (sandboxed frame, reload on fs change); page tell → `POST
/sessions/:id/tell` → one `note` batch, no tray; pins in `ui/events.jsonl` that outlive sessions, bind
only via a session's own `page.set`, with Start agent. Exit evidence: `test/pages.test.ts`, plus the
live counter loop (one haiku turn: click → batch → file edit → frame reload). Done — see
[reference/pages.md](../reference/pages.md).

**P1b · Page writes (2026-10-08).** `foreman_page({writable})` (files or existing dirs, relative to the page's
folder, never code; `src/shared/writable.ts`) → `page.set.writable` → `pin.bound.writable`; `PUT /p/<token>/<path>`
with Origin/type/size/rate/path checks, `ETag`/`If-Match` (428/412), tmp + rename, last-5 backups in
`~/.foreman/ui/page-backups/`; no reload for the page's own writes; Start agent re-declares `writable`;
contract, skill and tool texts rewritten to the two channels. Exit evidence: `test/pages.test.ts` + the
live counter v2 (one haiku turn). Done — see [reference/pages.md](../reference/pages.md).
