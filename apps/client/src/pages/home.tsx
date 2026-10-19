import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Header } from "@/components/header";
import { SearchFilters } from "@/components/search-filters";
import { ImageGallery, isFitsImage } from "@/components/image-gallery";
import { SOLAR_SYSTEM_SECTIONS, solarSystemSection } from "@shared/solar-system";
import { groupByDateAndFilter } from "@shared/fits-groups";
import { formatDayHeading } from "@/lib/datetime";
import { Sidebar } from "@/components/sidebar";
import { ImageOverlay } from "@/components/image-overlay";
import { GalleryCatalogBar } from "@/components/gallery-catalog-bar";
import { GalleryCatalogFolders } from "@/components/gallery-catalog-folders";
import type { GalleryCatalogSummary } from "@/components/gallery-catalog-picker";
import { Switch } from "@/components/ui/switch";
import { usePlateSolvingUpdates } from "@/hooks/use-socket";
import { useSearch, useLocation } from "wouter";
import type { AstroImage, Equipment } from "@shared/schema";

export default function Home() {
  const [selectedImage, setSelectedImage] = useState<AstroImage | null>(null);
  const searchString = useSearch();
  const [, setLocation] = useLocation();

  const [filters, setFilters] = useState({
    objectType: "",
    tags: [] as string[],
    plateSolved: undefined as boolean | undefined,
    constellation: "",
    search: "",
    equipmentId: undefined as number | undefined,
    equipmentName: undefined as string | undefined,
    galleryCatalogId: undefined as number | undefined,
  });
  const [visibleCount, setVisibleCount] = useState(48); // compact tiles: several rows at once
  // Catalogs as folders with only the unclassified images loose, or every image flat.
  const [grouped, setGrouped] = useState<boolean>(() => {
    try { return localStorage.getItem("astroviabin.galleryGrouped") !== "false"; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem("astroviabin.galleryGrouped", String(grouped)); } catch { /* storage unavailable */ }
  }, [grouped]);
  const { data: catalogs = [] } = useQuery<GalleryCatalogSummary[]>({ queryKey: ["/api/gallery-catalogs"] });

  type Stats = { totalImages: number; plateSolved: number; fitsCount: number; totalHours: number; uniqueTargets: number; };
  type Tag = { tag: string; count: number };

  const { data: images = [], isLoading: imagesLoading, refetch: refetchImages } = useQuery<AstroImage[]>({
    queryKey: ["/api/images", { objectType: filters.objectType, tags: filters.tags, plateSolved: filters.plateSolved, constellation: filters.constellation, equipmentId: filters.equipmentId, galleryCatalogId: filters.galleryCatalogId }],
    enabled: true,
  });

  // Handle deep-linking to a specific image via ?image=ID
  useEffect(() => {
    if (images.length > 0 && searchString) {
      const params = new URLSearchParams(searchString);
      const imageId = params.get("image");
      if (imageId) {
        const image = images.find(img => img.id.toString() === imageId);
        if (image) {
          setSelectedImage(image);
        }
      }
    }
  }, [images, searchString]);

  const { data: stats, refetch: refetchStats } = useQuery<Stats>({
    queryKey: ["/api/stats"],
    enabled: true,
  });

  const { data: equipment = [] } = useQuery<Equipment[]>({
    queryKey: ["/api/equipment"],
    enabled: true,
  });

  const { data: tags = [] } = useQuery<Tag[]>({
    queryKey: ["/api/tags"],
    enabled: true,
  });

  // Listen for real-time plate solving updates
  usePlateSolvingUpdates((update) => {
    console.log('Received plate solving update:', update);
    // Refresh data when plate solving status changes
    refetchImages();
    refetchStats();
  });

  const filteredImages = images.filter((image: AstroImage) => {
    if (filters.search && !image.title.toLowerCase().includes(filters.search.toLowerCase())) {
      return false;
    }
    // Advanced filters (client-side)
    const f = filters as any;
    if (f.dateFrom && image.captureDate) {
      if (new Date(image.captureDate) < new Date(f.dateFrom)) return false;
    }
    if (f.dateTo && image.captureDate) {
      if (new Date(image.captureDate) > new Date(f.dateTo + "T23:59:59")) return false;
    }
    if (f.minIntegration !== undefined && (image.totalIntegration || 0) < f.minIntegration) {
      return false;
    }
    return true;
  });

  // Reset visible count when filters change
  const handleFiltersChange = (newFilters: typeof filters) => {
    setFilters(newFilters);
    setVisibleCount(48); // Reset to initial count
  };

  const handleLoadMore = () => {
    setVisibleCount(prev => prev + 48);
  };

  // Grouping applies to the plain "All images" view; any filter or search shows matching images flat.
  const f = filters as typeof filters & { dateFrom?: string; dateTo?: string; minIntegration?: number };
  const filtering = Boolean(filters.galleryCatalogId || filters.search || filters.tags.length || filters.objectType
    || filters.plateSolved !== undefined || filters.constellation || filters.equipmentId || f.dateFrom || f.dateTo || f.minIntegration !== undefined);
  const showFolders = grouped && !filtering;
  const catalogued = new Set(catalogs.flatMap(catalog => catalog.imageIds ?? []));
  const listedImages = showFolders ? filteredImages.filter(image => !catalogued.has(image.id)) : filteredImages;

  // Inside an album, images are grouped into categories: one per body in the Solar System album,
  // FITS and photos in every other album.
  const openCatalog = catalogs.find(catalog => catalog.id === filters.galleryCatalogId);
  const albumSections: Array<{ name: string; images: AstroImage[] }> = !openCatalog ? [] :
    openCatalog.name === "Solar System"
      ? SOLAR_SYSTEM_SECTIONS.map(name => ({ name, images: filteredImages.filter(image => solarSystemSection(image.tags, image.title) === name) }))
      : [{ name: "FITS", images: filteredImages.filter(isFitsImage) }, { name: "Photos", images: filteredImages.filter(image => !isFitsImage(image)) }];

  // Get only the visible images based on pagination
  const visibleImages = listedImages.slice(0, visibleCount);
  const hasMoreImages = visibleCount < listedImages.length;

  const handleCloseOverlay = () => {
    setSelectedImage(null);
    // Remove the image parameter from the URL when overlay is closed
    if (searchString.includes("image=")) {
      const params = new URLSearchParams(searchString);
      params.delete("image");
      const from = params.get("from");
      params.delete("from");
      if (from === "targets") {
        setLocation("/targets", { replace: true });
        return;
      }
      const newSearch = params.toString();
      // Ensure we navigate back cleanly
      setLocation(newSearch ? `/?${newSearch}` : "/", { replace: true });
    }
  };

  return (
    <div className="min-h-screen bg-background overflow-x-hidden w-full">
      <Header />
      <SearchFilters
        filters={filters}
        onFiltersChange={handleFiltersChange}
        stats={stats}
        totalCount={images.length}
        filteredCount={filteredImages.length}
      />
      
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 w-full overflow-x-hidden">
        <div className="flex flex-col lg:flex-row gap-6">
          <main className="flex-1 min-w-0">
            <GalleryCatalogBar
              selectedId={filters.galleryCatalogId}
              onSelect={(galleryCatalogId) => handleFiltersChange({ ...filters, galleryCatalogId })}
              visibleImageIds={filteredImages.map(image => image.id)}
            />
            <div className="mb-3 flex items-center justify-end gap-2 text-xs text-muted-foreground">
              <label htmlFor="gallery-grouped" className="cursor-pointer">Group by catalog</label>
              <Switch id="gallery-grouped" checked={grouped} onCheckedChange={setGrouped} />
            </div>
            {showFolders && <GalleryCatalogFolders catalogs={catalogs} images={images}
              onOpen={galleryCatalogId => handleFiltersChange({ ...filters, galleryCatalogId })} />}
            {showFolders && catalogued.size > 0 && (
              <h2 className="mb-3 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                Unclassified ({listedImages.length})
              </h2>
            )}
            {openCatalog && !imagesLoading ? (
              filteredImages.length === 0 ? <p className="mb-8 text-sm text-muted-foreground">No images in this album match.</p> :
              albumSections.filter(section => section.images.length).map(section => (
                <section key={section.name} className="mb-6">
                  <h2 className="mb-3 font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    {section.name} ({section.images.length})
                  </h2>
                  {section.name === "FITS" ? groupByDateAndFilter(section.images).map(day => (
                    <div key={day.date ?? "unknown"} className="mb-4 border-l-2 border-primary/40 pl-3">
                      <h3 className="mb-2 text-xs font-semibold text-foreground">{formatDayHeading(day.date)} <span className="font-normal text-muted-foreground">· {day.count} frame{day.count === 1 ? "" : "s"}</span></h3>
                      {day.filters.map(group => (
                        <div key={group.filter.code} className="mb-3">
                          <h4 className="mb-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{group.filter.label} ({group.frames.length})</h4>
                          <ImageGallery images={group.frames} equipment={[]} showTime isLoading={false}
                            onImageClick={(image) => { setSelectedImage(image); setLocation(`/?image=${image.id}`, { replace: true }); }} />
                        </div>
                      ))}
                    </div>
                  )) : (
                    <ImageGallery
                      images={section.images}
                      equipment={[]}
                      onImageClick={(image) => {
                        setSelectedImage(image);
                        setLocation(`/?image=${image.id}`, { replace: true });
                      }}
                      isLoading={false}
                    />
                  )}
                </section>
              ))
            ) : showFolders && catalogued.size > 0 && !imagesLoading && listedImages.length === 0 ? (
              <p className="mb-8 text-sm text-muted-foreground">Every image is filed in a catalog. New images stay here until they are classified.</p>
            ) : <ImageGallery
              images={visibleImages}
              equipment={equipment}
              onImageClick={(image) => {
                setSelectedImage(image);
                // Also update URL when clicking from gallery for bookmarkability
                setLocation(`/?image=${image.id}`, { replace: true });
              }}
              isLoading={imagesLoading}
              hasMoreImages={hasMoreImages}
              onLoadMore={handleLoadMore}
              totalImages={listedImages.length}
              visibleCount={visibleCount}
            />}
          </main>
          
          <Sidebar 
            stats={stats}
            tags={tags}
            onTagClick={(tag) => {
              setFilters(prev => ({
                ...prev,
                tags: prev.tags.includes(tag) 
                  ? prev.tags.filter(t => t !== tag)
                  : [...prev.tags, tag]
              }));
            }}
          />
        </div>
      </div>

      {selectedImage && (
        <ImageOverlay
          key={selectedImage.id}
          image={selectedImage}
          onClose={handleCloseOverlay}
          onFilterByEquipment={(equipmentId, equipmentName) => {
            setFilters(prev => ({ ...prev, equipmentId, equipmentName }));
            setSelectedImage(null);
          }}
        />
      )}
    </div>
  );
}
