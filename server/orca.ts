import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunSnapshot, RunSummary, TaskSummary, WorkerSummary } from '../src/model.ts';

const exec = promisify(execFile);
type Row = Record<string, any>;
export type Command = (args: string[]) => Promise<Row>;

export function commandForEnvironment(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND;
  if (env.ORCA_DEV_REPO_ROOT) return 'orca-dev';
  return process.platform === 'linux' && !env.ORCA_TERMINAL_HANDLE && !env.ORCA_WORKSPACE_ID ? 'orca-ide' : 'orca';
}

export const orcaCommand: Command = async (args) => {
  try {
    const { stdout } = await exec(commandForEnvironment(), [...args, '--json'], {
      timeout: 12000, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
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
    outcome: String(row.projection?.outcome ?? '') };
}

export function createOrcaBridge(command: Command = orcaCommand) {
  return {
    async status() {
      const result = await command(['status']);
      return { connected: result.runtime?.reachable === true && result.runtime?.state === 'ready',
        version: String(result.runtime?.appVersion ?? ''), observedAt: new Date().toISOString() };
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
  };
}
