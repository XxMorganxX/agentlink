import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli';

describe('parseArgs', () => {
  it.each([
    [['install'], { cmd: 'install' }],
    [['uninstall'], { cmd: 'uninstall' }],
    [['status'], { cmd: 'status' }],
    [['serve'], { cmd: 'serve' }],
    [['pair', 'https://crm.example', 'K7Q2-9XM4'], { cmd: 'pair', origin: 'https://crm.example', code: 'K7Q2-9XM4' }],
    [['unpair', 'https://crm.example'], { cmd: 'unpair', origin: 'https://crm.example' }],
    [['pair', 'https://crm.example'], { cmd: 'help' }],
    [['run', 'agentlink://x'], { cmd: 'help' }],
    [[], { cmd: 'help' }],
  ])('%j → %j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected);
  });
});
