import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { get } from 'node:http';
import { createApp } from './app.ts';
import { createOrcaBridge } from './orca.ts';
import { newWorkflow } from '../src/model.ts';

test('local API saves graphs, rejects cross-origin requests, and exposes no worker mutation route', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-test-'));
  const bridge = createOrcaBridge(async (args) => args[0] === 'status' ? { runtime: { reachable: true, state: 'ready', appVersion: 'example' } } : { runs: [], nextCursor: null });
  const server = createApp(directory, bridge).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await (await fetch(`${base}/api/status`)).json()).connected, true);
    assert.equal((await fetch(`${base}/api/runs`, { headers: { Origin: 'https://example.com' } })).status, 403);
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(`${base}/api/runs`, { headers: { Host: 'example.com' } }, (response) => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(foreignHostStatus, 403);
    const graph = newWorkflow();
    const saved = await fetch(`${base}/api/workflows/${graph.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(graph) });
    assert.equal(saved.status, 200);
    const loaded = await (await fetch(`${base}/api/workflows/${graph.id}`)).json();
    assert.equal(loaded.nodes.length, 6);
    const invalid = await fetch(`${base}/api/workflows/${graph.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...graph, nodes: null }) });
    assert.equal(invalid.status, 400);
    assert.equal((await fetch(`${base}/api/worker-start`, { method: 'POST' })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
