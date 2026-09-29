# Claude plugin and hooks

The Claude-side half of Foreman: a plugin whose hooks register sessions and record passive
activity into the session journals. Open this when touching `plugin/`, `src/hooks/`, or when a
Claude Code upgrade changes hook payloads.

## Where it lives

| File | Role |
|---|---|
| `plugin/.claude-plugin/plugin.json` | Plugin manifest (`foreman`, MIT). The MCP sidecar (`.mcp.json`, `bin/foreman-mcp`) and the `foreman` skill are covered in [protocol.md](protocol.md). |
| `plugin/hooks/hooks.json` | 12 hooks → `${CLAUDE_PLUGIN_ROOT}/bin/foreman-hook <Event>`, 2–5 s timeouts. |
| `plugin/bin/foreman-hook` | sh shim: finds bun even under launchd's PATH, runs `plugin/dist/hook.js`; exits 0 if either is missing. |
| `plugin/dist/hook.js` | Bundle of `src/hooks/main.ts` — **build with `bun run build:plugin`**; gitignored. |
| `src/hooks/main.ts` | Entrypoint: always exits 0; SessionStart/End → `registration.ts` (SessionStart then prints the Foreman contract); PreToolUse on a Foreman tool → `stamp.ts`; others → one `activity` event, then the delivery duty below. |
| `src/hooks/stamp.ts` | Stamps the caller's current `target` onto Foreman MCP calls (`updatedInput`), denies subagents and unregistered sessions — see [protocol.md](protocol.md). |
| `.claude-plugin/marketplace.json` | Local marketplace pointing at `./plugin`, for a later user-scoped install (not installed). |
| `scripts/spike/plugin/` | Phase-0 **spike** copy named `foreman`: the real hooks + delivery probe hooks (`spike-hook.ts`), a no-SDK stdio MCP server (`mcp.ts`) and a `foreman` skill. Throwaway evidence, not the product plugin. |

## Rules

- Hooks print only deliberate protocol context: SessionStart's `additionalContext` contract (see
  [protocol.md](protocol.md)), `{"systemMessage": "Foreman unavailable: …"}` on registration failure
  (shown to the user, not the model), one human batch (below), or PreToolUse's target stamp / refusal
  on a `mcp__plugin_foreman_foreman__*` call (nothing for any other tool).
