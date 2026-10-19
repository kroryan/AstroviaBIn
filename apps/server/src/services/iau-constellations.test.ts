import { it } from 'node:test';
import assert from 'node:assert/strict';
import { constellationName, precessJ2000ToB1875 } from './iau-constellations';
import { getConstellationFromCoordinates } from './constellation-utils';

it('finds the IAU constellation of well-known objects', () => {
  const cases: Array<[string, number, number, string]> = [
    ['M 33', 23.4621, 30.6602, 'Triangulum'],
    ['Pleiades', 56.75, 24.1167, 'Taurus'],
    ['Algol', 47.0422, 40.9556, 'Perseus'],
    ['NGC 253', 11.888, -25.2882, 'Sculptor'],
    ['Dubhe', 165.932, 61.751, 'Ursa Major'],
    ['Pollux', 116.329, 28.026, 'Gemini'],
    ['HD 104985', 181.313, 76.906, 'Camelopardalis'],
    ['M 42', 83.822, -5.391, 'Orion'],
    ['M 31', 10.6847, 41.2690, 'Andromeda'],
    ['Polaris', 37.9546, 89.2641, 'Ursa Minor'],
    ['Sigma Octantis', 317.195, -88.956, 'Octans'],
    ['Arcturus', 213.915, 19.182, 'Bootes'],
    ['M 104 (near the Virgo/Corvus border)', 189.998, -11.623, 'Virgo'],
  ];
  for (const [label, ra, dec, expected] of cases) {
    assert.equal(constellationName(ra, dec), expected, label);
    assert.equal(getConstellationFromCoordinates(ra, dec), expected, label);
  }
});

it('precesses J2000 back to B1875 by about 1.7 degrees of RA near the equator', () => {
  const { ra, dec } = precessJ2000ToB1875(0, 0);
  // 125 years of general precession: m ≈ 46.1"/yr in RA (1.601°) and n ≈ 20.0"/yr in Dec (0.696°) at RA 0h.
  assert.ok(Math.abs(ra - (360 - 1.601)) < 0.01, `ra ${ra}`);
  assert.ok(Math.abs(dec + 0.696) < 0.01, `dec ${dec}`);
});
