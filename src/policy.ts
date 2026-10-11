import { BUILTIN_TOOLS_ALLOWED, LIMITS, MAX_MCP_SERVERS } from './config';
import type { TaskDocument } from './protocol';

export interface RunLimits { readonly maxTurns: number; readonly maxBudgetUsd: number; readonly timeoutS: number }

export interface RunPlan {
  /** Written to the temp dir as mcp.json and passed with --mcp-config --strict-mcp-config. */
  readonly mcpConfig: { mcpServers: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> };
  readonly allowedTools: readonly string[];
  readonly droppedTools: readonly string[];
  readonly limits: RunLimits;
}

export type PolicyResult = { ok: true; plan: RunPlan } | { ok: false; reason: string };

const FORBIDDEN_SERVER_KEYS = ['command', 'args', 'env'];

function isLocalDev(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/**
 * What an app may ask for (spec §3.3). The app cannot widen any of this: a
 * stdio server is arbitrary code execution, and a built-in tool beyond web
 * reads would hand the app the user's machine.
 */
export function applyPolicy(task: TaskDocument): PolicyResult {
  const names = Object.keys(task.mcp_servers);
  if (names.length > MAX_MCP_SERVERS) return { ok: false, reason: `mcp_servers: at most ${MAX_MCP_SERVERS} servers` };
  const mcpServers: RunPlan['mcpConfig']['mcpServers'] = {};
  for (const name of names) {
    const spec = task.mcp_servers[name] as unknown as Record<string, unknown>;
    if (FORBIDDEN_SERVER_KEYS.some((k) => k in spec) || spec.type === 'stdio' || typeof spec.url !== 'string') {
      return { ok: false, reason: `mcp_servers.${name}: only remote (url) servers are allowed` };
    }
    let url: URL;
    try { url = new URL(spec.url); } catch { return { ok: false, reason: `mcp_servers.${name}: url must be https` }; }
    if (url.protocol !== 'https:' && !isLocalDev(url)) return { ok: false, reason: `mcp_servers.${name}: url must be https` };
    const headers = spec.headers as Record<string, string> | undefined;
    mcpServers[name] = { type: 'http', url: spec.url, ...(headers ? { headers } : {}) };
  }

  const ownTool = (tool: string) => names.some((n) => tool === `mcp__${n}` || tool.startsWith(`mcp__${n}__`));
  const allowedTools = task.allowed_tools.filter((t) => ownTool(t) || BUILTIN_TOOLS_ALLOWED.includes(t));
  const droppedTools = task.allowed_tools.filter((t) => !allowedTools.includes(t));

  const clamp = (value: number | undefined, rule: { default: number; ceiling: number }) =>
    Math.min(value ?? rule.default, rule.ceiling);
  const limits: RunLimits = {
    maxTurns: Math.floor(clamp(task.limits?.max_turns, LIMITS.maxTurns)),
    maxBudgetUsd: clamp(task.limits?.max_budget_usd, LIMITS.maxBudgetUsd),
    timeoutS: clamp(task.limits?.timeout_s, LIMITS.timeoutS),
  };
  return { ok: true, plan: { mcpConfig: { mcpServers }, allowedTools, droppedTools, limits } };
}
