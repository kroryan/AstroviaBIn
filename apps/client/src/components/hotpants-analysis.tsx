import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AstroImage } from '@shared/schema';

type Candidate = { x: number; y: number; ra: number; dec: number; snr: number; status: string;
  centroidX?: number; centroidY?: number; ringRadiusPx?: number;
  scienceContrast?: number; shape?: { sharpness: number; roundness: number };
  nearbyCatalogObjects?: { name: string; separationArcsec: number }[];
  knownObject?: { name: string; class?: string; vmag?: number | null; separationArcsec: number } };
type SolarSystemObject = { name: string; class?: string; vmag?: number | null; x: number; y: number; ra: number; dec: number };
type CandidateCheck = { status: 'repeat_detection' | 'not_detected' | 'inconclusive'; sourceFound: boolean;
  followupImageId: number; followupFilter?: string | null; followupDate?: string | null;
  comparableFilter: boolean; independentEpoch: boolean; checkedAt: string; note: string };
type Report = {
  runId: string; status: string; startedAt: string; completedAt?: string;
  progress?: { stage: string }; error?: string; width?: number; height?: number;
  coverage?: number; detectedTotal?: number; candidates?: Candidate[];
  analysisVersion?: number; sourceFilter?: string; comparisonWarning?: string;
  rejectedCandidates?: Record<string, number>;
  candidateChecks?: Record<string, CandidateCheck>;
  files?: string[]; reference?: { survey?: string; localImageId?: number; autoSelection?: { band: string; reason: string; skipped: string[] } }; catalogCheck?: string;
  settings?: { thresholdSigma: number; maxDimension: number; sourceFwhm?: number };
  solarSystemObjects?: SolarSystemObject[]; solarSystemCheck?: string;
  brightStarMaskFraction?: number;
  cosmicRayPixels?: number | null;
  registration?: { matchedStars?: number; rmsBeforePx?: number; rmsAfterPx?: number; maxCorrectionPx?: number; applied?: boolean; note?: string };
  autoSettings?: { fwhmSciencePx?: number | null; fwhmReferencePx?: number | null; detectionFwhmPx?: number; hotpantsArgs?: string[] };
};

async function jsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `Request failed (${response.status})`);
  }
  return response.json();
}

