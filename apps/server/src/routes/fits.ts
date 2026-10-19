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
} from '../services/fits';
import { stackFits, type StackMethod } from '../services/fits-stacking';
import { tileInfo } from '../services/tiles';
import { rejectDeclaredOversize, sanitizedUploadFilename, UploadRequestError, writeUploadBody } from '../services/upload-stream';
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
  const colorMap = ['grey', 'inverted', 'heat', 'cool', 'rainbow', 'viridis'].includes(String(input.colorMap)) ? String(input.colorMap) as FitsProcessingSettings['colorMap'] : undefined;
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
  const tags = derived ? ['FITS', 'FITS derived', 'Deep Sky'] : source === 'upload' ? ['FITS', 'FITS uploaded', 'Deep Sky'] : ['FITS', 'Deep Sky'];
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
    const image = await importFits(outputPath, fitsUploadDirectory(), 'upload');
    return c.json({ image, output: outputName }, 201);
  } catch (error) {
    if (outputPath) await rm(outputPath, { force: true }).catch(() => {});
    if (error instanceof UploadRequestError) return c.json({ message: error.message }, error.status);
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
      backgroundNeutralization: query.backgroundNeutralization === 'true',
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
const TILE_SOURCE_SETTINGS: FitsProcessingSettings = { stretch: 'asinh' };

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

    const method: StackMethod = ['mean', 'median', 'sigma-clip'].includes(String(body.method)) ? body.method : 'sigma-clip';
    const sigmaClipThreshold = typeof body.sigmaClipThreshold === 'number' && Number.isFinite(body.sigmaClipThreshold) ? body.sigmaClipThreshold : undefined;
    const register = body.register !== false;
    const outputName = outputFilename(body.outputName, framePaths[0]);
    const outputPath = path.join(fitsDerivedDirectory(), outputName);
    try {
      await access(outputPath);
      return c.json({ message: 'A FITS derivative with that name already exists. Choose another name.' }, 409);
    } catch { /* a missing output is expected */ }

    const result = await stackFits(framePaths, outputPath, { method, sigmaClipThreshold, register });
    const stacked = await importFits(outputPath, fitsDerivedDirectory(), 'derived');
    return c.json({ image: stacked, output: outputName, frameCount: result.frameCount, offsets: result.offsets });
  } catch (error) {
    return handleRouteError(c, error, 'Failed to stack FITS frames');
  }
});

export default app;
