import { it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWcsHeaders, pixelToSky, skyToPixel, pixelScaleArcsec } from './wcs';

// TAN-SIP header; expected values were computed independently with astropy.wcs
// (all_pix2world / all_world2pix, origin=1).
const headers = {
  CTYPE1: 'RA---TAN-SIP', CTYPE2: 'DEC--TAN-SIP',
  CRVAL1: 83.8221, CRVAL2: -5.3911, CRPIX1: 2001.5, CRPIX2: 1499.25,
  CD1_1: -3.1e-4, CD1_2: 2.2e-5, CD2_1: -2.0e-5, CD2_2: -3.05e-4,
  A_ORDER: 2, A_0_2: 2.1e-7, A_1_1: -3.3e-7, A_2_0: 4.0e-7,
  B_ORDER: 2, B_0_2: -1.7e-7, B_1_1: 2.6e-7, B_2_0: 1.2e-7,
};
const wcs = parseWcsHeaders(headers, 4000, 3000);

const pixToWorld: Array<[number, number, number, number]> = [
  [1, 1, 84.41108199249831, -4.894168275124826],
  [4000, 3000, 83.23219533946215, -5.888765135242543],
  [2001.5, 1499.25, 83.8221, -5.3910999999999945],
  [150.25, 2875.75, 84.4284892056465, -5.773457943370932],
  [3900, 40, 83.19825988343037, -4.983569558482473],
];
const worldToPix: Array<[number, number, number, number]> = [
  [83.8221, -5.3911, 2001.5, 1499.25],
  [83.5, -5.1, 2963.3372118835473, 482.2665665760352],
  [84.1, -5.7, 1184.357525858544, 2566.136186246851],
  [83.9, -5.0, 1661.5009049559076, 239.37407412087055],
];

it('parses SIP distortion from a solve-field header', () => {
  assert.ok(wcs.sip);
  assert.equal(wcs.sip.a.order, 2);
  assert.equal(wcs.sip.b.terms['1_1'], 2.6e-7);
});

it('matches astropy pixel → sky to within a milliarcsecond', () => {
  for (const [x, y, ra, dec] of pixToWorld) {
    const sky = pixelToSky(wcs, x, y);
    assert.ok(Math.abs(sky.ra - ra) * 3600 < 1e-3, `RA at ${x},${y}: ${sky.ra} vs ${ra}`);
    assert.ok(Math.abs(sky.dec - dec) * 3600 < 1e-3, `Dec at ${x},${y}: ${sky.dec} vs ${dec}`);
  }
});

it('matches astropy sky → pixel to within a thousandth of a pixel', () => {
  for (const [ra, dec, x, y] of worldToPix) {
    const pixel = skyToPixel(wcs, ra, dec);
    assert.ok(pixel);
    assert.ok(Math.abs(pixel.x - x) < 1e-3, `x for ${ra},${dec}: ${pixel.x} vs ${x}`);
    assert.ok(Math.abs(pixel.y - y) < 1e-3, `y for ${ra},${dec}: ${pixel.y} vs ${y}`);
  }
});

it('round-trips across the whole frame', () => {
  for (let x = 1; x <= 4000; x += 333) {
    for (let y = 1; y <= 3000; y += 271) {
      const sky = pixelToSky(wcs, x, y);
      const back = skyToPixel(wcs, sky.ra, sky.dec)!;
      assert.ok(Math.hypot(back.x - x, back.y - y) < 1e-6);
    }
  }
});

it('handles RA wrap-around at 0/360 degrees', () => {
  const wrapped = parseWcsHeaders({ CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: 0.05, CRVAL2: 10, CRPIX1: 500, CRPIX2: 500, CD1_1: -1e-4, CD1_2: 0, CD2_1: 0, CD2_2: 1e-4 }, 1000, 1000);
  const pixel = skyToPixel(wrapped, 359.99, 10)!;
  assert.ok(pixel.x > 500 && pixel.x < 1300);
  const sky = pixelToSky(wrapped, pixel.x, pixel.y);
  assert.ok(Math.abs(sky.ra - 359.99) < 1e-9);
});

it('reports the linear pixel scale', () => {
  assert.ok(Math.abs(pixelScaleArcsec(wcs) - Math.sqrt(3.1e-4 * 3.05e-4 + 2.2e-5 * 2.0e-5) * 3600) < 1e-9);
});

it('rejects points on the far side of the sky', () => {
  assert.equal(skyToPixel(wcs, 83.8221 + 180, 5.3911), null);
});
