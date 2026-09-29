// Renders agent-written Markdown (see ../markdown.ts) as React text nodes only — never HTML.
// Links open in a new tab with no opener/referrer; only absolute http(s) targets are links.
import type { ReactNode } from "react";
import { parseInline, parseMarkdown, type Block, type Inline } from "../markdown";

function spans(xs: Inline[]): ReactNode[] {
  return xs.map((x, i) => {
    switch (x.t) {
      case "text":
        return x.v;
      case "code":
        return (
          <code key={i} className="rounded bg-panel-2 px-1 font-mono text-[12px]">
            {x.v}
          </code>
        );
      case "strong":
        return <strong key={i}>{spans(x.c)}</strong>;
      case "em":
        return <em key={i}>{spans(x.c)}</em>;
      case "link":
        return (
          <a key={i} href={x.href} target="_blank" rel="noopener noreferrer" className="text-accent underline" title={x.href}>
            {spans(x.c)}
          </a>
        );
    }
  });
}

function block(b: Block, i: number): ReactNode {
  switch (b.t) {
    case "p":
      return (
        <p key={i} className="whitespace-pre-wrap break-words">
          {spans(b.c)}
        </p>
      );
    case "h":
      return (
        <p key={i} className="font-semibold">
          {spans(b.c)}
        </p>
      );
    case "ul":
      return (
        <ul key={i} className="list-disc space-y-0.5 pl-4">
          {b.items.map((it, j) => (
            <li key={j} className="break-words">
              {spans(it)}
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={i} start={b.start} className="list-decimal space-y-0.5 pl-5">
          {b.items.map((it, j) => (
            <li key={j} className="break-words">
              {spans(it)}
            </li>
          ))}
        </ol>
      );
    case "pre":
      return (
        <pre key={i} className="overflow-x-auto rounded bg-panel-2 px-2 py-1 font-mono text-[12px]">
          {b.v}
        </pre>
      );
  }
}

/** Block Markdown (handover summary, item detail). */
export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return <div className={`space-y-1.5 ${className}`}>{parseMarkdown(text).map(block)}</div>;
}

/** Inline-only Markdown for one-line fields (item summaries). */
export function InlineMarkdown({ text }: { text: string }) {
  return <>{spans(parseInline(text))}</>;
}
