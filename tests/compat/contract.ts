import { readFileSync } from 'node:fs';
export const runtimeContract = JSON.parse(readFileSync(new URL('../../exports/runtime-contract.json', import.meta.url), 'utf8')) as readonly { key: string; title: string; text: string }[];
export function runtimeContractMarkdown(): string { return runtimeContract.map(item => `- **${item.title}** — ${item.text}`).join('\n'); }
