import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Heart, Share, Plus, Settings } from "lucide-react";
import type { AstroImage, Equipment } from "@shared/schema";
import { isDeepSkyTagged } from "@shared/solar-system";
import { RemoteImage } from "./remote-image";

function isFitsImage(image: AstroImage): boolean {
  return Boolean(image.originalPath?.startsWith('fits://') || image.originalPath?.startsWith('fits-derived://') || image.originalPath?.startsWith('fits-upload://'));
}

/** FITS and plate-solving status as small chips over the thumbnail corner. */
function StatusChips({ image }: { image: AstroImage }) {
  const chip = "rounded px-1 py-px font-mono text-[9px] leading-tight shadow";
  const unsolvedDeepSky = !image.plateSolved && isDeepSkyTagged(image.tags);
  if (!isFitsImage(image) && !image.plateSolved && !unsolvedDeepSky) return null;
  return (
    <div className="absolute bottom-1 left-1 flex gap-1">
      {isFitsImage(image) && <span className={`${chip} bg-red-700 text-white`}>FITS</span>}
      {image.plateSolved && <span className={`${chip} bg-emerald-600 text-white`} title="Plate solved">✓ WCS</span>}
      {unsolvedDeepSky && <span className={`${chip} bg-amber-600 text-white`} title="No plate data">no WCS</span>}
    </div>
  );
}

/** One compact tile size for photos, catalog covers and catalog contents; only whole tiles per row. */
export const GALLERY_GRID = "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(6rem,1fr))]";

interface ImageGalleryProps {
  images: AstroImage[];
  equipment: Equipment[];
  onImageClick: (image: AstroImage) => void;
  isLoading: boolean;
  hasMoreImages?: boolean;
  onLoadMore?: () => void;
  totalImages?: number;
  visibleCount?: number;
}

export function ImageGallery({ 
  images, 
  equipment, 
  onImageClick, 
  isLoading,
  hasMoreImages = false,
  onLoadMore,
  totalImages = 0,
  visibleCount = 0
}: ImageGalleryProps) {
  const formatExposureData = (image: AstroImage) => {
    const parts = [];
    if (image.focalLength) parts.push(`${image.focalLength}mm`);
    if (image.aperture) parts.push(image.aperture);
    if (image.iso) parts.push(`ISO ${image.iso}`);
    if (image.exposureTime) parts.push(image.exposureTime);
    return parts.join(' • ');
  };

  const formatIntegrationData = (image: AstroImage) => {
    const parts = [];
    if (image.frameCount) parts.push(`${image.frameCount} frames`);
    if (image.totalIntegration) parts.push(`${image.totalIntegration}h total`);
    return parts.join(' • ');
  };

  const formatDate = (date: Date | null) => {
    if (!date) return "Unknown date";
    return new Date(date).toLocaleDateString();
  };

  if (isLoading) {
    return (
      <div className={`${GALLERY_GRID} mb-8`}>
        {[...Array(12)].map((_, i) => (
          <Card key={i} className="sky-card animate-pulse overflow-hidden">
            <div className="aspect-square bg-muted" />
            <CardContent className="p-2"><div className="h-3 bg-muted rounded" /></CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (images.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground mb-4">
          No astrophotography images found. Add images to the local AstroviaBin library to get started.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Image Grid */}
      <div className={`${GALLERY_GRID} mb-8`}>
        {images.map((image) => (
          <Card key={image.id} className="group cursor-pointer overflow-hidden min-w-0" onClick={() => onImageClick(image)}
            title={[image.title, image.targetName && image.targetName !== image.title ? image.targetName : null, formatExposureData(image), formatIntegrationData(image)].filter(Boolean).join("\n")}>
            <div className="relative aspect-square overflow-hidden">
              <RemoteImage
                src={image.thumbnailUrl || image.fullUrl || ""}
                alt={image.title || "Astronomy image"}
                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors duration-300" />
              <StatusChips image={image} />
            </div>
            <CardContent className="p-2">
              <h3 className="truncate text-[11px] font-semibold leading-tight text-foreground">
                {image.title || "Untitled"}
              </h3>
              <p className="truncate text-[10px] text-muted-foreground">{formatDate(image.captureDate)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Load More Button - Only show if there are more images to load */}
      {hasMoreImages && onLoadMore && (
        <div className="text-center mb-8">
          <Button 
            className="sky-button-primary"
            onClick={onLoadMore}
          >
            <Plus className="mr-2 h-4 w-4" />
            Load More ({visibleCount} of {totalImages} library items)
          </Button>
        </div>
      )}

      {/* Equipment Section */}
      {equipment.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xl font-bold text-foreground mb-4 flex items-center">
            <Settings className="mr-2 text-primary" />
            Equipment Gallery
          </h2>
          
          <div className={GALLERY_GRID}>
            {equipment.map((item) => (
              <Card key={item.id} className="sky-card">
                {item.imageUrl && (
                  <img
                    src={item.imageUrl}
                    alt={item.name}
                    className="w-full aspect-square object-cover"
                  />
                )}
                <CardContent className="p-2">
                  <h4 className="truncate text-[11px] font-semibold text-foreground">{item.name}</h4>
                  <p className="truncate text-[10px] text-muted-foreground">{item.type}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
