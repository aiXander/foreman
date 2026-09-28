// `foreman attach <terminal-id>`: put this terminal in raw mode and mirror a ptyd terminal.
// Prefix key Ctrl-]: then `d` detach, `t` take over control, Ctrl-] sends a literal Ctrl-].
// Detaching never sends anything into Claude, and the local terminal is always restored.
import { b64, type Push, type TerminalInfo } from "../../shared/ptyproto";
import { PtyClient, PtyError } from "../../shared/ptyclient";

const PREFIX = 0x1d; // Ctrl-]
const WRITE_CHUNK = 16 * 1024;
// Leave alt screen, show cursor, disable bracketed paste / mouse / focus / app cursor+keypad, reset SGR.
const RESTORE = "\x1b[?1049l\x1b[?25h\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?1l\x1b>\x1b[0m\r\n";

export async function resolveTerminalId(client: PtyClient, ref: string): Promise<string> {
  const { terminals } = await client.request<{ terminals: TerminalInfo[] }>({ op: "list" });
  const hits = terminals.filter((t) => t.terminal_id.startsWith(ref));
  if (hits.length === 1) return hits[0]!.terminal_id;
  throw new Error(hits.length ? `terminal id prefix ${ref} is ambiguous` : `no terminal ${ref}`);
}

function localSize(): { cols: number; rows: number } {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  return { cols: clamp(process.stdout.columns || 80, 20, 500), rows: clamp(process.stdout.rows || 24, 5, 200) };
}

export async function attachTerminal(client: PtyClient, terminalId: string): Promise<number> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("attach needs an interactive terminal");
  const viewerId = crypto.randomUUID();
  let writer: string | null = null;
  let replaying = true; // drop local terminal replies generated while a snapshot is painted
  let prefixPending = false;
  let finished = false;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => (resolveDone = r));
  const me = () => writer === viewerId;

  const title = () => stdout.write(me() ? "\x1b]0;foreman\x07" : "\x1b]0;foreman · read-only — Ctrl-] t to take over\x07");

  const finish = (code: number, message: string, detach: boolean) => {
    if (finished) return;
    finished = true;
    offPush();
    stdin.off("data", onInput);
    stdout.off("resize", onResize);
    try {
      stdin.setRawMode(false);
    } catch {}
    stdin.pause();
    stdout.write(RESTORE + `[foreman] ${message}\r\n`);
    if (detach) client.request({ op: "detach", terminal_id: terminalId, viewer_id: viewerId }).catch(() => {}).finally(() => client.close());
    else client.close();
    resolveDone(code);
  };

  const send = (data: Uint8Array) => {
    for (let o = 0; o < data.length; o += WRITE_CHUNK) {
      client
        .request({ op: "write", terminal_id: terminalId, viewer_id: viewerId, input_id: crypto.randomUUID(), data_b64: b64.encode(data.subarray(o, o + WRITE_CHUNK)) })
        .catch(() => {}); // NOT_WRITER after a takeover is reported via the control push
    }
  };

  const resizeToLocal = () => {
    const { cols, rows } = localSize();
    client.request({ op: "resize", terminal_id: terminalId, viewer_id: viewerId, cols, rows }).catch(() => {});
  };

  const control = async (action: "acquire" | "takeover") => {
    try {
      const r = await client.request<{ writer: string | null }>({ op: "control", terminal_id: terminalId, viewer_id: viewerId, action });
      writer = r.writer;
      if (me()) resizeToLocal();
    } catch {}
    title();
  };

  const onInput = (buf: Buffer) => {
    const pass: number[] = [];
    for (const byte of buf) {
      if (prefixPending) {
        prefixPending = false;
        if (byte === 0x64 /* d */) return finish(0, `detached from ${terminalId.slice(0, 8)} (reattach: foreman attach ${terminalId.slice(0, 8)})`, true);
        if (byte === 0x74 /* t */) void control("takeover");
        else if (byte === PREFIX) pass.push(PREFIX);
        continue;
      }
      if (byte === PREFIX) prefixPending = true;
      else pass.push(byte);
    }
    if (!pass.length || replaying) return;
    if (me()) send(new Uint8Array(pass));
    else stdout.write("\x07");
  };

  const onResize = () => {
    if (me()) resizeToLocal();
  };

  const reattach = () =>
    client
      .request({ op: "attach", terminal_id: terminalId, viewer_id: viewerId })
      .then(() => control("acquire"))
      .catch((e) => finish(1, `could not reattach: ${e.message}`, false));

  const offPush = client.onPush((p: Push) => {
    if ("terminal_id" in p && p.terminal_id !== terminalId) return;
    switch (p.event) {
      case "snapshot_begin":
        replaying = true;
        stdout.write("\x1bc"); // full reset before painting the snapshot
        break;
      case "snapshot_chunk":
        stdout.write(b64.decode(p.data_b64));
        break;
      case "snapshot_end":
        setTimeout(() => (replaying = false), 100);
        break;
      case "output":
        stdout.write(b64.decode(p.data_b64));
        break;
      case "control":
        writer = p.writer;
        title();
        break;
      case "exit":
        finish(0, `terminal exited (${p.signal ?? `code ${p.code}`})`, false);
        break;
      case "resync_required":
        if (p.viewer_id === viewerId) void reattach();
        break;
    }
  });
  client.onClose(() => finish(1, "lost connection to ptyd", false));
  for (const sig of ["SIGTERM", "SIGHUP"] as const) process.once(sig, () => finish(1, `received ${sig}`, true));
  process.once("exit", () => {
    try {
      stdin.setRawMode(false);
    } catch {}
  });

  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onInput);
  stdout.on("resize", onResize);

  try {
    const r = await client.request<{ terminal: TerminalInfo; mode: string }>({ op: "attach", terminal_id: terminalId, viewer_id: viewerId });
    if (r.terminal.state === "exited") replaying = false;
    else await control("acquire");
  } catch (e: any) {
    finish(1, e instanceof PtyError ? `${e.code}: ${e.message}` : String(e?.message ?? e), false);
  }
  return done;
}

export async function main(args: string[]): Promise<number> {
  const ref = args[0];
  if (!ref) {
    console.error("usage: foreman attach <terminal-id or unique prefix>");
    return 2;
  }
  const client = await PtyClient.connect({ client: "cli" });
  try {
    return await attachTerminal(client, await resolveTerminalId(client, ref));
  } catch (e) {
    client.close();
    throw e;
  }
}
