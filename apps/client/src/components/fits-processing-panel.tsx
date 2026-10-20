import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Maximize2, Minimize2, RotateCcw, Save, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useToast } from '@/hooks/use-toast';
import { useDebounce } from '@/hooks/use-debounce';
import { DeepZoomViewer } from './deep-zoom-viewer';
import type { AstroImage } from '@shared/schema';

interface FitsMetadata {
  width: number;
  height: number;
  channels: number;
  bitpix: number;
  headers: Record<string, string | number | boolean>;
}

function isFits(image: AstroImage): boolean {
  return Boolean(image.originalPath?.startsWith('fits://') || image.originalPath?.startsWith('fits-derived://') || image.originalPath?.startsWith('fits-upload://'));
}

/** Every processing option's default; "Reset" and "Reset all" restore these. */
const DEFAULTS = {
  stretch: 'asinh', strength: 10, shadowPercentile: 0.5, highlightPercentile: 99.5, gamma: 2.2, midtones: 0.25,
  saturation: 1, redBalance: 1, greenBalance: 1, blueBalance: 1, backgroundNeutralization: true, scnrAmount: 0,
  sharpenAmount: 0, sharpenRadius: 1, denoiseAmount: 0, denoiseRadius: 1, backgroundExtractionAmount: 0,
  hotPixelThreshold: 0, colorMap: 'original',
};

const defaultOutputName = (filename: string) => filename.replace(/\.(fit|fits|fts)$/i, '') + '-processed';

function ResetButton({ label, changed, onReset }: { label: string; changed: boolean; onReset: () => void }) {
  return <button
    type="button"
    onClick={onReset}
    disabled={!changed}
    aria-label={`Reset ${label} to its default`}
    title={changed ? `Reset ${label} to its default` : `${label} is at its default`}
    className="rounded p-0.5 text-muted-foreground hover:text-primary disabled:opacity-30 disabled:hover:text-muted-foreground"
  >
    <RotateCcw className="h-3 w-3" />
  </button>;
}

function SliderField({ label, value, defaultValue, min, max, step, onChange, suffix = '' }: { label: string; value: number; defaultValue: number; min: number; max: number; step: number; onChange: (value: number) => void; suffix?: string }) {
  return <div className="space-y-1">
    <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{label}</span>
      <span className="flex items-center gap-1"><span className="font-mono">{value}{suffix}</span><ResetButton label={label} changed={value !== defaultValue} onReset={() => onChange(defaultValue)} /></span>
    </span>
    <input aria-label={label} className="w-full accent-primary" type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} />
  </div>;
}

