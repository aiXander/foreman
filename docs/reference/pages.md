# Pages: a session shows a plain HTML page the human uses and the agent maintains

A page is an ordinary `.html` file in a session's folder (next to ordinary data files). Foreman serves
that folder to a sandboxed frame, reloads the frame when files change, lets the page save the data files
its agent declared `writable`, carries what the human says back to the agent as a batch, and puts a diff
of the page's own saves at the top of the agent's next batch. Open this when touching `foreman_page`, the
page listener (reads and writes), pins, the tell route, the edit diff, Start/Fresh agent, or the UI's Page
mode. First real user: the CRM (`~/Documents/me/CRM`, its `CLAUDE.md`). Remaining work (rich card output,
point-at-element, starter page) is in [../TODO/01_pages.md](../TODO/01_pages.md).

## Two channels (P1b + P2b, 2026-10-08)

P1 made the agent the only writer (every click a message). Xander reversed that: buttons must just work
like a web page; the agent is for talking. So:

| The human | Path | Agent turn? |
|---|---|---|
| direct edit (toggle, field, delete) | the page `PUT`s its own declared data file | no; a diff of it opens the agent's next batch |
| talks, drops a transcript | a tell → batch → the agent reasons and edits files | yes |
| asks for a page change | a tell → the agent edits HTML/JS/CSS | yes |

Foreman's write primitive is generic on purpose ("replace this whole file if it is still the version you
read"): no records, fields, schemas or merge logic (D20). Code files are never page-writable, so the
page's behaviour changes only through the agent. The agent edits data files with its own tools: it
re-reads a writable file right before changing it and makes targeted edits (Claude Code's Edit refuses a
file changed since it was read, so it can't overwrite a page save it hasn't seen), and it searches a large
data file with Grep/`jq` instead of reading it whole (contract + skill say so). No agent-side helper or
write format exists on purpose; durable history for important data is the project's git. Long input (a transcript) goes through a writable inbox
directory plus a short tell naming the file, since a tell is capped at 2,000 characters.

## The loops

```
direct edit ─► fetch PUT /p/<token>/count.json  (If-Match: <etag>)
            ─► page listener: Host/Origin/type/size/rate/declared-path/version checks
            ─► backup old bytes ─► tmp + fsync + rename ─► 200 + new ETag
            ─► Pins.noteWrite(path, etag) ─► fs watch sees it, hash matches ─► no reload

talk in page ─► parent.postMessage({type:"foreman:tell", text, context?})
              ─► host TellGate (own frame window + page origin + frame focused + size/rate)
              ─► POST /api/v1/sessions/:id/tell ─► createBatch(one `note`, via:"page")  [no tray]
              ─► normal delivery (idle worker / hooks) ─► agent edits files
              ─► Pins fs watch (debounced) ─► SSE {type:"page"} ─► host reloads the frame
```

## Where it lives

