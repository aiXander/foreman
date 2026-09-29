// Live view of one ptyd terminal over the daemon's WebSocket proxy.
// Always typeable: the writer lease follows keyboard focus. Focusing the xterm takes control
// (over any other viewer), losing focus releases it, so idle delivery is only held back while
// someone is actually at this terminal. Unfocused, it renders at the terminal's own geometry;
// only the leaseholder fits the xterm to its container, resizes the PTY and sends input. Terminal query
// replies generated while replaying a snapshot or already-seen output are suppressed, so the
// agent never receives a duplicate answer from this viewer.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { WsClientFrame, WsServerFrame } from "../../shared/api";

type Conn = "connecting" | "open" | "reconnecting" | "closed";

interface Status {
  conn: Conn;
  viewerId: string | null;
  writer: string | null;
  exit: { code: number | null; signal: string | null } | null;
  error: string | null;
  cols: number | null;
  rows: number | null;
}

const decode = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const theme = {
  background: "#06070a",
  foreground: "#e6e9f0",
  cursor: "#c4bbff",
  cursorAccent: "#06070a",
  selectionBackground: "#a597ff55",
  black: "#1a1d26",
  red: "#ff6b81",
  green: "#3ee29a",
  yellow: "#ffc24a",
  blue: "#62a8ff",
  magenta: "#b79bff",
  cyan: "#4fd6e6",
  white: "#d5dae4",
  brightBlack: "#5d6576",
  brightRed: "#ff8fa0",
  brightGreen: "#7af0bb",
  brightYellow: "#ffd786",
  brightBlue: "#94c4ff",
  brightMagenta: "#d0bfff",
  brightCyan: "#8be8f2",
  brightWhite: "#ffffff",
};

