import { useEffect, useState } from 'react';
import { Check, Pencil, Plus, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient } from '@/lib/queryClient';
import type { AstroImage } from '@shared/schema';

const PRESET_TAGS = [
  'Deep Sky', 'Solar System', 'Sun', 'Moon', 'Mercury', 'Venus', 'Earth',
  'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto',
];

function normalizedTags(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags.reduce<string[]>((result, tag) => {
    const value = tag.trim();
    const key = value.toLocaleLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
    return result;
  }, []);
}

export function ImageTagsEditor({ image, dark = false }: { image: AstroImage; dark?: boolean }) {
  const [tags, setTags] = useState<string[]>(image.tags || []);
  const [objectType, setObjectType] = useState(image.objectType || '');
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    setTags(image.tags || []);
    setObjectType(image.objectType || '');
    setEditing(false);
  }, [image.id, image.tags]);

  const save = async (next: string[]) => {
    const normalized = normalizedTags(next);
    setTags(normalized);
    setSaving(true);
    try {
      const response = await apiRequest('PATCH', `/api/images/${image.id}`, { tags: normalized });
      const updated = await response.json() as AstroImage;
      setTags(updated.tags || normalized);
      setObjectType(updated.objectType || '');
      queryClient.invalidateQueries({ queryKey: ['/api/images'] });
      queryClient.invalidateQueries({ queryKey: ['/api/images', image.id] });
      queryClient.invalidateQueries({ queryKey: ['/api/tags'] });
    } catch (error) {
      setTags(image.tags || []);
      toast({ title: 'Could not update tags', description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const clearObjectType = async () => {
    const previous = objectType;
    setObjectType('');
    setSaving(true);
    try {
      await apiRequest('PATCH', `/api/images/${image.id}`, { objectType: null });
      queryClient.invalidateQueries({ queryKey: ['/api/images'] });
      queryClient.invalidateQueries({ queryKey: ['/api/images', image.id] });
      queryClient.invalidateQueries({ queryKey: ['/api/tags'] });
    } catch (error) {
      setObjectType(previous);
      toast({ title: 'Could not remove classification', description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const addTag = (value: string) => {
    const tag = value.trim();
    if (!tag || tags.some(existing => existing.localeCompare(tag, undefined, { sensitivity: 'accent' }) === 0)) return;
    setNewTag('');
    void save([...tags, tag]);
  };

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h4 className={`font-semibold ${dark ? 'text-white' : 'text-foreground'}`}>Tags</h4>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => setEditing(value => !value)}
          disabled={saving}
          title={editing ? 'Finish editing tags' : 'Edit tags'}
          aria-label={editing ? 'Finish editing tags' : 'Edit tags'}
          className="h-7 w-7"
        >
          {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {tags.map(tag => <Badge key={tag} className={`sky-tag gap-1 ${editing ? 'pr-1' : ''}`}>
          {tag}
          {editing && <button type="button" onClick={() => void save(tags.filter(existing => existing !== tag))} disabled={saving} aria-label={`Remove ${tag}`} className="rounded hover:text-destructive disabled:opacity-50"><X className="h-3 w-3" /></button>}
        </Badge>)}
        {objectType && <Badge className={`sky-tag gap-1 ${editing ? 'pr-1' : ''}`}>
          {objectType}
          {editing && <button type="button" onClick={() => void clearObjectType()} disabled={saving} aria-label={`Remove ${objectType} classification`} className="rounded hover:text-destructive disabled:opacity-50"><X className="h-3 w-3" /></button>}
        </Badge>}
      </div>
      {editing && <>
        <div className="flex gap-2">
          <Input value={newTag} onChange={event => setNewTag(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addTag(newTag); } }} placeholder="Create a tag..." className={dark ? 'bg-black/30 border-black/40 text-white' : ''} />
          <Button type="button" size="sm" variant="outline" onClick={() => addTag(newTag)} disabled={saving || !newTag.trim()} title="Add tag"><Plus className="h-4 w-4" /></Button>
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {PRESET_TAGS.filter(tag => !tags.some(existing => existing.toLowerCase() === tag.toLowerCase())).map(tag => <button type="button" key={tag} onClick={() => addTag(tag)} disabled={saving} className={`text-xs px-2 py-0.5 rounded-full border border-dashed transition-colors disabled:opacity-50 ${dark ? 'border-gray-600 text-gray-400 hover:border-blue-400 hover:text-blue-300' : 'border-muted-foreground/30 text-muted-foreground hover:border-primary hover:text-primary'}`}>+ {tag}</button>)}
        </div>
        <p className={`text-xs mt-2 ${dark ? 'text-gray-400' : 'text-muted-foreground'}`}>Deep Sky and Solar System are mutually exclusive. Solar System and planet tags are excluded from plate solving.</p>
      </>}
    </section>
  );
}
