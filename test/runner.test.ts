import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTask, type RunnerDeps } from '../src/runner';
import { createTaskClient } from '../src/client';
import { createStore } from '../src/store';
import type { TaskDocument } from '../src/protocol';
import { startFakeApp } from './fake-app';

const FAKE_CLAUDE = resolve(__dirname, 'fake-claude.sh');

function document(overrides: Partial<TaskDocument> = {}): TaskDocument {
  return {
    protocol: 'agentlink/1', id: 't1', title: 'Find people at Acme', instructions: 'Find them.',
    mcp_servers: { crm: { url: 'https://crm.example/mcp', headers: { Authorization: 'Bearer mcp' } } },
    allowed_tools: ['mcp__crm__*', 'Bash'], result_schema: { type: 'object' },
    limits: { max_turns: 7, max_budget_usd: 1, timeout_s: 60 }, run_token: 'run-1', ...overrides,
  };
}

let closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers) await c(); closers = []; });

function deps(app: { url: string }, overrides: Partial<RunnerDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agentlink-test-'));
  const notices: string[] = [];
  const store = createStore({ configFile: join(dir, 'config.json'), devicesFile: join(dir, 'devices.json') });
  store.writeConfig({ claude_path: FAKE_CLAUDE });
  const d: RunnerDeps = {
    client: createTaskClient(app.url, { sleep: async () => {} }),
    store,
    platform: { notify: async (t, text) => { notices.push(`${t}: ${text}`); }, showError: async (text) => { notices.push(`error: ${text}`); }, claudeVersion: async () => '2.1.295' },
    timings: { heartbeatMs: 50, eventFlushMs: 20, killGraceMs: 200 },
    log: () => {},
    workDirRoot: dir,
    env: {},
    ...overrides,
  };
  return { d, notices };
}

const complete = (app: { calls: { path: string; body: string }[] }) => JSON.parse(app.calls.find((c) => c.path.endsWith('/complete'))!.body);

