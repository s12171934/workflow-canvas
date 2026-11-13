import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoLayout } from '../src/layout.ts';
import { routeEdge, roundedPath, midpoint, type Point } from '../src/routing.ts';
import type { Workflow, Rect } from '../src/model.ts';
import { newWorkflow, projectNodes, serializableWorkflow, orderNodes, type RunSnapshot } from '../src/model.ts';
type Case = { file: string; placements: unknown[]; obstacles: Rect[]; routes: { source: Point; target: Point; points: Point[]; path: string; middle: Point }[] };
// Frozen outputs of the pre-migration TypeScript implementation, using only the public examples.
const cases: Case[] = JSON.parse(readFileSync(new URL('./fixtures/calculation-parity.json', import.meta.url), 'utf8'));
for (const fixture of cases) test(`Rust preserves the original layout and routes: ${fixture.file}`, () => {
  const graph: Workflow = JSON.parse(readFileSync(new URL(`../examples/${fixture.file}`, import.meta.url), 'utf8'));
  const nodes = autoLayout(graph.nodes, graph.edges);
  assert.deepEqual(nodes.map(n => ({ id: n.id, position: n.position, ...(['group', 'frame'].includes(n.type!) ? { width: n.width, height: n.height } : {}) })), fixture.placements);
  for (const route of fixture.routes) {
    const points = routeEdge(route.source, route.target, fixture.obstacles);
    assert.deepEqual(points, route.points);
    assert.equal(roundedPath(points), route.path);
    assert.deepEqual(midpoint(points), route.middle);
  }
});

test('moving nodes preserves document fields and cached calculations see edits and live state changes', () => {
  const graph = newWorkflow();
  const first = serializableWorkflow(graph);
  graph.nodes[0].position = { x: 123, y: 456 };
  assert.deepEqual(serializableWorkflow(graph).nodes[0].position, { x: 123, y: 456 });
  graph.nodes[0].data.description = '바뀐 지침';
  const edited = serializableWorkflow(graph);
  assert.equal(edited.nodes[0].data.description, '바뀐 지침');
  assert.equal(first.nodes[0].data.description, '목표와 완료 조건을 정의합니다.');
  const snapshot: RunSnapshot = { run: { id: 'run', objective: '', updatedAt: '' }, tasks: [{ id: 'task', title: '', spec: '', deps: [], status: 'running' }], workers: [], observedAt: '' };
  const executions = [{ id: 'e', label: 'e', bindings: { brief: 'task' } }];
  assert.equal(projectNodes(graph.nodes, snapshot, false, executions, 'all')[0].data.status, 'running');
  snapshot.tasks[0].status = 'failed';
  assert.equal(projectNodes(graph.nodes, snapshot, false, executions, 'all')[0].data.status, 'failed');
  assert.strictEqual(orderNodes(graph.nodes)[0], graph.nodes[0]);
});
