import { describe, expect, it } from 'vitest';
import { applyPolicy } from '../src/policy';
import type { TaskDocument } from '../src/protocol';

const base: TaskDocument = {
  protocol: 'agentlink/1', id: 't', title: 'T', instructions: 'go',
  mcp_servers: { crm: { url: 'https://crm.example/mcp', headers: { Authorization: 'Bearer x' } } },
  allowed_tools: ['mcp__crm__*', 'WebSearch'], result_schema: null, run_token: 'rt',
};

describe('applyPolicy', () => {
  it('builds an http-only mcp config and keeps the allowed tools', () => {
    const r = applyPolicy(base);
    expect(r).toMatchObject({
      ok: true,
      plan: {
        mcpConfig: { mcpServers: { crm: { type: 'http', url: 'https://crm.example/mcp', headers: { Authorization: 'Bearer x' } } } },
        allowedTools: ['mcp__crm__*', 'WebSearch'],
        droppedTools: [],
        limits: { maxTurns: 40, maxBudgetUsd: 5, timeoutS: 900 },
      },
    });
  });
  it('rejects a stdio server however it is spelled', () => {
    for (const spec of [{ command: 'evil' }, { url: 'https://x', command: 'evil' }, { url: 'https://x', type: 'stdio' }, { url: 'https://x', args: [] }, { url: 'https://x', env: {} }]) {
      const r = applyPolicy({ ...base, mcp_servers: { bad: spec as never } });
      expect(r).toEqual({ ok: false, reason: 'mcp_servers.bad: only remote (url) servers are allowed' });
    }
  });
  it('rejects plain http to a remote host and more than four servers', () => {
    expect(applyPolicy({ ...base, mcp_servers: { bad: { url: 'http://crm.example/mcp' } } })).toEqual({ ok: false, reason: 'mcp_servers.bad: url must be https' });
    const many = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((n) => [n, { url: `https://${n}.example/mcp` }]));
    expect(applyPolicy({ ...base, mcp_servers: many })).toEqual({ ok: false, reason: 'mcp_servers: at most 4 servers' });
  });
  it('allows localhost http for development', () => {
    expect(applyPolicy({ ...base, mcp_servers: { dev: { url: 'http://localhost:3002/mcp' } }, allowed_tools: ['mcp__dev__*'] }).ok).toBe(true);
  });
  it('drops tools the app does not own and every non-web builtin', () => {
    const r = applyPolicy({ ...base, allowed_tools: ['mcp__crm__get_company', 'mcp__crm', 'mcp__other__*', 'Bash', 'Edit', 'WebFetch', 'mcp__*'] });
    expect(r.ok && r.plan.allowedTools).toEqual(['mcp__crm__get_company', 'mcp__crm', 'WebFetch']);
    expect(r.ok && r.plan.droppedTools).toEqual(['mcp__other__*', 'Bash', 'Edit', 'mcp__*']);
  });
  it('clamps limits to the ceilings and fills defaults', () => {
    const r = applyPolicy({ ...base, limits: { max_turns: 500, max_budget_usd: 99, timeout_s: 10 } });
    expect(r.ok && r.plan.limits).toEqual({ maxTurns: 60, maxBudgetUsd: 10, timeoutS: 10 });
  });
});
