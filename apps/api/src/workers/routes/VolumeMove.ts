import { getVolumeStub } from '../doStubs';

/**
 * One volume's move, addressed only by its old and new `/owner/volume` paths.
 *
 * The D1 row's `id` and `name` are deliberately absent: the Durable Object is
 * resolved from the *path* (`getVolumeStub`), so carrying them here would be a
 * second, unchecked source of the same identity.
 */
interface VolumeMoveItem {
  oldFull: string;
  newFull: string;
}

function splitFull(full: string): { owner: string; volume: string } {
  const [owner = '', volume = ''] = full.split('/', 2);
  return { owner, volume };
}

// Move one volume DO: list source entries, replay collections then files
// into the fresh target isolate, then purge the source. On copy failure the
// half-made target is purged and the error rethrown with the source left
// intact, so callers can roll back D1 without data loss. Locks are never
// copied (RFC 4918 §9.8); dead props follow file bytes via writeVolumeEntry.
async function moveOneVolume(env: Env, move: VolumeMoveItem): Promise<{ empty: boolean }> {
  const oldParts = splitFull(move.oldFull);
  const newParts = splitFull(move.newFull);
  const source = getVolumeStub(env, oldParts.owner, oldParts.volume);
  const entries = await source.listVolumeEntries();
  const target = getVolumeStub(env, newParts.owner, newParts.volume);
  try {
    // Collections before files, and shallower before deeper within each, so a
    // child is never written into a parent that does not exist yet.
    const ordered = [...entries].sort((a, b) => {
      if (a.isCollection !== b.isCollection) return a.isCollection ? -1 : 1;
      return a.path.length - b.path.length;
    });
    for (const entry of ordered) {
      if (!entry.path) continue;
      // Hoisted out of the branch: both arms need it, and reading it twice made
      // a future change to the two arms easy to get half-done.
      const props = entry.props ?? [];
      if (entry.isCollection) {
        await target.writeVolumeEntry({ path: entry.path, isCollection: true, props });
      } else {
        const file = await source.readVolumeFile(entry.path);
        if (!file) throw new Error(`Failed to copy volume file ${entry.path}`);
        await target.writeVolumeEntry({
          path: entry.path,
          isCollection: false,
          contentType: file.contentType ?? entry.contentType,
          etag: entry.etag,
          dataBase64: file.dataBase64,
          props,
        });
      }
    }
    // The source purge is inside the `try` on purpose. If it fails, the
    // compensation below purges the *target* and the source is still intact —
    // whereas treating a failed purge as success would leave the data in both
    // isolates while the route rolled D1 back, which is the one outcome with no
    // recovery path.
    await source.deleteVolume();
    return { empty: entries.length === 0 };
  } catch (error) {
    await target.deleteVolume().catch(() => undefined);
    throw error;
  }
}

// Compensation for an already-moved volume when a later volume fails.
// Best-effort: returns false when the copy-back itself fails, in which case
// the data still exists under the new name.
async function moveOneVolumeBack(env: Env, move: VolumeMoveItem): Promise<boolean> {
  try {
    await moveOneVolume(env, { oldFull: move.newFull, newFull: move.oldFull });
    return true;
  } catch {
    return false;
  }
}

// Fail-closed multi-volume move for username renames (D1 already committed).
// Volumes move sequentially; on the first failure, already-moved volumes are
// copied back and the original error is rethrown so the route can compensate
// D1 (inverse rename) and surface 500 instead of an empty volume.
async function moveVolumeDosForRename(env: Env, moves: VolumeMoveItem[]): Promise<{ moved: number; empty: number }> {
  const completed: VolumeMoveItem[] = [];
  let moved = 0;
  let empty = 0;
  try {
    for (const move of moves) {
      if (!move?.oldFull || !move?.newFull || move.oldFull === move.newFull) continue;
      const result = await moveOneVolume(env, move);
      completed.push(move);
      moved += 1;
      if (result.empty) empty += 1;
    }
    return { moved, empty };
  } catch (error) {
    for (let i = completed.length - 1; i >= 0; i -= 1) {
      const item = completed[i];
      if (item) await moveOneVolumeBack(env, item);
    }
    throw error;
  }
}

export { moveVolumeDosForRename, splitFull };
export type { VolumeMoveItem };
