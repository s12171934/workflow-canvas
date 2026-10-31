import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createStorage, validateWorkflow } from './storage.ts';
import { newWorkflow } from '../src/model.ts';

test('rejects traversal, dangling edges, duplicate ids and malformed task bindings', () => {
  const graph = newWorkflow();
  assert.throws(() => validateWorkflow({ ...graph, id: '../outside' }));
  assert.throws(() => validateWorkflow({ ...graph, edges: [{ id: 'edge-a', source: 'missing', target: graph.nodes[0].id }] }));
  assert.throws(() => validateWorkflow({ ...graph, nodes: [graph.nodes[0], graph.nodes[0]] }));
  graph.nodes[0].data.taskId = '--bad argument';
  assert.throws(() => validateWorkflow(graph));
});
test('round-trips the graph without storing observed runtime state', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'storage-test-'));
  try {
    const storage = createStorage(directory);
    const graph = newWorkflow();
    graph.nodes[0].data.status = 'running';
    await storage.save(graph);
    const loaded = await storage.load(graph.id);
    assert.equal(loaded.nodes[0].data.status, undefined);
    assert.equal(loaded.edges.length, graph.edges.length);
    assert.deepEqual(await storage.list(), [{ id: graph.id, name: graph.name }]);
    await assert.rejects(storage.load('../outside'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
