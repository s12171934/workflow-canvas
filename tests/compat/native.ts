// Compatibility tests call the native Rust binary, never the retired Express server.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
const binary = resolve('.local/target/debug/workflow-canvas');
export function compute<T>(op: string, args: unknown[]): T {
  const result = spawnSync(binary, ['--compute'], { input: JSON.stringify({ op, args }), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'Rust 계산 프로세스 실패');
  const response = JSON.parse(result.stdout);
  if (response.error !== undefined) throw Object.assign(new Error(response.error), { status: response.status });
  return response.value as T;
}
let worker: ChildProcessWithoutNullStreams | undefined;
let sequence = 0, buffer = '';
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
function reference(ref: boolean) {
  for (const pipe of worker ? [worker.stdin, worker.stdout, worker.stderr] : []) {
    const handle = pipe as unknown as { ref?: () => void; unref?: () => void };
    if (ref) handle.ref?.(); else handle.unref?.();
  }
}
export function rpc<T>(op: string, args: unknown[]): Promise<T> {
  if (!worker) {
    worker = spawn(binary, ['--rpc'], { stdio: ['pipe', 'pipe', 'pipe'] });
    worker.unref();
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line) continue;
        const response = JSON.parse(line), waiter = pending.get(response.id);
        pending.delete(response.id);
        if (response.error !== undefined) waiter?.reject(Object.assign(new Error(response.error), { status: response.status }));
        else waiter?.resolve(response.value);
      }
      if (!pending.size) reference(false);
    });
    worker.on('error', error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); });
    process.once('exit', () => worker?.kill());
  }
  reference(true);
  const id = ++sequence;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
  });
}
