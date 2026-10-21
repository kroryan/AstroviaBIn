import { Folder, Sparkles } from "lucide-react";
import { galleryThumbnail } from "@/lib/fits";
import { Card } from "@/components/ui/card";
import type { AstroImage } from "@shared/schema";
import type { GalleryCatalogSummary } from "./gallery-catalog-picker";
import { RemoteImage } from "./remote-image";
import { GALLERY_GRID } from "./image-gallery";

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
      <div className={GALLERY_GRID}>
        {shown.map(catalog => {
          const covers = (catalog.imageIds ?? []).map(id => byId.get(id)).filter((image): image is AstroImage => Boolean(image)).slice(0, 1);
          const auto = catalog.description === AUTO_DESCRIPTION || catalog.description?.includes("auto-classified");
          return (
            <Card key={catalog.id} role="button" tabIndex={0} onClick={() => onOpen(catalog.id)}
              onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(catalog.id); } }}
              className="group cursor-pointer overflow-hidden min-w-0" title={`${catalog.name} — ${catalog.imageCount} item${catalog.imageCount === 1 ? "" : "s"}${catalog.description ? `\n${catalog.description}` : ""}`}>
              <div className="relative aspect-square overflow-hidden bg-muted">
                {covers[0] && <RemoteImage src={galleryThumbnail(covers[0].thumbnailUrl || covers[0].fullUrl)} alt={catalog.name}
                  className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />}
                <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded bg-black/65 px-1 py-0.5 font-mono text-[10px] text-white">
                  <Folder className="h-3 w-3" /> {catalog.imageCount}
                </span>
                {auto && <span className="absolute right-1 top-1 rounded bg-black/65 p-0.5 text-cyan-300" title="Created automatically from plate solutions">
                  <Sparkles className="h-3 w-3" />
                </span>}
              </div>
              <div className="p-2">
                <p className="truncate text-[11px] font-semibold leading-tight text-foreground">{catalog.name}</p>
                <p className="truncate text-[10px] text-muted-foreground">Album</p>
              </div>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
