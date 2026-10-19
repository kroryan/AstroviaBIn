import { useEffect, useState } from "react";
import { DEFAULT_SKY_LAYERS, type SkyLayers, type SkyOverlayData } from "@/lib/sky-overlay-renderer";

const STORAGE_KEY = "astroviabin.skyLayers";

const LABELS: Record<keyof SkyLayers, string> = {
  objects: "Deep sky",
  stars: "Stars",
  constellations: "Constellations",
  grid: "RA/Dec grid",
  labels: "Labels",
};

const COLORS: Record<keyof SkyLayers, string> = {
  objects: "#00f0ff",
  stars: "#f9f002",
  constellations: "#ff2bd6",
  grid: "#7a5cff",
  labels: "#e9e6ff",
};

/** Remembers the viewer's annotation layer choice per browser. */
export function useSkyLayers(): [SkyLayers, (layers: SkyLayers) => void] {
  const [layers, setLayers] = useState<SkyLayers>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? { ...DEFAULT_SKY_LAYERS, ...JSON.parse(stored) } : DEFAULT_SKY_LAYERS;
    } catch {
      return DEFAULT_SKY_LAYERS;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(layers)); } catch { /* storage unavailable */ }
  }, [layers]);
  return [layers, setLayers];
}

function formatSize(degrees: number): string {
  return degrees >= 1 ? `${degrees.toFixed(2)}°` : `${(degrees * 60).toFixed(1)}′`;
}

export function SkyLayerToggles({ layers, onChange, overlay, compact = false }: {
  layers: SkyLayers;
  onChange: (layers: SkyLayers) => void;
  overlay?: SkyOverlayData | null;
  compact?: boolean;
}) {
  return (
    <div className={`cyber-panel pointer-events-auto bg-black/70 backdrop-blur-sm px-3 py-2 text-xs ${compact ? "space-y-1" : "space-y-2"}`}>
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(LABELS) as Array<keyof SkyLayers>).map(key => (
          <button
            key={key}
            type="button"
            onClick={() => onChange({ ...layers, [key]: !layers[key] })}
            className="px-2 py-0.5 border font-mono uppercase tracking-wider transition-colors"
            style={{
              borderColor: COLORS[key],
              color: layers[key] ? "#04020a" : COLORS[key],
              background: layers[key] ? COLORS[key] : "transparent",
              opacity: layers[key] ? 1 : 0.75,
            }}
            aria-pressed={layers[key]}
          >
            {LABELS[key]}
          </button>
        ))}
      </div>
      {overlay && !compact && (
        <p className="font-mono text-[10px] text-gray-300">
          Field {formatSize(overlay.field.widthDeg)} × {formatSize(overlay.field.heightDeg)} · {overlay.field.pixelScale.toFixed(2)}″/px
          {overlay.field.constellation ? ` · ${overlay.field.constellation}` : ""} · {overlay.stars.length} stars · {overlay.objects.length} deep-sky
        </p>
      )}
    </div>
  );
}
