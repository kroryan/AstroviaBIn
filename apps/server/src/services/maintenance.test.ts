import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const { pruneCacheDirectory } = await import('./maintenance');

it('removes stale cache files and then the oldest ones until the cache fits its budget', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sidereal-cache-'));
  try {
    await mkdir(path.join(directory, 'tiles'), { recursive: true });
    const now = Date.now();
    const files = [
      ['ancient.png', 100, now - 90 * 86_400_000],
      ['old.png', 100, now - 3 * 86_400_000],
      [path.join('tiles', 'mid.jpg'), 100, now - 2 * 86_400_000],
      ['new.png', 100, now - 1000],
    ] as const;
    for (const [name, size, mtime] of files) {
      await writeFile(path.join(directory, name), Buffer.alloc(size));
      await utimes(path.join(directory, name), mtime / 1000, mtime / 1000);
    }
    const result = await pruneCacheDirectory(directory, 200, 60, now);
    assert.equal(result.removed, 2);
    assert.equal(result.freedBytes, 200);
    assert.deepEqual((await readdir(directory)).sort(), ['new.png', 'tiles']);
    assert.deepEqual(await readdir(path.join(directory, 'tiles')), ['mid.jpg']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('ignores a missing cache directory', async () => {
  assert.deepEqual(await pruneCacheDirectory(path.join(tmpdir(), 'sidereal-missing-cache-dir'), 1, 1), { removed: 0, freedBytes: 0 });
});
