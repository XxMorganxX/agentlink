import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CLAUDE_CANDIDATES, LAUNCHD_LABEL, PATHS } from '../config';
import type { Platform } from '../runner';
import manifest from '../../launchd/agentlink.registry.json';

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

const realExec: Exec = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    const raw = (err as { code?: unknown } | null)?.code;
    const code = typeof raw === 'number' ? raw : err ? 1 : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The launchd agent: `<binary> serve`, always on (spec §3.2). */
export function launchAgentPlist(binaryPath: string, logDir: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(binaryPath)}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>90</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(logDir)}/launchd.log</string>
  <key>StandardErrorPath</key><string>${xml(logDir)}/launchd.log</string>
</dict>
</plist>
`;
}

/** The background-systems registry entry (CLAUDE.md rule); the JSON file is the source of truth. */
export function registryManifest(now: Date): Record<string, unknown> {
  return { ...manifest, registeredAt: now.toISOString() };
}

export interface DarwinPlatform extends Platform {
  findClaude(): Promise<string | null>;
  installLaunchAgent(binaryPath: string): Promise<void>;
  uninstallLaunchAgent(): Promise<void>;
  launchAgentLoaded(): Promise<boolean>;
}

export interface DarwinDeps {
  exec?: Exec;
  exists?: (p: string) => boolean;
  writeFile?: (path: string, text: string) => void;
  remove?: (path: string) => void;
  ensureDir?: (path: string) => void;
  uid?: number;
}

export function createDarwinPlatform(deps: DarwinDeps = {}): DarwinPlatform {
  const exec = deps.exec ?? realExec;
  const exists = deps.exists ?? existsSync;
  const ensureDir = deps.ensureDir ?? ((path: string) => mkdirSync(path, { recursive: true }));
  const writeFile = deps.writeFile ?? ((path: string, text: string) => { ensureDir(dirname(path)); writeFileSync(path, text); });
  const remove = deps.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  const uid = deps.uid ?? process.getuid?.() ?? 501;
  const domain = `gui/${uid}`;

  /** 0.1 left an AppleScript applet and a trusted-origins file; neither has a 0.2 meaning. */
  const removeLegacy = async () => {
    const trusted = join(PATHS.configDir, 'trusted.json');
    if (exists(trusted)) remove(trusted);
    if (!exists(PATHS.legacyApplet)) return;
    await exec(LSREGISTER, ['-u', PATHS.legacyApplet]);
    remove(PATHS.legacyApplet);
  };

  return {
    async notify(title, text) {
      await exec('/usr/bin/osascript', ['-e', `display notification "${esc(text)}" with title "AgentLink" subtitle "${esc(title)}"`]);
    },
    async showError(text) {
      // `giving up after` dismisses the dialog unattended; a daemon must never block on a prompt (spec §3.3).
      await exec('/usr/bin/osascript', ['-e', `display dialog "${esc(text)}" with title "AgentLink" buttons {"OK"} default button "OK" with icon stop giving up after 30`]);
    },
    async claudeVersion(claudePath) {
      const r = await exec(claudePath, ['--version']);
      const m = r.stdout.match(/\d+\.\d+\.\d+/);
      return r.code === 0 && m ? m[0] : null;
    },
    async findClaude() {
      const hit = CLAUDE_CANDIDATES.find((p) => exists(p));
      if (hit) return hit;
      const r = await exec('/bin/zsh', ['-lc', 'command -v claude']);
      const path = r.stdout.trim().split('\n').pop() ?? '';
      return r.code === 0 && path.startsWith('/') ? path : null;
    },
    async installLaunchAgent(binaryPath) {
      await removeLegacy();
      ensureDir(PATHS.logDir); // launchd creates the log file but not its directory
      writeFile(PATHS.launchAgentPlist, launchAgentPlist(binaryPath, PATHS.logDir));
      writeFile(PATHS.registryManifest, `${JSON.stringify(registryManifest(new Date()), null, 2)}\n`);
      await exec('/bin/launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]); // not loaded yet is fine
      const r = await exec('/bin/launchctl', ['bootstrap', domain, PATHS.launchAgentPlist]);
      if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr || r.stdout}`);
    },
    async uninstallLaunchAgent() {
      await exec('/bin/launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
      remove(PATHS.launchAgentPlist);
      remove(PATHS.registryManifest);
      await removeLegacy();
    },
    /** Loaded *and* running: a loaded agent whose binary keeps crashing is not "running". */
    async launchAgentLoaded() {
      const r = await exec('/bin/launchctl', ['print', `${domain}/${LAUNCHD_LABEL}`]);
      return r.code === 0 && /state = running/.test(r.stdout);
    },
  };
}
