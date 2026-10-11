import { describe, expect, it } from 'vitest';
import { createAppClient, createTaskClient, PairError } from '../src/client';
import { TIMINGS } from '../src/config';

const TASK = 'https://crm.example/api/agentlink/v1/tasks/t1';

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const noSleep = async () => {};
const DONE_BODY = { outcome: 'done', exit_code: 0, result_text: 'ok', structured_output: null, total_cost_usd: 0.1, num_turns: 1, session_id: 's', error: null } as const;

describe('status, events, complete', () => {
  it('status GETs with the run token', async () => {
    const { calls, fetchImpl } = fakeFetch(() => Response.json({ status: 'running' }));
    const client = createTaskClient(TASK, { fetchImpl, sleep: noSleep });
    expect(await client.status('run')).toBe('running');
    expect(calls[0]!.url).toBe(TASK);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer run');
  });
  it('postEvents sends ndjson and retries three times before giving up', async () => {
    let n = 0;
    const { calls, fetchImpl } = fakeFetch(() => { n += 1; return new Response(null, { status: n < 3 ? 500 : 204 }); });
    const client = createTaskClient(TASK, { fetchImpl, sleep: noSleep });
    expect(await client.postEvents('run', ['{"a":1}', '{"b":2}'])).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.init.body).toBe('{"a":1}\n{"b":2}\n');
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/x-ndjson');

    const failing = fakeFetch(() => new Response('', { status: 500 }));
    expect(await createTaskClient(TASK, { fetchImpl: failing.fetchImpl, sleep: noSleep }).postEvents('run', ['x'])).toBe(false);
    expect(failing.calls).toHaveLength(3);
  });
  it('complete keeps retrying inside the window and reports success', async () => {
    let n = 0;
    const { fetchImpl } = fakeFetch(() => { n += 1; return new Response(null, { status: n < 4 ? 503 : 204 }); });
    let now = 0;
    const client = createTaskClient(TASK, { fetchImpl, sleep: async (ms) => { now += ms; }, clock: () => now });
    const body = { outcome: 'done', exit_code: 0, result_text: 'ok', structured_output: null, total_cost_usd: 0.1, num_turns: 1, session_id: 's', error: null } as const;
    expect(await client.complete('run', body)).toBe(true);
    expect(n).toBe(4);
  });
  it('complete spends the whole retry window before giving up', async () => {
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: 503 }));
    let now = 0;
    const client = createTaskClient(TASK, { fetchImpl, sleep: async (ms) => { now += ms; }, clock: () => now });
    expect(await client.complete('run', DONE_BODY)).toBe(false);
    expect(now).toBeGreaterThanOrEqual(TIMINGS.completeRetryWindowMs);
  });
  it('complete still succeeds when the server recovers late in the window', async () => {
    let now = 0;
    const { fetchImpl } = fakeFetch(() => new Response(null, { status: now > 45_000 ? 204 : 503 }));
    const client = createTaskClient(TASK, { fetchImpl, sleep: async (ms) => { now += ms; }, clock: () => now });
    expect(await client.complete('run', DONE_BODY)).toBe(true);
  });
});

const launcher = { name: 'agentlink', version: '0.2.0', platform: 'darwin-arm64', claude_version: '2.1.295' };
const paired = {
  device_id: 'dev_1', device_token: 'tok', poll_url: 'https://crm.example/api/agentlink/v1/poll',
  workspace: { id: 'w1', slug: 'acme', name: 'Acme' }, app: { name: 'Outreach CRM' },
};
const doc = {
  protocol: 'agentlink/1', id: 't1', title: 'T', instructions: 'Do it.', mcp_servers: {}, allowed_tools: [],
  result_schema: null, run_token: 'r1',
};

