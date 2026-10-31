import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskStatus, projectNodes, serializableWorkflow, newWorkflow, fromSnapshot, type TaskSummary, type WorkerSummary, type RunSnapshot } from './model.ts';

const task = (status: string): TaskSummary => ({ id: 'task-a', title: 'A', spec: 'A', status, deps: [] });
const worker = (liveness: string): WorkerSummary => ({ dispatchId: 'dispatch-a', taskId: 'task-a', liveness, stage: 'working', provider: 'claude', model: 'example-model', outcome: '' });

test('settled Tasks stay settled even with a live terminal', () => {
  assert.equal(taskStatus(task('completed'), [worker('live')]), 'completed');
  assert.equal(taskStatus(task('failed'), [worker('live')]), 'failed');
  assert.equal(taskStatus(task('pending'), [worker('live')]), 'pending');
});
test('lost worker observations never imply completion or revive an older attempt', () => {
  assert.equal(taskStatus(task('in_progress'), [worker('unverifiable')]), 'unknown');
  assert.equal(taskStatus(task('running'), [worker('exited'), worker('live')]), 'unknown');
  assert.equal(taskStatus(task('running'), [worker('live')]), 'running');
  assert.equal(taskStatus(task('brand-new-status'), []), 'unknown');
});
test('stale snapshots are visibly unknown, with unbound nodes preserved', () => {
  const graph = newWorkflow();
  graph.nodes[0].data.taskId = 'task-a';
  const snapshot: RunSnapshot = { run: { id: 'run-a', objective: 'A', updatedAt: '' }, tasks: [task('completed')], workers: [], observedAt: '' };
  const projected = projectNodes(graph.nodes, snapshot, true);
  assert.equal(projected[0].data.status, 'unknown');
  assert.equal(projected[1].data.status, 'unbound');
  assert.equal(projectNodes(graph.nodes, snapshot, false)[0].data.status, 'completed');
});
test('saved documents omit observed state and React Flow selection fields', () => {
  const graph = newWorkflow();
  graph.nodes[0].data.status = 'running';
  graph.nodes[0].data.agent = 'local-agent';
  graph.nodes[0].selected = true;
  const persisted = serializableWorkflow(graph);
  assert.equal(persisted.nodes[0].data.status, undefined);
  assert.equal(persisted.nodes[0].data.agent, undefined);
  assert.equal(persisted.nodes[0].selected, undefined);
});
test('Run import preserves dependency edges, parallel positions, and tolerates cycles', () => {
  const a = task('completed');
  const b = { ...a, id: 'task-b', deps: ['task-a'] };
  const c = { ...a, id: 'task-c', deps: ['task-a'] };
  const snapshot: RunSnapshot = { run: { id: 'run-a', objective: 'A', updatedAt: '' }, tasks: [a, b, c], workers: [], observedAt: '' };
  const graph = fromSnapshot(snapshot);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.nodes[1].position.x, graph.nodes[2].position.x);
  assert.notEqual(graph.nodes[1].position.y, graph.nodes[2].position.y);
  a.deps = ['task-b'];
  assert.doesNotThrow(() => fromSnapshot(snapshot));
});
