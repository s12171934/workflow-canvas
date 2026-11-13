import { compute } from './native.ts';
import type { Workflow } from '../../src/model.ts';
export type GenerationKind = 'workflow' | 'brief';
export type Generation = {
  id: string; kind: GenerationKind; status: 'pending' | 'done' | 'failed'; createdAt: number; project: string;
  /** brief: the node the instructions are for (in the canvas's current graph). */
  nodeId?: string;
  /** workflow: the saved workflow the agent produced. brief: the generated instructions. */
  workflowId?: string; description?: string; label?: string; error?: string;
};
export const generationTimeoutMs = 30 * 60_000, maxPromptLength = 10_000;
export const workflowPrompt = (input: { request: string; resultUrl: string; resultFile: string; saved: { id: string; name: string }[]; models?: readonly string[] }): string => compute('workflowPrompt', [input]);
export const briefPrompt = (input: { request: string; resultUrl: string; resultFile: string; graph: Workflow; nodeId: string }): string => compute('briefPrompt', [input]);
export const generatedWorkflow = (raw: unknown, id: string): Workflow => compute('generatedWorkflow', [raw, id]);
