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

test('new images are Deep Sky unless their name is a planet, the Sun or the Moon', async () => {
  const { defaultImageTags, withoutDeepSkyForPlanets } = await import('./solar-system');
  assert.deepEqual(defaultImageTags('Messier.png'), ['Deep Sky']);
  assert.deepEqual(defaultImageTags('Saturno1 canarias'), ['Saturn']);
  assert.deepEqual(defaultImageTags('sol2'), ['Sun']);
  assert.deepEqual(defaultImageTags('marte'), ['Mars']);
  assert.deepEqual(defaultImageTags('Júpiter 2026'), ['Jupiter']);
  assert.deepEqual(defaultImageTags('polux'), ['Deep Sky'], 'no planet inside other words');
  assert.deepEqual(defaultImageTags('Nebulosa (51 Andrómedas)'), ['Deep Sky']);
  assert.deepEqual(defaultImageTags(null, 'moon-mosaic'), ['Moon']);
  assert.deepEqual(withoutDeepSkyForPlanets(['Deep Sky', 'Saturn'], ['Deep Sky']), ['Saturn']);
  assert.deepEqual(withoutDeepSkyForPlanets(['Deep Sky', 'Comet', 'Solar System'], ['Deep Sky']), ['Deep Sky', 'Comet', 'Solar System'], 'comets keep Deep Sky');
  assert.deepEqual(withoutDeepSkyForPlanets(['Deep Sky', 'NGC 253'], []), ['Deep Sky', 'NGC 253']);
});

test('Solar System album categories come from the body tags', async () => {
  const { solarSystemSection } = await import('./solar-system');
  assert.equal(solarSystemSection(['astrophotography', 'Saturn']), 'Saturn');
  assert.equal(solarSystemSection(['Sun']), 'Sun');
  assert.equal(solarSystemSection(['jupiter']), 'Jupiter');
  assert.equal(solarSystemSection(['Solar System', 'Comet']), 'Comets');
  assert.equal(solarSystemSection(['Solar System']), 'Solar System');
  assert.equal(solarSystemSection([]), 'Solar System');
});
