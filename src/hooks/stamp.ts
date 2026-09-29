// PreToolUse on a Foreman MCP tool: the hook — not the model — says which session is calling.
// Claude hands the hook its own session_id, so the current run's target is stamped onto the call
// via `updatedInput` and the model never types one; subagents (agent_id present) are refused.
// The handler still checks the stamped target against the journal under the lock (a stale
// manifest yields STALE_TARGET, never a misroute). Verified live: scripts/spike/gate7-target-stamp.ts.
import { qualifiedTool } from "../shared/protocol";
import { lookupNative, readManifest } from "../shared/store";

const FOREMAN_TOOL = qualifiedTool("");

const decide = (permissionDecision: "allow" | "deny", extra: Record<string, unknown>) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, ...extra },
});

/** The hook output for a Foreman tool call; null when the tool isn't Foreman's (say nothing). */
export function stampTarget(input: any): object | null {
  if (typeof input?.tool_name !== "string" || !input.tool_name.startsWith(FOREMAN_TOOL)) return null;
  if (input.agent_id != null) {
    return decide("deny", { permissionDecisionReason: "Foreman tools are for the main agent only. Report back to it instead." });
  }
  const session = typeof input.session_id === "string" ? lookupNative("claude", input.session_id.trim()) : null;
  const target = session ? readManifest(session)?.target : null;
  if (!target) {
    return decide("deny", { permissionDecisionReason: "Foreman is not tracking this session (it did not register at start), so its tools are unavailable. Carry on without them." });
  }
  const args = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  return decide("allow", { updatedInput: { ...args, target } });
}
