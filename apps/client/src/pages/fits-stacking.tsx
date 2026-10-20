import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Layers, CheckCircle, AlertCircle, Loader, Info, Library, Star, X, Save, Search } from 'lucide-react';
import { Header } from '@/components/header';
import { apiRequest, queryClient as sharedQueryClient } from '@/lib/queryClient';
import type { AstroImage } from '@shared/schema';
import type { GalleryCatalogSummary } from '@/components/gallery-catalog-picker';

type StackFrameReport = { name: string; used: boolean; method?: string; dx?: number; dy?: number; reason?: string };
type StackResponse = { frameCount: number; frames?: StackFrameReport[]; warnings?: string[]; engine?: { name: string; ccdproc: string } };
import { formatDayHeading, formatTime } from "@/lib/datetime";
import { filterInfo, groupByDateAndFilter } from "@shared/fits-groups";
import { GALLERY_GRID } from "@/components/image-gallery";
import { checkSelection, SelectionNotes, StackingGuide } from "@/components/stacking-guide";
import { useCurrentUser } from '@/hooks/use-current-user';

/** Frame size as written by the FITS importer into the description ("FITS 9576×6388 · mono · 16-bit"). */
function frameSize(image: AstroImage): string | null {
  const match = image.description?.match(/FITS\s+(\d+)\s*×\s*(\d+)/);
  return match ? `${match[1]}×${match[2]}` : null;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Failed to stack frames.';
  const text = error.message.replace(/^\d+:\s*/, '');
  try { return JSON.parse(text).message || text; } catch { return text; }
}

