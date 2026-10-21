import { it } from 'node:test';
import assert from 'node:assert/strict';
delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const { clusterFields, fieldSizeDegrees, classifyGallery, SOLAR_SYSTEM_CATALOG, AUTO_DESCRIPTION } = await import('./gallery-auto-classify');
const { storage } = await import('./storage');

const field = (id: number, ra: number, dec: number, size: number, target: string | null = null) =>
  ({ id, ra, dec, size, target, constellation: null });

it('reads field sizes in arcminutes, degrees and arcseconds', () => {
  assert.equal(fieldSizeDegrees("29.8' × 29.8'"), 29.8 / 60);
  assert.equal(fieldSizeDegrees("119.1' × 79.5'"), 119.1 / 60);
  assert.equal(fieldSizeDegrees('1.5° × 1°'), 1.5);
  assert.equal(fieldSizeDegrees(null), null);
});

it('groups overlapping solutions and the same target, keeps different fields apart', () => {
  const groups = clusterFields([
    // Pleiades at two scales (106′ and 32′), 0.13° apart.
    field(27, 56.875, 24.16, 106.4 / 60, 'IC 349'), field(46, 56.734, 24.125, 32 / 60, 'IC 349'),
    // M42: a mosaic panel 0.67° from the others, joined by its identified target.
    field(10, 84.232, -4.904, 43.3 / 60, 'NGC 1976'), field(63, 83.841, -5.456, 32 / 60, 'NGC 1976'), field(64, 83.841, -5.454, 32 / 60, 'NGC 1976'),
    // Running Man: overlaps nothing above and is a different target.
    field(9, 83.834, -4.752, 106.5 / 60, 'NGC 1973'),
    // Two solutions of an unidentified field.
    field(23, 75.633, 41.141, 17.3 / 60), field(24, 75.643, 41.152, 17.3 / 60),
    // A lone field.
    field(14, 116.349, 28.074, 17.4 / 60),
  ]).map(group => group.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(groups, [[9], [10, 63, 64], [14], [23, 24], [27, 46]]);
});

it('classifies the gallery: Solar System, fields into new or existing catalogs, loose singletons, manual choices kept', async () => {
  const solved = (title: string, ra: number, dec: number, fov: string, targetName: string | null, tags = ['Deep Sky']) =>
    storage.createAstroImage({ title, filename: `${title}.fits`, plateSolved: true, ra: String(ra), dec: String(dec), fieldOfView: fov, targetName, tags } as any);
  const saturn = await storage.createAstroImage({ title: 'Saturn', filename: 'saturn.png', tags: ['Saturn'] } as any);
  const sun = await storage.createAstroImage({ title: 'Sun', filename: 'sun.png', tags: ['Sun'] } as any);
  const helixA = await solved('NGC 7293.png', 337.399, -20.81, "32.1' × 32.0'", 'NGC 7293');
  const helixB = await solved('NGC 7293 2.png', 337.384, -20.791, "32.1' × 32.0'", 'NGC 7293');
  const crabA = await solved('crab-a', 83.783, 21.997, "56.2' × 43.2'", 'NGC 1952');
  const crabB = await solved('crab-b', 83.65, 22.06, "36.5' × 36.4'", 'NGC 1952');
  const lonely = await solved('lonely', 116.349, 28.074, "17.4' × 11.8'", null);
  const unsolved = await storage.createAstroImage({ title: 'new upload', filename: 'new.png', tags: ['Deep Sky'] } as any);
  // The user already filed one Crab image in their own catalog.
  const mine = await storage.createGalleryCatalog({ name: 'Nebula del cangrejo' });
  await storage.addImagesToGalleryCatalog(mine.id, [crabA.id]);

  const result = await classifyGallery();
  assert.equal(result.added, 6); // Saturn, Sun, both Helix images, the second Crab image, the lone field
  const catalogs = await storage.getGalleryCatalogs();
  const byName = (name: string) => catalogs.find(catalog => catalog.name === name);
  assert.deepEqual(byName(SOLAR_SYSTEM_CATALOG)?.imageIds.sort(), [saturn.id, sun.id].sort());
  assert.deepEqual(byName('NGC 7293')?.imageIds.sort(), [helixA.id, helixB.id].sort());
  assert.equal(byName('NGC 7293')?.description, AUTO_DESCRIPTION);
  assert.deepEqual(byName('Nebula del cangrejo')?.imageIds.sort(), [crabA.id, crabB.id].sort());
  const filed = new Set(catalogs.flatMap(catalog => catalog.imageIds));
  assert.deepEqual(byName('lonely')?.imageIds, [lonely.id], 'a field seen once gets its own catalog, named after its title');
  assert.ok(!filed.has(unsolved.id), 'unsolved images stay loose until classified');
  // A later image of that field joins its catalog.
  const lonelyAgain = await solved('polux 2.png', 116.35, 28.075, "17.4' × 11.8'", null);
  assert.deepEqual(await classifyGallery({ imageId: lonelyAgain.id }), { added: 1, created: [], renamed: [] });

  // Taking an image out by hand is respected by later single-image runs for other images.
  await storage.removeImageFromGalleryCatalog(byName('NGC 7293')!.id, helixB.id);
  const helixC = await solved('NGC 7293 3.png', 337.39, -20.8, "32.1' × 32.0'", 'NGC 7293');
  assert.deepEqual(await classifyGallery({ imageId: helixC.id }), { added: 1, created: [], renamed: [] });
  const after = (await storage.getGalleryCatalogs()).find(catalog => catalog.name === 'NGC 7293')!;
  assert.deepEqual(after.imageIds.sort(), [helixA.id, helixC.id].sort());
});

it('names catalogs after a descriptive title unless a title names the identified target', async () => {
  const { descriptiveTitle, titleReferencesTarget } = await import('./gallery-auto-classify');
  assert.equal(descriptiveTitle('Tau Canis Majoris'), 'Tau Canis Majoris');
  assert.equal(descriptiveTitle('Pallas (2 Pallas)  canarias.png'), 'Pallas (2 Pallas)');
  assert.equal(descriptiveTitle('Niño (Zeta Aurigae)  2.png'), 'Niño (Zeta Aurigae)');
  assert.equal(descriptiveTitle('36489F003_cntrst3.jpg'), null);
  assert.equal(descriptiveTitle('TauCanisMajo261019115041.GIF'), null);
  assert.equal(descriptiveTitle('Coordenadas celestes - RA 3.339 Dec 35.23 CYT133.png'), null);
  assert.equal(descriptiveTitle('Pegasus', 'Pegasus'), null);
  assert.equal(descriptiveTitle('R Aquarii (HIP 117054) .png'), 'R Aquarii (HIP 117054)');
  assert.equal(descriptiveTitle('Eris (136199 Eris) .png'), 'Eris (136199 Eris)');
  assert.ok(titleReferencesTarget('messier51.png', 'NGC 5194', 'M 51'));
  assert.ok(titleReferencesTarget('Galaxia de diseño grandioso (M74) .png', 'NGC 628', 'M 74'));
  assert.ok(titleReferencesTarget('IC153.png', 'IC 153'));
  assert.ok(!titleReferencesTarget('Pallas (2 Pallas)', 'IC 86'));
});

it('places spectroscopy FITS by their header position: inside a solved field, with the same star, or alone', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { spectrumPosition } = await import('./gallery-auto-classify');
  const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-spectra-'));
  const previous = process.env.FITS_UPLOAD_DIR;
  process.env.FITS_UPLOAD_DIR = directory;
  const card = (key: string, value?: string) => (value === undefined ? key : `${key.padEnd(8, ' ')}= ${value}`).padEnd(80, ' ').slice(0, 80);
  const spectrumFits = (cards: string[]) => {
    const header = Buffer.from([card('SIMPLE', 'T'), card('BITPIX', '-32'), card('NAXIS', '2'), card('NAXIS1', '4'), card('NAXIS2', '1'), ...cards, card('END')].join(''), 'ascii');
    return Buffer.concat([header, Buffer.alloc(2880 - header.length, ' '), Buffer.alloc(2880)]);
  };
  try {
    // SDSS: RA/DEC is the plate centre, PLUG_RA/PLUG_DEC the fibre on the star.
    assert.deepEqual(spectrumPosition({ RA: 40.9, DEC: 0, PLUG_RA: 40.3934, PLUG_DEC: -1.017 }), { ra: 40.3934, dec: -1.017 });
    assert.deepEqual(spectrumPosition({ OBJCTRA: '10 00 00', OBJCTDEC: '+45 00 00' }), { ra: 150, dec: 45 });
    assert.equal(spectrumPosition({ OBJECT: 'no position' }), null);

    const spectrum = async (name: string, cards: string[]) => {
      await writeFile(path.join(directory, name), spectrumFits(cards));
      return storage.createAstroImage({ title: name, filename: name, originalPath: `fits-upload://${name}`, tags: ['FITS', 'Spectrum', '1-D spectrum'] } as any);
    };
    const inField = await spectrum('pollux-spec.fits', [card('PLUG_RA', '116.36'), card('PLUG_DEC', '28.07')]);
    const alone = await spectrum('far-star.fits', [card('OBJCTRA', "'10 00 00'"), card('OBJCTDEC', "'+45 00 00'")]);
    const sameStar = await spectrum('far-star-2.fits', [card('RA', '150.001'), card('DEC', '45.001')]);
    const noPosition = await spectrum('unknown.fits', []);

    await classifyGallery({ imageId: inField.id });
    await classifyGallery({ imageId: alone.id });
    await classifyGallery({ imageId: sameStar.id });
    await classifyGallery({ imageId: noPosition.id });
    const catalogs = await storage.getGalleryCatalogs();
    const of = (id: number) => catalogs.filter(catalog => catalog.imageIds.includes(id)).map(catalog => catalog.name);
    assert.deepEqual(of(inField.id), ['lonely'], 'a spectrum inside a solved field joins that field');
    assert.equal(of(alone.id).length, 1);
    assert.deepEqual(of(sameStar.id), of(alone.id), 'two spectra of the same star share a catalog');
    assert.notDeepEqual(of(alone.id), ['lonely']);
    assert.deepEqual(of(noPosition.id), [], 'without a header position a spectrum stays loose');

    // Later arrivals near the spectrum: another spectrum 5' away and a plate-solved image of that field.
    const near = await spectrum('far-star-3.fits', [card('RA', '150.08'), card('DEC', '45.03')]);
    await classifyGallery({ imageId: near.id });
    const solvedLater = await storage.createAstroImage({ title: 'field 10h', filename: 'field.fits', plateSolved: true, ra: '150.02', dec: '45.01', fieldOfView: "40' × 30'", targetName: null, tags: ['Deep Sky'] } as any);
    await classifyGallery({ imageId: solvedLater.id });
    const now = await storage.getGalleryCatalogs();
    const in_ = (id: number) => now.filter(catalog => catalog.imageIds.includes(id)).map(catalog => catalog.name);
    assert.deepEqual(in_(near.id), in_(alone.id), 'a nearby spectrum joins the same album');
    assert.deepEqual(in_(solvedLater.id), in_(alone.id), 'an image solved later in that area joins the spectrum album');
  } finally {
    if (previous === undefined) delete process.env.FITS_UPLOAD_DIR; else process.env.FITS_UPLOAD_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
