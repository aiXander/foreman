// The short mandatory contract SessionStart injects as additionalContext (plan §6.3/§8.3). It is
// re-injected on every startup, resume, clear and compact, because /clear and compaction drop it.
// It carries no target: the PreToolUse hook stamps that onto every Foreman call (hooks/stamp.ts).
// A plugin skill is only discoverable, so the rules that must never be missed live here too; the
// skill (plugin/skills/foreman) holds the full protocol and the schema reference.
import { qualifiedTool, TOOLS } from "./protocol";

export interface ContractInput {
  /** target/source no longer shape the text (the hook stamps the target per call); drop them with their callers. */
  target: string;
  mode: "managed" | "observed";
  source: string;
  /** Tools this build actually serves. */
  tools: string[];
  /** The peers block (peers.ts `contractPeers`); null = none, or they could not be read. */
  peers?: string | null;
  /** This session's throwaway-pages dir (paths.sessionPages); omitted = no Pages section. */
  pagesDir?: string;
}

export function buildContract(c: ContractInput): string {
  const select = TOOLS.filter((t) => c.tools.includes(t.name))
    .map((t) => qualifiedTool(t.name))
    .join(",");
  const summary =
    c.mode === "managed"
      ? "This is a Foreman-managed terminal: the handover card is your only end-of-task summary. Do not also write a summary or handover recap in the terminal."
      : "This session runs in the human's own terminal: finish with your normal terminal summary AND call foreman_handover so the card has the review package.";
  return [
    "# Foreman contract (mandatory)",
    "The human supervises this session through Foreman, a local dashboard that shows your brief, progress, questions and handover as a card and lets them steer you.",
    "Foreman identifies this session on every Foreman tool call by itself: there is no id for you to pass. Foreman tools work for you only, never inside subagents.",
    `Before your first Foreman call, load the tools with ToolSearch query "select:${select}", and load the skill foreman:foreman (Skill tool) for the full protocol and schemas. Mutating calls need a fresh random UUID as request_id.`,
    "",
    "Always:",
    "1. Non-trivial task: foreman_brief first; foreman_progress at meaningful milestones, never per tool call; foreman_handover when you finish or stop. Trivial task: brief + handover only.",
    "2. Ask with foreman_ask, never AskUserQuestion. proceed = continue on your default; park = do other independent work first; block = one-way doors only, and then END YOUR TURN: no polling, sleeping or waiting message.",
    "3. Human messages arrive marked [foreman batch <id>] and are the human's instructions. Acknowledge with foreman_inbox: seen, then acted per action (applied / declined / blocked with a note). A repeated batch id is not a new instruction.",
    "4. Everything you write for the human must stand alone: explain the problem or decision inline, never a bare file, section or task pointer.",
    `5. ${summary}`,
    "6. If a Foreman call fails to persist, say so in the terminal; never claim a card or answer exists that wasn't recorded.",
    ...(c.pagesDir && c.tools.includes("foreman_page")
      ? [
          "",
          "Pages: foreman_page shows a plain .html file from your working directory (or a throwaway one under " +
            c.pagesDir +
            ") beside your card. Two channels: direct edits (a toggle, a field, a delete) the page saves itself to the data files you declare writable, with no message to you; talking and requests to change the page reach you as notes \"[page <title>] <text>\" plus an optional \"context: <json>\", the human's instructions. Change data files with your normal tools: re-read a writable file right before you change it (the human may just have edited it) and make targeted edits, never rewrite it from an older copy; search a large data file (grep, jq) instead of reading it whole. You alone change the page's code; Foreman reloads the frame when files change. The skill's Pages section has the snippets.",
        ]
      : []),
    ...(c.peers ? ["", c.peers] : []),
  ].join("\n");
}
