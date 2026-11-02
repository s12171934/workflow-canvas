import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { worktreeNamePattern } from '../src/model.ts';
import type { AutomationState, Locations, RunSnapshot, RunSummary, TaskSummary, WorkerSummary } from '../src/model.ts';

const exec = promisify(execFile);
type Row = Record<string, any>;
/** `timeoutMs`: for slow commands (creating a worktree runs its setup); the default suits queries. */
export type Command = (args: string[], options?: { timeoutMs?: number }) => Promise<Row>;

export function commandForEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND;
  if (env.ORCA_DEV_REPO_ROOT) return 'orca-dev';
  return process.platform === 'linux' && !env.ORCA_TERMINAL_HANDLE && !env.ORCA_WORKSPACE_ID ? 'orca-ide' : 'orca';
}

export const orcaCommand: Command = async (args, options) => {
  try {
    const { stdout } = await exec(commandForEnvironment(), [...args, '--json'], {
      timeout: options?.timeoutMs ?? 12000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    });
    const response = JSON.parse(stdout);
    if (response.ok !== true || !response.result) throw new Error(response.error?.message ?? 'Orca 응답을 확인할 수 없습니다.');
    return response.result;
  } catch (error) {
    // Never return raw stdout/stderr: these can contain local paths or task contents.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error('Orca CLI를 찾지 못했습니다. ORCA_CLI_COMMAND를 실행 파일 경로로 설정하세요.');
    throw new Error('Orca CLI 조회에 실패했습니다. Orca 앱 실행 상태와 CLI 버전을 확인하세요.');
  }
};

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

export function createOrcaBridge(command: Command = orcaCommand) {
  const bridge = {
    async status() {
      const result = await command(['status']);
      return { connected: result.runtime?.reachable === true && result.runtime?.state === 'ready',
        version: String(result.runtime?.appVersion ?? ''), observedAt: new Date().toISOString() };
    },
    /** Projects (repos) open in Orca and their worktrees, for group nodes. Paths only; no git state. */
    async locations(): Promise<Locations> {
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
    async automations(): Promise<AutomationState[]> {
      const result = await command(['automations', 'list']);
      return (result.automations ?? []).map((row: Row) => ({ orcaId: String(row.id), name: String(row.name ?? ''), enabled: row.enabled === true,
        ...(typeof row.nextRunAt === 'number' ? { nextRunAt: row.nextRunAt } : {}), ...(typeof row.lastRunAt === 'number' ? { lastRunAt: row.lastRunAt } : {}),
        ...(typeof row.rrule === 'string' ? { rrule: row.rrule } : {}) }));
    },
    /** Creates an enabled, scheduled automation that runs a Claude agent in `project` with `prompt`. Returns the Orca id. */
    async createAutomation(input: { name: string; trigger: string; time?: string; day?: number; project: string; prompt: string }): Promise<string> {
      const result = await command(['automations', 'create', '--name', input.name, '--trigger', input.trigger,
        ...(input.time ? ['--time', input.time] : []), ...(input.day !== undefined ? ['--day', String(input.day)] : []),
        '--prompt', input.prompt, '--provider', 'claude', '--repo', `path:${input.project}`, '--workspace-mode', 'existing', '--fresh-session', '--enabled']);
      const id = result.automation?.id ?? result.id;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw new Error('Orca가 만든 자동화의 ID를 확인할 수 없습니다.');
      return id;
    },
    async runAutomation(orcaId: string) {
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(orcaId)) throw new Error('올바르지 않은 자동화 ID입니다.');
      await command(['automations', 'run', orcaId]);
    },
    async removeAutomation(orcaId: string) {
      if (!/^[a-zA-Z0-9-]{1,128}$/.test(orcaId)) throw new Error('올바르지 않은 자동화 ID입니다.');
      await command(['automations', 'remove', orcaId]);
    },
    async runs(): Promise<RunSummary[]> {
      const runs: RunSummary[] = [];
      let cursor: unknown;
      const visited = new Set<string>();
      do {
        const page = await command(['orchestration', 'run-list', '--limit', '100', ...(cursor == null ? [] : ['--cursor', String(cursor)])]);
        runs.push(...(page.runs ?? []).map(runSummary));
        cursor = page.nextCursor;
        if (cursor != null && visited.has(String(cursor))) throw new Error('Orca Run 페이지 커서가 반복되었습니다.');
        if (cursor != null) visited.add(String(cursor));
      } while (cursor != null);
      return runs;
    },
    async snapshot(runId: string): Promise<RunSnapshot> {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) throw new Error('올바르지 않은 Run ID입니다.');
      const [detail, tasks] = await Promise.all([
        command(['orchestration', 'run-show', '--id', runId]),
        command(['orchestration', 'task-list', '--run', runId]),
      ]);
      const workers: WorkerSummary[] = [];
      let cursor: unknown;
      const visited = new Set<string>();
      do {
        const page = await command(['orchestration', 'worker-list', '--run', runId, '--include-remote', '--limit', '100',
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
    async renameTerminal(terminal: string, title: string) {
      if (!/^term_[a-zA-Z0-9-]{1,128}$/.test(terminal)) return;
      await command(['terminal', 'rename', '--terminal', terminal, '--title', title.slice(0, 80)]);
    },
    async openTask(runId: string, taskId: string): Promise<{ opened: boolean; reason?: string }> {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(taskId)) throw new Error('올바르지 않은 Task ID입니다.');
      const snapshot = await bridge.snapshot(runId);
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
