import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { worktreeNamePattern } from '../../src/model.ts';
import type { AutomationState, Locations, RunSnapshot, RunSummary, TaskSummary, WorkerSummary } from '../../src/model.ts';

const exec = promisify(execFile);
type Row = Record<string, any>;
/** `timeoutMs`: for slow commands (creating a worktree runs its setup); the default suits queries. */
export type Command = (args: string[], options?: { timeoutMs?: number }) => Promise<Row>;

export function commandForEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND;
  if (env.ORCA_DEV_REPO_ROOT) return 'orca-dev';
  return process.platform === 'linux' && !env.ORCA_TERMINAL_HANDLE && !env.ORCA_WORKSPACE_ID ? 'orca-ide' : 'orca';
}

/** Each CLI call starts a whole Orca (Electron) process: under load, unbounded parallel calls starve each other past the timeout. */
export const maxConcurrentCalls = 4;
export const callTimeoutMs = 12_000;

/** Runs at most `limit` tasks at a time, first come first served. The wait in line does not count toward a call's timeout. */
export function createLimiter(limit: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async function limited<T>(task: () => Promise<T>): Promise<T> {
    if (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try { return await task(); }
    finally { const next = waiting.shift(); if (next) next(); else running--; }
  };
}
const limited = createLimiter(maxConcurrentCalls);

/** Slow calls are logged (command words and timings only, never arguments that could carry paths or task text). */
const slowCallMs = 3000;
let queued = 0;
/** Orca's machine error code (e.g. terminal_handle_stale) from a failed JSON response, if it gave one. */
function errorCode(response: { error?: { code?: unknown } } | undefined): string | undefined {
  const code = response?.error?.code;
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : undefined;
}
export const orcaCommand: Command = (args, options) => {
  const asked = Date.now();
  const timeoutMs = options?.timeoutMs ?? callTimeoutMs;
  queued++;
  // A long call (creating a worktree runs its setup for minutes) would hold a slot meant for quick reads: it skips the line.
  const run = async () => {
  const started = Date.now();
  const waiting = --queued;
  let outcome = 'ok';
  try {
    const { stdout } = await exec(commandForEnvironment(), [...args, '--json'], {
      timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    const response = JSON.parse(stdout);
    if (response.ok !== true || !response.result) throw Object.assign(new Error(response.error?.message ?? 'Orca 응답을 확인할 수 없습니다.'), { orcaCode: errorCode(response) });
    return response.result;
  } catch (error) {
    // Never return raw stdout/stderr: these can contain local paths or task contents. Only Orca's error code is kept.
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string; stdout?: string; orcaCode?: string };
    if (failure.orcaCode !== undefined) { outcome = 'fail'; throw error; }
    let orcaCode: string | undefined;
    try { orcaCode = errorCode(JSON.parse(failure.stdout ?? '')); } catch { /* not JSON */ }
    if (failure.code === 'ENOENT') throw new Error('Orca CLI를 찾지 못했습니다. ORCA_CLI_COMMAND를 실행 파일 경로로 설정하세요.');
    outcome = failure.killed || failure.signal === 'SIGTERM' ? 'timeout' : 'fail';
    if (failure.killed || failure.signal === 'SIGTERM') throw new Error(`Orca CLI가 ${timeoutMs / 1000}초 안에 응답하지 않았습니다. 시스템 부하나 동시에 돌고 있는 에이전트 수를 확인하세요.`);
    throw Object.assign(new Error('Orca CLI 조회에 실패했습니다. Orca 앱 실행 상태와 CLI 버전을 확인하세요.'), orcaCode ? { orcaCode } : {});
  } finally {
    const done = Date.now();
    if (done - asked >= slowCallMs) console.log(`[orca] ${new Date(done).toISOString()} ${args.slice(0, 2).join(' ')} wait=${((started - asked) / 1000).toFixed(1)}s run=${((done - started) / 1000).toFixed(1)}s queue=${waiting} ${outcome}`);
  }
  };
  return options?.timeoutMs ? run() : limited(run);
};

/** How long a read is reused (`fresh`) and how long the last good value stands in for a failed read (`stale`). */
/** `run`: a Run's own row (objective), part of each snapshot; it does not change while the Run goes on, so it is reused long. */
export type CacheTimes = Partial<Record<'status' | 'locations' | 'runs' | 'automations' | 'snapshot' | 'run', number>> & { staleMs?: number };
export const defaultCacheTimes: CacheTimes = { status: 4000, locations: 10_000, runs: 30_000, automations: 10_000, snapshot: 2000, run: 10 * 60_000, staleMs: 60_000 };

/**
 * Reads shared by the canvas polls, several tabs and the background watcher: one CLI call per key at a time (callers
 * join the call in flight), reused for a short time, and on failure answered with the last good value while it is recent.
 */
function createReadCache(times: CacheTimes) {
  const entries = new Map<string, { value?: unknown; at?: number; pending?: Promise<unknown> }>();
  return {
    /** `fresh`: how long a value is reused for this caller, when it tolerates an older one than `times[kind]`. */
    read<T>(kind: Exclude<keyof CacheTimes, 'staleMs'>, key: string, load: () => Promise<T>, { stale = true, fresh }: { stale?: boolean; fresh?: number } = {}): Promise<T> {
      const id = `${kind}:${key}`;
      const entry = entries.get(id) ?? {};
      entries.set(id, entry);
      if (entry.at !== undefined && Date.now() - entry.at < Math.max(fresh ?? 0, times[kind] ?? 0)) return Promise.resolve(entry.value as T);
      if (entry.pending) return entry.pending as Promise<T>;
      const pending = load().then((value) => { entry.value = value; entry.at = Date.now(); return value; }, (error) => {
        if (stale && entry.at !== undefined && Date.now() - entry.at < (times.staleMs ?? 0)) return entry.value as T;
        throw error;
      }).finally(() => { entry.pending = undefined; });
      entry.pending = pending;
      return pending;
    },
    forget(kind: Exclude<keyof CacheTimes, 'staleMs'>) {
      for (const id of entries.keys()) if (id.startsWith(`${kind}:`)) entries.delete(id);
    },
  };
}

function runSummary(row: Row): RunSummary {
  return { id: String(row.id), objective: String(row.objective ?? 'Untitled run'), updatedAt: String(row.updated_at ?? '') };
}
function parseDeps(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  try { return typeof value === 'string' ? parseDeps(JSON.parse(value)) : []; } catch { return []; }
}

export function normalizeTask(row: Row): TaskSummary {
  return { id: String(row.id), title: String(row.display_name || row.task_title || row.spec || row.id).slice(0, 160),
    spec: String(row.spec ?? ''), status: String(row.status ?? 'unknown'), deps: parseDeps(row.deps) };
}
function normalizeWorker(row: Row): WorkerSummary {
  return { dispatchId: String(row.dispatchId), taskId: String(row.taskId),
    provider: String(row.projection?.provider?.id ?? ''), model: String(row.projection?.provider?.model ?? ''),
    liveness: String(row.projection?.liveness?.verdict ?? 'unverifiable'),
    stage: String(row.projection?.stage?.activity ?? row.projection?.stage?.worker ?? ''),
    outcome: String(row.projection?.outcome ?? ''),
    terminal: typeof row.agentTerminalHandle === 'string' ? row.agentTerminalHandle : undefined,
    terminalState: typeof row.terminalState === 'string' ? row.terminalState : undefined };
}

/** Injected commands (tests) get no reuse window unless they ask for one; calls in flight are always joined. */
export function createOrcaBridge(command: Command = orcaCommand, cacheTimes: CacheTimes = command === orcaCommand ? defaultCacheTimes : {}) {
  const cache = createReadCache(cacheTimes);
  const bridge = {
    async status() {
      const result = await cache.read('status', '', () => command(['status']), { stale: false });
      return { connected: result.runtime?.reachable === true && result.runtime?.state === 'ready',
        version: String(result.runtime?.appVersion ?? ''), observedAt: new Date().toISOString() };
    },
    /** Projects (repos) open in Orca and their worktrees, for group nodes. Paths only; no git state. */
    locations(): Promise<Locations> { return cache.read('locations', '', () => bridge.loadLocations()); },
    async loadLocations(): Promise<Locations> {
      const [repos, worktrees] = await Promise.all([command(['repo', 'list']), command(['worktree', 'list', '--limit', '500'])]);
      const absolute = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && !/[\u0000-\u001f]/.test(value);
      return {
        projects: (repos.repos ?? []).filter((row: Row) => absolute(row.path)).map((row: Row) => ({
          id: String(row.id), name: String(row.displayName || row.path.split('/').pop()), path: row.path })),
        worktrees: (worktrees.worktrees ?? []).filter((row: Row) => absolute(row.path) && !row.isArchived && !row.isBare).map((row: Row) => ({
          id: String(row.id), name: String(row.displayName || row.path.split('/').pop()), path: row.path, repoId: String(row.repoId ?? ''),
          branch: typeof row.branch === 'string' ? row.branch.replace(/^refs\/heads\//, '') : undefined })),
      };
    },
    automations(): Promise<AutomationState[]> { return cache.read('automations', '', () => bridge.loadAutomations()); },
    async loadAutomations(): Promise<AutomationState[]> {
      const result = await command(['automations', 'list']);
      return (result.automations ?? []).map((row: Row) => ({ orcaId: String(row.id), name: String(row.name ?? ''), enabled: row.enabled === true,
        ...(typeof row.nextRunAt === 'number' ? { nextRunAt: row.nextRunAt } : {}), ...(typeof row.lastRunAt === 'number' ? { lastRunAt: row.lastRunAt } : {}),
        ...(typeof row.rrule === 'string' ? { rrule: row.rrule } : {}) }));
    },
    /** Creates an enabled, scheduled automation that runs a Claude agent in `project` with `prompt`. Returns the Orca id. */
    async createAutomation(input: { name: string; trigger: string; time?: string; day?: number; project: string; prompt: string }): Promise<string> {
      const result = await command(['automations', 'create', '--name', input.name, '--trigger', input.trigger,
        ...(input.time ? ['--time', input.time] : []), ...(input.day !== undefined ? ['--day', String(input.day)] : []),
        '--prompt', input.prompt, '--provider', 'claude', '--workspace', `path:${input.project}`, '--workspace-mode', 'existing', '--fresh-session', '--enabled']);
      const id = result.automation?.id ?? result.id;
      cache.forget('automations');
      if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error('Orca가 만든 자동화의 ID를 확인할 수 없습니다.');
      return id;
    },
    async runAutomation(orcaId: string) {
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(orcaId)) throw new Error('올바르지 않은 자동화 ID입니다.');
      await command(['automations', 'run', orcaId]);
      cache.forget('automations');
    },
    async removeAutomation(orcaId: string) {
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(orcaId)) throw new Error('올바르지 않은 자동화 ID입니다.');
      await command(['automations', 'remove', orcaId]);
      cache.forget('automations');
    },
    runs(): Promise<RunSummary[]> { return cache.read('runs', '', () => bridge.loadRuns()); },
    async loadRuns(): Promise<RunSummary[]> {
      const runs: RunSummary[] = [];
      let cursor: unknown;
      const visited = new Set<string>();
      do {
        const page = await command(['orchestration', 'run-list', '--full', '--limit', '100', ...(cursor == null ? [] : ['--cursor', String(cursor)])]);
        runs.push(...(page.runs ?? []).map(runSummary));
        cursor = page.nextCursor;
        if (cursor != null && visited.has(String(cursor))) throw new Error('Orca Run 페이지 커서가 반복되었습니다.');
        if (cursor != null) visited.add(String(cursor));
      } while (cursor != null);
      return runs;
    },
    /** `maxAgeMs`: a background reader that can use a snapshot this old (another reader's) instead of reading Orca again. */
    async snapshot(runId: string, maxAgeMs?: number): Promise<RunSnapshot> {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) throw new Error('올바르지 않은 Run ID입니다.');
      return cache.read('snapshot', runId, () => bridge.loadSnapshot(runId), { fresh: maxAgeMs });
    },
    async loadSnapshot(runId: string): Promise<RunSnapshot> {
      const [detail, tasks] = await Promise.all([
        cache.read('run', runId, () => command(['orchestration', 'run-show', '--full', '--id', runId])),
        command(['orchestration', 'task-list', '--full', '--run', runId]),
      ]);
      const workers: WorkerSummary[] = [];
      let cursor: unknown;
      const visited = new Set<string>();
      do {
        const page = await command(['orchestration', 'worker-list', '--full', '--run', runId, '--include-remote', '--limit', '100',
          ...(cursor == null ? [] : ['--cursor', String(cursor)])]);
        workers.push(...(page.workers ?? []).map(normalizeWorker));
        cursor = page.page?.hasMore ? page.page.nextCursor : null;
        if (cursor != null && visited.has(String(cursor))) throw new Error('Orca Worker 페이지 커서가 반복되었습니다.');
        if (cursor != null) visited.add(String(cursor));
      } while (cursor != null);
      return { run: runSummary(detail.run), tasks: (tasks.tasks ?? []).map(normalizeTask), workers, observedAt: new Date().toISOString() };
    },
    /**
     * Brings the latest attempt's terminal for a Task to the front in the Orca UI.
     * The handle is resolved server-side from the Run snapshot; clients never pass a handle.
     * This is a view action only: it does not send input or change any lifecycle state.
     */
    /**
     * The worktree a coordinator starts in: one of the repo's worktrees whose display name or branch is `name`, else a new one
     * (under `parent` when given, else with no parent). Reused worktrees are left as they are.
     */
    async prepareWorktree(input: { repo: string; name: string; parent?: string; baseBranch?: string }): Promise<{ path: string; created: boolean }> {
      if (!worktreeNamePattern.test(input.name)) throw new Error('올바르지 않은 워크트리 이름입니다.');
      const absolute = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && !/[\u0000-\u001f]/.test(value);
      if (!absolute(input.repo) || (input.parent !== undefined && !absolute(input.parent))) throw new Error('워크트리 경로가 올바르지 않습니다.');
      const listed = await command(['worktree', 'list', '--repo', `path:${input.repo}`, '--limit', '500']);
      const found = (listed.worktrees ?? []).find((row: Row) => absolute(row.path) && !row.isArchived && !row.isBare
        && (row.displayName === input.name || (typeof row.branch === 'string' && row.branch.replace(/^refs\/heads\//, '') === input.name)));
      if (found) return { path: found.path, created: false };
      const result = await command(['worktree', 'create', '--repo', `path:${input.repo}`, '--name', input.name,
        ...(input.baseBranch ? ['--base-branch', input.baseBranch] : []),
        ...(input.parent ? ['--parent-worktree', `path:${input.parent}`] : ['--no-parent']), '--setup', 'inherit'], { timeoutMs: 600_000 });
      const path = result.worktree?.path ?? result.path;
      if (!absolute(path)) throw new Error('Orca가 만든 워크트리의 경로를 확인할 수 없습니다.');
      return { path, created: true };
    },
    /** Starts the coordinator agent in a terminal (orchestration needs a terminal-bound coordinator). */
    async launchCoordinator(workspaceRoot: string, prompt: string): Promise<{ terminal?: string }> {
      const result = await command(['agent', 'launch', '--agent', 'claude', '--model', 'claude-opus-5-5',
        '--surface', 'terminal', '--worktree', `path:${workspaceRoot}`, '--prompt', prompt]);
      const text = JSON.stringify(result);
      return { terminal: text.match(/term_[a-zA-Z0-9-]{1,128}/)?.[0] };
    },
    /** Starts a generation agent the way a new agent tab does (chat or terminal, per the user's setting). */
    async launchGenerator(workspaceRoot: string, prompt: string): Promise<{ terminal?: string }> {
      const result = await command(['agent', 'launch', '--agent', 'claude', '--model', 'claude-opus-5-5',
        '--worktree', `path:${workspaceRoot}`, '--prompt', prompt]);
      return { terminal: JSON.stringify(result).match(/term_[a-zA-Z0-9-]{1,128}/)?.[0] };
    },
    /** Whether a terminal is still open in Orca. */
    async terminalOpen(terminal: string): Promise<boolean> {
      if (!/^term_[a-zA-Z0-9-]{1,128}$/.test(terminal)) return false;
      try {
        const result = await command(['terminal', 'show', '--terminal', terminal]);
        return result?.terminal?.handle === terminal;
      } catch (error) {
        // A closed terminal's handle is stale; anything else (Orca unreachable) is not an answer.
        const code = (error as { orcaCode?: string }).orcaCode;
        if (code && /stale|not_found/.test(code)) return false;
        throw error;
      }
    },
    async closeTerminal(terminal: string) {
      if (!/^term_[a-zA-Z0-9-]{1,128}$/.test(terminal)) return;
      await command(['terminal', 'close', '--terminal', terminal]);
    },
    async renameTerminal(terminal: string, title: string) {
      if (!/^term_[a-zA-Z0-9-]{1,128}$/.test(terminal)) return;
      await command(['terminal', 'rename', '--terminal', terminal, '--title', title.slice(0, 80)]);
    },
    async openTask(runId: string, taskId: string): Promise<{ opened: boolean; reason?: string }> {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) throw new Error('올바르지 않은 Task ID입니다.');
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) throw new Error('올바르지 않은 Run ID입니다.');
      // Read fresh, never a reused or stand-in snapshot: an older one could point at a released attempt.
      const snapshot = await bridge.loadSnapshot(runId);
      // worker-list returns newest attempts first; never open an older attempt's terminal.
      const latest = snapshot.workers.find((worker) => worker.taskId === taskId);
      if (!latest) return { opened: false, reason: '이 Task에는 아직 워커가 없습니다.' };
      if (!latest.terminal || !/^term_[a-zA-Z0-9-]{1,128}$/.test(latest.terminal)) return { opened: false, reason: '워커 터미널을 확인할 수 없습니다.' };
      if (latest.terminalState === 'released') return { opened: false, reason: '이미 정리된 워커입니다.' };
      await command(['terminal', 'switch', '--terminal', latest.terminal]);
      return { opened: true };
    },
  };
  return bridge;
}
