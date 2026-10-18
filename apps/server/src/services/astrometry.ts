import { randomUUID } from 'node:crypto';
import { storage } from './storage';
import { xmpSidecarService } from './xmp-sidecar';
import { configService } from './config';
import { getConstellationFromCoordinates } from './constellation-utils';
import { filterRelevantTags } from './tags-utils';
import { catalogService } from './catalog';
import { solveImageLocally, type SolveHint } from './astrometry-local';
import type { WcsSolution } from './wcs';

import type { WsManager } from './ws-manager';

let wsManager: WsManager | null = null;

export function setWsManager(wm: WsManager | null) {
  wsManager = wm;
}

export interface AstrometryCalibration {
  ra: number;
  dec: number;
  pixscale: number;
  radius: number;
  orientation: number;
  width_arcsec?: number;
  height_arcsec?: number;
  parity?: number;
}

export interface AstrometryAnnotation {
  type: string;
  names: string[];
  pixelx: number;
  pixely: number;
  radius?: number;
  ra?: number;
  dec?: number;
  vmag?: number;
  /** OpenNGC object class (G, PN, OCl, ...). */
  objectType?: string;
  pixelX?: number;
  pixelY?: number;
}

export interface PlateSolvingResult {
  calibration: AstrometryCalibration;
  annotations: AstrometryAnnotation[];
  machineTags: string[];
  /** Full solution (TAN + SIP) for local solves; annotations are recomputed from it on demand. */
  wcs?: WcsSolution;
}

/** Stored job payload while a job is queued: carries the optional user hint to the worker. */
function hintFromStoredJob(result: unknown): SolveHint | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const hint = (result as { hint?: SolveHint }).hint;
  if (!hint || !Number.isFinite(hint.ra) || !Number.isFinite(hint.dec)) return undefined;
  return hint;
}

export type PlateSolvingPollOutcome =
  | { status: 'success'; result: PlateSolvingResult; remoteJobId: string }
  | { status: 'failed'; error: string; remoteJobId: string | null }
  | { status: 'processing'; remoteJobId: string | null };
export type PlateSolvingWorkflowOutcome =
  | { status: 'success'; result: PlateSolvingResult }
  | { status: 'processing'; jobId: number; submissionId: string;
      message: string };

type SolvableImage = {
  id: number;
  libraryAssetId?: number | null;
  fullUrl?: string | null;
  originalPath?: string | null;
  title?: string | null;
  filename?: string | null;
  updatedAt?: Date | string | null;
  tags?: string[] | null;
};

function resultFromStoredJob(result: unknown): PlateSolvingResult | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const value = result as Record<string, unknown>;
  const calibration = {
    ra: Number(value.ra),
    dec: Number(value.dec),
    pixscale: Number(value.pixscale),
    radius: Number(value.radius),
    orientation: Number(value.orientation),
    ...(typeof value.width_arcsec === 'number' ? { width_arcsec: value.width_arcsec } : {}),
    ...(typeof value.height_arcsec === 'number' ? { height_arcsec: value.height_arcsec } : {}),
    ...(typeof value.parity === 'number' ? { parity: value.parity } : {}),
  };
  if (![calibration.ra, calibration.dec, calibration.pixscale, calibration.radius, calibration.orientation].every(Number.isFinite)) return undefined;
  return {
    calibration,
    annotations: Array.isArray(value.annotations) ? value.annotations as AstrometryAnnotation[] : [],
    machineTags: [],
    ...(value.wcs && typeof value.wcs === 'object' ? { wcs: value.wcs as WcsSolution } : {}),
  };
}

export class AstrometryService {
  private readonly localSubmissionJobs = new Map<string, number>();
  private readonly activeSolves = new Set<number>();

  constructor(_useConfigService: boolean = true) {}

  async submitImageForPlateSolving(image: SolvableImage, hint?: SolveHint): Promise<{ submissionId: string; jobId: number }> {
    if (!image.libraryAssetId && !image.originalPath?.startsWith('fits://') &&
        !image.originalPath?.startsWith('fits-derived://') && !image.originalPath?.startsWith('fits-upload://')) {
      throw new Error('This image has no private local source available for plate solving');
    }

    const submissionId = `local-${randomUUID()}`;
    const job = await storage.createPlateSolvingJob({
      imageId: image.id,
      astrometrySubmissionId: submissionId,
      astrometryJobId: null,
      status: 'processing',
      result: hint ? { hint } : null,
    });
    this.localSubmissionJobs.set(submissionId, job.id);
    if (wsManager) wsManager.broadcast('plate-solving-update', {
      jobId: job.id,
      status: 'processing',
      imageId: image.id,
      message: 'Image queued for private local plate solving',
    });
    return { submissionId, jobId: job.id };
  }

  async pollForPlateSolvingResult(
    submissionId: string,
    onJobId?: (localJobId: string) => Promise<void>,
  ): Promise<PlateSolvingPollOutcome> {
    const jobId = this.localSubmissionJobs.get(submissionId) ?? Number(submissionId.match(/^local-(\d+)$/)?.[1]);
    if (!Number.isSafeInteger(jobId) || jobId <= 0) return {
      status: 'failed', error: 'Local plate-solving job was not found', remoteJobId: null,
    };
    const localJobId = `local-${jobId}`;
    await onJobId?.(localJobId);
    const result = await this.checkJobStatus(jobId);
    if (result.status === 'success' && result.result) return { status: 'success', result: result.result, remoteJobId: localJobId };
    if (result.status === 'processing') return { status: 'processing', remoteJobId: localJobId };
    return { status: 'failed', error: 'Local plate solving failed', remoteJobId: localJobId };
  }

