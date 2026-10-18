import { useEffect, useRef, useState, useCallback } from "react";
import OpenSeadragon from "openseadragon";

interface Annotation {
  pixelx: number;
  pixely: number;
  names?: string[];
  type?: string;
  radius?: number;
}

interface TileInfo {
  width: number;
  height: number;
  tileSize: number;
  maxLevel: number;
}

interface DeepZoomViewerProps {
  imageUrl: string;
  annotations?: Annotation[];
  onZoom?: (zoom: number) => void;
  fullHeight?: boolean;
  height?: string | number;
  disableZoom?: boolean;
  /** Keep the current pan/zoom when `imageUrl` changes instead of re-fitting, for live-updating previews. */
  preserveViewport?: boolean;
  onLoad?: () => void;
  onError?: () => void;
  /**
   * Fetches tile metadata once and lets OpenSeadragon request only the visible tiles. `imageUrl`
   * remains the fallback for sources without a local tiled original.
   */
  tileInfoUrl?: string;
  tileUrlBase?: string;
  /**
   * Native pixel size the annotation coordinates refer to. Overlays are placed relative to it, so
   * they stay correct whether the viewer shows full-resolution tiles or a resized fallback preview.
   */
  annotationSize?: { width: number | null; height: number | null } | null;
}

if (typeof window !== 'undefined') {
  const style = document.createElement('style');
  style.innerHTML = `
    .osd-debug-overlay, .openseadragon-overlay {
      z-index: 999999 !important;
      pointer-events: auto !important;
      opacity: 1 !important;
      display: block !important;
      background-clip: padding-box !important;
    }
  `;
  document.head.appendChild(style);
}

