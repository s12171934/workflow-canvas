/** JSON boundary to the Rust library. Calculations stay synchronous and local to this tab. */
type CoreExports = {
  memory: WebAssembly.Memory;
  canvas_alloc: (length: number) => number;
  canvas_free: (pointer: number, length: number) => void;
  canvas_compute: (pointer: number, length: number) => bigint;
};
const wasmUrl = new URL('./generated/workflow_core.wasm', import.meta.url);
const filesystemModule = 'node:fs/promises';
const bytes: BufferSource = typeof window === 'undefined'
  ? await (await import(/* @vite-ignore */ filesystemModule)).readFile(wasmUrl)
  : await fetch(wasmUrl).then((response) => {
      if (!response.ok) throw new Error(`Rust 계산 모듈을 불러오지 못했습니다 (${response.status}).`);
      return response.arrayBuffer();
    });
const { instance } = await WebAssembly.instantiate(bytes, {});
const wasm = instance.exports as unknown as CoreExports;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function calculate<T>(op: string, args: unknown[]): T {
  const input = encoder.encode(JSON.stringify({ op, args }));
  const pointer = wasm.canvas_alloc(input.length);
  let output = 0, length = 0;
  try {
    new Uint8Array(wasm.memory.buffer, pointer, input.length).set(input);
    const packed = wasm.canvas_compute(pointer, input.length);
    output = Number(packed >> 32n);
    length = Number(packed & 0xffff_ffffn);
    const response = JSON.parse(decoder.decode(new Uint8Array(wasm.memory.buffer, output, length)));
    if (response.error !== undefined) throw new Error(response.error);
    return response.value as T;
  } finally {
    wasm.canvas_free(pointer, input.length);
    if (output) wasm.canvas_free(output, length);
  }
}

const memo = new Map<string, { key: string; value: unknown }>();
/** One entry per operation. Keys include values so mutations cannot leave stale state. */
export function calculateMemo<T>(op: string, args: unknown[]): T {
  const key = JSON.stringify(args), previous = memo.get(op);
  if (previous?.key === key) return previous.value as T;
  const value = calculate<T>(op, args);
  memo.set(op, { key, value });
  return value;
}
