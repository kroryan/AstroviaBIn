import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepSkyTagged, isPlateSolvingEligible, isSolarSystemTagged } from './solar-system';

test('identifies Solar System and planet tags independently of case', () => {
  assert.equal(isSolarSystemTagged(['Solar System']), true);
  assert.equal(isSolarSystemTagged(['mars']), true);
  assert.equal(isSolarSystemTagged(['Deep Sky', 'M 42']), false);
  assert.equal(isSolarSystemTagged(null), false);
});

test('requires the editable Deep Sky tag for plate solving', () => {
  assert.equal(isDeepSkyTagged(['Deep Sky']), true);
  assert.equal(isPlateSolvingEligible(['Deep Sky', 'M 42']), true);
  assert.equal(isPlateSolvingEligible(['M 42']), false);
  assert.equal(isPlateSolvingEligible(['Deep Sky', 'Mars']), false);
  // An existing stellar solution keeps the frame re-solvable without a Deep Sky tag.
  assert.equal(isPlateSolvingEligible(['M 42'], true), true);
  assert.equal(isPlateSolvingEligible(['Saturn'], true), false);
});
