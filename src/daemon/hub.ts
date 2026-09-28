// Owns the current SessionView set and the SSE event log. Any evidence change (journal fold,
// ptyd terminal push, registry poll, staleness tick) recomputes views; only real diffs are
// streamed. SSE ids are `<epoch>:<cursor>`; a reconnect inside the retained window replays,
// anything else gets `resync_required` and refetches the snapshot.
import type { SessionView, StreamEvent } from "../shared/api";
import { readNativeRegistry, type NativeRow } from "../shared/native";
import { projectRoot } from "../shared/project";
import type { IdleWorker } from "./idle-worker";
import type { Projection } from "./projection";
import type { StopControl } from "./stopper";
import type { Trays } from "./trays";
import type { PtydLink } from "./terminals";
import { registryOnlyView, sessionView } from "./view";

const RING = 1000;
const REGISTRY_POLL_MS = 2000;
const TICK_MS = 30_000;

export class Hub {
  readonly epoch = crypto.randomUUID();
  private cursor = 0;
  private ring: { cursor: number; event: StreamEvent }[] = [];
  private subscribers = new Set<(cursor: number, e: StreamEvent) => void>();
  private views = new Map<string, SessionView>();
  private viewJson = new Map<string, string>();
  private native = new Map<string, NativeRow>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private recomputeQueued = false;

  constructor(
    private projection: Projection,
    private ptyd: PtydLink,
    private worker: IdleWorker | null = null,
    private trays: Trays | null = null,
    private stops: StopControl | null = null,
  ) {}

  start(): void {
    this.pollRegistry();
    this.recompute();
    this.projection.onChange(() => this.recompute());
    this.ptyd.onChange((t) => {
      if (t) this.publish({ type: "terminal", terminal: t });
      this.recompute();
    });
    // Worker reason changes can fire from inside recompute (via poke): coalesce, don't re-enter.
    this.worker?.onChange(() => {
      if (this.recomputeQueued) return;
      this.recomputeQueued = true;
      queueMicrotask(() => {
        this.recomputeQueued = false;
        this.recompute();
      });
    });
    this.timers.push(setInterval(() => this.pollRegistry(true), REGISTRY_POLL_MS));
    this.timers.push(setInterval(() => this.recompute(), TICK_MS));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
  }

  snapshot(): { epoch: string; cursor: number; sessions: SessionView[] } {
    return { epoch: this.epoch, cursor: this.cursor, sessions: [...this.views.values()] };
  }

  view(id: string): SessionView | null {
    return this.views.get(id) ?? null;
  }

  private pollRegistry(recompute = false): void {
    let rows: NativeRow[] = [];
    try {
      rows = readNativeRegistry();
    } catch {
      return; // registry unreadable: keep last known rows rather than declaring everything dead
    }
    const next = new Map(rows.map((r) => [r.session_id, r]));
    const changed = JSON.stringify([...next]) !== JSON.stringify([...this.native]);
    this.native = next;
    if (recompute && changed) this.recompute();
  }

  recompute(): void {
    const states = this.projection.states();
    const next = new Map<string, SessionView>();
    const known = new Set<string>();
    let unsent = new Map<string, number>();
    try {
      unsent = this.trays?.unsent(states) ?? unsent;
    } catch (e) {
      console.error(`trays unreadable: ${(e as Error).message}`); // badges only; never block the views
    }
    for (const s of states) {
      known.add(s.native_id);
      const extra = { workerReason: this.worker?.reason(s.session) ?? null, unsent: unsent.get(s.session) ?? 0, stop: this.stops?.view(s.session) ?? null };
      next.set(s.session, sessionView(s, this.ptyd.terminals, this.native, this.ptyd.up, extra));
    }
    for (const row of this.native.values()) {
      if (known.has(row.session_id) || row.live !== "alive") continue; // a leftover file is not a session
      const v = registryOnlyView(row, projectRoot(row.cwd));
      next.set(v.id, v);
    }
    for (const [id, v] of next) {
      const json = JSON.stringify(v);
      if (this.viewJson.get(id) === json) continue;
      this.viewJson.set(id, json);
      this.publish({ type: "session", session: v });
    }
    for (const id of this.views.keys()) {
      if (next.has(id)) continue;
      this.viewJson.delete(id);
      this.publish({ type: "session_removed", id });
    }
    this.views = next;
    void this.ptyd.syncBindings(states);
    this.worker?.poke();
  }

  private publish(event: StreamEvent): void {
    const cursor = ++this.cursor;
    this.ring.push({ cursor, event });
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
    for (const s of this.subscribers) s(cursor, event);
  }

  /** Subscribe from a Last-Event-ID. Returns the replay (or null = resync needed) and an unsubscribe. */
  subscribe(lastEventId: string | null, cb: (cursor: number, e: StreamEvent) => void): { replay: { cursor: number; event: StreamEvent }[] | null; close: () => void } {
    let replay: { cursor: number; event: StreamEvent }[] | null = [];
    if (lastEventId) {
      const [epoch, c] = lastEventId.split(":");
      const after = Number(c);
      const oldest = this.ring[0]?.cursor ?? this.cursor + 1;
      if (epoch !== this.epoch || !Number.isInteger(after) || after > this.cursor || after < oldest - 1) replay = null;
      else replay = this.ring.filter((r) => r.cursor > after);
    }
    this.subscribers.add(cb);
    return { replay, close: () => this.subscribers.delete(cb) };
  }
}
