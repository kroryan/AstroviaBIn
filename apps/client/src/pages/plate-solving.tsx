import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Crosshair,
  Upload,
  CheckCircle,
  XCircle,
  Clock,
  Search,
  Loader,
  AlertCircle,
  Info,
  ChevronDown,
  ChevronUp,
  RefreshCw
} from "lucide-react";
import { Header } from "@/components/header";
import type { AstroImage, PlateSolvingJob } from "@shared/schema";
import { formatDateTime } from "@/lib/datetime";
import { isDeepSkyTagged, isPlateSolvingEligible } from "@shared/solar-system";

const isDeepSkyImage = (image: AstroImage) => isDeepSkyTagged(image.tags);
const canPlateSolve = (image: AstroImage) => isPlateSolvingEligible(image.tags, Boolean(image.plateSolved));

interface PlateSolvingStats {
  totalJobs: number;
  pendingJobs: number;
  processingJobs: number;
  completedJobs: number;
  failedJobs: number;
}

export default function PlateSolvingPage() {
  const [selectedImages, setSelectedImages] = useState<Set<number>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [showOnlyUnsolved, setShowOnlyUnsolved] = useState(true);
  const [expandedJobId, setExpandedJobId] = useState<number | null>(null);
  const queryClient = useQueryClient();
  const checkingIds = useRef(new Set<number>());
  const [checking, setChecking] = useState<Set<number>>(new Set());
  const [checkErrors, setCheckErrors] = useState<Set<number>>(new Set());
  const previousStatuses = useRef(new Map<number, string>());

  const refreshResults = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/images"] });
    queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
  };

  const checkStatus = async (jobId: number) => {
    if (checkingIds.current.has(jobId)) return;
    checkingIds.current.add(jobId);
    setChecking(new Set(checkingIds.current));
    setCheckErrors(errors => { const next = new Set(errors); next.delete(jobId); return next; });
    try {
      const response = await fetch(`/api/plate-solving/update/${jobId}`, { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("Status check failed");
      queryClient.invalidateQueries({ queryKey: ["/api/plate-solving/jobs"] }); queryClient.invalidateQueries({ queryKey: ["/api/plate-solving/jobs/summary"] });
      refreshResults();
    } catch {
      setCheckErrors(errors => new Set(errors).add(jobId));
    } finally {
      checkingIds.current.delete(jobId);
      setChecking(new Set(checkingIds.current));
    }
  };

  // Fetch images
  const { data: images = [], isLoading: imagesLoading } = useQuery<AstroImage[]>({
    queryKey: ["/api/images"],
    enabled: true,
  });

  // Fetch plate solving jobs
  const { data: jobs = [], isLoading: jobsLoading } = useQuery<PlateSolvingJob[]>({
    queryKey: ["/api/plate-solving/jobs"],
    enabled: true,
    refetchInterval: query => query.state.data?.some(job => job.status === "pending" || job.status === "processing") ? 30_000 : false,
    refetchOnWindowFocus: "always",
  });

  useEffect(() => {
    const completed = jobs.some(job => {
      const prior = previousStatuses.current.get(job.id);
      return (prior === "pending" || prior === "processing") && (job.status === "success" || job.status === "failed");
    });
    previousStatuses.current = new Map(jobs.map(job => [job.id, job.status]));
    if (completed) {
      queryClient.invalidateQueries({ queryKey: ["/api/images"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
    }
  }, [jobs, queryClient]);

  // Plate solving mutation
  const plateSolveMutation = useMutation({
    mutationFn: async (imageIds: number[]) => {
      const response = await fetch("/api/plate-solving/bulk", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({ imageIds }),
      });
      
      if (!response.ok) {
        throw new Error("Failed to submit images for plate solving");
      }
      
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/images"] });
      queryClient.invalidateQueries({ queryKey: ["/api/plate-solving/jobs"] }); queryClient.invalidateQueries({ queryKey: ["/api/plate-solving/jobs/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setSelectedImages(new Set()); // Clear selection after submission
    },
  });

  // Calculate stats
  const completedImageIds = new Set([
    ...images.filter(image => image.plateSolved).map(image => image.id),
    ...jobs.filter(job => job.status === "success" && job.imageId !== null).map(job => job.imageId!),
  ]);
  const unresolvedJobs = jobs.filter(job => job.imageId !== null && !completedImageIds.has(job.imageId));
  const pendingImageIds = new Set(unresolvedJobs.filter(job => job.status === "pending").map(job => job.imageId!));
  const processingImageIds = new Set(unresolvedJobs.filter(job => job.status === "processing").map(job => job.imageId!));
  const failedImageIds = new Set(unresolvedJobs.filter(job => job.status === "failed").map(job => job.imageId!));
  const allTrackedImageIds = new Set([
    ...completedImageIds,
    ...pendingImageIds,
    ...processingImageIds,
    ...failedImageIds,
  ]);
  const stats: PlateSolvingStats = {
    totalJobs: allTrackedImageIds.size,
    pendingJobs: pendingImageIds.size,
    processingJobs: processingImageIds.size,
    completedJobs: completedImageIds.size,
    failedJobs: failedImageIds.size,
  };

  // Filter images
  const filteredImages = images.filter((image) => {
    if (!image.plateSolved && !canPlateSolve(image)) return false;
    if (searchTerm && !image.title.toLowerCase().includes(searchTerm.toLowerCase())) {
      return false;
    }
    if (showOnlyUnsolved && image.plateSolved) {
      return false;
    }
    return true;
  });
  const selectableImages = filteredImages.filter(image =>
    !image.plateSolved &&
    canPlateSolve(image) &&
    !jobs.some(job => job.imageId === image.id && (job.status === "pending" || job.status === "processing"))
  );
  const selectableImageIds = new Set(selectableImages.map(image => image.id));
  const selectedSelectableCount = [...selectedImages].filter(id => selectableImageIds.has(id)).length;

  // Handle image selection
  const handleImageToggle = (imageId: number) => {
    if (!selectableImageIds.has(imageId)) return;
    const newSelected = new Set(selectedImages);
    if (newSelected.has(imageId)) {
      newSelected.delete(imageId);
    } else {
      newSelected.add(imageId);
    }
    setSelectedImages(newSelected);
  };

  // Handle select all/none
  const handleSelectAll = () => {
    if (selectedSelectableCount === selectableImages.length) {
      setSelectedImages(new Set());
    } else {
      setSelectedImages(new Set(selectableImageIds));
    }
  };

  // Handle bulk plate solving
  const handleBulkPlateSolve = () => {
    const imageIds = [...selectedImages].filter(id => selectableImageIds.has(id));
    if (imageIds.length > 0) {
      plateSolveMutation.mutate(imageIds);
    }
  };

  // Get job status for an image
  const getJobStatus = (imageId: number) => {
    const imageJobs = jobs.filter(job => job.imageId === imageId);
    if (imageJobs.length === 0) return null;
    
    // First, try to find the most recent successful job
    const successfulJobs = imageJobs.filter(job => job.status === "success");
    if (successfulJobs.length > 0) {
      // Return the most recent successful job
      return successfulJobs.sort((a, b) => 
        new Date(b.submittedAt || 0).getTime() - new Date(a.submittedAt || 0).getTime()
      )[0];
    }
    
    // If no successful jobs, return the most recent job
    return imageJobs.sort((a, b) => 
      new Date(b.submittedAt || 0).getTime() - new Date(a.submittedAt || 0).getTime()
    )[0];
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground mb-2">Plate Solving</h1>
          <p className="text-muted-foreground">
            Solve images privately on this AstroviaBin server with local Astrometry.net
          </p>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-6">
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Images tracked</p>
                  <p className="text-2xl font-bold">{stats.totalJobs}</p>
                </div>
                <Crosshair className="h-8 w-8 text-muted-foreground" />
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Pending</p>
                  <p className="text-2xl font-bold text-yellow-600">{stats.pendingJobs}</p>
                </div>
                <Clock className="h-8 w-8 text-yellow-600" />
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Processing</p>
                  <p className="text-2xl font-bold text-blue-600">{stats.processingJobs}</p>
                </div>
                <Loader className="h-8 w-8 text-blue-600 animate-spin" />
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Complete</p>
                  <p className="text-2xl font-bold text-green-600">{stats.completedJobs}</p>
                </div>
                <CheckCircle className="h-8 w-8 text-green-600" />
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Failed</p>
                  <p className="text-2xl font-bold text-red-600">{stats.failedJobs}</p>
                </div>
                <XCircle className="h-8 w-8 text-red-600" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Controls */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Image Selection</CardTitle>
            <CardDescription>
              Select images to submit for plate solving
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-4 mb-4">
              <div className="flex-1">
                <Label htmlFor="search" className="sr-only">Search images</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="search"
                    placeholder="Search images..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10"
                  />
                </div>
              </div>
              
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="showOnlyUnsolved"
                  checked={showOnlyUnsolved}
                  onCheckedChange={(checked) => setShowOnlyUnsolved(checked as boolean)}
                />
                <Label htmlFor="showOnlyUnsolved">Show only unsolved images</Label>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button
                  variant="outline"
                  onClick={handleSelectAll}
                  disabled={selectableImages.length === 0}
                >
                  {selectedSelectableCount === selectableImages.length ? "Deselect All" : "Select All"}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {selectedSelectableCount} of {selectableImages.length} images available to solve
                </span>
              </div>
              
              <Button
                onClick={handleBulkPlateSolve}
                disabled={selectedSelectableCount === 0 || plateSolveMutation.isPending}
                className="sky-button-primary w-full sm:w-auto whitespace-normal"
              >
                {plateSolveMutation.isPending ? (
                  <>
                    <Loader className="mr-2 h-4 w-4 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <Crosshair className="mr-2 h-4 w-4" />
                    Submit {selectedSelectableCount} for Plate Solving
                  </>
                )}
              </Button>
            </div>

            {plateSolveMutation.isError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Failed to submit images for plate solving. Please try again.
                </AlertDescription>
              </Alert>
            )}

            {plateSolveMutation.isSuccess && (
              <Alert>
                <CheckCircle className="h-4 w-4" />
                <AlertDescription>
                  Successfully submitted {plateSolveMutation.data?.results?.filter((r: any) => r.success).length || 0} images for plate solving.
                  {plateSolveMutation.data?.results?.filter((r: any) => !r.success).length > 0 && (
                    <span className="text-yellow-600">
                      {" "}{plateSolveMutation.data?.results?.filter((r: any) => !r.success).length} images failed to submit.
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Image Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          {filteredImages.map((image) => {
            const job = getJobStatus(image.id);
            const isSelectable = selectableImageIds.has(image.id);
            const isSelected = isSelectable && selectedImages.has(image.id);
            const isComplete = image.plateSolved || job?.status === "success";
            
            return (
              <Card 
                key={image.id} 
                className={`${isSelectable ? 'cursor-pointer hover:shadow-md' : ''} transition-all overflow-hidden ${
                  isSelected ? 'ring-2 ring-primary' : ''
                }`}
                onClick={() => isSelectable && handleImageToggle(image.id)}
              >
                <CardContent className="p-0">
                  <div className="relative">
                    {/* Image */}
                    <div className="aspect-square bg-muted flex items-center justify-center">
                      {image.thumbnailUrl ? (
                        <img 
                          src={image.thumbnailUrl} 
                          alt={image.title}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="text-muted-foreground text-center">
                          <Upload className="h-6 w-6 mx-auto mb-1" />
                          <p className="text-xs">No preview</p>
                        </div>
                      )}
                    </div>
                    
                    {/* Overlay with checkbox and title */}
                    <div className="absolute inset-0 bg-black/40 opacity-0 hover:opacity-100 transition-opacity">
                      {isSelectable && <div className="absolute top-2 left-2">
                        <Checkbox
                          checked={isSelected}
                          onChange={() => handleImageToggle(image.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="bg-white/90"
                        />
                      </div>}
                      <div className="absolute bottom-2 left-2 right-2">
                        <h3 className="font-medium text-xs text-white line-clamp-2 drop-shadow-lg">
                          {image.title}
                        </h3>
                      </div>
                    </div>
                    
                    {/* Status badges - always visible */}
                    <div className="absolute top-2 right-2 flex flex-col items-end space-y-1">
                      {isComplete && (
                        <Badge className="status-plate-solved text-xs">
                          <CheckCircle className="mr-1 h-3 w-3" />
                          Complete
                        </Badge>
                      )}
                      {job && !isComplete && (
                        <Badge
                          variant={
                            job.status === "success" ? "default" :
                            job.status === "failed" ? "destructive" :
                            job.status === "processing" ? "secondary" : "outline"
                          }
                          className="text-xs"
                        >
                          {job.status === "processing" && <Loader className="mr-1 h-3 w-3 animate-spin" />}
                          {job.status === "success" && <CheckCircle className="mr-1 h-3 w-3" />}
                          {job.status === "failed" && <XCircle className="mr-1 h-3 w-3" />}
                          {job.status === "pending" && <Clock className="mr-1 h-3 w-3" />}
                          {job.status === "processing" ? "Solving locally" : job.status === "success" ? "Complete" : job.status === "failed" ? "Failed" : "Queued"}
                        </Badge>
                      )}
                    </div>

                    {/* Selection indicator - always visible when selected */}
                    {isSelected && (
                      <div className="absolute inset-0 bg-primary/20 border-2 border-primary pointer-events-none" />
                    )}
                  </div>

                  {/* Result details toggle */}
                  {job && (job.status === "processing" || job.status === "success" || job.status === "failed") && (
                    <div className="border-t border-border">
                      <div className="flex items-center justify-between gap-1 px-2 py-1.5" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => setExpandedJobId(expandedJobId === job.id ? null : job.id)}
                          className="flex items-center gap-1 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {expandedJobId === job.id ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                          Details
                        </button>
                        {(job.status === "processing" || job.status === "failed") && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 gap-1 rounded-full border-border bg-transparent px-2 text-[11px] text-muted-foreground hover:text-foreground"
                            disabled={checking.has(job.id)}
                            onClick={() => checkStatus(job.id)}
                          >
                            <RefreshCw aria-hidden="true" className={`h-3 w-3 ${checking.has(job.id) ? "animate-spin" : ""}`} />
                            {checking.has(job.id) ? "Checking…" : "Check status"}
                          </Button>
                        )}
                      </div>
                      {checkErrors.has(job.id) && <p role="alert" className="px-2 pb-2 text-xs text-destructive">Couldn’t check status. Try again.</p>}
                      {expandedJobId === job.id && (
                        <div className="px-2 pb-2 text-xs space-y-1" onClick={(e) => e.stopPropagation()}>
                          {job.status === "failed" && (
                            <div className="text-red-400 bg-red-900/20 rounded p-1.5 space-y-1">
                              <div>{(job.result as any)?.error || "Unknown error"}</div>
                            </div>
                          )}
                          {job.status === "success" && (
                            <div className="text-muted-foreground space-y-0.5 font-mono">
                              <div className="font-sans">{job.astrometryJobId?.startsWith("local-") ? "Solved locally" : "Existing plate solution imported"}</div>
                              {(job.result as any)?.ra !== undefined && (
                                <div>RA: {Number((job.result as any).ra).toFixed(4)}</div>
                              )}
                              {(job.result as any)?.dec !== undefined && (
                                <div>Dec: {Number((job.result as any).dec).toFixed(4)}</div>
                              )}
                              {(job.result as any)?.pixscale && (
                                <div>Scale: {Number((job.result as any).pixscale).toFixed(2)}"/px</div>
                              )}
                              {(job.result as any)?.radius && (
                                <div>Radius: {Number((job.result as any).radius).toFixed(2)}&deg;</div>
                              )}
                              {(job.result as any)?.orientation !== undefined && (
                                <div>Orientation: {Number((job.result as any).orientation).toFixed(1)}&deg;</div>
                              )}
                            </div>
                          )}
                          {job.submittedAt && (
                            <div className="text-muted-foreground">
                              Submitted: {formatDateTime(job.submittedAt)}
                            </div>
                          )}
                          {(job.status === "success" || job.status === "failed") && job.completedAt && (
                            <div className="text-muted-foreground">
                              Completed: {formatDateTime(job.completedAt)}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {filteredImages.length === 0 && !imagesLoading && (
          <Card>
            <CardContent className="p-8 text-center">
              <Info className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No images found</h3>
              <p className="text-muted-foreground">
                {showOnlyUnsolved 
                  ? "All images have been plate solved, or try adjusting your search criteria."
                  : "Try adjusting your search criteria or add images to the private AstroviaBin library."
                }
              </p>
            </CardContent>
          </Card>
        )}

        {imagesLoading && (
          <div className="flex items-center justify-center p-8">
            <Loader className="h-8 w-8 animate-spin" />
            <span className="ml-2">Loading images...</span>
          </div>
        )}
      </div>
    </div>
  );
}
