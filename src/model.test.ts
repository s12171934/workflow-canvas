import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingDecisions, frameContents, orderNodes, decisionError, skippedStages, topologicalOrder, waves, nodeExecutionStatus, type FlowStage, type StageNode, membershipOf, nodeLocation, aggregateStatus, executionFinished, taskStatus, projectNodes, serializableWorkflow, newWorkflow, fromSnapshot, type TaskSummary, type WorkerSummary, type RunSnapshot, executionRun, inputsKey, mergeSnapshots, workflowRuns, variableRefs, substituteVariables, resolveVariables } from './model.ts';

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
test('executions project per-execution chips in 모아 보기 and one binding in 실행 선택', () => {
  const graph = newWorkflow();
  const [first, second] = graph.nodes;
  const done = task('completed');
  const live = { ...task('running'), id: 'task-b' };
  const executions = [
    { id: 'exec-1', label: '#1', bindings: { [first.id]: 'task-a' } },
    { id: 'exec-2', label: '#2', bindings: { [first.id]: 'task-b' } },
  ];
  const snapshot: RunSnapshot = { run: { id: 'run-a', objective: 'A', updatedAt: '' }, tasks: [done, live],
    workers: [{ ...worker('live'), taskId: 'task-b' }], observedAt: '' };
  const all = projectNodes(graph.nodes, snapshot, false, executions, 'all');
  assert.deepEqual(all[0].data.runs?.map((run) => run.status), ['completed', 'running']);
  assert.equal(all[0].data.status, 'running');
  assert.equal(all[1].data.status, 'unbound');
  assert.equal(projectNodes(graph.nodes, snapshot, false, executions, 'exec-1')[0].data.status, 'completed');
  assert.equal(projectNodes(graph.nodes, snapshot, false, executions, 'exec-1')[0].data.runs, undefined);
  assert.equal(projectNodes(graph.nodes, snapshot, true, executions, 'all')[0].data.status, 'unknown');
  assert.equal(second.data.taskId, undefined);
});
test('aggregate never hides a failure behind finished executions', () => {
  assert.equal(aggregateStatus(['completed', 'failed', 'completed']), 'failed');
  assert.equal(aggregateStatus(['completed', 'completed']), 'completed');
  assert.equal(aggregateStatus(['unbound', 'unbound']), 'unbound');
});
test('saved executions drop bindings to deleted nodes', () => {
  const graph = newWorkflow();
  graph.executions = [{ id: 'exec-1', label: '#1', bindings: { [graph.nodes[0].id]: 'task-a', missing: 'task-b' } }];
  assert.deepEqual(serializableWorkflow(graph).executions?.[0].bindings, { [graph.nodes[0].id]: 'task-a' });
  assert.equal(serializableWorkflow({ ...graph, executions: [] }).executions, undefined);
});
test('an execution is finished only when nothing is open and something completed', () => {
  assert.equal(executionFinished(['completed', 'skipped']), true); // untaken branch
  assert.equal(executionFinished(['completed', 'pending']), false); // a stage still to start
  assert.equal(executionFinished(['completed', 'running']), false);
  assert.equal(executionFinished(['completed', 'failed']), false);
  assert.equal(executionFinished(['completed', 'unknown']), false);
  assert.equal(executionFinished(['pending', 'pending']), false); // not started yet
});
test('hidden executions drop from chips but the node keeps an overall status', () => {
  const graph = newWorkflow();
  const executions = [{ id: 'exec-1', label: '#1', bindings: { [graph.nodes[0].id]: 'task-a' } }];
  const snapshot: RunSnapshot = { run: { id: 'run-a', objective: 'A', updatedAt: '' }, tasks: [task('completed')], workers: [], observedAt: '' };
  const projected = projectNodes(graph.nodes, snapshot, false, executions, 'all', new Set());
  assert.deepEqual(projected[0].data.runs, []);
  assert.equal(projected[0].data.status, 'completed');
  assert.equal(projectNodes(graph.nodes, snapshot, false, executions, 'exec-1')[0].data.activeTaskId, 'task-a');
});
test('a workflow link aggregates the Tasks of its expanded sub-graph', () => {
  const graph = newWorkflow();
  const link = { ...graph.nodes[0], data: { ...graph.nodes[0].data, kind: 'workflow' as const, workflowId: 'wf-b' } };
  const snapshot: RunSnapshot = { run: { id: 'run-a', objective: 'A', updatedAt: '' },
    tasks: [task('completed'), { ...task('running'), id: 'task-b' }], workers: [{ ...worker('live'), taskId: 'task-b' }], observedAt: '' };
  const executions = [{ id: 'exec-1', label: '#1', bindings: {}, links: { [link.id]: { first: 'task-a', second: 'task-b' } } }];
  const all = projectNodes([link], snapshot, false, executions, 'all');
  assert.equal(all[0].data.status, 'running');
  const one = projectNodes([link], snapshot, false, executions, 'exec-1');
  assert.equal(one[0].data.status, 'running');
  assert.equal(one[0].data.activeTaskId, 'task-b');
});
test('groups and notes carry no status; stages inside a group run at its path', () => {
  const graph = newWorkflow();
  const group = { id: 'grp', type: 'group' as const, position: { x: 0, y: 0 }, data: { label: 'wt', description: '', kind: 'group' as const, scope: 'worktree' as const, path: '/example/wt' } };
  const inside = { ...graph.nodes[0], parentId: 'grp' };
  const note = { ...graph.nodes[1], data: { ...graph.nodes[1].data, kind: 'note' as const } };
  const doc = { nodes: [group, inside, note], workspace: '/example/default' };
  assert.equal(nodeLocation(doc, inside, '/fallback'), '/example/wt');
  assert.equal(nodeLocation(doc, graph.nodes[2], '/fallback'), '/example/default');
  assert.equal(nodeLocation({ nodes: [] }, graph.nodes[2], '/fallback'), '/fallback');
  const projected = projectNodes([group, inside, note], null, false);
  assert.equal(projected[0].data.status, undefined);
  assert.equal(projected[2].data.status, undefined);
  const saved = serializableWorkflow({ ...graph, nodes: [inside, group], edges: [] });
  assert.deepEqual(saved.nodes.map((node) => node.id), ['grp', inside.id]);
  assert.equal(saved.nodes[0].width, 640);
});
test('membership walks up through a worktree group into its project', () => {
  const graph = newWorkflow();
  const project = { id: 'p', type: 'group' as const, position: { x: 0, y: 0 }, data: { label: 'P', description: '', kind: 'group' as const, scope: 'project' as const, path: '/example/p' } };
  const worktree = { id: 'w', type: 'group' as const, parentId: 'p', position: { x: 0, y: 0 }, data: { label: 'W', description: '', kind: 'group' as const, scope: 'worktree' as const, path: '/example/w' } };
  const inWorktree = { ...graph.nodes[0], parentId: 'w' };
  const inProject = { ...graph.nodes[1], parentId: 'p' };
  const nodes = [project, worktree, inWorktree, inProject, graph.nodes[2]];
  const member = membershipOf({ nodes }, inWorktree);
  assert.equal(member.project?.id, 'p');
  assert.deepEqual(member.worktrees.map((group) => group.id), ['w']);
  assert.deepEqual(membershipOf({ nodes }, inProject).worktrees, []);
  assert.equal(membershipOf({ nodes }, graph.nodes[2]).project, undefined);
  const inner = { ...worktree, id: 'w2', parentId: 'w', data: { ...worktree.data, label: 'W2', path: '' } };
  const deep = { ...graph.nodes[3], parentId: 'w2' };
  assert.deepEqual(membershipOf({ nodes: [...nodes, inner, deep] }, deep).worktrees.map((group) => group.id), ['w', 'w2']);
});

