import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Maximize2, Minimize2, RotateCcw, Save, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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

function SliderField({ label, value, min, max, step, onChange, suffix = '' }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; suffix?: string }) {
  return <label className="space-y-1 block">
    <span className="flex justify-between text-xs text-muted-foreground"><span>{label}</span><span className="font-mono">{value}{suffix}</span></span>
    <input className="w-full accent-primary" type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} />
  </label>;
}

export function FitsProcessingPanel({ image }: { image: AstroImage }) {
  const fitsImage = isFits(image);
  const [stretch, setStretch] = useState('asinh');
  const [strength, setStrength] = useState(10);
  const [shadowPercentile, setShadowPercentile] = useState(0.5);
  const [highlightPercentile, setHighlightPercentile] = useState(99.5);
  const [gamma, setGamma] = useState(2.2);
  const [midtones, setMidtones] = useState(0.25);
  const [saturation, setSaturation] = useState(1);
  const [redBalance, setRedBalance] = useState(1);
  const [greenBalance, setGreenBalance] = useState(1);
  const [blueBalance, setBlueBalance] = useState(1);
  const [backgroundNeutralization, setBackgroundNeutralization] = useState(true);
  const [scnrAmount, setScnrAmount] = useState(0);
  const [sharpenAmount, setSharpenAmount] = useState(0);
  const [sharpenRadius, setSharpenRadius] = useState(1);
  const [denoiseAmount, setDenoiseAmount] = useState(0);
  const [denoiseRadius, setDenoiseRadius] = useState(1);
  const [backgroundExtractionAmount, setBackgroundExtractionAmount] = useState(0);
  const [hotPixelThreshold, setHotPixelThreshold] = useState(0);
  const [colorMap, setColorMap] = useState('grey');
  const [fullscreen, setFullscreen] = useState(false);
  const [outputName, setOutputName] = useState(() => image.filename.replace(/\.(fit|fits|fts)$/i, '') + '-processed');
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
    if (backgroundNeutralization) params.set('backgroundNeutralization', 'true');
    if (!fullscreen) params.set('preview', 'interactive');
    return `/api/fits/${image.id}/preview?${params.toString()}`;
  }, [image.id, stretch, strength, gamma, midtones, saturation, redBalance, greenBalance, blueBalance, shadowPercentile, highlightPercentile, backgroundNeutralization, scnrAmount, sharpenAmount, sharpenRadius, denoiseAmount, denoiseRadius, backgroundExtractionAmount, hotPixelThreshold, colorMap, fullscreen]);

  useEffect(() => {
    setOutputName(image.filename.replace(/\.(fit|fits|fts)$/i, '') + '-processed');
  }, [image.id, image.filename]);

  const debouncedPreviewUrl = useDebounce(previewUrl, 90);

  useEffect(() => {
    if (!fitsImage) return;
    setPreviewLoading(true);
    setPreviewError(null);
  }, [fitsImage, debouncedPreviewUrl]);

  const handlePreviewLoad = useCallback(() => {
    setPreviewLoading(false);
    setPreviewError(null);
    setPreviewReady(true);
  }, []);

  const handlePreviewError = useCallback(() => {
    setPreviewLoading(false);
    setPreviewError('Preview failed');
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen]);

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
    <section className="bg-muted/30 rounded-xl p-4 border border-red-500/30 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-foreground flex items-center gap-2"><Sparkles className="h-4 w-4 text-red-400" /> FITS processing</h3>
        <Badge className="bg-red-700 text-white border-red-500">FITS</Badge>
      </div>
      {metadata && <p className="text-xs text-muted-foreground font-mono">{metadata.width}×{metadata.height} · {metadata.channels === 3 ? 'RGB' : 'Mono'} · BITPIX {metadata.bitpix}</p>}
      <div className="relative h-64 rounded-md bg-black overflow-hidden">
        {!fullscreen && <DeepZoomViewer
          imageUrl={debouncedPreviewUrl}
          height="100%"
          preserveViewport
          onLoad={handlePreviewLoad}
          onError={handlePreviewError}
        />}
        {!previewReady && !previewError && <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground pointer-events-none">Rendering preview…</div>}
        {previewReady && previewLoading && <span className="absolute right-2 top-2 rounded bg-black/70 px-2 py-1 text-xs text-white pointer-events-none">Updating preview…</span>}
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
        <div className="flex items-center justify-between gap-2 p-3">
          <span className="truncate text-sm text-white/80">{image.title}</span>
          <button type="button" onClick={() => setFullscreen(false)} aria-label="Exit full screen" title="Exit full screen" className="rounded bg-white/10 p-2 text-white hover:bg-white/20">
            <Minimize2 className="h-5 w-5" />
          </button>
        </div>
        <div className="relative flex-1 overflow-hidden">
          <DeepZoomViewer
            imageUrl={debouncedPreviewUrl}
            height="100%"
            preserveViewport
            onLoad={handlePreviewLoad}
            onError={handlePreviewError}
          />
          {previewLoading && <span className="absolute right-3 top-3 rounded bg-black/70 px-2 py-1 text-xs text-white pointer-events-none">Updating preview…</span>}
        </div>
      </div>}
      <details open className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Stretch & contrast</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm"><span className="text-muted-foreground">Stretch</span>
            <select value={stretch} onChange={(event) => setStretch(event.target.value)} className="w-full bg-background border border-input rounded-md px-2 py-1">
              <option value="linear">Linear</option><option value="asinh">Asinh (recommended)</option><option value="log">Logarithmic</option><option value="sqrt">Square root</option><option value="square">Squared</option><option value="gamma">Gamma</option><option value="mtf">Midtones (MTF)</option>
            </select>
          </label>
          {stretch === 'asinh' && <SliderField label="Asinh strength (beta)" value={strength} min={1} max={100} step={1} onChange={setStrength} />}
          {stretch === 'log' && <SliderField label="Logarithmic gain" value={strength} min={0.1} max={100} step={0.1} onChange={setStrength} />}
          <SliderField label="Shadow clipping" value={shadowPercentile} min={0} max={10} step={0.1} suffix="%" onChange={setShadowPercentile} />
          <SliderField label="Highlight clipping" value={highlightPercentile} min={90} max={100} step={0.1} suffix="%" onChange={setHighlightPercentile} />
          {stretch === 'gamma' && <SliderField label="Gamma" value={gamma} min={0.2} max={4} step={0.05} onChange={setGamma} />}
          {stretch === 'mtf' && <SliderField label="Midtones balance" value={midtones} min={0.02} max={0.9} step={0.01} onChange={setMidtones} />}
        </div>
      </details>
      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Display colour map</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm"><span className="text-muted-foreground">Palette</span>
            <select value={colorMap} onChange={(event) => setColorMap(event.target.value)} className="w-full bg-background border border-input rounded-md px-2 py-1">
              <option value="grey">Grey</option><option value="inverted">Inverted</option><option value="heat">Heat</option><option value="cool">Cool</option><option value="rainbow">Rainbow</option><option value="viridis">Viridis</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground self-center">Preview only — saved derivatives always keep their real pixel data.</p>
        </div>
      </details>
      <details className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Noise &amp; detail</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SliderField label="Unsharp mask amount" value={sharpenAmount} min={0} max={2} step={0.05} onChange={setSharpenAmount} />
          <SliderField label="Unsharp mask radius" value={sharpenRadius} min={1} max={4} step={1} suffix="px" onChange={setSharpenRadius} />
          <SliderField label="Noise reduction" value={denoiseAmount} min={0} max={1} step={0.05} onChange={setDenoiseAmount} />
          <SliderField label="Noise reduction radius" value={denoiseRadius} min={1} max={4} step={1} suffix="px" onChange={setDenoiseRadius} />
          <SliderField label="Hot/cold pixel removal" value={hotPixelThreshold} min={0} max={10} step={0.5} onChange={setHotPixelThreshold} />
          <SliderField label="Background extraction" value={backgroundExtractionAmount} min={0} max={1} step={0.05} onChange={setBackgroundExtractionAmount} />
        </div>
      </details>
      {metadata?.channels === 3 && <details open className="rounded-md border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Colour calibration</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SliderField label="Saturation" value={saturation} min={0} max={3} step={0.05} onChange={setSaturation} />
          <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={backgroundNeutralization} onChange={(event) => setBackgroundNeutralization(event.target.checked)} /> Per-channel background neutralization</label>
          <SliderField label="Red balance" value={redBalance} min={0} max={2} step={0.01} onChange={setRedBalance} />
          <SliderField label="Green balance" value={greenBalance} min={0} max={2} step={0.01} onChange={setGreenBalance} />
          <SliderField label="Blue balance" value={blueBalance} min={0} max={2} step={0.01} onChange={setBlueBalance} />
          <SliderField label="Green noise reduction (SCNR)" value={scnrAmount} min={0} max={1} step={0.05} onChange={setScnrAmount} />
        </div>
      </details>}
      {metadata?.channels !== 3 && <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={backgroundNeutralization} onChange={(event) => setBackgroundNeutralization(event.target.checked)} /> Background neutralization</label>}
      <Button type="button" variant="outline" size="sm" onClick={() => { setStretch('asinh'); setStrength(10); setShadowPercentile(0.5); setHighlightPercentile(99.5); setGamma(2.2); setMidtones(0.25); setSaturation(1); setRedBalance(1); setGreenBalance(1); setBlueBalance(1); setBackgroundNeutralization(true); setScnrAmount(0); setSharpenAmount(0); setSharpenRadius(1); setDenoiseAmount(0); setDenoiseRadius(1); setBackgroundExtractionAmount(0); setHotPixelThreshold(0); setColorMap('grey'); }}><RotateCcw className="mr-2 h-4 w-4" />Reset controls</Button>
      <label className="block space-y-1 text-sm"><span className="text-muted-foreground">New FITS filename</span><input value={outputName} onChange={event => setOutputName(event.target.value)} placeholder="my-processed-image" className="w-full rounded-md border border-input bg-background px-2 py-1" /><span className="text-xs text-muted-foreground">Saved separately in the FITS derivatives folder. The source is never changed.</span></label>
      <Button type="button" onClick={saveDerivative} disabled={saving} className="w-full sky-button-primary">
        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />} Save processed FITS
      </Button>
      <p className="text-xs text-muted-foreground">Creates a new float FITS derivative. The source file is never changed.</p>
    </section>
  );
}
