import { appendFile, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executionResults, statusLabels, taskStatus, type LoggedExecution, type RunEvent, type RunLogMeta, type RunLogOutcome, type RunLogSummary, type RunSnapshot, type StageStatus } from '../src/model.ts';
import { validId } from './storage.ts';
export { coordinatorEventTypes } from '../src/model.ts';

const maxListed = 50;
const maxFileBytes = 1024 * 1024;
/** Runs older than this are no longer watched in the background (the canvas still observes them while open). */
const watchWindowMs = 7 * 24 * 60 * 60 * 1000;
const fileName = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,200}$/;
const hidden = new Set(['meta.json', 'events.jsonl']);
/** Index of the last event of a type, or -1. */
const lastOf = (events: RunEvent[], type: string) => events.map((event) => event.type).lastIndexOf(type);
const stampPattern = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/;

/** Launch directories are named `<ISO stamp with : and . replaced>-<workflow id>`. */
export function launchDirName(startedAt: Date, workflowId: string) {
  return `${startedAt.toISOString().replace(/[:.]/g, '-')}-${workflowId}`;
}
function stampOf(id: string): string | undefined {
  const match = stampPattern.exec(id);
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : undefined;
}

/** Overall state of a launch from its events: a final 'finished' wins, then open problems, then progress. */
export function outcomeOf(meta: RunLogMeta | undefined, events: RunEvent[]): RunLogOutcome {
  if (events.some((event) => event.type === 'coordinator-failed')) return 'failed';
  const lastFinished = lastOf(events, 'finished');
  const lastTask = lastOf(events, 'task');
  if (lastFinished >= 0 && lastFinished > lastTask) return (events[lastFinished].status as RunLogOutcome) ?? 'completed';
  if (!meta?.runId) return meta ? 'pending' : 'unknown';
  const latest = new Map<string, StageStatus>();
  for (const event of events) if (event.type === 'execution' && event.taskId && event.status) latest.set(event.taskId, event.status);
  const statuses = [...latest.values()];
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('blocked')) return 'blocked';
  return 'running';
}

/**
 * Execution logs: what the server did for each 실행 (request, brief, coordinator launch, registration),
 * what the coordinator reported, every Task status change, and each execution's result once it settles.
 */
