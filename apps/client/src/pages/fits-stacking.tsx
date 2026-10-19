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
  const [method, setMethod] = useState<'sigma-clip' | 'mean' | 'median'>('sigma-clip');
  const [register, setRegister] = useState(true);
  const [outputName, setOutputName] = useState('stacked');
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

  const stackMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/fits/stack', { imageIds: selected, method, register, outputName });
      return response.json();
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
            Combine several same-sized exposures into one. Frames are aligned (translation only) against the reference frame
            (the first one you pick, marked ★), then combined pixel by pixel — sigma-clipping rejects one-frame outliers like
            satellite trails or cosmic ray hits. Pick frames one by one, or load a gallery catalog you prepared for this stack.
          </p>
          <p className="text-xs text-muted-foreground">
            Registration uses integer-pixel shifts and needs shared image structure; flat frames stay unshifted instead of
            receiving a guessed offset. Rotation and scale are not corrected. Frames must use the same filter and BUNIT.
            When every frame has EXPTIME, values are normalized to the first frame's exposure; the output keeps its WCS.
            Pixels with no frame coverage are marked NaN.
          </p>
        </div>

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
            {mismatched.length > 0 && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{mismatched.length} selected frame(s) differ in size from the reference ({referenceSize}). Only same-sized frames can be stacked.</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Options</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <label className="space-y-1 text-sm block">
                <span className="text-muted-foreground">Combination method</span>
                <select value={method} onChange={event => setMethod(event.target.value as typeof method)} className="w-full bg-background border border-input rounded-md px-2 py-1">
                  <option value="sigma-clip">Sigma-clipped mean (recommended)</option>
                  <option value="mean">Mean</option>
                  <option value="median">Median</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm self-end pb-1">
                <Checkbox checked={register} onCheckedChange={checked => setRegister(checked as boolean)} />
                <span>Align frames before stacking</span>
              </label>
              <label className="space-y-1 text-sm block">
                <span className="text-muted-foreground">New FITS filename</span>
                <input value={outputName} onChange={event => setOutputName(event.target.value)} className="w-full rounded-md border border-input bg-background px-2 py-1" />
              </label>
            </div>

            {stackMutation.isError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{errorMessage(stackMutation.error)}</AlertDescription>
              </Alert>
            )}
            {stackMutation.isSuccess && (
              <Alert>
                <CheckCircle className="h-4 w-4" />
                <AlertDescription>Stack saved to the gallery as a new FITS derivative.</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
              <Button
                onClick={() => stackMutation.mutate()}
                disabled={!canEdit || selected.length < 2 || mismatched.length > 0 || stackMutation.isPending || !outputName.trim()}
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

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          {visible.map(image => {
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
                        {[size, image.filters, image.exposureTime, image.captureDate ? new Date(image.captureDate).toLocaleDateString() : null].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
