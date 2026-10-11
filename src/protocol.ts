import { PROTOCOL } from './config';

/** The dispatch contract (spec §2). Exported for applications that implement the server side. */
export interface McpServerSpec {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface TaskLimits {
  readonly max_turns?: number;
  readonly max_budget_usd?: number;
  readonly timeout_s?: number;
}

export interface TaskDocument {
  readonly protocol: string;
  readonly id: string;
  readonly title: string;
  readonly instructions: string;
  readonly mcp_servers: Readonly<Record<string, McpServerSpec>>;
  readonly allowed_tools: readonly string[];
  readonly result_schema: Readonly<Record<string, unknown>> | null;
  readonly limits?: TaskLimits;
  readonly run_token: string;
}

export interface LauncherInfo {
  readonly name: string;
  readonly version: string;
  readonly platform: string;
  readonly claude_version: string | null;
}

/** `POST <origin>` + this path (spec §2.1). */
export const PAIR_PATH = '/api/agentlink/v1/pair';

/** The pair request body. */
export interface PairRequest { readonly code: string; readonly name: string; readonly launcher: LauncherInfo }

export interface PairResponse {
  readonly device_id: string;
  readonly device_token: string;
  readonly poll_url: string;
  readonly workspace: { readonly id: string; readonly slug: string; readonly name: string };
  readonly app: { readonly name: string };
}

/** `POST <poll_url>` (spec §2.2): the body, and the 200 answer. */
export interface PollRequest { readonly launcher: LauncherInfo }
export interface PollTask { readonly task: TaskDocument; readonly task_url: string }

export type TaskStatus =
  | 'queued' | 'claimed' | 'running'
  | 'done' | 'failed' | 'cancelled' | 'declined' | 'lost' | 'expired';

export type Outcome = 'done' | 'failed' | 'cancelled' | 'declined';

export interface CompletionBody {
  readonly outcome: Outcome;
  readonly exit_code: number | null;
  readonly result_text: string;
  readonly structured_output: unknown | null;
  readonly total_cost_usd: number;
  readonly num_turns: number;
  readonly session_id: string | null;
  readonly error: string | null;
}

/** https anywhere; http only to the developer's own machine. */
export function isAllowedTaskUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  // The client appends /events and /complete to a task URL, so a query or fragment would corrupt it; a poll URL gets the same rule.
  if (url.search !== '' || url.hash !== '') return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

type Validation = { ok: true; task: TaskDocument } | { ok: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Shape only. What the app may ask for is policy.ts's job. */
export function validateTaskDocument(raw: unknown): Validation {
  if (!isRecord(raw)) return { ok: false, reason: 'document: not an object' };
  if (raw.protocol !== PROTOCOL) return { ok: false, reason: 'protocol: unsupported' };
  if (!nonEmptyString(raw.id)) return { ok: false, reason: 'id: required' };
  if (!nonEmptyString(raw.title)) return { ok: false, reason: 'title: required' };
  if (!nonEmptyString(raw.instructions)) return { ok: false, reason: 'instructions: required' };
  if (!isRecord(raw.mcp_servers)) return { ok: false, reason: 'mcp_servers: must be an object' };
  for (const [name, spec] of Object.entries(raw.mcp_servers)) {
    if (!isRecord(spec) || !nonEmptyString(spec.url)) return { ok: false, reason: `mcp_servers.${name}: url required` };
    if (spec.headers !== undefined && (!isRecord(spec.headers) || Object.values(spec.headers).some((h) => typeof h !== 'string'))) {
      return { ok: false, reason: `mcp_servers.${name}: headers must be strings` };
    }
  }
  if (!Array.isArray(raw.allowed_tools) || raw.allowed_tools.some((t) => typeof t !== 'string')) {
    return { ok: false, reason: 'allowed_tools: must be a list of strings' };
  }
  if (raw.result_schema !== null && !isRecord(raw.result_schema)) return { ok: false, reason: 'result_schema: must be an object or null' };
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) return { ok: false, reason: 'limits: must be an object' };
    for (const key of ['max_turns', 'max_budget_usd', 'timeout_s']) {
      const v = raw.limits[key];
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) return { ok: false, reason: `limits.${key}: must be a positive number` };
    }
  }
  if (!nonEmptyString(raw.run_token)) return { ok: false, reason: 'run_token: required' };
  return { ok: true, task: raw as unknown as TaskDocument };
}

export function validatePairResponse(raw: unknown): { ok: true; paired: PairResponse } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'pair: not an object' };
  if (!nonEmptyString(raw.device_id)) return { ok: false, reason: 'device_id: required' };
  if (!nonEmptyString(raw.device_token)) return { ok: false, reason: 'device_token: required' };
  if (!nonEmptyString(raw.poll_url) || !isAllowedTaskUrl(raw.poll_url)) return { ok: false, reason: 'poll_url: must be https (or localhost http) without a query' };
  const ws = raw.workspace;
  if (!isRecord(ws) || !nonEmptyString(ws.id) || !nonEmptyString(ws.slug) || !nonEmptyString(ws.name)) return { ok: false, reason: 'workspace: id, slug and name required' };
  const app = raw.app;
  if (!isRecord(app) || !nonEmptyString(app.name)) return { ok: false, reason: 'app: name required' };
  return { ok: true, paired: raw as unknown as PairResponse };
}

export function validatePollTask(raw: unknown): { ok: true; task: TaskDocument; taskUrl: string } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: 'poll: not an object' };
  if (!nonEmptyString(raw.task_url) || !isAllowedTaskUrl(raw.task_url)) return { ok: false, reason: 'task_url: must be https (or localhost http) without a query' };
  const task = validateTaskDocument(raw.task);
  if (!task.ok) return task;
  return { ok: true, task: task.task, taskUrl: raw.task_url };
}
