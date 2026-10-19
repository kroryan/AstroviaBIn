import assert from 'node:assert/strict';
import test from 'node:test';
import { isPlateSolvingEligible, isSolarSystemTagged } from './solar-system';

test('planet and Solar System tags identify frames that do not need stellar plate solving', () => {
  assert.equal(isSolarSystemTagged(['Solar System']), true);
  assert.equal(isSolarSystemTagged(['Mars']), true);
  assert.equal(isPlateSolvingEligible(['Deep Sky', 'Jupiter']), false);
});

test('comet and asteroid tags allow Deep Sky plate solving', () => {
  assert.equal(isSolarSystemTagged(['Solar System', 'Comet']), false);
  assert.equal(isPlateSolvingEligible(['Deep Sky', 'Comet']), true);
  assert.equal(isPlateSolvingEligible(['Deep Sky', 'Asteroid']), true);
});
