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

  const field = "w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-[14px] text-ink";

  return (
    <div className="max-w-xl px-6 py-6">
      <h1 className="text-[18px] font-semibold tracking-tight">Launch a Claude session</h1>
      <p className="mt-1 text-[13px] text-ink-2">
        Starts Claude Code in a terminal Foreman owns. It keeps running when you close this page.
        {options?.claude_version ? ` Claude Code ${options.claude_version}.` : ""}
      </p>
      <form onSubmit={submit} className="mt-5 space-y-4">
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">Working directory</span>
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
          {cwd && !cwdValid ? <span className="mt-1 block text-[12px] text-[var(--sig-block)]">Use an absolute path.</span> : null}
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium">Model</span>
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
            <span className="mb-1 block text-[13px] font-medium">Effort</span>
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
        {optionsError ? <p className="text-[12px] text-ink-2">{`Model and effort lists unavailable: ${optionsError}`}</p> : null}
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium">First prompt (optional)</span>
          <textarea className={`${field} min-h-28`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        {error ? <p className="text-[13px] text-[var(--sig-block)]">{`Launch failed: ${error}`}</p> : null}
        <button
          type="submit"
          disabled={!cwdValid || busy}
          className="rounded-md bg-accent px-3.5 py-1.5 font-medium text-accent-ink disabled:opacity-50"
        >
          {busy ? "Launching…" : "Launch session"}
        </button>
      </form>
    </div>
  );
}
