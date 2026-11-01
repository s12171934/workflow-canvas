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
test('validates executions: unique ids, known nodes, safe task ids', () => {
  const graph = newWorkflow();
  const node = graph.nodes[0].id;
  const ok = { ...graph, executions: [{ id: 'exec-1', label: '#1', bindings: { [node]: 'task-a' } }] };
  assert.equal(validateWorkflow(ok).executions?.length, 1);
  assert.throws(() => validateWorkflow({ ...ok, executions: [ok.executions[0], ok.executions[0]] }));
  assert.throws(() => validateWorkflow({ ...ok, executions: [{ id: 'exec-1', label: '#1', bindings: { missing: 'task-a' } }] }));
  assert.throws(() => validateWorkflow({ ...ok, executions: [{ id: 'exec-1', label: '#1', bindings: { [node]: '--bad argument' } }] }));
  assert.throws(() => validateWorkflow({ ...ok, executions: [{ id: 'exec-1', label: ' ', bindings: {} }] }));
});
test('workspace must be an absolute path without control characters', () => {
  const graph = newWorkflow();
  assert.equal(validateWorkflow({ ...graph, workspace: '/example/repo' }).workspace, '/example/repo');
  assert.throws(() => validateWorkflow({ ...graph, workspace: 'relative/path' }));
  assert.throws(() => validateWorkflow({ ...graph, workspace: '/example\nrepo' }));
});
test('migrates v1 task nodes and validates group nodes and parents', () => {
  const graph = newWorkflow();
  graph.nodes[0].data.kind = 'task' as never;
  assert.equal(validateWorkflow(graph).nodes[0].data.kind, 'worker');
  const group = { id: 'grp', type: 'group', position: { x: 0, y: 0 }, width: 500, height: 300,
    data: { label: 'repo', description: '', kind: 'group', scope: 'worktree', path: '/example/wt' } };
  const child = { ...graph.nodes[1], parentId: 'grp' };
  const ok = validateWorkflow({ ...graph, nodes: [child, group, ...graph.nodes.slice(2)], edges: [] });
  assert.equal(ok.nodes[0].id, 'grp'); // parents first
  assert.equal(ok.nodes[1].parentId, 'grp');
  assert.throws(() => validateWorkflow({ ...graph, nodes: [{ ...group, data: { ...group.data, path: 'relative' } }], edges: [] }));
  assert.throws(() => validateWorkflow({ ...graph, nodes: [{ ...group, data: { ...group.data, scope: 'coordinator' } }], edges: [] }));
  assert.throws(() => validateWorkflow({ ...graph, nodes: [{ ...graph.nodes[0], parentId: 'nowhere' }], edges: [] }));
  // A worktree group inside a worktree group is a child worktree.
  assert.doesNotThrow(() => validateWorkflow({ ...graph, nodes: [group, { ...group, id: 'grp2', parentId: 'grp' }], edges: [] }));
  assert.throws(() => validateWorkflow({ ...graph, nodes: [{ ...graph.nodes[0], data: { ...graph.nodes[0].data, kind: 'script' } }], edges: [] }));
});
test('validates execution links for workflow-link nodes', () => {
  const graph = newWorkflow();
  const node = graph.nodes[0].id;
  const base = { ...graph, executions: [{ id: 'exec-1', label: '#1', bindings: {}, links: { [node]: { 'sub.inner': 'task-a' } } }] };
  assert.deepEqual(validateWorkflow(base).executions?.[0].links, { [node]: { 'sub.inner': 'task-a' } });
  assert.throws(() => validateWorkflow({ ...base, executions: [{ id: 'exec-1', label: '#1', bindings: {}, links: { missing: { sub: 'task-a' } } }] }));
  assert.throws(() => validateWorkflow({ ...base, executions: [{ id: 'exec-1', label: '#1', bindings: {}, links: { [node]: { sub: '--bad argument' } } }] }));
});
test('create-mode worktree groups keep their spec and reject argument-like values', () => {
  const graph = newWorkflow();
  const group = { id: 'grp', type: 'group', position: { x: 0, y: 0 },
    data: { label: 'new', description: '', kind: 'group', scope: 'worktree', path: '/stale', worktreeMode: 'create', repoPath: '/example/repo', worktreeName: 'feature', baseBranch: 'origin/main' } };
  const saved = validateWorkflow({ ...graph, nodes: [group], edges: [] }).nodes[0].data;
  assert.equal(saved.worktreeMode, 'create');
  assert.equal(saved.path, ''); // a create-mode group never runs at a picked path
  assert.equal(saved.baseBranch, 'origin/main');
  const bad = (data: object) => () => validateWorkflow({ ...graph, nodes: [{ ...group, data: { ...group.data, ...data } }], edges: [] });
  assert.throws(bad({ baseBranch: '--upload-pack=x' }));
  assert.throws(bad({ baseBranch: 'a..b' }));
  assert.throws(bad({ worktreeName: '-x' }));
  assert.throws(bad({ worktreeName: 'has space' }));
  assert.throws(bad({ repoPath: 'relative' }));
  assert.throws(bad({ scope: 'project' }));
});
test('worktree groups nest in projects and in each other; projects never nest', () => {
  const graph = newWorkflow();
  const project = { id: 'p', type: 'group', position: { x: 0, y: 0 }, data: { label: 'p', description: '', kind: 'group', scope: 'project', path: '/example/repo' } };
  const worktree = { id: 'w', type: 'group', parentId: 'p', position: { x: 20, y: 40 }, data: { label: 'w', description: '', kind: 'group', scope: 'worktree', path: '', worktreeMode: 'create' } };
  const stage = { ...graph.nodes[0], parentId: 'w' };
  const ok = validateWorkflow({ ...graph, nodes: [stage, worktree, project], edges: [] });
  assert.deepEqual(ok.nodes.map((node) => node.id), ['p', 'w', stage.id]);
  assert.throws(() => validateWorkflow({ ...graph, nodes: [project, { ...project, id: 'p2', parentId: 'p' }], edges: [] }));
  const child = validateWorkflow({ ...graph, nodes: [{ ...worktree, id: 'w2', parentId: 'w' }, project, worktree], edges: [] });
  assert.deepEqual(child.nodes.map((node) => node.id), ['p', 'w', 'w2']); // parents before children at every depth
  assert.throws(() => validateWorkflow({ ...graph, nodes: [{ ...project, parentId: 'w' }, worktree], edges: [] })); // projects never nest
  assert.throws(() => validateWorkflow({ ...graph, nodes: [{ ...worktree, parentId: 'w2' }, { ...worktree, id: 'w2', parentId: 'w' }], edges: [] })); // cycle
});

