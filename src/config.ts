import { homedir } from 'node:os';
import { join } from 'node:path';

/** Every tunable the launcher has, in one place (spec §3). */
export const LAUNCHER_NAME = 'agentlink';
export const LAUNCHER_VERSION = '0.2.0';
export const PROTOCOL = 'agentlink/1';
export const LAUNCHD_LABEL = 'com.stuart-labs.agentlink';

const configDir = join(homedir(), '.config', 'agentlink');
export const PATHS = {
  configDir,
  configFile: join(configDir, 'config.json'),
  devicesFile: join(configDir, 'devices.json'),
  logDir: join(configDir, 'logs'),
  binary: join(homedir(), '.local', 'bin', 'agentlink'),
  launchAgentPlist: join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
  registryManifest: join(homedir(), '.config', 'background-systems', 'registry', 'agentlink.json'),
  /** 0.1 installed an AppleScript applet for the URL scheme; `install` removes it. */
  legacyApplet: join(homedir(), 'Applications', 'AgentLink.app'),
} as const;

/** Where `claude` usually is when launchd runs us without a login shell. */
export const CLAUDE_CANDIDATES = [
  join(homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
] as const;

/** Built-in Claude Code tools an app may grant besides its own MCP tools. */
export const BUILTIN_TOOLS_ALLOWED: readonly string[] = ['WebSearch', 'WebFetch'];

export const MAX_MCP_SERVERS = 4;

/** The user's ceilings; an app's limits are clamped to these. */
export const LIMITS = {
  maxTurns: { default: 40, ceiling: 60 },
  maxBudgetUsd: { default: 5, ceiling: 10 },
  timeoutS: { default: 900, ceiling: 1800 },
} as const;

export const TIMINGS = {
  heartbeatMs: 5_000,
  eventFlushMs: 500,
  eventFlushBytes: 64 * 1024,
  eventPostRetries: 3,
  completeRetryWindowMs: 60_000,
  retryBaseMs: 1_000,
  killGraceMs: 5_000,
  httpTimeoutMs: 15_000,
  /** Poll cadence when the app sends no Retry-After, and the bounds we clamp its value to. */
  pollDefaultMs: 3_000,
  pollMinMs: 1_000,
  pollMaxMs: 60_000,
  /** After a failed poll: first wait, doubling to the cap. */
  backoffBaseMs: 5_000,
  backoffMaxMs: 60_000,
} as const;

export const CLAUDE_FIXED_ARGS: readonly string[] = [
  '-p',
  '--output-format', 'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--strict-mcp-config',
  '--permission-mode', 'dontAsk',
  '--permission-prompts', 'none',
];