export default function FitsStackingPage() {
  const queryClient = useQueryClient();
  const { canEdit } = useCurrentUser();
  // Selection order matters: the first frame is the alignment reference.
  const [selected, setSelected] = useState<number[]>([]);
  const [method, setMethod] = useState<'sigma-clip' | 'mean' | 'median' | 'sum'>('sigma-clip');
  const [register, setRegister] = useState(true);
  const [outputName, setOutputName] = useState('stacked');
  const [normalization, setNormalization] = useState<'none' | 'exposure' | 'median'>('exposure');
  const [weighting, setWeighting] = useState<'none' | 'exposure' | 'inverse-variance'>('none');
  const [interpolation, setInterpolation] = useState<'nearest-neighbor' | 'bilinear' | 'biquadratic' | 'bicubic'>('bilinear');
  const [sigmaClipLow, setSigmaClipLow] = useState('3');
  const [sigmaClipHigh, setSigmaClipHigh] = useState('3');
  const [memoryLimitMb, setMemoryLimitMb] = useState('512');
  const [masterBiasId, setMasterBiasId] = useState('none');
  const [masterDarkId, setMasterDarkId] = useState('none');
  const [masterFlatId, setMasterFlatId] = useState('none');
  const [badPixelMaskId, setBadPixelMaskId] = useState('none');
  const [ccdMaskRatioId, setCcdMaskRatioId] = useState('none');
  const [gain, setGain] = useState('');
  const [readNoise, setReadNoise] = useState('');
  const [flatMinimum, setFlatMinimum] = useState('');
  const [overscan, setOverscan] = useState('');
  const [overscanMedian, setOverscanMedian] = useState(true);
  const [overscanPolynomialDegree, setOverscanPolynomialDegree] = useState('');
  const [trim, setTrim] = useState('');
  const [exposureKeyword, setExposureKeyword] = useState('EXPTIME');
  const [darkScale, setDarkScale] = useState(true);
  const [calibrationMastersGainCorrected, setCalibrationMastersGainCorrected] = useState(false);
  const [cosmicMethod, setCosmicMethod] = useState<'none' | 'lacosmic' | 'median'>('none');
  const [cosmicSigma, setCosmicSigma] = useState('4.5');
  const [cosmicFraction, setCosmicFraction] = useState('0.3');
  const [cosmicObjectLimit, setCosmicObjectLimit] = useState('5');
  const [cosmicIterations, setCosmicIterations] = useState('4');
  const [cosmicCleanType, setCosmicCleanType] = useState<'median' | 'medmask' | 'meanmask' | 'idw'>('meanmask');
  const [cosmicSeparateMedian, setCosmicSeparateMedian] = useState(true);
  const [cosmicFineStructureMode, setCosmicFineStructureMode] = useState<'median' | 'convolve'>('median');
  const [cosmicPsfModel, setCosmicPsfModel] = useState<'gauss' | 'gaussx' | 'gaussy' | 'moffat'>('gauss');
  const [cosmicPsfFwhm, setCosmicPsfFwhm] = useState('2.5');
  const [cosmicPsfSize, setCosmicPsfSize] = useState('7');
  const [cosmicPsfBeta, setCosmicPsfBeta] = useState('4.765');
  const [saturationLevel, setSaturationLevel] = useState('');
  const [medianCosmicThreshold, setMedianCosmicThreshold] = useState('5');
  const [medianCosmicBox, setMedianCosmicBox] = useState('11');
  const [medianCosmicGrowBox, setMedianCosmicGrowBox] = useState('0');
  const [medianCosmicReplaceBox, setMedianCosmicReplaceBox] = useState('11');
  const [ccdMaskFindBadColumns, setCcdMaskFindBadColumns] = useState(false);
  const [ccdMaskByBlocks, setCcdMaskByBlocks] = useState(false);
  const [ccdMaskLowSigma, setCcdMaskLowSigma] = useState('9');
  const [ccdMaskHighSigma, setCcdMaskHighSigma] = useState('9');
  const [ccdMaskColumnMedian, setCcdMaskColumnMedian] = useState('7');
  const [ccdMaskLineMedian, setCcdMaskLineMedian] = useState('7');
  const [ccdMaskColumnSigmaBox, setCcdMaskColumnSigmaBox] = useState('15');
  const [ccdMaskLineSigmaBox, setCcdMaskLineSigmaBox] = useState('15');
  const [ccdMaskGoodPixelGap, setCcdMaskGoodPixelGap] = useState('5');
  const [clipExtrema, setClipExtrema] = useState(false);
  const [clipLowCount, setClipLowCount] = useState('1');
  const [clipHighCount, setClipHighCount] = useState('1');
  const [minimumClip, setMinimumClip] = useState('');
  const [maximumClip, setMaximumClip] = useState('');
  const [catalogFilter, setCatalogFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [saveName, setSaveName] = useState('');
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const { data: images = [], isLoading } = useQuery<AstroImage[]>({
    queryKey: ['/api/fits'],
    queryFn: async () => (await apiRequest('GET', '/api/fits')).json(),
  });
  const { data: catalogs = [] } = useQuery<GalleryCatalogSummary[]>({ queryKey: ['/api/gallery-catalogs'] });
  const catalogId = catalogFilter === 'all' ? undefined : Number(catalogFilter);
  const { data: catalogImages } = useQuery<AstroImage[]>({
    queryKey: ['/api/images', { galleryCatalogId: catalogId }],
    enabled: catalogId !== undefined,
  });

  const byId = useMemo(() => new Map(images.map(image => [image.id, image])), [images]);
  const catalogFrameIds = useMemo(() => {
    if (catalogId === undefined || !catalogImages) return null;
    return new Set(catalogImages.filter(image => byId.has(image.id)).map(image => image.id));
  }, [catalogId, catalogImages, byId]);

  const visible = images.filter(image => {
    if (catalogFrameIds && !catalogFrameIds.has(image.id)) return false;
    if (!search.trim()) return true;
    const query = search.trim().toLowerCase();
    return [image.title, image.filename, image.targetName, image.filters, image.camera]
      .some(value => value?.toLowerCase().includes(query));
  });

  const reference = selected.length > 0 ? byId.get(selected[0]) : undefined;
  const referenceSize = reference ? frameSize(reference) : null;
  const mismatched = selected.filter(id => {
    const image = byId.get(id);
    return referenceSize && image && frameSize(image) && frameSize(image) !== referenceSize;
  });

  const toggle = (id: number) => setSelected(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]);
  const makeReference = (id: number) => setSelected(previous => [id, ...previous.filter(item => item !== id)]);
  const addAll = (ids: number[]) => setSelected(previous => [...previous, ...ids.filter(id => !previous.includes(id))]);
  const only = (ids: number[]) => setSelected(ids);

  // Frames of the same field (plate solutions close together share an album) → night → filter.
  const fieldGroups = useMemo(() => {
    const groups = new Map<string, { key: string; name: string; frames: AstroImage[]; unsolved: boolean }>();
    for (const image of visible) {
      const catalog = catalogs.find(item => item.name !== 'Solar System' && item.imageIds?.includes(image.id))
        ?? catalogs.find(item => item.imageIds?.includes(image.id));
      const key = catalog ? `catalog-${catalog.id}` : 'unclassified';
      const group = groups.get(key) ?? { key, name: catalog?.name ?? 'Not classified yet', frames: [], unsolved: !catalog };
      group.frames.push(image);
      groups.set(key, group);
    }
    const latest = (frames: AstroImage[]) => Math.max(...frames.map(image => image.captureDate ? new Date(image.captureDate).getTime() : 0));
    return [...groups.values()].sort((a, b) => Number(a.unsolved) - Number(b.unsolved) || latest(b.frames) - latest(a.frames));
  }, [visible, catalogs]);

  const albumOf = (id: number) => (catalogs.find(item => item.name !== 'Solar System' && item.imageIds?.includes(id))
    ?? catalogs.find(item => item.imageIds?.includes(id)))?.name ?? null;
  const selectionNotes = checkSelection(selected.map(id => byId.get(id)).filter((image): image is AstroImage => Boolean(image)), albumOf);

  // The server refuses stacks that mix filters; say so before submitting.
  const selectedFilters = [...new Set(selected.map(id => filterInfo(byId.get(id)?.filters).code))];

  const renderFrame = (image: AstroImage) => {
    const position = selected.indexOf(image.id);
    const isSelected = position >= 0;
    const size = frameSize(image);
    const sizeMismatch = Boolean(referenceSize && size && size !== referenceSize);
    return (
      <Card
        key={image.id}
        className={`cursor-pointer transition-all hover:shadow-md overflow-hidden ${isSelected ? 'ring-2 ring-primary' : ''} ${sizeMismatch && !isSelected ? 'opacity-50' : ''}`}
        onClick={() => toggle(image.id)}
        title={sizeMismatch ? `Different size from the reference (${size} vs ${referenceSize})` : undefined}
      >
        <CardContent className="p-0">
          <div className="relative">
            <div className="aspect-square bg-muted flex items-center justify-center">
              {image.thumbnailUrl ? <img src={image.thumbnailUrl} alt={image.title} loading="lazy" className="w-full h-full object-cover" /> : <Info className="h-6 w-6 text-muted-foreground" />}
            </div>
            <div className="absolute top-2 left-2 flex items-center gap-1">
              <Checkbox checked={isSelected} onClick={event => event.stopPropagation()} onCheckedChange={() => toggle(image.id)} className="bg-white/90" />
              {isSelected && (
                <span className={`text-xs font-bold rounded px-1 ${position === 0 ? 'bg-yellow-400 text-black' : 'bg-black/70 text-white'}`}>
                  {position === 0 ? '★ ref' : position + 1}
                </span>
              )}
            </div>
            {isSelected && position > 0 && (
              <button
                className="absolute top-2 right-2 text-[10px] bg-black/70 text-white rounded px-1 hover:bg-black"
                onClick={event => { event.stopPropagation(); makeReference(image.id); }}
                title="Use this frame as the alignment reference"
              >
                ★ make ref
              </button>
            )}
            <div className="absolute bottom-0 inset-x-0 bg-black/60 px-2 py-1">
              <p className="text-xs text-white truncate">{image.title}</p>
              <p className="text-[10px] text-gray-300 truncate">
                {[image.captureDate ? formatTime(image.captureDate) : null, image.exposureTime, size, image.originalPath?.startsWith('fits-derived://') ? 'stack' : null].filter(Boolean).join(' · ')}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  const GroupButtons = ({ ids }: { ids: number[] }) => (
    <span className="ml-auto flex gap-1" onClick={event => event.preventDefault()}>
      <button type="button" className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground" onClick={() => addAll(ids)} title="Add these frames to the selection">+ select</button>
      <button type="button" className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground" onClick={() => only(ids)} title="Select only these frames">only these</button>
    </span>
  );

  const stackMutation = useMutation<StackResponse>({
    mutationFn: async () => {
      const numeric = (value: string) => value.trim() === '' ? undefined : Number(value);
      const response = await apiRequest('POST', '/api/fits/stack', {
        imageIds: selected, method, register, outputName, normalization, weighting, interpolation,
        sigmaClipLow: numeric(sigmaClipLow), sigmaClipHigh: numeric(sigmaClipHigh), memoryLimitMb: numeric(memoryLimitMb),
        masterBiasId, masterDarkId, masterFlatId, badPixelMaskId, ccdMaskRatioId,
        gain: numeric(gain), readNoise: numeric(readNoise), flatMinimum: numeric(flatMinimum), overscan,
        overscanMedian, overscanPolynomialDegree: numeric(overscanPolynomialDegree), trim,
        exposureKeyword, darkScale, calibrationMastersGainCorrected, cosmicMethod,
        cosmicSigma: numeric(cosmicSigma), cosmicFraction: numeric(cosmicFraction),
        cosmicObjectLimit: numeric(cosmicObjectLimit), cosmicIterations: numeric(cosmicIterations), cosmicCleanType,
        cosmicSeparateMedian, cosmicFineStructureMode, cosmicPsfModel, cosmicPsfFwhm: numeric(cosmicPsfFwhm),
        cosmicPsfSize: numeric(cosmicPsfSize), cosmicPsfBeta: numeric(cosmicPsfBeta),
        saturationLevel: numeric(saturationLevel), medianCosmicThreshold: numeric(medianCosmicThreshold),
        medianCosmicBox: numeric(medianCosmicBox), medianCosmicGrowBox: numeric(medianCosmicGrowBox),
        medianCosmicReplaceBox: numeric(medianCosmicReplaceBox), ccdMaskFindBadColumns, ccdMaskByBlocks,
        ccdMaskLowSigma: numeric(ccdMaskLowSigma), ccdMaskHighSigma: numeric(ccdMaskHighSigma),
        ccdMaskColumnMedian: numeric(ccdMaskColumnMedian), ccdMaskLineMedian: numeric(ccdMaskLineMedian),
        ccdMaskColumnSigmaBox: numeric(ccdMaskColumnSigmaBox), ccdMaskLineSigmaBox: numeric(ccdMaskLineSigmaBox),
        ccdMaskGoodPixelGap: numeric(ccdMaskGoodPixelGap),
        clipExtrema, clipLowCount: numeric(clipLowCount),
        clipHighCount: numeric(clipHighCount), minimumClip: numeric(minimumClip), maximumClip: numeric(maximumClip),
      });
      return response.json() as Promise<StackResponse>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fits'] });
      sharedQueryClient.invalidateQueries({ queryKey: ['/api/images'] });
      sharedQueryClient.invalidateQueries({ queryKey: ['/api/stats'] });
      setSelected([]);
    },
  });

  const saveSelection = useMutation({
    mutationFn: async () => {
      const name = saveName.trim();
      const existing = catalogs.find(catalog => catalog.name.toLowerCase() === name.toLowerCase());
      const catalog = existing ?? await (await apiRequest('POST', '/api/gallery-catalogs', { name, description: 'FITS frames saved from Stack FITS frames' })).json() as GalleryCatalogSummary;
      const result = await (await apiRequest('POST', `/api/gallery-catalogs/${catalog.id}/images`, { imageIds: selected })).json() as { added: number };
      return { name: catalog.name, added: result.added, existed: Boolean(existing) };
    },
    onSuccess: ({ name, added, existed }) => {
      setSavedMessage(`${added} frame${added === 1 ? '' : 's'} ${existed ? 'added to' : 'saved as'} the catalog "${name}".`);
      setSaveName('');
      sharedQueryClient.invalidateQueries({ queryKey: ['/api/gallery-catalogs'] });
    },
  });

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground mb-2 flex items-center gap-2"><Layers className="h-7 w-7" /> Stack FITS frames</h1>
          <p className="text-muted-foreground">
            Reduce and combine several exposures with Astropy CCDData and CCDProc. Calibration, L.A.Cosmic cleaning,
            WCS reprojection, masks, uncertainties, normalization, weighting and rejection all run in the scientific Python pipeline.
            Pick frames one by one, or load a gallery catalog you prepared for this stack.
          </p>
          <p className="text-xs text-muted-foreground">
            Alignment uses CCDProc's WCS projection onto the first frame. Plate-solve every mono frame first, or disable alignment
            only for data already registered on the same grid. Exact duplicates are skipped. Frames must share FILTER and BUNIT.
            The output preserves the reference WCS and adds MASK and UNCERT extensions without changing any source FITS.
          </p>
        </div>

        <StackingGuide />

        <Card>
          <CardHeader>
            <CardTitle>Frames</CardTitle>
            <CardDescription>
              {selected.length} frame{selected.length === 1 ? '' : 's'} selected
              {reference && <> · reference: <span className="font-medium text-foreground">{reference.title}</span>{referenceSize && ` (${referenceSize})`}</>}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col md:flex-row gap-2">
              <Select value={catalogFilter} onValueChange={setCatalogFilter}>
                <SelectTrigger className="md:w-64"><Library className="h-4 w-4 mr-2 shrink-0" /><SelectValue placeholder="All FITS frames" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All FITS frames</SelectItem>
                  {catalogs.map(catalog => <SelectItem key={catalog.id} value={String(catalog.id)}>{catalog.name} ({catalog.imageCount})</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Filter by title, target, filter or camera" className="pl-8" />
              </div>
              <Button variant="outline" onClick={() => addAll(visible.map(image => image.id))} disabled={visible.length === 0}>
                {catalogFrameIds ? `Select catalog (${visible.length})` : `Select shown (${visible.length})`}
              </Button>
              <Button variant="ghost" onClick={() => setSelected([])} disabled={selected.length === 0}><X className="h-4 w-4 mr-1" /> Clear</Button>
            </div>
            {catalogFrameIds && catalogImages && catalogImages.length > catalogFrameIds.size && (
              <p className="text-xs text-muted-foreground">{catalogImages.length - catalogFrameIds.size} non-FITS item(s) in this catalog are not stackable and are hidden.</p>
            )}

            {selected.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selected.map((id, index) => {
                  const image = byId.get(id);
                  if (!image) return null;
                  const bad = mismatched.includes(id);
                  return (
                    <Badge key={id} variant={index === 0 ? 'default' : bad ? 'destructive' : 'secondary'} className="gap-1">
                      {index === 0 ? <Star className="h-3 w-3" /> : `${index + 1}.`} {image.title}
                      <button aria-label={`Remove ${image.title}`} onClick={() => toggle(id)}><X className="h-3 w-3" /></button>
                    </Badge>
                  );
                })}
              </div>
            )}
            <SelectionNotes notes={selectionNotes} />
            {mismatched.length > 0 && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{mismatched.length} selected frame(s) differ in size from the reference ({referenceSize}). They are aligned through their plate solution, so plate-solve them first (otherwise they are left out).</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Options</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <label className="space-y-1 text-sm block">
                <span className="text-muted-foreground">Combination method</span>
                <select value={method} onChange={event => setMethod(event.target.value as typeof method)} className="w-full bg-background border border-input rounded-md px-2 py-1">
                  <option value="sigma-clip">Sigma-clipped mean (recommended)</option>
                  <option value="mean">Mean</option>
                  <option value="median">Median</option>
                  <option value="sum">Sum</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm self-end pb-1">
                <Checkbox checked={register} onCheckedChange={checked => setRegister(checked as boolean)} />
                <span>Align frames before stacking</span>
              </label>
              <label className="space-y-1 text-sm block">
                <span className="text-muted-foreground">WCS interpolation</span>
                <select value={interpolation} onChange={event => setInterpolation(event.target.value as typeof interpolation)} className="w-full bg-background border border-input rounded-md px-2 py-1" disabled={!register}>
                  <option value="nearest-neighbor">Nearest neighbour</option><option value="bilinear">Bilinear (recommended)</option>
                  <option value="biquadratic">Biquadratic</option><option value="bicubic">Bicubic</option>
                </select>
              </label>
              <label className="space-y-1 text-sm block">
                <span className="text-muted-foreground">New FITS filename</span>
                <input value={outputName} onChange={event => setOutputName(event.target.value)} className="w-full rounded-md border border-input bg-background px-2 py-1" />
              </label>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <label className="space-y-1 text-sm"><span className="text-muted-foreground">Normalization</span>
                <select value={normalization} onChange={event => setNormalization(event.target.value as typeof normalization)} className="w-full bg-background border border-input rounded-md px-2 py-1">
                  <option value="exposure">Exposure time</option><option value="median">Image median</option><option value="none">None</option>
                </select>
              </label>
              <label className="space-y-1 text-sm"><span className="text-muted-foreground">Frame weighting</span>
                <select value={weighting} onChange={event => setWeighting(event.target.value as typeof weighting)} className="w-full bg-background border border-input rounded-md px-2 py-1">
                  <option value="none">Equal</option><option value="exposure">Exposure time</option><option value="inverse-variance">Inverse variance (MAD)</option>
                </select>
              </label>
              <label className="space-y-1 text-sm"><span className="text-muted-foreground">Exposure header</span><Input value={exposureKeyword} onChange={event => setExposureKeyword(event.target.value.toUpperCase())} maxLength={8} /></label>
              <label className="space-y-1 text-sm"><span className="text-muted-foreground">Memory limit (MiB)</span><Input type="number" min="64" max="8192" value={memoryLimitMb} onChange={event => setMemoryLimitMb(event.target.value)} /></label>
              {method === 'sigma-clip' && <>
                <label className="space-y-1 text-sm"><span className="text-muted-foreground">Low sigma</span><Input type="number" min="0.5" max="20" step="0.1" value={sigmaClipLow} onChange={event => setSigmaClipLow(event.target.value)} /></label>
                <label className="space-y-1 text-sm"><span className="text-muted-foreground">High sigma</span><Input type="number" min="0.5" max="20" step="0.1" value={sigmaClipHigh} onChange={event => setSigmaClipHigh(event.target.value)} /></label>
              </>}
            </div>

            <details className="rounded-md border border-border p-3">
              <summary className="cursor-pointer font-medium">CCD calibration and rejection (CCDProc)</summary>
              <div className="mt-4 space-y-4">
                <p className="text-xs text-muted-foreground">Optional masters are read from the FITS gallery. CCDProc applies overscan, trim, bias, dark, flat, bad-pixel mask, gain and propagated uncertainty in its standard reduction order.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {([
                    ['Master bias', masterBiasId, setMasterBiasId], ['Master dark', masterDarkId, setMasterDarkId],
                    ['Master flat', masterFlatId, setMasterFlatId], ['Bad-pixel mask', badPixelMaskId, setBadPixelMaskId],
                  ] as const).map(([label, value, setter]) => <label key={label} className="space-y-1 text-sm"><span className="text-muted-foreground">{label}</span>
                    <select value={value} onChange={event => setter(event.target.value)} className="w-full bg-background border border-input rounded-md px-2 py-1">
                      <option value="none">None</option>{images.map(image => <option key={image.id} value={String(image.id)}>{image.title} (#{image.id})</option>)}
                    </select>
                  </label>)}
                  <label className="space-y-1 text-sm"><span className="text-muted-foreground">Flat-ratio for CCD mask</span>
                    <select value={ccdMaskRatioId} onChange={event => setCcdMaskRatioId(event.target.value)} className="w-full bg-background border border-input rounded-md px-2 py-1">
                      <option value="none">None</option>{images.map(image => <option key={image.id} value={String(image.id)}>{image.title} (#{image.id})</option>)}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm"><span className="text-muted-foreground">Gain (e⁻/ADU)</span><Input type="number" min="0" step="0.001" value={gain} onChange={event => setGain(event.target.value)} placeholder="From camera/header" /></label>
                  <label className="space-y-1 text-sm"><span className="text-muted-foreground">Read noise (e⁻)</span><Input type="number" min="0" step="0.01" value={readNoise} onChange={event => setReadNoise(event.target.value)} /></label>
                  <label className="space-y-1 text-sm"><span className="text-muted-foreground">Flat minimum</span><Input type="number" min="0" step="0.001" value={flatMinimum} onChange={event => setFlatMinimum(event.target.value)} /></label>
                  <label className="flex items-end gap-2 text-sm pb-2"><Checkbox checked={darkScale} onCheckedChange={checked => setDarkScale(Boolean(checked))} /><span>Scale dark by exposure</span></label>
                  <label className="flex items-end gap-2 text-sm pb-2"><Checkbox checked={calibrationMastersGainCorrected} onCheckedChange={checked => setCalibrationMastersGainCorrected(Boolean(checked))} /><span>Masters already gain-corrected</span></label>
                  <label className="space-y-1 text-sm"><span className="text-muted-foreground">Overscan FITS section</span><Input value={overscan} onChange={event => setOverscan(event.target.value)} placeholder="[1:50,1:2048]" /></label>
                  <label className="space-y-1 text-sm"><span className="text-muted-foreground">Overscan polynomial degree</span><Input type="number" min="0" max="10" value={overscanPolynomialDegree} onChange={event => setOverscanPolynomialDegree(event.target.value)} placeholder="No fitted model" /></label>
                  <label className="flex items-end gap-2 text-sm pb-2"><Checkbox checked={overscanMedian} onCheckedChange={checked => setOverscanMedian(Boolean(checked))} /><span>Median overscan (off = mean)</span></label>
                  <label className="space-y-1 text-sm"><span className="text-muted-foreground">Trim FITS section</span><Input value={trim} onChange={event => setTrim(event.target.value)} placeholder="[51:2098,1:2048]" /></label>
                </div>

                {ccdMaskRatioId !== 'none' && <div className="rounded border border-border p-3 space-y-3">
                  <p className="text-xs text-muted-foreground">CCDProc ccdmask derives detector defects from a flat-ratio image. This is not a normal master flat.</p>
                  <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                    <label className="flex items-center gap-2 text-xs"><Checkbox checked={ccdMaskFindBadColumns} onCheckedChange={checked => setCcdMaskFindBadColumns(Boolean(checked))} /><span>Find bad columns</span></label>
                    <label className="flex items-center gap-2 text-xs"><Checkbox checked={ccdMaskByBlocks} onCheckedChange={checked => setCcdMaskByBlocks(Boolean(checked))} /><span>Estimate sigma by blocks</span></label>
                    <label className="space-y-1 text-xs"><span>Low sigma</span><Input type="number" min="1" value={ccdMaskLowSigma} onChange={event => setCcdMaskLowSigma(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>High sigma</span><Input type="number" min="1" value={ccdMaskHighSigma} onChange={event => setCcdMaskHighSigma(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>Column median box</span><Input type="number" min="1" value={ccdMaskColumnMedian} onChange={event => setCcdMaskColumnMedian(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>Line median box</span><Input type="number" min="1" value={ccdMaskLineMedian} onChange={event => setCcdMaskLineMedian(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>Column sigma box</span><Input type="number" min="10" value={ccdMaskColumnSigmaBox} onChange={event => setCcdMaskColumnSigmaBox(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>Line sigma box</span><Input type="number" min="10" value={ccdMaskLineSigmaBox} onChange={event => setCcdMaskLineSigmaBox(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>Good-pixel gap</span><Input type="number" min="0" value={ccdMaskGoodPixelGap} onChange={event => setCcdMaskGoodPixelGap(event.target.value)} /></label>
                  </div>
                </div>}

                <div className="rounded border border-border p-3 space-y-3">
                  <label className="space-y-1 text-sm block"><span className="text-muted-foreground">Single-frame cosmic-ray cleaning</span>
                    <select value={cosmicMethod} onChange={event => setCosmicMethod(event.target.value as typeof cosmicMethod)} className="w-full sm:w-80 bg-background border border-input rounded-md px-2 py-1">
                      <option value="none">None</option><option value="lacosmic">L.A.Cosmic (astroscrappy)</option><option value="median">CCDProc median technique</option>
                    </select>
                  </label>
                  {cosmicMethod === 'lacosmic' && <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
                    <label className="space-y-1 text-xs"><span>Sigma</span><Input type="number" step="0.1" value={cosmicSigma} onChange={event => setCosmicSigma(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>Neighbour fraction</span><Input type="number" step="0.01" value={cosmicFraction} onChange={event => setCosmicFraction(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>Object contrast</span><Input type="number" step="0.1" value={cosmicObjectLimit} onChange={event => setCosmicObjectLimit(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>Iterations</span><Input type="number" min="1" max="20" value={cosmicIterations} onChange={event => setCosmicIterations(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>Clean algorithm</span><select value={cosmicCleanType} onChange={event => setCosmicCleanType(event.target.value as typeof cosmicCleanType)} className="w-full h-9 bg-background border border-input rounded-md px-2"><option value="meanmask">Masked mean</option><option value="medmask">Masked median</option><option value="median">Median</option><option value="idw">IDW</option></select></label>
                    <label className="space-y-1 text-xs"><span>Saturation</span><Input type="number" value={saturationLevel} onChange={event => setSaturationLevel(event.target.value)} placeholder="65535" /></label>
                    <label className="flex items-center gap-2 text-xs"><Checkbox checked={cosmicSeparateMedian} onCheckedChange={checked => setCosmicSeparateMedian(Boolean(checked))} /><span>Separable median</span></label>
                    <label className="space-y-1 text-xs"><span>Fine structure</span><select value={cosmicFineStructureMode} onChange={event => setCosmicFineStructureMode(event.target.value as typeof cosmicFineStructureMode)} className="w-full h-9 bg-background border border-input rounded-md px-2"><option value="median">Median</option><option value="convolve">PSF convolve</option></select></label>
                    <label className="space-y-1 text-xs"><span>PSF model</span><select value={cosmicPsfModel} onChange={event => setCosmicPsfModel(event.target.value as typeof cosmicPsfModel)} className="w-full h-9 bg-background border border-input rounded-md px-2"><option value="gauss">Gaussian</option><option value="gaussx">Gaussian X</option><option value="gaussy">Gaussian Y</option><option value="moffat">Moffat</option></select></label>
                    <label className="space-y-1 text-xs"><span>PSF FWHM</span><Input type="number" step="0.1" value={cosmicPsfFwhm} onChange={event => setCosmicPsfFwhm(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>PSF size</span><Input type="number" min="3" step="2" value={cosmicPsfSize} onChange={event => setCosmicPsfSize(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>Moffat beta</span><Input type="number" step="0.001" value={cosmicPsfBeta} onChange={event => setCosmicPsfBeta(event.target.value)} /></label>
                  </div>}
                  {cosmicMethod === 'median' && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <label className="space-y-1 text-xs"><span>Threshold</span><Input type="number" step="0.1" value={medianCosmicThreshold} onChange={event => setMedianCosmicThreshold(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>Detection box</span><Input type="number" min="3" step="2" value={medianCosmicBox} onChange={event => setMedianCosmicBox(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>Grow box (0 = off)</span><Input type="number" min="0" step="2" value={medianCosmicGrowBox} onChange={event => setMedianCosmicGrowBox(event.target.value)} /></label>
                    <label className="space-y-1 text-xs"><span>Replacement box (0 = mask only)</span><Input type="number" min="0" step="2" value={medianCosmicReplaceBox} onChange={event => setMedianCosmicReplaceBox(event.target.value)} /></label>
                  </div>}
                </div>

                <div className="rounded border border-border p-3 space-y-3">
                  <label className="flex items-center gap-2 text-sm"><Checkbox checked={clipExtrema} onCheckedChange={checked => setClipExtrema(Boolean(checked))} /><span>IRAF-style extrema rejection</span></label>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <label className="space-y-1 text-xs"><span>Lowest samples</span><Input type="number" min="0" max="20" value={clipLowCount} onChange={event => setClipLowCount(event.target.value)} disabled={!clipExtrema} /></label>
                    <label className="space-y-1 text-xs"><span>Highest samples</span><Input type="number" min="0" max="20" value={clipHighCount} onChange={event => setClipHighCount(event.target.value)} disabled={!clipExtrema} /></label>
                    <label className="space-y-1 text-xs"><span>Absolute minimum</span><Input type="number" value={minimumClip} onChange={event => setMinimumClip(event.target.value)} placeholder="Disabled" /></label>
                    <label className="space-y-1 text-xs"><span>Absolute maximum</span><Input type="number" value={maximumClip} onChange={event => setMaximumClip(event.target.value)} placeholder="Disabled" /></label>
                  </div>
                </div>
              </div>
            </details>

            {stackMutation.isError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{errorMessage(stackMutation.error)}</AlertDescription>
              </Alert>
            )}
            {stackMutation.isSuccess && (
              <Alert>
                <CheckCircle className="h-4 w-4" />
                <AlertDescription>
                  <p>Stack of {stackMutation.data?.frameCount} frame{stackMutation.data?.frameCount === 1 ? '' : 's'} saved as a new FITS derivative{stackMutation.data?.engine ? ` with ${stackMutation.data.engine.name} ${stackMutation.data.engine.ccdproc}` : ''}.</p>
                  {stackMutation.data?.frames && <ul className="mt-2 space-y-0.5 font-mono text-xs">
                    {stackMutation.data.frames.map((frame: StackFrameReport, index: number) => <li key={index} className={frame.used ? '' : 'text-amber-500'}>
                      {index === 0 ? '★ ' : `${index + 1}. `}{frame.name}: {frame.used
                        ? frame.method === 'reference' ? 'reference' : `${frame.method}${frame.dx !== undefined ? ` (Δ ${frame.dx}, ${frame.dy} px)` : ''}`
                        : frame.reason}
                    </li>)}
                  </ul>}
                  {stackMutation.data?.warnings?.length ? <p className="mt-2 text-xs text-amber-500">{stackMutation.data.warnings.length} warning(s): see the frames marked above.</p> : null}
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
              <Button
                onClick={() => stackMutation.mutate()}
                disabled={!canEdit || selected.length < 2 || selectedFilters.length > 1 || (mismatched.length > 0 && !register) || stackMutation.isPending || !outputName.trim()}
                className="sky-button-primary"
              >
                {stackMutation.isPending ? <Loader className="mr-2 h-4 w-4 animate-spin" /> : <Layers className="mr-2 h-4 w-4" />}
                {stackMutation.isPending ? 'Stacking…' : `Stack ${selected.length} frame${selected.length === 1 ? '' : 's'}`}
              </Button>
              {canEdit && selected.length > 0 && (
                <form className="flex gap-2 sm:ml-auto" onSubmit={event => { event.preventDefault(); if (saveName.trim()) saveSelection.mutate(); }}>
                  <Input value={saveName} onChange={event => setSaveName(event.target.value)} placeholder="Save selection as catalog…" className="h-9 sm:w-64" />
                  <Button type="submit" variant="outline" disabled={!saveName.trim() || saveSelection.isPending}><Save className="h-4 w-4" /></Button>
                </form>
              )}
            </div>
            {savedMessage && <p className="text-xs text-green-400">{savedMessage}</p>}
            {saveSelection.isError && <p className="text-xs text-red-400">{errorMessage(saveSelection.error)}</p>}
          </CardContent>
        </Card>

        {isLoading && (
          <div className="flex items-center justify-center p-8">
            <Loader className="h-8 w-8 animate-spin" />
            <span className="ml-2">Loading FITS frames…</span>
          </div>
        )}

        {!isLoading && images.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center">
              <Info className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No FITS frames yet</h3>
              <p className="text-muted-foreground">Upload or scan some FITS files from the header menu first.</p>
            </CardContent>
          </Card>
        )}

        {fieldGroups.map(field => (
          <details key={field.key} open className="rounded-lg border border-border bg-card/40 p-3">
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
              <Library className="h-4 w-4 text-primary" />
              <span className="font-semibold">{field.name}</span>
              <span className="text-xs text-muted-foreground">{field.frames.length} frame{field.frames.length === 1 ? '' : 's'}{field.unsolved ? ' · not plate-solved or not classified yet' : ''}</span>
              <GroupButtons ids={field.frames.map(image => image.id)} />
            </summary>
            <div className="mt-3 space-y-3">
              {groupByDateAndFilter(field.frames.filter(image => !image.originalPath?.startsWith('fits-derived://'))).map(day => (
                <div key={day.date ?? 'unknown'} className="border-l-2 border-primary/40 pl-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-semibold text-foreground">{formatDayHeading(day.date)}</span>
                    <span className="text-muted-foreground">{day.count} frame{day.count === 1 ? '' : 's'} · {day.filters.map(group => `${group.frames.length}×${group.filter.code}`).join(' ')}</span>
                    <GroupButtons ids={day.filters.flatMap(group => group.frames.map(image => image.id))} />
                  </div>
                  {day.filters.map(group => (
                    <div key={group.filter.code} className="mb-3">
                      <div className="mb-1.5 flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{group.filter.label} ({group.frames.length})</span>
                        <GroupButtons ids={group.frames.map(image => image.id)} />
                      </div>
                      <div className={GALLERY_GRID}>
                        {group.frames.map(image => renderFrame(image))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
              {field.frames.some(image => image.originalPath?.startsWith('fits-derived://')) && (() => {
                const stacks = field.frames.filter(image => image.originalPath?.startsWith('fits-derived://'));
                return (
                  <div className="border-l-2 border-amber-500/50 pl-3">
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-foreground">Earlier stacks and derivatives</span>
                      <span className="text-muted-foreground">{stacks.length} · do not re-stack them with the frames they came from</span>
                    </div>
                    <div className={GALLERY_GRID}>
                      {stacks.map(image => renderFrame(image))}
                    </div>
                  </div>
                );
              })()}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
