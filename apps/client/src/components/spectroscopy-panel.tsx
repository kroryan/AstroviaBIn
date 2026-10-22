import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Download, FileText, Loader2, Rainbow, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '@/lib/queryClient';
import { formatDateTime } from '@/lib/datetime';
import { useCurrentUser } from '@/hooks/use-current-user';
import type { AstroImage } from '@shared/schema';

type LineEntry = { key: string; label: string; element: string; rest: number; observed?: number | null; type: 'absorption' | 'emission' | 'band' | 'telluric';
  ew: number; ewError: number; unit: string; significance: number; velocity?: number | null };
type Classification = { type: string | null; range: string | null; teff: number | null; teffLow: number | null; teffHigh: number | null;
  luminosityClass?: string; luminosityRange?: string; metallicity?: string; matches?: string[]; special?: string | null; notes?: string[]; method?: string; chi2red?: number };
type Known = { hasSpectroscopy: boolean; summary: string; sources: string[];
  simbad?: { name: string; spType?: string | null; separationArcsec?: number } | null;
  gaia?: { source: string; teff?: number | null; logg?: number | null; rv?: number | null; separationArcsec?: number } | null;
  sdss?: { class: string; subclass: string; spectrum: string } | null };
type Star = {
  id: number; status: 'analysed' | 'contaminated' | 'discarded'; x: number | null; y: number | null; ra: number | null; dec: number | null;
  trace?: { x0: number; y0: number; x1: number; y1: number; halfWidth: number }; flags: string[]; reasons?: string[];
  snr?: number; confidence?: string; lines: LineEntry[]; unidentified?: LineEntry[]; elements: string[]; classification: Classification | null;
  velocity?: { value: number; error: number; method?: string } | null; colourTemperature?: { value: number; error?: number | null } | null;
  catalogue?: string; known?: Known;
  spectrum?: { wavelength?: (number | null)[]; pixel?: (number | null)[]; flux: (number | null)[]; continuum?: (number | null)[]; normalized?: (number | null)[]; model?: (number | null)[] };
};
type Check = { quantity: string; source: string; ours: string; reference: string; difference: string; agreement: 'agrees' | 'close' | 'differs' };
type Comparison = { statistics: Record<string, any>; errors: string[]; stars: { id: number; verdict: string; checks: Check[]; known: Known }[] };
type Result = {
  mode: 'spectrum1d' | 'slitless' | 'trace'; input: { name: string }; generatedAt: string; notes: string[];
  calibration: { status: string; dispersion: number | null; method: string; rmsA?: number | null };
  geometry?: { angleDeg: number; start: number; end: number }; image?: { width: number; height: number; wcs: boolean };
  stars: Star[]; summary?: { detected: number; analysed: number; classified: number }; comparison?: Comparison;
};
type Run = { runId: string; status: 'running' | 'complete' | 'failed' | 'interrupted'; startedAt: string; completedAt?: string; error?: string;
  progress?: { stage: string; fraction: number }; result?: Result; summary?: Result['summary']; mode?: string };
type KnownCheck = { generatedAt: string; mode: string; stars: { id: number; x: number | null; y: number | null; ra: number | null; dec: number | null; known: Known | null }[];
  summary: { stars: number; known: number; unknown: number }; errors: string[]; notes: string[] };

const DISPERSION_KEY = 'astroviabin.spectroscopy.instrumentDispersion';
const CONFIDENCE_STYLE: Record<string, string> = {
  High: 'border-emerald-400 text-emerald-300', Medium: 'border-cyan-400 text-cyan-300', Low: 'border-amber-400 text-amber-300', Insufficient: 'border-gray-500 text-gray-400',
};
const AGREEMENT_STYLE: Record<string, string> = { agrees: 'text-emerald-300', close: 'text-amber-300', differs: 'text-red-300' };
const LINE_COLOUR: Record<string, string> = { absorption: '#60a5fa', emission: '#f87171', band: '#c084fc', telluric: '#9ca3af' };

