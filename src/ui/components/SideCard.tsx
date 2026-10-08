// The card beside a page (D21: one surface, two layers): the bound agent's message box, its
// questions and what it did with your messages, in a narrow column next to the page frame. The
// same components as the full card; details and activity stay on the full card.
import type { SessionView } from "../../shared/api";
import { sessionTitle, stateLabel, useNow } from "../format";
import { Controls } from "./Controls";
import { Deliveries } from "./Deliveries";
import { Items } from "./Items";
import { Lamp } from "./Lamp";
import { Tray } from "./Tray";
import { useCardData } from "./useCardData";
import { Brief, Handover } from "./Work";

const SIDE_BATCHES = 5;

export function SideCard({ s, onOpenCard, onOpenTerminal, onUnauthorized }: { s: SessionView; onOpenCard: () => void; onOpenTerminal: (() => void) | null; onUnauthorized: () => void }) {
  const now = useNow();
  const { batches, work, reload, t, steerable } = useCardData(s, onUnauthorized);
  return (
    <div className="px-4 pt-3.5 pb-6">
      <div className="mb-3.5 flex items-center gap-2 text-[13px]">
        <Lamp state={s.state} />
        <span className="min-w-0 flex-1 truncate text-ink">{`${sessionTitle(s)} · ${stateLabel[s.state].toLowerCase()}`}</span>
        <button type="button" className="btn-link text-[12.5px]" onClick={onOpenCard}>
          Full card
        </button>
        {onOpenTerminal ? (
          <button type="button" className="btn-link text-[12.5px]" onClick={onOpenTerminal}>
            Terminal
          </button>
        ) : null}
      </div>
      {steerable ? <Tray session={s.id} t={t} reload={reload} onUnauthorized={onUnauthorized} compact /> : null}
      {work ? <Items session={s.id} items={work.items} t={t} now={now} reload={reload} onUnauthorized={onUnauthorized} /> : null}
      <Deliveries s={s} batches={batches.slice(0, SIDE_BATCHES)} now={now} onOpenTerminal={onOpenTerminal} onChanged={reload} onUnauthorized={onUnauthorized} />
      {work ? <Brief w={work} now={now} /> : null}
      {work ? <Handover w={work} now={now} /> : null}
      <Controls s={s} now={now} onOpenTerminal={onOpenTerminal ?? (() => {})} onUnauthorized={onUnauthorized} />
    </div>
  );
}
