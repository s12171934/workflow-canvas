import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { get } from 'node:http';
import { createApp } from './app.ts';
import { createOrcaBridge } from './orca.ts';
import { newWorkflow } from '../src/model.ts';

/** Orca answers for the run dialog's project check. */
function places(args: string[]) {
  if (args[0] === 'repo') return { repos: [{ id: 'repo-a', path: '/example/repo', displayName: 'repo' }] };
  if (args[0] === 'worktree') return { worktrees: [] };
  return undefined;
}

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
    const tailnetStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(`${base}/api/runs`, { headers: { Host: 'mac.tail1234.ts.net:4318', Origin: 'https://mac.tail1234.ts.net:4318' } }, (response) => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(tailnetStatus, 200);
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
test('execute launches one coordinator with a brief, refuses duplicates, and delete removes the file', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-exec-test-'));
  const calls: string[][] = [];
  const bridge = createOrcaBridge(async (args) => {
    calls.push(args);
    const place = places(args); if (place) return place;
    if (args[0] === 'agent') return { outcome: { kind: 'terminal' }, terminal: { handle: 'term_coord' } };
    if (args[1] === 'run-show') return { run: { id: 'run-a', objective: 'A' } };
    if (args[1] === 'task-list') return { tasks: [{ id: 'task-a', status: 'running', deps: [] }] };
    if (args[1] === 'worker-list') return { workers: [], page: { hasMore: false } };
    return {};
  });
  const server = createApp(directory, bridge, { root: '/example/canvas' }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = { 'Content-Type': 'application/json' };
  try {
    const graph = { ...newWorkflow(), workspace: '/example/repo' };
    assert.equal((await fetch(`${base}/api/workflows/${graph.id}`, { method: 'PUT', headers: json, body: JSON.stringify(graph) })).status, 200);
    assert.equal((await fetch(`${base}/api/workflows/${graph.id}/execute`, { method: 'POST', headers: json, body: JSON.stringify({ count: 0 }) })).status, 400);
    assert.equal((await fetch(`${base}/api/workflows/${graph.id}/execute`, { method: 'POST', headers: json, body: JSON.stringify({ count: 3, project: '/somewhere/else' }) })).status, 400);
    const launched = await fetch(`${base}/api/workflows/${graph.id}/execute`, { method: 'POST', headers: json, body: JSON.stringify({ count: 3, project: '/example/repo' }) });
    assert.equal(launched.status, 200);
    const launch = calls.find((args) => args[0] === 'agent')!;
    assert.deepEqual(launch.slice(0, 9), ['agent', 'launch', '--agent', 'claude', '--model', 'claude-opus-5-5', '--surface', 'terminal', '--worktree']);
    assert.equal(launch[9], 'path:/example/repo'); // the coordinator starts in the project picked for the run
    const briefPath = launch[11].split(' ')[0];
    const brief = await readFile(briefPath, 'utf8');
    assert.match(brief, /3회 병렬 실행/);
    assert.match(brief, /"location": "\/example\/repo"/);
    assert.ok(calls.some((args) => args[0] === 'terminal' && args[1] === 'rename'));
    // Double click within the cooldown never starts a second coordinator.
    assert.equal((await fetch(`${base}/api/workflows/${graph.id}/execute`, { method: 'POST', headers: json, body: JSON.stringify({ count: 1, project: '/example/repo' }) })).status, 409);
    assert.equal(calls.filter((args) => args[0] === 'agent').length, 1);
    // Coordinator registers executions; an unknown node is rejected.
    const bad = await fetch(`${base}/api/workflows/${graph.id}/executions`, { method: 'PUT', headers: json,
      body: JSON.stringify({ runId: 'run-a', executions: [{ id: 'exec-1', label: '#1', bindings: { missing: 'task-a' } }] }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/api/workflows/${graph.id}/executions`, { method: 'PUT', headers: json,
      body: JSON.stringify({ runId: 'run-a', executions: [{ id: 'exec-1', label: '#1', bindings: { [graph.nodes[0].id]: 'task-a' } }] }) });
    assert.equal(ok.status, 200);
    const stored = await (await fetch(`${base}/api/workflows/${graph.id}`)).json();
    assert.equal(stored.runId, 'run-a');
    assert.equal(stored.nodes.length, graph.nodes.length);
    assert.equal(stored.workspace, '/example/repo');
    assert.equal((await fetch(`${base}/api/workflows/${graph.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/api/workflows/${graph.id}`)).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
test('execute refuses while an earlier execution is still open', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-open-test-'));
  const calls: string[][] = [];
  const bridge = createOrcaBridge(async (args) => {
    calls.push(args);
    const place = places(args); if (place) return place;
    if (args[1] === 'run-show') return { run: { id: 'run-a', objective: 'A' } };
    if (args[1] === 'task-list') return { tasks: [{ id: 'task-a', status: 'dispatched', deps: [] }] };
    if (args[1] === 'worker-list') return { workers: [{ dispatchId: 'd', taskId: 'task-a', projection: { liveness: { verdict: 'live' } } }], page: { hasMore: false } };
    return {};
  });
  const server = createApp(directory, bridge, { root: '/example/canvas' }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const graph = newWorkflow();
    graph.runId = 'run-a';
    graph.executions = [{ id: 'exec-1', label: '#1', bindings: { [graph.nodes[0].id]: 'task-a' } }];
    await fetch(`${base}/api/workflows/${graph.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(graph) });
    const response = await fetch(`${base}/api/workflows/${graph.id}/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1, project: '/example/repo' }) });
    assert.equal(response.status, 409);
    assert.equal(calls.filter((args) => args[0] === 'agent').length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
test('execute refuses a workflow link that is unset, missing, or cyclic', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-link-test-'));
  const calls: string[][] = [];
  const bridge = createOrcaBridge(async (args) => { calls.push(args); return places(args) ?? { terminal: { handle: 'term_coord' } }; });
  const server = createApp(directory, bridge, { root: '/example/canvas' }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = { 'Content-Type': 'application/json' };
  const put = (graph: unknown) => fetch(`${base}/api/workflows/${(graph as { id: string }).id}`, { method: 'PUT', headers: json, body: JSON.stringify(graph) });
  const run = (id: string) => fetch(`${base}/api/workflows/${id}/execute`, { method: 'POST', headers: json, body: JSON.stringify({ count: 1, project: '/example/repo' }) });
  const link = (id: string, workflowId?: string) => ({ ...newWorkflow(), id, nodes: [{ id: 'link', type: 'stage', position: { x: 0, y: 0 },
    data: { label: '링크', description: '', kind: 'workflow', ...(workflowId ? { workflowId } : {}) } }], edges: [] });
  try {
    await put(link('wf-unset'));
    assert.equal((await run('wf-unset')).status, 400);
    await put(link('wf-missing', 'nowhere'));
    assert.equal((await run('wf-missing')).status, 400);
    await put(link('wf-a', 'wf-b')); await put(link('wf-b', 'wf-a'));
    assert.match((await (await run('wf-a')).json()).error, /순환/);
    assert.equal(calls.filter((args) => args[0] === 'agent').length, 0);
    const child = { ...newWorkflow(), id: 'wf-child', name: '하위' };
    await put(child); await put(link('wf-parent', 'wf-child'));
    assert.equal((await run('wf-parent')).status, 200);
    const launch = calls.find((args) => args[0] === 'agent')!;
    const brief = await readFile(launch[11].split(' ')[0], 'utf8');
    assert.match(brief, /"nodeId": "link\.design"/);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
test('brief asks for one new worktree per execution, including inside links', async () => {
  const { buildBrief, checkGroups } = await import('./execute.ts');
  const child = { ...newWorkflow(), id: 'wf-child', name: '하위', nodes: [
    { id: 'g', type: 'group' as const, position: { x: 0, y: 0 }, data: { label: '새 WT', description: '', kind: 'group' as const, scope: 'worktree' as const, path: '', worktreeMode: 'create' as const, repoPath: '/example/repo', worktreeName: 'feat' } },
    { id: 'inner', type: 'stage' as const, parentId: 'g', position: { x: 10, y: 10 }, data: { label: '안', description: '', kind: 'worker' as const } },
    { id: 'outer', type: 'stage' as const, position: { x: 0, y: 400 }, data: { label: '밖', description: '', kind: 'worker' as const } },
  ], edges: [] };
  const parent = { ...newWorkflow(), id: 'wf-parent', workspace: '/example/default', nodes: [
    { id: 'link', type: 'stage' as const, position: { x: 0, y: 0 }, data: { label: '링크', description: '', kind: 'workflow' as const, workflowId: 'wf-child' } },
  ], edges: [] };
  const brief = buildBrief({ graph: parent, linked: new Map([['wf-child', child]]), count: 2, apiBase: 'http://127.0.0.1:1', workspace: '/example/canvas', artifactDir: '/tmp/x' });
  assert.match(brief, /## 워크트리/);
  assert.match(brief, /"location": "new-worktree:link\.g"/);
  assert.match(brief, /orca worktree create --repo path:<repo>/);
  // Ungrouped stages run in the project picked for the run (the workflow's own workspace is only the dialog default).
  assert.match(brief, /"nodeId": "link\.outer",[\s\S]*?"location": "\/example\/canvas"/);
  // A create-mode group with no project of its own branches from the run project.
  const noRepo = { ...child, nodes: child.nodes.map((node) => node.id === 'g' ? { ...node, data: { ...node.data, repoPath: '' } } : node) };
  assert.doesNotThrow(() => checkGroups([noRepo]));
  assert.match(buildBrief({ graph: noRepo, count: 1, apiBase: 'http://127.0.0.1:1', workspace: '/run/project', artifactDir: '/tmp/x' }), /"repo": "\/run\/project"/);
  assert.doesNotThrow(() => checkGroups([child]));
  // A create-mode worktree group inside a project group branches from that project.
  const nested = { ...child, nodes: [{ id: 'p', type: 'group' as const, position: { x: 0, y: 0 }, data: { label: 'P', description: '', kind: 'group' as const, scope: 'project' as const, path: '/example/project' } },
    ...child.nodes.map((node) => node.id === 'g' ? { ...node, parentId: 'p', data: { ...node.data, repoPath: '' } } : node)] };
  assert.doesNotThrow(() => checkGroups([nested]));
  assert.match(buildBrief({ graph: nested, count: 1, apiBase: 'http://127.0.0.1:1', workspace: '/c', artifactDir: '/tmp/x' }), /"repo": "\/example\/project"/);
});
test('brief covers naming sources, child worktrees, clean-up and automation', async () => {
  const { buildBrief, checkGroups } = await import('./execute.ts');
  const group = (id: string, data: object, parentId?: string) => ({ id, type: 'group' as const, position: { x: 0, y: 0 }, ...(parentId ? { parentId } : {}),
    data: { label: id, description: '', kind: 'group' as const, scope: 'worktree' as const, path: '', ...data } });
  const stage = (id: string, parentId?: string) => ({ id, type: 'stage' as const, position: { x: 0, y: 0 }, ...(parentId ? { parentId } : {}), data: { label: id, description: '', kind: 'worker' as const } });
  const graph = { ...newWorkflow(), nodes: [
    group('outer', { worktreeMode: 'create', nameSource: 'agent', nameFrom: 'plan' }),
    group('inner', { worktreeMode: 'create', nameSource: 'input', inputPrompt: '이슈 키' }, 'outer'),
    group('picked', { path: '/example/wt', worktreeName: 'feature-a', branch: 'feature/a', repoPath: '/example/repo' }),
    stage('plan'), stage('build', 'inner'), stage('fix', 'picked'),
  ], edges: [] };
  assert.doesNotThrow(() => checkGroups([graph]));
  const brief = buildBrief({ graph, count: 2, apiBase: 'http://127.0.0.1:1', workspace: '/example/repo', artifactDir: '/tmp/x',
    inputs: { inner: 'PROJ-1' }, cleanup: { coordinator: true, worktrees: true, sessions: false }, automation: { id: 'auto-1', name: '야간' } });
  const specs = JSON.parse(brief.match(/## 워크트리[\s\S]*?```json\n([\s\S]*?)\n```/)![1]);
  assert.deepEqual(specs.map((spec: { location: string }) => spec.location), ['new-worktree:outer', '/example/wt', 'new-worktree:inner']);
  assert.equal(specs[2].parent, 'new-worktree:outer'); // child worktree of the outer one
  assert.deepEqual(specs[2].name, { source: 'input', value: 'PROJ-1', prompt: '이슈 키' });
  assert.deepEqual(specs[0].name, { source: 'agent', fromStage: 'plan' });
  assert.deepEqual(specs[1].existing, { path: '/example/wt', name: 'feature-a', branch: 'feature/a' });
  assert.match(brief, /"nodeId": "plan",[\s\S]*?"namesWorktree": \[\s*"new-worktree:outer"/);
  assert.match(brief, /--parent-worktree path:/);
  assert.match(brief, /재사용/);
  assert.match(brief, /worker-retain/);
  assert.match(brief, /orca worktree rm/);
  assert.match(brief, /orca terminal close/);
  assert.match(brief, /자동화 「야간」/);
  assert.match(brief, /"automation":\{"id":"auto-1","name":"야간"\}/);
  // The naming stage must sit outside the worktree it names.
  const inside = { ...graph, nodes: graph.nodes.map((node) => node.id === 'plan' ? { ...node, parentId: 'outer' } : node) };
  assert.throws(() => checkGroups([inside]), /그룹 밖/);
});
test('automations: create in Orca with a brief-fetching prompt, fire, and remove', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-auto-test-'));
  const calls: string[][] = [];
  let listed: object[] = [];
  const bridge = createOrcaBridge(async (args) => {
    calls.push(args);
    const place = places(args); if (place) return place;
    if (args[0] === 'automations' && args[1] === 'create') { listed = [{ id: 'orca-auto-1', name: 'x', enabled: true, nextRunAt: 1 }]; return { automation: { id: 'orca-auto-1' } }; }
    if (args[0] === 'automations' && args[1] === 'list') return { automations: listed };
    return {};
  });
  const server = createApp(directory, bridge).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = { 'Content-Type': 'application/json' };
  try {
    const graph = newWorkflow();
    await fetch(`${base}/api/workflows/${graph.id}`, { method: 'PUT', headers: json, body: JSON.stringify(graph) });
    const body = { name: '야간', trigger: 'daily', time: '02:00', project: '/example/repo', count: 2, cleanup: { coordinator: true, worktrees: false, sessions: true } };
    assert.equal((await fetch(`${base}/api/workflows/${graph.id}/automations`, { method: 'POST', headers: json, body: JSON.stringify({ ...body, trigger: 'rm -rf' }) })).status, 400);
    assert.equal(calls.filter((args) => args[1] === 'create').length, 0); // nothing reaches Orca when the settings are invalid
    const created = await (await fetch(`${base}/api/workflows/${graph.id}/automations`, { method: 'POST', headers: json, body: JSON.stringify(body) })).json();
    const config = created.automations[0];
    assert.equal(config.orcaId, 'orca-auto-1');
    const create = calls.find((args) => args[1] === 'create')!;
    assert.ok(create.includes('--workspace') && !create.includes('--repo') && create.includes('path:/example/repo') && create.includes('--time') && create.includes('02:00'));
    assert.match(create[create.indexOf('--prompt') + 1], new RegExp(`/api/workflows/${graph.id}/automations/${config.id}/brief`));
    const listing = await (await fetch(`${base}/api/workflows/${graph.id}/automations`)).json();
    assert.equal(listing.automations[0].state.enabled, true);
    // When Orca fires it, the agent fetches a brief that records the automation.
    const fired = await (await fetch(`${base}/api/workflows/${graph.id}/automations/${config.id}/brief`, { method: 'POST' })).json();
    assert.match(await readFile(fired.briefPath, 'utf8'), /자동화 「야간」/);
    assert.equal((await fetch(`${base}/api/workflows/${graph.id}/automations/${config.id}/run`, { method: 'POST' })).status, 200);
    assert.ok(calls.some((args) => args[1] === 'run' && args[2] === 'orca-auto-1'));
    const removed = await (await fetch(`${base}/api/workflows/${graph.id}/automations/${config.id}`, { method: 'DELETE' })).json();
    assert.equal(removed.automations, undefined);
    assert.ok(calls.some((args) => args[1] === 'remove' && args[2] === 'orca-auto-1'));
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
test('execution log records the launch, registration, observed Task changes and coordinator events', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-log-test-'));
  let status = 'ready';
  const bridge = createOrcaBridge(async (args) => {
    const place = places(args); if (place) return place;
    if (args[0] === 'agent') return { terminal: { handle: 'term_coord' } };
    if (args[1] === 'run-show') return { run: { id: 'run-a', objective: 'A' } };
    if (args[1] === 'task-list') return { tasks: [{ id: 'task-a', display_name: '구현 #1', status, deps: [] }] };
    if (args[1] === 'worker-list') return { workers: [], page: { hasMore: false } };
    return {};
  });
  const server = createApp(directory, bridge).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = { 'Content-Type': 'application/json' };
  try {
    const graph = newWorkflow();
    await fetch(`${base}/api/workflows/${graph.id}`, { method: 'PUT', headers: json, body: JSON.stringify(graph) });
    assert.deepEqual(await (await fetch(`${base}/api/workflows/${graph.id}/logs`)).json(), []);
    assert.equal((await fetch(`${base}/api/workflows/${graph.id}/execute`, { method: 'POST', headers: json, body: JSON.stringify({ count: 2, project: '/example/repo' }) })).status, 200);
    const [entry] = await (await fetch(`${base}/api/workflows/${graph.id}/logs`)).json();
    assert.equal(entry.count, 2);
    assert.equal(entry.project, '/example/repo');
    assert.deepEqual(entry.files, ['brief.md']);
    const brief = await (await fetch(`${base}/api/workflows/${graph.id}/logs/${entry.id}/files/brief.md`)).json();
    assert.match(brief.text, new RegExp(`/api/workflows/${graph.id}/logs/${entry.id}/events`));
    assert.equal((await fetch(`${base}/api/workflows/${graph.id}/logs/${entry.id}/files/meta.json`)).status, 400);
    assert.equal((await fetch(`${base}/api/workflows/${graph.id}/logs/${entry.id}/files/..%2Fx`)).status, 400);
    assert.equal((await fetch(`${base}/api/workflows/${graph.id}/logs/2020-01-01T00-00-00-000Z-other`)).status, 400);

    await fetch(`${base}/api/workflows/${graph.id}/executions`, { method: 'PUT', headers: json,
      body: JSON.stringify({ runId: 'run-a', executions: [{ id: 'exec-1', label: '#1', bindings: { [graph.nodes[0].id]: 'task-a' } }] }) });
    await fetch(`${base}/api/runs/run-a`);
    await fetch(`${base}/api/runs/run-a`); // unchanged: no second event
    status = 'running';
    await fetch(`${base}/api/runs/run-a`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await fetch(`${base}/api/workflows/${graph.id}/logs/${entry.id}/events`, { method: 'POST', headers: json, body: JSON.stringify({ type: 'task', message: 'x' }) })).status, 400);
    assert.equal((await fetch(`${base}/api/workflows/${graph.id}/logs/${entry.id}/events`, { method: 'POST', headers: json,
      body: JSON.stringify({ type: 'worker', taskId: 'task-a', message: '구현 #1: 통과 → 다음 단계 진행' }) })).status, 200);

    const detail = await (await fetch(`${base}/api/workflows/${graph.id}/logs/${entry.id}`)).json();
    assert.equal(detail.meta.runId, 'run-a');
    assert.deepEqual(detail.events.map((event: { type: string }) => event.type), ['requested', 'brief', 'coordinator', 'registered', 'task', 'task', 'worker']);
    const tasks = detail.events.filter((event: { type: string }) => event.type === 'task');
    assert.deepEqual(tasks.map((event: { status: string; from?: string }) => [event.from, event.status]), [[undefined, 'pending'], ['pending', 'running']]);
    assert.equal(tasks[0].message, '구현 #1');
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
test('execution log keeps finished executions: results, completion events, legacy adoption and background watch', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-log-done-test-'));
  let status = 'running';
  const bridge = createOrcaBridge(async (args) => {
    const place = places(args); if (place) return place;
    if (args[1] === 'run-show') return { run: { id: 'run-old', objective: 'A' } };
    if (args[1] === 'task-list') return { tasks: [{ id: 'task-a', display_name: '구현 #1', status, deps: [] }, { id: 'task-b', display_name: '검토 #1', status: 'ready', deps: ['task-a'] }] };
    if (args[1] === 'worker-list') return { workers: [], page: { hasMore: false } };
    return {};
  });
  const graph = newWorkflow();
  // A launch from before execution logs: only a brief and a report, and the workflow still points at its Run.
  const legacy = `2026-10-31T17-48-45-819Z-${graph.id}`;
  await mkdir(join(directory, '.executions', legacy), { recursive: true });
  await writeFile(join(directory, '.executions', legacy, 'report.md'), '# 보고');
  const app = createApp(directory, bridge, { watchMs: 20 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = { 'Content-Type': 'application/json' };
  try {
    await fetch(`${base}/api/workflows/${graph.id}`, { method: 'PUT', headers: json,
      body: JSON.stringify({ ...graph, runId: 'run-old', executions: [{ id: 'exec-1', label: '#1', bindings: { [graph.nodes[0].id]: 'task-a', [graph.nodes[1].id]: 'task-b' }, skipped: [graph.nodes[1].id] }] }) });
    const [entry] = await (await fetch(`${base}/api/workflows/${graph.id}/logs`)).json();
    assert.equal(entry.id, legacy);
    assert.equal(entry.runId, 'run-old');
    assert.equal(entry.adopted, true);
    let detail = await (await fetch(`${base}/api/workflows/${graph.id}/logs/${legacy}`)).json();
    assert.deepEqual(detail.results.map((item: { label: string; status: string; finished: boolean }) => [item.label, item.status, item.finished]), [['#1', 'running', false]]);
    assert.equal(detail.outcome, 'running');
    // The Task completes while no canvas polls: the background watcher logs it; the untaken branch was skipped.
    status = 'completed';
    for (let i = 0; i < 50 && detail.outcome !== 'completed'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      detail = (await (await fetch(`${base}/api/workflows/${graph.id}/logs`)).json())[0];
    }
    assert.equal(detail.outcome, 'completed');
    detail = await (await fetch(`${base}/api/workflows/${graph.id}/logs/${legacy}`)).json();
    assert.deepEqual(detail.results[0].stages.map((stage: { title: string; status: string }) => [stage.title, stage.status]), [['구현 #1', 'completed'], ['검토 #1', 'skipped']]);
    assert.equal(detail.results[0].stages[1].skipped, true);
    assert.equal(detail.results[0].finished, true);
    const types = detail.events.map((event: { type: string }) => event.type);
    assert.equal(types.filter((type: string) => type === 'execution').length, 1);
    assert.equal(types.filter((type: string) => type === 'finished').length, 1);
    assert.equal(types[0], 'adopted');
    assert.match(detail.events.find((event: { type: string }) => event.type === 'execution').message, /#1 완료 — 구현 #1 완료, 검토 #1 진행 안 함/);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
test('branches: brief carries order and judges, bad branches are refused, decisions skip and close the untaken side', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-branch-test-'));
  const calls: string[][] = [];
  const bridge = createOrcaBridge(async (args) => { calls.push(args); return places(args) ?? { terminal: { handle: 'term_coord' } }; });
  const server = createApp(directory, bridge, { root: '/example/canvas' }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = { 'Content-Type': 'application/json' };
  const put = (graph: unknown) => fetch(`${base}/api/workflows/${(graph as { id: string }).id}`, { method: 'PUT', headers: json, body: JSON.stringify(graph) });
  const run = (id: string) => fetch(`${base}/api/workflows/${id}/execute`, { method: 'POST', headers: json, body: JSON.stringify({ count: 1, project: '/example/repo' }) });
  const stage = (id: string, kind = 'worker', extra = {}) => ({ id, type: 'stage', position: { x: 0, y: 0 }, data: { label: id, description: `${id} 지침`, kind, ...extra } });
  const outputs = [{ id: 'pass', label: '통과' }, { id: 'fail', label: '실패' }];
  const graph = { ...newWorkflow(), id: 'wf-branch', name: '분기', nodes: [stage('build'), stage('lint'), stage('test'),
    stage('check', 'branch', { mode: 'exclusive', judge: 'previous', outputs }), stage('verify'),
    stage('ship'), stage('fix'), stage('report', 'worker', { join: 'any' })],
    edges: [['build', 'lint'], ['build', 'test'], ['lint', 'verify'], ['test', 'verify'], ['verify', 'check'], ['check', 'ship', 'pass'], ['check', 'fix', 'fail'], ['ship', 'report'], ['fix', 'report']]
      .map(([source, target, handle]) => ({ id: `${source}-${target}`, source, target, ...(handle ? { sourceHandle: handle } : {}) })) };
  try {
    // A judge 'previous' branch needs exactly one worker in front of it.
    const twoInFront = { ...graph, id: 'wf-two', edges: [...graph.edges, { id: 'lint-check', source: 'lint', target: 'check' }] };
    assert.equal((await put(twoInFront)).status, 200);
    assert.match((await (await run('wf-two')).json()).error, /워커 하나만/);
    const oneOutput = { ...graph, id: 'wf-one', nodes: graph.nodes.map((node) => node.id === 'check' ? stage('check', 'branch', { outputs: [outputs[0]] }) : node),
      edges: graph.edges.filter((edge) => edge.id !== 'check-fix') };
    assert.equal((await put(oneOutput)).status, 200);
    assert.match((await (await run('wf-one')).json()).error, /두 개 이상/);

    assert.equal((await put(graph)).status, 200);
    assert.equal((await run('wf-branch')).status, 200);
    const launch = calls.find((args) => args[0] === 'agent')!;
    const brief = await readFile(launch[11].split(' ')[0], 'utf8');
    const stages = JSON.parse(brief.match(/```json\n(\[[\s\S]*?\])\n```/)![1]);
    assert.deepEqual(stages.map((item: { nodeId: string }) => item.nodeId), ['build', 'lint', 'test', 'verify', 'check', 'ship', 'fix', 'report']);
    assert.deepEqual(stages.map((item: { wave: number }) => item.wave), [0, 1, 1, 2, 3, 4, 4, 5]);
    assert.deepEqual(stages.find((item: { nodeId: string }) => item.nodeId === 'verify').decides, [{ nodeId: 'check', mode: 'exclusive', outputs }]);
    assert.deepEqual(stages.find((item: { nodeId: string }) => item.nodeId === 'ship').after, [{ nodeId: 'check', output: 'pass', condition: '통과' }]);
    assert.match(brief, /executions\/<실행 id>\/decisions/);

    const bindings = Object.fromEntries(graph.nodes.map((node) => [node.id, `task-${node.id}`]));
    assert.equal((await fetch(`${base}/api/workflows/wf-branch/executions`, { method: 'PUT', headers: json,
      body: JSON.stringify({ runId: 'run-a', executions: [{ id: 'exec-1', label: '#1', bindings }] }) })).status, 200);
    const decide = (body: unknown) => fetch(`${base}/api/workflows/wf-branch/executions/exec-1/decisions`, { method: 'POST', headers: json, body: JSON.stringify(body) });
    assert.equal((await decide({ node: 'verify', outputs: ['pass'] })).status, 400);
    assert.equal((await decide({ node: 'check', outputs: ['pass', 'fail'] })).status, 400);
    const decided = await decide({ node: 'check', outputs: ['pass'] });
    assert.equal(decided.status, 200);
    assert.deepEqual(await decided.json(), { decisions: { check: ['pass'] }, skipped: ['fix'], skippedTasks: ['task-fix'] });
    assert.equal((await decide({ node: 'check', outputs: ['pass'] })).status, 200);
    // A choice made elsewhere (the QA dashboard) names where; a repeat of the same choice is accepted, another one refused.
    assert.equal((await decide({ node: 'check', outputs: ['pass'], by: 'user', via: '\n' })).status, 400);
    assert.equal((await decide({ node: 'check', outputs: ['pass'], by: 'user', via: '대시보드' })).status, 200);
    assert.equal((await decide({ node: 'check', outputs: ['fail'] })).status, 409);
    // Re-registering the same Run keeps what was decided.
    await fetch(`${base}/api/workflows/wf-branch/executions`, { method: 'PUT', headers: json,
      body: JSON.stringify({ runId: 'run-a', executions: [{ id: 'exec-1', label: '#1', bindings }] }) });
    const saved = await (await fetch(`${base}/api/workflows/wf-branch`)).json();
    assert.deepEqual(saved.executions[0].skipped, ['fix']);
    assert.deepEqual(saved.executions[0].decisions, { check: ['pass'] });
    // The coordinator polls what was decided; the canvas reads the expanded graph to offer user decisions.
    assert.deepEqual(await (await fetch(`${base}/api/workflows/wf-branch/executions/exec-1/decisions`)).json(),
      { decisions: { check: ['pass'] }, skipped: ['fix'], skippedTasks: ['task-fix'] });
    const flow = await (await fetch(`${base}/api/workflows/wf-branch/flow`)).json();
    assert.deepEqual(flow.find((item: { id: string }) => item.id === 'check').outputLabels, { pass: '통과', fail: '실패' });
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
test('brief gives each launching stage its model (default when unset) and effort; memo groups never become stages', async () => {
  const { buildBrief } = await import('./execute.ts');
  const stage = (id: string, kind = 'worker', extra = {}) => ({ id, type: 'stage' as const, position: { x: 0, y: 0 }, data: { label: id, description: id, kind, ...extra } });
  const graph = { ...newWorkflow(), id: 'wf-launch', nodes: [
    { id: 'frame', type: 'frame' as const, position: { x: 0, y: 0 }, width: 400, height: 200, data: { label: '묶음', description: '', kind: 'frame' } },
    stage('plain'), stage('tuned', 'worker', { workerModel: 'claude-sonnet-5-5', effort: 'xhigh' }), stage('ask', 'gate', { workerModel: 'claude-haiku-5-5' }),
    stage('judge', 'branch', { judge: 'worker', effort: 'low', outputs: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })],
    edges: [{ id: 'plain-tuned', source: 'plain', target: 'tuned' }, { id: 'tuned-ask', source: 'tuned', target: 'ask' }, { id: 'ask-judge', source: 'ask', target: 'judge' }] } as never;
  const brief = buildBrief({ graph, count: 1, apiBase: 'http://127.0.0.1:1', workspace: '/example/repo', artifactDir: '/tmp/x' });
  const stages = JSON.parse(brief.match(/```json\n(\[[\s\S]*?\])\n```/)![1]) as { nodeId: string; model?: string; effort?: string }[];
  assert.deepEqual(stages.map((item) => [item.nodeId, item.model, item.effort]), [
    ['plain', 'claude-opus-5-5', undefined], ['tuned', 'claude-sonnet-5-5', 'xhigh'], ['ask', undefined, undefined], ['judge', 'claude-opus-5-5', 'low']]);
  assert.match(brief, /--model <그 단계의 model> \[--effort <그 단계의 effort>\]/);
  assert.match(brief, /`location`·`model`·`effort` 가 모두 직전 단계와 같으면/);
});
test('a gate can be asked in the terminal of the one worker before it', async () => {
  const { buildBrief, checkBranches } = await import('./execute.ts');
  const stage = (id: string, kind = 'worker', extra = {}) => ({ id, type: 'stage' as const, position: { x: 0, y: 0 }, data: { label: id, description: `${id} 지침`, kind, ...extra } });
  const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
  const graph = { ...newWorkflow(), id: 'wf-ask', nodes: [stage('impl'), stage('review', 'gate', { asker: 'previous', description: '머지해도 될까요?' }), stage('merge')],
    edges: [edge('impl', 'review'), edge('review', 'merge')] } as never as Parameters<typeof buildBrief>[0]['graph'];
  checkBranches([graph]);
  const brief = buildBrief({ graph, count: 1, apiBase: 'http://127.0.0.1:1', workspace: '/example/repo', artifactDir: '/tmp/x' });
  const stages = JSON.parse(brief.match(/```json\n(\[[\s\S]*?\])\n```/)![1]) as { nodeId: string; branch?: { judge: string }; decides?: { nodeId: string; ask?: string }[] }[];
  assert.deepEqual(stages[0].decides, [{ nodeId: 'review', mode: 'exclusive', outputs: [{ id: 'approve', label: '통과' }, { id: 'reject', label: '거절' }], ask: '머지해도 될까요?' }]);
  assert.equal(stages[1].branch?.judge, 'previous');
  assert.match(brief, /워커에서 묻는 게이트/);
  assert.match(brief, /worker_done 을 보내기 전에 이 터미널에서 사용자에게/);
  // The asking worker must be the only stage in front of the gate.
  const twoInFront = { ...graph, nodes: [...graph.nodes, stage('docs')], edges: [...graph.edges, edge('docs', 'review')] } as never as typeof graph;
  assert.throws(() => checkBranches([twoInFront]), /앞에 워커 하나만/);
  const coordinator = { ...twoInFront, nodes: twoInFront.nodes.map((node) => node.id === 'review' ? stage('review', 'gate') : node) } as never as typeof graph;
  checkBranches([coordinator]);
});
test('a link that only starts lets what follows it go on without waiting for its sub-graph', async () => {
  const { flowOf, buildBrief } = await import('./execute.ts');
  const stage = (id: string, kind = 'worker', extra = {}) => ({ id, type: 'stage' as const, position: { x: 0, y: 0 }, data: { label: id, description: id, kind, ...extra } });
  const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
  const child = { ...newWorkflow(), id: 'wf-child', name: '배포', nodes: [stage('build'), stage('deploy')], edges: [edge('build', 'deploy')] } as never as Parameters<typeof flowOf>[0];
  const parent = (linkMode?: string) => ({ ...newWorkflow(), id: 'wf-parent', name: '부모', nodes: [stage('prep'), stage('link', 'workflow', { workflowId: 'wf-child', ...(linkMode ? { linkMode } : {}) }), stage('next')],
    edges: [edge('prep', 'link'), edge('link', 'next')] } as never as Parameters<typeof flowOf>[0]);
  const linked = new Map([['wf-child', child]]);
  const after = (graph: Parameters<typeof flowOf>[0]) => Object.fromEntries(flowOf(graph, linked).map((item) => [item.id, item.after.map((dep) => dep.id)]));
  assert.deepEqual(after(parent()), { prep: [], 'link.build': ['prep'], 'link.deploy': ['link.build'], next: ['link.deploy'] });
  assert.deepEqual(after(parent('start')), { prep: [], 'link.build': ['prep'], 'link.deploy': ['link.build'], next: ['prep'] });
  const brief = buildBrief({ graph: parent('start'), linked, count: 1, apiBase: 'http://127.0.0.1:1', workspace: '/example/repo', artifactDir: '/tmp/x' });
  assert.match(brief, /"wait": false/);
});
test('natural-language generation: Orca launches an agent, its results are validated, saved and reported', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-generate-test-'));
  const calls: string[][] = [];
  const bridge = createOrcaBridge(async (args) => { calls.push(args); return places(args) ?? { terminal: { handle: 'term_gen' } }; });
  const server = createApp(directory, bridge).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = { 'Content-Type': 'application/json' };
  const post = (body: unknown) => fetch(`${base}/api/generations`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  const put = (id: string, body: unknown) => fetch(`${base}/api/generations/${id}`, { method: 'PUT', headers: json, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ kind: 'workflow', prompt: '배포', project: '/elsewhere' })).status, 400, 'only a project Orca has open');
    assert.equal((await post({ kind: 'workflow', prompt: ' ', project: '/example/repo' })).status, 400);

    const started = await (await post({ kind: 'workflow', prompt: '설계 후 구현, 검토', project: '/example/repo' })).json();
    assert.equal(started.status, 'pending');
    const launch = calls.find((args) => args[0] === 'agent')!;
    assert.deepEqual(launch.slice(0, 8), ['agent', 'launch', '--agent', 'claude', '--model', 'claude-opus-5-5', '--worktree', 'path:/example/repo']);
    const prompt = await readFile(launch[9].split(' ')[0], 'utf8');
    assert.match(prompt, /설계 후 구현, 검토/);
    assert.match(prompt, new RegExp(`/api/generations/${started.id}`));

    // A cycle is refused with a reason the agent can act on; a valid graph is laid out, saved and reported.
    const cyclic = { name: 'x', nodes: [{ id: 'a', kind: 'worker', label: 'A' }, { id: 'b', kind: 'worker', label: 'B' }], edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }] };
    assert.match((await (await put(started.id, cyclic)).json()).error, /순환/);
    const badBranch = { name: 'x', nodes: [{ id: 'a', kind: 'worker' }, { id: 'c', kind: 'branch', outputs: [{ id: 'ok', label: '통과' }] }], edges: [{ source: 'a', target: 'c' }] };
    assert.match((await (await put(started.id, badBranch)).json()).error, /두 개 이상/);
    const good = { name: '기능 개발', description: '설계부터 검토까지', nodes: [
      { id: 'design', kind: 'worker', label: '설계', description: '설계한다', effort: 'high' },
      { id: 'impl', kind: 'worker', label: '구현', description: '구현한다', workerModel: 'claude-sonnet-5-5' },
      { id: 'review', kind: 'gate', label: '검토', description: '머지할까요?', asker: 'previous', sourceHandle: 'ignored' }],
      edges: [{ source: 'design', target: 'impl' }, { source: 'impl', target: 'review' }] };
    assert.equal((await put(started.id, good)).status, 200);
    assert.equal((await put(started.id, good)).status, 409, 'a finished generation takes no second result');
    const done = await (await fetch(`${base}/api/generations/${started.id}`)).json();
    assert.equal(done.status, 'done');
    const saved = await (await fetch(`${base}/api/workflows/${done.workflowId}`)).json();
    assert.equal(saved.name, '기능 개발');
    assert.deepEqual(saved.nodes.map((node: { id: string; position: { x: number } }) => [node.id, node.position.x]), [['design', 0], ['impl', 320], ['review', 640]]);
    assert.deepEqual([saved.nodes[0].data.effort, saved.nodes[1].data.workerModel, saved.nodes[2].data.asker], ['high', 'claude-sonnet-5-5', 'previous']);

    // Instructions for one stage, with the canvas's current graph as context; the agent may also give up with a reason.
    const graph = newWorkflow();
    assert.equal((await post({ kind: 'brief', prompt: '테스트 포함', project: '/example/repo', workflow: graph, nodeId: 'missing' })).status, 400);
    const brief = await (await post({ kind: 'brief', prompt: '테스트 포함', project: '/example/repo', workflow: graph, nodeId: 'backend' })).json();
    const briefPrompt = await readFile(calls.filter((args) => args[0] === 'agent').at(-1)![9].split(' ')[0], 'utf8');
    assert.match(briefPrompt, /\*\*\[이 단계\]\*\* 백엔드 구현/);
    assert.match(briefPrompt, /바로 앞 단계: 설계/);
    assert.equal((await put(brief.id, { description: '' })).status, 400);
    assert.equal((await put(brief.id, { description: 'API 를 구현하고 테스트한다.', label: '백엔드 API' })).status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/generations/${brief.id}`)).json(),
      { ...brief, status: 'done', description: 'API 를 구현하고 테스트한다.', label: '백엔드 API' });
    const failing = await (await post({ kind: 'workflow', prompt: '불가능한 것', project: '/example/repo' })).json();
    assert.equal((await put(failing.id, { error: '요청이 모호합니다.' })).status, 200);
    assert.equal((await (await fetch(`${base}/api/generations/${failing.id}`)).json()).error, '요청이 모호합니다.');
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('one workflow runs side by side for different run-time inputs; the same inputs never overlap', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-inputs-test-'));
  const calls: string[][] = [];
  const bridge = createOrcaBridge(async (args) => {
    calls.push(args);
    const place = places(args); if (place) return place;
    if (args[0] === 'agent') return { terminal: { handle: `term_${calls.length}` } };
    const run = args[args.indexOf(args[1] === 'run-show' ? '--id' : '--run') + 1];
    if (args[1] === 'run-show') return { run: { id: run, objective: run } };
    if (args[1] === 'task-list') return { tasks: [{ id: `task-${run}`, status: 'running', deps: [] }] };
    if (args[1] === 'worker-list') return { workers: [], page: { hasMore: false } };
    return {};
  });
  const json = { 'Content-Type': 'application/json' };
  const graph = { version: 1 as const, id: 'per-ticket', name: '티켓 처리', description: '', runId: '', edges: [], nodes: [
    { id: 'wt', type: 'group' as const, position: { x: 0, y: 0 }, width: 400, height: 300,
      data: { label: '티켓', description: '', kind: 'group' as const, scope: 'worktree' as const, path: '', worktreeMode: 'create' as const, nameSource: 'input' as const } },
    { id: 'fix', type: 'stage' as const, parentId: 'wt', position: { x: 20, y: 40 }, data: { label: '수정', description: '고친다', kind: 'worker' as const } },
  ] };
  const start = (base: string, ticket: string) => fetch(`${base}/api/workflows/per-ticket/execute`, { method: 'POST', headers: json,
    body: JSON.stringify({ count: 1, project: '/example/repo', inputs: { wt: ticket } }) });
  const register = (base: string, body: unknown) => fetch(`${base}/api/workflows/per-ticket/executions`, { method: 'PUT', headers: json, body: JSON.stringify(body) });
  let server = createApp(directory, bridge).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
  try {
    assert.equal((await fetch(`${base}/api/workflows/per-ticket`, { method: 'PUT', headers: json, body: JSON.stringify(graph) })).status, 200);
    assert.equal((await start(base, 'ABC-1')).status, 200);
    assert.equal((await start(base, 'ABC-1')).status, 409); // same ticket within the cooldown
    assert.equal((await start(base, 'ABC-2')).status, 200); // another ticket starts its own coordinator
    assert.equal(calls.filter((args) => args[0] === 'agent').length, 2);
    const logs = await (await fetch(`${base}/api/workflows/per-ticket/logs`)).json() as { id: string; inputs?: Record<string, string> }[];
    const first = logs.find((entry) => entry.inputs?.wt === 'ABC-1')!;
    const second = logs.find((entry) => entry.inputs?.wt === 'ABC-2')!;
    const brief = (await (await fetch(`${base}/api/workflows/per-ticket/logs/${first.id}/files/brief.md`)).json()).text as string;
    assert.match(brief, new RegExp(`"launch":"${first.id}"`));
    assert.match(brief, /"id":"<run_id>-1"/);

    // The older request registers after the newer one started: it still lands on its own launch, not the newest.
    assert.equal((await register(base, { runId: 'run-a', launch: first.id, executions: [{ id: 'run-a-1', label: '#1', bindings: { fix: 'task-run-a' } }] })).status, 200);
    assert.equal((await register(base, { runId: 'run-b', launch: second.id, executions: [{ id: 'run-b-1', label: '#1', bindings: { fix: 'task-run-b' } }] })).status, 200);
    const stored = await (await fetch(`${base}/api/workflows/per-ticket`)).json();
    assert.equal(stored.runId, 'run-b');
    assert.deepEqual(stored.executions.map((item: { id: string; label: string; runId: string; inputs: Record<string, string> }) => [item.id, item.label, item.runId, item.inputs.wt]),
      [['run-a-1', 'ABC-1 #1', 'run-a', 'ABC-1'], ['run-b-1', 'ABC-2 #1', 'run-b', 'ABC-2']]);
    assert.equal((await (await fetch(`${base}/api/workflows/per-ticket/logs/${first.id}`)).json()).meta.runId, 'run-a');
    assert.equal((await (await fetch(`${base}/api/workflows/per-ticket/logs/${second.id}`)).json()).meta.runId, 'run-b');
    // An execution id another Run already uses is refused with a hint; re-registering a Run replaces only its own.
    const clash = await register(base, { runId: 'run-c', executions: [{ id: 'run-a-1', label: '#1', bindings: { fix: 'task-run-c' } }] });
    assert.equal(clash.status, 400);
    assert.match((await clash.json()).error, /run-c-<n>/);
    assert.equal((await register(base, { runId: 'run-a', launch: first.id, executions: [{ id: 'run-a-1', label: '#1', bindings: { fix: 'task-run-a' } }] })).status, 200);
    assert.equal((await (await fetch(`${base}/api/workflows/per-ticket`)).json()).executions.length, 2);
    // A decision on one ticket's execution leaves the other ticket's untouched.
    assert.equal((await (await fetch(`${base}/api/workflows/per-ticket/executions/run-b-1/decisions`)).json()).skipped.length, 0);

    // After the cooldown (a fresh server), a ticket still in progress is refused; a new ticket is not.
    await close();
    server = createApp(directory, bridge).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const busy = await start(base, 'ABC-1');
    assert.equal(busy.status, 409);
    assert.match((await busy.json()).error, /같은 입력/);
    assert.equal((await start(base, 'ABC-3')).status, 200);
  } finally {
    await close();
    await rm(directory, { recursive: true, force: true });
  }
});
test('a spawn link starts one separate execution of its target per reported item, once per item', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-spawn-test-'));
  const calls: string[][] = [];
  const bridge = createOrcaBridge(async (args) => {
    calls.push(args);
    const place = places(args); if (place) return place;
    if (args[0] === 'agent') return { terminal: { handle: `term_${calls.length}` } };
    return {};
  });
  const json = { 'Content-Type': 'application/json' };
  const target = { version: 1 as const, id: 'per-ticket', name: '티켓 처리', description: '', runId: '', edges: [], nodes: [
    { id: 'wt', type: 'group' as const, position: { x: 0, y: 0 }, width: 400, height: 300,
      data: { label: '티켓', description: '', kind: 'group' as const, scope: 'worktree' as const, path: '', worktreeMode: 'create' as const, nameSource: 'input' as const } },
    { id: 'fix', type: 'stage' as const, parentId: 'wt', position: { x: 20, y: 40 }, data: { label: '수정', description: '고친다', kind: 'worker' as const } },
  ] };
  const stage = (id: string, kind: 'worker' | 'workflow', extra = {}) => ({ id, type: 'stage' as const, position: { x: 0, y: 0 }, data: { label: id, description: id, kind, ...extra } });
  const picker = { version: 1 as const, id: 'picker', name: '선별', description: '', runId: '',
    nodes: [stage('pick', 'worker'), stage('fan', 'workflow', { workflowId: 'per-ticket', linkMode: 'spawn' }), stage('after', 'worker')],
    edges: [{ id: 'e1', source: 'pick', target: 'fan' }, { id: 'e2', source: 'fan', target: 'after' }] };
  const server = createApp(directory, bridge).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const put = (graph: unknown) => fetch(`${base}/api/workflows/${(graph as { id: string }).id}`, { method: 'PUT', headers: json, body: JSON.stringify(graph) });
  const execute = (id: string) => fetch(`${base}/api/workflows/${id}/execute`, { method: 'POST', headers: json, body: JSON.stringify({ count: 1, project: '/example/repo' }) });
  const spawn = (body: unknown) => fetch(`${base}/api/workflows/picker/executions/run-p-1/spawn`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  try {
    assert.equal((await put(target)).status, 200);
    // Refused before a coordinator starts: no worker in front, or a target without exactly one run-time input.
    assert.equal((await put({ ...picker, id: 'loose', edges: [picker.edges[1]] })).status, 200);
    assert.match((await (await execute('loose')).json()).error, /워커 하나만/);
    assert.equal((await put({ ...target, id: 'no-input', nodes: [target.nodes[1]].map((node) => ({ ...node, parentId: undefined })) })).status, 200);
    assert.equal((await put({ ...picker, id: 'no-input-link', nodes: [picker.nodes[0], stage('fan', 'workflow', { workflowId: 'no-input', linkMode: 'spawn' }), picker.nodes[2]] })).status, 200);
    assert.match((await (await execute('no-input-link')).json()).error, /정확히 하나/);
    assert.equal(calls.filter((args) => args[0] === 'agent').length, 0);

    assert.equal((await put(picker)).status, 200);
    assert.equal((await execute('picker')).status, 200);
    const [log] = await (await fetch(`${base}/api/workflows/picker/logs`)).json();
    const brief = (await (await fetch(`${base}/api/workflows/picker/logs/${log.id}/files/brief.md`)).json()).text as string;
    assert.match(brief, /"reportsItems": \[\s*"fan"\s*\]/);
    assert.match(brief, /"spawn": \{\s*"workflowId": "per-ticket",\s*"name": "티켓 처리",\s*"input": "wt"/);
    assert.match(brief, /\/api\/workflows\/picker\/executions\/<실행 id>\/spawn/);
    // Not expanded: the link stays one stage that follows the worker.
    const flow = await (await fetch(`${base}/api/workflows/picker/flow`)).json();
    assert.deepEqual(flow.map((item: { id: string; after: { id: string }[] }) => [item.id, item.after.map((after) => after.id)]), [['pick', []], ['fan', ['pick']], ['after', ['fan']]]);

    assert.equal((await fetch(`${base}/api/workflows/picker/executions`, { method: 'PUT', headers: json,
      body: JSON.stringify({ runId: 'run-p', launch: log.id, executions: [{ id: 'run-p-1', label: '#1', bindings: { pick: 'tp1', fan: 'tp2', after: 'tp3' } }] }) })).status, 200);
    assert.equal((await spawn({ node: 'pick', project: '/example/repo', items: ['ABC-1'] })).status, 400);
    assert.equal((await spawn({ node: 'fan', project: '/example/repo', items: ['bad name'] })).status, 400);
    const first = await (await spawn({ node: 'fan', project: '/example/repo', items: ['ABC-1', 'ABC-2', 'ABC-1'] })).json();
    assert.deepEqual(first.results.map((item: { item: string; status: string }) => [item.item, item.status]), [['ABC-1', 'requested'], ['ABC-2', 'requested']]);
    const again = await (await spawn({ node: 'fan', project: '/somewhere/else', items: ['ABC-1', 'ABC-3'] })).json();
    assert.deepEqual(again.results.map((item: { item: string; status: string }) => [item.item, item.status]), [['ABC-1', 'already'], ['ABC-3', 'failed']]);
    assert.match(again.results[1].error, /프로젝트/);
    assert.equal(calls.filter((args) => args[0] === 'agent').length, 3); // picker + two tickets

    const launches = await (await fetch(`${base}/api/workflows/per-ticket/logs`)).json() as { inputs?: Record<string, string>; last?: { message: string } }[];
    assert.deepEqual(launches.map((item) => item.inputs?.wt).sort(), ['ABC-1', 'ABC-2']);
    const requested = (await (await fetch(`${base}/api/workflows/per-ticket/logs/${(launches[0] as unknown as { id: string }).id}`)).json()).events[0].message as string;
    assert.match(requested, /「선별」 #1 의 fan/);
    const stored = (await (await fetch(`${base}/api/workflows/picker`)).json()).executions[0];
    assert.deepEqual(stored.spawned.fan.map((item: { item: string; error?: string }) => [item.item, !!item.error]), [['ABC-1', false], ['ABC-2', false], ['ABC-3', true]]);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
test('workflow settings: asked per run, fixed per automation, written into instructions, and passed on by spawn links', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-values-test-'));
  const bridge = createOrcaBridge(async (args) => {
    const place = places(args); if (place) return place;
    if (args[0] === 'agent') return { terminal: { handle: 'term_x' } };
    if (args[0] === 'automations' && args[1] === 'create') return { automation: { id: 'orca-auto-1' } };
    if (args[0] === 'automations' && args[1] === 'list') return { automations: [] };
    return {};
  });
  const json = { 'Content-Type': 'application/json' };
  const variables = [{ key: 'epic', label: '에픽', required: true }, { key: 'sheet', label: 'TC 시트', default: 'https://example.com/sheet' }];
  const stage = (id: string, description: string, extra = {}) => ({ id, type: 'stage' as const, position: { x: 0, y: 0 }, data: { label: id, description, kind: 'worker' as const, ...extra } });
  const target = { version: 1 as const, id: 'per-ticket', name: '티켓 처리', description: '', runId: '', edges: [], variables: [{ key: 'epic', label: '에픽' }, { key: 'other', label: '다른 값' }], nodes: [
    { id: 'wt', type: 'group' as const, position: { x: 0, y: 0 }, width: 400, height: 300,
      data: { label: '티켓', description: '', kind: 'group' as const, scope: 'worktree' as const, path: '', worktreeMode: 'create' as const, nameSource: 'input' as const } },
    { ...stage('fix', '{{epic}} 의 티켓을 고친다'), parentId: 'wt' },
  ] };
  const master = { version: 1 as const, id: 'master', name: '선별', description: '', runId: '', variables,
    nodes: [stage('pick', '에픽 {{epic}} 를 보고 시트 {{sheet}} 를 갱신한다'), { ...stage('fan', '', { kind: 'workflow', workflowId: 'per-ticket', linkMode: 'spawn' }) }],
    edges: [{ id: 'e1', source: 'pick', target: 'fan' }] };
  const server = createApp(directory, bridge).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const put = (graph: unknown) => fetch(`${base}/api/workflows/${(graph as { id: string }).id}`, { method: 'PUT', headers: json, body: JSON.stringify(graph) });
  const execute = (id: string, values: unknown) => fetch(`${base}/api/workflows/${id}/execute`, { method: 'POST', headers: json, body: JSON.stringify({ count: 1, project: '/example/repo', values }) });
  try {
    assert.equal((await put({ ...master, variables: [...variables, { key: 'Bad-Key', label: 'x' }] })).status, 400);
    assert.equal((await put(target)).status, 200);
    assert.equal((await put(master)).status, 200);
    assert.match((await (await execute('master', {})).json()).error, /필수 설정값.*「에픽」/);
    assert.match((await (await execute('master', { epic: 'ABC-100', nope: 'x' })).json()).error, /없는 설정값.*nope/);
    assert.match((await (await execute('master', { epic: 'two\nlines' })).json()).error, /한 줄/);
    assert.equal((await execute('master', { epic: ' ABC-100 ' })).status, 200);
    const [log] = await (await fetch(`${base}/api/workflows/master/logs`)).json();
    assert.deepEqual(log.values, { epic: 'ABC-100', sheet: 'https://example.com/sheet' }); // the default fills what was not given
    const brief = (await (await fetch(`${base}/api/workflows/master/logs/${log.id}/files/brief.md`)).json()).text as string;
    assert.match(brief, /에픽 ABC-100 를 보고 시트 https:\/\/example\.com\/sheet 를 갱신한다/);
    assert.match(brief, /`epic` 에픽: `ABC-100`/);

    // A {{key}} the workflow does not declare is refused before anything starts.
    assert.equal((await put({ ...master, id: 'typo', nodes: [stage('pick', '{{epik}} 를 본다')], edges: [] })).status, 200);
    assert.match((await (await execute('typo', { epic: 'ABC-100' })).json()).error, /\{\{epik\}\}.*설정값에 없습니다/);

    // An automation keeps what was typed (not the defaults) and runs with it.
    const created = await (await fetch(`${base}/api/workflows/master/automations`, { method: 'POST', headers: json,
      body: JSON.stringify({ name: '주기', trigger: 'hourly', project: '/example/repo', count: 1, values: { epic: 'ABC-200' }, cleanup: { coordinator: true, worktrees: false, sessions: true } }) })).json();
    const config = created.automations[0];
    assert.deepEqual(config.values, { epic: 'ABC-200' });
    const fired = await (await fetch(`${base}/api/workflows/master/automations/${config.id}/brief`, { method: 'POST' })).json();
    assert.match(await readFile(fired.briefPath, 'utf8'), /에픽 ABC-200 를 보고/);

    // The spawn link passes the run's values on, for the keys the target declares.
    assert.equal((await fetch(`${base}/api/workflows/master/executions`, { method: 'PUT', headers: json,
      body: JSON.stringify({ runId: 'run-m', launch: log.id, executions: [{ id: 'run-m-1', label: '#1', bindings: { pick: 't1', fan: 't2' } }] }) })).status, 200);
    const spawned = await (await fetch(`${base}/api/workflows/master/executions/run-m-1/spawn`, { method: 'POST', headers: json,
      body: JSON.stringify({ node: 'fan', project: '/example/repo', items: ['ABC-1'] }) })).json();
    assert.equal(spawned.results[0].status, 'requested');
    const child = await (await fetch(`${base}/api/workflows/per-ticket/logs/${spawned.results[0].launch}`)).json();
    assert.deepEqual(child.meta.values, { epic: 'ABC-100' });
    const childBrief = (await (await fetch(`${base}/api/workflows/per-ticket/logs/${spawned.results[0].launch}/files/brief.md`)).json()).text as string;
    assert.match(childBrief, /ABC-100 의 티켓을 고친다/);
    assert.match(childBrief, /`other` 다른 값: \(없음\)/);
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
test('loops: a branch output goes back with a limit; the decision API starts a new round and the coordinator binds its Tasks', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-loop-test-'));
  const bridge = createOrcaBridge(async (args) => {
    const place = places(args); if (place) return place;
    if (args[0] === 'agent') return { terminal: { handle: 'term_x' } };
    return {};
  });
  const json = { 'Content-Type': 'application/json' };
  const stage = (id: string, extra = {}) => ({ id, type: 'stage' as const, position: { x: 0, y: 0 }, data: { label: id, description: id, kind: 'worker' as const, ...extra } });
  const result = stage('result', { kind: 'branch', mode: 'exclusive', judge: 'previous', outputs: [{ id: 'pass', label: '통과' }, { id: 'fix', label: '보완' }, { id: 'stop', label: '막힘' }] });
  const edges = [{ id: 'e1', source: 'impl', target: 'review' }, { id: 'e2', source: 'review', target: 'result' },
    { id: 'e3', source: 'result', target: 'done', sourceHandle: 'pass' }, { id: 'e4', source: 'result', target: 'blocked', sourceHandle: 'stop' }];
  const back = { id: 'back', source: 'result', target: 'impl', sourceHandle: 'fix', loop: { max: 2, exit: 'stop' } };
  const graph = { version: 1 as const, id: 'looping', name: '반복', description: '', runId: '', nodes: [stage('impl'), stage('review'), result, stage('done'), stage('blocked')], edges: [...edges, back] };
  const server = createApp(directory, bridge).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const put = (doc: unknown) => fetch(`${base}/api/workflows/${(doc as { id: string }).id}`, { method: 'PUT', headers: json, body: JSON.stringify(doc) });
  const errorOf = async (doc: unknown) => (await (await put(doc)).json()).error as string;
  const decide = (outputs: string[]) => fetch(`${base}/api/workflows/looping/executions/run-l-1/decisions`, { method: 'POST', headers: json, body: JSON.stringify({ node: 'result', outputs }) });
  try {
    // Saving: a plain back edge is a cycle; a loop needs a limit, an exit, an exclusive branch output of its own, and a stage before it.
    assert.match(await errorOf({ ...graph, edges: [...edges, { ...back, loop: undefined }] }), /순환합니다.*되돌아가기/);
    assert.match(await errorOf({ ...graph, edges: [...edges, { ...back, loop: { max: 0, exit: 'stop' } }] }), /최대 반복/);
    assert.match(await errorOf({ ...graph, edges: [...edges, { ...back, loop: { max: 2, exit: 'fix' } }] }), /다른 출력/);
    assert.match(await errorOf({ ...graph, edges: [...edges, { ...back, sourceHandle: 'pass' }] }), /다른 연결을 둘 수 없습니다/);
    assert.match(await errorOf({ ...graph, edges: [...edges, { ...back, target: 'done', sourceHandle: 'fix' }] }), /앞에 있는/);
    assert.match(await errorOf({ ...graph, nodes: graph.nodes.map((node) => node.id === 'result' ? { ...result, data: { ...result.data, mode: 'inclusive' } } : node) }), /하나만/);
    assert.equal((await put(graph)).status, 200);
    const saved = await (await fetch(`${base}/api/workflows/looping`)).json();
    assert.deepEqual(saved.edges.find((edge: { id: string }) => edge.id === 'back').loop, { max: 2, exit: 'stop' });

    // Expanding a looping workflow through a link is refused; the brief carries the loop.
    assert.equal((await put({ version: 1, id: 'outer', name: '바깥', description: '', runId: '', edges: [], nodes: [stage('link', { kind: 'workflow', workflowId: 'looping' })] })).status, 200);
    assert.match((await (await fetch(`${base}/api/workflows/outer/execute`, { method: 'POST', headers: json, body: JSON.stringify({ count: 1, project: '/example/repo' }) })).json()).error, /되돌아가기 연결이 있습니다/);
    assert.equal((await fetch(`${base}/api/workflows/looping/execute`, { method: 'POST', headers: json, body: JSON.stringify({ count: 1, project: '/example/repo' }) })).status, 200);
    const [log] = await (await fetch(`${base}/api/workflows/looping/logs`)).json();
    const brief = (await (await fetch(`${base}/api/workflows/looping/logs/${log.id}/files/brief.md`)).json()).text as string;
    assert.match(brief, /"loops": \[\s*\{\s*"edge": "back",\s*"output": "fix",\s*"to": "impl",\s*"max": 2,\s*"exit": "stop",\s*"body": \[\s*"impl",\s*"review",\s*"result"\s*\]/);
    assert.match(brief, /"nodeId": "impl",[\s\S]*?"after": \[\]/); // the loop edge is not a dependency
    assert.match(brief, /executions\/<실행 id>\/bindings/);

    assert.equal((await fetch(`${base}/api/workflows/looping/executions`, { method: 'PUT', headers: json, body: JSON.stringify({ runId: 'run-l', launch: log.id,
      executions: [{ id: 'run-l-1', label: '#1', bindings: { impl: 't1', review: 't2', result: 't3', done: 't4', blocked: 't5' } }] }) })).status, 200);
    const first = await (await decide(['fix'])).json();
    assert.deepEqual(first.loop, { edge: 'back', to: 'impl', restart: ['impl', 'review', 'result'], pass: 2, max: 2, remaining: 1 });
    assert.deepEqual(first.skippedTasks, []);
    assert.equal((await (await decide(['fix'])).json()).loop.pass, 2); // a retried request does not go round again
    const patch = (bindings: unknown) => fetch(`${base}/api/workflows/looping/executions/run-l-1/bindings`, { method: 'PATCH', headers: json, body: JSON.stringify({ bindings }) });
    assert.equal((await patch({ nope: 't9' })).status, 400);
    assert.deepEqual((await (await patch({ impl: 't6', review: 't7', result: 't8' })).json()).bindings, { done: 't4', blocked: 't5', impl: 't6', review: 't7', result: 't8' });
    assert.equal((await (await decide(['fix'])).json()).loop.pass, 3);
    await patch({ impl: 't9', review: 't10', result: 't11' });
    const last = await (await decide(['fix'])).json();
    assert.deepEqual(last.exhausted, { output: 'stop', max: 2 });
    assert.deepEqual(last.decisions, { result: ['stop'] });
    assert.deepEqual(last.skippedTasks, ['t4']);
    const detail = await (await fetch(`${base}/api/workflows/looping/logs/${log.id}`)).json();
    assert.equal(detail.meta.executions[0].tasks.length, 11);
    assert.ok(detail.events.some((event: { type: string; message: string }) => event.type === 'note' && /되돌아가기 → impl 2회차/.test(event.message)));
    assert.ok(detail.events.some((event: { type: string; message: string }) => event.type === 'note' && /최대 반복 2회를 다 써서 stop/.test(event.message)));
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('a coordinator worktree group: the server reuses or creates it (under the parent setting) and starts the coordinator inside it', async () => {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-coordinator-test-'));
  const calls: string[][] = [];
  const existing = [{ path: '/example/worktrees/ABC-2', displayName: 'ABC-2', branch: 'refs/heads/ABC-2' }];
  const bridge = createOrcaBridge(async (args) => {
    calls.push(args);
    if (args[0] === 'repo') return places(args)!;
    if (args[0] === 'worktree' && args[1] === 'list') return { worktrees: args.includes('--repo') ? existing : [] };
    if (args[0] === 'worktree' && args[1] === 'create') return { worktree: { path: `/example/worktrees/${args[args.indexOf('--name') + 1]}` } };
    if (args[0] === 'agent') return { terminal: { handle: `term_${calls.length}` } };
    return {};
  });
  const json = { 'Content-Type': 'application/json' };
  const ticket = { version: 1 as const, id: 'ticket', name: '티켓 해결', description: '', runId: '', edges: [], coordinatorGroup: 'wt',
    variables: [{ key: 'parent_worktree', label: '에픽 워크트리' }], nodes: [
      { id: 'wt', type: 'group' as const, position: { x: 0, y: 0 }, width: 400, height: 300,
        data: { label: '티켓', description: '', kind: 'group' as const, scope: 'worktree' as const, path: '', worktreeMode: 'create' as const, nameSource: 'input' as const, parentPath: '{{parent_worktree}}' } },
      { id: 'fix', type: 'stage' as const, parentId: 'wt', position: { x: 20, y: 40 }, data: { label: '수정', description: '고친다', kind: 'worker' as const } },
    ] };
  const server = createApp(directory, bridge).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const put = (graph: unknown) => fetch(`${base}/api/workflows/${(graph as { id: string }).id}`, { method: 'PUT', headers: json, body: JSON.stringify(graph) });
  const execute = (id: string, inputs: Record<string, string>, values: Record<string, string> = {}) =>
    fetch(`${base}/api/workflows/${id}/execute`, { method: 'POST', headers: json, body: JSON.stringify({ count: 1, project: '/example/repo', inputs, values }) });
  const settled = async (agents: number) => { for (let i = 0; i < 100 && calls.filter((args) => args[0] === 'agent').length < agents; i += 1) await new Promise((resolve) => setTimeout(resolve, 20)); };
  const latestBrief = async (id: string) => {
    const [log] = await (await fetch(`${base}/api/workflows/${id}/logs`)).json();
    return { log, brief: (await (await fetch(`${base}/api/workflows/${id}/logs/${log.id}/files/brief.md`)).json()).text as string };
  };
  try {
    // Stored and refused as documents: a relative parent, a coordinator group that is not a worktree group.
    assert.equal((await put({ ...ticket, id: 'bad-parent', nodes: [{ ...ticket.nodes[0], data: { ...ticket.nodes[0].data, parentPath: 'relative/path' } }, ticket.nodes[1]] })).status, 400);
    assert.equal((await put({ ...ticket, id: 'bad-group', coordinatorGroup: 'fix' })).status, 400);
    // Refused before anything is created: an agent-named group cannot hold the coordinator; nor a run without its name.
    assert.equal((await put({ ...ticket, id: 'agent-named', nodes: [{ ...ticket.nodes[0], data: { ...ticket.nodes[0].data, nameSource: 'agent', nameFrom: 'pick' } }, ticket.nodes[1],
      { id: 'pick', type: 'stage' as const, position: { x: 0, y: 400 }, data: { label: '고르기', description: '고른다', kind: 'worker' as const } }] })).status, 200);
    assert.match((await (await execute('agent-named', {})).json()).error, /코디네이터를 띄우기 전에/);
    assert.equal((await put(ticket)).status, 200);
    assert.match((await (await execute('ticket', { wt: '' })).json()).error, /워크트리 이름/);
    assert.equal(calls.filter((args) => args[0] === 'worktree' && args[1] === 'create').length + calls.filter((args) => args[0] === 'agent').length, 0);

    // New ticket: created under the parent setting, coordinator started inside it, brief marks it prepared.
    assert.equal((await execute('ticket', { wt: 'ABC-1' }, { parent_worktree: '/example/worktrees/epic' })).status, 200);
    await settled(1);
    const create = calls.find((args) => args[0] === 'worktree' && args[1] === 'create')!;
    assert.deepEqual(create.slice(create.indexOf('--parent-worktree'), create.indexOf('--parent-worktree') + 2), ['--parent-worktree', 'path:/example/worktrees/epic']);
    assert.ok(!create.includes('--no-parent'));
    const launch = calls.filter((args) => args[0] === 'agent')[0];
    assert.equal(launch[launch.indexOf('--worktree') + 1], 'path:/example/worktrees/ABC-1');
    let { log, brief } = await latestBrief('ticket');
    assert.match(brief, /"prepared": true/);
    assert.match(brief, /"parentPath": "\/example\/worktrees\/epic"/);
    const events = (await (await fetch(`${base}/api/workflows/ticket/logs/${log.id}`)).json()).events.map((event: { message: string }) => event.message).join('\n');
    assert.match(events, /새로 생성 \(부모 \/example\/worktrees\/epic\): \/example\/worktrees\/ABC-1/);

    // Reopened ticket: its worktree is reused as it is; nothing created.
    assert.equal((await execute('ticket', { wt: 'ABC-2' }, { parent_worktree: '/example/worktrees/epic' })).status, 200);
    await settled(2);
    assert.equal(calls.filter((args) => args[0] === 'worktree' && args[1] === 'create').length, 1);
    assert.equal(calls.filter((args) => args[0] === 'agent')[1][calls.filter((args) => args[0] === 'agent')[1].indexOf('--worktree') + 1], 'path:/example/worktrees/ABC-2');
    ({ log } = await latestBrief('ticket'));
    const reused = (await (await fetch(`${base}/api/workflows/ticket/logs/${log.id}`)).json()).events.map((event: { message: string }) => event.message).join('\n');
    assert.match(reused, /재사용: \/example\/worktrees\/ABC-2/);

    // No parent value: created with no parent.
    assert.equal((await execute('ticket', { wt: 'ABC-3' })).status, 200);
    await settled(3);
    assert.ok(calls.filter((args) => args[0] === 'worktree' && args[1] === 'create')[1].includes('--no-parent'));
  } finally {
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});

test('the brief marks the coordinator worktree prepared only when the server started the coordinator there', async () => {
  const { buildBrief } = await import('./execute.ts');
  const graph = { version: 1 as const, id: 'wf', name: 'wf', description: '', runId: '', edges: [], coordinatorGroup: 'wt', nodes: [
    { id: 'wt', type: 'group' as const, position: { x: 0, y: 0 }, data: { label: '티켓', description: '', kind: 'group' as const, scope: 'worktree' as const, path: '', worktreeMode: 'create' as const, nameSource: 'fixed' as const, worktreeName: 'T-1', parentPath: '/epic' } },
    { id: 'a', type: 'stage' as const, parentId: 'wt', position: { x: 0, y: 0 }, data: { label: 'a', description: 'a', kind: 'worker' as const } },
  ] };
  const common = { graph, count: 1, apiBase: 'http://127.0.0.1:1', workspace: '/run/project', artifactDir: '/tmp/x' };
  assert.doesNotMatch(buildBrief(common), /"prepared"/); // an automation's own agent coordinates from the project
  assert.match(buildBrief(common), /"parentPath": "\/epic"/);
  assert.match(buildBrief({ ...common, preparedGroup: 'wt' }), /"prepared": true/);
});
test('a gate set to approve automatically is never asked: the coordinator registers approve and logs it', async () => {
  const { buildBrief, checkBranches, flowOf } = await import('./execute.ts');
  const { pendingDecisions } = await import('../src/model.ts');
  const stage = (id: string, kind = 'worker', extra = {}) => ({ id, type: 'stage' as const, position: { x: 0, y: 0 }, data: { label: id, description: `${id} 지침`, kind, ...extra } });
  const edge = (source: string, target: string) => ({ id: `${source}-${target}`, source, target });
  const graph = { ...newWorkflow(), id: 'wf-auto', nodes: [stage('analyze'), stage('direction', 'gate', { asker: 'auto' }), stage('impl')],
    edges: [edge('analyze', 'direction'), edge('direction', 'impl')] } as never as Parameters<typeof buildBrief>[0]['graph'];
  checkBranches([graph]);
  const brief = buildBrief({ graph, count: 1, apiBase: 'http://127.0.0.1:1', workspace: '/example/repo', artifactDir: '/tmp/x' });
  const stages = JSON.parse(brief.match(/```json\n(\[[\s\S]*?\])\n```/)![1]) as { nodeId: string; branch?: { judge: string }; decides?: unknown[] }[];
  assert.equal(stages[1].branch?.judge, 'auto');
  assert.equal(stages[0].decides, undefined); // no worker asks it
  assert.match(brief, /자동 승인 게이트\(kind `gate`, judge `auto`\)/);
  // It never shows up as a decision waiting for the user.
  const flow = flowOf(graph, new Map());
  const execution = { id: 'e-1', label: '#1', bindings: { analyze: 'task-a', direction: 'task-d', impl: 'task-i' } };
  const snapshot = { run: { id: 'run-a', objective: 'A', updatedAt: '' }, workers: [], observedAt: '',
    tasks: [{ id: 'task-a', title: 'a', spec: '', status: 'completed', deps: [] }, { id: 'task-d', title: 'd', spec: '', status: 'pending', deps: [] }] };
  assert.deepEqual(pendingDecisions(flow, execution, snapshot), []);
});
test('the brief makes the coordinator stop waiting on a dead worker and close itself once every run has ended', async () => {
  const { buildBrief } = await import('./execute.ts');
  const graph = { ...newWorkflow(), id: 'wf-close' } as never as Parameters<typeof buildBrief>[0]['graph'];
  const brief = buildBrief({ graph, count: 1, apiBase: 'http://127.0.0.1:1', workspace: '/example/repo', artifactDir: '/tmp/x',
    cleanup: { sessions: true, worktrees: false, coordinator: true } });
  assert.match(brief, /\*\*죽은 워커\*\*/);
  assert.match(brief, /실패한 단계·남은 확인·남긴 워크트리가 있어도 닫는다/);
  assert.doesNotMatch(brief, /남은 것이 있으면 닫지 않고 사용자를 기다린다/);
  assert.match(brief, /자기 `location` 워크트리를 지우거나/);
  assert.match(brief, /판정이 이미 등록됐는지 본다/);
});
test('a coordinator still open after its run ended is due for closing: a minute after its report, or after the grace without one', async () => {
  const { createRunLog } = await import('./runlog.ts');
  const root = await mkdtemp(join(process.cwd(), '.tmp-runlog-'));
  try {
    const runlog = createRunLog(root);
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-wf-close`;
    await mkdir(join(root, id));
    await runlog.start(id, { workflowId: 'wf-close', workflowName: 'W', startedAt: new Date().toISOString(), closeCoordinator: true });
    await runlog.patchMeta(id, { coordinatorTerminal: 'term_coord' });
    const t0 = Date.now();
    const at = (ms: number) => new Date(t0 + ms).toISOString();
    await runlog.append(id, { at: at(0), type: 'task', taskId: 'task-a', status: 'completed', message: 'a' });
    assert.deepEqual(await runlog.coordinatorsToClose(t0 + 3600_000, 600_000), []); // not finished yet
    await runlog.append(id, { at: at(1000), type: 'finished', status: 'completed', message: '끝' });
    assert.deepEqual(await runlog.coordinatorsToClose(t0 + 5 * 60_000, 600_000), []); // no report, within the grace
    assert.deepEqual(await runlog.coordinatorsToClose(t0 + 11 * 60_000, 600_000), [{ id, terminal: 'term_coord' }]);
    await runlog.append(id, { at: at(2000), type: 'report', message: '보고' });
    assert.deepEqual(await runlog.coordinatorsToClose(t0 + 30_000, 600_000), []);
    assert.deepEqual(await runlog.coordinatorsToClose(t0 + 63_000, 600_000), [{ id, terminal: 'term_coord' }]);
    await runlog.append(id, { at: at(70_000), type: 'coordinator-closed', message: '닫음' });
    assert.deepEqual(await runlog.coordinatorsToClose(t0 + 3600_000, 600_000), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
