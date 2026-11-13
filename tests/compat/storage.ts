import { calculate } from '../../src/core.ts';
import { rpc } from './native.ts';
import type { Workflow } from '../../src/model.ts';
export const validId = (id: string): boolean => /^[a-zA-Z0-9_-]{1,128}$/.test(id);
export const validateWorkflow = (value: unknown): Workflow => calculate('validateWorkflow', [value]);
export function createStorage(directory: string) {
  return {
    list: (): Promise<{ id: string; name: string; tags?: string[] }[]> => rpc('store.list', [directory]),
    load: (id: string): Promise<Workflow> => rpc('store.load', [directory, id]),
    save: (value: unknown): Promise<Workflow> => rpc('store.save', [directory, value]),
    remove: (id: string): Promise<void> => rpc('store.remove', [directory, id]),
    seed: (examples: string): Promise<string[]> => rpc('store.seed', [directory, examples]),
  };
}
