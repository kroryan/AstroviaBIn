import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

delete process.env.DATABASE_URL;
process.env.SQLITE_DB_PATH = ':memory:';
const directory = await mkdtemp(path.join(tmpdir(), 'astroviabin-verify-'));
process.env.FITS_ANALYSIS_DIR = directory;
process.env.ASTROVIABIN_ANALYSIS_PYTHON = 'python3';
const { startVerification, stopVerification, getHotpantsReport } = await import('./hotpants');

const RUN = '11111111-2222-3333-4444-555555555555';
const run = path.join(directory, '7', RUN);
const until = async (check: () => Promise<boolean>, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('timed out waiting');
};

it('shows the verification progress and log live, and the stop button really stops it', async () => {
  await mkdir(run, { recursive: true });
  await writeFile(path.join(run, 'report.json'), JSON.stringify({ runId: RUN, imageId: 7, status: 'complete', candidates: [] }));
  // A stand-in for hotpants_report.py: progress, a log line, then a long wait (no time limit applies).
  const script = path.join(directory, 'slow_report.py');
  await writeFile(script, [
    'import sys, time, json',
    'print("PROGRESS " + json.dumps({"percent": 42, "step": "Verified 2 of 5 candidates"}), file=sys.stderr, flush=True)',
    'print("[12:00:00] Gaia DR3 (VizieR I/355): 812 stars in 0.6 s", file=sys.stderr, flush=True)',
    'time.sleep(600)',
  ].join('\n'));
  process.env.HOTPANTS_REPORT_SCRIPT = script;
  assert.deepEqual(await startVerification(7, RUN), { status: 'running' });
  await until(async () => (await getHotpantsReport(7, RUN)).verificationProgress?.percent === 42);
  const running = await getHotpantsReport(7, RUN);
  assert.equal(running.verificationStatus, 'running');
  assert.equal(running.verificationProgress.step, 'Verified 2 of 5 candidates');
  assert.match(running.verificationLog.join('\n'), /812 stars/);
  assert.match(await readFile(path.join(run, 'verification.log'), 'utf8'), /812 stars/);

  assert.equal(stopVerification(7, RUN), true);
  await until(async () => (await getHotpantsReport(7, RUN)).verificationStatus === 'failed');
  const stopped = await getHotpantsReport(7, RUN);
  assert.equal(stopped.verificationError, 'Stopped by the user');
  assert.match(stopped.verificationLog.join('\n'), /812 stars/, 'the log is kept after stopping');
  assert.equal(stopVerification(7, RUN), false, 'nothing left to stop');
  await rm(directory, { recursive: true, force: true });
});
