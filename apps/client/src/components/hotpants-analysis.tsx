import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { AstroImage } from '@shared/schema';

type Candidate = { x: number; y: number; ra: number; dec: number; snr: number; status: string;
  scienceContrast?: number; shape?: { sharpness: number; roundness: number };
  nearbyCatalogObjects?: { name: string; separationArcsec: number }[] };
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
  files?: string[]; reference?: { survey?: string; localImageId?: number }; catalogCheck?: string;
  settings?: { thresholdSigma: number; maxDimension: number; sourceFwhm?: number };
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
  const [survey, setSurvey] = useState('DSS2 Red');
  const [maxDimension, setMaxDimension] = useState(2048);
  const [thresholdSigma, setThresholdSigma] = useState(6);
  const [sourceFwhm, setSourceFwhm] = useState(3);
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
        survey, maxDimension, thresholdSigma, sourceFwhm, maxCandidates: 100, hotpantsOptions }),
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
          <option value="survey">Historical sky survey (DSS2)</option><option value="local">Another local FITS</option>
        </select>
      </label>
      {referenceMode === 'survey' ? <label className="text-sm space-y-1">Survey band
        <select className="w-full rounded-md border bg-background p-2" value={survey} onChange={event => setSurvey(event.target.value)}>
          {['DSS2 Red', 'DSS2 Blue', 'DSS2 IR'].map(value => <option key={value}>{value}</option>)}
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
        <Input type="number" min={1.5} max={12} step={0.5} value={sourceFwhm} onChange={event => setSourceFwhm(Number(event.target.value))} />
      </label>
    </div>
    <details className="text-sm"><summary className="cursor-pointer font-medium">Advanced HOTPANTS controls and auxiliary files</summary>
      <p className="mt-2 text-muted-foreground">Optional upstream command-line flags, for example <code>-r 8 -ng 3 6 0.7 4 1.5 2 3</code>. Required input/output paths are managed by Sidereal. File-based flags must name an uploaded attachment. See the bundled HOTPANTS README for every supported flag.</p>
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
        <div className="grid gap-2 sm:grid-cols-3">
          {(['science.fits', 'reference-aligned.fits', 'difference.fits'] as const).map(name => <div key={name}>
            <p className="mb-1 text-xs font-medium">{name === 'science.fits' ? 'Science' : name === 'reference-aligned.fits' ? 'Aligned reference' : 'Difference · candidates'}</p>
            <div className="relative"><img src={file(name, true)} alt={name} className="w-full rounded border" loading="lazy" />
              {name === 'difference.fits' && report.analysisVersion === 2 && report.candidates?.map((candidate, index) => <span key={`${candidate.x}-${candidate.y}`} title={`Candidate ${index + 1}: model S/N ${candidate.snr}, RA ${candidate.ra.toFixed(5)}, Dec ${candidate.dec.toFixed(5)}`} className="absolute h-4 w-4 rounded-full border-2 border-red-500 bg-red-500/20" style={{ left: `${candidate.x / (report.width || 1) * 100}%`, top: `${candidate.y / (report.height || 1) * 100}%`, transform: 'translate(-50%, -50%)' }} />)}
            </div>
          </div>)}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">{report.files?.map(name => <a key={name} href={file(name)} className="text-primary underline" download>{name}</a>)}</div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={utility.isPending} onClick={() => utility.mutate({ tool: 'maskim', imageLayer: 'difference.fits' })}>Create masked difference</Button>
          <Button type="button" size="sm" variant="outline" disabled={utility.isPending} onClick={() => utility.mutate({ tool: 'extractkern', mode: 'full', kernelWidths: 2 })}>Extract full kernel map</Button>
          <Button type="button" size="sm" variant="outline" disabled={utility.isPending} onClick={() => utility.mutate({ tool: 'extractkern', mode: 'image', imageLayer: 'science.fits' })}>Reconstruct convolution</Button>
        </div>
        {utility.error && <p role="alert" className="text-xs text-destructive">Utility failed: {utility.error.message}</p>}
        {report.analysisVersion === 2 && <>
          <div className="rounded-md border p-3 text-xs space-y-2">
            <p className="font-medium">Independent local FITS follow-up</p>
            <p className="text-muted-foreground">Select a separate exposure of the same field. A point source at the same sky position supports a candidate only when the filter matches and the observing time differs; it is not a confirmed discovery. No FITS leaves Sidereal.</p>
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
              <p>#{index + 1} · model S/N {candidate.snr} · science contrast {candidate.scienceContrast} · RA {candidate.ra.toFixed(6)}° · Dec {candidate.dec.toFixed(6)}° · needs follow-up{candidate.nearbyCatalogObjects?.length ? ` · nearby OpenNGC: ${candidate.nearbyCatalogObjects.map(object => `${object.name} (${object.separationArcsec}″)`).join(', ')}` : ''}</p>
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