export function TerminalPane({ terminalId }: { terminalId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [st, setSt] = useState<Status>({ conn: "connecting", viewerId: null, writer: null, exit: null, error: null, cols: null, rows: null });

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 13,
      scrollback: 10000,
      theme,
      allowProposedApi: false,
      cursorBlink: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    let ws: WebSocket | null = null;
    let disposed = false;
    let backoff = 500;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let viewerId: string | null = null;
    let writer: string | null = null;
    let epoch: string | null = null;
    let lastSeq: number | null = null;
    // Output with seq <= this was already seen by the terminal's previous responder.
    let replayUntil = -1;
    let suppress = 0;
    let geom = { cols: 80, rows: 24 };
    // Focus tracking for the lease. `claiming` covers the gap between sending a takeover and its
    // `control` reply: the daemon handles one socket's frames in order, so input sent after the
    // takeover lands after it.
    let focused = false;
    let claiming = false;
    let firstHello = true;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;

    const send = (f: WsClientFrame) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
    };
    const mine = () => viewerId !== null && writer === viewerId;
    const claim = () => {
      if (mine() || claiming || viewerId === null) return;
      claiming = true;
      send({ t: "control", action: "takeover" });
    };
    const patch = (p: Partial<Status>) => setSt((s) => ({ ...s, ...p }));

    const applyGeometry = () => {
      if (mine()) {
        try {
          fit.fit();
        } catch {}
        if (term.cols !== geom.cols || term.rows !== geom.rows) send({ t: "resize", cols: term.cols, rows: term.rows });
      } else if (term.cols !== geom.cols || term.rows !== geom.rows) {
        term.resize(geom.cols, geom.rows);
      }
    };

    const writeSuppressed = (data: Uint8Array | string) => {
      suppress++;
      term.write(data, () => {
        suppress--;
      });
    };

    const onFrame = (f: WsServerFrame) => {
      switch (f.t) {
        case "hello":
          backoff = 500;
          viewerId = f.viewer_id;
          writer = f.terminal.writer;
          geom = { cols: f.terminal.cols, rows: f.terminal.rows };
          replayUntil = f.terminal.last_seq;
          if (epoch && epoch !== f.terminal.stream_epoch) lastSeq = null;
          patch({ viewerId, writer, conn: "open", error: null, cols: geom.cols, rows: geom.rows });
          applyGeometry();
          if (f.terminal.state === "exited") patch({ exit: f.terminal.exit });
          else if (focused) claim();
          else if (firstHello) term.focus(); // opening the terminal view puts the keyboard here
          firstHello = false;
          break;
        case "snapshot_begin":
          epoch = f.stream_epoch;
          geom = { cols: f.cols, rows: f.rows };
          suppress++;
          term.reset();
          if (!mine()) term.resize(f.cols, f.rows);
          patch({ cols: f.cols, rows: f.rows });
          break;
        case "snapshot_chunk":
          term.write(decode(f.data_b64));
          break;
        case "snapshot_end":
          lastSeq = f.seq;
          term.write("", () => {
            suppress--;
            applyGeometry();
          });
          break;
        case "output": {
          if (epoch === f.stream_epoch && lastSeq !== null && f.seq <= lastSeq) break; // duplicate
          epoch = f.stream_epoch;
          lastSeq = f.seq;
          const bytes = decode(f.data_b64);
          if (f.seq <= replayUntil) writeSuppressed(bytes);
          else term.write(bytes);
          break;
        }
        case "resize":
          geom = { cols: f.cols, rows: f.rows };
          lastSeq = Math.max(lastSeq ?? 0, f.seq);
          patch({ cols: f.cols, rows: f.rows });
          if (!mine()) term.resize(f.cols, f.rows);
          break;
        case "exit":
          patch({ exit: { code: f.code, signal: f.signal } });
          break;
        case "control":
          writer = f.writer;
          claiming = false;
          patch({ writer });
          applyGeometry();
          break;
        case "error":
          patch({ error: f.message || f.code });
          break;
      }
    };

    const connect = () => {
      if (disposed) return;
      const q = new URLSearchParams();
      if (epoch && lastSeq !== null) {
        q.set("after_seq", String(lastSeq));
        q.set("stream_epoch", epoch);
      }
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const qs = q.toString();
      ws = new WebSocket(`${proto}//${location.host}/api/v1/terminals/${encodeURIComponent(terminalId)}/ws${qs ? `?${qs}` : ""}`);
      ws.onmessage = (m) => {
        try {
          onFrame(JSON.parse(String(m.data)) as WsServerFrame);
        } catch {}
      };
      ws.onclose = () => {
        viewerId = null;
        writer = null;
        claiming = false;
        if (disposed) return;
        patch({ conn: "reconnecting", viewerId: null, writer: null });
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 8000);
      };
    };

    const dataSub = term.onData((d) => {
      if (suppress > 0 || !(mine() || claiming)) return;
      send({ t: "input", data: d });
    });

    // Release after a short grace so clicks inside xterm (scrollbar, selection) that bounce focus
    // don't flap the lease; switching tab, window or to the card view all blur the xterm.
    const onFocusIn = () => {
      focused = true;
      clearTimeout(releaseTimer);
      claim();
    };
    const onFocusOut = () => {
      focused = false;
      clearTimeout(releaseTimer);
      releaseTimer = setTimeout(() => {
        if (!focused && mine()) send({ t: "control", action: "release" });
      }, 200);
    };
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("focusout", onFocusOut);

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (mine()) applyGeometry();
      }, 80);
    });
    ro.observe(el);

    connect();

    return () => {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(resizeTimer);
      clearTimeout(releaseTimer);
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("focusout", onFocusOut);
      ro.disconnect();
      dataSub.dispose();
      ws?.close();
      term.dispose();
    };
  }, [terminalId]);

  const holding = st.viewerId !== null && st.writer === st.viewerId;
  const otherHolds = st.writer !== null && !holding;
  const exited = st.exit !== null;

  const tone = toolbarTone(st.conn, holding, otherHolds);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-line bg-ground-2/80 px-4 py-2 text-[13px] backdrop-blur-xl">
        <span className="lamp !animate-none" data-state={tone} data-hollow={exited} />
        <span className={holding ? "font-medium text-ink" : "text-ink-2"}>
          {st.conn === "open"
            ? exited
              ? `Process exited${st.exit?.code != null ? ` with code ${st.exit.code}` : ""}${st.exit?.signal ? ` (${st.exit.signal})` : ""}`
              : holding
                ? "Live, typing goes to Claude"
                : otherHolds
                  ? "Someone else is typing here. Click the terminal to take over"
                  : "Live. Click the terminal to type"
            : st.conn === "reconnecting"
              ? "Reconnecting…"
              : "Connecting…"}
        </span>
        {st.cols && st.rows ? <span className="chip font-mono tabular-nums">{`${st.cols}×${st.rows}`}</span> : null}
        {st.error ? <span className="text-[var(--sig-block)]">{st.error}</span> : null}
      </div>
      <div className="xterm-host min-h-0 flex-1 overflow-auto bg-term" ref={host} />
    </div>
  );
}

/** Toolbar lamp colour (borrows the session-state palette): green = yours, blue = watching, amber = connecting or someone else's. An exited process shows hollow. */
function toolbarTone(conn: Conn, holding: boolean, otherHolds: boolean): string {
  if (conn !== "open" || otherHolds) return "waiting_input";
  return holding ? "working" : "starting";
}