- **Delivery routes:** PostToolUse and PostToolUseFailure (route `post_tool_use`) and Stop (route
  `stop`): `claimNext` (fsynced) → print `hookSpecificOutput{hookEventName: <this event>,
  additionalContext: hookContext(...)}` via `Bun.write` → `settle(transport_sent)`; a failed write
  settles `uncertain`. Never when `agent_id` is present (a subagent must not get its parent's batches);
  Stop only when `stop_hook_active === false` (strict: a missing field never continues). Empty or
  held queue → no output at all. A pause at the head of a Stop claim is mooted, not delivered
  (queue rules: [protocol.md](protocol.md)).
- **UserPromptSubmit** reads the prompt only for `[foreman batch <id>]` markers → `delivery.corroborated`
  (ids of this session's batches only); a prompt without a marker moots a queued pause. The prompt is never stored.
- Stored fields are names, paths and counts only: tool name, file paths for Read/Edit/Write/
  MultiEdit/NotebookEdit, notification type, StopFailure `error`, `agent_id`. Never prompts,
  tool inputs/outputs or messages. `FOREMAN_HOOK_DEBUG=1` logs field *names* only.
- Sessions not registered (plugin loaded mid-run) are ignored, never guessed.
- Managed launches pass `--plugin-dir <repo>/plugin` unless a user-scoped `foreman` plugin is
  installed (`pluginInstalledForUser()`), so it's never loaded twice.

## Verified hook facts (Claude Code 2.1.283)

- Hooks fire in `-p` mode too (smoke: session.created → run.started → prompt/tool/Stop → run.ended).
- SessionStart often has **no `model`**; the daemon falls back to `--model` from the managed launch argv.
- `source` ∈ startup|resume|clear|compact|fork. SessionEnd `reason` ∈ clear|resume|logout|prompt_input_exit|other.
- `agent_id` is present only inside subagents (key subagent detection on it, not `agent_type`).
- Notification types used: `permission_prompt`, `idle_prompt`, `elicitation_dialog`, `elicitation_url_dialog`.
- Not yet observed live (docs + fixtures only): Notification, StopFailure, SubagentStart.
- PermissionRequest fires live when a dialog opens (keys include `tool_name`, `tool_input`,
  `permission_suggestions`); it also fires in `-p` mode, where the tool is then denied.
- Stop input carries `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`.
- `/clear` and `/resume` end the old run via SessionEnd before the new SessionStart — see
  [storage-and-identity.md](storage-and-identity.md) (identity model).

## Verified for phase 2 delivery and identity (2026-09-28, Claude Code 2.1.283, haiku)

Evidence scripts in `scripts/spike/` (`gate2-midturn.ts`, `gate3-identity.ts`, `gate4-observed.ts`).
SessionStart context and PostToolUse/PostToolUseFailure/Stop delivery are in product use (routes above).

**Product delivery verified live (2026-09-28, haiku, `scripts/phase2-delivery-demo.ts`, 6/6):**
PostToolUse and **PostToolUseFailure** `additionalContext` reach the running turn; Stop continues once
(2 Stops, the second claims nothing); an empty queue gives one Stop; the idle worker's typed batch is
corroborated by UserPromptSubmit; a mid-turn Pause stopped haiku after 1 of 3 planned reads and the
send queued before it stayed parked. Haiku acked every delivered batch through `foreman_inbox` (acted).
A cwd Claude hasn't trusted yet opens the folder-trust dialog **before** SessionStart (no hook
fires); accepting writes Claude's own config, so live demos run in the (trusted) repo.

- **PostToolUse** `hookSpecificOutput.additionalContext` reaches the model inside the running turn
  (transcript: a `hook_additional_context` attachment). Works for observed sessions too.
- **Stop** `hookSpecificOutput.additionalContext` makes Claude continue the turn once; the next Stop
  arrives with `stop_hook_active: true` (return nothing then). With nothing queued: one Stop, no loop.
  `decision:"block"` + `reason` also works but is recorded as a user "Stop hook feedback" message plus
  a `hook_blocking_error` — use context; block is the fallback.
- **SessionStart** `additionalContext` reaches the model on `startup`, `compact`, `clear` and
  `resume` (in-TUI and process restart), in the TUI and in `-p`.
- **Namespaces:** plugin skill `foreman:foreman`; plugin MCP server `plugin:foreman:foreman`, tools
  `mcp__plugin_foreman_foreman__<tool>`. The tools are **deferred** (the model must ToolSearch them
  first) and **need permission** (manual mode prompts; `--allowedTools mcp__plugin_foreman_foreman__ping`
  pre-allows). The stdio sidecar inherits `FOREMAN_TERMINAL_ID` and **survives `/clear`** — it
  cannot know the current conversation by itself, which is why every call carries a `target`.
- **PreToolUse `updatedInput` works on plugin MCP tools** (2026-09-28, `gate7-target-stamp.ts`, 4/4):
  a field the tool doesn't advertise, added by the hook, reaches the server; `permissionDecision:
  allow` skips the permission prompt without `--allowedTools`; a subagent's call carries `agent_id`
  and a `deny` keeps it from the server (the subagent sees the reason).

## Cost

Median ~63 ms per passive hook through the shim (bun start ~10 ms, then loading the zod-heavy bundle
dominates); SessionStart ~65–85 ms warm, ~560 ms cold (git + ps). PostToolUse with delivery, bundle
run directly (no shim): ~44 ms on a fresh journal, ~50 ms at 5,000 journal lines with a delivered
batch — the empty-queue peek skips journals that never had a batch and never parses activity lines.
Consider lazy-importing the protocol modules if the bundle grows further.
