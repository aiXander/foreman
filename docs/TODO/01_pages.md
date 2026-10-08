# The surface: the card (common) and the page (custom) as one HTML interface

**Phase 3**, before the inbox (phase 4), as decided by Xander on 2026-10-08. First user: Xander's CRM
(`~/Documents/me/CRM/`); that folder's side (and the live exit check still to run with Xander) is in its own
`docs/TODO/agentic_crm.md`. Replaces vision-plan §13 ("Panels"). How pages work **today** (P1, P1b, P2, P2a, P2b shipped):
[../reference/pages.md](../reference/pages.md). Read it before building anything here.

## The vision this serves (grilled with Xander, 2026-10-08)

HTML replaces terminal text as the interface between Xander and his agents. One surface per session, two
layers:

| Layer | What it is | Who shapes it |
|---|---|---|
| **Card** (common) | What every session needs: goal/progress, click-to-answer questions, decisions, handover, Send. Foreman's React UI. | Foreman, the same in every project |
| **Page** (custom, optional) | A per-project HTML app (the CRM first). Coding sessions start without one; an agent may add one mid-session when it helps. | The agent, usually forked from a starter page (P5) |

- **Two layers underneath, always.** The card runs on the daemon origin, which can type into terminals; the
  page is agent-written HTML in a sandboxed frame on the page origin. They may *look* like one surface but
  never merge technically. First cut (2026-10-08, after Xander couldn't find the card in Page view): the
  card sits in a collapsible column beside the page, with a full message box on top; the final layout
  (Xander mostly uses a 16:9 screen) is revisited with rich card output (P4).
- **Agent questions and replies live on the card** (`foreman_ask`, `foreman_post`), in the CRM too. A page
  grows its own question widget only if the card version proves clunky in use.
- **Most clicks never start a turn.** Direct edits save silently; the agent sees them as a diff on its next
  delivery (P2b). A page may make a specific meaningful action also send a tell (e.g. a card dragged to
  "won"), from the click handler.
- **The agent sees typed text only on Send** (⌘↵ / a Send button), never live drafts.
- **Adoption test:** Foreman replaces c11 for agent work if the visual surface clearly lets Xander take in
  more from agents than terminal text. The CRM trial (P2) tests the human → agent direction; rich card
  output (P4) tests agent → human and decides adoption.
- Out of scope for now: phone / remote access (a tunnel such as Tailscale is the likely later want; it needs
  its own auth design).

## The model: two channels

Shipped in P1b: direct edits are saved by the page itself through Foreman's page listener (no agent turn);
talking and page-code changes are tells to the agent. The table, the rules (no structure on top of HTML,
only declared non-code files writable, neither side clobbers the other) and how it works:
[reference/pages.md](../reference/pages.md). Reversed 2026-10-08 and shipped in P2b: the agent *is* told
about direct edits, as a diff at the top of its next batch.

## Open work

Order: the CRM's live exit check (P2, built) → P4 → phase 4 inbox → full switch from c11. P3 and P5 when they earn it.

| Step | Work | Exit evidence | Estimate |
|---|---|---|---|
| **P2 · CRM live exit check** | Built (see Shipped). Left: run the CRM's exit check steps 2–6 with Xander on his real data (real Claude turns: the Voka talk, a transcript, no clobber, edit diff, Fresh agent), then a week of every CRM update through the page. Watch in that week: whether the 2 KB diff budget and its hunk headers are enough for the agent; whether a page action should send a tell by itself (dragging to `won`). | The CRM's exit check, live | with Xander |
| **P4 · Rich card output** | A coding agent can put diagrams, tables, colour or images into its handover, decisions and notes on the common card. Mechanism open: richer Markdown (Mermaid, tables, project images) vs. an agent-written HTML fragment in a small sandboxed frame inside the card (leaning the latter: the same "HTML is the interface" idea everywhere). **Its own short grill with Xander after the CRM trial.** Then the card/page layout. | Xander judges a real coding session's card: does it beat reading the terminal? | tbd |
| **P3 · Point at it** | Alt-click any element → tell with its selector + trimmed `outerHTML` ("this one, smaller"). Needs a small injected script, the one exception to "no injection"; decide then. | — | ~0.5 d |
| **P5 · Starter page** | One `starter.html` shipped with the Foreman skill (a small helper: `tell()`, save with `If-Match` + 412 retry, view state in `sessionStorage`), extracted from what proves reusable in the CRM page. Projects copy it and own their copy (fonts, styling, features grow per project); Foreman's server never knows about it. A file, not a component library. Timing: with P4, or when a second project wants a page. | A second project's page forked from it | ~0.25 d |

## Constraints from P1 that P2–P5 must respect

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
beyond the last-5 backups (the folder's git is the undo), an agent turn per direct edit, live drafts sent to
the agent, a component library in Foreman (the starter page is a file projects copy), merging the card and
the page into one origin.

## Shipped

**P2 · CRM trial build, P2a · Fresh agent, P2b · edit diff on delivery (2026-10-08).** CRM side: `index.html`
saves through `PUT` + `If-Match` with a 412 re-apply, Tell boxes, `inbox/` drops, view state in
`sessionStorage`, the CRM agent's rules in its `CLAUDE.md`, `serve.py` archived. Foreman: `POST /pins/:pin/agent`
(launch first, then end the old managed agent; Start agent uses it too); `PageEdits` records each page save's
before/after (so the diff is the page's changes only) and the tell/Send routes freeze it into the batch
(`batch.created.edits`), 2 KB budget with per-file summary. Exit evidence: `test/pages.test.ts`,
`test/line-diff.test.ts`, the 23-check CDP run on a scratch copy. Done — see [reference/pages.md](../reference/pages.md).

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
