import { createServer, request, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createOrcaBridge } from './orca.ts';
import type { createModelCatalog } from './models.ts';
export { allowedHost, documentVersion } from './pure.ts';
export function createApp(directory: string, bridge = createOrcaBridge(), options: { root?: string; watchMs?: number; reapMs?: number; models?: ReturnType<typeof createModelCatalog> } = {}) {
  let backend = '', readyResolve: () => void, readyReject: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let process: ReturnType<typeof spawn> | undefined;
  const server = createServer(async (req, res) => {
    if (req.url === '/__rust_test_bridge__') {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const { method, args } = JSON.parse(Buffer.concat(chunks).toString());
        const value = method === 'models' ? await (options.models?.list() ?? { models: [], source: 'fallback' })
          : await (bridge as unknown as Record<string, (...args: unknown[]) => unknown>)[method](...args);
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ value }));
      } catch (error) { res.end(JSON.stringify({ error: (error as Error).message })); }
      return;
    }
    try {
      await ready;
      const upstream = request(`${backend}${req.url}`, { method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode ?? 503, response.headers); response.pipe(res);
      });
      upstream.on('error', error => { res.statusCode = 503; res.end(JSON.stringify({ error: error.message })); });
      req.pipe(upstream);
    } catch (error) { res.statusCode = 503; res.end(JSON.stringify({ error: (error as Error).message })); }
  });
  server.once('listening', () => {
    const callbackBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process = spawn(resolve('.local/target/debug/workflow-canvas'), ['--port', '0', '--data-dir', directory,
      '--bridge-url', `${callbackBase}/__rust_test_bridge__`, '--callback-base', callbackBase,
      '--watch-ms', String(options.watchMs ?? 0), '--reap-ms', String(options.reapMs ?? Math.max(options.watchMs ?? 0, 30000))],
      { env: { ...globalThis.process.env, WORKFLOW_CANVAS_TESTING: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    process.stdout!.on('data', chunk => { output += chunk; const found = output.match(/Workflow Canvas: (http:\/\/127\.0\.0\.1:\d+)/); if (found && !backend) { backend = found[1]; readyResolve(); } });
    process.stderr!.on('data', chunk => { errors += chunk; });
    process.once('error', readyReject);
    process.once('exit', code => { if (!backend) readyReject(new Error(`Rust 서버 종료 ${code}: ${errors}`)); });
  });
  const originalClose = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    if (!process || process.exitCode !== null) return originalClose(callback);
    process.once('exit', () => originalClose(callback)); process.kill('SIGTERM');
    return server;
  }) as Server['close'];
  const app = { locals: { stopWatch: () => {} }, listen: server.listen.bind(server) };
  return app;
}
