import { TIMINGS } from './config';
import type { AppClient } from './client';
import type { LauncherInfo, TaskDocument } from './protocol';
import type { Store } from './store';

export interface ServeDeps {
  store: Pick<Store, 'listDevices' | 'removeDevice'>;
  app: AppClient;
  /** Runs one claimed task to completion; the exit code is logged, not acted on. */
  runner(task: TaskDocument, taskUrl: string): Promise<number>;
  /** Called once per cycle — must be cheap (cache `claude --version`). */
  launcher(): Promise<LauncherInfo>;
  notify(title: string, text: string): Promise<void>;
  log(line: string): void;
}

export interface ServeState {
  /** Per origin: a non-zero backoff after a failed poll. Absent = healthy. */
  backoff: Map<string, { backoffMs: number; lastError?: string }>;
}

/**
 * One pass over every paired device (spec §3.3). Returns how long to sleep
 * before the next pass: the shortest delay any device asked for.
 */
export async function serveCycle(deps: ServeDeps, state: ServeState, signal: AbortSignal): Promise<number> {
  const devices = deps.store.listDevices(); // re-read each pass: pair/unpair need no restart
  for (const origin of state.backoff.keys()) if (!devices.some((d) => d.origin === origin)) state.backoff.delete(origin);
  if (devices.length === 0) return TIMINGS.pollDefaultMs;
  const launcher = await deps.launcher();
  let next = Number.POSITIVE_INFINITY;

  for (const device of devices) {
    const { origin } = device;
    const health = state.backoff.get(origin) ?? { backoffMs: 0 };
    const recovered = () => {
      if (health.backoffMs) deps.log(`${origin}: reachable again`);
      state.backoff.delete(origin);
    };
    const failed = (detail: string) => {
      const backoffMs = Math.min(TIMINGS.backoffMaxMs, health.backoffMs ? health.backoffMs * 2 : TIMINGS.backoffBaseMs);
      if (health.lastError !== detail) deps.log(`${origin}: poll failed: ${detail}`);
      state.backoff.set(origin, { backoffMs, lastError: detail });
      next = Math.min(next, backoffMs);
    };
    try {
      // A device that just ran a task is polled again immediately: the queue may hold more.
      for (;;) {
        if (signal.aborted) return TIMINGS.pollDefaultMs;
        const r = await deps.app.poll(device.poll_url, device.device_token, launcher);
        if (r.kind === 'task') {
          recovered();
          deps.log(`${origin}: claimed ${r.task.id} "${r.task.title}"`);
          const code = await deps.runner(r.task, r.taskUrl);
          deps.log(`${origin}: ${r.task.id} finished (${code})`);
          continue;
        }
        if (r.kind === 'idle') {
          recovered();
          next = Math.min(next, r.retryAfterMs);
        } else if (r.kind === 'revoked') {
          deps.log(`${origin}: token revoked — forgetting this device`);
          deps.store.removeDevice(origin);
          state.backoff.delete(origin);
          await deps.notify('AgentLink', `${device.app} (${device.workspace.name}) disconnected this Mac.`);
        } else {
          failed(r.detail);
        }
        break;
      }
    } catch (err) {
      // One device's failure (runner, store, notifier) must not stop the others from being polled.
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`${origin}: ${message}`);
      failed(message);
    }
  }
  return Number.isFinite(next) ? next : TIMINGS.pollDefaultMs;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { signal.removeEventListener('abort', done); clearTimeout(t); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

/** The daemon: cycles until the signal aborts. */
export async function serve(deps: ServeDeps, signal: AbortSignal): Promise<void> {
  const state: ServeState = { backoff: new Map() };
  while (!signal.aborted) {
    let delay: number = TIMINGS.pollDefaultMs;
    try { delay = await serveCycle(deps, state, signal); } catch (err) { deps.log(`cycle error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`); }
    await sleep(delay, signal);
  }
}
