# Agent protocol (MCP, contract, skill) and the batch queue

How a Claude session talks to Foreman: the SessionStart contract gives it a `target`, the stdio MCP
sidecar exposes the `foreman_*` tools, and everything lands as events in the session journal. Also
the human-batch queue every delivery route claims from (the routes themselves: hooks in
[plugin-hooks.md](plugin-hooks.md), the idle worker in [daemon-and-ui.md](daemon-and-ui.md)). Open this when touching `src/shared/protocol.ts`,
`tools.ts`, `work.ts`, `delivery.ts`, `contract.ts`, `src/mcp/`, or `plugin/skills/foreman/`.

## Where it lives

| File | Role |
|---|---|
| `src/shared/protocol.ts` | **The** Zod definitions: tool inputs (plan §8.2), item bodies, human batch actions (§9.1), limits, error codes, the tool catalogue (`TOOLS`, `qualifiedTool`). MCP, the CLI mirror, HTTP and journal replay all validate with these. |
| `src/shared/tools.ts` | `callTool(name, input, ctx)`: target resolution + every handler. `HANDLED_TOOLS` = what this build serves (`foreman_peers` is declared but not served yet). |
| `src/shared/work.ts` | `WorkState` fold (brief, progress, items, handover, batches → attempts → receipts), `batchStatus`, `queueHead`, `isActionable`/`openCounts`. Pure. |
| `src/shared/delivery.ts` | `createBatch` (freeze a Send), `claimNext` / `settle` / `retryBatch` / `onUserPrompt`, human `cancelBatch` / `retargetBatch` / `markReviewed`, rendering (`renderBatch` = the tray preview, `staleReason` = tray conflicts), hook framing (`hookContext`), idle lead (`idleLead`), marker parsing. |
| `src/shared/contract.ts` | The SessionStart contract text (mode-specific). |
| `src/mcp/main.ts` | Stdio sidecar → `plugin/dist/mcp.js`. MCP TS SDK **v2** (`@modelcontextprotocol/server`, spec 2026-07-28). |
| `src/cli/commands/call.ts` | `foreman call <tool> '<json>'` — CLI mirror; fills `request_id`, skips the terminal-ownership check. |
| `plugin/.mcp.json`, `plugin/bin/foreman-mcp` | Plugin MCP registration; shim finds bun and fails loudly (unlike the hook shim). |
| `plugin/skills/foreman/SKILL.md` | The `foreman:foreman` skill (~1,500 words). `reference.md` beside it is **generated** by `scripts/gen-skill-reference.ts` (a test fails when stale — rerun it after any schema change). |

## Identity and routing

- SessionStart prints `hookSpecificOutput.additionalContext` = the contract, on **every** source
  (startup/resume/clear/compact), because it carries the current run's `target`. Compact keeps the
  target; everything else mints a new one. The contract names the deferred tools as one
  `ToolSearch select:` line and tells the model to load the skill.
- `target → session` via `sessions/by-target/<target>` (written at registration, rebuildable;
  falls back to scanning manifests for older journals). Inside the lock the handler folds the
  journal and requires `state.target === target` and a live run, else `STALE_TARGET`; unknown →
  `NOT_REGISTERED`.
- Sidecar ownership: the sidecar inherits `FOREMAN_TERMINAL_ID` (and survives `/clear`). With one,
  it may only act on sessions of that terminal; without one, only on observed sessions. The CLI
  mirror skips this (the human runs it).
- Managed launches (`managedClaudeArgv` in `src/shared/config.ts`, used by `foreman run` and the
  daemon launcher) add `--allowedTools=<all foreman tools>` — the `=` form, because the flag is
  variadic and would otherwise swallow a following prompt (verified live with `-p`).

## Rules the handlers enforce