function isFits(image: AstroImage): boolean {
  return /^(fits|fits-derived|fits-upload):\/\//.test(image.originalPath || '');
}

async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return 'Request failed';
  const text = error.message.replace(/^\d+:\s*/, '');
  try { return JSON.parse(text).message || text; } catch { return text; }
}

function sexagesimal(ra: number, dec: number): string {
  const h = ra / 15;
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = ((h - hh) * 60 - mm) * 60;
  const sign = dec < 0 ? '−' : '+';
  const d = Math.abs(dec), dd = Math.floor(d), dm = Math.floor((d - dd) * 60), ds = ((d - dd) * 60 - dm) * 60;
  return `${String(hh).padStart(2, '0')}h${String(mm).padStart(2, '0')}m${ss.toFixed(2).padStart(5, '0')}s ${sign}${String(dd).padStart(2, '0')}°${String(dm).padStart(2, '0')}′${ds.toFixed(1).padStart(4, '0')}″`;
}

function readStoredDispersion(): string {
  try { return localStorage.getItem(DISPERSION_KEY) ?? ''; } catch { return ''; }
}

/** Field image with every star marked (circle) and its extracted spectrum (box), clickable. */
function FieldView({ imageId, width, height, stars, selected, onSelect, known }: {
  imageId: number; width: number; height: number; stars: Star[]; selected: number | null; onSelect: (id: number) => void; known?: KnownCheck | null;
}) {
  const box = (star: Star) => {
    const trace = star.trace!;
    const dx = trace.x1 - trace.x0, dy = trace.y1 - trace.y0;
    const length = Math.hypot(dx, dy) || 1;
    const nx = -dy / length * trace.halfWidth, ny = dx / length * trace.halfWidth;
    // FITS rows grow upwards; the preview image is drawn with row 0 at the top.
    const point = (x: number, y: number) => `${x},${height - 1 - y}`;
    return [point(trace.x0 + nx, trace.y0 + ny), point(trace.x1 + nx, trace.y1 + ny), point(trace.x1 - nx, trace.y1 - ny), point(trace.x0 - nx, trace.y0 - ny)].join(' ');
  };
  const radius = Math.max(6, Math.min(width, height) / 70);
  return <div className="relative w-full overflow-hidden rounded-md bg-black">
    <img src={`/api/fits/${imageId}/preview?stretch=asinh&preview=interactive`} alt="Field" className="block w-full" />
    <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
      {stars.map(star => {
        if (star.x === null || star.y === null) return null;
        const knownEntry = known?.stars.find(entry => entry.x !== null && entry.y !== null && Math.hypot(entry.x - star.x!, entry.y - star.y!) < 3)?.known;
        const colour = star.status === 'discarded' ? '#f59e0b' : star.id === selected ? '#f0abfc' : knownEntry && !knownEntry.hasSpectroscopy ? '#fbbf24' : '#22d3ee';
        return <g key={star.id} className="cursor-pointer" onClick={() => onSelect(star.id)}>
          {star.trace && <polygon points={box(star)} fill="none" stroke={colour} strokeWidth={Math.max(1, width / 900)} opacity={0.85} />}
          <circle cx={star.x} cy={height - 1 - star.y} r={radius} fill="none" stroke={colour} strokeWidth={Math.max(1.2, width / 700)} />
          <text x={star.x + radius * 1.2} y={height - 1 - star.y - radius * 1.2} fill={colour} fontSize={Math.max(12, width / 60)} fontWeight="bold">{star.id}</text>
        </g>;
      })}
    </svg>
  </div>;
}

