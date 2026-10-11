import { describe, expect, it } from 'vitest';
import { isAllowedTaskUrl, validatePairResponse, validatePollTask, validateTaskDocument } from '../src/protocol';

const TASK_URL = 'https://crm.example/api/agentlink/v1/tasks/tsk_1';

describe('isAllowedTaskUrl', () => {
  it('allows http only for localhost and 127.0.0.1', () => {
    expect(isAllowedTaskUrl(TASK_URL)).toBe(true);
    expect(isAllowedTaskUrl('http://localhost:3002/t/1')).toBe(true);
    expect(isAllowedTaskUrl('http://127.0.0.1:3002/t/1')).toBe(true);
    expect(isAllowedTaskUrl('http://crm.example/t/1')).toBe(false);
    expect(isAllowedTaskUrl('not a url')).toBe(false);
    expect(isAllowedTaskUrl('https://crm.example/t/1?v=2')).toBe(false);
  });
});

const DOC = {
  protocol: 'agentlink/1', id: 'tsk_1', title: 'Find people at Acme', instructions: 'Do the thing.',
  mcp_servers: { crm: { url: 'https://crm.example/mcp', headers: { Authorization: 'Bearer t' } } },
  allowed_tools: ['mcp__crm__*', 'WebSearch'], result_schema: { type: 'object' },
  limits: { max_turns: 10, max_budget_usd: 1, timeout_s: 60 }, run_token: 'rt',
};

describe('validateTaskDocument', () => {
  it('accepts a well-formed document', () => {
    expect(validateTaskDocument(DOC)).toEqual({ ok: true, task: DOC });
  });
  it('accepts a null result_schema and missing limits', () => {
    const { limits: _l, ...rest } = DOC;
    expect(validateTaskDocument({ ...rest, result_schema: null }).ok).toBe(true);
  });
  it('names the field that is wrong', () => {
    expect(validateTaskDocument({ ...DOC, protocol: 'agentlink/2' })).toEqual({ ok: false, reason: 'protocol: unsupported' });
    expect(validateTaskDocument({ ...DOC, instructions: '' })).toEqual({ ok: false, reason: 'instructions: required' });
    expect(validateTaskDocument({ ...DOC, allowed_tools: 'x' })).toEqual({ ok: false, reason: 'allowed_tools: must be a list of strings' });
    expect(validateTaskDocument({ ...DOC, run_token: 3 })).toEqual({ ok: false, reason: 'run_token: required' });
    expect(validateTaskDocument(null)).toEqual({ ok: false, reason: 'document: not an object' });
  });
});

const doc = {
  protocol: 'agentlink/1', id: 't1', title: 'T', instructions: 'Do it.', mcp_servers: {}, allowed_tools: [],
  result_schema: null, run_token: 'r1',
};

describe('validatePairResponse', () => {
  const good = {
    device_id: 'dev_1', device_token: 'tok', poll_url: 'https://crm.example/api/agentlink/v1/poll',
    workspace: { id: 'w1', slug: 'acme', name: 'Acme' }, app: { name: 'Outreach CRM' },
  };
  it('accepts the documented shape', () => {
    expect(validatePairResponse(good)).toEqual({ ok: true, paired: good });
  });
  it.each([
    [{ ...good, device_token: '' }, 'device_token'],
    [{ ...good, poll_url: 'ftp://x' }, 'poll_url'],
    [{ ...good, poll_url: 'https://crm.example/poll?x=1' }, 'poll_url'],
    [{ ...good, workspace: { id: 'w1' } }, 'workspace'],
    ['nope', 'not an object'],
  ])('rejects %j', (raw, reason) => {
    const r = validatePairResponse(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(reason);
  });
});

describe('validatePollTask', () => {
  it('accepts a task document with an allowed task_url', () => {
    const r = validatePollTask({ task: doc, task_url: 'https://crm.example/api/agentlink/v1/tasks/t1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.taskUrl).toBe('https://crm.example/api/agentlink/v1/tasks/t1');
  });
  it.each([
    ['a non-https task_url', { task: doc, task_url: 'http://evil.example/t' }],
    ['a bad document', { task: { ...doc, run_token: '' }, task_url: 'https://crm.example/t' }],
  ])('rejects %s', (_label, raw) => {
    expect(validatePollTask(raw).ok).toBe(false);
  });
});
