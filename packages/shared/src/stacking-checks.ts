import { filterInfo, observationDate } from './fits-groups';

/** Checks a stacking selection against the stacking guide's rules (see the Stack page). */

export type Level = 'error' | 'warning' | 'info' | 'ok';
export interface SelectionNote { level: Level; text: string }
export interface StackFrame {
  id: number;
  filters?: string | null;
  description?: string | null;
  originalPath?: string | null;
  exposureTime?: string | null;
  captureDate?: string | Date | null;
  targetName?: string | null;
  tags?: string[] | null;
}


const isDerived = (image: StackFrame) => Boolean(image.originalPath?.startsWith('fits-derived://'));
const isComposite = (image: StackFrame) => Boolean(image.filters?.includes(',')) || /\bRGB\b/.test(image.description ?? '');
const size = (image: StackFrame) => image.description?.match(/FITS\s+(\d+)\s*×\s*(\d+)/)?.slice(1, 3).join('×') ?? null;
const seconds = (image: StackFrame) => Number.parseFloat(image.exposureTime ?? '');
const movingTarget = (image: StackFrame) =>
  /^\(?\d+\)?\s+[A-Za-zÀ-ÿ]/.test(image.targetName ?? '') || /^[CP]\/\d{4}/.test(image.targetName ?? '') ||
  (image.tags ?? []).some(tag => /^(asteroid|asteroids|comet|comets)$/i.test(tag));

/** Checks a stacking selection against the rules in the guide below. */
export function checkSelection(frames: StackFrame[], albumOf: (id: number) => string | null): SelectionNote[] {
  if (frames.length < 2) return [];
  const notes: SelectionNote[] = [];
  const filters = [...new Set(frames.map(frame => filterInfo(frame.filters).code))];
  if (filters.length > 1) notes.push({ level: 'error', text: `Mixed filters (${filters.join(', ')}): stack each filter separately and combine the stacks into colour afterwards.` });
  if (frames.some(isComposite) && frames.some(frame => !isComposite(frame))) notes.push({ level: 'error', text: 'Colour composites mixed with single-filter frames: they are different kinds of data.' });
  else if (frames.every(isComposite)) notes.push({ level: 'warning', text: 'These are already colour composites (final products). Stacking them only makes sense for repeated composites of the same field and channel order.' });
  const albums = [...new Set(frames.map(frame => albumOf(frame.id) ?? 'unclassified'))];
  if (albums.length > 1) notes.push({ level: 'warning', text: `Frames from different fields (${albums.join(', ')}): a stack needs overlapping fields; panels of a mosaic need a mosaic tool instead.` });
  if (frames.some(isDerived)) notes.push({ level: 'warning', text: 'The selection includes earlier stacks: re-stacking a stack with its own frames counts their signal twice. Stack raw frames, or stacks of different frames only.' });
  const sizes = [...new Set(frames.map(size).filter(Boolean))];
  if (sizes.length > 1) notes.push({ level: 'info', text: `Different frame sizes (${sizes.join(', ')}) — different binning or cameras. They are aligned through their plate solutions, but mixing pixel scales and PSFs costs sharpness; prefer one setup.` });
  const exposures = [...new Set(frames.map(seconds).filter(Number.isFinite))];
  if (exposures.length > 1) notes.push({ level: 'info', text: `Different exposure times (${exposures.map(value => `${value}s`).join(', ')}): values are normalized to the reference exposure, but long frames may saturate stars the short ones do not.` });
  const nights = [...new Set(frames.map(frame => observationDate(frame.captureDate)).filter(Boolean))];
  if (nights.length > 1) notes.push({ level: 'info', text: `Frames from ${nights.length} different nights: fine for a deep image, wrong for photometry, variable stars or finding changes between those nights.` });
  if (frames.some(movingTarget)) notes.push({ level: 'warning', text: 'The target is an asteroid or comet: stacking aligns the stars, so the moving object is smeared or rejected by sigma-clipping. Measure it in single frames (or use a track-and-stack on its motion).' });
  if (!notes.length) notes.push({ level: 'ok', text: `Consistent selection: one field, one filter (${filters[0]}), one kind of data.` });
  return notes;
}