export function createRunLog(root: string) {
  const dir = (id: string) => join(root, id);
  // runId → launch id; per-Run memory of what was logged last, so restarts and repeated polls never duplicate events.
  const runLaunch = new Map<string, string>();
  const memory = new Map<string, { tasks: Map<string, StageStatus>; executions: Map<string, string>; done: boolean }>();
  const observing = new Map<string, Promise<void>>();
  /** Launch ids whose Run is still open: the background watcher polls these. */
  const active = new Set<string>();
  let indexed: Promise<void> | undefined;

  const validLaunch = (workflowId: string, id: string) => validId(workflowId) && /^[a-zA-Z0-9_-]{1,200}$/.test(id) && id.endsWith(`-${workflowId}`) && !!stampOf(id);

  async function readMeta(id: string): Promise<RunLogMeta | undefined> {
    try { return JSON.parse(await readFile(join(dir(id), 'meta.json'), 'utf8')) as RunLogMeta; } catch { return undefined; }
  }
  async function writeMeta(id: string, meta: RunLogMeta) {
    await writeFile(join(dir(id), 'meta.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
  }
  async function readEvents(id: string): Promise<RunEvent[]> {
    let text = '';
    try { text = await readFile(join(dir(id), 'events.jsonl'), 'utf8'); } catch { return []; }
    return text.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as RunEvent]; } catch { return []; } });
  }
  async function launches(workflowId?: string): Promise<string[]> {
    let names: string[] = [];
    try { names = await readdir(root); } catch { return []; }
    return names.filter((name) => stampOf(name) && (!workflowId || name.endsWith(`-${workflowId}`))).sort().reverse();
  }
  const recent = (id: string) => Date.now() - Date.parse(stampOf(id)!) < watchWindowMs;
  function index() {
    indexed ??= (async () => {
      for (const id of await launches()) {
        const meta = await readMeta(id);
        if (!meta?.runId || runLaunch.has(meta.runId)) continue;
        runLaunch.set(meta.runId, id);
        if (recent(id) && outcomeOf(meta, await readEvents(id)) !== 'completed') active.add(id);
      }
    })();
    return indexed;
  }
  async function append(id: string, event: Omit<RunEvent, 'at'> & { at?: string }) {
    const line: RunEvent = { at: event.at ?? new Date().toISOString(), ...event };
    await appendFile(join(dir(id), 'events.jsonl'), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }
  /** What was logged last for a Run, rebuilt from its events the first time. */
  async function remembered(runId: string, id: string) {
    let state = memory.get(runId);
    if (state) return state;
    const events = await readEvents(id);
    state = { tasks: new Map(), executions: new Map(), done: false };
    for (const event of events) {
      if (event.type === 'task' && event.taskId && event.status) state.tasks.set(event.taskId, event.status);
      if (event.type === 'execution' && event.taskId && event.status) state.executions.set(event.taskId, event.status);
    }
    state.done = lastOf(events, 'finished') > lastOf(events, 'task');
    memory.set(runId, state);
    return state;
  }
  async function observeNow(snapshot: RunSnapshot) {
    await index();
    const id = runLaunch.get(snapshot.run.id);
    if (!id) return;
    const state = await remembered(snapshot.run.id, id);
    const at = snapshot.observedAt;
    for (const task of snapshot.tasks) {
      const status = taskStatus(task, snapshot.workers);
      const from = state.tasks.get(task.id);
      if (from === status) continue;
      state.tasks.set(task.id, status);
      await append(id, { at, type: 'task', taskId: task.id, message: task.title, status, ...(from ? { from } : {}) });
    }
    const meta = await readMeta(id);
    if (!meta?.executions?.length) return;
    // One event per execution when it settles (finished, failed, or waiting on a person), and one when every execution has settled.
    const results = executionResults(meta.executions, snapshot);
    for (const result of results) {
      const status: StageStatus = result.finished ? 'completed' : result.status;
      const notable = result.finished || status === 'failed' || status === 'blocked';
      const key = notable ? status : 'open';
      if ((state.executions.get(result.id) ?? 'open') === key) continue;
      state.executions.set(result.id, key);
      if (!notable) continue;
      const stages = result.stages.map((stage) => `${stage.title} ${stage.skipped ? '진행 안 함' : statusLabels[stage.status]}`).join(', ');
      await append(id, { at, type: 'execution', taskId: result.id, status, message: `${result.label} ${result.finished ? '완료' : statusLabels[status]} — ${stages}` });
    }
    const settled = results.every((result) => result.finished || result.status === 'failed');
    if (settled && !state.done) {
      const failed = results.filter((result) => !result.finished).length;
      await append(id, { at, type: 'finished', status: failed ? 'failed' : 'completed',
        message: failed ? `실행 ${results.length}개 중 ${failed}개 실패` : `실행 ${results.length}개 모두 완료` });
      active.delete(id);
    } else if (!settled && recent(id)) active.add(id);
    state.done = settled;
  }

  const log = {
    root,
    /** Starts a launch's log; the directory must already exist. */
    async start(id: string, meta: RunLogMeta) { await writeMeta(id, meta); },
    append,
    /** Appends an event to the launch that owns this Run, if any (decisions taken on the canvas). */
    async appendRun(runId: string, event: Omit<RunEvent, 'at'>) {
      await index();
      const id = runLaunch.get(runId);
      if (id) await append(id, event);
    },
    /**
     * Ties a Run to a launch with its executions: the launch the coordinator names (several requests of one workflow may be
     * running at once), else the launch that already owns this Run, else the newest launch of this workflow without a Run.
     */
    async register(workflowId: string, runId: string, executions: LoggedExecution[], launch?: string) {
      await index();
      const named = launch && validLaunch(workflowId, launch) ? [launch] : undefined;
      const owner = runLaunch.has(runId) ? [runLaunch.get(runId)!] : [];
      for (const id of named ?? [...owner, ...await launches(workflowId)]) {
        const meta = await readMeta(id);
        if (!meta || (meta.runId && meta.runId !== runId)) continue;
        await writeMeta(id, { ...meta, runId, executions });
        runLaunch.set(runId, id);
        active.add(id);
        // A later update of the same Run (branch decisions) refreshes the executions without a second 'registered' line.
        if (meta.runId !== runId) await append(id, { type: 'registered', message: `Run ${runId} 에 실행 ${executions.length}개 등록` });
        return id;
      }
      return undefined;
    },
    /**
     * Attaches the workflow's current Run to the newest launch from before execution logs existed (no meta.json),
     * so earlier executions show their results too. Does nothing once some launch owns the Run.
     */
    async adopt(workflowId: string, workflowName: string, runId: string, executions: LoggedExecution[]) {
      await index();
      if (!runId || runLaunch.has(runId) || !executions.length) return;
      for (const id of await launches(workflowId)) {
        if (await readMeta(id)) continue;
        await writeMeta(id, { workflowId, workflowName, startedAt: stampOf(id)!, runId, executions, adopted: true });
        runLaunch.set(runId, id);
        if (recent(id)) active.add(id);
        await append(id, { type: 'adopted', message: `실행 로그 도입 전 실행을 Run ${runId} 에 연결. 이후 시각은 관찰한 시각이다.` });
        return;
      }
    },
    /** Logs Task status changes and execution results seen in a snapshot. Serialized per Run so concurrent polls never log twice. */
    observe(snapshot: RunSnapshot): Promise<void> {
      const previous = observing.get(snapshot.run.id) ?? Promise.resolve();
      const next = previous.then(() => observeNow(snapshot), () => observeNow(snapshot));
      observing.set(snapshot.run.id, next);
      void next.finally(() => { if (observing.get(snapshot.run.id) === next) observing.delete(snapshot.run.id); }).catch(() => {});
      return next;
    },
    /** Polls open Runs in the background so results are logged even while no canvas is open. Returns a stop function. */
    watch(snapshot: (runId: string) => Promise<RunSnapshot>, intervalMs: number) {
      let stopped = false;
      let timer: ReturnType<typeof setTimeout>;
      async function tick() {
        await index().catch(() => {});
        for (const id of [...active]) {
          const runId = (await readMeta(id))?.runId;
          if (!runId || !recent(id)) { active.delete(id); continue; }
          try { await log.observe(await snapshot(runId)); } catch { /* Orca unreachable: try again next tick */ }
        }
        if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref?.(); }
      }
      timer = setTimeout(tick, 0); timer.unref?.();
      return () => { stopped = true; clearTimeout(timer); };
    },
    async meta(id: string) { return readMeta(id); },
    async patchMeta(id: string, patch: Partial<RunLogMeta>) {
      const meta = await readMeta(id);
      if (meta) await writeMeta(id, { ...meta, ...patch });
    },
    /**
     * Recent launches whose run has ended but whose coordinator, told to close itself, may still be open: due once its
     * closing report is a minute old, or `graceMs` after the run ended without one. Each is returned until it is marked.
     */
    async coordinatorsToClose(now: number, graceMs: number): Promise<{ id: string; terminal: string }[]> {
      const due: { id: string; terminal: string }[] = [];
      for (const id of await launches()) {
        if (!recent(id)) continue;
        const meta = await readMeta(id);
        // A coordinator with sub-coordinators among its workers closes itself once they settle: closing it would strand their worker_done.
        if (!meta?.closeCoordinator || !meta.coordinatorTerminal || meta.subcoordinators) continue;
        const events = await readEvents(id);
        const finished = lastOf(events, 'finished');
        if (finished < 0 || lastOf(events, 'coordinator-closed') >= 0 || lastOf(events, 'task') > finished) continue;
        const report = events.slice(finished).find((event) => event.type === 'report');
        const since = (event: RunEvent) => now - Date.parse(event.at);
        if (report ? since(report) >= 60_000 : since(events[finished]) >= graceMs) due.push({ id, terminal: meta.coordinatorTerminal });
      }
      return due;
    },
    /** meta.json of the launch that owns a Run, if any. */
    async metaOfRun(runId: string) {
      await index();
      const id = runId ? runLaunch.get(runId) : undefined;
      return id ? readMeta(id) : undefined;
    },
    /** Id of the launch that owns a Run, if any. */
    async launchOfRun(runId: string) {
      await index();
      return runId ? runLaunch.get(runId) : undefined;
    },
    async list(workflowId: string): Promise<RunLogSummary[]> {
      const ids = (await launches(workflowId)).slice(0, maxListed);
      return Promise.all(ids.map(async (id) => {
        const [meta, events, files] = await Promise.all([readMeta(id), readEvents(id), log.files(id)]);
        return { workflowId, workflowName: '', startedAt: stampOf(id)!, ...meta, id, events: events.length,
          ...(events.length ? { last: events[events.length - 1] } : {}), files, outcome: outcomeOf(meta, events) };
      }));
    },
    async detail(workflowId: string, id: string) {
      if (!validLaunch(workflowId, id)) throw Object.assign(new Error('올바르지 않은 실행 로그 ID입니다.'), { status: 400 });
      await stat(dir(id)); // ENOENT → 404
      const [meta, events, files] = await Promise.all([readMeta(id), readEvents(id), log.files(id)]);
      return { meta: { workflowId, workflowName: '', startedAt: stampOf(id)!, ...meta }, id, events, files, outcome: outcomeOf(meta, events) };
    },
    /** Readable files of a launch (brief, worker artifacts, report), without the log's own bookkeeping. */
    async files(id: string): Promise<string[]> {
      try {
        const entries = await readdir(dir(id), { withFileTypes: true });
        return entries.filter((entry) => entry.isFile() && fileName.test(entry.name) && !hidden.has(entry.name)).map((entry) => entry.name).sort();
      } catch { return []; }
    },
    async file(workflowId: string, id: string, name: string) {
      if (!validLaunch(workflowId, id) || !fileName.test(name) || hidden.has(name)) throw Object.assign(new Error('올바르지 않은 파일입니다.'), { status: 400 });
      const path = join(dir(id), name);
      const info = await stat(path);
      if (!info.isFile()) throw Object.assign(new Error('올바르지 않은 파일입니다.'), { status: 400 });
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(info.size, maxFileBytes));
        await handle.read(buffer, 0, buffer.length, 0);
        return { name, size: info.size, truncated: info.size > maxFileBytes, text: buffer.toString('utf8') };
      } finally { await handle.close(); }
    },
    validLaunch,
  };
  return log;
}
export type RunLog = ReturnType<typeof createRunLog>;
