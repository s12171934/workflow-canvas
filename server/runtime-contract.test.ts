import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.ts';
import { createOrcaBridge } from './orca.ts';
import { newWorkflow, type Workflow } from '../src/model.ts';

/** Starts the API on a temporary data directory with a fake Orca. */
async function serve(name: string, answer: (args: string[]) => unknown = () => ({})) {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), `${name}-`));
  const bridge = createOrcaBridge(async (args) => answer(args) as Record<string, unknown>);
  const server = createApp(directory, bridge).listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => {
    await new Promise<void>((done, fail) => { server.close((error) => error ? fail(error) : done()); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  };
  return { base, directory, close };
}
const json = { 'Content-Type': 'application/json' };

test('(f) PUT keeps the stored executions, runs in the runtime queue, and honours If-Match', async () => {
  const { base, close } = await serve('api-put-guard');
  const put = (doc: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/workflows/${(doc as Workflow).id}`, { method: 'PUT', headers: { ...json, ...headers }, body: JSON.stringify(doc) });
  try {
    const graph = { ...newWorkflow(), id: 'guarded' };
    const stageId = graph.nodes.find((node) => node.data.kind === 'worker')!.id;
    assert.equal((await put(graph)).status, 200);
    // The coordinator registers executions through the runtime API.
    const registered = await fetch(`${base}/api/workflows/guarded/executions`, { method: 'PUT', headers: json,
      body: JSON.stringify({ runId: 'run-a', executions: [{ id: 'run-a-1', label: '#1', bindings: { [stageId]: 'task-1' } }] }) });
    assert.equal(registered.status, 200);
    // A stale editor (or agent) saves the graph it read before: no executions, a renamed graph. Executions survive.
    const edited = await put({ ...graph, name: '바뀐 이름', executions: [] });
    assert.equal(edited.status, 200);
    const stored = await (await fetch(`${base}/api/workflows/guarded`)).json() as Workflow;
    assert.equal(stored.name, '바뀐 이름');
    assert.deepEqual(stored.executions?.map((item) => item.id), ['run-a-1']);
    // Executions in the body never replace the stored ones either.
    await put({ ...stored, executions: [{ id: 'forged', label: 'x', bindings: {} }] });
    assert.deepEqual(((await (await fetch(`${base}/api/workflows/guarded`)).json()) as Workflow).executions?.map((item) => item.id), ['run-a-1']);
    // Picking another Run keeps the earlier executions on their own Run.
    await put({ ...stored, runId: 'run-b' });
    const moved = await (await fetch(`${base}/api/workflows/guarded`)).json() as Workflow;
    assert.equal(moved.runId, 'run-b');
    assert.equal(moved.executions?.[0].runId, 'run-a');

    // If-Match: the ETag of GET is the document version; runtime writes do not change it.
    const read = await fetch(`${base}/api/workflows/guarded`);
    const version = read.headers.get('etag')!;
    assert.match(version, /^"[0-9a-f]{24}"$/);
    await fetch(`${base}/api/workflows/guarded/executions`, { method: 'PUT', headers: json,
      body: JSON.stringify({ runId: 'run-c', executions: [{ id: 'run-c-1', label: '#2', bindings: {} }] }) });
    assert.equal((await fetch(`${base}/api/workflows/guarded`)).headers.get('etag'), version);
    const first = await put({ ...moved, description: '첫 수정' }, { 'If-Match': version });
    assert.equal(first.status, 200);
    const next = first.headers.get('etag');
    assert.notEqual(next, version);
    // A second writer that read the old version is refused with the current one.
    const stale = await put({ ...moved, description: '두 번째 수정' }, { 'If-Match': version });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).version, next);
    assert.equal(((await (await fetch(`${base}/api/workflows/guarded`)).json()) as Workflow).description, '첫 수정');
    assert.equal((await put({ ...moved, description: '세 번째' }, { 'If-Match': `W/${next}` })).status, 200);
    assert.equal((await put({ ...moved, description: '네 번째' }, { 'If-Match': '*' })).status, 200);
    // Without If-Match a save is accepted as before.
    assert.equal((await put({ ...moved, description: '헤더 없음' })).status, 200);
    // If-Match on a document that does not exist yet is a conflict.
    assert.equal((await put({ ...newWorkflow(), id: 'fresh' }, { 'If-Match': version })).status, 409);

    // Runtime writes and graph saves share one queue: concurrent ones never lose a registration.
    const saves = Array.from({ length: 5 }, (_, index) => put({ ...moved, description: `동시 ${index}` }));
    const registration = fetch(`${base}/api/workflows/guarded/executions`, { method: 'PUT', headers: json,
      body: JSON.stringify({ runId: 'run-d', executions: [{ id: 'run-d-1', label: '#3', bindings: {} }] }) });
    await Promise.all([...saves, registration]);
    const final = await (await fetch(`${base}/api/workflows/guarded`)).json() as Workflow;
    assert.ok(final.executions?.some((item) => item.id === 'run-d-1'));
    assert.ok(final.executions?.some((item) => item.id === 'run-a-1'));
  } finally { await close(); }
});

/** Orca answers for the run dialog's project check. */
function places(args: string[]) {
  if (args[0] === 'repo') return { repos: [{ id: 'repo-a', path: '/example/repo', displayName: 'repo' }] };
  if (args[0] === 'worktree') return { worktrees: [] };
  return undefined;
}

test('(b) outcome is stalled when the coordinator terminal is gone without a finished event', async () => {
  const { outcomeOf, createRunLog, launchDirName } = await import('./runlog.ts');
  const meta = { workflowId: 'w', workflowName: 'w', startedAt: new Date().toISOString(), runId: 'run-1' };
  const at = new Date().toISOString();
  assert.equal(outcomeOf(meta, [{ at, type: 'task', message: 't', taskId: 'a', status: 'running' }, { at, type: 'coordinator-lost', message: 'x' }]), 'stalled');
  // A finished run stays finished even if its coordinator closed later.
  assert.equal(outcomeOf(meta, [{ at, type: 'finished', status: 'completed', message: 'ok' }, { at, type: 'coordinator-lost', message: 'x' }]), 'completed');
  assert.equal(outcomeOf(meta, [{ at, type: 'coordinator-lost', message: 'x' }, { at, type: 'finished', status: 'failed', message: 'no' }]), 'failed');

  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(join(resolve('.local'), 'runlog-stalled-'));
  try {
    const log = createRunLog(root);
    const id = launchDirName(new Date(), 'w');
    await mkdir(join(root, id));
    await log.start(id, { ...meta, coordinatorTerminal: 'term_dead' });
    assert.deepEqual((await log.coordinatorsToWatch()).map((item) => item.id), [id]);
    assert.equal(await log.markLost(id, 'term_dead'), true);
    assert.equal(await log.markLost(id, 'term_dead'), false);
    assert.deepEqual(await log.coordinatorsToWatch(), []);
    assert.equal((await log.list('w'))[0].outcome, 'stalled');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('(b) the server marks a launch stalled only when Orca says the coordinator terminal is gone', async () => {
  let terminal: 'open' | 'gone' | 'unreachable' = 'unreachable';
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(join(resolve('.local'), 'api-stalled-'));
  const bridge = createOrcaBridge(async (args) => {
    if (args[0] === 'terminal' && args[1] === 'show') {
      if (terminal === 'gone') throw Object.assign(new Error('stale'), { orcaCode: 'terminal_handle_stale' });
      if (terminal === 'unreachable') throw new Error('Orca 응답 없음');
      return { terminal: { handle: args[3] } };
    }
    return places(args) ?? { terminal: { handle: 'term_coord' } };
  });
  const app = createApp(directory, bridge, { watchMs: 60_000, reapMs: 40 });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
  try {
    const graph = { ...newWorkflow(), id: 'dying' };
    await fetch(`${url}/api/workflows/dying`, { method: 'PUT', headers: json, body: JSON.stringify(graph) });
    assert.equal((await fetch(`${url}/api/workflows/dying/execute`, { method: 'POST', headers: json, body: JSON.stringify({ count: 1, project: '/example/repo' }) })).status, 200);
    const outcome = async () => ((await (await fetch(`${url}/api/workflows/dying/logs`)).json()) as { outcome: string }[])[0].outcome;
    await wait(200);
    assert.equal(await outcome(), 'pending', 'Orca not answering is not a dead coordinator');
    terminal = 'open';
    await wait(200);
    assert.equal(await outcome(), 'pending');
    terminal = 'gone';
    await wait(200);
    assert.equal(await outcome(), 'stalled');
    const events = ((await (await fetch(`${url}/api/workflows/dying/logs`)).json()) as { id: string }[])[0];
    const detail = await (await fetch(`${url}/api/workflows/dying/logs/${events.id}`)).json() as { events: { type: string }[] };
    assert.equal(detail.events.filter((event) => event.type === 'coordinator-lost').length, 1);
  } finally {
    (app.locals.stopWatch as (() => void) | undefined)?.();
    await new Promise<void>((done, fail) => { server.close((error) => error ? fail(error) : done()); server.closeAllConnections(); });
    // A reap already in flight may still append once; retry the removal instead of racing it.
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('(b) a coordinator the server did not start names its terminal when it registers', async () => {
  const { base, close } = await serve('api-coord-terminal', (args) => places(args)
    ?? (args[0] === 'automations' && args[1] === 'create' ? { automation: { id: 'orca-auto-1' } } : { terminal: { handle: 'term_coord' } }));
  try {
    const graph = { ...newWorkflow(), id: 'named' };
    await fetch(`${base}/api/workflows/named`, { method: 'PUT', headers: json, body: JSON.stringify(graph) });
    // An automation brief: no coordinator is started by the server, so the launch knows no terminal yet.
    const created = await fetch(`${base}/api/workflows/named/automations`, { method: 'POST', headers: json,
      body: JSON.stringify({ name: '매일', trigger: 'daily', time: '09:00', count: 1, project: '/example/repo', cleanup: { coordinator: false, worktrees: false, sessions: true } }) });
    assert.equal(created.status, 200, await created.clone().text());
    const config = ((await created.json()) as Workflow).automations![0];
    const { briefPath } = await (await fetch(`${base}/api/workflows/named/automations/${config.id}/brief`, { method: 'POST' })).json() as { briefPath: string };
    const launch = briefPath.split('/').at(-2)!;
    const { readFile } = await import('node:fs/promises');
    assert.match(await readFile(briefPath, 'utf8'), /"coordinatorTerminal":"<네 터미널 핸들>"/);
    await fetch(`${base}/api/workflows/named/executions`, { method: 'PUT', headers: json,
      body: JSON.stringify({ runId: 'run-n', launch, coordinatorTerminal: 'term_auto', executions: [{ id: 'run-n-1', label: '#1', bindings: {} }] }) });
    const detail = await (await fetch(`${base}/api/workflows/named/logs/${launch}`)).json() as { meta: { coordinatorTerminal?: string } };
    assert.equal(detail.meta.coordinatorTerminal, 'term_auto');
  } finally { await close(); }
});

/** A worker → user-judged branch → worker graph, with a fanout review stage. */
function decisionGraph(): Workflow {
  const stage = (id: string, x: number, data: Record<string, unknown>) => ({ id, type: 'stage' as const, position: { x, y: 0 }, data: { label: id, description: '', ...data } });
  return { ...newWorkflow(), id: 'wf-tracks', nodes: [
    stage('plan', 0, { kind: 'worker', label: '계획' }),
    stage('tracks', 200, { kind: 'branch', label: '트랙 수', judge: 'user', mode: 'exclusive', outputs: [{ id: 'one', label: '1개' }, { id: 'two', label: '2개' }] }),
    stage('build', 400, { kind: 'worker', label: '구현' }),
    stage('review', 600, { kind: 'worker', label: '리뷰', fanout: { models: ['claude-opus-5-5', 'gpt-5-codex'] } }),
    stage('judge', 800, { kind: 'worker', label: '판정' }),
  ] as Workflow['nodes'], edges: [
    { id: 'e1', source: 'plan', target: 'tracks' }, { id: 'e2', source: 'tracks', sourceHandle: 'one', target: 'build' },
    { id: 'e3', source: 'build', target: 'review' }, { id: 'e4', source: 'review', target: 'judge' },
  ] } as Workflow;
}

test('(a)(d)(e) brief: user decisions reach worker specs, fanout all-fail goes on, coordinator closes reported terminals', async () => {
  const { buildBrief } = await import('./execute.ts');
  const brief = buildBrief({ graph: decisionGraph(), count: 1, apiBase: 'http://127.0.0.1:1', workspace: '/w', artifactDir: '/tmp/x' });
  // (a) every worker spec carries the section; the coordinator writes its content from the decisions API right before dispatch.
  assert.match(brief, /## 앞 사용자 분기 판정\n {2}`\/tmp\/x\/<n>-<nodeId>-user-decisions\.md` 가 있으면 그 내용이 이 절이다/);
  assert.match(brief, /워커\(판정 전용 워커·`fanout` 자식 포함\)를 띄우기 \*\*직전마다\*\*/);
  assert.match(brief, /`userSection` 이 비어 있지 않으면 그 문자열을 그대로 `\/tmp\/x\/<n>-<nodeId>-user-decisions\.md` 에 쓴다/);
  // (d) all model workers failing does not fail the stage or the run.
  assert.match(brief, /\*\*모든 자식이 실패해도\(`모델별 0\/<m>`\) 단계와 실행을 실패로 만들지 않는다\*\*/);
  assert.match(brief, /실패 <name>\(<사유>\)/);
  assert.doesNotMatch(brief, /모두 실패면 `failed` 로 닫고/);
  // (e) the coordinator closes what a stage worker reports, right after that stage; workers still never close their location's terminals.
  assert.match(brief, /\*\*코디네이터 정리 요청\*\*: worker_done 본문에 `코디네이터 정리 필요: <터미널 핸들>/);
  assert.match(brief, /그 단계 Task 를 닫은 \*\*직후\*\*\(다음 단계를 띄우기 전에\) 적힌 터미널을 `orca terminal close --terminal <핸들>` 로 닫고/);
  assert.match(brief, /워커는 자기 `location` 워크트리를 지우거나 그 안의 터미널을 닫지 않는다/);
  // (c) rounds per stage.
  assert.match(brief, /`loop\.rounds\[<nodeId>\]`\(단계 기준 누적\)/);
  assert.match(brief, /k 를 \*\*숫자로\*\* 비교/);
  // No user-judged branch: no section.
  const plain = { ...decisionGraph(), nodes: decisionGraph().nodes.map((node) => node.id === 'tracks' ? { ...node, data: { ...node.data, judge: 'previous' as const } } : node) };
  assert.doesNotMatch(buildBrief({ graph: plain, count: 1, apiBase: 'http://127.0.0.1:1', workspace: '/w', artifactDir: '/tmp/x' }), /앞 사용자 분기 판정/);
});

test('(a) the decisions API gives the user-judged branch decisions and the spec section, loop passes included', async () => {
  const { base, close } = await serve('api-user-decisions');
  try {
    const graph = decisionGraph();
    assert.equal((await fetch(`${base}/api/workflows/wf-tracks`, { method: 'PUT', headers: json, body: JSON.stringify(graph) })).status, 200);
    await fetch(`${base}/api/workflows/wf-tracks/executions`, { method: 'PUT', headers: json,
      body: JSON.stringify({ runId: 'run-t', executions: [{ id: 'run-t-1', label: '#1', bindings: { plan: 't1', tracks: 't2', build: 't3', review: 't4', judge: 't5' } }] }) });
    const read = async () => (await fetch(`${base}/api/workflows/wf-tracks/executions/run-t-1/decisions`)).json() as Promise<{ userDecisions: unknown[]; userSection: string }>;
    assert.deepEqual(await read().then((body) => [body.userDecisions, body.userSection]), [[], '']);
    assert.equal((await fetch(`${base}/api/workflows/wf-tracks/executions/run-t-1/decisions`, { method: 'POST', headers: json, body: JSON.stringify({ node: 'tracks', outputs: ['one'], by: 'user' }) })).status, 200);
    const after = await read();
    assert.deepEqual(after.userDecisions, [{ node: 'tracks', label: '트랙 수', outputs: ['one'] }]);
    assert.equal(after.userSection, '## 앞 사용자 분기 판정\n- tracks (트랙 수): one\n');
  } finally { await close(); }
  const { userDecisions } = await import('../src/model.ts');
  // A decision archived by a loop pass still counts; the current one wins; gates are not branch decisions.
  const flow = [{ id: 'b', after: [], label: 'B', judge: 'user' as const, branch: { mode: 'exclusive' as const, outputs: ['x', 'y'] } },
    { id: 'g', after: [], label: 'G', judge: 'user' as const, veto: ['reject'], branch: { mode: 'exclusive' as const, outputs: ['approve', 'reject'] } },
    { id: 'w', after: [], label: 'W', judge: 'previous' as const, branch: { mode: 'exclusive' as const, outputs: ['p', 'q'] } }];
  assert.deepEqual(userDecisions(flow, { decisions: { g: ['approve'], w: ['p'] }, history: [{ edge: 'e', pass: 1, nodes: ['b'], bindings: {}, decisions: { b: ['x'] } }] }),
    [{ node: 'b', label: 'B', outputs: ['x'] }]);
  assert.deepEqual(userDecisions(flow, { decisions: { b: ['y'] }, history: [{ edge: 'e', pass: 1, nodes: ['b'], bindings: {}, decisions: { b: ['x'] } }] })[0].outputs, ['y']);
});

test('runtime contract: one list for the generation prompts and README; README loop limit matches the code', async () => {
  const { runtimeContract, runtimeContractMarkdown } = await import('./contract.ts');
  const { workflowPrompt, briefPrompt } = await import('./generate.ts');
  const { maxLoopRounds } = await import('../src/model.ts');
  const { readFile } = await import('node:fs/promises');
  // Every rule the task names is in the list.
  assert.deepEqual(runtimeContract.map((item) => item.key), ['empty-setting', 'setting-reach', 'decision', 'loop-exhausted', 'rounds', 'stalled',
    'user-decisions', 'fanout-failed', 'coordinator-cleanup', 'location-terminals', 'document-put']);
  const list = runtimeContractMarkdown();
  assert.match(list, /빈 문자열/);
  assert.match(list, /worker_done \*\*첫 줄\*\* `decision:/);
  assert.match(list, /## 앞 사용자 분기 판정/);
  assert.match(list, new RegExp(`1~${maxLoopRounds}`));
  // README carries the same text between its markers.
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.match(/<!-- runtime-contract:start -->\n([\s\S]*?)\n<!-- runtime-contract:end -->/);
  assert.ok(section, 'README 에 런타임 계약 절이 있어야 한다');
  assert.equal(section[1], list, 'README 의 런타임 계약 절을 server/contract.ts 와 맞추세요');
  assert.match(readme, new RegExp(`최대 반복 횟수\\(1~${maxLoopRounds}\\)`));
  assert.doesNotMatch(readme, /1~10\)/);
  // Both generation prompts embed it.
  const workflow = workflowPrompt({ request: 'r', resultUrl: 'http://x', resultFile: '/tmp/r.json', saved: [] });
  assert.ok(workflow.includes(`## 런타임 계약`) && workflow.includes(list));
  const graph = { ...newWorkflow(), id: 'g' };
  const brief = briefPrompt({ request: 'r', resultUrl: 'http://x', resultFile: '/tmp/r.json', graph, nodeId: graph.nodes.find((node) => node.data.kind === 'worker')!.id });
  assert.ok(brief.includes(list));
});

test('check warns about settings no instruction uses, 「중괄호 그대로」, and picking the latest round by name', async () => {
  const { preflight } = await import('./execute.ts');
  const stage = (id: string, description: string, extra: Record<string, unknown> = {}) => ({ id, type: 'stage' as const, position: { x: 0, y: 0 },
    data: { label: id, description, kind: 'worker' as const, ...extra } });
  const graph = { ...newWorkflow(), id: 'warned', variables: [{ key: 'top_name', label: '상위 이름' }, { key: 'unused', label: '안 씀' }, { key: 'models', label: '모델' }],
    nodes: [
      stage('status', '`{{top_name}}` 이 중괄호 그대로면 단독 실행이다.'),
      stage('prepare', '산출물 `1-review-r*.txt` 중 가장 최근 회차를 읽는다.'),
      stage('fixed', '`1-review-r<k>.txt` 중 k 를 숫자로 비교해 가장 최근 회차를 읽는다.'),
      stage('review', '<리뷰어> 로 리뷰한다', { fanout: { models: [], variable: 'models' } }),
    ], edges: [{ id: 'a', source: 'status', target: 'prepare' }, { id: 'b', source: 'prepare', target: 'fixed' }, { id: 'c', source: 'fixed', target: 'review' }] } as Workflow;
  const report = await preflight(graph, async () => { throw new Error('no links'); });
  const has = (text: string) => report.warnings.some((item) => item.includes(text));
  assert.ok(has("'안 씀'(unused)"), report.warnings.join('\n'));
  assert.ok(!has('(top_name)') && !has('(models)'), 'used in an instruction or as the fanout setting');
  assert.ok(has("'status' 지침이 「중괄호 그대로」"));
  assert.ok(has("'prepare' 지침이 「가장 최근 회차」"));
  assert.ok(!has("'fixed' 지침이 「가장 최근 회차」"));
});