| File | Role |
|---|---|
| `src/shared/protocol.ts` | `PageInput` (`path` or null, optional `title`, optional `writable` ≤ `MAX_WRITABLE` 8), the `foreman_page` tool spec, `MAX_TELL_TEXT`. |
| `src/shared/tools.ts` | `foreman_page` handler + `mountablePage`: realpath first (symlinks out are refused), `.html`, not a dotfile, inside the session cwd or `paths.sessionPages(session)` (`~/.foreman/sessions/<id>/pages/`, throwaway pages). `writableEntries`/`placeProblem` check `writable` against the page's folder. Appends `page.set {path, title, writable}` (realpath) or `{path:null}`; the result echoes `writable`. |
| `src/shared/writable.ts` | The rules both mount and write use: `CODE_EXT` (`.html .htm .xhtml .svg .js .mjs .cjs .css .wasm`), drop-file names in a writable dir (`^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$`), `badSegment`, `writableCovers`. |
| `src/shared/reducer.ts` | `JournalState.page` (current mount, with `writable`) and `page_event` (latest page.set id, for pin binding). A P1 `page.set` without `writable` folds to `[]`. Projection `SCHEMA_VERSION` 6. |
| `src/shared/delivery.ts` | `tellNote`: `[page <title>] <text>` + `\ncontext: <compact JSON>`, ≤ 2,000 chars total. `NewBatch.via:"page"` → `batch.created.via` → `BatchState/BatchView.via` (the "from page" chip). |
| `src/shared/contract.ts` | The contract's **Pages** paragraph (only when `foreman_page` is served; names the session's pages dir). Full usage + snippet: the skill's Pages section. |
| `src/daemon/pins.ts` | `Pins`: pin store in `ui/events.jsonl` (beside trays): `pin.bound` (carries `writable`; the token authorizes writes, so the pin must know them) / `pin.unbound` / `pin.hidden`. `sync(states)` applies each session's latest `page_event` exactly once (by event id). Token = 32 random bytes, the page URL's capability. `rewatch` = one recursive `fs.watch` per pinned folder; `ignoredChange` skips dot segments, `*.tmp`, `*~`; 150 ms debounce per folder collecting the changed names; `noteWrite`/`isSelfWrite` drop the page's own writes (below). |
| `src/daemon/page-edits.ts` | `PageEdits`: what each page saved since its agent's last batch (`record` from the PUT, `take(session)` from the tell/Send routes), one JSON file per pin in `ui/page-edits/`; `renderEdits` = the batch preface with its 2 KB budget. |
| `src/daemon/line-diff.ts` | `lineHunks`: Myers line diff (common prefix/suffix trimmed, null past 1,000 edits = "rewritten") → unified hunks, 1 line of context, long lines clipped, a hunk header naming the place from indentation. |
| `src/daemon/page-server.ts` | The page listener: `servedFile` (read path resolution), `writeTarget` (write path resolution), `pageHandler` (Host/method/Origin checks, GET/HEAD with `ETag`, the PUT pipeline: `putHeaderRefusal` → body size → rate → `writeTarget` → `badJson` → `versionRefusal` → `commit` + `backup`), `servePages`. `etagOf` = `"<sha256 hex, first 32>"`. |
| `src/daemon/hub.ts` | Calls `pins.sync` on every recompute, adds `SessionView.page`, publishes `{type:"pins"}` on change and `{type:"page", pin_id}` on folder changes. |
| `src/daemon/server.ts` | `POST /sessions/:id/tell` (and Send) take the pending edit diff, `POST /pins/:pin/agent` (Start/Fresh agent), `POST /pins/:pin/hide`, `pins` + `page_origin` on `GET /sessions`, host CSP `frame-src <page origin>`. |
| `src/ui/tell.ts` | `TellGate` (pure, unit-tested): what counts as a tell. |
| `src/ui/components/PagePane.tsx` | Strip (agent lamp, needs-you button, `edits: <writable>`, last tell's fate, **Start agent** / **Fresh agent**, both `POST /pins/:pin/agent`) + the sandboxed frame + reload. Used by the session's **Page** mode and the pin route. `Deliveries.tsx` shows a batch's diff under "With your page edits". |
| `src/ui/components/PinPage.tsx`, `Sidebar.tsx` (`PinsSection`) | `#/page/<pin>` and the sidebar's **Pages** list. |
| `src/ui/components/SideCard.tsx` | The bound agent's card in a column beside the frame (message box, needs-you items, sent batches with the agent's ack notes, brief, Pause/Stop; "Full card" / "Terminal" links), in both the pin route and a session's Page mode. "Hide card" on the strip collapses it (`localStorage` `foreman.pageCard`). General messages to a page agent go through this box; a page's own tell boxes are for messages that need page context (the CRM's per-record Tell box). |
| `test/pages.test.ts`, `test/line-diff.test.ts` | Every P1, P1b, P2a and P2b exit-evidence claim except the live browser loops. |

## Security model (verified in headless Chrome, 2026-10-08)

- **Two host names.** The daemon is `http://127.0.0.1:<port>`, pages are `http://localhost:<page_port>`
  (`config.page_port`, default port + 1, env `FOREMAN_PAGE_PORT`). Cookies ignore ports: the spike showed
  the daemon cookie *is* sent to `127.0.0.1:<other port>` and *not* to `localhost:<page_port>`. Never serve
  pages on 127.0.0.1. The cookie has no `Domain` (host-only) and is `SameSite=Strict`.
- **The daemon refuses the page origin everywhere**: `checkTransport` rejects any Origin not in the
  allowlist, and `http://localhost:<page_port>` must never be added to `extra_origins`.
- **Page listener:** GET/HEAD/PUT only (405 otherwise, `OPTIONS` included, and no CORS headers ever, so a
  foreign site's preflight fails), `Host` must be exactly `localhost:<page_port>`, an
  Origin header (if any) must be the page origin, `/p/<token>/<path>` only. `servedFile` rejects empty,
  `.`/`..`, dot-prefixed and backslash segments before and after realpath, anything resolving outside
  the folder, and directories (no listings). Headers: CSP (`connect-src 'self'`, scripts self + inline +
  jsdelivr/cdnjs/unpkg, Google Fonts, `img-src 'self' data: blob:`, `frame-ancestors` = daemon origin +
  extra_origins), `no-store`, `nosniff`, `no-referrer` (keeps the token out of CDN referers),
  `CORP: same-origin`.
- **Page writes (`PUT /p/<token>/<path>`)**, refused in this order: `Origin` missing or not the page origin
  (403: browsers always send Origin on a non-GET fetch, so none = not our page); `Content-Type` not
  `application/json` / `text/plain` / `text/markdown` (415); body over 4 MiB (413); unknown token (404);
  over 30 writes / 10 s per pin (429, every attempt counts); path not a declared writable file or a
  well-named direct child of a declared writable dir, a code extension, a dot/empty segment, a folder
  resolving outside, or an existing target that is a symlink (all 404, so nothing about what exists
  leaks); `.json` that doesn't parse (400). Then the version check: replacing needs `If-Match: <ETag>`
  (428 without, 412 stale with the current `ETag`); creating needs `If-None-Match: *` (412 if it exists).
  The mount-time check (`foreman_page`) applies the same rules plus: a declared dir must exist and a
  declared entry must not be a symlink.
- **Frame:** `sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"`; same-origin is safe
  because that origin isn't Foreman's (parent DOM access throws). No popups, no top navigation.
- **TellGate** accepts a message only when `event.source` is our frame's `contentWindow` **and**
  `event.origin` is the page origin (a same-origin second frame and a foreign origin were both rejected
  in the spike), and only while the frame holds focus (`document.activeElement === iframe`: the human
  clicked or typed in it, so a page can't tell on load). Caps: 8 KiB message, 5 tells / 10 s per frame.
  The daemon adds 20 tells / min per pin (429) and the 2,000-char note limit (400).
- Limits we accept: all pins share one origin (shared storage, other pins reachable only with their
  token); a malicious page can still navigate itself to an external URL (CSP has no navigation control).
  Pages are written by the user's own agents, so the threat is a confused agent, not an adversary.

## Pins and binding

- A pin is created or rebound only by a session's own `page.set` event, applied once by event id
  (`pin.bound.event_id`), never by cwd or recency (invariant). Restart-safe: a fresh `Pins` re-applies
  nothing. Several unapplied mounts are applied oldest `ts` first.
- Same file mounted by another session → same pin, same token, new session. Unmount (`path:null`) →
  `pin.unbound` releases every pin bound to that session. Session switching pages keeps the old pin bound.
- A pin whose session ended stays listed ("no agent"); the frame renders, tells get 409 "No agent". `/clear`
  in the agent's terminal leaves the pin on the retired session the same way (never rebound on a guess, D24).
- **Start agent / Fresh agent** (P2a) are one route, `POST /pins/:pin/agent`: launch a managed Claude (default
  model) in `pin.cwd` (the binding session's cwd, so the folder is already trusted) with `startPrompt(pin)`
  (`pins.ts`: `foreman_page` that path with the same title and `writable`), **then** SIGTERM the old bound
  agent's terminal if Foreman manages it and it is live (an observed session can't be ended: `previous:
  "not_managed"`, it keeps running and loses the pin once the new one mounts). Launch first, so a failed launch
  leaves the old agent working. The new agent's own `page.set` rebinds the pin; nothing here binds. Replay of
  the same `request_id` gets the same terminal from ptyd and never ends it. The strip shows Fresh agent while
  an agent is live, Start agent otherwise; one click, no confirm (D24: Xander restarts page agents often).
- "Remove from sidebar" appends `pin.hidden`; the next mount of that file shows it again. Hidden pins
  bound to a session are still watched (its Page mode keeps reloading).

## Behaviour worth knowing

- **A write is atomic and backed up.** `<name>.<random>.tmp` beside the target, fsync, then rename over it
  (replace) or hard-link into place (create: fails if the file appeared meanwhile → 412), fsync the folder.
  The replaced bytes go first to `~/.foreman/ui/page-backups/<pin_id>/<relpath with / → __>.<ISO time>`,
  last 5 per file kept: **the undo for a buggy page that wipes a file** (Foreman's home, never the user's
  folder, so no git noise and no reload). One daemon log line per write (pin, path, bytes); no journal
  event, since a page edit is not session state and pins work with no session (writes work with no agent).
  From the version check to the rename nothing yields, so two page writes can't interleave.
- **No reload for the page's own writes.** The PUT records `absolute path → ETag` (`Pins.noteWrite`) before
  renaming. When the debounce fires, the folder emits only if some changed name is neither an existing
  directory (FSEvents reports `inbox` when a file is added inside it) nor a file whose hash equals its
  recorded ETag; a mismatch forgets the record. So an agent or editor change (or the page's write then
  an agent's within 150 ms) still reloads. Keyed by path: two open views of one file share it, and the
  second view misses that one reload (accepted).

- **Reload resets the frame URL, hash included.** The host navigates the frame with
  `contentWindow.location.replace(url)` (no history entry): a cross-origin parent can't call `reload()`
  or read the frame's hash. So pages keep view state in `sessionStorage` (which survives), prefixed per
  page because all pins share the origin. The original plan said "URL hash or sessionStorage"; only
  sessionStorage works.
- Tells skip the send tray on purpose (a click is already a human gesture) but keep everything else of a
  batch: durable before acknowledged, claimed before printed, receipts, Retry. The tell's `batch_id` is
  also its note's action id; the host mints it per tell (HTTP replay-safe).
- `SessionView.page` is null when the session's mounted path has no pin yet (before the next hub
  recompute applies the page.set).

## Edit diff on delivery (P2b, D22)

The agent sees the human's direct edits without a turn per click: the next batch Foreman creates for the
bound session opens with "Since your last Foreman message the human edited these files directly in the
page …" and a line diff. Design choices, and why:

- **Recorded at the PUT, not snapshotted at delivery.** Each successful page save hands `PageEdits.record`
  the bytes before and after. Consecutive saves chain into one segment (before of the first, after of the
  last) when a save's "before" is exactly the previous save's "after" (by ETag); a save on top of bytes
  someone else wrote (the agent's Edit) starts a new segment. So the diff is exactly the page's changes and
  never the agent's own edits, which a "snapshot at delivery, diff at the next" baseline would mix in.
  Created files (a drop into a writable dir) keep only their size: shown as name + size, never content.
- **Joined at batch creation, frozen in the journal.** The tell route and Send call `take(session)`, pass the
  text as `NewBatch.edits`, and `renderBatch` puts it above the numbered actions; `batch.created.edits` and
  `text` carry it durably, the card shows it, and every delivery route (hook or idle submit) delivers the
  same frozen text. Clearing happens only after the batch is durable and not a replay, and only if no save
  landed since `take` (a per-pin `rev`). Edits made while a batch waits in the queue ride on the next batch.
  Pause batches carry none; turns the human starts in the terminal carry none (the pending edits wait).
- **Store:** `~/.foreman/ui/page-edits/<pin_id>.json` = `{session, rev, files: {rel: [segments]}}`, atomic
  replace per save; survives a daemon restart. Keyed by the bound session: a save with no bound agent is not
  recorded, and a pin rebound to a new session (Fresh/Start agent) starts empty, so a fresh agent's first
  batch has no diff from before it existed.
- **Budget:** hunks (1 line of context; context lines clipped at 80 chars, changed lines at 400) within
  `EDIT_DIFF_BUDGET` 2,048 bytes in file order; whatever doesn't fit becomes one line per file ("N more
  changes not shown (+a −b lines); read the file, or `git diff <file>` if the folder is in git"). A segment past
  1,000 line edits says "rewritten". The whole preface stays under ~6 KB (many dropped files are cut).
- **Hunk headers name the place** generically from indentation (`where` in `line-diff.ts`): up to three
  enclosing block heads, the root left out, and a head that only opens a block (`{`, `[`, `-`) named by the
  block's first line. A CRM record shows as `@@ -58,3 +58,3 @@ "contacts" › "name": "Voka Oost-Vlaanderen"`.
- Trap: the page's own housekeeping fields (the CRM stamps `updated` and `modified` on every save) show up
  as hunks too and spend budget; that's the page's choice, Foreman stays generic.

## Verifying

**P1b live check** (done 2026-10-08, one haiku turn, all pass): counter v2 in `/tmp/fh` with
`writable: ["count.json"]` mounted via `callTool` (no model turn); "+1" PUTs with its held ETag → file
changes at once, frame load counter (in `sessionStorage`) stays 1, zero batches; "Ask the agent to double
it" → tell → haiku edits `count.json` → frame reloads (load counter 2); a second top-level tab of the same
pin URL, holding the stale ETag, clicks "+1" → `412 → re-read → 200`. Trap: **opening a second CDP tab
takes focus from the host**, and the host then refuses the frame's tell (no frame focus) silently from
the script's view; `Target.activateTarget` + `Page.bringToFront` the host tab before clicking a tell.


**P2 scratch check** (2026-10-08, no model): `FOREMAN_HOME=/tmp/fh FOREMAN_PORT=7801`, a managed session whose
terminal is `test/fixtures/fake-claude.ts` (registered with its `FOREMAN_TERMINAL_ID`; so tells "deliver"
without a model turn), a copy of the CRM's `index.html` + `contacts.json` + `inbox/` in its pages dir mounted
with `callTool("foreman_page", …, writable ["contacts.json","inbox/"])`, then headless Chrome over CDP (frame
target for element rects and setup `Runtime.evaluate`, mouse events on the host page; synthetic `DragEvent`s
for the board drag and the file drop). 23 checks pass: star / next_touch / drag save at once with no batch and
no reload; a targeted external edit reloads the frame and `sessionStorage` restores the open record and the
half-typed Tell text; a second top-level tab with a stale ETag gets 412 → re-read → re-apply, keeping both
edits and the "agent's"; a tell gives one page batch whose diff holds the page's edits but not the external
one, and the fake terminal receives it; long text and a dropped `.vtt` go to `inbox/` and the second click
sends the tell naming the file; no console errors. Fresh agent was not clicked live (it starts a real turn);
the route is covered in `test/pages.test.ts` with a stubbed ptyd.

`bun test test/pages.test.ts` covers mount checks, listener/escapes, page origin vs daemon, TellGate,
the tell route, daemon rate limit, pins across session end/restart and the fs watch. Live loop (done
2026-10-08, one haiku turn): idle managed haiku TUI in the repo with `--add-dir <FOREMAN_HOME>/sessions
--permission-mode acceptEdits`, a counter page + `count.json` in its pages dir mounted via
`foreman call foreman_page` (no model turn), then headless Chrome over CDP: attach to the `iframe` target
(`Target.getTargets` → `attachToTarget {flatten}`) for the button's rect and `Input.dispatchMouseEvent`
on the page — that click routes into the cross-site frame. Claude-in-Chrome's clicks did **not** reach
these frames (or the page opened top-level), so use CDP for page clicks.
