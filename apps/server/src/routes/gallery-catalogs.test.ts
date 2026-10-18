import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const { default: catalogRoutes } = await import('./gallery-catalogs');
const { default: imageRoutes } = await import('./images');
const { storage } = await import('../services/storage');

const app = new Hono().route('/api/gallery-catalogs', catalogRoutes).route('/api/images', imageRoutes);
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

it('creates catalogs, groups photos and FITS, filters the gallery and removes only the grouping', async () => {
  const photo = await storage.createAstroImage({ title: 'Andromeda', filename: 'm31.jpg', tags: ['Deep Sky'] } as any);
  const fits = await storage.createAstroImage({ title: 'M42 FITS', filename: 'm42.fits', originalPath: 'fits://m42.fits', tags: ['FITS'] } as any);
  const other = await storage.createAstroImage({ title: 'Moon', filename: 'moon.jpg', tags: ['Moon'] } as any);

  const created = await app.request('/api/gallery-catalogs', json({ name: 'Messier marathon', description: 'Spring 2026' }));
  assert.equal(created.status, 201);
  const catalog = await created.json() as { id: number; name: string };
  assert.equal((await app.request('/api/gallery-catalogs', json({ name: 'messier MARATHON' }))).status, 409);

  const added = await app.request(`/api/gallery-catalogs/${catalog.id}/images`, json({ imageIds: [photo.id, fits.id, fits.id] }));
  assert.deepEqual(await added.json(), { added: 2 });

  const listed = await (await app.request('/api/gallery-catalogs')).json() as Array<{ id: number; imageCount: number }>;
  assert.equal(listed.find(item => item.id === catalog.id)?.imageCount, 2);

  const filtered = await (await app.request(`/api/images?galleryCatalogId=${catalog.id}`)).json() as Array<{ id: number }>;
  assert.deepEqual(filtered.map(image => image.id).sort(), [photo.id, fits.id].sort());
  assert.ok(!filtered.some(image => image.id === other.id));

  assert.deepEqual(await (await app.request(`/api/images/${fits.id}/gallery-catalogs`)).json(), [catalog.id]);

  assert.equal((await app.request(`/api/gallery-catalogs/${catalog.id}/images/${fits.id}`, { method: 'DELETE' })).status, 204);
  assert.deepEqual(await (await app.request(`/api/images/${fits.id}/gallery-catalogs`)).json(), []);

  const renamed = await app.request(`/api/gallery-catalogs/${catalog.id}`, { ...json({ name: 'Best of 2026' }), method: 'PATCH' });
  assert.equal((await renamed.json() as { name: string }).name, 'Best of 2026');

  assert.equal((await app.request(`/api/gallery-catalogs/${catalog.id}`, { method: 'DELETE' })).status, 204);
  assert.ok(await storage.getAstroImage(photo.id), 'deleting a catalog keeps its images');
});

it('validates catalog names', async () => {
  const response = await app.request('/api/gallery-catalogs', json({ name: '   ' }));
  assert.equal(response.status, 400);
});
