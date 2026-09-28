import type { ActivityState } from "../../shared/api";
import { stateLabel } from "../format";

/** Signal lamp for a session state. Unknown/ended states render hollow: no live evidence. */
export function Lamp({ state, title }: { state: ActivityState; title?: string }) {
  return (
    <span
      className="lamp"
      data-state={state}
      data-hollow={state === "unknown" || state === "dead"}
      role="img"
      aria-label={stateLabel[state]}
      title={title ?? stateLabel[state]}
    />
  );
}