function fetchReturning(status: number, body: unknown = null, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('createAppClient.pair', () => {
  it('posts the code and launcher to <origin>/api/agentlink/v1/pair and returns the validated response', async () => {
    const f = fetchReturning(200, paired);
    const c = createAppClient({ fetchImpl: f.fetchImpl });
    expect(await c.pair('https://crm.example/', { code: 'K7Q29XM4', name: 'My Mac', launcher })).toEqual(paired);
    expect(f.calls[0]!.url).toBe('https://crm.example/api/agentlink/v1/pair');
    expect(JSON.parse(f.calls[0]!.init.body as string)).toEqual({ code: 'K7Q29XM4', name: 'My Mac', launcher });
  });
  it.each([[404, 'unknown_code'], [410, 'expired'], [500, 'bad_response']])('maps HTTP %i to %s', async (status, code) => {
    const c = createAppClient({ fetchImpl: fetchReturning(status, { error: 'x' }).fetchImpl });
    await expect(c.pair('https://crm.example', { code: 'X', name: 'M', launcher })).rejects.toMatchObject({ code });
  });
  it('maps a network failure to unreachable', async () => {
    const down = createAppClient({ fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch });
    const attempt = down.pair('https://crm.example', { code: 'X', name: 'M', launcher });
    await expect(attempt).rejects.toBeInstanceOf(PairError);
    await expect(attempt).rejects.toMatchObject({ code: 'unreachable' });
  });
  it('unreachable detail includes the fetch cause (undici hides ECONNREFUSED there)', async () => {
    const down = createAppClient({ fetchImpl: (async () => { throw new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:443') }); }) as typeof fetch });
    await expect(down.pair('https://crm.example', { code: 'X', name: 'M', launcher })).rejects.toMatchObject({ code: 'unreachable', message: expect.stringContaining('ECONNREFUSED') });
  });
  it('maps a body that fails validation to bad_response', async () => {
    const junk = createAppClient({ fetchImpl: fetchReturning(200, { device_id: 'only' }).fetchImpl });
    await expect(junk.pair('https://crm.example', { code: 'X', name: 'M', launcher })).rejects.toMatchObject({ code: 'bad_response' });
  });
  it('refuses a non-https origin without calling fetch', async () => {
    const f = fetchReturning(200, paired);
    const c = createAppClient({ fetchImpl: f.fetchImpl });
    await expect(c.pair('ftp://x', { code: 'X', name: 'M', launcher })).rejects.toMatchObject({ code: 'bad_origin' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('createAppClient.poll', () => {
  it('returns idle with the default delay on 204', async () => {
    const f = fetchReturning(204);
    const c = createAppClient({ fetchImpl: f.fetchImpl });
    expect(await c.poll(paired.poll_url, 'tok', launcher)).toEqual({ kind: 'idle', retryAfterMs: 3000 });
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });
  it.each([
    ['10', 10_000],
    ['999', 60_000],
    ['0', 1_000],
    ['Wed, 21 Oct 2015 07:28:00 GMT', 3_000],
    ['', 3_000],
  ])('turns Retry-After %j into %i ms', async (header, expected) => {
    const c = createAppClient({ fetchImpl: fetchReturning(204, null, { 'retry-after': header }).fetchImpl });
    expect(await c.poll(paired.poll_url, 'tok', launcher)).toEqual({ kind: 'idle', retryAfterMs: expected });
  });
  it('returns the task and its URL on 200', async () => {
    const c = createAppClient({ fetchImpl: fetchReturning(200, { task: doc, task_url: 'https://crm.example/api/agentlink/v1/tasks/t1' }).fetchImpl });
    expect(await c.poll(paired.poll_url, 'tok', launcher)).toEqual({ kind: 'task', task: doc, taskUrl: 'https://crm.example/api/agentlink/v1/tasks/t1' });
  });
  it('returns revoked on 401 and error otherwise', async () => {
    expect(await createAppClient({ fetchImpl: fetchReturning(401).fetchImpl }).poll(paired.poll_url, 'tok', launcher)).toEqual({ kind: 'revoked' });
    expect(await createAppClient({ fetchImpl: fetchReturning(503).fetchImpl }).poll(paired.poll_url, 'tok', launcher)).toMatchObject({ kind: 'error' });
    expect(await createAppClient({ fetchImpl: (async () => { throw new Error('down'); }) as typeof fetch }).poll(paired.poll_url, 'tok', launcher)).toMatchObject({ kind: 'error', detail: 'down' });
    expect(await createAppClient({ fetchImpl: fetchReturning(200, { task: 'junk', task_url: 'https://x/t' }).fetchImpl }).poll(paired.poll_url, 'tok', launcher)).toMatchObject({ kind: 'error' });
  });
});