- Every mutation is one `Journal.transact` (read → decide → append under the session lock, fsync).
  `request_id` idempotency hashes the **input** (`request_hash` on the envelope): a retry returns the
  original event without re-deciding (so revisions don't drift); same id, different input → `CONFLICT`.
- IDs agents invent (`request_id`, action ids) are `z.guid()` — any 8-4-4-4-12 hex. `z.uuid()` rejects
  model-made UUIDs with wrong variant bits; don't tighten it.
- MCP errors: the SDK is given an *advertise-only* Standard Schema (emits the Zod JSON Schema,
  validates nothing), so invalid input reaches `callTool` and comes back in the protocol envelope
  `{ok:false, code, field?, message}` with `isError: true` — same shape as CLI/HTTP.
- Items: create at `expected_revision: 0`, replace at the exact revision with full content, kind fixed,
  resolved items are closed for edits. Limits (3 open questions, 5 unreviewed decisions, 50 actionable)
  are checked on **create** only. A question's options/policy freeze once a human answer was sent.
- Resolve: questions never `completed` (they close via an applied answer ack); `default_applied` only
  for proceed/park; `superseded_by` must exist.
- Handover must carry every actionable item (`isActionable`: open question/blocker/offer/ship,
  unfixed issue, decision not reviewed at its current revision).
- Inbox acks: validated against the session's batches/actions; `seen` then `acted` per action; never
  regress. An applied `answer` / `offer_accept` / `offer_decline` / `ship_ack` appends `item.resolved`
  (`answered` / `accepted` / `declined` / `acknowledged`) in the same transaction.

## The batch queue (proven delivery rule, plan §9.2)

- `batch.created` freezes the actions + rendered text (validated against the current run and item
  revisions — stale → `CONFLICT`, never reinterpreted). Text carries `[action <uuid>]` per line and is
  stripped of control characters (CRLF → LF) so ptyd can always type it. The `[foreman batch <id>]`
  marker is added by the route (`hookContext` / `idleLead`), not stored; `batchMarkers()` reads it back.
- `claimNext(session, route)` appends `delivery.claimed` (fsynced) **before** the caller produces any
  output. Its unlocked peek (`peekQueue`) returns at once when the journal never had a `batch.created`
  and never parses `activity` lines — PostToolUse runs it on every tool call (~44–50 ms per hook
  including bun start, flat up to 5,000 journal lines). `settle` records `transport_sent | failed | uncertain`.
- `queueHead` per run: an unsettled or `uncertain` attempt holds the queue; `failed` (nothing written)
  makes the batch eligible again; only `batch.retry` (explicit human Retry) moves past uncertain.
  Pauses go before sends; otherwise FIFO. Batches of an older run wait for a retarget; batches acked
  `seen` via the inbox are never delivered again.
- **Pause (D18):** delivered only mid-turn (PostToolUse). At a Stop or idle claim it is cancelled as
  moot (`batch.cancelled{by:"auto"}`), and a UserPromptSubmit without a marker (the human typed a prompt)
  moots a queued one too. A pause that went out or was mooted **parks** the sends queued before it
  (`hold … reason:"paused"`); the human's next Send releases them in order. A human-cancelled pause parks nothing.
- **Cancel / retarget (human):** cancel = `batch.cancelled{by:"human"}`, only for a `queued` batch (any
  run); its item actions drop out of the items' `human` lists (they never went out). Retarget = one
  transaction: cancel the earlier run's queued **send** + a new `batch.created` on the current run
  (client `batch_id`, fresh action ids, `createBatch`'s revision checks — stale → `CONFLICT`, nothing
  written); it joins the back of the FIFO. A Pause for an earlier run can only be cancelled.
- **Status** (`batchStatus`) counts only the attempt claimed after the latest Retry. A
  `delivery.corroborated` (UserPromptSubmit saw the marker) newer than that attempt upgrades
  attempting/uncertain to `transport_sent` — the prompt proves the typed submit went in.
- **Retry** (`retryBatch`, `retryable`): an uncertain attempt; an unsettled one whose claimer the caller
  found dead (the daemon checks PID + start time → shown as *orphaned*); a sent batch the model hasn't
  marked seen for 2 min (`UNSEEN_RETRY_MS`). Current run only. It may duplicate transport; nothing retries itself.
- Proven by `test/delivery.test.ts` (6 processes × 40 batches, zero duplicate claims) and the hook
  routes in `test/hooks.test.ts`; the idle route in `test/idle-worker.test.ts` (see
  [daemon-and-ui.md](daemon-and-ui.md)).

## Verified live (2026-09-28, Claude Code 2.1.283, haiku, `-p`, observed)

The contract reached the model, it ToolSearched the deferred tool, called `foreman_brief` with its
target without a permission prompt (`--allowedTools=` form), and `brief.set` landed in the journal.
The sidecar runs on the SDK's `serveStdio`, which answers both the classic `initialize` handshake
(it echoes the client's version, e.g. 2025-06-18 in `test/mcp.test.ts`) and the stateless
2026-07-28 `server/discover` (SDK probe; `server.connect()` would miss the latter). stdin EOF ends it.
