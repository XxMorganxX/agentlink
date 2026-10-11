import { describe, expect, it } from 'vitest';
import { launchAgentPlist, registryManifest, createDarwinPlatform } from '../src/platform/darwin';

describe('findClaude', () => {
  it('prefers an existing candidate, then the login shell', async () => {
    const calls: string[][] = [];
    const platform = createDarwinPlatform({
      exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '/from/shell/claude\n', stderr: '' }; },
      exists: (p) => p === '/opt/homebrew/bin/claude',
    });
    expect(await platform.findClaude()).toBe('/opt/homebrew/bin/claude');
    expect(calls).toEqual([]); // a known candidate never shells out
    const none = createDarwinPlatform({
      exec: async () => ({ code: 0, stdout: '/from/shell/claude\n', stderr: '' }),
      exists: () => false,
    });
    expect(await none.findClaude()).toBe('/from/shell/claude');
  });
  it('reads the version from `claude --version`', async () => {
    const platform = createDarwinPlatform({ exec: async () => ({ code: 0, stdout: '2.1.295 (Claude Code)\n', stderr: '' }), exists: () => true });
    expect(await platform.claudeVersion('/x/claude')).toBe('2.1.295');
  });
  it('claudeVersion is null when claude exits non-zero', async () => {
    const platform = createDarwinPlatform({ exec: async () => ({ code: 1, stdout: '2.1.295', stderr: '' }), exists: () => true });
    expect(await platform.claudeVersion('/x/claude')).toBeNull();
  });
});

describe('showError', () => {
  it('dialog gives up after 30 s so an unattended daemon never blocks on it', async () => {
    const calls: string[][] = [];
    const platform = createDarwinPlatform({ exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; }, exists: () => true });
    await platform.showError('claude is "gone"');
    expect(calls[0]![0]).toBe('/usr/bin/osascript');
    const script = calls[0]![2]!;
    expect(script).toContain('display dialog "claude is \\"gone\\""');
    expect(script).toMatch(/giving up after 30$/);
  });
});

