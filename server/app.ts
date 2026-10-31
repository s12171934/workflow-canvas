import express from 'express';
import type { ErrorRequestHandler } from 'express';
import { createOrcaBridge } from './orca.ts';
import { createStorage, validateWorkflow } from './storage.ts';

export function createApp(directory: string, bridge = createOrcaBridge()) {
  const app = express();
  const storage = createStorage(directory);
  app.disable('x-powered-by');
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const host = req.get('host') ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.status(403).json({ error: '로컬 요청만 허용합니다.' }); return; }
    const origin = req.get('origin');
    if ((origin && origin !== `http://${host}`) || req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ error: '같은 출처의 요청만 허용합니다.' }); return;
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/status', async (_req, res) => { res.json(await bridge.status()); });
  app.get('/api/runs', async (_req, res) => { res.json(await bridge.runs()); });
  app.get('/api/runs/:id', async (req, res) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(req.params.id)) { res.status(400).json({ error: '올바르지 않은 Run ID입니다.' }); return; }
    res.json(await bridge.snapshot(req.params.id));
  });
  app.get('/api/workflows', async (_req, res) => { res.json(await storage.list()); });
  app.post('/api/validate', (req, res) => {
    try { res.json(validateWorkflow(req.body)); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });
  app.get('/api/workflows/:id', async (req, res) => { res.json(await storage.load(req.params.id)); });
  app.put('/api/workflows/:id', async (req, res) => {
    if (req.params.id !== req.body?.id) { res.status(400).json({ error: '워크플로 ID가 일치하지 않습니다.' }); return; }
    let graph;
    try { graph = validateWorkflow(req.body); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
    res.json(await storage.save(graph));
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API를 찾을 수 없습니다.' }); });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const code = (error as NodeJS.ErrnoException).code;
    const status = code === 'ENOENT' ? 404 : (error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 503);
    const message = error instanceof Error && !code ? error.message : '요청을 처리할 수 없습니다.';
    res.status(status).json({ error: message });
  };
  app.use(errors);
  return app;
}
