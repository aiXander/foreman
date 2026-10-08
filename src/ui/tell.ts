// The host side of a page's tell (pages plan, item 4): which `message` events from the page frame
// become a POST to the agent. Pure, so it is tested without a DOM. A message counts only when it
// comes from our own frame's window AND the page origin, after a human interacted with the frame
// (it holds focus); then size and rate caps apply, so a runaway page is refused, visibly.

export const TELL_RATE = { count: 5, windowMs: 10_000 };
/** The whole posted message, serialized. The daemon caps the rendered note at 2,000 characters. */
const MAX_TELL_MESSAGE_BYTES = 8 * 1024;

export type TellVerdict = { kind: "ignore" } | { kind: "refuse"; reason: string } | { kind: "send"; text: string; context?: unknown };

export interface TellEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

export class TellGate {
  private times: number[] = [];

  constructor(private pageOrigin: string) {}

  /**
   * `frame`: the iframe's contentWindow right now. `focused`: the frame holds focus, i.e. the human
   * clicked or typed in it (a page never tells on load or on a timer).
   */
  check(e: TellEvent, frame: unknown, focused: boolean, now = Date.now()): TellVerdict {
    if (!frame || e.source !== frame || e.origin !== this.pageOrigin) return { kind: "ignore" };
    const d = e.data as { type?: unknown; text?: unknown; context?: unknown } | null;
    if (!d || typeof d !== "object" || d.type !== "foreman:tell") return { kind: "ignore" };
    const bad = malformed(d) ?? (focused ? null : "The page sent a message without a click or keypress in it; refused.") ?? this.overRate(now);
    if (bad) return { kind: "refuse", reason: bad };
    this.times.push(now);
    const text = d.text as string;
    return d.context === undefined ? { kind: "send", text } : { kind: "send", text, context: d.context };
  }

  private overRate(now: number): string | null {
    this.times = this.times.filter((t) => now - t < TELL_RATE.windowMs);
    return this.times.length >= TELL_RATE.count ? `The page sent more than ${TELL_RATE.count} messages in ${TELL_RATE.windowMs / 1000} s; refused.` : null;
  }
}

/** Why a foreman:tell message can't be sent as-is, or null. */
function malformed(d: { text?: unknown }): string | null {
  if (typeof d.text !== "string" || !d.text.trim()) return "The page sent a message without text.";
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(d)).length;
  } catch {
    return "The page sent a message that isn't JSON.";
  }
  return size > MAX_TELL_MESSAGE_BYTES ? `The page sent a ${size}-byte message; at most ${MAX_TELL_MESSAGE_BYTES}.` : null;
}