// A worker decides an exclusive branch; one side is two stages long, both sides join again.
const flow: FlowStage[] = [
  { id: 'build', after: [] },
  { id: 'lint', after: [{ id: 'build' }] }, { id: 'test', after: [{ id: 'build' }] },
  { id: 'check', after: [{ id: 'lint' }, { id: 'test' }], branch: { mode: 'exclusive', outputs: ['pass', 'fail'] } },
  { id: 'ship', after: [{ id: 'check', output: 'pass' }] },
  { id: 'fix', after: [{ id: 'check', output: 'fail' }] }, { id: 'retest', after: [{ id: 'fix' }] },
  { id: 'report', after: [{ id: 'ship' }, { id: 'retest' }], join: 'any' },
];
test('topological order puts every stage after its predecessors, with parallel stages in one wave', () => {
  const edges = flow.flatMap((stage) => stage.after.map((item) => ({ source: item.id, target: stage.id })));
  const { order, cycle } = topologicalOrder(flow.map((stage) => stage.id).reverse(), edges);
  assert.equal(cycle, undefined);
  for (const edge of edges) assert.ok(order.indexOf(edge.source) < order.indexOf(edge.target), `${edge.source} → ${edge.target}`);
  const wave = waves(order, edges);
  assert.equal(wave.get('lint'), wave.get('test'));
  assert.equal(wave.get('report'), 5);
});
test('topological order names the loop of a cyclic graph', () => {
  const { cycle } = topologicalOrder(['a', 'b', 'c', 'd'], [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'b' }, { source: 'c', target: 'd' }]);
  assert.deepEqual(cycle, ['b', 'c', 'b']);
});
test('an undecided branch skips nothing; a decision skips the untaken side but not the join', () => {
  assert.deepEqual(skippedStages(flow, {}), []);
  assert.deepEqual(skippedStages(flow, { check: ['pass'] }), ['fix', 'retest']);
  assert.deepEqual(skippedStages(flow, { check: ['fail'] }), ['ship']);
});
test('a join behind two untaken outputs is skipped too, and so is a branch nobody reaches', () => {
  const inclusive: FlowStage[] = [
    { id: 'pick', after: [], branch: { mode: 'inclusive', outputs: ['a', 'b', 'c'] } },
    { id: 'a1', after: [{ id: 'pick', output: 'a' }] }, { id: 'b1', after: [{ id: 'pick', output: 'b' }] },
    { id: 'ab', after: [{ id: 'a1' }, { id: 'b1' }], join: 'any' },
    { id: 'c1', after: [{ id: 'pick', output: 'c' }] },
    { id: 'inner', after: [{ id: 'ab' }], branch: { mode: 'exclusive', outputs: ['x', 'y'] } }, { id: 'x1', after: [{ id: 'inner', output: 'x' }] },
  ];
  assert.deepEqual(skippedStages(inclusive, { pick: ['a', 'c'] }), ['b1']);
  assert.deepEqual(skippedStages(inclusive, { pick: ['c'] }), ['a1', 'b1', 'ab', 'inner', 'x1']);
});
test('decisions are checked against the branch: known outputs, mode, reachability and no change of mind', () => {
  assert.equal(decisionError(flow, {}, 'check', ['pass']), undefined);
  assert.match(decisionError(flow, {}, 'build', ['pass'])!, /분기·게이트 단계가 아닙니다/);
  assert.match(decisionError(flow, {}, 'check', ['maybe'])!, /출력이 아닙니다/);
  assert.match(decisionError(flow, {}, 'check', ['pass', 'fail'])!, /하나만/);
  assert.match(decisionError(flow, {}, 'check', [])!, /하나 이상/);
  assert.equal(decisionError(flow, { check: ['pass'] }, 'check', ['pass']), undefined);
  assert.match(decisionError(flow, { check: ['pass'] }, 'check', ['fail'])!, /이미/);
  const nested: FlowStage[] = [...flow, { id: 'again', after: [{ id: 'fix' }], branch: { mode: 'exclusive', outputs: ['ok', 'no'] } }];
  assert.match(decisionError(nested, { check: ['pass'] }, 'again', ['ok'])!, /건너뛴/);
});
test('a skipped stage shows as skipped even though its Task was closed as completed', () => {
  const node = (id: string, kind: StageNode['data']['kind'] = 'worker'): StageNode => ({ id, type: 'stage', position: { x: 0, y: 0 }, data: { label: id, description: '', kind } });
  const snapshot: RunSnapshot = { run: { id: 'run-a', objective: 'A', updatedAt: '' }, workers: [], observedAt: '',
    tasks: [{ id: 'task-fix', title: 'fix', spec: '', status: 'completed', deps: [] }, { id: 'task-sub', title: 'sub', spec: '', status: 'completed', deps: [] }] };
  const execution = { id: 'exec-1', label: '#1', bindings: { fix: 'task-fix' }, links: { link: { sub: 'task-sub' } }, skipped: ['fix', 'link.sub'] };
  assert.equal(nodeExecutionStatus(node('fix'), execution, snapshot, false), 'skipped');
  assert.equal(nodeExecutionStatus(node('link', 'workflow'), execution, snapshot, false), 'skipped');
  assert.equal(executionFinished(['completed', 'skipped', 'skipped']), true);
});
test('memo groups save as top-level boxes, keep no edges, and carry only what lies inside', () => {
  const graph = newWorkflow();
  const frame: StageNode = { id: 'frame-a', type: 'frame', position: { x: -40, y: 0 }, width: 700, height: 400, parentId: 'brief',
    data: { label: '앞단', description: '설계까지', kind: 'frame' } };
  const saved = serializableWorkflow({ ...graph, nodes: [...graph.nodes, frame], edges: [...graph.edges, { id: 'to-frame', source: 'brief', target: 'frame-a' }] });
  const stored = saved.nodes.find((node) => node.id === 'frame-a')!;
  assert.equal(saved.nodes[0].id, 'frame-a', 'memo groups render first, under everything');
  assert.deepEqual([stored.type, stored.parentId, stored.width, stored.height], ['frame', undefined, 700, 400]);
  assert.ok(!saved.edges.some((edge) => edge.id === 'to-frame'));
  assert.equal(orderNodes(saved.nodes)[0].id, 'frame-a');

  const nodes: Pick<StageNode, 'id' | 'data' | 'parentId'>[] = [
    { id: 'f', data: { label: '', description: '', kind: 'frame' } },
    { id: 'in', data: { label: '', description: '', kind: 'worker' } },
    { id: 'edge', data: { label: '', description: '', kind: 'worker' } },
    { id: 'out', data: { label: '', description: '', kind: 'worker' } },
    { id: 'g', data: { label: '', description: '', kind: 'group', scope: 'project' } },
    { id: 'child', parentId: 'g', data: { label: '', description: '', kind: 'worker' } },
    { id: 'big', data: { label: '', description: '', kind: 'group', scope: 'project' } },
  ];
  const rects = new Map([
    ['f', { x: 0, y: 0, width: 500, height: 300 }], ['in', { x: 10, y: 10, width: 100, height: 50 }],
    ['edge', { x: 440, y: 10, width: 100, height: 50 }], ['out', { x: 470, y: 10, width: 100, height: 50 }],
    ['g', { x: 200, y: 100, width: 200, height: 150 }], ['child', { x: 220, y: 140, width: 100, height: 50 }],
    ['big', { x: 100, y: 100, width: 600, height: 150 }],
  ]);
  assert.deepEqual(frameContents('f', nodes, rects), ['in', 'edge', 'g'], 'stages by centre, groups only whole; children ride with their group');
});
test('model and effort are saved only for nodes that start a worker', () => {
  const graph = newWorkflow();
  graph.nodes[0].data = { ...graph.nodes[0].data, workerModel: 'claude-sonnet-5-5', effort: 'high' };
  graph.nodes[5].data = { ...graph.nodes[5].data, workerModel: 'claude-sonnet-5-5', effort: 'high' }; // a gate starts no worker
  const saved = serializableWorkflow(graph);
  assert.deepEqual([saved.nodes[0].data.workerModel, saved.nodes[0].data.effort], ['claude-sonnet-5-5', 'high']);
  assert.deepEqual([saved.nodes[5].data.workerModel, saved.nodes[5].data.effort], [undefined, undefined]);
  assert.equal(serializableWorkflow(newWorkflow()).nodes[0].data.workerModel, undefined, 'unset stays unset (default)');
});

