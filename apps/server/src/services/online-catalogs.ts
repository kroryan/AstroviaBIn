import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sqliteDbPath } from '../db';

/**
 * Optional online catalogues for deeper annotations: Gaia DR3 stars (via CDS VizieR) and named
 * SIMBAD objects. Only the field centre and radius leave the server. Results are stored per image
 * and solution on local disk and reused forever; without a connection the offline bundle is used.
 */

export interface OnlineStar { id: string; ra: number; dec: number; pmra: number; pmdec: number; mag: number | null }
export interface OnlineObject { name: string; ra: number; dec: number; type: string; mag: number | null }
export interface OnlineCatalog { fetchedAt: string; gaia: OnlineStar[]; simbad: OnlineObject[]; errors: string[] }

const TIMEOUT_MS = Number(process.env.ASTROVIABIN_ONLINE_TIMEOUT_MS) || 12_000;
const failures = new Map<string, number>();
const pending = new Map<string, Promise<OnlineCatalog | null>>();

export function onlineCatalogsEnabled(): boolean {
  return process.env.ASTROVIABIN_ONLINE_CATALOGS !== 'false';
}

function cacheDirectory(): string {
  const base = process.env.ASTROVIABIN_ONLINE_CACHE_DIR
    || path.join(path.dirname(path.resolve(sqliteDbPath && sqliteDbPath !== ':memory:' ? sqliteDbPath : 'local.db')), 'online-catalog-cache');
  return path.resolve(base);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'AstroviaBin/1.0 (self-hosted annotations)' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** Gaia DR3 stars brighter than `magLimit`, brightest first (VizieR I/355/gaiadr3, epoch 2016.0). */
async function fetchGaia(ra: number, dec: number, radiusDeg: number, magLimit: number): Promise<OnlineStar[]> {
  const params = new URLSearchParams({
    '-source': 'I/355/gaiadr3',
    '-c': `${ra.toFixed(6)} ${dec >= 0 ? '+' : ''}${dec.toFixed(6)}`,
    '-c.rd': radiusDeg.toFixed(5),
    '-out': 'Source,RA_ICRS,DE_ICRS,pmRA,pmDE,Gmag',
    '-out.max': '2000',
    '-sort': 'Gmag',
    Gmag: `<${magLimit}`,
  });
  const text = await fetchText(`https://vizier.cds.unistra.fr/viz-bin/asu-tsv?${params}`);
  const stars: OnlineStar[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [source, raText, decText, pmra, pmdec, gmag] = line.split('\t').map(value => value.trim());
    const r = Number(raText);
    const d = Number(decText);
    if (!/^\d+$/.test(source) || !Number.isFinite(r) || !Number.isFinite(d)) continue;
    stars.push({ id: source, ra: r, dec: d, pmra: Number(pmra) || 0, pmdec: Number(pmdec) || 0, mag: gmag ? Number(gmag) : null });
  }
  return stars;
}

/** Non-stellar SIMBAD objects (galaxies, nebulae, clusters, QSOs…) in the field, brightest first. */
async function fetchSimbad(ra: number, dec: number, radiusDeg: number): Promise<OnlineObject[]> {
  const query = `SELECT TOP 400 b.main_id, b.ra, b.dec, b.otype, f.V FROM basic AS b LEFT JOIN allfluxes AS f ON b.oid = f.oidref ` +
    `WHERE CONTAINS(POINT('ICRS', b.ra, b.dec), CIRCLE('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}, ${radiusDeg.toFixed(5)})) = 1 ` +
    `AND b.ra IS NOT NULL AND b.otype NOT LIKE '%*' AND b.otype NOT IN ('IR', 'X', 'Rad', 'UV', 'gam', 'mR', 'cm', 'mm', 'smm', 'HI', '?', 'reg', 'err', 'PoC', 'PoG', 'Unknown')`;
  const params = new URLSearchParams({ request: 'doQuery', lang: 'adql', format: 'json', query });
  const json = JSON.parse(await fetchText(`https://simbad.cds.unistra.fr/simbad/sim-tap/sync?${params}`)) as { data?: Array<[string, number, number, string, number | null]> };
  return (json.data ?? []).map(([name, r, d, type, v]) => ({ name: String(name).replace(/\s+/g, ' ').trim(), ra: Number(r), dec: Number(d), type: String(type), mag: v ?? null }))
    .filter(object => Number.isFinite(object.ra) && Number.isFinite(object.dec));
}

/**
 * Cached online catalogue for an image's solved field; fetched once (in parallel) and stored on
 * disk. Returns null when disabled or offline. Failed lookups are retried after 10 minutes.
 */
export async function getOnlineCatalog(imageId: number, field: { ra: number; dec: number; radiusDeg: number; pixelScale: number }): Promise<OnlineCatalog | null> {
  if (!onlineCatalogsEnabled()) return null;
  const key = `${imageId}-${createHash('sha1').update(`${field.ra.toFixed(5)},${field.dec.toFixed(5)},${field.radiusDeg.toFixed(4)}`).digest('hex').slice(0, 12)}`;
  const file = path.join(cacheDirectory(), `${key}.json`);
  try { return JSON.parse(await readFile(file, 'utf8')) as OnlineCatalog; } catch { /* not cached yet */ }
  if ((failures.get(key) ?? 0) > Date.now()) return null;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;

  const work = (async () => {
    // Deeper for finer sampling: ~G 17 at 1"/px, ~G 14 for wide fields.
    const magLimit = Math.min(18, Math.max(13, 16 - Math.log2(Math.max(0.25, field.pixelScale)) * 1.2));
    const radius = Math.min(field.radiusDeg, 3);
    const [gaia, simbad] = await Promise.allSettled([fetchGaia(field.ra, field.dec, radius, magLimit), fetchSimbad(field.ra, field.dec, radius)]);
    const errors = [gaia, simbad].filter(result => result.status === 'rejected').map(result => String((result as PromiseRejectedResult).reason));
    if (gaia.status === 'rejected' && simbad.status === 'rejected') {
      failures.set(key, Date.now() + 10 * 60_000);
      console.warn(`Online catalogues unavailable for image ${imageId}: ${errors.join('; ')}`);
      return null;
    }
    const catalog: OnlineCatalog = {
      fetchedAt: new Date().toISOString(),
      gaia: gaia.status === 'fulfilled' ? gaia.value : [],
      simbad: simbad.status === 'fulfilled' ? simbad.value : [],
      errors,
    };
    // Only cache complete results so a partial failure is retried next time.
    if (errors.length === 0) {
      await mkdir(cacheDirectory(), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(catalog));
      await rename(temporary, file);
    }
    return catalog;
  })().finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}