describe('launchd', () => {
  it('plist runs `<binary> serve`, at load, kept alive, in the background, logging to the log dir', () => {
    const xml = launchAgentPlist('/Users/me/.local/bin/agentlink', '/Users/me/.config/agentlink/logs');
    for (const part of [
      '<string>com.stuart-labs.agentlink</string>', '<string>/Users/me/.local/bin/agentlink</string>', '<string>serve</string>',
      '<key>RunAtLoad</key>', '<key>KeepAlive</key>', '<key>ThrottleInterval</key>', '<integer>10</integer>',
      '<key>ExitTimeOut</key><integer>90</integer>', // the completion retry window is 60 s; launchd's default 20 s would SIGKILL mid-retry
      '<key>ProcessType</key>', '<string>Background</string>', '/Users/me/.config/agentlink/logs/launchd.log',
    ]) expect(xml).toContain(part);
    expect(launchAgentPlist('/a&b/agentlink', '/l')).toContain('/a&amp;b/agentlink');
  });
  it('manifest carries the registry fields, a logs list and a registeredAt stamp', () => {
    const m = registryManifest(new Date('2026-10-09T12:00:00Z'));
    expect(m).toMatchObject({ id: 'agentlink', kind: 'launchd-agent', launchdLabel: 'com.stuart-labs.agentlink', registeredAt: '2026-10-09T12:00:00.000Z' });
    expect((m.description as string).length).toBeGreaterThanOrEqual(40);
    expect(Array.isArray(m.logs)).toBe(true);
  });

  /** A platform whose side effects are recorded; `exists` decides which legacy files are present. */
  function fakePlatform(opts: { exists?: (p: string) => boolean; exec?: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string } } = {}) {
    const calls: string[][] = [];
    const written: string[] = [];
    const removed: string[] = [];
    const p = createDarwinPlatform({
      exec: async (cmd, args) => { calls.push([cmd, ...args]); return opts.exec?.(cmd, args) ?? { code: 0, stdout: '', stderr: '' }; },
      exists: opts.exists ?? (() => false),
      writeFile: (path) => { written.push(path); },
      remove: (path) => { removed.push(path); },
      ensureDir: () => {},
      uid: 501,
    });
    return { p, calls, written, removed };
  }

  it('install writes the plist and manifest, then boots the agent out and in', async () => {
    const { p, calls, written } = fakePlatform();
    await p.installLaunchAgent('/Users/me/.local/bin/agentlink');
    expect(written.some((w) => w.endsWith('com.stuart-labs.agentlink.plist'))).toBe(true);
    expect(written.some((w) => w.endsWith('registry/agentlink.json'))).toBe(true);
    expect(calls).toEqual([
      ['/bin/launchctl', 'bootout', 'gui/501/com.stuart-labs.agentlink'],
      ['/bin/launchctl', 'bootstrap', 'gui/501', expect.stringContaining('com.stuart-labs.agentlink.plist')],
    ]);
  });
  it('install removes a 0.1 applet (unregistering it first) and a 0.1 trusted.json', async () => {
    const { p, calls, removed } = fakePlatform({ exists: (path) => path.endsWith('AgentLink.app') || path.endsWith('trusted.json') });
    await p.installLaunchAgent('/Users/me/.local/bin/agentlink');
    expect(removed.some((r) => r.endsWith('AgentLink.app'))).toBe(true);
    expect(removed.some((r) => r.endsWith('/agentlink/trusted.json'))).toBe(true);
    expect(calls.some((c) => c[0]?.endsWith('lsregister') && c[1] === '-u')).toBe(true);
  });
  it('install never calls lsregister when there is no applet', async () => {
    const { p, calls } = fakePlatform();
    await p.installLaunchAgent('/Users/me/.local/bin/agentlink');
    expect(calls.some((c) => c[0]?.endsWith('lsregister'))).toBe(false);
  });
  it('install throws with launchctl stderr when bootstrap fails', async () => {
    const { p } = fakePlatform({ exec: (_cmd, args) => (args[0] === 'bootstrap' ? { code: 5, stdout: '', stderr: 'Input/output error' } : { code: 0, stdout: '', stderr: '' }) });
    await expect(p.installLaunchAgent('/Users/me/.local/bin/agentlink')).rejects.toThrow(/bootstrap failed: Input\/output error/);
  });
  it('uninstall boots out and removes plist + manifest', async () => {
    const calls: string[][] = [];
    const removed: string[] = [];
    const p = createDarwinPlatform({ exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; }, exists: () => true, remove: (x) => { removed.push(x); }, writeFile: () => {}, ensureDir: () => {}, uid: 501 });
    await p.uninstallLaunchAgent();
    expect(calls[0]).toEqual(['/bin/launchctl', 'bootout', 'gui/501/com.stuart-labs.agentlink']);
    expect(removed.filter((r) => r.endsWith('.plist') || r.endsWith('agentlink.json')).length).toBe(2);
  });
  it('launchAgentLoaded is true only when launchctl print shows a running state', async () => {
    const yes = createDarwinPlatform({ exec: async () => ({ code: 0, stdout: 'com.stuart-labs.agentlink = {\n\tstate = running\n\tpid = 4242\n}', stderr: '' }), exists: () => true, uid: 501 });
    expect(await yes.launchAgentLoaded()).toBe(true);
    const loadedNotRunning = createDarwinPlatform({ exec: async () => ({ code: 0, stdout: 'state = not running\nlast exit code = 1', stderr: '' }), exists: () => true, uid: 501 });
    expect(await loadedNotRunning.launchAgentLoaded()).toBe(false);
    const no = createDarwinPlatform({ exec: async () => ({ code: 113, stdout: '', stderr: 'Could not find service' }), exists: () => true, uid: 501 });
    expect(await no.launchAgentLoaded()).toBe(false);
  });
});
