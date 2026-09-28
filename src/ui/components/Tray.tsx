// The send tray (plan §9.1): card clicks stage actions here — persisted by the daemon, never sent
// by a click, a tab switch or a timer. Send freezes exactly the preview text into one batch.
import { useCallback, useState } from "react";
import type { TrayAction, TrayView } from "../../shared/api";
import { ApiError, api, Unauthorized } from "../client";

export interface TrayApi {
  tray: TrayView | null;
  /** Stage an action; one staged action per item, so staging an item again replaces it. */
  stage: (a: DistributiveOmit<TrayAction, "action_id">) => void;
  unstage: (actionId: string) => void;
  staged: (itemId: string) => TrayAction | null;
  busy: boolean;
  error: string | null;
}

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

export function useTray(session: string, tray: TrayView | null, setTray: (t: TrayView) => void, reload: () => void, onUnauthorized: () => void): TrayApi {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const put = useCallback(
    (actions: TrayAction[]) => {
      if (!tray || busy) return;
      setBusy(true);
      setError(null);
      api
        .putTray(session, { expected_revision: tray.revision, actions })
        .then((r) => setTray(r.tray))
        .catch((e) => {
          if (e instanceof Unauthorized) return onUnauthorized();
          setError(e instanceof ApiError && e.status === 409 ? `${e.message}` : e instanceof Error ? e.message : String(e));
          reload();
        })
        .finally(() => setBusy(false));
    },
    [session, tray, busy, setTray, reload, onUnauthorized],
  );

  const current = tray?.actions.map((a) => a.action) ?? [];
  return {
    tray,
    busy,
    error,
    staged: (itemId) => current.find((a) => "item_id" in a && a.item_id === itemId) ?? null,
    stage: (a) => {
      const next = { ...a, action_id: crypto.randomUUID() } as TrayAction;
      const itemId = "item_id" in next ? next.item_id : null;
      put([...current.filter((x) => !itemId || !("item_id" in x) || x.item_id !== itemId), next]);
    },
    unstage: (actionId) => put(current.filter((a) => a.action_id !== actionId)),
  };
}

export function Tray({ session, t, reload, onUnauthorized }: { session: string; t: TrayApi; reload: () => void; onUnauthorized: () => void }) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const tray = t.tray;
  if (!tray) return null;
  const n = tray.actions.length;

  const send = () => {
    if (!tray.batch_id) return;
    setSending(true);
    setSendError(null);
    api
      .send(session, { batch_id: tray.batch_id, tray_revision: tray.revision })
      .catch((e) => (e instanceof Unauthorized ? onUnauthorized() : setSendError(e instanceof Error ? e.message : String(e))))
      .finally(() => {
        setSending(false);
        reload();
      });
  };
  const addNote = () => {
    if (!note.trim()) return;
    t.stage({ type: "note", text: note.trim() });
    setNote("");
  };

  return (
    <section className="rounded-md border border-line bg-panel px-3 py-2.5 text-[13px]" aria-label="Send tray">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold text-ink-2">Send tray</h2>
        {n > 0 ? <span className="rounded bg-accent px-1.5 text-[11px] font-semibold text-accent-ink">{`${n} unsent`}</span> : null}
      </div>
      {n === 0 ? <p className="mt-1 text-ink-2">Nothing staged. Answers and clicks on the card land here; nothing reaches the agent until you press Send.</p> : null}
      <ol className="mt-1.5 space-y-1">
        {tray.actions.map((a) => (
          <li key={a.action.action_id} className={`flex gap-2 rounded px-1.5 py-1 ${a.conflict ? "bg-warn-bg" : "bg-panel-2"}`}>
            <span className="min-w-0 flex-1 break-words">
              {a.label}
              {a.conflict ? <span className="block text-[12px]">{`Conflict: ${a.conflict}. Remove it and stage it again from the card.`}</span> : null}
            </span>
            <button type="button" disabled={t.busy} onClick={() => t.unstage(a.action.action_id)} className="h-fit text-ink-2 hover:text-ink" aria-label="Remove from tray" title="Remove">
              ×
            </button>
          </li>
        ))}
      </ol>
      <div className="mt-2 flex gap-1.5">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addNote()}
          maxLength={2000}
          placeholder="Add a note for the agent"
          className="min-w-0 flex-1 rounded border border-line bg-ground px-2 py-1"
          aria-label="Note for the agent"
        />
        <button type="button" disabled={t.busy || !note.trim()} onClick={addNote} className="rounded border border-line bg-panel-2 px-2 font-medium hover:border-accent disabled:opacity-50">
          Stage
        </button>
      </div>
      {t.error ? <p className="mt-1 text-[var(--sig-block)]">{t.error}</p> : null}
      {tray.preview ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-ink-2">{`Preview: exactly what the agent receives (batch ${tray.batch_id?.slice(0, 8)}, ${tray.preview_bytes} bytes)`}</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[12px]">{tray.preview}</pre>
        </details>
      ) : null}
      {n > 0 ? (
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            disabled={sending || t.busy || tray.blocked !== null}
            onClick={send}
            className="rounded-md bg-accent px-3 py-1 font-medium text-accent-ink disabled:opacity-50"
          >
            {sending ? "Sending…" : `Send ${n} action${n === 1 ? "" : "s"}`}
          </button>
          {tray.blocked ? <span className="text-ink-2">{tray.blocked}</span> : null}
        </div>
      ) : null}
      {sendError ? <p className="mt-1 text-[var(--sig-block)]">{sendError}</p> : null}
    </section>
  );
}
