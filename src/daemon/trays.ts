// Send trays (plan §9.1): per session, the human's staged actions — persisted, revisioned, and
// turned into one immutable batch only by an explicit Send. They live in `~/.foreman/ui/events.jsonl`
// (not the SQLite projection, which is disposable): each `tray.set` is the whole tray at a new
// revision. A Send first commits `batch.created` durably in the session journal, then clears exactly
// the sent actions; if the daemon dies in between, any staged action whose id is already in a batch
// is recognised as sent and dropped (reconcile), so nothing is sent twice from a tray.
import { statSync } from "node:fs";
import { z } from "zod";
import type { TrayAction, TrayView } from "../shared/api";
import { createBatch, renderAction, renderBatch, staleReason } from "../shared/delivery";
import { Journal, type Stored } from "../shared/journal";
import { ensureDir, paths } from "../shared/paths";
import { BatchAction, MAX_BATCH_ACTIONS, MAX_BATCH_TEXT_BYTES, ToolError, validationError } from "../shared/protocol";
import type { JournalState } from "../shared/reducer";
import { LOCK_TIMEOUT } from "../shared/store";
import type { WorkState } from "../shared/work";

const TraySet = z.strictObject({
  revision: z.int().min(1),
  batch_id: z.uuid().nullable(),
  actions: z.array(BatchAction).max(MAX_BATCH_ACTIONS),
  /** Set when this revision is the clear after a Send of that batch. */
  sent_batch: z.uuid().nullable(),
});
type TraySet = z.infer<typeof TraySet>;

interface Tray {
  revision: number;
  batch_id: string | null;
  actions: TrayAction[];
}

const EMPTY: Tray = { revision: 0, batch_id: null, actions: [] };

function fold(events: Stored[]): Map<string, Tray> {
  const trays = new Map<string, Tray>();
  for (const e of events) {
    if (e.type !== "tray.set" || typeof e.session !== "string") continue;
    const p = TraySet.parse(e.payload);
    trays.set(e.session, { revision: p.revision, batch_id: p.batch_id, actions: p.actions as TrayAction[] });
  }
  return trays;
}

const sentIds = (w: WorkState) => new Set(w.batch_order.flatMap((id) => w.batches[id]!.actions.map((a) => a.action_id)));

/** The tray minus anything a committed batch already carries (a Send that crashed before its clear). */
function reconciled(t: Tray, w: WorkState): Tray {
  const sent = sentIds(w);
  const actions = t.actions.filter((a) => !sent.has(a.action_id));
  const consumed = t.batch_id !== null && w.batches[t.batch_id] !== undefined;
  if (actions.length === t.actions.length && !consumed) return t;
  return { revision: t.revision, batch_id: actions.length ? (consumed ? crypto.randomUUID() : t.batch_id) : null, actions };
}

function parseTrayActions(raw: unknown): TrayAction[] {
  if (!Array.isArray(raw)) throw new ToolError("VALIDATION", "actions must be an array", "actions");
  if (raw.length > MAX_BATCH_ACTIONS) throw new ToolError("LIMIT", `a tray holds at most ${MAX_BATCH_ACTIONS} actions`);
  const items = new Set<string>();
  const ids = new Set<string>();
  return raw.map((a, i) => {
    const r = BatchAction.safeParse(a);
    if (!r.success) {
      const e = validationError(r.error);
      throw new ToolError("VALIDATION", `actions.${i}: ${e.message}`, `actions.${i}`);
    }
    const act = r.data;
    if (act.type === "pause") throw new ToolError("VALIDATION", "Pause is sent directly, never staged", `actions.${i}`);
    if (ids.has(act.action_id)) throw new ToolError("VALIDATION", `duplicate action_id ${act.action_id}`, `actions.${i}`);
    ids.add(act.action_id);
    // Editing an item replaces its staged action (§9.1): one staged action per item.
    if ("item_id" in act) {
      if (items.has(act.item_id)) throw new ToolError("VALIDATION", `item ${act.item_id} is staged twice; replace its action instead`, `actions.${i}`);
      items.add(act.item_id);
    }
    return act;
  });
}

export class Trays {
  private journal = new Journal(paths.uiJournal(), paths.uiLock());

  /** Folded trays, re-read only when the file changed (hub recomputes call this on every change). */
  private cache: { size: number; mtime: number; trays: Map<string, Tray> } | null = null;

  private read(): Map<string, Tray> {
    ensureDir(paths.ui());
    const st = statSync(paths.uiJournal(), { throwIfNoEntry: false });
    const size = st?.size ?? 0;
    const mtime = st?.mtimeMs ?? 0;
    if (this.cache?.size === size && this.cache.mtime === mtime) return this.cache.trays;
    const trays = fold(this.journal.readAll());
    this.cache = { size, mtime, trays };
    return trays;
  }

  /** Read-decide-append under the UI journal's lock; `decide` returns the next tray or null (no change). */
  private update(session: string, decide: (t: Tray) => (Tray & { sent_batch?: string }) | null): Tray {
    ensureDir(paths.ui());
    const tx = this.journal.transact(
      (events) => {
        const cur = fold(events).get(session) ?? EMPTY;
        const next = decide(cur);
        if (!next) return { drafts: [], result: cur };
        const payload: TraySet = TraySet.parse({ revision: cur.revision + 1, batch_id: next.batch_id, actions: next.actions, sent_batch: next.sent_batch ?? null });
        return { drafts: [{ type: "tray.set", payload, fields: { session, source: "daemon" } }], result: { revision: payload.revision, batch_id: payload.batch_id, actions: next.actions } };
      },
      { lockTimeoutMs: LOCK_TIMEOUT.mutation, durable: true },
    );
    return tx.result!;
  }

