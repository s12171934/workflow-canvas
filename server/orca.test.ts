import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandForEnvironment, createOrcaBridge, normalizeTask } from './orca.ts';

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
