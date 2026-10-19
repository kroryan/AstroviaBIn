import { it } from 'node:test';
import assert from 'node:assert/strict';

it('accepts pre-rename SIDEREAL_* variables as ASTROVIABIN_* aliases without overriding new names', async () => {
  process.env.SIDEREAL_TEST_ALIAS = 'legacy';
  process.env.SIDEREAL_TEST_BOTH = 'legacy';
  process.env.ASTROVIABIN_TEST_BOTH = 'current';
  await import('../env-compat');
  assert.equal(process.env.ASTROVIABIN_TEST_ALIAS, 'legacy');
  assert.equal(process.env.ASTROVIABIN_TEST_BOTH, 'current');
});
