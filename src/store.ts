import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PATHS } from './config';

export interface LauncherConfig {
  /** Absolute path to the claude binary, resolved at install time. */
  claude_path?: string;
  /** Passed as --model when set; unset means Claude Code's default. */
  model?: string;
}

/** One paired app + workspace (spec §3.2). The token is shown once by the app; this file is its only copy. */
export interface Device {
  origin: string;
  app: string;
  workspace: { slug: string; name: string };
  device_id: string;
  device_token: string;
  poll_url: string;
  paired_at: string;
}

export interface Store {
  readConfig(): LauncherConfig;
  writeConfig(config: LauncherConfig): void;
  listDevices(): Device[];
  /** Replaces an existing device for the same origin. */
  addDevice(device: Device): void;
  removeDevice(origin: string): void;
}

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; }
}

function writeJson(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // the dir may pre-exist wider (the log dir is created under it)
  // Write a temp file then rename, so a crash never leaves a half-written token file;
  // `mode` only applies on create, hence the chmod.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function isDevice(v: unknown): v is Device {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  const ws = d.workspace as Record<string, unknown> | undefined;
  return str(d.origin) && str(d.app) && str(d.device_id) && str(d.device_token) && str(d.poll_url) && str(d.paired_at)
    && !!ws && str(ws.slug) && str(ws.name);
}

export function createStore(paths: { configFile: string; devicesFile: string } = PATHS): Store {
  const readDevices = (): Device[] => {
    const raw = readJson<{ devices?: unknown }>(paths.devicesFile, {});
    return Array.isArray(raw.devices) ? raw.devices.filter(isDevice) : [];
  };
  return {
    readConfig: () => readJson<LauncherConfig>(paths.configFile, {}),
    writeConfig: (config) => writeJson(paths.configFile, config),
    listDevices: readDevices,
    addDevice(device) {
      const rest = readDevices().filter((d) => d.origin !== device.origin);
      writeJson(paths.devicesFile, { devices: [device, ...rest] });
    },
    removeDevice: (origin) => writeJson(paths.devicesFile, { devices: readDevices().filter((d) => d.origin !== origin) }),
  };
}
