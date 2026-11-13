import { compute, rpc } from './native.ts';
import type { RunEvent, RunLogMeta, RunSnapshot } from '../../src/model.ts';
export { coordinatorEventTypes } from '../../src/model.ts';
export const quietAfterMs = 30 * 60 * 1000, idleAfterMs = 6 * 60 * 60 * 1000, quietEveryMs = 5 * 60 * 1000, settledEveryMs = 15 * 60 * 1000;
export const ended = (events: RunEvent[]): boolean => compute('ended', [events]);
export const outcomeOf = (meta: RunLogMeta | undefined, events: RunEvent[]): string => compute('outcomeOf', [meta, events]);
export const launchDirName = (at: Date, id: string) => `${at.toISOString().replace(/[:.]/g, '-')}-${id}`;
export function createRunLog(root: string) {
  const call = <T = any>(name: string, ...args: unknown[]): Promise<T> => rpc(`log.${name}`, [root, ...args]);
  return { root,
    start: (id: string, meta: RunLogMeta) => call('start', id, meta),
    append: (id: string, event: unknown) => call('append', id, event),
    appendRun: (run: string, event: unknown) => call('appendRun', run, event),
    register: (workflow: string, run: string, executions: unknown, launch?: string) => call('register', workflow, run, executions, launch),
    adopt: (workflow: string, name: string, run: string, executions: unknown) => call('adopt', workflow, name, run, executions),
    observe: (snapshot: RunSnapshot) => call('observe', snapshot),
    meta: (id: string) => call('meta', id), patchMeta: (id: string, patch: unknown) => call('patchMeta', id, patch),
    coordinatorsToClose: (now: number, grace: number) => call('coordinatorsToClose', now, grace),
    coordinatorsToWatch: (now?: number) => call<{ id: string; terminal: string; runId?: string }[]>('coordinatorsToWatch', now), markLost: (id: string, terminal: string) => call('markLost', id, terminal),
    liveByWorkflow: () => call('liveByWorkflow'), overview: (runs: string[]) => call('overview', runs),
    metaOfRun: (run: string) => call('metaOfRun', run), runPace: (run: string, now?: number) => call('runPace', run, now),
    launchOfRun: (run: string) => call('launchOfRun', run), list: (workflow: string) => call('list', workflow),
    detail: (workflow: string, id: string) => call('detail', workflow, id), files: (id: string) => call('files', id),
    file: (workflow: string, id: string, name: string) => call('file', workflow, id, name),
    validLaunch: (workflow: string, id: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(workflow) && /^[a-zA-Z0-9_-]{1,200}$/.test(id) && id.endsWith(`-${workflow}`) && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/.test(id),
    watch(snapshot: (run: string) => Promise<RunSnapshot>, interval: number) {
      let stopped = false, timer: ReturnType<typeof setTimeout>;
      async function tick() {
        for (const run of await call<string[]>('watchTargets')) { try { await call('observe', await snapshot(run)); } catch {} }
        if (!stopped) { timer = setTimeout(tick, interval); timer.unref(); }
      }
      timer = setTimeout(tick, 0); timer.unref();
      return () => { stopped = true; clearTimeout(timer); };
    },
  };
}
