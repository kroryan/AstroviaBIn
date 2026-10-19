import assert from 'node:assert/strict';
import test from 'node:test';
import { filterInfo, groupByDateAndFilter, observationDate } from './fits-groups';

test('filter names from different observatories normalize to one code', () => {
  assert.equal(filterInfo('Luminance').code, 'L');
  assert.equal(filterInfo('L').code, 'L');
  assert.equal(filterInfo('Red').code, 'R');
  assert.equal(filterInfo('Hα').code, 'Hα');
  assert.equal(filterInfo('Halpha').code, 'Hα');
  assert.equal(filterInfo('rp').code, 'r′');
  assert.equal(filterInfo('zs').code, 'z_s');
  assert.equal(filterInfo('R,B,V').code, 'Color (R·B·V)');
  assert.equal(filterInfo('Weird-7').code, 'Weird-7');
  assert.equal(filterInfo(null).code, 'No filter');
  assert.ok(filterInfo('L').order < filterInfo('Red').order && filterInfo('Red').order < filterInfo('Blue').order);
});

test('dates are UTC calendar dates', () => {
  assert.equal(observationDate('2026-10-17T01:40:51Z'), '2026-10-17');
  assert.equal(observationDate('2026-10-16T23:59:00-03:00'), '2026-10-17');
  assert.equal(observationDate(null), null);
});

test('a Slooh LRGB set groups by night and filter in time order', () => {
  const frames = [
    { id: 6, captureDate: '2026-10-17T01:47:35Z', filters: 'Blue' },
    { id: 1, captureDate: '2026-10-17T01:40:51Z', filters: 'Luminance' },
    { id: 4, captureDate: '2026-10-17T01:44:58Z', filters: 'Red' },
    { id: 3, captureDate: '2026-10-17T01:43:34Z', filters: 'Luminance' },
    { id: 5, captureDate: '2026-10-17T01:46:16Z', filters: 'Green' },
    { id: 2, captureDate: '2026-10-17T01:42:13Z', filters: 'Luminance' },
    { id: 9, captureDate: '2026-10-14T00:36:54Z', filters: 'rp' },
    { id: 10, captureDate: null, filters: 'rp' },
  ];
  const groups = groupByDateAndFilter(frames);
  assert.deepEqual(groups.map(group => group.date), ['2026-10-17', '2026-10-14', null]);
  assert.deepEqual(groups[0].filters.map(group => [group.filter.code, group.frames.map(frame => frame.id)]),
    [['L', [1, 2, 3]], ['R', [4]], ['G', [5]], ['B', [6]]]);
});
