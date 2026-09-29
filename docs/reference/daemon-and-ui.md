# Web daemon (foremand) and UI

`foremand` projects the session journals, merges them with ptyd and Claude-registry evidence,
and serves the React UI, a JSON API, an SSE stream and an authenticated terminal WebSocket.
Open this when touching `src/daemon/`, `src/ui/`, the API contract, auth, or session state display.

## Where it lives

| File | Role |
|---|---|
| `src/shared/api.ts` | **The** daemon ⇄ browser contract (`SessionView`, SSE `StreamEvent`, WS frames). UI imports it directly. |
| `src/daemon/auth.ts` | Host allowlist, exact-Origin checks, CLI bearer (`secrets/ui-token`), signed cookie, one-use launch tokens. |
| `src/daemon/projection.ts` | Disposable SQLite projection: folds journals, stores per-session byte offset, FSEvents watch + 1 s poll. Bump `SCHEMA_VERSION` whenever `JournalState`'s shape or fold rules change (it stores the fold as JSON; v2 added `work`, v3 batch corroboration + cancel `by`, v4 cancelled batches drop their item receipts). |
| `src/daemon/view.ts` | Evidence merge → `SessionView`: journal state + ptyd terminal + registry row. Capability labels live here. |
| `src/daemon/hub.ts` | Current views, 2 s registry poll, 30 s staleness tick, SSE ring (`<epoch>:<cursor>` ids), ptyd bind sync. |
| `src/daemon/terminals.ts` | `PtydLink` (control connection, terminal mirror, `bind` CAS), managed launcher, `launchOptions()` from `claude --help`. |
| `src/daemon/server.ts` | Hono routes, SSE, static `dist/ui` with CSP, WS proxy (one ptyd connection per browser viewer). |
| `src/daemon/idle-worker.ts` | `IdleWorker`: types queued human batches into idle managed terminals (ptyd `input_state` → `claimNext("idle_submit")` → `submit` → `settle`); keeps a per-session "why not typed" reason. |
| `src/daemon/trays.ts` | `Trays`: the per-session send tray in `ui/events.jsonl` (`tray.set` = whole tray at a new revision), `put` / `send` / `view`, crash reconcile, unsent counts for badges. |
| `src/daemon/stopper.ts` | `StopControl`: Stop → ptyd `interrupt`, then watches `input_state` for the leftover draft (`SessionView.stop`). |
| `src/daemon/delivery-view.ts` | `SessionView.delivery` summary (queued / held / why waiting / unseen / old run) and `BatchView`s for the detail route; orphan detection. |
| `src/cli/commands/{daemon,up,down,open,status}.ts` | Service lifecycle; `open` mints a launch link with the bearer secret. |
| `src/ui/` | React 19 + Vite + Tailwind 4 SPA (hash routes). `live.ts` = snapshot + SSE; `components/TerminalPane.tsx` = xterm over the WS. Card sections: `Work.tsx` (brief/progress/handover), `Items.tsx` (needs-you, decisions, receipts), `Tray.tsx` (`useTray` staging + Send), `Controls.tsx` (Pause/Stop), `Deliveries.tsx` (sent batches). |
| `src/ui/styles.css` | The look: dark-only tokens (`--ground/panel/ink/line/accent`, `--sig-*` state colours) mapped into Tailwind, plus shared classes — `.btn` (`-sm`/`-primary`/`-on` = staged choice/`-link`), `.field`, `.surface`, `.chip`, `.eyebrow` (section label), `.seg`, `.kbd`, `.enter` (mount fade). Any element with `data-state="<ActivityState>"` sets `--sig`, which `.lamp`, `.strip` (state-tinted card), `.tile` and `.sig-text` read; batch statuses and item kinds borrow it through small tone maps. Reuse these instead of one-off utility stacks. |

## Behaviour worth knowing before changing it

- **Auth:** every request needs Host `127.0.0.1:<port>` and, if an `Origin` is sent, an allowed one
  (daemon origin + `config.extra_origins`). API needs bearer or cookie; cookie mutations and WS
  upgrades need an exact Origin. The cookie is `nonce.HMAC(ui-token)` — stateless, survives daemon
  restarts. Launch tokens live 60 s, in memory, single use; `/auth/launch` 303s to `/` to drop it.
