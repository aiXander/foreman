// Thin fetch wrapper for the daemon's /api/v1. Auth is the HttpOnly cookie set by `foreman open`.
import type { LaunchOptions, LaunchRequest, LaunchResponse, SendRequest, SessionDetailResponse, SessionsResponse, StopInfo, TrayPutRequest, TrayView } from "../shared/api";

export class Unauthorized extends Error {}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      message = body?.message ?? body?.error?.message ?? body?.error ?? message;
    } catch {}
    throw new ApiError(res.status, String(message));
  }
  return (await res.json()) as T;
}

export const api = {
  sessions: () => call<SessionsResponse>("/api/v1/sessions"),
  session: (id: string) => call<SessionDetailResponse>(`/api/v1/sessions/${encodeURIComponent(id)}`),
  launchOptions: () => call<LaunchOptions>("/api/v1/launch-options"),
  launch: (req: LaunchRequest) => call<LaunchResponse>("/api/v1/terminals", { method: "POST", body: JSON.stringify(req) }),
  retryBatch: (session: string, batch: string) => post<{ ok: true }>(`${sess(session)}/batches/${encodeURIComponent(batch)}/retry`, {}),
  cancelBatch: (session: string, batch: string) => post<{ ok: true }>(`${sess(session)}/batches/${encodeURIComponent(batch)}/cancel`, {}),
  retargetBatch: (session: string, batch: string) =>
    post<{ ok: true; batch_id: string }>(`${sess(session)}/batches/${encodeURIComponent(batch)}/retarget`, { batch_id: crypto.randomUUID() }),
  putTray: (session: string, body: TrayPutRequest) => call<{ ok: true; tray: TrayView }>(`${sess(session)}/tray`, { method: "PUT", body: JSON.stringify(body) }),
  send: (session: string, body: SendRequest) => post<{ ok: true; batch_id: string }>(`${sess(session)}/send`, body),
  pause: (session: string) => post<{ ok: true; batch_id: string }>(`${sess(session)}/pause`, { batch_id: crypto.randomUUID() }),
  stop: (session: string) => post<{ ok: true; stop: StopInfo }>(`${sess(session)}/stop`, { request_id: crypto.randomUUID() }),
  markReviewed: (session: string, item: string, revision: number) => post<{ ok: true }>(`${sess(session)}/items/${encodeURIComponent(item)}/reviewed`, { revision }),
};

const sess = (id: string) => `/api/v1/sessions/${encodeURIComponent(id)}`;
const post = <T>(path: string, body: unknown) => call<T>(path, { method: "POST", body: JSON.stringify(body) });
