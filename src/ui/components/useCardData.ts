// The data a session card shows beyond its SessionView (activity, batches, declared work, the send
// tray), refetched as the session's journal, delivery summary or tray move. Used by the full card
// and the card beside a page.
import { useCallback, useEffect, useState } from "react";
import type { ActivityEntry, BatchView, SessionView, TrayView, WorkView } from "../../shared/api";
import { api, Unauthorized } from "../client";
import { useTray } from "./Tray";

/** Everything a card shows beyond the SessionView, refetched as the session moves (full card and side card). */
export function useCardData(s: SessionView, onUnauthorized: () => void) {
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [batches, setBatches] = useState<BatchView[]>([]);
  const [work, setWork] = useState<WorkView | null>(null);
  const [tray, setTray] = useState<TrayView | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  // Refetch whenever the journal advances, the delivery summary changes (orphan/unseen are
  // time-based) or the tray changes elsewhere (another tab).
  const deliveryKey = JSON.stringify(s.delivery);
  useEffect(() => {
    if (s.id.startsWith("reg-")) return;
    let cancelled = false;
    api
      .session(s.id)
      .then((r) => {
        if (!cancelled) {
          setActivity(r.activity);
          setBatches(r.batches);
          setWork(r.work);
          setTray(r.tray);
          setActivityError(null);
        }
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof Unauthorized) onUnauthorized();
        else setActivityError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [s.id, s.last_seq, deliveryKey, s.unsent, tick, onUnauthorized]);

  const t = useTray(s.id, tray, setTray, reload, onUnauthorized);
  return { activity, batches, work, activityError, reload, t, steerable: s.capabilities.cards && !s.id.startsWith("reg-") };
}
