// Live session/terminal state: one snapshot fetch, then SSE deltas. Any gap (resync_required,
// a dropped stream) refetches the snapshot rather than trusting partial state.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionView, StreamEvent } from "../shared/api";
import type { TerminalInfo } from "../shared/ptyproto";
import { api, Unauthorized } from "./client";

export type LiveStatus = "loading" | "ok" | "unauthorized" | "offline";

export interface Live {
  status: LiveStatus;
  sessions: SessionView[];
  terminals: TerminalInfo[];
  error: string | null;
}

export function useLive(): Live {
  const [status, setStatus] = useState<LiveStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Map<string, SessionView>>(new Map());
  const [terminals, setTerminals] = useState<Map<string, TerminalInfo>>(new Map());
  const inflight = useRef<Promise<void> | null>(null);
  /** `<epoch>:<cursor>` of the last snapshot, so the first SSE connect replays anything newer. */
  const snapshotAt = useRef<string | null>(null);

  const refresh = useCallback(() => {
    if (inflight.current) return inflight.current;
    const p = api
      .sessions()
      .then((r) => {
        snapshotAt.current = `${r.epoch}:${r.cursor}`;
        setSessions(new Map(r.sessions.map((s) => [s.id, s])));
        setTerminals(new Map(r.terminals.map((t) => [t.terminal_id, t])));
        setStatus("ok");
        setError(null);
      })
      .catch((e) => {
        if (e instanceof Unauthorized) setStatus("unauthorized");
        else {
          setStatus((s) => (s === "unauthorized" ? s : "offline"));
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = p;
    return p;
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let hadError = false;

    const apply = (ev: StreamEvent) => {
      switch (ev.type) {
        case "session":
          setSessions((m) => new Map(m).set(ev.session.id, ev.session));
          break;
        case "session_removed":
          setSessions((m) => {
            const n = new Map(m);
            n.delete(ev.id);
            return n;
          });
          break;
        case "terminal":
          setTerminals((m) => new Map(m).set(ev.terminal.terminal_id, ev.terminal));
          break;
        case "resync_required":
          void refresh();
          break;
      }
    };

    const open = () => {
      if (closed) return;
      const after = snapshotAt.current ? `?after=${encodeURIComponent(snapshotAt.current)}` : "";
      es = new EventSource(`/api/v1/events${after}`, { withCredentials: true });
      es.onopen = () => {
        if (hadError) {
          hadError = false;
          void refresh();
        }
      };
      es.onmessage = (m) => {
        try {
          apply(JSON.parse(m.data) as StreamEvent);
        } catch {}
      };
      es.onerror = () => {
        hadError = true;
        // Browser retries on its own while CONNECTING; a CLOSED stream (e.g. 401) needs us.
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          void refresh();
          retry = setTimeout(open, 3000);
        } else {
          // A routine stream reconnect is not an outage; only a failed refetch marks us offline.
          void refresh();
        }
      };
    };

    void refresh().then(open);
    return () => {
      closed = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [refresh]);

  return { status, sessions: [...sessions.values()], terminals: [...terminals.values()], error };
}