export function FitsProcessingPanel({ image }: { image: AstroImage }) {
  const fitsImage = isFits(image);
  const [stretch, setStretch] = useState(DEFAULTS.stretch);
  const [strength, setStrength] = useState(DEFAULTS.strength);
  const [shadowPercentile, setShadowPercentile] = useState(DEFAULTS.shadowPercentile);
  const [highlightPercentile, setHighlightPercentile] = useState(DEFAULTS.highlightPercentile);
  const [gamma, setGamma] = useState(DEFAULTS.gamma);
  const [midtones, setMidtones] = useState(DEFAULTS.midtones);
  const [saturation, setSaturation] = useState(DEFAULTS.saturation);
  const [redBalance, setRedBalance] = useState(DEFAULTS.redBalance);
  const [greenBalance, setGreenBalance] = useState(DEFAULTS.greenBalance);
  const [blueBalance, setBlueBalance] = useState(DEFAULTS.blueBalance);
  const [backgroundNeutralization, setBackgroundNeutralization] = useState(DEFAULTS.backgroundNeutralization);
  const [scnrAmount, setScnrAmount] = useState(DEFAULTS.scnrAmount);
  const [sharpenAmount, setSharpenAmount] = useState(DEFAULTS.sharpenAmount);
  const [sharpenRadius, setSharpenRadius] = useState(DEFAULTS.sharpenRadius);
  const [denoiseAmount, setDenoiseAmount] = useState(DEFAULTS.denoiseAmount);
  const [denoiseRadius, setDenoiseRadius] = useState(DEFAULTS.denoiseRadius);
  const [backgroundExtractionAmount, setBackgroundExtractionAmount] = useState(DEFAULTS.backgroundExtractionAmount);
  const [hotPixelThreshold, setHotPixelThreshold] = useState(DEFAULTS.hotPixelThreshold);
  const [colorMap, setColorMap] = useState(DEFAULTS.colorMap);
  const [fullscreen, setFullscreen] = useState(false);
  const [outputName, setOutputName] = useState(() => defaultOutputName(image.filename));
  const [previewReady, setPreviewReady] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();
  const { data: metadata } = useQuery<FitsMetadata>({
    queryKey: ['/api/fits', image.id, 'metadata'],
    queryFn: async () => (await apiRequest('GET', `/api/fits/${image.id}/metadata`)).json(),
    enabled: fitsImage,
  });
  const previewUrl = useMemo(() => {
    const params = new URLSearchParams({
      stretch, strength: String(strength), gamma: String(gamma), midtones: String(midtones), saturation: String(saturation),
      redBalance: String(redBalance), greenBalance: String(greenBalance), blueBalance: String(blueBalance),
      shadowPercentile: String(shadowPercentile / 100), highlightPercentile: String(highlightPercentile / 100),
      scnrAmount: String(scnrAmount), sharpenAmount: String(sharpenAmount), sharpenRadius: String(sharpenRadius),
      denoiseAmount: String(denoiseAmount), denoiseRadius: String(denoiseRadius),
      backgroundExtractionAmount: String(backgroundExtractionAmount), hotPixelThreshold: String(hotPixelThreshold),
      colorMap,
    });
    params.set('backgroundNeutralization', String(backgroundNeutralization));
    if (!fullscreen) params.set('preview', 'interactive');
    return `/api/fits/${image.id}/preview?${params.toString()}`;
  }, [image.id, stretch, strength, gamma, midtones, saturation, redBalance, greenBalance, blueBalance, shadowPercentile, highlightPercentile, backgroundNeutralization, scnrAmount, sharpenAmount, sharpenRadius, denoiseAmount, denoiseRadius, backgroundExtractionAmount, hotPixelThreshold, colorMap, fullscreen]);

  useEffect(() => {
    setOutputName(defaultOutputName(image.filename));
  }, [image.id, image.filename]);

  const settledPreviewUrl = useDebounce(previewUrl, 90);
  // A failed render (server busy or restarting, dropped connection) is retried twice before an error shows.
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const debouncedPreviewUrl = previewAttempt ? `${settledPreviewUrl}&retry=${previewAttempt}` : settledPreviewUrl;

  useEffect(() => {
    if (!fitsImage) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewAttempt(0);
  }, [fitsImage, settledPreviewUrl]);

  const handlePreviewLoad = useCallback(() => {
    setPreviewLoading(false);
    setPreviewError(null);
    setPreviewReady(true);
  }, []);

  const handlePreviewError = useCallback(() => {
    if (previewAttempt < 2) {
      window.setTimeout(() => setPreviewAttempt(attempt => attempt + 1), 1200 * (previewAttempt + 1));
      return;
    }
    setPreviewLoading(false);
    setPreviewError('Preview failed: the server did not return an image (it may be restarting or busy). Change a setting to try again.');
  }, [previewAttempt]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen]);

  const current = {
    stretch, strength, shadowPercentile, highlightPercentile, gamma, midtones, saturation, redBalance, greenBalance,
    blueBalance, backgroundNeutralization, scnrAmount, sharpenAmount, sharpenRadius, denoiseAmount, denoiseRadius,
    backgroundExtractionAmount, hotPixelThreshold, colorMap,
  };
  const changedCount = (Object.keys(DEFAULTS) as Array<keyof typeof DEFAULTS>).filter(key => current[key] !== DEFAULTS[key]).length
    + (outputName !== defaultOutputName(image.filename) ? 1 : 0);
  const resetAll = () => {
    setStretch(DEFAULTS.stretch); setStrength(DEFAULTS.strength); setShadowPercentile(DEFAULTS.shadowPercentile);
    setHighlightPercentile(DEFAULTS.highlightPercentile); setGamma(DEFAULTS.gamma); setMidtones(DEFAULTS.midtones);
    setSaturation(DEFAULTS.saturation); setRedBalance(DEFAULTS.redBalance); setGreenBalance(DEFAULTS.greenBalance);
    setBlueBalance(DEFAULTS.blueBalance); setBackgroundNeutralization(DEFAULTS.backgroundNeutralization);
    setScnrAmount(DEFAULTS.scnrAmount); setSharpenAmount(DEFAULTS.sharpenAmount); setSharpenRadius(DEFAULTS.sharpenRadius);
    setDenoiseAmount(DEFAULTS.denoiseAmount); setDenoiseRadius(DEFAULTS.denoiseRadius);
    setBackgroundExtractionAmount(DEFAULTS.backgroundExtractionAmount); setHotPixelThreshold(DEFAULTS.hotPixelThreshold);
    setColorMap(DEFAULTS.colorMap); setOutputName(defaultOutputName(image.filename));
  };
  const resetAllButton = <Button type="button" variant="outline" size="sm" onClick={resetAll} disabled={changedCount === 0}
    title={changedCount ? 'Restore every option to its default' : 'Every option is at its default'}>
    <RotateCcw className="mr-2 h-4 w-4" />Reset all{changedCount ? ` (${changedCount} changed)` : ''}
  </Button>;

  if (!fitsImage) return null;

  const saveDerivative = async () => {
    setSaving(true);
    try {
      const response = await apiRequest('POST', `/api/fits/${image.id}/process`, {
        stretch,
        strength,
        gamma,
        midtones,
        saturation,
        redBalance,
        greenBalance,
        blueBalance,
        shadowPercentile: shadowPercentile / 100,
        highlightPercentile: highlightPercentile / 100,
        backgroundNeutralization,
        scnrAmount,
        sharpenAmount,
        sharpenRadius,
        denoiseAmount,
        denoiseRadius,
        backgroundExtractionAmount,
        hotPixelThreshold,
        outputName,
      });
      const data = await response.json();
      toast({ title: 'Processed FITS created', description: `${data.output} was saved as a separate derivative.` });
      queryClient.invalidateQueries({ queryKey: ['/api/images'] });
      queryClient.invalidateQueries({ queryKey: ['/api/tags'] });
      queryClient.invalidateQueries({ queryKey: ['/api/stats'] });
    } catch (error) {
      toast({ title: 'FITS processing failed', description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <details className="bg-muted/30 rounded-xl p-4 border border-red-500/30">
      <summary className="cursor-pointer font-semibold text-foreground"><Sparkles className="inline h-4 w-4 mr-2 text-red-400" />FITS processing</summary>
      <div className="pt-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {metadata ? <p className="text-xs text-muted-foreground font-mono">{metadata.width}×{metadata.height} · {metadata.channels === 3 ? 'RGB' : 'Mono'} · BITPIX {metadata.bitpix}</p> : <span />}
        {resetAllButton}
      </div>
      <div className="relative h-64 rounded-md bg-black overflow-hidden">
        {!fullscreen && <DeepZoomViewer
          imageUrl={debouncedPreviewUrl}
          height="100%"
          zoomPosition="top-right"
          preserveViewport
          onLoad={handlePreviewLoad}
          onError={handlePreviewError}
        />}
        {!previewReady && !previewError && <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground pointer-events-none">Rendering preview…</div>}
        {previewReady && previewLoading && <span className="absolute left-1/2 top-2 -translate-x-1/2 rounded bg-black/70 px-2 py-1 text-xs text-white pointer-events-none">Updating preview…</span>}
        {previewError && <div className="absolute inset-0 grid place-items-center px-3 text-sm text-red-300 bg-black/80">{previewError}</div>}
        {previewReady && <button
          type="button"
          onClick={() => setFullscreen(true)}
          aria-label="View preview full screen"
          title="View full screen"
          className="absolute left-2 top-2 rounded bg-black/70 p-1.5 text-white hover:bg-black/90"
        >
          <Maximize2 className="h-4 w-4" />
        </button>}
        <p className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-black/60 px-2 py-0.5 text-[10px] text-white/70 pointer-events-none">Scroll or pinch to zoom · drag to pan</p>
      </div>
      {fullscreen && <div className="fixed inset-0 z-50 flex flex-col bg-black" role="dialog" aria-modal="true" aria-label={`Full screen preview of ${image.title}`}>
        <div className="relative flex items-center justify-between gap-2 p-3">
          <span className="truncate text-sm text-white/80">{image.title}</span>
          <button type="button" onClick={() => setFullscreen(false)} aria-label="Exit full screen" title="Exit full screen" className="rounded bg-white/10 p-2 text-white hover:bg-white/20">
            <Minimize2 className="h-5 w-5" />
          </button>
        </div>
        <div className="relative flex-1 overflow-hidden">
          <DeepZoomViewer
            imageUrl={debouncedPreviewUrl}
            height="100%"
            zoomPosition="top-right"
            preserveViewport
            onLoad={handlePreviewLoad}
            onError={handlePreviewError}
          />
          {previewLoading && <span className="absolute left-1/2 top-3 -translate-x-1/2 rounded bg-black/70 px-2 py-1 text-xs text-white pointer-events-none">Updating preview…</span>}
        </div>
      </div>}
      <details open className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Stretch & contrast</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1 text-sm"><span className="flex items-center justify-between text-muted-foreground"><span>Stretch</span><ResetButton label="Stretch" changed={stretch !== DEFAULTS.stretch} onReset={() => setStretch(DEFAULTS.stretch)} /></span>
            <select aria-label="Stretch" value={stretch} onChange={(event) => setStretch(event.target.value)} className="w-full bg-background border border-input rounded-md px-2 py-1">
              <option value="linear">Linear</option><option value="asinh">Asinh (recommended)</option><option value="log">Logarithmic</option><option value="sqrt">Square root</option><option value="square">Squared</option><option value="gamma">Gamma</option><option value="mtf">Midtones (MTF)</option>
            </select>
          </div>
          {stretch === 'asinh' && <SliderField label="Asinh strength (beta)" value={strength} defaultValue={DEFAULTS.strength} min={1} max={100} step={1} onChange={setStrength} />}
          {stretch === 'log' && <SliderField label="Logarithmic gain" value={strength} defaultValue={DEFAULTS.strength} min={0.1} max={100} step={0.1} onChange={setStrength} />}
          <SliderField label="Shadow clipping" value={shadowPercentile} defaultValue={DEFAULTS.shadowPercentile} min={0} max={10} step={0.1} suffix="%" onChange={setShadowPercentile} />
          <SliderField label="Highlight clipping" value={highlightPercentile} defaultValue={DEFAULTS.highlightPercentile} min={90} max={100} step={0.1} suffix="%" onChange={setHighlightPercentile} />
          {stretch === 'gamma' && <SliderField label="Gamma" value={gamma} defaultValue={DEFAULTS.gamma} min={0.2} max={4} step={0.05} onChange={setGamma} />}
          {stretch === 'mtf' && <SliderField label="Midtones balance" value={midtones} defaultValue={DEFAULTS.midtones} min={0.02} max={0.9} step={0.01} onChange={setMidtones} />}
        </div>
      </details>
      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Display colour map</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1 text-sm"><span className="flex items-center justify-between text-muted-foreground"><span>Palette</span><ResetButton label="Palette" changed={colorMap !== DEFAULTS.colorMap} onReset={() => setColorMap(DEFAULTS.colorMap)} /></span>
            <select aria-label="Palette" value={colorMap} onChange={(event) => setColorMap(event.target.value)} className="w-full bg-background border border-input rounded-md px-2 py-1">
              <option value="original">Original (no colour map)</option><option value="grey">Grey</option><option value="inverted">Inverted</option><option value="heat">Heat</option><option value="cool">Cool</option><option value="rainbow">Rainbow</option><option value="viridis">Viridis</option>
            </select>
          </div>
          <p className="text-xs text-muted-foreground self-center">Preview only — saved derivatives always keep their real pixel data.</p>
        </div>
      </details>
      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Noise &amp; detail</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SliderField label="Unsharp mask amount" value={sharpenAmount} defaultValue={DEFAULTS.sharpenAmount} min={0} max={2} step={0.05} onChange={setSharpenAmount} />
          <SliderField label="Unsharp mask radius" value={sharpenRadius} defaultValue={DEFAULTS.sharpenRadius} min={1} max={4} step={1} suffix="px" onChange={setSharpenRadius} />
          <SliderField label="Noise reduction" value={denoiseAmount} defaultValue={DEFAULTS.denoiseAmount} min={0} max={1} step={0.05} onChange={setDenoiseAmount} />
          <SliderField label="Noise reduction radius" value={denoiseRadius} defaultValue={DEFAULTS.denoiseRadius} min={1} max={4} step={1} suffix="px" onChange={setDenoiseRadius} />
          <SliderField label="Hot/cold pixel removal" value={hotPixelThreshold} defaultValue={DEFAULTS.hotPixelThreshold} min={0} max={10} step={0.5} onChange={setHotPixelThreshold} />
          <SliderField label="Background extraction" value={backgroundExtractionAmount} defaultValue={DEFAULTS.backgroundExtractionAmount} min={0} max={1} step={0.05} onChange={setBackgroundExtractionAmount} />
        </div>
      </details>
      {metadata?.channels === 3 && <details open className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Colour calibration</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SliderField label="Saturation" value={saturation} defaultValue={DEFAULTS.saturation} min={0} max={3} step={0.05} onChange={setSaturation} />
          <span className="flex items-center gap-2 text-sm text-muted-foreground"><label className="flex items-center gap-2"><input type="checkbox" checked={backgroundNeutralization} onChange={(event) => setBackgroundNeutralization(event.target.checked)} /> Per-channel background neutralization</label><ResetButton label="background neutralization" changed={backgroundNeutralization !== DEFAULTS.backgroundNeutralization} onReset={() => setBackgroundNeutralization(DEFAULTS.backgroundNeutralization)} /></span>
          <SliderField label="Red balance" value={redBalance} defaultValue={DEFAULTS.redBalance} min={0} max={2} step={0.01} onChange={setRedBalance} />
          <SliderField label="Green balance" value={greenBalance} defaultValue={DEFAULTS.greenBalance} min={0} max={2} step={0.01} onChange={setGreenBalance} />
          <SliderField label="Blue balance" value={blueBalance} defaultValue={DEFAULTS.blueBalance} min={0} max={2} step={0.01} onChange={setBlueBalance} />
          <SliderField label="Green noise reduction (SCNR)" value={scnrAmount} defaultValue={DEFAULTS.scnrAmount} min={0} max={1} step={0.05} onChange={setScnrAmount} />
        </div>
      </details>}
      {metadata?.channels !== 3 && <span className="flex items-center gap-2 text-sm text-muted-foreground"><label className="flex items-center gap-2"><input type="checkbox" checked={backgroundNeutralization} onChange={(event) => setBackgroundNeutralization(event.target.checked)} /> Background neutralization</label><ResetButton label="background neutralization" changed={backgroundNeutralization !== DEFAULTS.backgroundNeutralization} onReset={() => setBackgroundNeutralization(DEFAULTS.backgroundNeutralization)} /></span>}
      {resetAllButton}
      <div className="block space-y-1 text-sm"><span className="flex items-center justify-between text-muted-foreground"><span>New FITS filename</span><ResetButton label="filename" changed={outputName !== defaultOutputName(image.filename)} onReset={() => setOutputName(defaultOutputName(image.filename))} /></span><input aria-label="New FITS filename" value={outputName} onChange={event => setOutputName(event.target.value)} placeholder="my-processed-image" className="w-full rounded-md border border-input bg-background px-2 py-1" /><span className="text-xs text-muted-foreground">Saved separately in the FITS derivatives folder. The source is never changed.</span></div>
      <Button type="button" onClick={saveDerivative} disabled={saving} className="w-full sky-button-primary">
        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />} Save processed FITS
      </Button>
      <p className="text-xs text-muted-foreground">Creates a new float FITS derivative. The source file is never changed.</p>
      </div>
    </details>
  );
}
