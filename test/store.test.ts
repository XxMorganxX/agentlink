import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStore, type Device } from '../src/store';

const dir = () => mkdtempSync(join(tmpdir(), 'agentlink-store-'));
const paths = (d: string) => ({ configFile: join(d, 'config.json'), devicesFile: join(d, 'devices.json') });
const device = (origin: string, over: Partial<Device> = {}): Device => ({
  origin, app: 'Outreach CRM', workspace: { slug: 'acme', name: 'Acme' }, device_id: 'dev_1', device_token: 'tok',
  poll_url: `${origin}/api/agentlink/v1/poll`, paired_at: '2026-10-09T00:00:00.000Z', ...over,
});

describe('store', () => {
  it('reads an empty config and devices when nothing is written', () => {
    const s = createStore(paths(dir()));
    expect(s.readConfig()).toEqual({});
    expect(s.listDevices()).toEqual([]);
  });
  it('writes config and devices with mode 600', () => {
    const d = dir();
    const s = createStore(paths(d));
    s.writeConfig({ claude_path: '/x/claude' });
    s.addDevice(device('https://crm.example'));
    expect(statSync(join(d, 'config.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, 'devices.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(d, 'devices.json'), 'utf8'))).toEqual({ devices: [device('https://crm.example')] });
  });
  it('restores mode 600 on overwrite and keeps the directory at 700', () => {
    const d = dir();
    const s = createStore(paths(d));
    s.addDevice(device('https://a.example'));
    chmodSync(join(d, 'devices.json'), 0o644);
    chmodSync(d, 0o755);
    s.addDevice(device('https://b.example'));
    expect(statSync(join(d, 'devices.json')).mode & 0o777).toBe(0o600);
    expect(statSync(d).mode & 0o777).toBe(0o700);
  });
  it('replaces a device for the same origin and removes by origin', () => {
    const s = createStore(paths(dir()));
    s.addDevice(device('https://a.example'));
    s.addDevice(device('https://b.example'));
    s.addDevice(device('https://a.example', { device_id: 'dev_2' }));
    expect(s.listDevices().map((x) => x.device_id)).toEqual(['dev_2', 'dev_1']);
    s.removeDevice('https://b.example');
    expect(s.listDevices().map((x) => x.origin)).toEqual(['https://a.example']);
  });
  it('ignores malformed device entries', () => {
    const d = dir();
    const s = createStore(paths(d));
    s.addDevice(device('https://a.example'));
    const raw = JSON.parse(readFileSync(join(d, 'devices.json'), 'utf8'));
    raw.devices.push({ origin: 'https://broken.example' });
    writeFileSync(join(d, 'devices.json'), JSON.stringify(raw));
    expect(s.listDevices().map((x) => x.origin)).toEqual(['https://a.example']);
  });
});