export function HotpantsAnalysis({ image }: { image: AstroImage }) {
  const client = useQueryClient();
  const [referenceMode, setReferenceMode] = useState<'survey' | 'local'>('survey');
  const [referenceImageId, setReferenceImageId] = useState('');
  const [followupImageId, setFollowupImageId] = useState('');
  const [survey, setSurvey] = useState('Auto');
  const [maxDimension, setMaxDimension] = useState(2048);
  const [thresholdSigma, setThresholdSigma] = useState(6);
  // Empty = measured from the image.
  const [sourceFwhm, setSourceFwhm] = useState('');
  const [hotpantsOptions, setHotpantsOptions] = useState('');
  const [attachmentError, setAttachmentError] = useState('');
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const base = `/api/fits/${image.id}`;
  const reports = useQuery<Report[]>({
    queryKey: [base, 'analyses'],
    queryFn: () => fetch(`${base}/analyses`).then(jsonResponse<Report[]>),
    enabled: expanded,
    refetchInterval: 4000,
  });
  const availableFits = useQuery<AstroImage[]>({
    queryKey: ['/api/fits'],
    queryFn: () => fetch('/api/fits').then(jsonResponse<AstroImage[]>),
    enabled: expanded,
  });
  const inputs = useQuery<string[]>({
    queryKey: [base, 'analysis-inputs'],
    queryFn: () => fetch(`${base}/analysis-inputs`).then(jsonResponse<string[]>),
    enabled: expanded,
  });
  const start = useMutation({
    mutationFn: () => fetch(`${base}/analyses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ referenceMode, referenceImageId: referenceMode === 'local' ? Number(referenceImageId) : undefined,
        survey, maxDimension, thresholdSigma, sourceFwhm: sourceFwhm.trim() ? Number(sourceFwhm) : null, maxCandidates: 100, hotpantsOptions }),
    }).then(jsonResponse<Report>),
    onSuccess: report => { setActiveRun(report.runId); client.invalidateQueries({ queryKey: [base, 'analyses'] }); },
  });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const response = await fetch(`${base}/analysis-inputs?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
      });
      return jsonResponse<{ filename: string }>(response);
    },
    onSuccess: () => { setAttachmentError(''); client.invalidateQueries({ queryKey: [base, 'analysis-inputs'] }); },
    onError: error => setAttachmentError(error.message),
  });
  const report = reports.data?.find(item => item.runId === activeRun) || reports.data?.[0];
  const file = (name: string, preview = false) => `${base}/analyses/${report?.runId}/files/${name}${preview ? '?preview=1' : ''}`;
  const utility = useMutation({
    mutationFn: (request: Record<string, unknown>) => fetch(`${base}/analyses/${report?.runId}/utilities`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    }).then(jsonResponse<{ filename: string }>),
    onSuccess: () => client.invalidateQueries({ queryKey: [base, 'analyses'] }),
  });
  const removeReport = useMutation({
    mutationFn: async (runId: string) => {
      const response = await fetch(`${base}/analyses/${runId}`, { method: 'DELETE' });
      if (!response.ok) await jsonResponse(response);
    },
    onSuccess: () => { setActiveRun(null); client.invalidateQueries({ queryKey: [base, 'analyses'] }); },
  });
  const checkCandidate = useMutation({
    mutationFn: (index: number) => fetch(`${base}/analyses/${report?.runId}/candidates/${index}/check`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ followupImageId: Number(followupImageId) }),
    }).then(jsonResponse<CandidateCheck>),
    onSuccess: () => client.invalidateQueries({ queryKey: [base, 'analyses'] }),
  });

  return <details className="mt-3 rounded-xl border border-border bg-muted/20 p-4" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer font-semibold text-foreground">HOTPANTS · compare FITS and find new-object candidates</summary>
    <div className="mt-4 space-y-4">
    <div>
      <p className="text-sm text-muted-foreground">Local plate solving, reference alignment, image subtraction and unconfirmed transient candidates. Your FITS is never uploaded to an external astrometry service; automatic reference lookup sends sky coordinates only.</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm space-y-1">Reference source
        <select className="w-full rounded-md border bg-background p-2" value={referenceMode} onChange={event => setReferenceMode(event.target.value as 'survey' | 'local')}>
          <option value="survey">Sky survey reference</option><option value="local">Another local FITS</option>
        </select>
      </label>
      {referenceMode === 'survey' ? <label className="text-sm space-y-1">Survey / band
        <select className="w-full rounded-md border bg-background p-2" value={survey} onChange={event => setSurvey(event.target.value)}>
          <option value="Auto">Auto — best survey in your filter's band (recommended)</option>
          <optgroup label="Pan-STARRS1 DR2 stacks · deep CCD · Dec > −30° · fields ≤ 25′">
            {['g', 'r', 'i', 'z', 'y'].map(band => <option key={band} value={`Pan-STARRS1 ${band} stack`}>Pan-STARRS1 {band}</option>)}
          </optgroup>
          <optgroup label="DESI Legacy Surveys DR10 · deep CCD · any field size">
            {['g', 'r', 'i', 'z'].map(band => <option key={band} value={`Legacy Surveys DR10 ${band}`}>Legacy Surveys {band}</option>)}
          </optgroup>
          <optgroup label="SDSS · CCD · SDSS footprint only">
            {['u', 'g', 'r', 'i', 'z'].map(band => <option key={band} value={`SDSS ${band}`}>SDSS {band}</option>)}
          </optgroup>
          <optgroup label="Digitized Sky Survey · photographic · whole sky">
            <option>DSS2 Red</option><option>DSS2 Blue</option><option>DSS2 IR</option><option>DSS1 Red</option>
          </optgroup>
          <optgroup label="2MASS · near-infrared · whole sky">
            {['J', 'H', 'K'].map(band => <option key={band} value={`2MASS ${band}`}>2MASS {band}</option>)}
          </optgroup>
        </select>
      </label> : <label className="text-sm space-y-1">Reference FITS
        <select className="w-full rounded-md border bg-background p-2" value={referenceImageId} onChange={event => setReferenceImageId(event.target.value)}>
          <option value="">Select a different FITS</option>
          {availableFits.data?.filter(item => item.id !== image.id).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>}
      <label className="text-sm space-y-1">Analysis resolution
        <select className="w-full rounded-md border bg-background p-2" value={maxDimension} onChange={event => setMaxDimension(Number(event.target.value))}>
          {[1024, 2048, 4096, 8192].map(value => <option key={value} value={value}>{value} px maximum</option>)}
        </select>
      </label>
      <label className="text-sm space-y-1">Candidate threshold (signal / noise)
        <Input type="number" min={3} max={30} step={0.5} value={thresholdSigma} onChange={event => setThresholdSigma(Number(event.target.value))} />
      </label>
      <label className="text-sm space-y-1">Point-source width (FWHM, pixels)
        <Input type="number" min={1.5} max={12} step={0.5} value={sourceFwhm} placeholder="Auto (measured)" onChange={event => setSourceFwhm(event.target.value)} />
      </label>
    </div>
    <details className="text-sm"><summary className="cursor-pointer font-medium">Advanced HOTPANTS controls and auxiliary files</summary>
      <p className="mt-2 text-muted-foreground">Optional upstream command-line flags, for example <code>-r 8 -ng 3 6 0.7 4 1.5 2 3</code>. Required input/output paths are managed by AstroviaBin. File-based flags must name an uploaded attachment. See the bundled HOTPANTS README for every supported flag.</p>
      <textarea className="mt-2 w-full rounded-md border bg-background p-2 font-mono" rows={3} value={hotpantsOptions} onChange={event => setHotpantsOptions(event.target.value)} placeholder="Optional HOTPANTS flags" />
      <label className="block mt-2">Auxiliary FITS, stamps or region list <Input type="file" className="mt-1" disabled={upload.isPending} onChange={event => { const selected = event.target.files?.[0]; if (selected) upload.mutate(selected); }} /></label>
      {inputs.data?.length ? <p className="mt-1 text-muted-foreground">Available: {inputs.data.join(', ')}</p> : null}
      {attachmentError && <p role="alert" className="text-destructive">{attachmentError}</p>}
    </details>
    <Button type="button" onClick={() => start.mutate()} disabled={start.isPending || reports.data?.some(item => item.status === 'running') || (referenceMode === 'local' && !referenceImageId)}>
      {start.isPending ? 'Starting…' : 'Analyze FITS'}
    </Button>
    {start.error && <p role="alert" className="text-sm text-destructive">{start.error.message}</p>}
    {reports.error && <p role="alert" className="text-sm text-destructive">Could not load analysis reports: {reports.error.message}</p>}
    {reports.data?.length ? <div className="space-y-3">
      <label className="block text-sm">Saved analyses
        <select className="ml-2 max-w-full rounded-md border bg-background p-1" value={report?.runId || ''} onChange={event => setActiveRun(event.target.value)}>
          {reports.data.map(item => <option key={item.runId} value={item.runId}>{new Date(item.startedAt).toLocaleString()} · {item.status}</option>)}
        </select>
      </label>
      <Button type="button" size="sm" variant="destructive" disabled={!report || report.status === 'running' || removeReport.isPending}
        onClick={() => {
          if (report && window.confirm('Delete this analysis and all its generated reports and FITS layers? The original uploaded FITS will remain untouched.')) {
            removeReport.mutate(report.runId);
          }
        }}>{removeReport.isPending ? 'Deleting…' : 'Delete this report'}</Button>
      {removeReport.error && <p role="alert" className="text-sm text-destructive">Could not delete report: {removeReport.error.message}</p>}
      {report?.status === 'running' && <p role="status">Processing locally: {report.progress?.stage || 'starting'}…</p>}
      {report?.status === 'interrupted' && <p role="alert" className="text-amber-500">Analysis interrupted by a server restart. Start a new analysis.</p>}
      {report?.status === 'failed' && <p role="alert" className="text-destructive">Analysis failed: {report.error}</p>}
      {report?.status === 'complete' && <>
        <p className="text-sm">Reference: {report.reference?.survey || `local FITS #${report.reference?.localImageId}`} · coverage {Math.round((report.coverage || 0) * 100)}% · {report.detectedTotal || 0} raw peaks above model S/N {report.settings?.thresholdSigma} ({report.analysisVersion === 2 ? report.candidates?.length || 0 : 0} passed independent point-source checks).</p>
        {report.analysisVersion !== 2 ? <p role="alert" className="text-xs text-amber-500">This report used the old peak-only detector. Its markers are hidden because they were not validated. Run the analysis again for the improved results.</p> : <>
          <p className="text-xs text-amber-500">{report.comparisonWarning} These are unconfirmed differences, not identified supernovae.</p>
          <p className="text-xs text-muted-foreground">Rejected raw peaks: {Object.entries(report.rejectedCandidates || {}).map(([reason, count]) => `${reason.replace(/([A-Z])/g, ' $1').toLowerCase()} ${count}`).join(' · ') || 'none'}.</p>
        </>}
        <p className="text-xs text-muted-foreground">Catalog check: {report.catalogCheck || 'not available'}. A nearby catalog object is not a transient identification.</p>
        {report.reference?.autoSelection && <p className="text-xs text-muted-foreground">Auto reference: band {report.reference.autoSelection.band} ({report.reference.autoSelection.reason}){report.reference.autoSelection.skipped.length ? `; skipped ${report.reference.autoSelection.skipped.map(item => item.split(':')[0]).join(', ')}` : ''}.</p>}
        {report.registration?.applied && <p className="text-xs text-muted-foreground">Registration refined with {report.registration.matchedStars} matched stars: residual {report.registration.rmsBeforePx?.toFixed(2)} px → {report.registration.rmsAfterPx?.toFixed(2)} px (largest correction {report.registration.maxCorrectionPx?.toFixed(1)} px).</p>}
        {report.cosmicRayPixels != null && report.cosmicRayPixels > 0 && <p className="text-xs text-muted-foreground">Cosmic-ray/hot pixels removed from the single exposure (L.A.Cosmic): {report.cosmicRayPixels.toLocaleString()}.</p>}
        {report.brightStarMaskFraction != null && report.brightStarMaskFraction > 0 && <p className="text-xs text-muted-foreground">Masked around bright, saturated or bleeding stars: {(report.brightStarMaskFraction * 100).toFixed(1)}% of the field (transients there cannot be detected reliably).</p>}
        {report.autoSettings && <p className="text-xs text-muted-foreground">Measured seeing: science {report.autoSettings.fwhmSciencePx ?? '?'} px, reference {report.autoSettings.fwhmReferencePx ?? '?'} px · detection FWHM {report.autoSettings.detectionFwhmPx} px · HOTPANTS auto: <code>{report.autoSettings.hotpantsArgs?.join(' ') || 'defaults'}</code></p>}
        {report.solarSystemCheck && <p className="text-xs text-muted-foreground">Known asteroids and comets: {report.solarSystemCheck}{report.solarSystemObjects?.length ? ` ${report.solarSystemObjects.map(item => `${item.name}${item.vmag != null ? ` (V ${item.vmag})` : ''}`).join(', ')}.` : ''}</p>}
        <div className="grid gap-2 sm:grid-cols-3">
          {(['science.fits', 'reference-aligned.fits', 'difference.fits'] as const).map(name => <div key={name}>
            <p className="mb-1 text-xs font-medium">{name === 'science.fits' ? 'Science' : name === 'reference-aligned.fits' ? 'Aligned reference' : 'Difference · candidates'}</p>
            <div className="relative"><img src={file(name, true)} alt={name} className="w-full rounded border" loading="lazy" />
              {name === 'difference.fits' && report.analysisVersion === 2 && report.candidates?.map((candidate, index) => {
                const radius = candidate.ringRadiusPx || 5;
                const known = candidate.status === 'known_solar_system_object';
                return <span key={`${candidate.x}-${candidate.y}`} title={`Candidate ${index + 1}${known ? ` = ${candidate.knownObject?.name}` : ''}: S/N ${candidate.snr}, RA ${candidate.ra.toFixed(7)}, Dec ${candidate.dec.toFixed(7)}`} className={`absolute rounded-full border-2 ${known ? 'border-amber-400 bg-amber-400/10' : 'border-red-500 bg-red-500/10'}`} style={{ left: `${(candidate.centroidX ?? candidate.x) / (report.width || 1) * 100}%`, top: `${(candidate.centroidY ?? candidate.y) / (report.height || 1) * 100}%`, width: `${2 * radius / (report.width || 1) * 100}%`, height: `${2 * radius / (report.height || 1) * 100}%`, transform: 'translate(-50%, -50%)', boxSizing: 'border-box' }} />;
              })}
            </div>
          </div>)}
        </div>
        {report.files?.includes('difference-candidates.fits') && <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm space-y-2">
          <p className="font-medium">Candidate-marked difference export</p>
          <p className="text-xs text-muted-foreground">The primary FITS difference plane is preserved unchanged. Candidate circles are in the <code>CANDIDATE_MASK</code> extension; <code>CANDIDATES</code> contains subpixel centroids and sky coordinates. Open the DS9 region file to overlay precise vector circles.</p>
          <div className="flex flex-wrap gap-4 text-xs">
            <a href={file('difference-candidates.fits')} className="text-primary underline" download>Download candidate-marked FITS</a>
            <a href={file('difference-candidates.reg')} className="text-primary underline" download>Download DS9 candidate circles</a>
          </div>
        </div>}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">{report.files?.filter(name => name !== 'difference-candidates.fits' && name !== 'difference-candidates.reg').map(name => <a key={name} href={file(name)} className="text-primary underline" download>{name}</a>)}</div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={utility.isPending} onClick={() => utility.mutate({ tool: 'maskim', imageLayer: 'difference.fits' })}>Create masked difference</Button>
          <Button type="button" size="sm" variant="outline" disabled={utility.isPending} onClick={() => utility.mutate({ tool: 'extractkern', mode: 'full', kernelWidths: 2 })}>Extract full kernel map</Button>
          <Button type="button" size="sm" variant="outline" disabled={utility.isPending} onClick={() => utility.mutate({ tool: 'extractkern', mode: 'image', imageLayer: 'science.fits' })}>Reconstruct convolution</Button>
        </div>
        {utility.error && <p role="alert" className="text-xs text-destructive">Utility failed: {utility.error.message}</p>}
        {report.analysisVersion === 2 && <>
          <div className="rounded-md border p-3 text-xs space-y-2">
            <p className="font-medium">Independent local FITS follow-up</p>
            <p className="text-muted-foreground">Select a separate exposure of the same field. A point source at the same sky position supports a candidate only when the filter matches and the observing time differs; it is not a confirmed discovery. No FITS leaves AstroviaBin.</p>
            <select className="w-full rounded-md border bg-background p-2" value={followupImageId} onChange={event => setFollowupImageId(event.target.value)}>
              <option value="">Select a second FITS exposure</option>
              {availableFits.data?.filter(item => item.id !== image.id).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
            {!availableFits.data?.some(item => item.id !== image.id) && <p className="text-amber-500">Upload another FITS exposure to enable independent follow-up.</p>}
            {checkCandidate.error && <p role="alert" className="text-destructive">Follow-up failed: {checkCandidate.error.message}</p>}
          </div>
          <div className="max-h-64 overflow-y-auto text-xs space-y-2">{report.candidates?.map((candidate, index) => {
            const checked = report.candidateChecks?.[index];
            return <div key={`${candidate.x}-${candidate.y}`} className="rounded-md border p-2 space-y-1">
              <p>#{index + 1} · model S/N {candidate.snr} · science contrast {candidate.scienceContrast} · RA {candidate.ra.toFixed(6)}° · Dec {candidate.dec.toFixed(6)}° · {candidate.status === 'known_solar_system_object' && candidate.knownObject ? <span className="text-amber-400">known solar-system object: {candidate.knownObject.name}{candidate.knownObject.class ? ` (${candidate.knownObject.class})` : ''}, {candidate.knownObject.separationArcsec}″ away — not a transient</span> : 'needs follow-up'}{candidate.nearbyCatalogObjects?.length ? ` · nearby OpenNGC: ${candidate.nearbyCatalogObjects.map(object => `${object.name} (${object.separationArcsec}″)`).join(', ')}` : ''}</p>
              {checked && <p className="text-amber-500">Follow-up: {checked.status.replaceAll('_', ' ')} in FITS #{checked.followupImageId} · {checked.comparableFilter ? 'same filter' : 'different/unknown filter'} · {checked.independentEpoch ? 'different observation time' : 'same/unknown observation time'}. {checked.note}</p>}
              <div className="flex gap-3">
                <button type="button" className="text-primary underline" disabled={utility.isPending} onClick={() => utility.mutate({ tool: 'extractkern', mode: 'position', x: candidate.x, y: candidate.y, kernelWidths: 2 })}>PSF kernel</button>
                <button type="button" className="text-primary underline" disabled={!followupImageId || checkCandidate.isPending} onClick={() => checkCandidate.mutate(index)}>{checkCandidate.isPending ? 'Checking…' : 'Check in second FITS'}</button>
              </div>
            </div>;
          })}</div>
        </>}
      </>}
    </div> : <p className="text-sm text-muted-foreground">No saved analysis yet.</p>}
    </div>
  </details>;
}
