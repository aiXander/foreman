// Live view of one ptyd terminal over the daemon's WebSocket proxy.
// Read-only by default and rendered at the terminal's own geometry; only the viewer holding
// control fits the xterm to its container, resizes the PTY and sends input. Terminal query
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
  background: "#14181c",
  foreground: "#d7dde3",
  cursor: "#d7dde3",
  selectionBackground: "#3a4a63",
  black: "#1d242b",
  brightBlack: "#5b6570",
};

export function TerminalPane({ terminalId }: { terminalId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const actions = useRef<{ control: (a: "acquire" | "release" | "takeover") => void } | null>(null);
  const [st, setSt] = useState<Status>({ conn: "connecting", viewerId: null, writer: null, exit: null, error: null, cols: null, rows: null });

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
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

    const send = (f: WsClientFrame) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
    };
    const mine = () => viewerId !== null && writer === viewerId;
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
          patch({ writer });
          applyGeometry();
          if (mine()) term.focus();
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
        if (disposed) return;
        patch({ conn: "reconnecting", viewerId: null, writer: null });
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 8000);
      };
    };

    const dataSub = term.onData((d) => {
      if (suppress > 0 || !mine()) return;
      send({ t: "input", data: d });
    });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (mine()) applyGeometry();
      }, 80);
    });
    ro.observe(el);

    actions.current = { control: (action) => send({ t: "control", action }) };
    connect();

    return () => {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(resizeTimer);
      ro.disconnect();
      dataSub.dispose();
      ws?.close();
      term.dispose();
      actions.current = null;
    };
  }, [terminalId]);

  const holding = st.viewerId !== null && st.writer === st.viewerId;
  const otherHolds = st.writer !== null && !holding;
  const exited = st.exit !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-line bg-panel px-3 py-2 text-[13px]">
        <span className="text-ink-2">
          {st.conn === "open"
            ? exited
              ? `Process exited${st.exit?.code != null ? ` with code ${st.exit.code}` : ""}${st.exit?.signal ? ` (${st.exit.signal})` : ""}`
              : holding
                ? "You have control"
                : otherHolds
                  ? "Another viewer has control"
                  : "Viewing, read-only"
            : st.conn === "reconnecting"
              ? "Reconnecting…"
              : "Connecting…"}
        </span>
        {st.cols && st.rows ? <span className="text-ink-2 tabular-nums">{`${st.cols}×${st.rows}`}</span> : null}
        {st.error ? <span className="text-[var(--sig-block)]">{st.error}</span> : null}
        <span className="flex-1" />
        {st.conn === "open" && !exited ? (
          holding ? (
            <Btn onClick={() => actions.current?.control("release")}>Release control</Btn>
          ) : otherHolds ? (
            <Btn onClick={() => actions.current?.control("takeover")}>Take over</Btn>
          ) : (
            <Btn primary onClick={() => actions.current?.control("acquire")}>
              Take control
            </Btn>
          )
        ) : null}
      </div>
      <div className="xterm-host min-h-0 flex-1 overflow-auto bg-term" ref={host} />
    </div>
  );
}

function Btn({ children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        primary
          ? "rounded-md bg-accent px-2.5 py-1 font-medium text-accent-ink hover:opacity-90"
          : "rounded-md border border-line px-2.5 py-1 text-ink hover:bg-panel-2"
      }
    >
      {children}
    </button>
  );
}
