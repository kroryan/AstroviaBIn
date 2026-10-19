import { Folder, Sparkles } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { AstroImage } from "@shared/schema";
import type { GalleryCatalogSummary } from "./gallery-catalog-picker";
import { RemoteImage } from "./remote-image";

const AUTO_DESCRIPTION = "Auto-classified by plate solution";

/** Catalogs shown as folders at the top of the gallery; opening one filters the gallery to it. */
export function GalleryCatalogFolders({ catalogs, images, onOpen }: {
  catalogs: GalleryCatalogSummary[];
  images: AstroImage[];
  onOpen: (catalogId: number) => void;
}) {
  const byId = new Map(images.map(image => [image.id, image]));
  const shown = catalogs.filter(catalog => catalog.imageCount > 0);
  if (!shown.length) return null;
  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted-foreground">
        <Folder className="h-4 w-4" /> Catalogs ({shown.length})
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
        {shown.map(catalog => {
          const covers = (catalog.imageIds ?? []).map(id => byId.get(id)).filter((image): image is AstroImage => Boolean(image)).slice(0, 3);
          const auto = catalog.description === AUTO_DESCRIPTION || catalog.description?.includes("auto-classified");
          return (
            <Card key={catalog.id} role="button" tabIndex={0} onClick={() => onOpen(catalog.id)}
              onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(catalog.id); } }}
              className="group cursor-pointer overflow-hidden" title={catalog.description || catalog.name}>
              <div className="relative aspect-[4/3] bg-muted">
                {covers[0] && <RemoteImage src={covers[0].thumbnailUrl || covers[0].fullUrl || ""} alt={catalog.name}
                  className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />}
                {covers.length > 1 && (
                  <div className="absolute bottom-2 right-2 flex gap-1">
                    {covers.slice(1).map(image => <RemoteImage key={image.id} src={image.thumbnailUrl || image.fullUrl || ""} alt=""
                      className="h-10 w-10 rounded border border-white/40 object-cover shadow" />)}
                  </div>
                )}
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-3 pr-24">
                  <p className="truncate text-sm font-semibold text-white" title={catalog.name}>{catalog.name}</p>
                  <p className="font-mono text-[11px] text-gray-300">{catalog.imageCount} item{catalog.imageCount === 1 ? "" : "s"}</p>
                </div>
                <Folder className="absolute left-2 top-2 h-5 w-5 text-white drop-shadow" />
                {auto && <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] uppercase text-cyan-300" title="Created automatically from plate solutions">
                  <Sparkles className="h-3 w-3" /> auto
                </span>}
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