function SpectrumChart({ star }: { star: Star }) {
  const spectrum = star.spectrum;
  const calibrated = Boolean(spectrum?.wavelength);
  const data = useMemo(() => {
    if (!spectrum) return [];
    const axis = spectrum.wavelength ?? spectrum.pixel ?? [];
    return axis.map((value, index) => ({
      x: value === null ? null : calibrated ? value / 10 : value,
      flux: spectrum.flux[index], model: spectrum.model?.[index] ?? null, continuum: spectrum.continuum?.[index] ?? null,
      normalized: spectrum.normalized?.[index] ?? null,
    })).filter(point => point.x !== null);
  }, [spectrum, calibrated]);
  if (!spectrum || data.length === 0) return null;
  const lines = calibrated ? star.lines : [];
  return <div className="space-y-2">
    <div className="h-56 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="#1f2937" />
          <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 10 }} unit={calibrated ? ' nm' : ' px'} />
          <YAxis tick={{ fontSize: 10 }} width={44} />
          <Tooltip contentStyle={{ background: '#0b0a18', border: '1px solid #334155', fontSize: 11 }} formatter={value => Number(value).toPrecision(4)} />
          <Line dataKey="flux" stroke="#e2e8f0" dot={false} strokeWidth={1} isAnimationActive={false} name="Flux" />
          {spectrum.continuum && <Line dataKey="continuum" stroke="#f97316" dot={false} strokeWidth={1} isAnimationActive={false} name="Continuum" />}
          {spectrum.model && <Line dataKey="model" stroke="#22c55e" dot={false} strokeWidth={1} isAnimationActive={false} name="Best standard (pPXF)" />}
          {lines.map(line => <ReferenceLine key={`${line.key}-${line.type}`} x={line.rest / 10} stroke={LINE_COLOUR[line.type]} strokeDasharray="3 3" />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
    {spectrum.normalized && <div className="h-40 w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 4, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid stroke="#1f2937" />
          <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 10 }} unit=" nm" />
          <YAxis domain={[0, 1.5]} tick={{ fontSize: 10 }} width={44} allowDataOverflow />
          <ReferenceLine y={1} stroke="#475569" />
          <Line dataKey="normalized" stroke="#a5b4fc" dot={false} strokeWidth={1} isAnimationActive={false} name="Normalised" />
          {lines.map(line => <ReferenceLine key={`n-${line.key}-${line.type}`} x={line.rest / 10} stroke={LINE_COLOUR[line.type]} strokeDasharray="2 4"
            label={{ value: line.label.split(' + ')[0], position: 'insideTopRight', fontSize: 9, fill: LINE_COLOUR[line.type] }} />)}
        </LineChart>
      </ResponsiveContainer>
    </div>}
  </div>;
}

