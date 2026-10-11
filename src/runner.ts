import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CLAUDE_FIXED_ARGS, TIMINGS } from './config';
import type { TaskClient } from './client';
import { applyPolicy, type RunPlan } from './policy';
import type { CompletionBody, Outcome, TaskDocument } from './protocol';
import type { Store } from './store';

/** The OS-specific surface the runner needs; platform/darwin.ts implements it, tests stub it. */
export interface Platform {
  notify(title: string, text: string): Promise<void>;
  showError(text: string): Promise<void>;
  claudeVersion(claudePath: string): Promise<string | null>;
}

export interface RunnerDeps {
  client: TaskClient;
  store: Store;
  platform: Platform;
  timings?: Partial<Record<'heartbeatMs' | 'eventFlushMs' | 'eventFlushBytes' | 'killGraceMs', number>>;
  log: (line: string) => void;
  /** Parent of the per-run empty working directory; defaults to the OS temp dir. */
  workDirRoot?: string;
  /** Extra environment for the child (tests use it to steer fake-claude). */
  env?: NodeJS.ProcessEnv;
  /** Daemon shutdown: kills the child and completes failed/daemon_stopped. */
  abort?: AbortSignal;
}

export interface Run { task: TaskDocument; taskUrl: string }

interface ResultEvent {
  subtype?: string; is_error?: boolean; result?: string; structured_output?: unknown;
  total_cost_usd?: number; num_turns?: number; session_id?: string;
}

interface ChildExit { code: number | null; signal: NodeJS.Signals | null }

const EXIT_OK = 0;
const EXIT_FAILED = 1;

function completion(partial: Partial<CompletionBody> & { outcome: Outcome }): CompletionBody {
  return {
    exit_code: null, result_text: '', structured_output: null, total_cost_usd: 0, num_turns: 0, session_id: null, error: null,
    ...partial,
  };
}

function claudeArgs(plan: RunPlan, task: TaskDocument, mcpConfigPath: string, model: string | undefined): string[] {
  const args = [...CLAUDE_FIXED_ARGS, '--mcp-config', mcpConfigPath];
  if (plan.allowedTools.length > 0) args.push('--allowedTools', plan.allowedTools.join(' '));
  args.push('--max-turns', String(plan.limits.maxTurns), '--max-budget-usd', String(plan.limits.maxBudgetUsd));
  if (task.result_schema) args.push('--json-schema', JSON.stringify(task.result_schema));
  if (model) args.push('--model', model);
  return args;
}

/**
 * One claimed task, start to finish (spec §3.3): heartbeat → policy → spawn →
 * stream → complete. The daemon already holds the document; this never talks
 * to the app except through the task URL. Returns 0 for done/cancelled, 1 otherwise.
 */
