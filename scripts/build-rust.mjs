import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const release = !process.argv.includes('--dev');
for (const args of [
  ['build', '--locked', '-p', 'workflow-core', '--target', 'wasm32-unknown-unknown', '--release'],
  ['build', '--locked', '-p', 'workflow-canvas', ...(release ? ['--release'] : [])],
]) {
  const result = spawnSync(`${root}/scripts/cargo`, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
mkdirSync(`${root}/src/generated`, { recursive: true });
copyFileSync(`${root}/.local/target/wasm32-unknown-unknown/release/workflow_core.wasm`, `${root}/src/generated/workflow_core.wasm`);