  async fetchCompleteResult(jobId: string): Promise<PlateSolvingResult> {
    const localId = Number(jobId.match(/^local-(\d+)$/)?.[1]);
    const job = Number.isSafeInteger(localId) && localId > 0
      ? await storage.getPlateSolvingJob(localId)
      : await storage.getPlateSolvingJobByAstrometryId(jobId);
    if (!job?.imageId) throw new Error('Local plate-solving job or image was not found');
    const image = await storage.getAstroImage(job.imageId);
    if (!image) throw new Error('Image not found for local plate solving');
    return solveImageLocally(image);
  }

  async updateJobAndImage(jobId: number, result: PlateSolvingResult): Promise<void> {
    const job = await storage.getPlateSolvingJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    const localJobId = `local-${job.id}`;
    await storage.updatePlateSolvingJob(job.id, {
      status: 'success',
      astrometrySubmissionId: job.astrometrySubmissionId?.startsWith('local-') ? job.astrometrySubmissionId : localJobId,
      astrometryJobId: localJobId,
      result: { ...result.calibration, annotations: result.annotations, ...(result.wcs ? { wcs: result.wcs } : {}) } as any,
    });

    if (job.imageId === null) return;
    const image = await storage.getAstroImage(job.imageId);
    if (!image) return;
    const allTags = Array.from(new Set([
      ...(image.tags || []),
      ...filterRelevantTags(result.machineTags),
    ])).filter(Boolean);
    const constellation = getConstellationFromCoordinates(result.calibration.ra, result.calibration.dec);
    const widthArcsec = result.calibration.width_arcsec ?? result.calibration.radius * 3600 * Math.SQRT2;
    const heightArcsec = result.calibration.height_arcsec ?? result.calibration.radius * 3600 * Math.SQRT2;
    await storage.updateAstroImage(image.id, {
      plateSolved: true,
      ra: result.calibration.ra.toString(),
      dec: result.calibration.dec.toString(),
      pixelScale: result.calibration.pixscale,
      fieldOfView: `${(widthArcsec / 60).toFixed(1)}' × ${(heightArcsec / 60).toFixed(1)}'`,
      rotation: result.calibration.orientation,
      astrometryJobId: localJobId,
      constellation,
      tags: allTags as any,
    });

    try {
      const target = await catalogService.matchTargetAtCoordinates(
        result.calibration.ra,
        result.calibration.dec,
        result.calibration.radius,
        [image.title, image.filename, ...allTags],
      );
      if (target) await storage.updateAstroImage(image.id, { targetName: target.name } as any);
    } catch (error) {
      console.error(`Failed to identify the catalog target for image ${image.id}:`, error);
    }

    try {
      const sidecarConfig = await configService.getSidecarConfig();
      if (sidecarConfig.enabled) {
        const equipment = await storage.getEquipmentForImage(image.id);
        await xmpSidecarService.writeSidecar(image, result, localJobId, equipment, sidecarConfig);
      }
    } catch (error) {
      console.error(`Failed to write XMP sidecar for image ${image.id}:`, error);
    }

    if (wsManager) wsManager.broadcast('plate-solving-update', {
      jobId: job.id,
      status: 'success',
      imageId: image.id,
      result: { ...result.calibration, annotations: result.annotations },
    });
  }

  async completePlateSolvingWorkflow(image: SolvableImage, hint?: SolveHint): Promise<PlateSolvingWorkflowOutcome> {
    const { jobId, submissionId } = await this.submitImageForPlateSolving(image, hint);
    return {
      status: 'processing',
      jobId,
      submissionId,
      message: 'Queued for private local solving. This can take several minutes for large images.',
    };
  }

  async checkJobStatus(jobId: number, options?: { resumeProcessing?: boolean }): Promise<{ status: string; result?: PlateSolvingResult }> {
    const job = await storage.getPlateSolvingJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    const existingResult = resultFromStoredJob(job.result);
    if (job.status === 'success' && existingResult) return { status: 'success', result: existingResult };
    if (job.status === 'failed' && !options?.resumeProcessing) return { status: 'failed', result: existingResult };
    if (!job.imageId) throw new Error('Local plate-solving job has no image');
    const image = await storage.getAstroImage(job.imageId);
    if (!image) throw new Error('Image not found for local plate solving');

    // The worker polls every few seconds; never run two solves of the same job in this process.
    if (this.activeSolves.has(job.id)) return { status: 'processing' };
    this.activeSolves.add(job.id);
    try {
      const result = await solveImageLocally(image, { hint: hintFromStoredJob(job.result) });
      await this.updateJobAndImage(job.id, result);
      return { status: 'success', result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown local plate-solving error';
      const localJobId = `local-${job.id}`;
      await storage.updatePlateSolvingJob(job.id, {
        status: 'failed',
        astrometrySubmissionId: job.astrometrySubmissionId?.startsWith('local-') ? job.astrometrySubmissionId : localJobId,
        astrometryJobId: localJobId,
        result: { error: message },
      });
      if (wsManager) wsManager.broadcast('plate-solving-update', {
        jobId: job.id,
        status: 'failed',
        imageId: job.imageId,
        result: { error: message },
      });
      return { status: 'failed', result: { error: message } as unknown as PlateSolvingResult };
    } finally {
      this.activeSolves.delete(job.id);
    }
  }
}

export const astrometryService = new AstrometryService();
