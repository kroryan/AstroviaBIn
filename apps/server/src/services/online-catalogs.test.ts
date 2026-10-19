import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { getOnlineCatalog } = await import('./online-catalogs');

it('queries SIMBAD with hierarchical non-star types and persists the complete result', async () => {
  const cache = await mkdtemp(path.join(os.tmpdir(), 'astroviabin-online-catalog-'));
  const previousCache = process.env.ASTROVIABIN_ONLINE_CACHE_DIR;
  const previousFetch = globalThis.fetch;
  process.env.ASTROVIABIN_ONLINE_CACHE_DIR = cache;
  const simbadRows = [['M 33', 23.462069, 30.660175, 'G', 5.7]];
  let query = '';
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === 'simbad.cds.unistra.fr') {
      query = url.searchParams.get('query') ?? '';
      return new Response(JSON.stringify({ data: simbadRows }), { status: 200 });
    }
    return new Response('# empty VizieR result\n', { status: 200 });
  }) as typeof fetch;

  try {
    const result = await getOnlineCatalog(99123, { ra: 23.462069, dec: 30.660175, radiusDeg: 0.5, pixelScale: 1 });
    assert.ok(result);
    assert.match(query, /otype\s*!=\s*'star\.\.'/i);
    assert.doesNotMatch(query, /NOT\s+LIKE/i);
    assert.deepEqual(result.simbad, [{ name: 'M 33', ra: 23.462069, dec: 30.660175, type: 'G', mag: 5.7 }]);
    const files = await readdir(cache);
    assert.equal(files.length, 1, 'complete successful catalogue results are cached');
    const cached = JSON.parse(await readFile(path.join(cache, files[0]), 'utf8'));
    assert.deepEqual(cached.simbad, result.simbad);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousCache === undefined) delete process.env.ASTROVIABIN_ONLINE_CACHE_DIR;
    else process.env.ASTROVIABIN_ONLINE_CACHE_DIR = previousCache;
    await rm(cache, { recursive: true, force: true });
  }
});
