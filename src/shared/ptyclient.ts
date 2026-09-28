// Client for the ptyd socket (used by the CLI and the daemon). One request/response map plus a
// push listener list; writes go through an Outbox so partial socket writes are never lost.
import type { Socket } from "bun";
import { paths } from "./paths";
import { encodeFrame, FrameReader, PTY_PROTOCOL, type PtyErrorCode, type Push, type Request } from "./ptyproto";

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
export type RequestBody = DistributiveOmit<Request, "v" | "id">;

export class PtyError extends Error {
  constructor(
    public code: PtyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const enc = new TextEncoder();

/**
 * Buffered writer over a Bun socket. `send` never blocks: bytes the kernel doesn't take now are
 * queued and flushed on `drain`. `exempt` bytes (snapshots, replays) don't count toward the
 * slow-consumer limit that ptyd enforces with `liveBytes`.
 */
export class Outbox {
  private queue: { bytes: Uint8Array; exempt: boolean }[] = [];
  private headOffset = 0;
  queuedBytes = 0;
  exemptBytes = 0;

  constructor(private socket: Socket<any>) {}

  get liveBytes(): number {
    return this.queuedBytes - this.exemptBytes;
  }

  send(frame: unknown, exempt = false): void {
    const bytes = enc.encode(encodeFrame(frame));
    this.queue.push({ bytes, exempt });
    this.queuedBytes += bytes.length;
    if (exempt) this.exemptBytes += bytes.length;
    if (this.queue.length === 1) this.flush();
  }

  /** Drop queued frames that haven't started writing (keeps the partially written head intact). */
  dropUnstarted(): void {
    const keep = this.headOffset > 0 ? 1 : 0;
    for (const e of this.queue.splice(keep)) {
      this.queuedBytes -= e.bytes.length;
      if (e.exempt) this.exemptBytes -= e.bytes.length;
    }
  }

  flush(): void {
    while (this.queue.length) {
      const head = this.queue[0]!;
      const rest = head.bytes.subarray(this.headOffset);
      let n: number;
      try {
        n = this.socket.write(rest);
      } catch {
        return;
      }
      if (n <= 0) return;
      this.headOffset += n;
      if (this.headOffset < head.bytes.length) return;
      this.queue.shift();
      this.headOffset = 0;
      this.queuedBytes -= head.bytes.length;
      if (head.exempt) this.exemptBytes -= head.bytes.length;
    }
  }
}

export class PtyClient {
  private socket!: Socket<undefined>;
  private outbox!: Outbox;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private pushListeners = new Set<(p: Push) => void>();
  private closeListeners: ((err?: Error) => void)[] = [];
  private closed = false;
  hello: { protocol: number; stream_epoch: string; pid: number } | null = null;

  private constructor() {}

  static async connect(opts: { client: "cli" | "daemon"; socket?: string }): Promise<PtyClient> {
    const c = new PtyClient();
    const reader = new FrameReader(
      (f) => c.onFrame(f),
      (e) => c.fail(e),
    );
    c.socket = await Bun.connect({
      unix: opts.socket ?? paths.ptydSock(),
      socket: {
        data: (_s, d) => reader.push(d),
        drain: () => c.outbox.flush(),
        close: () => c.fail(),
        error: (_s, e) => c.fail(e),
      },
    });
    c.outbox = new Outbox(c.socket);
    try {
      c.hello = await c.request({ op: "hello", client: opts.client });
    } catch (e) {
      c.close();
      throw e;
    }
    return c;
  }

  request<T = any>(req: RequestBody): Promise<T> {
    if (this.closed) return Promise.reject(new PtyError("RESYNC_REQUIRED", "ptyd connection closed"));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.outbox.send({ v: PTY_PROTOCOL, id, ...req });
    });
  }

  onPush(cb: (p: Push) => void): () => void {
    this.pushListeners.add(cb);
    return () => this.pushListeners.delete(cb);
  }

  onClose(cb: (err?: Error) => void): void {
    if (this.closed) cb();
    else this.closeListeners.push(cb);
  }

  close(): void {
    try {
      this.socket?.end();
    } catch {}
    this.fail();
  }

  private onFrame(f: any): void {
    if (f && typeof f.id === "string" && "ok" in f) {
      const p = this.pending.get(f.id);
      if (!p) return;
      this.pending.delete(f.id);
      if (f.ok) p.resolve(f.result);
      else p.reject(new PtyError(f.error?.code ?? "BAD_REQUEST", f.error?.message ?? "error"));
      return;
    }
    if (f && typeof f.event === "string") for (const l of this.pushListeners) l(f as Push);
  }

  private fail(err?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new PtyError("RESYNC_REQUIRED", err?.message ?? "ptyd connection closed"));
    this.pending.clear();
    for (const l of this.closeListeners) l(err);
    this.closeListeners = [];
  }
}
