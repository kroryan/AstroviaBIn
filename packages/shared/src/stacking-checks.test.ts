import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSelection } from './stacking-checks';

const frame = (id: number, extra: Record<string, unknown> = {}) => ({
  id, filters: 'Luminance', description: 'FITS 4096×4096 · mono · 16-bit', originalPath: `fits-upload://f${id}.fits`,
  exposureTime: '60s', captureDate: '2026-10-17T01:40:51Z', targetName: 'M 42', tags: ['FITS', 'Deep Sky'], ...extra,
});
const album = () => 'M 42';
const levels = (notes: ReturnType<typeof checkSelection>) => notes.map(note => note.level);

test('three Slooh L frames of one night are a consistent stack', () => {
  const notes = checkSelection([frame(1), frame(2, { exposureTime: '60.099s' }), frame(3, { exposureTime: '60.2s' })], album);
  assert.deepEqual(levels(notes), ['ok']);
});

test('mixing L with R is refused, composites with mono too', () => {
  assert.ok(checkSelection([frame(1), frame(4, { filters: 'Red' })], album).some(note => note.level === 'error' && /Mixed filters/.test(note.text)));
  assert.ok(checkSelection([frame(1), frame(5, { filters: 'R,B,V' })], album).some(note => note.level === 'error' && /composites/.test(note.text)));
});

test('stacks, other fields, other nights, sizes, exposures and moving targets are flagged', () => {
  const notes = checkSelection([
    frame(1),
    frame(2, { originalPath: 'fits-derived://stack.fits', description: 'FITS 2400×2400 · mono · -32-bit', exposureTime: '120s', captureDate: '2026-10-14T00:36:54Z' }),
  ], id => (id === 1 ? 'M 42' : 'NGC 253'));
  const text = notes.map(note => note.text).join(' | ');
  for (const pattern of [/earlier stacks/, /different fields/, /frame sizes/, /exposure times/, /2 different nights/]) assert.match(text, pattern);
  assert.match(checkSelection([frame(1, { targetName: '1620 Geographos' }), frame(2, { targetName: '1620 Geographos' })], album).map(note => note.text).join(' '), /asteroid or comet/);
});
