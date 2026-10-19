import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Library, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import type { AstroImage } from "@shared/schema";
import { useCurrentUser } from "@/hooks/use-current-user";

export interface GalleryCatalogSummary {
  id: number;
  name: string;
  description: string | null;
  imageCount: number;
  coverImageId: number | null;
  /** Member image ids, most recently added first. */
  imageIds?: number[];
}

function cleanError(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const text = error.message.replace(/^\d+:\s*/, "");
  try { return JSON.parse(text).message || text; } catch { return text; }
}

/** Shows which gallery catalogs an image belongs to and lets the user add or remove it. */
export function GalleryCatalogPicker({ image, dark = false }: { image: AstroImage; dark?: boolean }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const { canEdit } = useCurrentUser();

  const { data: catalogs = [] } = useQuery<GalleryCatalogSummary[]>({ queryKey: ["/api/gallery-catalogs"] });
  const { data: memberOf = [] } = useQuery<number[]>({
    queryKey: ["/api/images", image.id, "gallery-catalogs"],
    queryFn: async () => (await apiRequest("GET", `/api/images/${image.id}/gallery-catalogs`)).json(),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/gallery-catalogs"] });
    queryClient.invalidateQueries({ queryKey: ["/api/images"] });
  };

  const add = useMutation({
    mutationFn: async (catalogId: number) => apiRequest("POST", `/api/gallery-catalogs/${catalogId}/images`, { imageIds: [image.id] }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async (catalogId: number) => apiRequest("DELETE", `/api/gallery-catalogs/${catalogId}/images/${image.id}`),
    onSuccess: refresh,
  });
  const create = useMutation({
    mutationFn: async (name: string) => {
      const response = await apiRequest("POST", "/api/gallery-catalogs", { name });
      const catalog = await response.json() as GalleryCatalogSummary;
      await apiRequest("POST", `/api/gallery-catalogs/${catalog.id}/images`, { imageIds: [image.id] });
      return catalog;
    },
    onSuccess: () => { setNewName(""); setAdding(false); refresh(); },
  });

  const members = catalogs.filter(catalog => memberOf.includes(catalog.id));
  const available = catalogs.filter(catalog => !memberOf.includes(catalog.id));
  const sectionClass = dark
    ? "bg-black/30 rounded-xl p-4 mb-2 shadow border border-black/40"
    : "bg-muted/30 rounded-xl p-4 mb-2 shadow border border-black/20";
  const muted = dark ? "text-gray-400" : "text-muted-foreground";
  const error = cleanError(add.error) || cleanError(remove.error) || cleanError(create.error);

  return (
    <section className={sectionClass}>
      <div className="flex items-center justify-between mb-2">
        <h3 className={`font-semibold flex items-center gap-2 ${dark ? "text-white" : "text-foreground"}`}>
          <Library className="h-4 w-4" /> Catalogs
        </h3>
        {canEdit && <Button variant="ghost" size="sm" className={`h-6 px-2 ${muted}`} onClick={() => setAdding(value => !value)} title="Add to a catalog">
          <FolderPlus className="h-3 w-3" />
        </Button>}
      </div>
      <div className="flex flex-wrap gap-1">
        {members.length === 0 && <span className={`text-xs ${muted}`}>Not in any catalog yet.</span>}
        {members.map(catalog => (
          <Badge key={catalog.id} variant="secondary" className="gap-1">
            {catalog.name}
            {canEdit && <button aria-label={`Remove from ${catalog.name}`} onClick={() => remove.mutate(catalog.id)} className="hover:text-red-400">
              <X className="h-3 w-3" />
            </button>}
          </Badge>
        ))}
      </div>
      {adding && (
        <div className="mt-3 space-y-2">
          {available.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {available.map(catalog => (
                <Button key={catalog.id} size="sm" variant="outline" className="h-7 text-xs" onClick={() => add.mutate(catalog.id)}>
                  <Plus className="h-3 w-3 mr-1" />{catalog.name}
                </Button>
              ))}
            </div>
          )}
          <form className="flex gap-2" onSubmit={event => { event.preventDefault(); if (newName.trim()) create.mutate(newName.trim()); }}>
            <Input value={newName} onChange={event => setNewName(event.target.value)} placeholder="New catalog name" className={dark ? "h-8 text-xs bg-black/40 border-white/20 text-white" : "h-8 text-xs"} />
            <Button size="sm" type="submit" disabled={!newName.trim() || create.isPending}>Create</Button>
          </form>
        </div>
      )}
      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </section>
  );
}
