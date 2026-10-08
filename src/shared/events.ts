// Session journal event schemas. The same definitions validate writes (hooks, CLI, daemon)
// and replay (daemon projection), so a record that was accepted can always be read back.
import { z } from "zod";
import { AckOutcome, AckState, BatchAction, BriefInput, HandoverInput, ID, MAX_BATCH_ACTIONS, MAX_BATCH_TEXT_BYTES, MAX_WRITABLE, ProgressInput, ResolveOutcome, StoredItem, UUID } from "./protocol";

const JOURNAL_VERSION = 1;

const Source = z.enum(["hook", "mcp", "cli", "daemon"]);
export type Source = z.infer<typeof Source>;

const uuid = z.uuid();
const str = (n: number) => z.string().min(1).max(n);

export const RunSource = z.enum(["startup", "resume", "clear", "compact", "fork", "unknown"]);

/** Hook names we record as passive activity. General tool arguments/outputs are never stored. */
export const ActivityHook = z.enum([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
]);
export type ActivityHook = z.infer<typeof ActivityHook>;

const payloads = {
  "session.created": z.strictObject({
    vendor: z.literal("claude"),
    native_id: str(128),
    project: str(4096),
    cwd: str(4096),
  }),
  "run.started": z.strictObject({
    target: uuid,
    source: RunSource,
    mode: z.enum(["managed", "observed"]),
    terminal_id: uuid.nullable(),
    launch_id: uuid.nullable(),
    model: str(200).nullable(),
    transcript_path: str(4096).nullable(),
    claude_pid: z.int().positive().nullable(),
    claude_start: str(64).nullable(),
  }),
  // Compaction keeps the run and its target; recorded so the contract re-injection is visible.
  "run.compacted": z.strictObject({ target: uuid }),
  "run.ended": z.strictObject({
    reason: str(200),
    via: z.enum(["hook", "ptyd", "daemon"]),
    exit_code: z.int().nullable(),
    signal: str(32).nullable(),
  }),
  activity: z.strictObject({
    hook: ActivityHook,
    tool: str(200).nullable(),
    // Touched paths for file tools only (names/paths/counts policy — no bodies).
    paths: z.array(str(4096)).max(8),
    notification: str(64).nullable(),
    // Short factual label, e.g. StopFailure error type. Never prompt or tool content.
    detail: str(200).nullable(),
    agent_id: str(128).nullable(),
  }),

  // ---- declared work (MCP / CLI, source "mcp" | "cli") ----
  "brief.set": BriefInput.omit({ target: true, request_id: true }),
  "progress.set": ProgressInput.omit({ target: true, request_id: true }),
  "item.put": StoredItem,
  // Agent resolutions use the §8.2 outcomes; human-side closures (an applied answer / accepted
  // offer / acknowledged ship, via the agent's acted ack) use the rest.
  "item.resolved": z.strictObject({
    id: ID,
    revision: z.int().min(1),
    outcome: z.union([ResolveOutcome, z.enum(["answered", "accepted", "declined", "acknowledged"])]),
    reason: str(280).nullable(),
    superseded_by: ID.nullable(),
  }),
  /** The human marked this decision revision reviewed (a local review, no agent steer). */
  "item.reviewed": z.strictObject({ id: ID, revision: z.int().min(1) }),
  "handover.set": HandoverInput.omit({ target: true, request_id: true }),
  /**
   * The session's page (foreman_page): realpath of an .html file, or null = unmounted. `writable`:
   * what the page may save itself, relative to its folder (absent in P1 journals = none).
   */
  "page.set": z.strictObject({ path: str(4096).nullable(), title: str(80).nullable(), writable: z.array(str(512)).max(MAX_WRITABLE).optional() }),

  // ---- human batches and their delivery (§9) ----
  "batch.created": z.strictObject({
    batch_id: uuid,
    /** The run it was sent to; a different current run needs an explicit retarget (§6.2). */
    run: uuid,
    kind: z.enum(["send", "pause"]),
    actions: z.array(BatchAction).min(1).max(MAX_BATCH_ACTIONS),
    text: z.string().min(1).refine((t) => Buffer.byteLength(t) <= MAX_BATCH_TEXT_BYTES, "batch text too large"),
    /** `page`: a tell from the session's page (sent without the tray); absent = the send tray / Pause. */
    via: z.literal("page").optional(),
  }),
  /** Explicit human retry of an uncertain delivery: the head batch becomes claimable again. */
  "batch.retry": z.strictObject({ batch_id: uuid }),
  /** `by: "auto"` = a pause made moot (session already idle / human typed a prompt); absent = human. */
  "batch.cancelled": z.strictObject({ batch_id: uuid, reason: str(200), by: z.enum(["human", "auto"]).optional() }),
  /** Appended (fsynced) BEFORE any output: an unsettled claim holds the queue. */
  "delivery.claimed": z.strictObject({
    batch_id: uuid,
    attempt_id: uuid,
    route: z.enum(["post_tool_use", "stop", "idle_submit"]),
    claimer_pid: z.int().positive(),
    claimer_start: str(64).nullable(),
  }),
  "delivery.settled": z.strictObject({
    batch_id: uuid,
    attempt_id: uuid,
    /** transport_sent = handed to the hook output / typed and started a turn. Never "model saw it". */
    outcome: z.enum(["transport_sent", "failed", "uncertain"]),
    detail: str(300).nullable(),
  }),
  /** UserPromptSubmit carried the batch marker: corroborates an idle submit (transport, not seen). */
  "delivery.corroborated": z.strictObject({ batch_id: uuid, via: z.literal("user_prompt_submit") }),
  /** Model receipts from foreman_inbox acks. */
  "batch.acked": z.strictObject({
    batch_id: UUID,
    state: AckState,
    action_ids: z.array(UUID).max(MAX_BATCH_ACTIONS),
    outcome: AckOutcome.nullable(),
    note: str(280).nullable(),
  }),
} as const;

export type EventType = keyof typeof payloads;
export type Payload<T extends EventType> = z.infer<(typeof payloads)[T]>;

const Envelope = z.strictObject({
  v: z.literal(JOURNAL_VERSION),
  id: uuid,
  seq: z.int().positive(),
  ts: z.iso.datetime(),
  session: uuid,
  run: uuid.nullable(),
  source: Source,
  type: str(64),
  payload: z.unknown(),
  request_id: UUID.optional(),
  // Hash of the caller's input for `transact` idempotency (a replay must be the same call).
  request_hash: z.string().max(128).optional(),
});
export type Envelope = z.infer<typeof Envelope>;

export function validatePayload(type: string, payload: unknown): unknown {
  const schema = (payloads as Record<string, z.ZodType>)[type];
  if (!schema) throw new Error(`unknown event type: ${type}`);
  return schema.parse(payload);
}

/** Parse a stored event. Unknown types from the same journal version are kept, not dropped. */
export function parseEvent(raw: unknown): Envelope {
  const env = Envelope.parse(raw);
  const schema = (payloads as Record<string, z.ZodType>)[env.type];
  if (schema) env.payload = schema.parse(env.payload);
  return env;
}
