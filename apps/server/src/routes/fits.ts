import { Hono } from 'hono';
import { access, mkdir, readdir, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { storage } from '../services/storage';
import {
  cachedFitsPreview,
  createProcessedFits,
  fitsDerivedDirectory,
  fitsLibraryDirectory,
  fitsPathFor,
  fitsRelativePath,
  fitsUploadDirectory,
  renderFitsTile,
  readFitsMetadata,
  resolveFitsFile,
  type FitsSource,
  type FitsProcessingSettings,
  normalizeUploadedFits,
} from '../services/fits';
import {
  runStackInThread,
  type StackInterpolation,
  StackError,
  type StackMethod,
  type StackNormalization,
  type StackSettings,
  type StackWeighting,
} from '../services/fits-stacking';
import { wcsFromStored } from '../services/wcs';
import { tileInfo } from '../services/tiles';
import { rejectDeclaredOversize, sanitizedUploadFilename, UploadRequestError, writeUploadBody } from '../services/upload-stream';
import { astrometryService } from '../services/astrometry';
import { configService } from '../services/config';
import { defaultImageTags } from '../services/solar-system';
import { handleRouteError } from './route-utils';

const app = new Hono();
const FITS_EXTENSIONS = new Set(['.fit', '.fits', '.fts']);

function textHeader(headers: Record<string, string | number | boolean>, key: string): string | undefined {
  const value = headers[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numericHeader(headers: Record<string, string | number | boolean>, key: string): number | undefined {
  const value = headers[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function captureDate(headers: Record<string, string | number | boolean>): Date | undefined {
  const raw = textHeader(headers, 'DATE-OBS');
  if (!raw) return undefined;
  const parsed = new Date(raw.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function processingSettings(value: unknown): FitsProcessingSettings {
  if (!value || typeof value !== 'object') return {};
  const input = value as Record<string, unknown>;
  const stretch = ['linear', 'asinh', 'log', 'gamma', 'mtf', 'sqrt', 'square'].includes(String(input.stretch)) ? String(input.stretch) as FitsProcessingSettings['stretch'] : undefined;
  const colorMap = ['original', 'grey', 'inverted', 'heat', 'cool', 'rainbow', 'viridis'].includes(String(input.colorMap)) ? String(input.colorMap) as FitsProcessingSettings['colorMap'] : undefined;
  const number = (name: string) => typeof input[name] === 'number' && Number.isFinite(input[name]) ? input[name] as number : undefined;
  return {
    stretch,
    blackPoint: number('blackPoint'),
    whitePoint: number('whitePoint'),
    shadowPercentile: number('shadowPercentile'),
    highlightPercentile: number('highlightPercentile'),
    strength: number('strength'),
    gamma: number('gamma'),
    midtones: number('midtones'),
    saturation: number('saturation'),
    redBalance: number('redBalance'),
    greenBalance: number('greenBalance'),
    blueBalance: number('blueBalance'),
    backgroundNeutralization: input.backgroundNeutralization === true,
    scnrAmount: number('scnrAmount'),
    sharpenAmount: number('sharpenAmount'),
    sharpenRadius: number('sharpenRadius'),
    backgroundExtractionAmount: number('backgroundExtractionAmount'),
    denoiseAmount: number('denoiseAmount'),
    denoiseRadius: number('denoiseRadius'),
    hotPixelThreshold: number('hotPixelThreshold'),
    colorMap,
  };
}

function outputFilename(value: unknown, sourcePath: string): string {
  const extension = (path.extname(sourcePath) || '.fits').toLowerCase();
  const requested = typeof value === 'string' ? value.trim() : '';
  const base = (requested || `${path.basename(sourcePath, path.extname(sourcePath))}-astroviabin`)
    .replace(/\.(fit|fits|fts)$/i, '')
    .replace(/[^a-z0-9._-]+/gi, '_')
    .replace(/^[_ .-]+|[_ .-]+$/g, '');
  if (!base) throw new Error('Choose a valid filename using letters, numbers, spaces, dots, hyphens, or underscores');
  return `${base}${extension}`;
}

async function importFits(filePath: string, root: string, source: FitsSource) {
  const relativePath = path.relative(root, filePath);
  const originalPath = fitsPathFor(relativePath, source);
  const metadata = await readFitsMetadata(filePath);
  const existing = await storage.getAstroImageByOriginalPath(originalPath);
  const title = textHeader(metadata.headers, 'OBJECT') || path.basename(filePath, path.extname(filePath));
  const exposure = numericHeader(metadata.headers, 'EXPTIME') ?? numericHeader(metadata.headers, 'EXPOSURE');
  const focalLength = numericHeader(metadata.headers, 'FOCALLEN');
  const apertureDiameter = numericHeader(metadata.headers, 'APTDIA');
  const derived = source === 'derived';
  // Deep Sky (plate-solvable) unless OBJECT or the file name names a planet, the Sun or the Moon.
  const kind = defaultImageTags(textHeader(metadata.headers, 'OBJECT'), path.basename(filePath, path.extname(filePath)));
  const tags = [...(derived ? ['FITS', 'FITS derived'] : source === 'upload' ? ['FITS', 'FITS uploaded'] : ['FITS']), ...kind];
  const values = {
    title,
    filename: path.basename(filePath),
    originalPath,
    thumbnailUrl: existing ? `/api/fits/${existing.id}/preview` : null,
    fullUrl: existing ? `/api/fits/${existing.id}/preview?stretch=asinh` : null,
    captureDate: captureDate(metadata.headers),
    focalLength,
    aperture: focalLength && apertureDiameter ? `f/${focalLength / apertureDiameter}` : null,
    exposureTime: exposure === undefined ? null : `${exposure}s`,
    telescope: textHeader(metadata.headers, 'TELESCOP') || null,
    camera: textHeader(metadata.headers, 'INSTRUME') || null,
    filters: textHeader(metadata.headers, 'FILTER') || null,
    targetName: textHeader(metadata.headers, 'OBJECT') || null,
    tags,
    description: `FITS ${metadata.width}×${metadata.height} · ${metadata.channels === 3 ? 'RGB' : 'mono'} · ${metadata.bitpix}-bit${derived ? ' · AstroviaBin processed derivative' : ''}`,
  };
  if (existing) return storage.updateAstroImage(existing.id, values);
  const image = await storage.createAstroImage(values);
  await storage.updateAstroImage(image.id, {
    thumbnailUrl: `/api/fits/${image.id}/preview`,
    fullUrl: `/api/fits/${image.id}/preview?stretch=asinh`,
  });
  return storage.getAstroImage(image.id);
}

async function findFitsFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory()) files.push(...await findFitsFiles(candidate));
      else if (entry.isFile() && FITS_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(candidate);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return files;
}

app.get('/', async (c) => {
  try {
    return c.json(await storage.getFitsImages());
  } catch (error) {
    return handleRouteError(c, error, 'Failed to list FITS images');
  }
});

app.post('/scan', async (c) => {
  try {
    const roots = [
      { path: fitsLibraryDirectory(), source: 'source' as const },
      { path: fitsDerivedDirectory(), source: 'derived' as const },
      { path: fitsUploadDirectory(), source: 'upload' as const },
    ];
    let imported = 0;
    let updated = 0;
    const errors: Array<{ file: string; message: string }> = [];
    for (const root of roots) {
      for (const filePath of await findFitsFiles(root.path)) {
        try {
          const before = await storage.getAstroImageByOriginalPath(fitsPathFor(path.relative(root.path, filePath), root.source));
          await importFits(filePath, root.path, root.source);
          if (before) updated++; else imported++;
        } catch (error: unknown) {
          errors.push({ file: path.relative(root.path, filePath), message: error instanceof Error ? error.message : 'Unknown FITS import error' });
        }
      }
    }
    return c.json({ imported, updated, errors });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to scan the FITS library');
  }
});

app.post('/upload', async (c) => {
  let outputPath: string | undefined;
  try {
    rejectDeclaredOversize(c.req.header('content-length'));
    const originalName = sanitizedUploadFilename(c.req.query('filename') || c.req.header('x-file-name'));
    const extension = path.extname(originalName).toLowerCase();
    if (!FITS_EXTENSIONS.has(extension)) return c.json({ message: 'Only .fit, .fits, and .fts files are supported' }, 415);
    const basename = originalName.slice(0, -extension.length).replace(/[^a-z0-9._-]+/gi, '_').replace(/^[_ .-]+|[_ .-]+$/g, '');
    if (!basename) return c.json({ message: 'Invalid FITS filename' }, 400);
    const outputName = `${basename}-${Date.now()}${extension}`;
    outputPath = path.join(fitsUploadDirectory(), outputName);
    await mkdir(fitsUploadDirectory(), { recursive: true });
    await writeUploadBody(c.req.raw.body, outputPath);
    // Extension or tile-compressed FITS (Slooh, fpack) become a standard FITS; the original is kept.
    const normalized = await normalizeUploadedFits(outputPath);
    const image = await importFits(outputPath, fitsUploadDirectory(), 'upload');
    return c.json({ image, output: outputName, normalized }, 201);
  } catch (error) {
    if (outputPath) {
      await rm(outputPath, { force: true }).catch(() => {});
      await rm(`${outputPath}.orig`, { force: true }).catch(() => {});
    }
    if (error instanceof UploadRequestError) return c.json({ message: error.message }, error.status);
    if (error instanceof Error && (error.message.startsWith('Invalid FITS file:') || /^FITS header|^Unsupported FITS/.test(error.message))) {
      return c.json({ message: error.message }, 400);
    }
    return handleRouteError(c, error, 'Failed to upload FITS image');
  }
});

app.get('/:imageId/download', async (c) => {
  try {
    const image = await storage.getAstroImage(Number(c.req.param('imageId')));
    const filePath = resolveFitsFile(image?.originalPath || null);
    if (!image || !filePath) return c.json({ message: 'FITS image not found' }, 404);
    const name = path.basename(image.filename || filePath).replace(/[\r\n"]/g, '_');
    return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, {
      headers: {
        'content-type': 'application/fits',
        'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to download FITS image');
  }
});

app.get('/:imageId/metadata', async (c) => {
  try {
    const image = await storage.getAstroImage(Number(c.req.param('imageId')));
    const filePath = resolveFitsFile(image?.originalPath || null);
    if (!image || !filePath) return c.json({ message: 'FITS image not found' }, 404);
    const metadata = await readFitsMetadata(filePath);
    c.header('cache-control', 'private, no-store');
    return c.json({ ...metadata, cards: undefined, source: fitsRelativePath(image.originalPath) });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to read FITS metadata');
  }
});

app.get('/:imageId/preview', async (c) => {
  try {
    const image = await storage.getAstroImage(Number(c.req.param('imageId')));
    const filePath = resolveFitsFile(image?.originalPath || null);
    if (!image || !filePath) return c.json({ message: 'FITS image not found' }, 404);
    const query = c.req.query();
    const settings = processingSettings({
      stretch: query.stretch,
      blackPoint: query.blackPoint ? Number(query.blackPoint) : undefined,
      whitePoint: query.whitePoint ? Number(query.whitePoint) : undefined,
      shadowPercentile: query.shadowPercentile ? Number(query.shadowPercentile) : undefined,
      highlightPercentile: query.highlightPercentile ? Number(query.highlightPercentile) : undefined,
      strength: query.strength ? Number(query.strength) : undefined,
      gamma: query.gamma ? Number(query.gamma) : undefined,
      midtones: query.midtones ? Number(query.midtones) : undefined,
      saturation: query.saturation ? Number(query.saturation) : undefined,
      redBalance: query.redBalance ? Number(query.redBalance) : undefined,
      greenBalance: query.greenBalance ? Number(query.greenBalance) : undefined,
      blueBalance: query.blueBalance ? Number(query.blueBalance) : undefined,
      // On unless explicitly turned off: a neutral sky is the faithful default for colour FITS.
      backgroundNeutralization: query.backgroundNeutralization !== 'false',
      scnrAmount: query.scnrAmount ? Number(query.scnrAmount) : undefined,
      sharpenAmount: query.sharpenAmount ? Number(query.sharpenAmount) : undefined,
      sharpenRadius: query.sharpenRadius ? Number(query.sharpenRadius) : undefined,
      backgroundExtractionAmount: query.backgroundExtractionAmount ? Number(query.backgroundExtractionAmount) : undefined,
      denoiseAmount: query.denoiseAmount ? Number(query.denoiseAmount) : undefined,
      denoiseRadius: query.denoiseRadius ? Number(query.denoiseRadius) : undefined,
      hotPixelThreshold: query.hotPixelThreshold ? Number(query.hotPixelThreshold) : undefined,
      colorMap: query.colorMap,
    });
    // `full` is the non-tiled fallback; native-resolution viewing goes through /tile. Cap it so a single
    // request cannot allocate gigabytes for a very large frame.
    const fullMaximum = Number(process.env.FITS_FULL_PREVIEW_MAX) > 0 ? Number(process.env.FITS_FULL_PREVIEW_MAX) : 4096;
    const maximumDimension = query.preview === 'interactive' ? 1024 : query.preview === 'full' ? fullMaximum : 2048;
    const preview = await cachedFitsPreview(filePath, settings, maximumDimension);
    const body = preview.buffer.slice(preview.byteOffset, preview.byteOffset + preview.byteLength) as ArrayBuffer;
    return new Response(body, { headers: { 'content-type': 'image/png', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to render FITS preview');
  }
});

// Tiling for the main gallery viewer: always the same default render (matching fullUrl), so
// tiles stay a stable, shareable cache regardless of who's looking. The live-editing processing
// panel keeps using /preview directly — it needs arbitrary settings, which tiling intentionally
// does not support.
const TILE_SOURCE_SETTINGS: FitsProcessingSettings = { stretch: 'asinh', backgroundNeutralization: true };

app.get('/:imageId/tile-info', async (c) => {
  try {
    const image = await storage.getAstroImage(Number(c.req.param('imageId')));
    const filePath = resolveFitsFile(image?.originalPath || null);
    if (!image || !filePath) return c.json({ message: 'FITS image not found' }, 404);
    const metadata = await readFitsMetadata(filePath);
    c.header('cache-control', 'private, no-store');
    return c.json(tileInfo(metadata.width, metadata.height));
  } catch (error) {
    return handleRouteError(c, error, 'Failed to read FITS tile info');
  }
});

app.get('/:imageId/tile', async (c) => {
  try {
    const image = await storage.getAstroImage(Number(c.req.param('imageId')));
    const filePath = resolveFitsFile(image?.originalPath || null);
    if (!image || !filePath) return c.json({ message: 'FITS image not found' }, 404);
    const level = Number(c.req.query('level'));
    const x = Number(c.req.query('x'));
    const y = Number(c.req.query('y'));
    const tile = await renderFitsTile(filePath, TILE_SOURCE_SETTINGS, level, x, y);
    return new Response(new Uint8Array(tile), { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to render FITS tile');
  }
});

app.post('/:imageId/process', async (c) => {
  try {
    const image = await storage.getAstroImage(Number(c.req.param('imageId')));
    const filePath = resolveFitsFile(image?.originalPath || null);
    if (!image || !filePath) return c.json({ message: 'FITS image not found' }, 404);
    const body = await c.req.json();
    const settings = processingSettings(body);
    const outputName = outputFilename(body.outputName, filePath);
    const outputPath = path.join(fitsDerivedDirectory(), outputName);
    try {
      await access(outputPath);
      return c.json({ message: 'A FITS derivative with that name already exists. Choose another name.' }, 409);
    } catch { /* a missing output is expected */ }
    await createProcessedFits(filePath, outputPath, settings);
    const processed = await importFits(outputPath, fitsDerivedDirectory(), 'derived');
    return c.json({ image: processed, output: outputName });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to process FITS image');
  }
});

app.post('/stack', async (c) => {
  try {
    const body = await c.req.json();
    const imageIds = Array.isArray(body.imageIds) ? body.imageIds.map(Number).filter(Number.isFinite) : [];
    if (imageIds.length < 2) return c.json({ message: 'Choose at least two FITS frames to stack' }, 400);
    if (imageIds.length > 50) return c.json({ message: 'Choose 50 or fewer frames per stack' }, 400);

    const images = await Promise.all(imageIds.map((id: number) => storage.getAstroImage(id)));
    const framePaths: string[] = [];
    for (let index = 0; index < images.length; index++) {
      const filePath = resolveFitsFile(images[index]?.originalPath || null);
      if (!images[index] || !filePath) return c.json({ message: `FITS image ${imageIds[index]} not found` }, 404);
      framePaths.push(filePath);
    }

    const method: StackMethod = ['mean', 'median', 'sum', 'sigma-clip'].includes(String(body.method)) ? body.method : 'sigma-clip';
    const number = (name: string, minimum: number, maximum: number): number | undefined => {
      const value = Number(body[name]);
      return Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
    };
    const optionalNumber = (name: string, minimum: number, maximum: number): number | undefined => {
      if (body[name] === '' || body[name] === null || body[name] === undefined) return undefined;
      return number(name, minimum, maximum);
    };
    const choice = <T extends string>(value: unknown, choices: readonly T[], fallback: T): T =>
      choices.includes(value as T) ? value as T : fallback;
    const section = (value: unknown): string | undefined => {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) return undefined;
      if (!/^\[[0-9*,:-]+\]$/.test(text) || text.length > 80) throw new Error('Overscan and trim must use a FITS section such as [1:50,1:2048]');
      return text;
    };
    const calibrationPath = async (value: unknown, label: string): Promise<string | undefined> => {
      if (value === null || value === undefined || value === '' || value === 'none') return undefined;
      const id = Number(value);
      if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid ${label} FITS selection`);
      const image = await storage.getAstroImage(id);
      const filePath = resolveFitsFile(image?.originalPath || null);
      if (!image || !filePath) throw new Error(`${label} FITS is unavailable`);
      return filePath;
    };
    const interpolation = choice<StackInterpolation>(body.interpolation,
      ['nearest-neighbor', 'bilinear', 'biquadratic', 'bicubic'], 'bilinear');
    const normalization = choice<StackNormalization>(body.normalization, ['none', 'exposure', 'median'], 'exposure');
    const weighting = choice<StackWeighting>(body.weighting, ['none', 'exposure', 'inverse-variance'], 'none');
    const cosmicCleanType = choice<NonNullable<StackSettings['cosmicCleanType']>>(body.cosmicCleanType,
      ['median', 'medmask', 'meanmask', 'idw'], 'meanmask');
    const exposureKeyword = typeof body.exposureKeyword === 'string' && /^[A-Z][A-Z0-9_-]{0,7}$/i.test(body.exposureKeyword.trim())
      ? body.exposureKeyword.trim().toUpperCase() : 'EXPTIME';
    const outputName = outputFilename(body.outputName, framePaths[0]);
    const outputPath = path.join(fitsDerivedDirectory(), outputName);
    try {
      await access(outputPath);
      return c.json({ message: 'A FITS derivative with that name already exists. Choose another name.' }, 409);
    } catch { /* a missing output is expected */ }

    // Frames without a WCS in their header can still be aligned through their stored plate solve.
    const frameWcs = await Promise.all(imageIds.map(async (id: number) => {
      const job = await storage.getLatestPlateSolvingJob(id, 'success');
      return wcsFromStored((job?.result as Record<string, unknown> | undefined)?.wcs) ?? null;
    }));
    const frameNames = images.map((image, index) => image?.title ? `${image.title} (#${imageIds[index]})` : `#${imageIds[index]}`);
    const settings: StackSettings = {
      method,
      register: body.register !== false,
      interpolation,
      normalization,
      weighting,
      sigmaClipThreshold: number('sigmaClipThreshold', 0.5, 20),
      sigmaClipLow: number('sigmaClipLow', 0.5, 20),
      sigmaClipHigh: number('sigmaClipHigh', 0.5, 20),
      memoryLimitMb: number('memoryLimitMb', 64, 8192),
      clipExtrema: body.clipExtrema === true,
      clipLowCount: number('clipLowCount', 0, 20),
      clipHighCount: number('clipHighCount', 0, 20),
      minimumClip: optionalNumber('minimumClip', -1e30, 1e30),
      maximumClip: optionalNumber('maximumClip', -1e30, 1e30),
      overscan: section(body.overscan),
      overscanMedian: body.overscanMedian !== false,
      overscanPolynomialDegree: optionalNumber('overscanPolynomialDegree', 0, 10),
      trim: section(body.trim),
      gain: optionalNumber('gain', 0.000001, 1e6),
      readNoise: optionalNumber('readNoise', 0, 1e6),
      flatMinimum: optionalNumber('flatMinimum', 0, 1e30),
      darkScale: body.darkScale !== false,
      calibrationMastersGainCorrected: body.calibrationMastersGainCorrected === true,
      exposureKeyword,
      cosmicMethod: choice(body.cosmicMethod, ['none', 'lacosmic', 'median'] as const, 'none'),
      cosmicSigma: number('cosmicSigma', 1, 100),
      cosmicFraction: number('cosmicFraction', 0.01, 1),
      cosmicObjectLimit: number('cosmicObjectLimit', 0.1, 100),
      cosmicIterations: number('cosmicIterations', 1, 20),
      cosmicCleanType,
      cosmicSeparateMedian: body.cosmicSeparateMedian !== false,
      cosmicFineStructureMode: choice(body.cosmicFineStructureMode, ['median', 'convolve'] as const, 'median'),
      cosmicPsfModel: choice(body.cosmicPsfModel, ['gauss', 'gaussx', 'gaussy', 'moffat'] as const, 'gauss'),
      cosmicPsfFwhm: number('cosmicPsfFwhm', 0.1, 100),
      cosmicPsfSize: number('cosmicPsfSize', 3, 101),
      cosmicPsfBeta: number('cosmicPsfBeta', 0.1, 20),
      saturationLevel: optionalNumber('saturationLevel', 1, 1e30),
      medianCosmicThreshold: number('medianCosmicThreshold', 0.1, 100),
      medianCosmicBox: number('medianCosmicBox', 3, 101),
      medianCosmicGrowBox: number('medianCosmicGrowBox', 0, 101),
      medianCosmicReplaceBox: number('medianCosmicReplaceBox', 0, 101),
      ccdMaskFindBadColumns: body.ccdMaskFindBadColumns === true,
      ccdMaskByBlocks: body.ccdMaskByBlocks === true,
      ccdMaskLowSigma: number('ccdMaskLowSigma', 1, 100),
      ccdMaskHighSigma: number('ccdMaskHighSigma', 1, 100),
      ccdMaskColumnMedian: number('ccdMaskColumnMedian', 1, 101),
      ccdMaskLineMedian: number('ccdMaskLineMedian', 1, 101),
      ccdMaskColumnSigmaBox: number('ccdMaskColumnSigmaBox', 10, 501),
      ccdMaskLineSigmaBox: number('ccdMaskLineSigmaBox', 10, 501),
      ccdMaskGoodPixelGap: number('ccdMaskGoodPixelGap', 0, 100),
      calibration: {
        biasPath: await calibrationPath(body.masterBiasId, 'master bias'),
        darkPath: await calibrationPath(body.masterDarkId, 'master dark'),
        flatPath: await calibrationPath(body.masterFlatId, 'master flat'),
        badPixelMaskPath: await calibrationPath(body.badPixelMaskId, 'bad-pixel mask'),
        ccdMaskRatioPath: await calibrationPath(body.ccdMaskRatioId, 'flat-ratio mask source'),
      },
      frameWcs,
      frameNames,
    };
    const result = await runStackInThread(framePaths, outputPath, settings);
    let stacked = await importFits(outputPath, fitsDerivedDirectory(), 'derived');
    const referenceImage = images[0];
    if (stacked && referenceImage) {
      // The stack shows the reference frame's field: keep its target and tags (e.g. object names).
      const tags = [...new Set([...(stacked.tags ?? []), ...(referenceImage.tags ?? [])].filter(tag => tag !== 'FITS uploaded'))];
      stacked = await storage.updateAstroImage(stacked.id, { tags, targetName: referenceImage.targetName ?? stacked.targetName }) ?? stacked;
      // Solve the stack too (annotations, HOTPANTS) when the reference was solvable.
      if (referenceImage.plateSolved && (await configService.getAstrometryConfig()).enabled) {
        astrometryService.completePlateSolvingWorkflow(stacked).catch(error => console.warn(`Could not queue plate solving for stack ${stacked?.id}:`, error));
      }
    }
    return c.json({ image: stacked, output: outputName, frameCount: result.frameCount, offsets: result.offsets,
      frames: result.frames, warnings: result.warnings, engine: result.engine });
  } catch (error) {
    if (error instanceof StackError) {
      console.error('Failed to stack FITS frames:', error.message);
      return c.json({ message: `Stacking failed: ${error.message}` }, 422);
    }
    return handleRouteError(c, error, 'Failed to stack FITS frames');
  }
});

export default app;