- **State honesty (`view.ts`):** managed + ptyd has the terminal → process from ptyd; ptyd up but
  terminal unknown → dead; otherwise registry row, then hook-recorded PID; else `unknown`. No hook
  evidence for 10 min without a verified-live process → `unknown`. Registry-only discoveries are
  listed only when PID + start time verify live.
- **SSE:** first connect passes `?after=<epoch>:<cursor>` from the snapshot (browser reconnects
  send `Last-Event-ID`); outside the retained 1000-event ring or across a daemon restart the
  stream sends `resync_required` and the UI refetches.
- **Terminal WS:** the daemon buffers ptyd pushes until the attach reply so `hello` (with
  `last_seq`) always arrives first — the UI suppresses query replies for output ≤ that seq.
  Frames per viewer are serialized; a browser with > 1 MiB buffered is closed (4000) to resync.
- **Browser writer lease = keyboard focus** (`TerminalPane.tsx`): no control buttons. Focusing the
  xterm sends `takeover` (input typed before the `control` reply is still sent — the per-viewer frame
  chain orders it after the takeover); blur releases after 200 ms. Opening the terminal view focuses
  it. So a background tab or the card view never holds the lease and never blocks idle delivery.
- **Launcher:** argv built server-side (never shell) via `managedClaudeArgv` (plugin dir unless
  user-installed, `--allowedTools=` for the Foreman tools — see [protocol.md](protocol.md)); model/effort validated against the
  installed CLI (`--help` only quotes *example* aliases, so a known alias set is merged in).
  The prompt goes after `--`.
- Model: SessionStart rarely carries it; `view.ts` falls back to `--model` in the terminal argv.
- **Idle worker** (plan §9.2, queue rules in [protocol.md](protocol.md)): eligible = managed, live
  terminal whose ptyd `target` equals the session's current target, OSC 9;4 `idle`, head batch
  deliverable. Poked on every hub recompute plus a 1 s tick; one in flight per terminal; 1 s backoff
  after a not-ready reading or a refused submit. A viewer holding the writer lease, a draft or a
  dialog → no claim, reason shown. Pause at the head → claimed on the idle route = mooted, never
  typed. ptyd errors that guarantee nothing was written (`NOT_READY`, `CONFLICT`, `EXITED`,
  `NOT_FOUND`, `FORBIDDEN`, `LIMIT`) settle `failed`; anything else (a lost connection, an
  unconfirmed paste) settles `uncertain`. Observed sessions are never typed into (D10).
- **Delivery display:** `SessionView.delivery` (null when nothing is pending) carries a plain-words
  `waiting` reason (busy → next tool call / turn end; observed idle → next active hook; lease/draft/
  dialog from the worker; permission prompt from hooks). An unsettled attempt whose claimer's
  PID + start time is dead shows as `orphaned` (cached once dead). `GET /sessions/:id` adds
  `batches` (newest first, exact text, attempts, receipts, `retryable`, `warning`);
  `POST /api/v1/sessions/:id/batches/:batch/retry` decides against the journal (not the projection).
  The card's "Sent to the agent" section is `src/ui/components/Deliveries.tsx`.

## Steering: tray, Send, Pause, Stop (plan §9.1)

Every steering route decides against the session journal (`foldJournal(readAll())`), never the
projection; all are cookie + exact-Origin (or bearer) like other mutations.

| Route | Does |
|---|---|
| `PUT /sessions/:id/tray` `{expected_revision, actions}` | Replace the staged actions (stale revision → 409). One staged action per item (the UI replaces), no `pause`, ≤ 20, rendered ≤ 16 KiB, no action id that already went out. Mints the tray's `batch_id` when it becomes non-empty. |
| `POST /sessions/:id/send` `{batch_id, tray_revision}` | `createBatch` (durable, validates run + item revisions; a stale item → 409 with `field` = its action id, nothing written), **then** clears exactly the sent action ids (newer edits stay). Same `batch_id` again = replay, only finishes the clear. |
| `POST /sessions/:id/pause` `{batch_id}` | A `kind:"pause"` batch (action id = batch id). Observed + no turn running (hook state not working/permission/input) → 409 "Already idle" up front. Managed idle is left to the idle worker, which moots it. |
| `POST /sessions/:id/stop` `{request_id}` | Managed only, terminal live and routed to the current target → ptyd `interrupt` (one ESC, busy only; see [terminal-host.md](terminal-host.md)). |
| `POST …/batches/:batch/cancel` · `…/retarget` `{batch_id}` | Cancel any `queued` batch (`by:"human"`); retarget an earlier run's queued send (rules in [protocol.md](protocol.md)). |
| `POST /sessions/:id/items/:item/reviewed` `{revision}` | `item.reviewed` for a decision at that exact revision (a local review; the agent is not told). |

