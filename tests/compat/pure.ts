import { compute } from './native.ts';
import type { Workflow } from '../../src/model.ts';
export const allowedHost = (host: string): boolean => compute('allowedHost', [host]);
export const documentVersion = (graph: Workflow): string => compute('documentVersion', [graph]);
