/**
 * Grouping of FITS frames by observation date (UTC) and filter, as observatories deliver them
 * (e.g. Slooh: three L frames, then R, G and B; LCO: SDSS r′, z_s…).
 */

export interface FilterInfo {
  /** Short code used for grouping ("L", "R", "Hα", "r′", "Color (R·B·V)"). */
  code: string;
  /** Human label ("L — Luminance"). */
  label: string;
  /** Sort order: luminance/clear, RGB, Johnson, narrowband, SDSS, other, colour composites. */
  order: number;
}

const KNOWN: Array<[RegExp, string, string, number]> = [
  [/^(l|lum|luminance|luminancia)$/, 'L', 'L — Luminance', 0],
  [/^(clear|cl|c|none|open|clr)$/, 'Clear', 'Clear', 1],
  [/^(r|red|rojo)$/, 'R', 'R — Red', 2],
  [/^(g|green|verde)$/, 'G', 'G — Green', 3],
  [/^(b|blue|azul)$/, 'B', 'B — Blue', 4],
  [/^(u|johnson u|bessell u)$/, 'U', 'U (Johnson)', 5],
  [/^(v|johnson v|bessell v)$/, 'V', 'V (Johnson)', 6],
  [/^(i|johnson i|bessell i)$/, 'I', 'I (Johnson)', 7],
  [/^(ha|halpha|h-alpha|h_alpha|hα|h-α|halfa)$/, 'Hα', 'Hα — Hydrogen-alpha', 8],
  [/^(oiii|o3|o-iii)$/, 'OIII', 'OIII — Oxygen', 9],
  [/^(sii|s2|s-ii)$/, 'SII', 'SII — Sulphur', 10],
  [/^(up|u')$/, 'u′', "u′ (SDSS)", 11],
  [/^(gp|g')$/, 'g′', "g′ (SDSS)", 12],
  [/^(rp|r')$/, 'r′', "r′ (SDSS)", 13],
  [/^(ip|i')$/, 'i′', "i′ (SDSS)", 14],
  [/^(zp|z')$/, 'z′', "z′ (SDSS)", 15],
  [/^(zs|z_s)$/, 'z_s', 'z_s (Pan-STARRS)', 16],
  [/^(y|ys)$/, 'Y', 'Y', 17],
];

export function filterInfo(filter: string | null | undefined): FilterInfo {
  const raw = (filter ?? '').trim();
  if (!raw) return { code: 'No filter', label: 'No filter recorded', order: 90 };
  if (raw.includes(',')) {
    const parts = raw.split(',').map(part => filterInfo(part).code);
    const code = `Color (${parts.join('·')})`;
    return { code, label: `${code} — colour composite`, order: 95 };
  }
  const normalized = raw.toLowerCase().replace(/\s+/g, ' ');
  const known = KNOWN.find(([pattern]) => pattern.test(normalized));
  return known ? { code: known[1], label: known[2], order: known[3] } : { code: raw, label: raw, order: 80 };
}

/** Observation date in UTC ("2026-10-17"), or null. */
export function observationDate(captureDate: string | Date | null | undefined): string | null {
  if (!captureDate) return null;
  const date = new Date(captureDate);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export interface FrameLike { id: number; captureDate?: string | Date | null; filters?: string | null }
export interface FilterGroup<T> { filter: FilterInfo; frames: T[] }
export interface DateGroup<T> { date: string | null; filters: Array<FilterGroup<T>>; count: number }

function time(frame: FrameLike): number {
  const value = frame.captureDate ? new Date(frame.captureDate).getTime() : Number.NaN;
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** Frames grouped by UTC date (newest first, unknown last), then filter, each in time order. */
export function groupByDateAndFilter<T extends FrameLike>(frames: T[]): Array<DateGroup<T>> {
  const byDate = new Map<string | null, T[]>();
  for (const frame of frames) {
    const date = observationDate(frame.captureDate);
    byDate.set(date, [...(byDate.get(date) ?? []), frame]);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : b.localeCompare(a)))
    .map(([date, list]) => {
      const byFilter = new Map<string, { filter: FilterInfo; frames: T[] }>();
      for (const frame of list) {
        const filter = filterInfo(frame.filters);
        const group = byFilter.get(filter.code) ?? { filter, frames: [] };
        group.frames.push(frame);
        byFilter.set(filter.code, group);
      }
      const filters = [...byFilter.values()]
        .sort((a, b) => a.filter.order - b.filter.order || a.filter.code.localeCompare(b.filter.code))
        .map(group => ({ ...group, frames: group.frames.sort((a, b) => time(a) - time(b) || a.id - b.id) }));
      return { date, filters, count: list.length };
    });
}