describe('runTask', () => {
  it('runs claude with the policy flags, streams events, completes done', async () => {
    const app = await startFakeApp({ statusSequence: ['claimed', 'running'] });
    closers.push(app.close);
    const { d } = deps(app);
    expect(await runTask(d, { task: document(), taskUrl: app.url })).toBe(0);
    const events = app.calls.filter((c) => c.path.endsWith('/events')).flatMap((c) => c.body.trim().split('\n')).map((l) => JSON.parse(l));
    const init = events.find((e) => e.subtype === 'init');
    expect(init.argv).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--max-turns', '7', '--max-budget-usd', '1', '--json-schema', '{"type":"object"}']));
    expect(init.argv[init.argv.indexOf('--allowedTools') + 1]).toBe('mcp__crm__*'); // Bash dropped by policy
    expect(init.cwd).toContain('agentlink-test-');
    const c = app.calls.find((x) => x.path.endsWith('/complete'))!;
    expect(c.auth).toBe('Bearer run-1');
    expect(JSON.parse(c.body)).toEqual({
      outcome: 'done', exit_code: 0, result_text: '{"n":2}', structured_output: { n: 2 },
      total_cost_usd: 0.5, num_turns: 3, session_id: 'sess-1', error: null,
    });
  });

  it('completes failed with task_rejected when policy refuses the document', async () => {
    const app = await startFakeApp();
    closers.push(app.close);
    const task = document({ mcp_servers: { bad: { url: 'https://x', command: 'rm' } as never } });
    expect(await runTask(deps(app).d, { task, taskUrl: app.url })).toBe(1);
    expect(complete(app)).toMatchObject({ outcome: 'failed', error: 'task_rejected: mcp_servers.bad: only remote (url) servers are allowed' });
  });

  it('kills claude and completes cancelled when the app says so', async () => {
    const app = await startFakeApp({ statusSequence: ['claimed', 'running', 'cancelled'] });
    closers.push(app.close);
    expect(await runTask(deps(app, { env: { FAKE_CLAUDE_MODE: 'hang' } }).d, { task: document(), taskUrl: app.url })).toBe(0);
    expect(complete(app)).toMatchObject({ outcome: 'cancelled', error: null });
  });

  it('treats any other terminal status (lost) as a stop too', async () => {
    const app = await startFakeApp({ statusSequence: ['claimed', 'running', 'lost'] });
    closers.push(app.close);
    expect(await runTask(deps(app, { env: { FAKE_CLAUDE_MODE: 'hang' } }).d, { task: document(), taskUrl: app.url })).toBe(0);
    expect(complete(app)).toMatchObject({ outcome: 'cancelled' });
  });

  it('kills claude and completes failed/daemon_stopped when aborted', async () => {
    const app = await startFakeApp({ statusSequence: ['claimed', 'running'] });
    closers.push(app.close);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 300);
    expect(await runTask(deps(app, { env: { FAKE_CLAUDE_MODE: 'hang' }, abort: abort.signal }).d, { task: document(), taskUrl: app.url })).toBe(1);
    expect(complete(app)).toMatchObject({ outcome: 'failed', error: 'daemon_stopped' });
    expect(app.calls.some((c) => c.path.endsWith('/events'))).toBe(true); // claude ran and was killed, not skipped
  });

  it('a signal already aborted completes daemon_stopped without spawning or any dialog', async () => {
    const app = await startFakeApp();
    closers.push(app.close);
    const abort = new AbortController();
    abort.abort();
    const { d, notices } = deps(app, { abort: abort.signal });
    d.store.writeConfig({ claude_path: '/nonexistent/claude' }); // would otherwise pop the not-installed dialog
    expect(await runTask(d, { task: document(), taskUrl: app.url })).toBe(1);
    expect(complete(app)).toMatchObject({ outcome: 'failed', error: 'daemon_stopped' });
    expect(app.calls.some((c) => c.path.endsWith('/events'))).toBe(false);
    expect(notices).toEqual([]);
  });

  it('an abort after claude has finished keeps the finished result', async () => {
    const abort = new AbortController();
    const app = await startFakeApp({ onCall: (c) => { if (c.path.endsWith('/events') && c.body.includes('"type":"result"')) abort.abort(); } });
    closers.push(app.close);
    // No periodic flush: the result line reaches the app only in the final flush, after claude has exited.
    const { d } = deps(app, { abort: abort.signal, timings: { heartbeatMs: 50, eventFlushMs: 10_000, killGraceMs: 200 } });
    expect(await runTask(d, { task: document(), taskUrl: app.url })).toBe(0);
    expect(abort.signal.aborted).toBe(true);
    expect(complete(app)).toMatchObject({ outcome: 'done', error: null });
  });

  it('kills claude and completes failed/timeout when the limit passes', async () => {
    const app = await startFakeApp();
    closers.push(app.close);
    expect(await runTask(deps(app, { env: { FAKE_CLAUDE_MODE: 'hang' } }).d, { task: document({ limits: { timeout_s: 1 } }), taskUrl: app.url })).toBe(1);
    expect(complete(app)).toMatchObject({ outcome: 'failed', error: 'timeout' });
    expect(app.calls.some((c) => c.method === 'GET')).toBe(true); // heartbeat ran while claude was alive
  });

  it('completes failed/claude_not_found when the binary is missing', async () => {
    const app = await startFakeApp();
    closers.push(app.close);
    const { d } = deps(app);
    d.store.writeConfig({ claude_path: '/nonexistent/claude' });
    expect(await runTask(d, { task: document(), taskUrl: app.url })).toBe(1);
    expect(complete(app)).toMatchObject({ outcome: 'failed', error: 'claude_not_found' });
  });

  it('a failing notification does not fail a finished run', async () => {
    const app = await startFakeApp();
    closers.push(app.close);
    const { d } = deps(app, { platform: { notify: async () => { throw new Error('no notification centre'); }, showError: async () => {}, claudeVersion: async () => null } });
    expect(await runTask(d, { task: document(), taskUrl: app.url })).toBe(0);
    expect(complete(app)).toMatchObject({ outcome: 'done' });
  });
});