export function DeepZoomViewer({ imageUrl, annotations = [], onZoom, fullHeight = false, height, disableZoom = false, preserveViewport = false, onLoad, onError, tileInfoUrl, tileUrlBase, annotationSize }: DeepZoomViewerProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const osdViewer = useRef<OpenSeadragon.Viewer | null>(null);
  const overlayElements = useRef<HTMLDivElement[]>([]);
  const [viewerReady, setViewerReady] = useState(false);
  const [currentZoom, setCurrentZoom] = useState(1);
  const pendingViewportRef = useRef<{ zoom: number; center: OpenSeadragon.Point } | null>(null);
  const viewerOpenRef = useRef(false);
  
  // Store the home position and zoom for full height mode
  const homePositionRef = useRef<{ center: any; zoom: number } | null>(null);
  
  // Variables for home position calculation
  let homeZoomLevel = 1;
  let homeCenter: any = null;
  let storedHomeZoom = 1;

  // Set up OpenSeadragon viewer
  useEffect(() => {
    setViewerReady(false);
    if (!viewerRef.current) return;
    if (osdViewer.current) {
      // The previous effect's cleanup (below) already captured the viewport and destroyed
      // this instance before this body ran; this is just a defensive fallback.
      osdViewer.current.destroy();
      osdViewer.current = null;
    }

    let cancelled = false;

    async function resolveTileSources(): Promise<OpenSeadragon.TileSourceOptions | string> {
      if (!tileInfoUrl || !tileUrlBase) return imageUrl;
      const response = await fetch(tileInfoUrl, { cache: 'no-store' });
      if (!response.ok) {
        if (response.status === 404) return imageUrl;
        throw new Error(`tile info failed (${response.status})`);
      }
      const info: TileInfo = await response.json();
      return {
          width: info.width,
          height: info.height,
          tileSize: info.tileSize,
          minLevel: 0,
          maxLevel: info.maxLevel,
          getTileUrl: (level: number, x: number, y: number) => `${tileUrlBase}?level=${level}&x=${x}&y=${y}`,
      } as unknown as OpenSeadragon.TileSourceOptions;
    }

    resolveTileSources().then(tileSources => {
      if (cancelled || !viewerRef.current) return;
      createViewer(tileSources);
    }).catch(() => {
      if (!cancelled) onError?.();
    });

    function createViewer(tileSources: OpenSeadragon.TileSourceOptions | string) {
    osdViewer.current = OpenSeadragon({
      element: viewerRef.current!,
      prefixUrl: "//openseadragon.github.io/openseadragon/images/",
      tileSources,
      showNavigator: false,
      showFullPageControl: false,
      showHomeControl: false,
      showZoomControl: false,
      showRotationControl: false,
      minZoomLevel: fullHeight ? 0.1 : 0.5,
      defaultZoomLevel: fullHeight ? 0.5 : 1,
      maxZoomLevel: 20,
      visibilityRatio: 1.0,
      constrainDuringPan: true,
      preserveImageSizeOnResize: true,
      blendTime: 0.1,
      navigatorPosition: "TOP_RIGHT",
      navigatorHeight: "100px",
      navigatorWidth: "100px",
      gestureSettingsMouse: disableZoom ? { scrollToZoom: false, clickToZoom: false, dblClickToZoom: false, pinchToZoom: false, flickEnabled: false, dragToPan: false } : undefined,
      gestureSettingsTouch: disableZoom ? { pinchToZoom: false, flickEnabled: false, dragToPan: false, dblClickToZoom: false } : undefined,
      gestureSettingsPen: disableZoom ? { pinchToZoom: false, flickEnabled: false, dragToPan: false, dblClickToZoom: false } : undefined,
      gestureSettingsUnknown: disableZoom ? { pinchToZoom: false, flickEnabled: false, dragToPan: false, dblClickToZoom: false } : undefined,
    });
    
    // Additional disabling of navigation and controls
    if (disableZoom && osdViewer.current) {
      osdViewer.current.setMouseNavEnabled(false);
      osdViewer.current.setControlsEnabled(false);
    }
    
    // Add zoom handler
    osdViewer.current.addHandler("zoom", (event: OpenSeadragon.ZoomEvent) => {
      if (onZoom) {
        onZoom(event.zoom);
      }
      setCurrentZoom(event.zoom);
    });
    
    osdViewer.current.addHandler("open-failed", () => {
      onError?.();
    });

    osdViewer.current.addHandler("open", () => {
      setViewerReady(true);
      viewerOpenRef.current = true;
      onLoad?.();
      if (preserveViewport && pendingViewportRef.current) {
        const { zoom, center } = pendingViewportRef.current;
        osdViewer.current!.viewport.zoomTo(zoom, undefined, true);
        osdViewer.current!.viewport.panTo(center, true);
        pendingViewportRef.current = null;
        setTimeout(() => addOverlays(), 500);
        return;
      }
      // Log image content size
      const tiledImage = osdViewer.current!.world.getItemAt(0);
      if (tiledImage) {
        const size = tiledImage.getContentSize();
        console.log('OpenSeadragon image content size:', size);

        // If in full height mode, fit the image to the viewport
        if (fullHeight) {
          setTimeout(() => {
            if (osdViewer.current) {
              const tiledImage = osdViewer.current.world.getItemAt(0);
              if (tiledImage) {
                const bounds = tiledImage.getBounds();
                osdViewer.current.viewport.fitBounds(bounds, true);
                
                // Calculate the home zoom level for full frame view
                const imageSize = tiledImage.getContentSize();
                const viewportSize = osdViewer.current.viewport.getContainerSize();
                const homeZoomX = viewportSize.x / imageSize.x;
                const homeZoomY = viewportSize.y / imageSize.y;
                const homeZoom = Math.min(homeZoomX, homeZoomY);
                
                // Update the home zoom level
                homeZoomLevel = homeZoom;
                
                // Store the home position and zoom
                homeCenter = osdViewer.current.viewport.getCenter();
                storedHomeZoom = osdViewer.current.viewport.getZoom();
                
                // Store in ref for the custom button
                homePositionRef.current = {
                  center: homeCenter,
                  zoom: storedHomeZoom
                };
                
                // Try to establish this as the home position by calling goHome
                // This should set the current view as the home position
                setTimeout(() => {
                  if (osdViewer.current) {
                    osdViewer.current.viewport.goHome();
                  }
                }, 100);
              }
            }
          }, 300);
        } else {
          // For non-expanded mode, also fit the image to the frame
          setTimeout(() => {
            if (osdViewer.current) {
              const tiledImage = osdViewer.current.world.getItemAt(0);
              if (tiledImage) {
                const bounds = tiledImage.getBounds();
                osdViewer.current.viewport.fitBounds(bounds, true);
                
                // Store the home position using the actual zoom after fitBounds
                homePositionRef.current = {
                  center: osdViewer.current.viewport.getCenter(),
                  zoom: osdViewer.current.viewport.getZoom()
                };
              }
            }
          }, 300);
        }
      }
      setTimeout(() => {
        addOverlays();
      }, 500);
    });
    }

    return () => {
      cancelled = true;
      if (osdViewer.current) {
        if (preserveViewport && viewerOpenRef.current) {
          pendingViewportRef.current = {
            zoom: osdViewer.current.viewport.getZoom(),
            center: osdViewer.current.viewport.getCenter(),
          };
        }
        viewerOpenRef.current = false;
        osdViewer.current.destroy();
        osdViewer.current = null;
      }
    };
  }, [imageUrl, tileInfoUrl, tileUrlBase, onZoom, fullHeight, disableZoom, preserveViewport, onLoad, onError]);

  // Function to add overlays
  const addOverlays = useCallback(() => {
    if (!osdViewer.current) return;
    
    // Remove old overlays
    overlayElements.current.forEach(el => {
      try { osdViewer.current!.removeOverlay(el); } catch {}
    });
    overlayElements.current = [];

    // Get image bounds in viewport coordinates
    const tiledImage = osdViewer.current.world.getItemAt(0);
    if (!tiledImage) return;
    const imageRect = tiledImage.getBounds();
    const contentSize = tiledImage.getContentSize();
    const spaceX = annotationSize?.width || contentSize.x;
    const spaceY = annotationSize?.height || contentSize.y;

    // Create a container div for overlays
    const overlayContainer = document.createElement('div');
    overlayContainer.style.position = 'absolute';
    overlayContainer.style.overflow = 'hidden';
    overlayContainer.style.width = '100%';
    overlayContainer.style.height = '100%';
    overlayContainer.style.pointerEvents = 'none';
    overlayContainer.style.top = '0';
    overlayContainer.style.left = '0';
    overlayContainer.style.zIndex = '10';

    // Add annotation overlays to the container
    annotations.forEach((annotation, idx) => {
      if (annotation.pixelx == null || annotation.pixely == null) return;
      let overlayDiv;
      // Markers scale with the image so they stay visible on large frames.
      const dotSize = Math.max(8, Math.min(spaceX, spaceY) / 250);
      if (annotation.radius && annotation.radius > dotSize / 2) {
        // Render circle overlay
        overlayDiv = document.createElement('div');
        overlayDiv.style.position = 'absolute';
        overlayDiv.style.left = `${((annotation.pixelx - annotation.radius) / spaceX) * 100}%`;
        overlayDiv.style.top = `${((annotation.pixely - annotation.radius) / spaceY) * 100}%`;
        overlayDiv.style.width = `${(annotation.radius * 2 / spaceX) * 100}%`;
        overlayDiv.style.height = `${(annotation.radius * 2 / spaceY) * 100}%`;
        overlayDiv.style.border = '2px solid #00FF00';
        overlayDiv.style.borderRadius = '50%';
        overlayDiv.style.boxSizing = 'border-box';
        overlayDiv.style.pointerEvents = 'none';
        overlayDiv.style.background = 'transparent';
        if (annotation.names && annotation.names[0]) {
          const labelDiv = document.createElement('div');
          labelDiv.style.position = 'absolute';
          labelDiv.style.left = '50%';
          labelDiv.style.top = '0';
          labelDiv.style.transform = 'translate(-50%, -120%)';
          labelDiv.style.color = '#00FF00';
          labelDiv.style.fontSize = '14px';
          labelDiv.style.fontFamily = 'Arial, sans-serif';
          labelDiv.style.fontWeight = 'bold';
          labelDiv.style.textShadow = '0 0 2px #000';
          labelDiv.style.whiteSpace = 'nowrap';
          labelDiv.textContent = annotation.names[0];
          overlayDiv.appendChild(labelDiv);
        }
      } else {
        // Render dot overlay for point-like objects
        overlayDiv = document.createElement('div');
        overlayDiv.style.position = 'absolute';
        overlayDiv.style.left = `${((annotation.pixelx - dotSize / 2) / spaceX) * 100}%`;
        overlayDiv.style.top = `${((annotation.pixely - dotSize / 2) / spaceY) * 100}%`;
        overlayDiv.style.width = `${(dotSize / spaceX) * 100}%`;
        overlayDiv.style.height = `${(dotSize / spaceY) * 100}%`;
        overlayDiv.style.background = '#00FF00';
        overlayDiv.style.borderRadius = '50%';
        overlayDiv.style.boxSizing = 'border-box';
        overlayDiv.style.pointerEvents = 'none';
        if (annotation.names && annotation.names[0]) {
          const labelDiv = document.createElement('div');
          labelDiv.style.position = 'absolute';
          labelDiv.style.left = '50%';
          labelDiv.style.top = '0';
          labelDiv.style.transform = 'translate(-50%, -120%)';
          labelDiv.style.color = '#00FF00';
          labelDiv.style.fontSize = '14px';
          labelDiv.style.fontFamily = 'Arial, sans-serif';
          labelDiv.style.fontWeight = 'bold';
          labelDiv.style.textShadow = '0 0 2px #000';
          labelDiv.style.whiteSpace = 'nowrap';
          labelDiv.textContent = annotation.names[0];
          overlayDiv.appendChild(labelDiv);
        }
      }
      overlayContainer.appendChild(overlayDiv);
    });

    // Add the overlay container as an OpenSeadragon overlay
    osdViewer.current.addOverlay({
      element: overlayContainer,
      location: imageRect,
    });
    overlayElements.current.push(overlayContainer);
    osdViewer.current.forceRedraw();
  }, [annotations, disableZoom, annotationSize?.width, annotationSize?.height]);

  // Add/remove overlays when annotations change
  useEffect(() => {
    if (!osdViewer.current || !viewerReady) return;
    addOverlays();
    return () => {
      if (osdViewer.current) {
        overlayElements.current.forEach(el => {
          try { osdViewer.current!.removeOverlay(el); } catch {}
        });
        overlayElements.current = [];
      }
    };
  }, [annotations, viewerReady, addOverlays]);

  // Handle fullHeight changes
  useEffect(() => {
    if (!osdViewer.current || !viewerReady) return;
    
    if (fullHeight) {
      setTimeout(() => {
        if (osdViewer.current) {
          const tiledImage = osdViewer.current.world.getItemAt(0);
          if (tiledImage) {
            const bounds = tiledImage.getBounds();
            osdViewer.current.viewport.fitBounds(bounds, true);
            
            // Recalculate the home zoom level for full frame view
            const imageSize = tiledImage.getContentSize();
            const viewportSize = osdViewer.current.viewport.getContainerSize();
            const homeZoomX = viewportSize.x / imageSize.x;
            const homeZoomY = viewportSize.y / imageSize.y;
            const homeZoom = Math.min(homeZoomX, homeZoomY);
            
            // Update the home zoom level
            homeZoomLevel = homeZoom;
            
            // Store the home position and zoom
            homeCenter = osdViewer.current.viewport.getCenter();
            storedHomeZoom = osdViewer.current.viewport.getZoom();
            
            // Store in ref for the custom button
            homePositionRef.current = {
              center: homeCenter,
              zoom: storedHomeZoom
            };
          }
        }
      }, 300);
    } else {
      // For non-expanded mode, also fit the image to the frame
      setTimeout(() => {
        if (osdViewer.current) {
          const tiledImage = osdViewer.current.world.getItemAt(0);
          if (tiledImage) {
            const bounds = tiledImage.getBounds();
            osdViewer.current.viewport.fitBounds(bounds, true);
            
            // Store the home position using the actual zoom after fitBounds
            homePositionRef.current = {
              center: osdViewer.current.viewport.getCenter(),
              zoom: osdViewer.current.viewport.getZoom()
            };
          }
        }
      }, 300);
    }
  }, [fullHeight, viewerReady]);

  return (
    <div style={{ position: "relative", width: "100%", height: height || (fullHeight ? "100vh" : "90vh") }}>
      <div ref={viewerRef} style={{ width: "100%", height: "100%" }} />
      
      {/* Zoom percentage display (only if zoom is enabled) */}
      {!disableZoom && (
        <div
          onClick={() => {
            if (osdViewer.current && homePositionRef.current) {
              // Use stored home position for both modes
              osdViewer.current.viewport.panTo(homePositionRef.current.center);
              osdViewer.current.viewport.zoomTo(homePositionRef.current.zoom);
            }
          }}
          style={{
            position: "absolute",
            top: "10px",
            left: "10px",
            zIndex: 1000,
            background: "rgba(0, 0, 0, 0.7)",
            color: "white",
            border: "none",
            borderRadius: "4px",
            padding: "8px 12px",
            fontSize: "12px",
            fontFamily: "monospace",
            cursor: "pointer",
          }}
        >
          {Math.round(currentZoom * 100)}%
        </div>
      )}
    </div>
  );
}
