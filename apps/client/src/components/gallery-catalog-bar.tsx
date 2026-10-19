import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, FolderPlus, Library, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import type { GalleryCatalogSummary } from "./gallery-catalog-picker";
import { useCurrentUser } from "@/hooks/use-current-user";

interface GalleryCatalogBarProps {
  selectedId?: number;
  onSelect: (catalogId: number | undefined) => void;
  /** Ids of the images currently shown, for "add these to a catalog". */
  visibleImageIds: number[];
}

function cleanError(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const text = error.message.replace(/^\d+:\s*/, "");
  try { return JSON.parse(text).message || text; } catch { return text; }
}

/** Gallery catalogs: filter the gallery by catalog, create, rename, delete, and bulk-add the shown images. */
export function GalleryCatalogBar({ selectedId, onSelect, visibleImageIds }: GalleryCatalogBarProps) {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const { canEdit } = useCurrentUser();
  const { data: catalogs = [] } = useQuery<GalleryCatalogSummary[]>({ queryKey: ["/api/gallery-catalogs"] });
  const selected = catalogs.find(catalog => catalog.id === selectedId);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/gallery-catalogs"] });
    queryClient.invalidateQueries({ queryKey: ["/api/images"] });
  };

  const create = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/gallery-catalogs", { name: name.trim(), description: description.trim() || null })).json(),
    onSuccess: (catalog: GalleryCatalogSummary) => { setCreating(false); setName(""); setDescription(""); refresh(); onSelect(catalog.id); },
  });
  const update = useMutation({
    mutationFn: async () => apiRequest("PATCH", `/api/gallery-catalogs/${selectedId}`, { name: name.trim(), description: description.trim() || null }),
    onSuccess: () => { setEditing(false); refresh(); },
  });
  const remove = useMutation({
    mutationFn: async () => apiRequest("DELETE", `/api/gallery-catalogs/${selectedId}`),
    onSuccess: () => { onSelect(undefined); refresh(); },
  });
  const addShown = useMutation({
    mutationFn: async (catalogId: number) => (await apiRequest("POST", `/api/gallery-catalogs/${catalogId}/images`, { imageIds: visibleImageIds })).json(),
    onSuccess: (result: { added: number }, catalogId) => {
      setLastAdded(`${result.added} added to ${catalogs.find(catalog => catalog.id === catalogId)?.name ?? "catalog"}`);
      refresh();
    },
  });
  const error = cleanError(create.error) || cleanError(update.error) || cleanError(remove.error) || cleanError(addShown.error);

  const chip = (active: boolean) =>
    `px-3 py-1 rounded-full text-xs border transition-colors whitespace-nowrap ${active ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:text-foreground"}`;

  return (
    <div className="mb-4 space-y-2">
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <Library className="h-4 w-4 text-muted-foreground shrink-0" />
        <button className={chip(!selectedId)} onClick={() => onSelect(undefined)}>All images</button>
        {catalogs.map(catalog => (
          <button key={catalog.id} className={chip(catalog.id === selectedId)} onClick={() => onSelect(catalog.id)} title={catalog.description || undefined}>
            {catalog.name} <span className="opacity-70">({catalog.imageCount})</span>
          </button>
        ))}
        {canEdit && <Button variant="ghost" size="sm" className="h-7 text-xs shrink-0" onClick={() => { setCreating(value => !value); setEditing(false); setName(""); setDescription(""); }}>
          <FolderPlus className="h-3 w-3 mr-1" /> New catalog
        </Button>}
        {canEdit && catalogs.length > 0 && visibleImageIds.length > 0 && (
          <Select value="" onValueChange={value => addShown.mutate(Number(value))}>
            <SelectTrigger className="h-7 w-auto text-xs shrink-0 sky-input">
              <SelectValue placeholder={`Add ${visibleImageIds.length} shown to…`} />
            </SelectTrigger>
            <SelectContent className="bg-gray-900 border-gray-700 text-white">
              {catalogs.map(catalog => <SelectItem key={catalog.id} value={String(catalog.id)}>{catalog.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </div>

      {(creating || editing) && (
        <form
          className="flex flex-col sm:flex-row gap-2"
          onSubmit={event => { event.preventDefault(); if (!name.trim()) return; if (creating) create.mutate(); else update.mutate(); }}
        >
          <Input value={name} onChange={event => setName(event.target.value)} placeholder="Catalog name (e.g. Messier marathon, M42 FITS)" className="h-8 text-sm sky-input" autoFocus />
          <Input value={description} onChange={event => setDescription(event.target.value)} placeholder="Description (optional)" className="h-8 text-sm sky-input" />
          <div className="flex gap-1">
            <Button size="sm" type="submit" disabled={!name.trim()}><Check className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => { setCreating(false); setEditing(false); }}><X className="h-4 w-4" /></Button>
          </div>
        </form>
      )}

      {canEdit && selected && !editing && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{selected.description || `${selected.imageCount} item${selected.imageCount === 1 ? "" : "s"} in this catalog`}</span>
          <Button variant="ghost" size="sm" className="h-6 px-2" title="Rename catalog" onClick={() => { setEditing(true); setCreating(false); setName(selected.name); setDescription(selected.description || ""); }}>
            <Pencil className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 hover:text-red-400" title="Delete catalog (images are kept)"
            onClick={() => { if (window.confirm(`Delete the catalog "${selected.name}"? The images stay in your gallery.`)) remove.mutate(); }}>
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      )}
      {lastAdded && <p className="text-xs text-green-400">{lastAdded}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