function StarDetail({ star, comparison }: { star: Star; comparison?: Comparison }) {
  const c = star.classification;
  const row = comparison?.stars.find(entry => entry.id === star.id);
  return <div className="space-y-3 rounded-md border border-border p-3 text-sm">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h4 className="text-base font-semibold">Star {star.id}{c?.type ? ` — ${c.type}` : ''}{c?.range && c.range !== c?.type ? ` (${c.range})` : ''}</h4>
      {star.confidence && <span className={`rounded border px-2 py-0.5 text-xs ${CONFIDENCE_STYLE[star.confidence] ?? ''}`}>{star.confidence} confidence</span>}
    </div>
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
      {star.x !== null && <><dt className="text-muted-foreground">Position in the image</dt><dd className="font-mono">x {star.x?.toFixed(2)} px, y {star.y?.toFixed(2)} px</dd></>}
      {star.ra !== null && star.dec !== null && <><dt className="text-muted-foreground">RA, Dec (ICRS)</dt>
        <dd className="font-mono">{star.ra.toFixed(6)}°, {star.dec >= 0 ? '+' : ''}{star.dec.toFixed(6)}° · {sexagesimal(star.ra, star.dec)}</dd></>}
      {c?.teff && <><dt className="text-muted-foreground">Temperature</dt><dd>{c.teff} K (range {c.teffLow}–{c.teffHigh} K)</dd></>}
      {c?.luminosityClass && <><dt className="text-muted-foreground">Luminosity class</dt><dd>{c.luminosityClass}{c.luminosityRange && c.luminosityRange !== c.luminosityClass ? ` (${c.luminosityRange})` : ''} · {c.metallicity}</dd></>}
      {star.velocity && <><dt className="text-muted-foreground">Radial velocity</dt><dd>{star.velocity.value} ± {star.velocity.error} km/s</dd></>}
      {star.colourTemperature && <><dt className="text-muted-foreground">Colour temperature</dt><dd>{star.colourTemperature.value} K (continuum, not dereddened)</dd></>}
      {star.snr !== undefined && <><dt className="text-muted-foreground">S/N</dt><dd>{star.snr}</dd></>}
      {star.elements.length > 0 && <><dt className="text-muted-foreground">Elements (compatible lines)</dt><dd>{star.elements.join(', ')}</dd></>}
      {star.known && <><dt className="text-muted-foreground">Earlier spectroscopy</dt><dd>{star.known.hasSpectroscopy ? star.known.summary : 'None found (new)'}</dd></>}
    </dl>
    {c?.special && <p className="rounded border border-fuchsia-500/40 bg-fuchsia-500/10 p-2 text-xs text-fuchsia-200">{c.special}</p>}
    {[...(star.reasons ?? []), ...(c?.notes ?? []), ...star.flags.map(flag => `Flag: ${flag}`)].length > 0 && <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-300">
      {[...(star.reasons ?? []), ...(c?.notes ?? []), ...star.flags.map(flag => `Flag: ${flag}`)].map(text => <li key={text}>{text}</li>)}
    </ul>}
    <SpectrumChart star={star} />
    {c?.matches && c.matches.length > 0 && <p className="text-xs text-muted-foreground">Closest standards: {c.matches.join(', ')} · {c.method}</p>}
    {star.lines.length > 0 && <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="text-left text-muted-foreground"><th className="pr-2">Line</th><th className="pr-2">Rest (nm)</th><th className="pr-2">EW / depth</th><th className="pr-2">Signif.</th><th>Type</th></tr></thead>
        <tbody>{star.lines.map(line => <tr key={`${line.key}-${line.type}`}>
          <td className="pr-2" style={{ color: LINE_COLOUR[line.type] }}>{line.label}</td><td className="pr-2 font-mono">{(line.rest / 10).toFixed(1)}</td>
          <td className="pr-2 font-mono">{line.ew.toFixed(2)} ± {line.ewError.toFixed(2)} {line.unit === 'A' ? 'Å' : ''}</td><td className="pr-2">{line.significance}σ</td><td>{line.type}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {row && row.checks.length > 0 && <div>
      <h5 className="mb-1 text-xs font-semibold">Comparison with earlier spectroscopy — {row.verdict}</h5>
      <ul className="space-y-0.5 text-xs">{row.checks.map((check, index) => <li key={index}>
        <span className="text-muted-foreground">{check.quantity} ({check.source}):</span> ours {check.ours} · catalogue {check.reference} · {check.difference}{' '}
        <span className={AGREEMENT_STYLE[check.agreement]}>{check.agreement}</span>
      </li>)}</ul>
    </div>}
  </div>;
}

/** Spectroscopy tools only apply to spectra: 1-D spectra and slitless/grating frames (tagged on upload). */
const SPECTROSCOPY_TAGS = ['Spectrum', 'Spectroscopy', 'Slitless spectrum', '1-D spectrum'];
export function isSpectroscopyImage(image: AstroImage): boolean {
  return (image.tags ?? []).some(tag => SPECTROSCOPY_TAGS.includes(tag));
}

export function SpectroscopyPanel({ image }: { image: AstroImage }) {
  const fits = isFits(image);
  const { canEdit } = useCurrentUser();
  const queryClient = useQueryClient();
  const spectrumImage = (image.tags ?? []).includes('Spectrum');
  const [expanded, setExpanded] = useState(spectrumImage || (image.tags ?? []).includes('Spectroscopy'));
  const [mode, setMode] = useState<'auto' | 'slitless' | 'trace' | 'spectrum1d'>('auto');
  const [dispersion, setDispersion] = useState(readStoredDispersion);
  const [angle, setAngle] = useState('');
  const [maxStars, setMaxStars] = useState('60');
  const [minSnr, setMinSnr] = useState('5');
  const [detectionSigma, setDetectionSigma] = useState('6');
  const [cosmicRays, setCosmicRays] = useState(true);
  const [biasId, setBiasId] = useState('');
  const [darkId, setDarkId] = useState('');
  const [flatId, setFlatId] = useState('');
  const [compare, setCompare] = useState(true);
  const [runId, setRunId] = useState<string | null>(null);
  const [selectedStar, setSelectedStar] = useState<number | null>(null);

  const runs = useQuery<Run[]>({ queryKey: ['/api/fits', image.id, 'spectroscopy'], queryFn: async () => json(await apiRequest('GET', `/api/fits/${image.id}/spectroscopy`)), enabled: fits && expanded });
  const known = useQuery<KnownCheck | null>({
    queryKey: ['/api/fits', image.id, 'spectroscopy', 'known'], enabled: fits && expanded, retry: false,
    queryFn: async () => { const response = await fetch(`/api/fits/${image.id}/spectroscopy/known`, { credentials: 'include' }); return response.ok ? response.json() : null; },
  });
  const fitsList = useQuery<AstroImage[]>({ queryKey: ['/api/fits'], enabled: fits && expanded });
  useEffect(() => { if (!runId && runs.data?.length) setRunId(runs.data[0].runId); }, [runs.data, runId]);
  const run = useQuery<Run>({
    queryKey: ['/api/fits', image.id, 'spectroscopy', runId], enabled: Boolean(runId) && expanded,
    queryFn: async () => json(await apiRequest('GET', `/api/fits/${image.id}/spectroscopy/${runId}`)),
    refetchInterval: query => (query.state.data?.status === 'running' ? 1500 : false),
  });
  useEffect(() => {
    if (run.data?.status !== 'running') queryClient.invalidateQueries({ queryKey: ['/api/fits', image.id, 'spectroscopy'], exact: true });
  }, [run.data?.status, queryClient, image.id]);

  const numeric = (value: string) => value.trim() === '' ? undefined : Number(value);
  const start = useMutation({
    mutationFn: async () => json<Run>(await apiRequest('POST', `/api/fits/${image.id}/spectroscopy`, {
      mode, dispersionNmPerPixel: numeric(dispersion), dispersionAngle: numeric(angle), maxStars: numeric(maxStars) ?? 60,
      minTraceSnr: numeric(minSnr) ?? 5,
      detectionSigma: numeric(detectionSigma) ?? 6, cosmicRays, compareWithKnown: Boolean(known.data) && compare,
      biasImageId: numeric(biasId), darkImageId: numeric(darkId), flatImageId: numeric(flatId),
    })),
    onSuccess: report => { setRunId(report.runId); setSelectedStar(null); queryClient.invalidateQueries({ queryKey: ['/api/fits', image.id, 'spectroscopy'], exact: true }); },
  });
  const check = useMutation({
    mutationFn: async () => json<KnownCheck>(await apiRequest('POST', `/api/fits/${image.id}/spectroscopy/known`, {
      mode, maxStars: numeric(maxStars) ?? 60, detectionSigma: numeric(detectionSigma) ?? 6 })),
    onSuccess: data => { queryClient.setQueryData(['/api/fits', image.id, 'spectroscopy', 'known'], data); setCompare(true); },
  });
  const remove = useMutation({
    mutationFn: async (id: string) => apiRequest('DELETE', `/api/fits/${image.id}/spectroscopy/${id}`),
    onSuccess: () => { setRunId(null); queryClient.invalidateQueries({ queryKey: ['/api/fits', image.id, 'spectroscopy'], exact: true }); },
  });

  if (!fits) return null;
  const result = run.data?.status === 'complete' ? run.data.result : undefined;
  const selected = result?.stars.find(star => star.id === selectedStar) ?? result?.stars.find(star => star.status !== 'discarded') ?? null;
  const fileUrl = (name: string, download = true) => `/api/fits/${image.id}/spectroscopy/${runId}/files/${name}${download ? '?download=1' : ''}`;
  const masters = (fitsList.data ?? []).filter(entry => entry.id !== image.id);
  const masterSelect = (label: string, value: string, setValue: (value: string) => void) => <label className="space-y-1 text-xs">
    <span className="text-muted-foreground">{label}</span>
    <select value={value} onChange={event => setValue(event.target.value)} className="w-full rounded-md border border-input bg-background px-2 py-1">
      <option value="">None</option>
      {masters.map(entry => <option key={entry.id} value={entry.id}>{entry.title} · {entry.filename}</option>)}
    </select>
  </label>;
  const field = (label: string, value: string, setValue: (value: string) => void, hint: string, placeholder = '') => <label className="space-y-1 text-xs">
    <span className="text-muted-foreground" title={hint}>{label}</span>
    <input value={value} onChange={event => setValue(event.target.value)} placeholder={placeholder} inputMode="decimal" className="w-full rounded-md border border-input bg-background px-2 py-1" />
  </label>;

  return <details className="mt-3 rounded-xl border border-violet-500/30 bg-muted/20 p-4" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer font-semibold text-foreground"><Rainbow className="mr-2 inline h-4 w-4 text-violet-300" />Spectroscopy · stars, lines, types and temperatures</summary>
    {expanded && <div className="space-y-4 pt-3 text-sm">
      <p className="text-xs text-muted-foreground">
        Analyses every usable star of a slitless spectroscopic frame (Star Analyser–type grating: field with zero orders, or spectrum strips) or a 1-D spectrum.
        Calibration with CCDProc, stars with Photutils, strip extraction with Specreduce, line measurements with Specutils, and stellar template fits
        with pPXF against the Pickles standard-star library. Enter a dispersion measured independently with the same instrument setup for slitless fields;
        strips without their zero order need a spectral WCS in the FITS. Uncalibrated and overlapping spectra are shown without line identifications
        or stellar classifications. Radial velocity is not reported at this template resolution.
      </p>

      <section className="space-y-2 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-medium">1 · Earlier spectroscopy (optional, before the analysis)</h4>
          {canEdit && <Button size="sm" variant="outline" disabled={check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Search className="mr-1 h-4 w-4" />}Check known spectroscopy
          </Button>}
        </div>
        <p className="text-xs text-muted-foreground">Looks every star up in SIMBAD, Gaia DR3 (XP/RVS) and SDSS DR18 (only coordinates are sent). Stars without earlier spectroscopy are marked as new. The analysis then compares its results with these profiles, in the same PDF report.</p>
        {check.isError && <p className="text-xs text-red-300">{errorText(check.error)}</p>}
        {known.data && <div className="space-y-1 text-xs">
          <p>Checked {formatDateTime(known.data.generatedAt)}: {known.data.summary.stars} star(s) — <span className="text-emerald-300">{known.data.summary.known} with earlier spectroscopy</span>, <span className="text-amber-300">{known.data.summary.unknown} without (new)</span>.</p>
          {known.data.errors.map(error => <p key={error} className="text-amber-300">{error}</p>)}
          <div className="max-h-40 overflow-y-auto">
            <table className="w-full"><tbody>{known.data.stars.map(entry => <tr key={entry.id} className="align-top">
              <td className="pr-2 font-mono">{entry.id}</td>
              <td className="pr-2 font-mono">{entry.ra !== null && entry.dec !== null ? `${entry.ra.toFixed(5)}, ${entry.dec >= 0 ? '+' : ''}${entry.dec.toFixed(5)}` : '—'}</td>
              <td className={entry.known?.hasSpectroscopy ? 'text-emerald-300' : 'text-amber-300'}>{entry.known?.hasSpectroscopy ? entry.known.summary : 'No earlier spectroscopy (new)'}</td>
            </tr>)}</tbody></table>
          </div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={compare} onChange={event => setCompare(event.target.checked)} />Compare the analysis with these profiles</label>
        </div>}
      </section>

      <section className="space-y-2 rounded-md border border-border p-3">
        <h4 className="font-medium">2 · Analysis</h4>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="space-y-1 text-xs"><span className="text-muted-foreground">Kind of data</span>
            <select value={mode} onChange={event => setMode(event.target.value as typeof mode)} className="w-full rounded-md border border-input bg-background px-2 py-1">
              <option value="auto">Automatic</option><option value="slitless">Slitless field (zero orders visible)</option>
              <option value="trace">Spectrum strip (no zero order)</option><option value="spectrum1d">1-D spectrum</option>
            </select>
          </label>
          {field('Measured dispersion (nm/px)', dispersion, setDispersion, 'Measure with a reference star or calibration lamp using the same grating, camera and spacing. The image cannot calibrate itself reliably.', 'e.g. 0.432')}
          {field('Dispersion angle (°)', angle, setAngle, 'Found automatically; set it only for crowded fields.')}
        </div>
        <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">More settings and calibration frames</summary>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {field('Maximum stars', maxStars, setMaxStars, 'The brightest stars are analysed first.')}
            {field('Minimum spectrum S/N', minSnr, setMinSnr, 'Fainter spectra are listed as discarded.')}
            {field('Detection threshold (σ)', detectionSigma, setDetectionSigma, 'Photutils star detection.')}
            {masterSelect('Master bias', biasId, setBiasId)}
            {masterSelect('Master dark', darkId, setDarkId)}
            {masterSelect('Master flat', flatId, setFlatId)}
            <label className="flex items-center gap-2"><input type="checkbox" checked={cosmicRays} onChange={event => setCosmicRays(event.target.checked)} />Remove cosmic rays (L.A.Cosmic)</label>
          </div>
        </details>
        {canEdit && <Button className="w-full" disabled={start.isPending || run.data?.status === 'running'} onClick={() => start.mutate()}>
          {start.isPending || run.data?.status === 'running' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Rainbow className="mr-2 h-4 w-4" />}
          Analyse spectra{known.data && compare ? ' and compare' : ''}
        </Button>}
        {start.isError && <p className="text-xs text-red-300">{errorText(start.error)}</p>}
      </section>

      {(runs.data?.length ?? 0) > 0 && <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Analyses:</span>
        <select value={runId ?? ''} onChange={event => { setRunId(event.target.value); setSelectedStar(null); }} className="rounded-md border border-input bg-background px-2 py-1">
          {runs.data!.map(entry => <option key={entry.runId} value={entry.runId}>{formatDateTime(entry.startedAt)} · {entry.status}{entry.summary ? ` · ${entry.summary.analysed}/${entry.summary.detected} stars` : ''}</option>)}
        </select>
        {canEdit && runId && run.data?.status !== 'running' && <Button size="sm" variant="ghost" onClick={() => remove.mutate(runId)}><Trash2 className="h-4 w-4" /></Button>}
      </div>}

      {run.data?.status === 'running' && <div className="space-y-1 text-xs">
        <p>{run.data.progress?.stage ?? 'Starting…'}</p>
        <div className="h-1.5 w-full overflow-hidden rounded bg-muted"><div className="h-full bg-violet-400 transition-all" style={{ width: `${Math.round((run.data.progress?.fraction ?? 0.02) * 100)}%` }} /></div>
      </div>}
      {(run.data?.status === 'failed' || run.data?.status === 'interrupted') && <p className="text-xs text-red-300">{run.data.error}</p>}

      {result && <div className="space-y-3">
        <div className="space-y-1 rounded-md border border-border p-3 text-xs">
          <p><span className="text-muted-foreground">Mode:</span> {result.mode === 'spectrum1d' ? '1-D spectrum' : result.mode === 'trace' ? 'spectrum strip' : 'slitless field'} ·{' '}
            <span className="text-muted-foreground">stars:</span> {result.summary?.analysed} analysed of {result.summary?.detected}</p>
          <p><span className="text-muted-foreground">Wavelength calibration:</span> {result.calibration.method}{result.calibration.dispersion ? ` · ${result.calibration.dispersion.toFixed(4)} nm/px` : ''}</p>
          {result.geometry && result.mode === 'slitless' && <p><span className="text-muted-foreground">Dispersion direction:</span> {result.geometry.angleDeg.toFixed(2)}°</p>}
          {result.notes.map(note => <p key={note} className="text-amber-300">{note}</p>)}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" asChild><a href={fileUrl('report.pdf', false)} target="_blank" rel="noreferrer"><FileText className="mr-1 h-4 w-4" />PDF report</a></Button>
            <Button size="sm" variant="outline" asChild><a href={fileUrl('summary.csv')}><Download className="mr-1 h-4 w-4" />Summary CSV</a></Button>
            <Button size="sm" variant="outline" asChild><a href={fileUrl('spectra.fits')}><Download className="mr-1 h-4 w-4" />Spectra FITS</a></Button>
            {result.comparison && <Button size="sm" variant="outline" asChild><a href={fileUrl('comparison.csv')}><Download className="mr-1 h-4 w-4" />Comparison CSV</a></Button>}
            {selected && <Button size="sm" variant="ghost" asChild><a href={fileUrl(`star-${selected.id}.csv`)}><Download className="mr-1 h-4 w-4" />Star {selected.id} CSV</a></Button>}
          </div>
        </div>
        {result.comparison && <div className="rounded-md border border-border p-3 text-xs">
          <h4 className="mb-1 font-medium">Comparison with earlier spectroscopy</h4>
          <p>{result.comparison.statistics.withEarlierProfile} of {result.comparison.statistics.stars} star(s) had an earlier profile; {result.comparison.statistics.withoutEarlierProfile} are new.</p>
          {['Spectral type', 'Teff (K)', 'Luminosity class', 'Radial velocity (km/s)'].map(name => result.comparison!.statistics[name] && <p key={name}>
            {name}: {result.comparison!.statistics[name].agreeing}/{result.comparison!.statistics[name].comparisons} agree
            {result.comparison!.statistics[name].medianAbsolute !== undefined ? ` · median |Δ| ${result.comparison!.statistics[name].medianAbsolute}` : ''}</p>)}
        </div>}
        {result.image && result.mode !== 'spectrum1d' && <FieldView imageId={image.id} width={result.image.width} height={result.image.height} stars={result.stars}
          selected={selected?.id ?? null} onSelect={setSelectedStar} known={known.data} />}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-muted-foreground"><th className="pr-2">Star</th><th className="pr-2">Type</th><th className="pr-2">Teff (K)</th><th className="pr-2">Lines</th><th className="pr-2">Confidence</th><th>Status</th></tr></thead>
            <tbody>{result.stars.map(star => <tr key={star.id} onClick={() => setSelectedStar(star.id)} className={`cursor-pointer align-top hover:bg-white/5 ${selected?.id === star.id ? 'bg-violet-500/10' : ''}`}>
              <td className="pr-2 font-mono">{star.id}</td>
              <td className="pr-2">{star.classification?.type ?? '—'}{star.classification?.range && star.classification.range !== star.classification.type ? ` (${star.classification.range})` : ''}</td>
              <td className="pr-2">{star.classification?.teff ?? '—'}</td>
              <td className="pr-2">{star.lines.slice(0, 5).map(line => line.label.split(' + ')[0]).join(', ') || '—'}</td>
              <td className="pr-2">{star.confidence ? <span className={`rounded border px-1 ${CONFIDENCE_STYLE[star.confidence] ?? ''}`}>{star.confidence}</span> : '—'}</td>
              <td>{star.status}{star.known ? (star.known.hasSpectroscopy ? ' · known' : ' · new') : ''}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {selected && <StarDetail star={selected} comparison={result.comparison} />}
      </div>}
    </div>}
  </details>;
}