test('a pending stage keeps the execution open: only completed and skipped stages finish it', () => {
  assert.equal(executionFinished(['completed', 'pending']), false);
  assert.equal(executionFinished(['completed', 'skipped']), true);
  assert.equal(executionFinished(['pending', 'pending']), false);
});
test('user decisions open once every live predecessor finished, and close once decided', () => {
  const stages: FlowStage[] = [
    { id: 'impl', after: [] },
    { id: 'ask', after: [{ id: 'impl' }], branch: { mode: 'exclusive', outputs: ['ship', 'hold'] }, judge: 'user', label: '배포 여부', question: '배포할까요?', outputLabels: { ship: '배포', hold: '보류' } },
    { id: 'gate', after: [{ id: 'impl' }, { id: 'side' }], branch: { mode: 'exclusive', outputs: ['approve', 'reject'] }, judge: 'user', veto: ['reject'] },
    { id: 'side', after: [{ id: 'impl' }] },
    { id: 'auto', after: [{ id: 'impl' }], branch: { mode: 'exclusive', outputs: ['a', 'b'] }, judge: 'previous' },
    { id: 'ship', after: [{ id: 'ask', output: 'ship' }, { id: 'gate', output: 'approve' }] },
  ];
  const snapshot = (statuses: Record<string, string>): RunSnapshot => ({ run: { id: 'run-a', objective: 'A', updatedAt: '' }, workers: [], observedAt: '',
    tasks: Object.entries(statuses).map(([id, status]) => ({ id: `task-${id}`, title: id, spec: '', status, deps: [] })) });
  const execution = { id: 'exec-1', label: '#1', bindings: Object.fromEntries(stages.map((stage) => [stage.id, `task-${stage.id}`])) };
  assert.deepEqual(pendingDecisions(stages, execution, snapshot({ impl: 'running' })), []);
  const open = pendingDecisions(stages, execution, snapshot({ impl: 'completed', side: 'running' }));
  assert.deepEqual(open, [{ executionId: 'exec-1', executionLabel: '#1', node: 'ask', label: '배포 여부', question: '배포할까요?', mode: 'exclusive',
    outputs: [{ id: 'ship', label: '배포' }, { id: 'hold', label: '보류' }], taskId: 'task-ask' }]);
  // The gate waits for 'side' too; a skipped predecessor counts as finished.
  assert.deepEqual(pendingDecisions(stages, { ...execution, skipped: ['side'] }, snapshot({ impl: 'completed' })).map((item) => item.node), ['ask', 'gate']);
  assert.deepEqual(pendingDecisions(stages, { ...execution, decisions: { ask: ['ship'] } }, snapshot({ impl: 'completed', side: 'completed' })).map((item) => item.node), ['gate']);
  // A rejected gate stops the join even though the user branch chose its way in; an untaken branch output alone does not.
  assert.deepEqual(skippedStages(stages, { ask: ['ship'], gate: ['reject'] }), ['ship']);
  // 'ship' needs both the user's choice and the gate: choosing 'hold' skips it although the gate passed.
  assert.deepEqual(skippedStages(stages, { ask: ['hold'], gate: ['approve'] }), ['ship']);
  assert.deepEqual(skippedStages(stages, { ask: ['ship'], gate: ['approve'] }), []);
});
test('a join needs every path by default; a meeting point marked any runs when one path arrives', () => {
  const split: FlowStage[] = [
    { id: 'pick', after: [], branch: { mode: 'exclusive', outputs: ['x', 'y'] } },
    { id: 'x1', after: [{ id: 'pick', output: 'x' }] }, { id: 'y1', after: [{ id: 'pick', output: 'y' }] },
    { id: 'both', after: [{ id: 'x1' }, { id: 'y1' }] }, { id: 'either', after: [{ id: 'x1' }, { id: 'y1' }], join: 'any' },
  ];
  assert.deepEqual(skippedStages(split, { pick: ['x'] }), ['y1', 'both']);
});
test('a gate asked in the worker before it opens a card only while that worker waits for the user', () => {
  const stages: FlowStage[] = [
    { id: 'impl', after: [], label: '구현' },
    { id: 'gate', after: [{ id: 'impl' }], branch: { mode: 'exclusive', outputs: ['approve', 'reject'] }, judge: 'previous', veto: ['reject'], label: '검토', question: '머지할까요?' },
  ];
  const snapshot = (status: string): RunSnapshot => ({ run: { id: 'run-a', objective: 'A', updatedAt: '' }, workers: [], observedAt: '',
    tasks: [{ id: 'task-impl', title: 'impl', spec: '', status, deps: [] }] });
  const execution = { id: 'exec-1', label: '#1', bindings: { impl: 'task-impl', gate: 'task-gate' } };
  assert.deepEqual(pendingDecisions(stages, execution, snapshot('running')), [], 'still working: nothing to answer yet');
  assert.deepEqual(pendingDecisions(stages, execution, snapshot('waiting_for_input')).map((item) => [item.node, item.askedBy]),
    [['gate', { label: '구현', taskId: 'task-impl' }]]);
  assert.deepEqual(pendingDecisions(stages, { ...execution, decisions: { gate: ['approve'] } }, snapshot('waiting_for_input')), []);
  // A non-gate branch judged by the previous worker is never a user decision.
  assert.deepEqual(pendingDecisions([stages[0], { ...stages[1], veto: undefined }], execution, snapshot('waiting_for_input')), []);
});
test('executions of several Runs: each keeps its Run and inputs, and one merged snapshot resolves them all', () => {
  const graph = newWorkflow();
  const stage = graph.nodes.find((node) => node.data.kind === 'worker')!;
  graph.runId = 'run-b';
  graph.executions = [
    { id: 'old-1', label: '#1', bindings: { [stage.id]: 'task-old' } }, // from before executions carried a Run
    { id: 'run-a-1', label: 'ABC-1 #1', bindings: { [stage.id]: 'task-a' }, runId: 'run-a', inputs: { wt: 'ABC-1' } },
  ];
  assert.deepEqual(workflowRuns(graph), ['run-b', 'run-a']);
  assert.equal(executionRun(graph, graph.executions[0]), 'run-b');
  const saved = serializableWorkflow(graph).executions!;
  assert.deepEqual([saved[1].runId, saved[1].inputs], ['run-a', { wt: 'ABC-1' }]);
  assert.equal(saved[0].runId, undefined);
  assert.equal(inputsKey({ wt: 'ABC-1', other: '' }), inputsKey({ wt: 'ABC-1' }));
  assert.notEqual(inputsKey({ wt: 'ABC-1' }), inputsKey({ wt: 'ABC-2' }));
  const snap = (run: string, task: string, status: string) => ({ run: { id: run, objective: run, updatedAt: '' }, observedAt: `2026-01-0${run === 'run-a' ? 1 : 2}`,
    tasks: [{ id: task, title: task, spec: task, status, deps: [] }], workers: [] }) as RunSnapshot;
  const merged = mergeSnapshots([snap('run-b', 'task-old', 'completed'), snap('run-a', 'task-a', 'running')])!;
  assert.equal(merged.run.id, 'run-b');
  assert.equal(merged.observedAt, '2026-01-01');
  assert.deepEqual(graph.executions.map((execution) => nodeExecutionStatus(stage, execution, merged, false)), ['completed', 'running']);
  assert.equal(mergeSnapshots([]), null);
});
test('a spawn link reads its own Task and shows the items it requested; saving keeps its mode and requests', () => {
  const graph = newWorkflow();
  const link = { id: 'fan', type: 'stage' as const, position: { x: 0, y: 0 }, data: { label: '티켓마다', description: '', kind: 'workflow' as const, workflowId: 'per-ticket', linkMode: 'spawn' as const } };
  graph.nodes = [...graph.nodes, link];
  const spawned = { fan: [{ item: 'ABC-1', at: '2026-01-01T00:00:00Z', workflowId: 'per-ticket', launch: 'L1' }, { item: 'ABC-2', at: '2026-01-01T00:00:00Z', workflowId: 'per-ticket', error: '실패' }] };
  graph.executions = [{ id: 'run-p-1', label: '#1', bindings: { fan: 'task-fan' }, runId: 'run-p', spawned }];
  const snapshot = { run: { id: 'run-p', objective: 'p', updatedAt: '' }, observedAt: '', workers: [],
    tasks: [{ id: 'task-fan', title: 'fan', spec: '', status: 'completed', deps: [] }] } as RunSnapshot;
  assert.equal(nodeExecutionStatus(link, graph.executions[0], snapshot, false), 'completed');
  const [projected] = projectNodes([link], snapshot, false, graph.executions, 'run-p-1');
  assert.deepEqual(projected.data.spawned?.map((item) => item.item), ['ABC-1', 'ABC-2']);
  const saved = serializableWorkflow(graph);
  assert.equal(saved.nodes.find((node) => node.id === 'fan')!.data.linkMode, 'spawn');
  assert.equal(saved.nodes.find((node) => node.id === 'fan')!.data.spawned, undefined);
  assert.equal(saved.executions![0].spawned!.fan.length, 2);
});
test('settings: {{key}} references, substitution, defaults and required keys; saving keeps the declarations', () => {
  assert.deepEqual(variableRefs('{{epic}} · {{ sheet }} · {{epic}} · {{Bad}} · {epic}'), ['epic', 'sheet']);
  assert.equal(substituteVariables('{{epic}} / {{ sheet }} / {{none}}', { epic: 'ABC-1', sheet: 'S' }), 'ABC-1 / S / {{none}}');
  const variables = [{ key: 'epic', label: '에픽', required: true }, { key: 'sheet', label: '시트', default: 'S' }, { key: 'note', label: '메모' }];
  assert.deepEqual(resolveVariables(variables, { epic: ' ABC-1 ' }), { values: { epic: 'ABC-1', sheet: 'S' }, missing: [] });
  assert.deepEqual(resolveVariables(variables, {}).missing.map((item) => item.key), ['epic']);
  const graph = { ...newWorkflow(), variables: [{ key: 'epic', label: '  ', required: true, description: '' }] };
  assert.deepEqual(serializableWorkflow(graph).variables, [{ key: 'epic', label: 'epic', required: true }]);
  assert.equal(serializableWorkflow(newWorkflow()).variables, undefined);
});
