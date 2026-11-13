import { compute } from './native.ts';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { workerModels } from '../../src/model.ts';

/** Model families offered per launching node: the newest model of each is listed. */
export const modelFamilies = ['opus', 'sonnet', 'haiku', 'fable'] as const;
const cacheMs = 60 * 60_000;
const retryMs = 5 * 60_000;

export type ModelList = { models: string[]; source: 'api' | 'fallback'; error?: string };
type ApiModel = { id: string; created_at?: string };

/** Newest model per family, in `modelFamilies` order. Ids outside the families are ignored. */
export function latestPerFamily(models: ApiModel[]): string[] { return compute('latestPerFamily', [models]); }

/**
 * Credentials for the Models API: ANTHROPIC_API_KEY, else the Claude Code login (macOS keychain, then
 * ~/.claude/.credentials.json). Undefined when none is found.
 */
async function credentials(): Promise<Record<string, string> | undefined> {
  if (process.env.ANTHROPIC_API_KEY) return { 'x-api-key': process.env.ANTHROPIC_API_KEY };
  const oauth = (raw: string) => {
    try { const token = JSON.parse(raw)?.claudeAiOauth?.accessToken; return typeof token === 'string' && token ? token : undefined; }
    catch { return undefined; }
  };
  let token: string | undefined;
  if (process.platform === 'darwin') {
    try { token = oauth((await promisify(execFile)('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5_000 })).stdout); }
    catch { /* not in the keychain */ }
  }
  if (!token) {
    try { token = oauth(await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8')); }
    catch { /* no file */ }
  }
  return token ? { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' } : undefined;
}

/** Fetches the current model list from the Anthropic Models API. */
export async function fetchModels(fetcher: typeof fetch = fetch, auth = credentials): Promise<string[]> {
  const headers = await auth();
  if (!headers) throw new Error('Anthropic 자격 증명(ANTHROPIC_API_KEY 또는 Claude Code 로그인)을 찾지 못했습니다.');
  const response = await fetcher('https://api.anthropic.com/v1/models?limit=1000', {
    headers: { ...headers, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Models API 응답 ${response.status}`);
  const body = await response.json() as { data?: ApiModel[] };
  const models = latestPerFamily(Array.isArray(body.data) ? body.data.filter((item) => typeof item?.id === 'string') : []);
  if (!models.length) throw new Error('Models API 가 쓸 수 있는 모델을 돌려주지 않았습니다.');
  return models;
}

/** Cached model list: refreshed hourly; on failure the built-in list is served and retried after a few minutes. */
export function createModelCatalog(fetchList: () => Promise<string[]> = () => fetchModels()) {
  let cached: { list: ModelList; at: number; ttl: number } | undefined;
  let pending: Promise<ModelList> | undefined;
  return {
    async list(): Promise<ModelList> {
      if (cached && Date.now() - cached.at < cached.ttl) return cached.list;
      pending ??= fetchList()
        .then((models): ModelList => { cached = { list: { models, source: 'api' }, at: Date.now(), ttl: cacheMs }; return cached.list; })
        .catch((error: Error): ModelList => {
          // Keep the last good list over the built-in one.
          const list: ModelList = cached?.list.source === 'api' ? { ...cached.list, error: error.message }
            : { models: [...workerModels], source: 'fallback', error: error.message };
          cached = { list, at: Date.now(), ttl: retryMs };
          return list;
        })
        .finally(() => { pending = undefined; });
      return pending;
    },
  };
}
