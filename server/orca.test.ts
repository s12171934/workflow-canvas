import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandForEnvironment, createLimiter, createOrcaBridge, normalizeTask } from './orca.ts';

test('normalizes real CLI dependency strings and task titles', () => {
  assert.deepEqual(normalizeTask({ id: 'task-a', display_name: 'A', status: 'completed', deps: '["task-b"]' }).deps, ['task-b']);
  assert.deepEqual(normalizeTask({ id: 'task-a', deps: 'broken' }).deps, []);
  assert.equal(commandForEnvironment({ ORCA_CLI_COMMAND: '/example/orca' }), '/example/orca');
  assert.equal(commandForEnvironment({ ORCA_DEV_REPO_ROOT: '/example/dev' }), 'orca-dev');
});
test('snapshot uses only explicit read commands and follows worker pages', async () => {
  const calls: string[][] = [];
  const bridge = createOrcaBridge(async (args) => {
    calls.push(args);
    if (args[1] === 'run-show') return { run: { id: 'run-a', objective: 'A' } };
    if (args[1] === 'task-list') return { tasks: [{ id: 'task-a', status: 'running', deps: [] }] };
    const second = args.includes('--cursor');
    return { workers: [{ dispatchId: second ? 'dispatch-b' : 'dispatch-a', taskId: 'task-a', projection: { liveness: { verdict: 'live' } } }],
      page: { hasMore: !second, nextCursor: second ? null : 'next-page' } };
  });
  const snapshot = await bridge.snapshot('run-a');
  assert.equal(snapshot.workers.length, 2);
  assert.ok(calls.every((args) => ['run-show', 'task-list', 'worker-list'].includes(args[1])));
  assert.ok(calls.every((args) => args.includes('run-a')));
  // Orca's concise view drops run, projection and page; these reads need the full record.
  assert.ok(calls.every((args) => args.includes('--full')));
  await assert.rejects(bridge.snapshot('--other-flag;rm'), /Run ID/);
  assert.equal(calls.length, 4);
});
test('runs pagination does not silently omit later Runs', async () => {
  let page = 0;
  const bridge = createOrcaBridge(async () => ({ runs: [{ id: `run-${page}`, objective: 'A' }], nextCursor: page++ === 0 ? 1 : null }));
  assert.equal((await bridge.runs()).length, 2);
});
test('openTask switches only to the newest live attempt terminal, resolved server-side', async () => {
  const calls: string[][] = [];
  const workers = [
    { dispatchId: 'dispatch-new', taskId: 'task-a', agentTerminalHandle: 'term_new', terminalState: 'owned', projection: {} },
    { dispatchId: 'dispatch-old', taskId: 'task-a', agentTerminalHandle: 'term_old', terminalState: 'owned', projection: {} },
    { dispatchId: 'dispatch-done', taskId: 'task-b', agentTerminalHandle: 'term_done', terminalState: 'released', projection: {} },
  ];
  const bridge = createOrcaBridge(async (args) => {
    calls.push(args);
    if (args[1] === 'run-show') return { run: { id: 'run-a', objective: 'A' } };
    if (args[1] === 'task-list') return { tasks: [] };
    if (args[0] === 'terminal') return {};
    return { workers, page: { hasMore: false } };
  });
  assert.deepEqual(await bridge.openTask('run-a', 'task-a'), { opened: true });
  assert.deepEqual(calls.at(-1), ['terminal', 'switch', '--terminal', 'term_new']);
  assert.equal((await bridge.openTask('run-a', 'task-b')).opened, false);
  assert.equal((await bridge.openTask('run-a', 'task-none')).opened, false);
  await assert.rejects(bridge.openTask('run-a', '--flag;rm'), /Task ID/);
  assert.equal(calls.filter((args) => args[0] === 'terminal').length, 1);
});
test('limiter runs at most the limit at once and lets the rest through in order', async () => {
  const limited = createLimiter(2);
  let running = 0, peak = 0;
  const order: number[] = [];
  await Promise.all([0, 1, 2, 3, 4].map((index) => limited(async () => {
    running++; peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(index); running--;
    if (index === 1) throw new Error('one fails');
  }).catch(() => {})));
  assert.equal(peak, 2);
  assert.deepEqual([...order].sort(), [0, 1, 2, 3, 4]);
  assert.equal(running, 0);
});
test('reads are joined while in flight, reused for a short time, and stand in for a failure while recent', async () => {
  let calls = 0;
  let fail = false;
  const bridge = createOrcaBridge(async (args) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (fail) throw new Error('timeout');
    if (args[0] === 'status') return { runtime: { reachable: true, state: 'ready' } };
    if (args[0] === 'automations') return { automations: [{ id: `auto-${calls}`, enabled: true }] };
    return { repos: [{ id: 'repo', path: '/example/repo' }], worktrees: [] };
  }, { locations: 50, automations: 10_000, status: 0, staleMs: 10_000 });
  const [first, second] = await Promise.all([bridge.locations(), bridge.locations()]);
  assert.equal(calls, 2); // repo list + worktree list, once for both callers
  assert.equal(first, second);
  await bridge.locations();
  assert.equal(calls, 2);
  await new Promise((resolve) => setTimeout(resolve, 60));
  fail = true;
  assert.deepEqual(await bridge.locations(), first); // CLI failed: the recent value stands in
  // status is the health signal: never answered from an older value.
  fail = false; await bridge.status(); fail = true;
  await assert.rejects(bridge.status(), /timeout/);
  // Writes drop the reused automations list.
  fail = false;
  const before = await bridge.automations();
  assert.equal((await bridge.automations())[0].orcaId, before[0].orcaId);
  await bridge.runAutomation('auto-1');
  assert.notEqual((await bridge.automations())[0].orcaId, before[0].orcaId);
});
test('injected commands get no reuse window by default, but calls in flight are still joined', async () => {
  let calls = 0;
  const bridge = createOrcaBridge(async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 5)); return { runtime: {} }; });
  await Promise.all([bridge.status(), bridge.status()]);
  assert.equal(calls, 1);
  await bridge.status();
  assert.equal(calls, 2);
});
test('a closed terminal reads as closed; an unreachable Orca is not an answer', async () => {
  const stale = createOrcaBridge(async () => { throw Object.assign(new Error('x'), { orcaCode: 'terminal_handle_stale' }); });
  assert.equal(await stale.terminalOpen('term_gone'), false);
  const open = createOrcaBridge(async () => ({ terminal: { handle: 'term_live' } }));
  assert.equal(await open.terminalOpen('term_live'), true);
  const down = createOrcaBridge(async () => { throw new Error('Orca CLI 조회에 실패했습니다.'); });
  await assert.rejects(down.terminalOpen('term_live'));
  assert.equal(await open.terminalOpen('not a handle'), false);
});
