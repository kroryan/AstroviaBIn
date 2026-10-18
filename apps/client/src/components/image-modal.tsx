import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { X, Crosshair, Loader, Eye, AlertTriangle } from "lucide-react";
import type { AstroImage } from "@shared/schema";
import { DeepZoomViewer } from "./deep-zoom-viewer";
import { ImageTagsEditor } from "./image-tags-editor";
import { formatCaptureMoment, resolveZoomUrl } from "@/lib/fits";
import { useIsMobile } from "@/hooks/use-mobile";
import { HotpantsAnalysis } from "./hotpants-analysis";

interface ImageModalProps {
  image: AstroImage;
  onClose: () => void;
}

const SOLAR_SYSTEM_TAGS = new Set(['solar system', 'sun', 'moon', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']);

export function ImageModal({ image, onClose }: ImageModalProps) {
  const [showAnnotations, setShowAnnotations] = useState(false);
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const solarSystemFrame = Boolean(image.tags?.some(tag => SOLAR_SYSTEM_TAGS.has(tag.trim().toLowerCase())));
  const deepSkyFrame = Boolean(image.tags?.some(tag => tag.trim().toLowerCase() === 'deep sky'));
  const plateSolvingEligible = deepSkyFrame && !solarSystemFrame;
  const isFits = /^(fits|fits-derived|fits-upload):\/\//.test(image.originalPath || '');

  const plateSolveMutation = useMutation({
    mutationFn: async (imageId: number): Promise<{ processing: boolean; message?: string }> => {
      const response = await apiRequest("POST", `/api/plate-solving/images/${imageId}/plate-solve`);
      if (response.status === 202) {
        const data = await response.json();
        return { processing: true, message: data.message };
      }
      return { processing: false };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/images"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/plate-solving/jobs"] });
    },
  });

  const { data: annotationsData } = useQuery({
    queryKey: ["/api/images", image.id, "annotations"],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/images/${image.id}/annotations`);
      return response.json();
    },
    enabled: !!(showAnnotations && image.plateSolved),
  });

  // Fetch plate solving job data for this image
  const { data: plateSolvingJob } = useQuery({
    queryKey: ["/api/images", image.id, "plate-solving-job"],
    queryFn: async () => {
      const response = await apiRequest("GET", `/api/images/${image.id}/plate-solving-job`);
      return response.json();
    },
    enabled: !!image.id,
    refetchInterval: query => query.state.data?.status === "processing" ? 5_000 : false,
  });
  const isPlateSolveProcessing = plateSolvingJob?.status === "processing";

  // HTML overlays for Astrometry.net annotations
  const annotationOverlays = showAnnotations && annotationsData?.annotations ? (
    <>
      {annotationsData.annotations.map((annotation: any, idx: number) => {
        if (annotation.pixelx == null || annotation.pixely == null) return null;
        return (
          <div
            key={idx}
            style={{
              position: "absolute",
              left: annotation.pixelx,
              top: annotation.pixely,
              transform: "translate(-50%, -50%)",
              pointerEvents: "auto",
              zIndex: 20,
            }}
          >
            <div style={{
              background: "rgba(0,0,0,0.7)",
              color: "#fff",
              borderRadius: 6,
              padding: "2px 6px",
              fontSize: 14,
              border: "1px solid #fff",
              whiteSpace: "nowrap",
              minWidth: 20,
              textAlign: "center",
            }}>
              {annotation.names && annotation.names[0] ? annotation.names[0] : annotation.type || "?"}
            </div>
            <div style={{
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: "rgba(255,0,0,0.5)",
              border: "2px solid #fff",
              margin: "0 auto",
              marginTop: 2,
            }} />
          </div>
        );
      })}
    </>
  ) : null;

  return (
    <Dialog open={true} onOpenChange={onClose}>
      <DialogContent className="max-w-6xl w-full max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex justify-between items-center">
            <div>
              <DialogTitle className="text-xl font-bold text-foreground">
                {image.title}
              </DialogTitle>
              {(() => {
                const moment = formatCaptureMoment(image.captureDate, image.originalPath, image.captureDateSource);
                return (
                  <p className="text-muted-foreground flex items-center gap-1.5">
                    Captured on {moment.text}
                    {moment.status === 'unverified' && (
                      <span title="The time may not be exact — it comes from file metadata, not a verified exposure timestamp."><AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-label="Time not verified" /></span>
                    )}
                    {moment.status === 'edited' && <span className="text-xs italic">(edited)</span>}
                  </p>
                );
              })()}
            </div>
          </div>
        </DialogHeader>

        {isMobile ? (
          // MOBILE LAYOUT: image on top, details below
          <div className="flex flex-col gap-4">
            <div className="relative w-full aspect-[4/3] bg-black rounded-xl overflow-hidden">
              {image.fullUrl ? (
                <div className="relative w-full h-full">
                  <DeepZoomViewer
                    imageUrl={resolveZoomUrl(image)}
                    tileInfoUrl={`/api/images/${image.id}/tile-info`}
                    tileUrlBase={`/api/images/${image.id}/tile`}
                    annotations={showAnnotations && !isPlateSolveProcessing && annotationsData?.annotations ? annotationsData.annotations : []}
                  />
                  {/* Annotation Toggle Button */}
                  {image.plateSolved && !isPlateSolveProcessing && (
                    <div className="absolute bottom-4 right-4 z-10">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowAnnotations(!showAnnotations)}
                        className="bg-black/50 text-white border-white/20 hover:bg-black/70"
                      >
                        <Eye className="mr-2 h-4 w-4" />
                        {showAnnotations ? "Hide" : "Show"} Annotations
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="w-full h-64 bg-muted rounded-lg flex items-center justify-center">
                  <span className="text-muted-foreground">Image not available</span>
                </div>
              )}
            </div>
            <div className="bg-card rounded-xl p-4 flex flex-col gap-4">
              <div>
                <h4 className="font-semibold text-foreground mb-2">Technical Details</h4>
                <div className="text-sm text-muted-foreground space-y-1 font-mono">
                  {image.telescope && <div>Telescope: {image.telescope}</div>}
                  {image.camera && <div>Camera: {image.camera}</div>}
                  {image.mount && <div>Mount: {image.mount}</div>}
                  {image.focalLength && <div>Focal Length: {image.focalLength}mm</div>}
                  {image.aperture && <div>Aperture: {image.aperture}</div>}
                  {image.exposureTime && <div>Exposure: {image.exposureTime}</div>}
                  {image.iso && <div>ISO/Gain: {image.iso}</div>}
                  {image.frameCount && <div>Frame Count: {image.frameCount}</div>}
                  {image.totalIntegration && <div>Total Integration: {image.totalIntegration}h</div>}
                  {image.filters && <div>Filters: {image.filters}</div>}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-semibold text-foreground">Plate Solution</h4>
                  {plateSolvingEligible && (
                    <Button
                      onClick={() => plateSolveMutation.mutate(image.id)}
                      disabled={plateSolveMutation.isPending || plateSolvingJob?.status === "processing"}
                      size="sm"
                      className="sky-button-secondary"
                    >
                      {plateSolveMutation.isPending ? (
                        <Loader className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Crosshair className="mr-2 h-4 w-4" />
                      )}
                      {image.plateSolved ? "Solve again locally" : "Solve locally"}
                    </Button>
                  )}
                </div>
                {(isPlateSolveProcessing || plateSolveMutation.data?.processing) && (
                  <p role="status" className="mb-2 text-sm text-muted-foreground">Private local plate solving is in progress. The previous coordinates and target are not being treated as verified.</p>
                )}
                {isPlateSolveProcessing ? (
                  <p className="text-sm text-muted-foreground">Waiting for the private local solve to verify the image.</p>
                ) : image.plateSolved ? (
                  <div className="text-sm text-muted-foreground space-y-1">
                    {image.ra && <div>RA: {image.ra}</div>}
                    {image.dec && <div>Dec: {image.dec}</div>}
                    {image.pixelScale && <div>Pixel Scale: {image.pixelScale}"/pixel</div>}
                    {image.fieldOfView && <div>Field of View: {image.fieldOfView}</div>}
                    {image.rotation && <div>Rotation: {image.rotation}°</div>}
                    <div className="text-green-400 flex items-center">
                      <Badge className="status-plate-solved">✓ {plateSolvingJob?.astrometryJobId?.startsWith("local-") ? "Solved locally with Astrometry.net" : "Existing plate solution imported"}</Badge>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    <p>No plate solving data available.</p>
                    {!deepSkyFrame ? <p className="mt-2">Add the Deep Sky tag to make this stellar frame available for plate solving.</p> : solarSystemFrame ? <p className="mt-2">Solar System frames are excluded from plate solving.</p> : !plateSolveMutation.data?.processing && <p className="mt-2">Click "Solve" to process this image privately on this Sidereal server.</p>}
                  </div>
                )}
              </div>
              <ImageTagsEditor image={image} />
              {isFits && <HotpantsAnalysis image={image} />}
              {/* Description */}
              {image.description && (
                <div>
                  <h4 className="font-semibold text-foreground mb-2">Description</h4>
                  <p className="text-muted-foreground text-sm">{image.description}</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          // DESKTOP/TABLET LAYOUT (unchanged)
          <div className="bg-card rounded-xl p-4">
            <div className="relative mb-4">
              {image.fullUrl ? (
                <div className="relative">
                  <DeepZoomViewer
                    imageUrl={resolveZoomUrl(image)}
                    tileInfoUrl={`/api/images/${image.id}/tile-info`}
                    tileUrlBase={`/api/images/${image.id}/tile`}
                    annotations={showAnnotations && !isPlateSolveProcessing && annotationsData?.annotations ? annotationsData.annotations : []}
                  />
                  {/* Annotation Toggle Button */}
                  {image.plateSolved && !isPlateSolveProcessing && (
                    <div className="absolute bottom-4 right-4 z-10">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShowAnnotations(!showAnnotations)}
                        className="bg-black/50 text-white border-white/20 hover:bg-black/70"
                      >
                        <Eye className="mr-2 h-4 w-4" />
                        {showAnnotations ? "Hide" : "Show"} Annotations
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="w-full h-64 bg-muted rounded-lg flex items-center justify-center">
                  <span className="text-muted-foreground">Image not available</span>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h4 className="font-semibold text-foreground mb-2">Technical Details</h4>
                <div className="text-sm text-muted-foreground space-y-1 font-mono">
                  {image.telescope && <div>Telescope: {image.telescope}</div>}
                  {image.camera && <div>Camera: {image.camera}</div>}
                  {image.mount && <div>Mount: {image.mount}</div>}
                  {image.focalLength && <div>Focal Length: {image.focalLength}mm</div>}
                  {image.aperture && <div>Aperture: {image.aperture}</div>}
                  {image.exposureTime && <div>Exposure: {image.exposureTime}</div>}
                  {image.iso && <div>ISO/Gain: {image.iso}</div>}
                  {image.frameCount && <div>Frame Count: {image.frameCount}</div>}
                  {image.totalIntegration && <div>Total Integration: {image.totalIntegration}h</div>}
                  {image.filters && <div>Filters: {image.filters}</div>}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="font-semibold text-foreground">Plate Solution</h4>
                  {plateSolvingEligible && (
                    <Button
                      onClick={() => plateSolveMutation.mutate(image.id)}
                      disabled={plateSolveMutation.isPending || plateSolvingJob?.status === "processing"}
                      size="sm"
                      className="sky-button-secondary"
                    >
                      {plateSolveMutation.isPending ? (
                        <Loader className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Crosshair className="mr-2 h-4 w-4" />
                      )}
                      {image.plateSolved ? "Solve again locally" : "Solve locally"}
                    </Button>
                  )}
                </div>
                {(isPlateSolveProcessing || plateSolveMutation.data?.processing) && (
                  <p role="status" className="mb-2 text-sm text-muted-foreground">Private local plate solving is in progress. The previous coordinates and target are not being treated as verified.</p>
                )}
                {isPlateSolveProcessing ? (
                  <p className="text-sm text-muted-foreground">Waiting for the private local solve to verify the image.</p>
                ) : image.plateSolved ? (
                  <div className="text-sm text-muted-foreground space-y-1">
                    {image.ra && <div>RA: {image.ra}</div>}
                    {image.dec && <div>Dec: {image.dec}</div>}
                    {image.pixelScale && <div>Pixel Scale: {image.pixelScale}"/pixel</div>}
                    {image.fieldOfView && <div>Field of View: {image.fieldOfView}</div>}
                    {image.rotation && <div>Rotation: {image.rotation}°</div>}
                    <div className="text-green-400 flex items-center">
                      <Badge className="status-plate-solved">✓ {plateSolvingJob?.astrometryJobId?.startsWith("local-") ? "Solved locally with Astrometry.net" : "Existing plate solution imported"}</Badge>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    <p>No plate solving data available.</p>
                    {!deepSkyFrame ? <p className="mt-2">Add the Deep Sky tag to make this stellar frame available for plate solving.</p> : solarSystemFrame ? <p className="mt-2">Solar System frames are excluded from plate solving.</p> : !plateSolveMutation.data?.processing && <p className="mt-2">Click "Solve" to process this image privately on this Sidereal server.</p>}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-4">
              <ImageTagsEditor image={image} />
            </div>
            {isFits && <HotpantsAnalysis image={image} />}
            {/* Description */}
            {image.description && (
              <div className="mt-4">
                <h4 className="font-semibold text-foreground mb-2">Description</h4>
                <p className="text-muted-foreground text-sm">{image.description}</p>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
