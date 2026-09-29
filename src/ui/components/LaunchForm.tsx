import { useEffect, useMemo, useState } from "react";
import type { LaunchOptions, SessionView } from "../../shared/api";
import { api, Unauthorized } from "../client";
import { navigate } from "../route";

export function LaunchForm({ sessions, onUnauthorized }: { sessions: SessionView[]; onUnauthorized: () => void }) {
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const knownDirs = useMemo(() => [...new Set(sessions.flatMap((s) => [s.project, s.cwd]))].sort(), [sessions]);
  const [cwd, setCwd] = useState(() => knownDirs[0] ?? "");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One request id per form submission attempt, reused on retry of the same attempt.
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    api
      .launchOptions()
      .then(setOptions)
      .catch((e) => {
        if (e instanceof Unauthorized) onUnauthorized();
        else setOptionsError(e instanceof Error ? e.message : String(e));
      });
  }, [onUnauthorized]);

  const cwdValid = cwd.trim().startsWith("/");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cwdValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.launch({
        request_id: requestId,
        cwd: cwd.trim(),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      });
      setRequestId(crypto.randomUUID());
      navigate({ name: "terminal", id: r.terminal_id });
    } catch (err) {
      if (err instanceof Unauthorized) onUnauthorized();
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const field = "field text-[14px]";
  const label = "mb-1.5 block text-[12.5px] font-medium text-ink-2";

  return (
    <div className="enter mx-auto max-w-2xl px-8 pt-12 pb-10">
      <h1 className="text-[24px] font-semibold tracking-tight text-white">Launch a Claude session</h1>
      <p className="mt-1.5 text-[14px] text-ink-2">
        Starts Claude Code in a terminal Foreman owns. It keeps running when you close this page.
        {options?.claude_version ? <span className="chip mt-3 flex w-fit font-mono">{`Claude Code ${options.claude_version}`}</span> : null}
      </p>
      <form onSubmit={submit} className="surface mt-7 space-y-5 px-6 py-6">
        <label className="block">
          <span className={label}>Working directory</span>
          <input
            className={`${field} font-mono text-[13px]`}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/Users/you/code/project"
            list="foreman-known-dirs"
            required
            spellCheck={false}
            autoComplete="off"
          />
          <datalist id="foreman-known-dirs">
            {knownDirs.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          {cwd && !cwdValid ? <span className="mt-1.5 block text-[12px] text-[var(--sig-block)]">Use an absolute path.</span> : null}
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={label}>Model</span>
            <select className={field} value={model} onChange={(e) => setModel(e.target.value)} disabled={!options}>
              <option value="">Claude's default</option>
              {options?.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Effort</span>
            <select className={field} value={effort} onChange={(e) => setEffort(e.target.value)} disabled={!options}>
              <option value="">Claude's default</option>
              {options?.efforts.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
        {optionsError ? <p className="text-[12px] text-ink-3">{`Model and effort lists unavailable: ${optionsError}`}</p> : null}
        <label className="block">
          <span className={label}>
            First prompt <span className="font-normal text-ink-3">(optional)</span>
          </span>
          <textarea className={`${field} min-h-32 resize-y leading-relaxed`} placeholder="What should Claude start on?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        {error ? <p className="text-[13px] text-[var(--sig-block)]">{`Launch failed: ${error}`}</p> : null}
        <div className="flex items-center gap-3 border-t border-line/70 pt-5">
          <button type="submit" disabled={!cwdValid || busy} className="btn btn-primary h-9 px-5 text-[14px]">
            {busy ? "Launching…" : "Launch session"}
          </button>
          <span className="text-[12px] text-ink-3">Opens its live terminal next.</span>
        </div>
      </form>
    </div>
  );
}
