#!/usr/bin/env node
// A process fixture for exercising the actual Rust CLI adapter (no Orca app required).
import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2).filter(arg => arg !== '--json');
const fixture = JSON.parse(readFileSync(process.env.WORKFLOW_CANVAS_CLI_FIXTURE, 'utf8'));
const key = args.slice(0, 2).join(' ') + (args.includes('--cursor') ? '.next' : '');
const answer = fixture[key] ?? { result: {} };
const record = kind => process.env.WORKFLOW_CANVAS_CLI_LOG && appendFileSync(process.env.WORKFLOW_CANVAS_CLI_LOG, `${JSON.stringify({ kind, pid: process.pid, args })}\n`);
record('start');
if (answer.delay) await new Promise(done => setTimeout(done, answer.delay));
if (answer.raw) { process.stderr.write('private-fixture-stderr'); process.stdout.write('invalid-private-fixture-output'); process.exitCode = 1; }
else process.stdout.write(JSON.stringify(answer.error ? { ok: false, error: answer.error } : { ok: true, result: answer.result }));
record('end');
