import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import express from 'express';
import { createApp } from './app.ts';
import { createStorage } from './storage.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const portArg = process.argv.indexOf('--port');
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : process.env.WORKFLOW_CANVAS_PORT ?? 4318);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('올바른 포트가 필요합니다.');
const directory = resolve(process.env.WORKFLOW_CANVAS_DATA_DIR ?? join(root, '.local/workflows'));
const seeded = await createStorage(directory).seed(join(root, 'examples')).catch((error: Error) => { console.error(`예시 워크플로를 넣지 못했습니다: ${error.message}`); return []; });
if (seeded.length) console.log(`예시 워크플로 추가: ${seeded.join(', ')}`);
const app = createApp(directory, undefined, { root, watchMs: 10_000 });
const server = app.listen(port, '127.0.0.1', () => console.log(`Workflow Canvas: http://127.0.0.1:${port}`));
server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
if (process.argv.includes('--dev')) {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true, hmr: { server } }, appType: 'custom' });
  app.use(vite.middlewares);
  app.get('/{*path}', async (req, res, next) => {
    try {
      const template = await readFile(join(root, 'index.html'), 'utf8');
      res.type('html').send(await vite.transformIndexHtml(req.originalUrl, template));
    } catch (error) { next(error); }
  });
  server.on('close', () => { void vite.close(); });
} else {
  await readFile(join(root, 'dist/index.html')).catch(() => {
    console.error('빌드가 필요합니다. npm run build를 먼저 실행하세요.');
    server.close();
    process.exit(1);
  });
  app.use(express.static(join(root, 'dist')));
  app.get('/{*path}', (_req, res) => { res.sendFile(join(root, 'dist/index.html')); });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.close(() => process.exit(0)); });
}
