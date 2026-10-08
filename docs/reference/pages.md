# Pages: a session shows a plain HTML page the human uses and the agent maintains

A page is an ordinary `.html` file in a session's folder (next to ordinary data files). Foreman serves
that folder to a sandboxed frame, reloads the frame when files change, lets the page save the data files
its agent declared `writable`, and carries what the human says back to the agent as a batch. Open this
when touching `foreman_page`, the page listener (reads and writes), pins, the tell route, or the UI's Page
mode. Remaining work (the CRM as first user; point-at-element) is in [../TODO/01_pages.md](../TODO/01_pages.md).

## Two channels (P1b, 2026-10-08)

P1 made the agent the only writer (every click a message). Xander reversed that: buttons must just work
like a web page; the agent is for talking. So:

| The human | Path | Agent turn? |
|---|---|---|
| direct edit (toggle, field, delete) | the page `PUT`s its own declared data file | no, and the agent isn't told |
| talks, drops a transcript | a tell → batch → the agent reasons and edits files | yes |
| asks for a page change | a tell → the agent edits HTML/JS/CSS | yes |

Foreman's write primitive is generic on purpose ("replace this whole file if it is still the version you
read"): no records, fields, schemas or merge logic (D20). Code files are never page-writable, so the
page's behaviour changes only through the agent. The agent re-reads a writable file before changing it
and writes atomically (contract + skill say so); long input (a transcript) goes through a writable inbox
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
| `src/daemon/page-server.ts` | The page listener: `servedFile` (read path resolution), `writeTarget` (write path resolution), `pageHandler` (Host/method/Origin checks, GET/HEAD with `ETag`, the PUT pipeline: `putHeaderRefusal` → body size → rate → `writeTarget` → `badJson` → `versionRefusal` → `commit` + `backup`), `servePages`. `etagOf` = `"<sha256 hex, first 32>"`. |
| `src/daemon/hub.ts` | Calls `pins.sync` on every recompute, adds `SessionView.page`, publishes `{type:"pins"}` on change and `{type:"page", pin_id}` on folder changes. |
| `src/daemon/server.ts` | `POST /sessions/:id/tell`, `POST /pins/:pin/hide`, `pins` + `page_origin` on `GET /sessions`, host CSP `frame-src <page origin>`. |
| `src/ui/tell.ts` | `TellGate` (pure, unit-tested): what counts as a tell. |
| `src/ui/components/PagePane.tsx` | Strip (agent lamp, needs-you button, `edits: <writable>`, last tell's fate, Start agent) + the sandboxed frame + reload. `startPrompt` re-declares the pin's title and `writable`, so a relaunched agent doesn't remount read-only. Used by the session's **Page** mode and the pin route. |
| `src/ui/components/PinPage.tsx`, `Sidebar.tsx` (`PinsSection`) | `#/page/<pin>` and the sidebar's **Pages** list. |
| `test/pages.test.ts` | Every P1 and P1b exit-evidence claim except the live browser loops. |

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
- A pin whose session ended stays listed ("no agent"); the frame renders, tells get 409 "No agent". **Start
  agent** launches a managed Claude (default model) in `pin.cwd` (the binding session's cwd, so the
  folder is already trusted) with a prompt to `foreman_page` that path, which rebinds the pin.
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
- **The agent is not told about direct edits** (decision, revisit if it bites): it re-reads before acting.

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

## Verifying

**P1b live check** (done 2026-10-08, one haiku turn, all pass): counter v2 in `/tmp/fh` with
`writable: ["count.json"]` mounted via `callTool` (no model turn); "+1" PUTs with its held ETag → file
changes at once, frame load counter (in `sessionStorage`) stays 1, zero batches; "Ask the agent to double
it" → tell → haiku edits `count.json` → frame reloads (load counter 2); a second top-level tab of the same
pin URL, holding the stale ETag, clicks "+1" → `412 → re-read → 200`. Trap: **opening a second CDP tab
takes focus from the host**, and the host then refuses the frame's tell (no frame focus) silently from
the script's view; `Target.activateTarget` + `Page.bringToFront` the host tab before clicking a tell.


`bun test test/pages.test.ts` covers mount checks, listener/escapes, page origin vs daemon, TellGate,
the tell route, daemon rate limit, pins across session end/restart and the fs watch. Live loop (done
2026-10-08, one haiku turn): idle managed haiku TUI in the repo with `--add-dir <FOREMAN_HOME>/sessions
--permission-mode acceptEdits`, a counter page + `count.json` in its pages dir mounted via
`foreman call foreman_page` (no model turn), then headless Chrome over CDP: attach to the `iframe` target
(`Target.getTargets` → `attachToTarget {flatten}`) for the button's rect and `Input.dispatchMouseEvent`
on the page — that click routes into the cross-site frame. Claude-in-Chrome's clicks did **not** reach
these frames (or the page opened top-level), so use CDP for page clicks.
