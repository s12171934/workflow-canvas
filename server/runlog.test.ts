import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRunLog, launchDirName, quietEveryMs } from './runlog.ts';
import type { RunEvent, RunSnapshot } from '../src/model.ts';

const hour = 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** A launch dated `startedAgo` with one execution on `runId`, its events as given, and a coordinator terminal. */
async function launch(root: string, workflowId: string, runId: string, startedAgo: number, events: Omit<RunEvent, 'message'>[]) {
  const id = launchDirName(new Date(Date.now() - startedAgo), workflowId);
  await mkdir(join(root, id), { recursive: true });
  await writeFile(join(root, id, 'meta.json'), JSON.stringify({ workflowId, workflowName: workflowId, startedAt: ago(startedAgo), runId,
    coordinatorTerminal: `term-${runId}`, executions: [{ id: 'exec-1', label: '#1', tasks: ['task-a'] }] }));
  await writeFile(join(root, id, 'events.jsonl'), events.map((event) => JSON.stringify({ message: '', ...event })).join('\n') + '\n');
  return id;
}
/** Waits until `ready()` holds (at most 5s), so busy machines do not fail timing-based checks. */
async function until(ready: () => boolean) {
  for (let i = 0; i < 250 && !ready(); i++) await new Promise((done) => setTimeout(done, 20));
}
const snapshotOf = (runId: string, status: string): RunSnapshot => ({ run: { id: runId, objective: '', updatedAt: '' },
  tasks: [{ id: 'task-a', title: '구현 #1', spec: '', status, deps: [] }], workers: [], observedAt: new Date().toISOString() });

test('background watch: ended launches (failed too) are not read, quiet ones rarely, moving ones every tick', async () => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(join(resolve('.local'), 'runlog-watch-test-'));
  try {
    // Finished as failed a day ago: before, only completed and stalled launches were left out after a restart.
    await launch(root, 'wf-failed', 'run-failed', 26 * hour, [{ at: ago(25 * hour), type: 'task', taskId: 'task-a', status: 'failed' },
      { at: ago(25 * hour), type: 'finished', status: 'failed' }]);
    await launch(root, 'wf-done', 'run-done', 26 * hour, [{ at: ago(25 * hour), type: 'finished', status: 'completed' }]);
    await launch(root, 'wf-lost', 'run-lost', 26 * hour, [{ at: ago(25 * hour), type: 'coordinator-lost' }]);
    // Waiting on a person for two hours: quiet.
    await launch(root, 'wf-quiet', 'run-quiet', 3 * hour, [{ at: ago(2 * hour), type: 'task', taskId: 'task-a', status: 'blocked' },
      { at: ago(2 * hour), type: 'execution', taskId: 'exec-1', status: 'blocked' }]);
    // A Task has been running for two hours without a change: a long Task, still read at the normal pace.
    await launch(root, 'wf-long', 'run-long', 3 * hour, [{ at: ago(2 * hour), type: 'task', taskId: 'task-a', status: 'running' }]);
    // Moved a minute ago.
    await launch(root, 'wf-busy', 'run-busy', hour, [{ at: ago(60_000), type: 'task', taskId: 'task-a', status: 'pending' }]);
    const reads = new Map<string, number>();
    const statuses: Record<string, string> = { 'run-quiet': 'blocked', 'run-long': 'running', 'run-busy': 'pending' };
    const log = createRunLog(root);
    const stop = log.watch(async (runId) => {
      reads.set(runId, (reads.get(runId) ?? 0) + 1);
      return snapshotOf(runId, statuses[runId] ?? 'completed');
    }, 10);
    await until(() => (reads.get('run-long') ?? 0) >= 3 && (reads.get('run-busy') ?? 0) >= 3);
    stop();
    assert.equal(reads.get('run-failed'), undefined);
    assert.equal(reads.get('run-done'), undefined);
    assert.equal(reads.get('run-lost'), undefined);
    assert.equal(reads.get('run-quiet'), 1);
    assert.ok((reads.get('run-long') ?? 0) >= 3, `long: ${reads.get('run-long')}`);
    assert.ok((reads.get('run-busy') ?? 0) >= 3, `busy: ${reads.get('run-busy')}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('background watch: a quiet launch whose Task moves is read at the normal pace again', async () => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(join(resolve('.local'), 'runlog-wake-test-'));
  try {
    await launch(root, 'wf-quiet', 'run-quiet', 3 * hour, [{ at: ago(2 * hour), type: 'task', taskId: 'task-a', status: 'blocked' }]);
    let reads = 0;
    const log = createRunLog(root);
    // The person answered: the next (rare) read sees the Task running, logs it, and the launch is no longer quiet.
    const stop = log.watch(async (runId) => { reads++; return snapshotOf(runId, 'running'); }, 10);
    await until(() => reads >= 3);
    stop();
    assert.ok(reads >= 3, `reads: ${reads}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('coordinator check: open launches only, quiet ones once per quietEveryMs', async () => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(join(resolve('.local'), 'runlog-coordinator-test-'));
  try {
    await launch(root, 'wf-failed', 'run-failed', 26 * hour, [{ at: ago(25 * hour), type: 'finished', status: 'failed' }]);
    const quiet = await launch(root, 'wf-quiet', 'run-quiet', 3 * hour, [{ at: ago(2 * hour), type: 'task', taskId: 'task-a', status: 'blocked' }]);
    const busy = await launch(root, 'wf-busy', 'run-busy', hour, [{ at: ago(60_000), type: 'task', taskId: 'task-a', status: 'pending' }]);
    const log = createRunLog(root);
    const ids = async (now: number) => (await log.coordinatorsToWatch(now)).map((item) => item.id).sort();
    const now = Date.now();
    assert.deepEqual(await ids(now), [busy, quiet].sort());
    assert.deepEqual(await ids(now + 30_000), [busy]);
    assert.deepEqual(await ids(now + quietEveryMs), [busy, quiet].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('run pace: ended, quiet or moving, and moving for a Run no launch owns', async () => {
  await mkdir('.local', { recursive: true });
  const root = await mkdtemp(join(resolve('.local'), 'runlog-pace-test-'));
  try {
    await launch(root, 'wf-failed', 'run-failed', 26 * hour, [{ at: ago(25 * hour), type: 'finished', status: 'failed' }]);
    await launch(root, 'wf-quiet', 'run-quiet', 3 * hour, [{ at: ago(2 * hour), type: 'task', taskId: 'task-a', status: 'blocked' }]);
    await launch(root, 'wf-long', 'run-long', 3 * hour, [{ at: ago(2 * hour), type: 'task', taskId: 'task-a', status: 'running' }]);
    const log = createRunLog(root);
    assert.equal(await log.runPace('run-failed'), 'ended');
    assert.equal(await log.runPace('run-quiet'), 'quiet');
    assert.equal(await log.runPace('run-long'), 'moving');
    assert.equal(await log.runPace('run-unknown'), 'moving');
  } finally { await rm(root, { recursive: true, force: true }); }
});
