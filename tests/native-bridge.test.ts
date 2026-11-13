import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
async function serve(responses: Record<string, unknown>) {
  await mkdir('.local', { recursive: true });
  const dir = await mkdtemp(resolve('.local/native-cli-'));
  const fixture = join(dir, 'fixture.json'), log = join(dir, 'calls.jsonl');
  await writeFile(fixture, JSON.stringify(responses));
  const child = spawn(resolve('.local/target/debug/workflow-canvas'), ['--port', '0', '--data-dir', join(dir, 'data'), '--watch-ms', '0'], {
    env: { ...process.env, WORKFLOW_CANVAS_TESTING: '1', ORCA_CLI_COMMAND: resolve('tests/fixtures/orca-cli.mjs'), WORKFLOW_CANVAS_CLI_FIXTURE: fixture, WORKFLOW_CANVAS_CLI_LOG: log },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = await new Promise<string>((done, fail) => {
    let output = ''; child.stdout.on('data', chunk => { output += chunk; const found = output.match(/Workflow Canvas: (http:\/\/127\.0\.0\.1:\d+)/); if (found) done(found[1]); });
    child.once('error', fail); child.once('exit', code => fail(new Error(`server exited ${code}`)));
  });
  return { base, fixture,
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string; pid: number; args: string[] }),
    close: async () => { child.kill('SIGTERM'); await once(child, 'exit'); await rm(dir, { recursive: true, force: true }); },
  };
}
const responses = {
  'orchestration run-show': { result: { run: { id: 'run-a', objective: 'A', updated_at: '2026-11-01' } } },
  'orchestration task-list': { result: { tasks: [{ id: 'task-a', display_name: '한글 단계', status: 'running', deps: '["task-before"]' }] } },
  'orchestration worker-list': { result: { workers: [{ dispatchId: 'd-new', taskId: 'task-a', agentTerminalHandle: 'term_new', terminalState: 'owned', projection: { provider: { id: 'claude', model: 'example' }, liveness: { verdict: 'live' }, stage: { activity: 'working' } } }], page: { hasMore: true, nextCursor: 'page-2' } } },
  'orchestration worker-list.next': { result: { workers: [{ dispatchId: 'd-old', taskId: 'task-a', agentTerminalHandle: 'term_old', projection: {} }], page: { hasMore: false } } },
};
test('native CLI adapter normalizes real records, follows pages, and opens the newest terminal', async () => {
  const app = await serve(responses);
  try {
    const response = await fetch(`${app.base}/api/runs/run-a`); assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.run.updatedAt, '2026-11-01');
    assert.equal(snapshot.tasks[0].title, '한글 단계'); assert.deepEqual(snapshot.tasks[0].deps, ['task-before']);
    assert.equal(snapshot.workers[0].provider, 'claude'); assert.equal(snapshot.workers[0].liveness, 'live'); assert.equal(snapshot.workers.length, 2);
    assert.equal((await fetch(`${app.base}/api/runs/run-a/tasks/task-a/open`, { method: 'POST' })).status, 200);
    const commands = (await app.calls()).filter(c => c.kind === 'start').map(c => c.args);
    assert.ok(commands.filter(a => a[0] === 'orchestration').every(a => a.includes('--full')));
    assert.deepEqual(commands.at(-1), ['terminal', 'switch', '--terminal', 'term_new']);
  } finally { await app.close(); }
});
test('native CLI adapter joins concurrent reads and limits process concurrency to four', async () => {
  const delayed = Object.fromEntries(Object.entries(responses).map(([key, value]) => [key, { ...value, delay: 50 }]));
  const app = await serve(delayed);
  try {
    const answers = await Promise.all(Array.from({ length: 3 }, () => fetch(`${app.base}/api/runs/run-a`)));
    assert.ok(answers.every(r => r.status === 200));
    assert.equal((await app.calls()).filter(c => c.kind === 'start').length, 4);
    await Promise.all(Array.from({ length: 6 }, (_, i) => fetch(`${app.base}/api/runs/run-${i}`)));
    let active = 0, peak = 0;
    for (const event of await app.calls()) { active += event.kind === 'start' ? 1 : -1; peak = Math.max(peak, active); }
    assert.ok(peak <= 4 && peak >= 2, `peak ${peak}`); assert.equal(active, 0);
  } finally { await app.close(); }
});
test('native CLI errors hide raw process output and repeated cursors fail rather than loop', async () => {
  const app = await serve({ status: { raw: true }, 'orchestration run-list': { result: { runs: [], nextCursor: 'same' } }, 'orchestration run-list.next': { result: { runs: [], nextCursor: 'same' } } });
  try {
    const response = await fetch(`${app.base}/api/status`); assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /private-fixture/);
    const runs = await fetch(`${app.base}/api/runs`); assert.equal(runs.status, 503); assert.match((await runs.json()).error, /커서가 반복/);
  } finally { await app.close(); }
});
