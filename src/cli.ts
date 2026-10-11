import { appendFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { LAUNCHER_NAME, LAUNCHER_VERSION, PATHS } from './config';
import { createAppClient, createTaskClient, PairError } from './client';
import { createDarwinPlatform, type DarwinPlatform } from './platform/darwin';
import { isAllowedTaskUrl, type LauncherInfo } from './protocol';
import { runTask } from './runner';
import { serve } from './serve';
import { createStore, type Store } from './store';

export type Command =
  | { cmd: 'install' } | { cmd: 'uninstall' } | { cmd: 'status' } | { cmd: 'serve' } | { cmd: 'help' }
  | { cmd: 'pair'; origin: string; code: string }
  | { cmd: 'unpair'; origin: string };

export function parseArgs(argv: readonly string[]): Command {
  const [a, b, c] = argv;
  if (a === 'install' || a === 'uninstall' || a === 'status' || a === 'serve') return { cmd: a };
  if (a === 'pair' && b && c) return { cmd: 'pair', origin: b, code: c };
  if (a === 'unpair' && b) return { cmd: 'unpair', origin: b };
  return { cmd: 'help' };
}

const HELP = `agentlink ${LAUNCHER_VERSION} — run app-dispatched agent tasks in Claude Code

  agentlink install                   find claude, start the background agent
  agentlink pair <origin> <code>      connect this Mac to an app (code from its Agent page)
  agentlink unpair <origin>           forget an app
  agentlink status                    what is installed, paired, and running
  agentlink uninstall                 stop the agent, remove it and the config
  agentlink serve                     the loop launchd runs; run by hand to watch it
`;

function fileLogger(name: string): (line: string) => void {
  // The log dir lives under the config dir, which holds the device token: keep the parent 0700.
  mkdirSync(PATHS.configDir, { recursive: true, mode: 0o700 });
  mkdirSync(PATHS.logDir, { recursive: true, mode: 0o700 });
  const path = join(PATHS.logDir, `${name.replace(/[^A-Za-z0-9_.-]/g, '_')}.log`);
  return (line) => appendFileSync(path, `${new Date().toISOString()} ${line}\n`);
}

async function launcherInfo(store: Store, platform: DarwinPlatform): Promise<LauncherInfo> {
  const claudePath = store.readConfig().claude_path;
  const claudeVersion = claudePath && existsSync(claudePath) ? await platform.claudeVersion(claudePath) : null;
  return { name: LAUNCHER_NAME, version: LAUNCHER_VERSION, platform: `${process.platform}-${process.arch}`, claude_version: claudeVersion };
}

const LAUNCHER_INFO_TTL_MS = 10 * 60_000;

/** serve calls this every cycle; `claude --version` is a subprocess, so answer from a cache for a while. */
function cachedLauncherInfo(store: Store, platform: DarwinPlatform): () => Promise<LauncherInfo> {
  let cached: { info: LauncherInfo; at: number } | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < LAUNCHER_INFO_TTL_MS) return cached.info;
    cached = { info: await launcherInfo(store, platform), at: Date.now() };
    return cached.info;
  };
}

