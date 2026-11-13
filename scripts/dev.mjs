import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2).filter(arg => arg !== '--dev');
const build = spawnSync(process.execPath, [`${root}/scripts/build-rust.mjs`, '--dev'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const portAt = args.indexOf('--port');
const port = Number(portAt >= 0 ? args[portAt + 1] : process.env.WORKFLOW_CANVAS_PORT ?? 4318);
if (!Number.isInteger(port) || port < 1 || port > 65534) throw new Error('개발 포트는 1~65534 사이여야 합니다.');
const vite = await createServer({ root, server: { host: '127.0.0.1', port: port + 1, strictPort: true, hmr: { host: '127.0.0.1', clientPort: port + 1 } } });
await vite.listen();
const backend = spawn(`${root}/.local/target/debug/workflow-canvas`, ['--root', root, '--dev-proxy', `http://127.0.0.1:${port + 1}`, '--port', String(port), ...args], { cwd: root, stdio: 'inherit' });
let closing = false;
async function close(code = 0) { if (closing) return; closing = true; backend.kill('SIGTERM'); await vite.close(); process.exitCode = code; }
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
backend.once('error', error => { console.error(error.message); void close(1); });
backend.once('exit', code => void close(code ?? 1));
