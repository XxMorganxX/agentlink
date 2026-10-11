import { TIMINGS } from './config';
import {
  isAllowedTaskUrl, PAIR_PATH, validatePairResponse, validatePollTask,
  type CompletionBody, type LauncherInfo, type PairRequest, type PairResponse, type PollRequest, type TaskDocument, type TaskStatus,
} from './protocol';

export class PairError extends Error {
  constructor(readonly code: 'unknown_code' | 'expired' | 'unreachable' | 'bad_response' | 'bad_origin', detail: string) {
    super(detail);
    this.name = 'PairError';
  }
}

export type PollResult =
  | { kind: 'idle'; retryAfterMs: number }
  | { kind: 'task'; task: TaskDocument; taskUrl: string }
  | { kind: 'revoked' }
  | { kind: 'error'; detail: string };

/** The app-level calls (spec §2.1–2.2); one per daemon, not per task. */
export interface AppClient {
  pair(origin: string, body: PairRequest): Promise<PairResponse>;
  poll(pollUrl: string, deviceToken: string, launcher: LauncherInfo): Promise<PollResult>;
}

export interface TaskClient {
  status(runToken: string): Promise<TaskStatus | null>;
  /** Best-effort: true when accepted, false after the retries are spent. */
  postEvents(runToken: string, lines: readonly string[]): Promise<boolean>;
  /** Retried for the whole window — the one message that must land. */
  complete(runToken: string, body: CompletionBody): Promise<boolean>;
}

export interface ClientDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createTaskClient(taskUrl: string, deps: ClientDeps = {}): TaskClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const clock = deps.clock ?? Date.now;
  const base = taskUrl.replace(/\/$/, '');

  async function send(path: string, token: string, init: RequestInit): Promise<Response> {
    return fetchImpl(`${base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(TIMINGS.httpTimeoutMs),
    });
  }

  return {
    async status(runToken) {
      try {
        const res = await send('', runToken, { method: 'GET' });
        if (!res.ok) return null;
        const body = await res.json() as { status?: unknown };
        return typeof body.status === 'string' ? body.status as TaskStatus : null;
      } catch {
        return null;
      }
    },

    async postEvents(runToken, lines) {
      const body = lines.map((l) => `${l}\n`).join('');
      for (let attempt = 0; attempt < TIMINGS.eventPostRetries; attempt += 1) {
        try {
          const res = await send('/events', runToken, { method: 'POST', headers: { 'content-type': 'application/x-ndjson' }, body });
          if (res.ok) return true;
        } catch { /* retry */ }
        if (attempt + 1 < TIMINGS.eventPostRetries) await sleep(TIMINGS.retryBaseMs * 2 ** attempt);
      }
      return false;
    },

    async complete(runToken, body) {
      const deadline = clock() + TIMINGS.completeRetryWindowMs;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const res = await send('/complete', runToken, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          if (res.ok) return true;
        } catch { /* retry */ }
        const remaining = deadline - clock();
        if (remaining <= 0) return false;
        await sleep(Math.min(TIMINGS.retryBaseMs * 2 ** Math.min(attempt, 5), remaining));
      }
    },
  };
}

export function createAppClient(deps: ClientDeps = {}): AppClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const post = (url: string, body: unknown, token?: string) => fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMINGS.httpTimeoutMs),
  });
  return {
    async pair(origin, body) {
      if (!isAllowedTaskUrl(origin)) throw new PairError('bad_origin', 'origin must be https (http only for localhost)');
      let res: Response;
      try {
        res = await post(`${origin.replace(/\/+$/, '')}${PAIR_PATH}`, body);
      } catch (err) {
        // undici says only "fetch failed"; the useful part (ECONNREFUSED, ENOTFOUND, …) is the cause.
        const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
        throw new PairError('unreachable', `${err instanceof Error ? err.message : String(err)}${cause}`);
      }
      if (res.status === 404) throw new PairError('unknown_code', 'that code is not known — it may have been used already');
      if (res.status === 410) throw new PairError('expired', 'that code has expired; make a new one on the Agent page');
      if (!res.ok) throw new PairError('bad_response', `pair: HTTP ${res.status}`);
      let raw: unknown;
      try { raw = await res.json(); } catch { throw new PairError('bad_response', 'pair: response was not JSON'); }
      const v = validatePairResponse(raw);
      if (!v.ok) throw new PairError('bad_response', v.reason);
      return v.paired;
    },
    async poll(pollUrl, deviceToken, launcher) {
      const body: PollRequest = { launcher };
      let res: Response;
      try {
        res = await post(pollUrl, body, deviceToken);
      } catch (err) {
        return { kind: 'error', detail: err instanceof Error ? err.message : String(err) };
      }
      if (res.status === 401) return { kind: 'revoked' };
      if (res.status === 204) {
        const raw = res.headers.get('retry-after');
        const secs = raw ? Number(raw) : NaN;
        const ms = Number.isFinite(secs) ? secs * 1000 : TIMINGS.pollDefaultMs;
        return { kind: 'idle', retryAfterMs: Math.min(TIMINGS.pollMaxMs, Math.max(TIMINGS.pollMinMs, ms)) };
      }
      if (!res.ok) return { kind: 'error', detail: `poll: HTTP ${res.status}` };
      let raw: unknown;
      try { raw = await res.json(); } catch { return { kind: 'error', detail: 'poll: response was not JSON' }; }
      const v = validatePollTask(raw);
      return v.ok ? { kind: 'task', task: v.task, taskUrl: v.taskUrl } : { kind: 'error', detail: v.reason };
    },
  };
}
