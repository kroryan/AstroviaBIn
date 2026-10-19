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

type StackFrameReport = { name: string; used: boolean; method?: string; matchedStars?: number; rmsPx?: number | null; dx?: number; dy?: number; reason?: string };
type StackResponse = { frameCount: number; frames?: StackFrameReport[]; warnings?: string[] };
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
      const response = await apiRequest('POST', '/api/fits/stack', { imageIds: selected, method, register, outputName });
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
            Combine several exposures into one. Every frame is resampled onto the reference frame (the first one you pick,
            marked ★) with sub-pixel accuracy, then combined pixel by pixel — sigma-clipping rejects one-frame outliers like
            satellite trails, cosmic rays and moving asteroids. Pick frames one by one, or load a gallery catalog you prepared for this stack.
          </p>
          <p className="text-xs text-muted-foreground">
            Alignment uses each frame's plate solution (rotation, scale and lens distortion included) refined with stars
            matched to the reference; frames without a plate solution are aligned from their stars. Each frame's residual is
            reported, frames whose stars do not line up are left out with the reason, and exact duplicates are skipped.
            Frames must use the same filter and BUNIT. When every frame has EXPTIME, values are normalized to the reference
            exposure; the output keeps the reference WCS. Pixels with no frame coverage are marked NaN.
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
                <AlertDescription>
                  <p>Stack of {stackMutation.data?.frameCount} frame{stackMutation.data?.frameCount === 1 ? '' : 's'} saved to the gallery as a new FITS derivative.</p>
                  {stackMutation.data?.frames && <ul className="mt-2 space-y-0.5 font-mono text-xs">
                    {stackMutation.data.frames.map((frame: StackFrameReport, index: number) => <li key={index} className={frame.used ? '' : 'text-amber-500'}>
                      {index === 0 ? '★ ' : `${index + 1}. `}{frame.name}: {frame.used
                        ? frame.method === 'reference' ? 'reference' : `${frame.method}${frame.matchedStars ? `, ${frame.matchedStars} stars` : ''}${frame.rmsPx != null ? `, residual ${frame.rmsPx} px` : ''}${frame.dx !== undefined ? ` (Δ ${frame.dx}, ${frame.dy} px)` : ''}`
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
