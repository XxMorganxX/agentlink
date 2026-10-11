import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded { method: string; path: string; auth: string | null; body: string }

/** A minimal task server (status, events, complete): records every call, answers status from a script. */
export async function startFakeApp(opts: { statusSequence?: string[]; onCall?: (call: Recorded) => void } = {}): Promise<{ url: string; calls: Recorded[]; close(): Promise<void> }> {
  const calls: Recorded[] = [];
  const statuses = [...(opts.statusSequence ?? ['claimed'])];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const path = req.url ?? '';
      const call: Recorded = { method: req.method ?? '', path, auth: req.headers.authorization ?? null, body };
      calls.push(call);
      opts.onCall?.(call);
      if (path.endsWith('/events') || path.endsWith('/complete')) {
        res.writeHead(204); res.end();
      } else {
        const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/tasks/t1`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}
