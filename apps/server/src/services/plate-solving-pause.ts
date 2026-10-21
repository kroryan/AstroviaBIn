import { storage } from './storage';

/**
 * "Pause plate solving": kept as its own admin setting row and read from the database each time (the
 * worker is a separate process with its own config cache). While paused the worker takes no job and
 * stops the solve in progress, which goes back to the queue.
 */
const KEY = 'plateSolvingPaused';

export async function plateSolvingPaused(): Promise<boolean> {
  const value = (await storage.getAdminSettings())[KEY] as { paused?: boolean } | undefined;
  return value?.paused === true;
}

export async function setPlateSolvingPaused(paused: boolean): Promise<void> {
  await storage.updateAdminSettings({ [KEY]: { paused, changedAt: new Date().toISOString() } });
}

/**
 * Bump when the local solving strategy improves: failed Deep Sky jobs of unsolved images are queued
 * again once (with their stored hints), so they get the new attempts without anyone resubmitting them.
 * 2: hinted attempts also use solve-field's own source extraction.
 * 3: frames too sparse to solve get the WCS of a solved frame of the same pointing (astroalign).
 */
export const SOLVING_STRATEGY_VERSION = 3;

export async function requeueFailedForNewStrategy(eligible: (tags: string[] | null | undefined) => boolean): Promise<number> {
  const settings = await storage.getAdminSettings();
  const done = (settings.plateSolvingStrategy as { version?: number } | undefined)?.version ?? 1;
  if (done >= SOLVING_STRATEGY_VERSION) return 0;
  const images = new Map((await storage.getAstroImages()).map(image => [image.id, image]));
  let requeued = 0;
  for (const job of await storage.getPlateSolvingJobs()) {
    const image = job.imageId === null ? undefined : images.get(job.imageId);
    if (job.status !== 'failed' || !image || image.plateSolved || !eligible(image.tags)) continue;
    await storage.updatePlateSolvingJob(job.id, { status: 'pending' });
    requeued++;
  }
  await storage.updateAdminSettings({ plateSolvingStrategy: { version: SOLVING_STRATEGY_VERSION, requeued, at: new Date().toISOString() } });
  return requeued;
}
