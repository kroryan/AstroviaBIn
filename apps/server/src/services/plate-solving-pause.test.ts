import { it } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const { storage } = await import('./storage');
const { plateSolvingPaused, setPlateSolvingPaused, requeueFailedForNewStrategy } = await import('./plate-solving-pause');
const { abortLocalSolves, resetLocalSolveAbort, runSolverProcess, SolveAbortedError } = await import('./astrometry-local');
const { isPlateSolvingEligible } = await import('./solar-system');

it('pausing is stored and read back, and resuming clears it', async () => {
  assert.equal(await plateSolvingPaused(), false);
  await setPlateSolvingPaused(true);
  assert.equal(await plateSolvingPaused(), true);
  await setPlateSolvingPaused(false);
  assert.equal(await plateSolvingPaused(), false);
});

it('a pause stops the solver process at once and reports an abort, not a failure', async () => {
  resetLocalSolveAbort();
  const started = Date.now();
  const running = runSolverProcess('sleep', ['30'], 60_000);
  setTimeout(() => abortLocalSolves(), 200);
  await assert.rejects(running, (error: unknown) => error instanceof SolveAbortedError);
  assert.ok(Date.now() - started < 5000, 'stopped within seconds');
  // While paused nothing new starts; after a reset it runs again.
  await assert.rejects(runSolverProcess('true', [], 5000), (error: unknown) => error instanceof SolveAbortedError);
  resetLocalSolveAbort();
  assert.equal(await runSolverProcess('true', [], 5000), '');
});

it('failed Deep Sky jobs are re-queued once for a new solving strategy; planets, solved images and other jobs are left alone', async () => {
  const image = (tags: string[], plateSolved = false) => storage.createAstroImage({ title: 't', filename: 't.fits', tags, plateSolved } as any);
  const job = async (imageId: number, status: string) => storage.createPlateSolvingJob({ imageId, status, result: { error: 'timed out' } } as any);
  const deep = await image(['Deep Sky']);
  const moon = await image(['Moon']);
  const solved = await image(['Deep Sky'], true);
  const failedDeep = await job(deep.id, 'failed');
  const failedMoon = await job(moon.id, 'failed');
  const failedSolved = await job(solved.id, 'failed');
  assert.equal(await requeueFailedForNewStrategy(tags => isPlateSolvingEligible(tags)), 1);
  assert.equal((await storage.getPlateSolvingJob(failedDeep.id))?.status, 'pending');
  assert.equal((await storage.getPlateSolvingJob(failedMoon.id))?.status, 'failed');
  assert.equal((await storage.getPlateSolvingJob(failedSolved.id))?.status, 'failed');
  // Only once per strategy version.
  await storage.updatePlateSolvingJob(failedDeep.id, { status: 'failed' });
  assert.equal(await requeueFailedForNewStrategy(tags => isPlateSolvingEligible(tags)), 0);
});