- **Tray storage:** `ui/events.jsonl` under its own lock (`ui/.write-lock`), durable appends, read
  through a size/mtime cache (hub recomputes ask for unsent counts on every change). Crash between
  commit and clear: any staged action whose id is already in a batch, or a tray `batch_id` that already
  exists, is **reconciled** (dropped / re-minted) and written the next time the tray is read. The file is
  never compacted yet (each edit appends the whole tray, ≤ ~20 KiB).
- **Preview = frozen text:** `TrayView.preview` is `renderBatch` over the same state `createBatch` uses,
  so a Send without conflicts freezes exactly it. `TrayView.blocked` says why Send is refused.
- **Session detail** also carries `work` (brief, progress, items with `actionable`, handover) and `tray`.
  `SessionView` adds `unsent` (badge in the sidebar/overview), `terminal_progress` (ptyd's OSC 9;4
  reading; Stop is enabled only on `busy`) and `stop` (`{at, draft}` until the next turn starts).
- **Stop's draft:** `StopControl` polls `input_state` (0.5 s for 10 s, then 2 s, ≤ 30 min) and sets
  `draft` while ptyd reports "input box holds a draft"; the card shows it with an "Open the terminal"
  link. Nothing clears it; the idle worker's own reason (draft) holds delivery meanwhile.
- **Card order:** status + Pause/Stop → brief/progress (bar, ETA, confidence, now, checklist, quiet
  after 20 min) → needs-you items → decisions (Mark reviewed, Revisit) → deliverables/notes → closed →
  handover; right column: send tray → sent batches (Retry / Move to current run / Cancel, per-action
  receipts with declined/blocked notes, terminal link) → activity.
- **Agent Markdown (plan §16):** the handover summary and item details render through a small subset
  (`src/ui/markdown.ts` → `components/Markdown.tsx`: paragraphs, headings, lists, fenced code,
  inline code/bold/italic, links); item summaries get the inline part only. It parses to data rendered as
  React text nodes — no HTML path exists, raw HTML stays literal, and only absolute http(s) targets
  become links (new tab, `noopener noreferrer`); anything else shows as `label (target)` text. Every
  other agent field is plain text. Tests: `test/markdown.test.ts`; checked in headless Chrome.

## Verifying the UI

`scripts/phase1-demo.ts` covers the API/WS path with real Claude. For the browser itself, drive
headless Chrome over CDP (launch → sign in via `foreman open --print` → evaluate `.xterm-rows`
text / `Page.captureScreenshot`). The c11 embedded browser (WKWebView) signs in and renders the
app, but its xterm rows stayed empty and its screenshot/eval fail under the page's strict CSP —
use Chrome for terminal checks. Card states that need batches (queued, uncertain, Retry) can be
seeded without a model: `registerSessionStart` + `createBatch` + `claimNext`/`settle` against
`FOREMAN_HOME=/tmp/fh`, then open `#/s/<session>`. Declared work comes from `callTool(..., {source:"cli"})`.
For Pause/Stop, create the ptyd terminal with `test/fixtures/fake-claude.ts <record> working` (a fake TUI
mid-turn; an ESC ends it and leaves a draft) and register with its `FOREMAN_TERMINAL_ID`.

## Dev

`bun run dev:ui` (Vite on :5173, proxies `/api` + `/auth` with WS to :7717) needs
`"extra_origins": ["http://localhost:5173"]` in `~/.foreman/config.json`; sign in by opening the
`foreman open --print` link with its host swapped to `localhost:5173` (cookies are per host). Production: `bun run build:ui`
→ `dist/ui`, served by the daemon.
