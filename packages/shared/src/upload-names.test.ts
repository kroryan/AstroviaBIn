import { it } from 'node:test';
import assert from 'node:assert/strict';
import { uploadNameKey } from './upload-names';

it('matches a stored upload to the name it was picked with', () => {
  assert.equal(uploadNameKey('M42 final.FITS'), uploadNameKey('M42_final-1729512345678.fits'));
  assert.equal(uploadNameKey('folder/sub/Orion (1).jpg'), 'orion_1.jpg');
  assert.notEqual(uploadNameKey('m42.fits'), uploadNameKey('m43.fits'));
  assert.notEqual(uploadNameKey('m42.fits'), uploadNameKey('m42.fit'));
});
