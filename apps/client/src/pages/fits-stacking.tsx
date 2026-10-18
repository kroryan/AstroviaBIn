import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Layers, CheckCircle, AlertCircle, Loader, Info } from 'lucide-react';
import { Header } from '@/components/header';
import { apiRequest, queryClient as sharedQueryClient } from '@/lib/queryClient';
import type { AstroImage } from '@shared/schema';

export default function FitsStackingPage() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [method, setMethod] = useState<'sigma-clip' | 'mean' | 'median'>('sigma-clip');
  const [register, setRegister] = useState(true);
  const [outputName, setOutputName] = useState('stacked');

  const { data: images = [], isLoading } = useQuery<AstroImage[]>({
    queryKey: ['/api/fits'],
    queryFn: async () => (await apiRequest('GET', '/api/fits')).json(),
  });

  const toggle = (id: number) => {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const stackMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', '/api/fits/stack', {
        imageIds: Array.from(selected),
        method,
        register,
        outputName,
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/fits'] });
      sharedQueryClient.invalidateQueries({ queryKey: ['/api/images'] });
      sharedQueryClient.invalidateQueries({ queryKey: ['/api/stats'] });
      setSelected(new Set());
    },
  });

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground mb-2 flex items-center gap-2"><Layers className="h-7 w-7" /> Stack FITS frames</h1>
          <p className="text-muted-foreground">
            Combine several same-sized exposures into one. Frames are aligned (translation only) against the first one you pick, then
            combined pixel by pixel — sigma-clipping rejects one-frame outliers like satellite trails or cosmic ray hits.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Options</CardTitle>
            <CardDescription>{selected.size} frame{selected.size === 1 ? '' : 's'} selected</CardDescription>
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
                <AlertDescription>{stackMutation.error instanceof Error ? stackMutation.error.message : 'Failed to stack frames.'}</AlertDescription>
              </Alert>
            )}

            {stackMutation.isSuccess && (
              <Alert>
                <CheckCircle className="h-4 w-4" />
                <AlertDescription>Stack saved to the gallery as a new FITS derivative.</AlertDescription>
              </Alert>
            )}

            <Button
              onClick={() => stackMutation.mutate()}
              disabled={selected.size < 2 || stackMutation.isPending || !outputName.trim()}
              className="sky-button-primary"
            >
              {stackMutation.isPending ? <Loader className="mr-2 h-4 w-4 animate-spin" /> : <Layers className="mr-2 h-4 w-4" />}
              {stackMutation.isPending ? 'Stacking…' : `Stack ${selected.size} frame${selected.size === 1 ? '' : 's'}`}
            </Button>
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
          {images.map(image => {
            const isSelected = selected.has(image.id);
            return (
              <Card
                key={image.id}
                className={`cursor-pointer transition-all hover:shadow-md overflow-hidden ${isSelected ? 'ring-2 ring-primary' : ''}`}
                onClick={() => toggle(image.id)}
              >
                <CardContent className="p-0">
                  <div className="relative">
                    <div className="aspect-square bg-muted flex items-center justify-center">
                      {image.thumbnailUrl ? <img src={image.thumbnailUrl} alt={image.title} className="w-full h-full object-cover" /> : <Info className="h-6 w-6 text-muted-foreground" />}
                    </div>
                    <div className="absolute top-2 left-2">
                      <Checkbox checked={isSelected} onClick={event => event.stopPropagation()} onCheckedChange={() => toggle(image.id)} className="bg-white/90" />
                    </div>
                    <div className="absolute bottom-0 inset-x-0 bg-black/60 px-2 py-1">
                      <p className="text-xs text-white truncate">{image.title}</p>
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
