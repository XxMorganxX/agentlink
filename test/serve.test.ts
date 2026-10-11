import { describe, expect, it } from 'vitest';
import { serve, serveCycle, type ServeDeps, type ServeState } from '../src/serve';
import type { PollResult } from '../src/client';
import type { Device } from '../src/store';
import type { TaskDocument } from '../src/protocol';

const doc: TaskDocument = { protocol: 'agentlink/1', id: 't1', title: 'T', instructions: 'Do.', mcp_servers: {}, allowed_tools: [], result_schema: null, run_token: 'r' };
const dev = (origin: string): Device => ({ origin, app: 'CRM', workspace: { slug: 'acme', name: 'Acme' }, device_id: `d-${origin}`, device_token: `t-${origin}`, poll_url: `${origin}/poll`, paired_at: 'x' });
const task = (id: string): PollResult => ({ kind: 'task', task: { ...doc, id }, taskUrl: `https://a/tasks/${id}` });

function harness(devices: Device[], answers: Record<string, PollResult[]>, overrides: Partial<ServeDeps> = {}) {
  let list = devices;
  const removed: string[] = [];
  const ran: string[] = [];
  const polled: string[] = [];
  const notices: string[] = [];
  const log: string[] = [];
  const ac = new AbortController();
  const deps: ServeDeps = {
    store: { listDevices: () => list, removeDevice: (o) => { removed.push(o); list = list.filter((d) => d.origin !== o); } },
    app: {
      poll: async (url) => { polled.push(url); const q = answers[url] ?? []; return q.length > 1 ? q.shift()! : (q[0] ?? { kind: 'idle', retryAfterMs: 3000 }); },
      pair: async () => { throw new Error('unused'); },
    },
    runner: async (t) => { ran.push(t.id); return 0; },
    launcher: async () => ({ name: 'agentlink', version: '0.2.0', platform: 'darwin-arm64', claude_version: '1.0.0' }),
    notify: async (t, x) => { notices.push(`${t}: ${x}`); },
    log: (l) => log.push(l),
    ...overrides,
  };
  const state: ServeState = { backoff: new Map() };
  const cycle = () => serveCycle(deps, state, ac.signal);
  return { deps, state, ac, cycle, removed, ran, polled, notices, log };
}

describe('serveCycle', () => {
  it('polls every device and returns the shortest idle delay', async () => {
    const h = harness([dev('https://a'), dev('https://b')], {
      'https://a/poll': [{ kind: 'idle', retryAfterMs: 3000 }], 'https://b/poll': [{ kind: 'idle', retryAfterMs: 1500 }],
    });
    expect(await h.cycle()).toBe(1500);
    expect(h.ran).toEqual([]);
  });

  it('runs a claimed task, then polls that device again at once', async () => {
    const h = harness([dev('https://a')], { 'https://a/poll': [task('t1'), { kind: 'idle', retryAfterMs: 2000 }] });
    expect(await h.cycle()).toBe(2000);
    expect(h.ran).toEqual(['t1']);
  });

  it('stops polling once aborted, even with more tasks queued', async () => {
    const h = harness([dev('https://a'), dev('https://b')], { 'https://a/poll': [task('t1'), task('t2'), { kind: 'idle', retryAfterMs: 2000 }] });
    h.deps.runner = async (t) => { h.ran.push(t.id); h.ac.abort(); return 0; };
    expect(await h.cycle()).toBe(3000);
    expect(h.ran).toEqual(['t1']);
    expect(h.polled).toEqual(['https://a/poll']);
  });

  it('forgets a revoked device and notifies', async () => {
    const h = harness([dev('https://a')], { 'https://a/poll': [{ kind: 'revoked' }] });
    await h.cycle();
    expect(h.removed).toEqual(['https://a']);
    expect(h.notices[0]).toContain('disconnected');
  });

  it('backs off on errors, doubling to the cap, and resets on success', async () => {
    const h = harness([dev('https://a')], { 'https://a/poll': [{ kind: 'error', detail: 'down' }] });
    expect(await h.cycle()).toBe(5000);
    expect(await h.cycle()).toBe(10000);
    expect(await h.cycle()).toBe(20000);
    expect(await h.cycle()).toBe(40000);
    expect(await h.cycle()).toBe(60000);
    expect(await h.cycle()).toBe(60000);
    expect(h.log.filter((l) => l.includes('down')).length).toBe(1); // logged once per change, not per cycle
    const ok = harness([dev('https://a')], { 'https://a/poll': [{ kind: 'idle', retryAfterMs: 3000 }] });
    ok.state.backoff.set('https://a', { backoffMs: 40000 });
    expect(await ok.cycle()).toBe(3000);
    expect(ok.state.backoff.size).toBe(0);
    expect(ok.log).toContain('https://a: reachable again');
  });

  it('a claimed task also clears the backoff', async () => {
    const h = harness([dev('https://a')], { 'https://a/poll': [task('t1'), { kind: 'idle', retryAfterMs: 3000 }] });
    h.state.backoff.set('https://a', { backoffMs: 20000, lastError: 'down' });
    await h.cycle();
    expect(h.state.backoff.size).toBe(0);
    expect(h.log).toContain('https://a: reachable again');
  });

  it('a device that throws is backed off; the others are still polled', async () => {
    const h = harness([dev('https://a'), dev('https://b')], { 'https://a/poll': [task('t1')], 'https://b/poll': [{ kind: 'idle', retryAfterMs: 1500 }] });
    h.deps.runner = async () => { throw new Error('claude exploded'); };
    expect(await h.cycle()).toBe(1500);
    expect(h.polled).toEqual(['https://a/poll', 'https://b/poll']);
    expect(h.state.backoff.get('https://a')).toEqual({ backoffMs: 5000, lastError: 'claude exploded' });
    expect(h.log).toContain('https://a: claude exploded');
  });

  it('prunes backoff for a device that was unpaired', async () => {
    const h = harness([dev('https://a')], { 'https://a/poll': [{ kind: 'idle', retryAfterMs: 3000 }] });
    h.state.backoff.set('https://gone', { backoffMs: 5000 });
    await h.cycle();
    expect([...h.state.backoff.keys()]).toEqual([]);
  });

  it('idles for the default delay when no device is paired', async () => {
    const h = harness([], {});
    expect(await h.cycle()).toBe(3000);
  });
});

describe('serve', () => {
  it('wakes from a long idle sleep as soon as the signal aborts', async () => {
    const h = harness([dev('https://a')], {});
    h.deps.app.poll = async () => { h.ac.abort(); return { kind: 'idle', retryAfterMs: 60_000 }; };
    const started = Date.now();
    await serve(h.deps, h.ac.signal);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('a pre-aborted signal never polls', async () => {
    const h = harness([dev('https://a')], { 'https://a/poll': [{ kind: 'idle', retryAfterMs: 1000 }] });
    h.ac.abort();
    await serve(h.deps, h.ac.signal);
    expect(h.polled).toEqual([]);
  });
});