  /** Staged-action counts for the unsent badges, reconciled against each session's batches. */
  unsent(states: JournalState[]): Map<string, number> {
    const trays = this.read();
    const out = new Map<string, number>();
    for (const s of states) {
      const t = trays.get(s.session);
      if (t?.actions.length) out.set(s.session, reconciled(t, s.work).actions.length);
    }
    return out;
  }

  /** Replace the tray at `expectedRevision` (stale → CONFLICT). Staging never sends. */
  // reached through the server's Deps (fallow can't see it)
  // fallow-ignore-next-line unused-class-member
  put(s: JournalState, expectedRevision: number, rawActions: unknown): TrayView {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new ToolError("VALIDATION", "expected_revision must be a nonnegative integer", "expected_revision");
    const actions = parseTrayActions(rawActions);
    const sent = sentIds(s.work);
    const dup = actions.find((a) => sent.has(a.action_id));
    if (dup) throw new ToolError("CONFLICT", `action ${dup.action_id} was already sent; stage a new one`, "actions");
    const bytes = actions.length ? Buffer.byteLength(renderBatch(actions, s.work)) : 0;
    if (bytes > MAX_BATCH_TEXT_BYTES) throw new ToolError("LIMIT", `the tray would render to ${bytes} bytes; a batch holds at most ${MAX_BATCH_TEXT_BYTES}`);
    this.current(s);
    const t = this.update(s.session, (cur) => {
      if (cur.revision !== expectedRevision) throw new ToolError("CONFLICT", `the tray changed (now revision ${cur.revision}); reload it and stage again`, "expected_revision");
      return { batch_id: actions.length ? (cur.batch_id ?? crypto.randomUUID()) : null, revision: 0, actions };
    });
    return trayView(t, s);
  }

  /**
   * Send the tray as batch `batchId` (§9.1): freeze it with `createBatch` (durable), then clear the
   * sent actions. A retry of a Send that already committed only finishes the clear.
   */
  // reached through the server's Deps (fallow can't see it)
  // fallow-ignore-next-line unused-class-member
  send(s: JournalState, batchId: string, trayRevision: number): { batch_id: string; replayed: boolean } {
    const committed = s.work.batches[batchId];
    if (!committed) {
      const t = this.current(s);
      if (t.revision !== trayRevision) throw new ToolError("CONFLICT", `the tray changed (now revision ${t.revision}); review it and send again`, "tray_revision");
      if (!t.actions.length) throw new ToolError("VALIDATION", "nothing is staged");
      if (t.batch_id !== batchId) throw new ToolError("CONFLICT", "this tray is being sent under another batch id; reload it", "batch_id");
      if (!s.run) throw new ToolError("STALE_TARGET", "the session has no run to send to");
      createBatch(s.session, { batch_id: batchId, run: s.run, kind: "send", actions: t.actions });
    }
    this.clearSent(s.session, batchId);
    return { batch_id: batchId, replayed: !!committed };
  }

  /** After `batchId` is durable: drop its actions from the tray; anything staged since stays. */
  private clearSent(session: string, batchId: string): void {
    const batch = new Journal(paths.sessionJournal(session), paths.sessionLock(session)).readAll().find((e) => e.type === "batch.created" && (e.payload as any).batch_id === batchId);
    const ids = new Set(((batch?.payload as any)?.actions ?? []).map((a: BatchAction) => a.action_id));
    this.update(session, (cur) => {
      const actions = cur.actions.filter((a) => !ids.has(a.action_id));
      if (actions.length === cur.actions.length && cur.batch_id !== batchId) return null;
      const batch_id = actions.length ? (cur.batch_id === batchId ? crypto.randomUUID() : cur.batch_id) : null;
      return { revision: 0, batch_id, actions, sent_batch: batchId };
    });
  }

  // reached through the server's Deps (fallow can't see it)
  // fallow-ignore-next-line unused-class-member
  view(s: JournalState): TrayView {
    return trayView(this.current(s), s);
  }

  /** The tray, with a crashed Send's leftovers (actions already in a batch) cleared durably first. */
  private current(s: JournalState): Tray {
    const raw = this.read().get(s.session) ?? EMPTY;
    if (reconciled(raw, s.work) === raw) return raw;
    return this.update(s.session, (cur) => {
      const r = reconciled(cur, s.work);
      return r === cur ? null : { ...r, revision: 0 };
    });
  }
}

function trayView(t: Tray, s: JournalState): TrayView {
  const actions = t.actions.map((a) => ({ action: a, label: renderAction(a, s.work), conflict: staleReason(a, s.work) }));
  const preview = t.actions.length ? renderBatch(t.actions, s.work) : null;
  const conflicts = actions.filter((a) => a.conflict).length;
  let blocked: string | null = null;
  if (!t.actions.length) blocked = "Nothing staged.";
  else if (conflicts) blocked = `${conflicts} staged action${conflicts === 1 ? "" : "s"} no longer match${conflicts === 1 ? "es" : ""} the card; remove or restage ${conflicts === 1 ? "it" : "them"}.`;
  else if (!s.run || s.state === "dead") blocked = "The session has ended; there is no run to send to.";
  return { revision: t.revision, batch_id: t.batch_id, actions, preview, preview_bytes: preview ? Buffer.byteLength(preview) : 0, blocked };
}