test('refuses cyclic edges and branch edges that do not leave one of the branch outputs', () => {
  const graph = newWorkflow();
  assert.match(String((() => { try { validateWorkflow({ ...graph, edges: [...graph.edges, { id: 'back', source: 'review', target: 'design' }] }); } catch (error) { return (error as Error).message; } })()), /순환.*설계/);
  const branch = { id: 'gate-check', type: 'stage', position: { x: 0, y: 0 }, data: { label: '판정', description: '', kind: 'branch', mode: 'exclusive', judge: 'previous',
    outputs: [{ id: 'pass', label: '통과' }, { id: 'fail', label: '실패' }] } };
  const nodes = [...graph.nodes, branch];
  assert.throws(() => validateWorkflow({ ...graph, nodes, edges: [...graph.edges, { id: 'out', source: 'gate-check', target: 'approve' }] }), /출력/);
  assert.throws(() => validateWorkflow({ ...graph, nodes, edges: [...graph.edges, { id: 'out', source: 'gate-check', sourceHandle: 'maybe', target: 'approve' }] }), /출력/);
  const saved = validateWorkflow({ ...graph, nodes, edges: [...graph.edges, { id: 'out', source: 'gate-check', sourceHandle: 'pass', target: 'approve' }, { id: 'plain', source: 'brief', sourceHandle: 'x', target: 'gate-check' }] });
  assert.equal(saved.edges.find((edge) => edge.id === 'out')!.sourceHandle, 'pass');
  assert.equal(saved.edges.find((edge) => edge.id === 'plain')!.sourceHandle, undefined);
  assert.deepEqual(saved.nodes.find((node) => node.id === 'gate-check')!.data.outputs, branch.data.outputs);
});
test('validates memo groups and per-node model and effort', () => {
  const graph = newWorkflow();
  const frame = { id: 'frame-a', type: 'frame', position: { x: 0, y: 0 }, width: 400, height: 200, data: { label: '묶음', description: '', kind: 'frame' } };
  assert.equal(validateWorkflow({ ...graph, nodes: [frame, ...graph.nodes] }).nodes.length, graph.nodes.length + 1);
  assert.throws(() => validateWorkflow({ ...graph, nodes: [{ ...frame, type: 'stage' }, ...graph.nodes] }));
  assert.throws(() => validateWorkflow({ ...graph, nodes: [{ ...frame, parentId: 'brief' }, ...graph.nodes] }));
  const withLaunch = (data: object) => ({ ...graph, nodes: graph.nodes.map((node, index) => index ? node : { ...node, data: { ...node.data, ...data } }) });
  assert.equal(validateWorkflow(withLaunch({ workerModel: 'claude-haiku-5-5', effort: 'low' })).nodes[0].data.effort, 'low');
  assert.throws(() => validateWorkflow(withLaunch({ workerModel: '--terminal x' })));
  assert.throws(() => validateWorkflow(withLaunch({ effort: 'extreme' })));
});
test('only gates take an asker, and only a known one', () => {
  const graph = newWorkflow();
  const withData = (index: number, data: object) => ({ ...graph, nodes: graph.nodes.map((node, i) => i === index ? { ...node, data: { ...node.data, ...data } } : node) });
  assert.equal(validateWorkflow(withData(5, { asker: 'previous' })).nodes[5].data.asker, 'previous');
  assert.throws(() => validateWorkflow(withData(5, { asker: 'someone' })));
  assert.throws(() => validateWorkflow(withData(0, { asker: 'previous' })));
});
test('only workflow links take a link mode, and only a known one', () => {
  const graph = { ...newWorkflow(), nodes: [{ id: 'link', type: 'stage' as const, position: { x: 0, y: 0 }, data: { label: 'link', description: '', kind: 'workflow' as const, linkMode: 'start' as const } }], edges: [] };
  assert.equal(validateWorkflow(graph).nodes[0].data.linkMode, 'start');
  assert.throws(() => validateWorkflow({ ...graph, nodes: [{ ...graph.nodes[0], data: { ...graph.nodes[0].data, linkMode: 'later' as never } }] }));
  assert.throws(() => validateWorkflow({ ...graph, nodes: [{ ...graph.nodes[0], data: { ...graph.nodes[0].data, kind: 'worker' as const } }] }));
});
test('memo groups go in any group, but nothing goes in a memo group', () => {
  const graph = newWorkflow();
  const project = { id: 'p', type: 'group', position: { x: 0, y: 0 }, width: 800, height: 600, data: { label: 'P', description: '', kind: 'group', scope: 'project', path: '' } };
  const worktree = { id: 'w', type: 'group', parentId: 'p', position: { x: 10, y: 10 }, width: 600, height: 400, data: { label: 'W', description: '', kind: 'group', scope: 'worktree', path: '' } };
  const frame = { id: 'f', type: 'frame', parentId: 'w', position: { x: 10, y: 10 }, width: 300, height: 200, data: { label: '묶음', description: '', kind: 'frame' } };
  const stored = validateWorkflow({ ...graph, nodes: [project, worktree, frame, ...graph.nodes] });
  assert.equal(stored.nodes.find((node) => node.id === 'f')!.parentId, 'w');
  assert.throws(() => validateWorkflow({ ...graph, nodes: [project, worktree, frame, ...graph.nodes.map((node, index) => index ? node : { ...node, parentId: 'f' })] }), /그룹 노드 안에만/);
});
