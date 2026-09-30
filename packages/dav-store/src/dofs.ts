import { Fs } from 'dofs';


type DofsFs = Fs;

type DofsContext = {
  readonly storage?: unknown;
  readonly [key: string]: unknown;
};

type DofsEnvironment = {
  readonly [key: string]: unknown;
};

interface DofsOptions {
  chunkSize?: number;
}

const DEFAULT_CHUNK_SIZE = 512 * 1024;
const MAX_CHUNK_SIZE = 8 * 1024 * 1024;

function validateChunkSize(chunkSize: unknown): number {
  if (typeof chunkSize !== 'number' || !Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > MAX_CHUNK_SIZE) {
    const seen = typeof chunkSize === 'number' ? String(chunkSize) : typeof chunkSize;
    throw new Error(`Invalid chunkSize: ${seen} (must be 1..${MAX_CHUNK_SIZE})`);
  }
  return chunkSize;
}

function createDofsFs(ctx: unknown, env: unknown, options: DofsOptions = {}): DofsFs {
  const { chunkSize = DEFAULT_CHUNK_SIZE } = options;
  const validated = validateChunkSize(chunkSize);
  return new Fs(ctx as ConstructorParameters<typeof Fs>[0], env as ConstructorParameters<typeof Fs>[1], { chunkSize: validated });
}

/**
 * Apply the volume's device quota.
 *
 * Deliberately does **not** swallow: `dofs.setDeviceSize` has no "already set"
 * error, so a throw here means the quota was not applied and will stay
 * unenforced. This function used to catch and ignore on the assumption that
 * the only possible error was ENOSPC, which meant the caller's
 * `ensureSize()` — the one place that logs "volume quota may be unenforced" —
 * never saw a failure. Let it propagate and let the caller decide; the caller
 * is per-isolate and runs once, so a logged failure is cheap.
 */
function setDofsDeviceSize(dofs: DofsFs, bytes: number): void {
  dofs.setDeviceSize(bytes);
}

export { createDofsFs, setDofsDeviceSize, validateChunkSize, DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE };
export type { DofsFs, DofsContext, DofsEnvironment, DofsOptions };

export { type DirEntry } from 'dofs';