export async function runTask(deps: RunnerDeps, run: Run): Promise<number> {
  const timings = { ...TIMINGS, ...deps.timings };
  const { task, taskUrl } = run;
  const origin = new URL(taskUrl).origin;
  const config = deps.store.readConfig();
  const claudePath = config.claude_path ?? '';
  const runToken = task.run_token;

  // 1. Heartbeat for the rest of the run; any terminal answer (cancelled, lost, expired, …)
  //    kills the child. The completion still says `cancelled` — the app keeps its own status.
  let cancelled = false;
  let child: ReturnType<typeof spawn> | null = null;
  const kill = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const c = child;
    setTimeout(() => { if (c.exitCode === null) c.kill('SIGKILL'); }, timings.killGraceMs).unref();
  };
  const heartbeat = setInterval(async () => {
    const status = await deps.client.status(runToken);
    if (status && status !== 'claimed' && status !== 'running') { cancelled = true; kill(); }
  }, timings.heartbeatMs);
  heartbeat.unref();

  let stopped = false;
  const onAbort = () => { stopped = true; kill(); };
  if (deps.abort?.aborted) onAbort(); else deps.abort?.addEventListener('abort', onAbort, { once: true });

  const finish = async (body: CompletionBody, code: number): Promise<number> => {
    deps.abort?.removeEventListener('abort', onAbort);
    clearInterval(heartbeat);
    const landed = await deps.client.complete(runToken, body);
    if (!landed) deps.log(`completion did not reach ${origin}: ${JSON.stringify(body)}`);
    return code;
  };

  try {
    // A shutdown that landed before we got here: no dialog, no spawn.
    if (stopped) return await finish(completion({ outcome: 'failed', error: 'daemon_stopped' }), EXIT_FAILED);

    // 2. Policy.
    const policy = applyPolicy(task);
    if (!policy.ok) {
      deps.log(`task rejected: ${policy.reason}`);
      await deps.platform.showError(`${origin} asked for something this launcher does not allow: ${policy.reason}`);
      return await finish(completion({ outcome: 'failed', error: `task_rejected: ${policy.reason}` }), EXIT_FAILED);
    }
    const plan = policy.plan;
    if (plan.droppedTools.length > 0) deps.log(`dropped tools not allowed by policy: ${plan.droppedTools.join(', ')}`);
    if (!claudePath || !existsSync(claudePath)) {
      await deps.platform.showError('Claude Code is not installed, or agentlink cannot find it. Run `agentlink install` after installing Claude Code.');
      return await finish(completion({ outcome: 'failed', error: 'claude_not_found' }), EXIT_FAILED);
    }

    // 3. Spawn in an empty directory with only the task's servers.
    const workDir = mkdtempSync(join(deps.workDirRoot ?? tmpdir(), 'agentlink-run-'));
    let lastResult: ResultEvent | null = null;
    let spawnError: string | null = null;
    let timedOut = false;
    let stoppedDuringRun = false;
    let exit: ChildExit = { code: null, signal: null };
    try {
      const mcpConfigPath = join(workDir, 'mcp.json');
      writeFileSync(mcpConfigPath, JSON.stringify(plan.mcpConfig), { mode: 0o600 });
      const args = claudeArgs(plan, task, mcpConfigPath, config.model);
      deps.log(`spawning ${claudePath} ${args.join(' ')}`);
      child = spawn(claudePath, args, { cwd: workDir, env: { ...process.env, ...deps.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      // EPIPE when claude exits before draining a large prompt; unhandled, it would kill the launcher before completion.
      child.stdin!.on('error', (e) => deps.log(`stdin: ${e.message}`));
      child.stdin!.end(task.instructions);
      child.stderr!.on('data', (chunk: Buffer) => deps.log(`claude: ${chunk.toString().trimEnd()}`));

      // 4. Stream stdout lines to the app in small batches.
      let pending: string[] = [];
      let pendingBytes = 0;
      let flushing = Promise.resolve();
      const flush = () => {
        if (pending.length === 0) return;
        const batch = pending; pending = []; pendingBytes = 0;
        flushing = flushing.then(async () => {
          const ok = await deps.client.postEvents(runToken, batch);
          if (!ok) deps.log(`dropped ${batch.length} events after retries`);
        });
      };
      const flushTimer = setInterval(flush, timings.eventFlushMs);
      flushTimer.unref();
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', (line) => {
        pending.push(line);
        pendingBytes += line.length;
        try {
          const event = JSON.parse(line) as { type?: string } & ResultEvent;
          if (event.type === 'result') lastResult = event;
        } catch { /* a non-JSON line is still forwarded */ }
        if (pendingBytes >= timings.eventFlushBytes) flush();
      });

      // 5. Timeout.
      const timeout = setTimeout(() => { timedOut = true; kill(); }, plan.limits.timeoutS * 1000);
      timeout.unref();

      exit = await new Promise<ChildExit>((resolve) => {
        child!.on('error', (err) => { spawnError = err.message; deps.log(`spawn error: ${err.message}`); resolve({ code: null, signal: null }); });
        child!.on('close', (code, signal) => resolve({ code, signal }));
      });
      // An abort after claude already exited must not turn a finished run into daemon_stopped.
      stoppedDuringRun = stopped;
      clearTimeout(timeout);
      clearInterval(flushTimer);
      // All lines read: readline emits `close` when stdout ends, but if stdout already ended waiting would hang.
      await new Promise<void>((r) => { if (child!.stdout!.readableEnded) r(); else lines.once('close', r); });
      flush();
      await flushing;
    } finally {
      rmSync(workDir, { recursive: true, force: true }); // the MCP bearer in mcp.json never outlives the run
    }

    // 6. Complete.
    const r: ResultEvent = lastResult ?? {};
    const exitCode = exit.code;
    const ok = exitCode === 0 && r.is_error !== true && !cancelled && !timedOut && !stoppedDuringRun;
    const outcome: Outcome = stoppedDuringRun ? 'failed' : cancelled ? 'cancelled' : ok ? 'done' : 'failed';
    const error = stoppedDuringRun ? 'daemon_stopped'
      : cancelled ? null
      : timedOut ? 'timeout'
      : r.is_error ? (r.subtype ?? 'error')
      : exitCode !== 0 ? (spawnError ?? `exit ${exitCode ?? exit.signal}`) : null;
    const body = completion({
      outcome, exit_code: exitCode, result_text: r.result ?? '', structured_output: r.structured_output ?? null,
      total_cost_usd: r.total_cost_usd ?? 0, num_turns: r.num_turns ?? 0, session_id: r.session_id ?? null, error,
    });
    const cost = body.total_cost_usd ? ` · $${body.total_cost_usd.toFixed(2)}` : '';
    const notice = outcome === 'done' ? `Done${cost}` : outcome === 'cancelled' ? 'Stopped' : `Failed: ${error}${cost}`;
    // A failed notification (e.g. permission denied on first run) must not turn a finished run into a failure.
    try { await deps.platform.notify(task.title, notice); } catch (e) { deps.log(`notify failed: ${String(e)}`); }
    return await finish(body, outcome === 'done' || outcome === 'cancelled' ? EXIT_OK : EXIT_FAILED);
  } catch (err) {
    deps.log(`runner error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    kill();
    return await finish(completion({ outcome: 'failed', error: err instanceof Error ? err.message : String(err) }), EXIT_FAILED);
  }
}