function normaliseOrigin(raw: string): string | null {
  try {
    const origin = new URL(raw).origin;
    return isAllowedTaskUrl(origin) ? origin : null;
  } catch { return null; }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The compiled binary may be named `agentlink` or `agentlink-darwin-<arch>` (dist/), either registers itself. */
const BINARY_NAME = /agentlink(-darwin-\w+)?$/;

export async function main(argv: readonly string[]): Promise<number> {
  if (process.platform !== 'darwin') {
    process.stderr.write('agentlink currently supports macOS only.\n');
    return 1;
  }
  const command = parseArgs(argv);
  const platform = createDarwinPlatform();
  const store = createStore();
  const out = (s: string) => process.stdout.write(`${s}\n`);
  const err = (s: string) => process.stderr.write(`${s}\n`);

  switch (command.cmd) {
    case 'help':
      process.stdout.write(HELP);
      return 0;

    case 'install': {
      const claude = await platform.findClaude();
      if (!claude) {
        err('Claude Code was not found. Install it first (https://claude.ai/code), sign in, then run `agentlink install` again.');
        return 1;
      }
      store.writeConfig({ ...store.readConfig(), claude_path: claude });
      const binary = BINARY_NAME.test(process.execPath) ? process.execPath : PATHS.binary;
      if (!existsSync(binary)) {
        err(`${binary} does not exist. Put the release binary there (install.sh does), or run that binary's own \`install\`.`);
        return 1;
      }
      try {
        await platform.installLaunchAgent(binary);
      } catch (e) {
        err(`Could not start the background agent: ${message(e)}\nThe plist is at ${PATHS.launchAgentPlist}; if you are on ssh, run install from a logged-in Terminal.`);
        return 1;
      }
      out(`claude:  ${claude}\nagent:   ${PATHS.launchAgentPlist} (running)\nconfig:  ${PATHS.configDir}`);
      if (store.listDevices().length === 0) out('Next: open your app\'s Agent page, click "Connect a Mac", and run the pair command it shows.');
      return 0;
    }

    case 'pair': {
      // The client re-checks the scheme (PairError 'bad_origin'); this is the friendly message.
      const origin = normaliseOrigin(command.origin);
      if (!origin) { err('origin must be an https URL (http is allowed for localhost only)'); return 1; }
      let paired;
      try {
        paired = await createAppClient().pair(origin, { code: command.code, name: hostname().replace(/\.local$/, ''), launcher: await launcherInfo(store, platform) });
      } catch (e) {
        err(e instanceof PairError ? `Could not pair: ${e.message}` : `Could not pair: ${String(e)}`);
        return 1;
      }
      // One Mac holds one pairing per origin; the old device row stays "connected" on its page until disconnected there.
      const previous = store.listDevices().find((d) => d.origin === origin);
      if (previous) out(`Replacing the pairing for ${previous.app} · ${previous.workspace.name}; Disconnect this Mac on that workspace's Agent page too.`);
      try {
        store.addDevice({
          origin, app: paired.app.name, workspace: { slug: paired.workspace.slug, name: paired.workspace.name },
          device_id: paired.device_id, device_token: paired.device_token, poll_url: paired.poll_url, paired_at: new Date().toISOString(),
        });
      } catch (e) {
        // The app has consumed the code and minted a token we just lost; only a fresh code recovers.
        err(`Paired, but could not save ${PATHS.devicesFile} (${message(e)}); make a new code and pair again.`);
        return 1;
      }
      out(`Paired with ${paired.app.name} · ${paired.workspace.name}. The background agent picks it up within a few seconds.`);
      if (!(await platform.launchAgentLoaded())) out('The background agent is not running — run `agentlink install`.');
      return 0;
    }

    case 'unpair': {
      const origin = normaliseOrigin(command.origin) ?? command.origin;
      if (!store.listDevices().some((d) => d.origin === origin)) { out(`Nothing is paired with ${origin}.`); return 0; }
      store.removeDevice(origin);
      out(`Forgot ${origin}. Disconnect this Mac on its Agent page too, or it keeps a dead token.`);
      return 0;
    }

    case 'status': {
      const config = store.readConfig();
      const info = await launcherInfo(store, platform);
      const devices = store.listDevices();
      out([
        `agentlink ${LAUNCHER_VERSION}`,
        `claude:   ${config.claude_path ?? '(not configured — run agentlink install)'}${info.claude_version ? ` (${info.claude_version})` : ''}`,
        `agent:    ${(await platform.launchAgentLoaded()) ? 'running' : '(not running — run agentlink install)'}`,
        `paired:   ${devices.length ? '' : '(none — pair from an Agent page)'}`,
        ...devices.map((d) => `          ${d.app} · ${d.workspace.name} · ${d.origin} · since ${d.paired_at.slice(0, 10)}`),
        `logs:     ${PATHS.logDir}`,
      ].join('\n'));
      return 0;
    }

    case 'serve': {
      const log = fileLogger('serve');
      const abort = new AbortController();
      for (const sig of ['SIGTERM', 'SIGINT'] as const) {
        process.on(sig, () => {
          if (abort.signal.aborted) process.exit(130); // second Ctrl-C: do not wait for the running task to wind down
          log(`${sig}: stopping`);
          abort.abort();
        });
      }
      log(`agentlink ${LAUNCHER_VERSION} serving`);
      await serve({
        store,
        app: createAppClient(),
        launcher: cachedLauncherInfo(store, platform),
        notify: (t, x) => platform.notify(t, x),
        log,
        runner: (task, taskUrl) => runTask(
          { client: createTaskClient(taskUrl), store, platform, log: fileLogger(task.id), abort: abort.signal },
          { task, taskUrl },
        ),
      }, abort.signal);
      log('stopped');
      return 0;
    }

    case 'uninstall':
      try {
        await platform.uninstallLaunchAgent();
      } catch (e) {
        err(`Could not stop the background agent: ${message(e)}\nThe plist is at ${PATHS.launchAgentPlist}; if you are on ssh, run uninstall from a logged-in Terminal.`);
        return 1;
      }
      rmSync(PATHS.configDir, { recursive: true, force: true });
      out(`Removed the background agent and ${PATHS.configDir}. Disconnect this Mac on each app's Agent page too.`);
      return 0;
  }
}
