import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Crosshair, Loader, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import type { AstroImage } from "@shared/schema";

const SOLAR_SYSTEM_TAGS = new Set(['solar system', 'sun', 'moon', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto']);

interface PlateSolveControlsProps {
  image: AstroImage;
  job?: { status?: string; error?: string | null } | null;
  annotationsSource?: string;
  annotationsMessage?: string;
  dark?: boolean;
}

/** Starts (or repeats) a private local solve, optionally guided by the target's RA/Dec. */
export function PlateSolveControls({ image, job, annotationsSource, annotationsMessage, dark = false }: PlateSolveControlsProps) {
  const queryClient = useQueryClient();
  const [showHint, setShowHint] = useState(false);
  const [ra, setRa] = useState("");
  const [dec, setDec] = useState("");
  const [radius, setRadius] = useState("3");
  const [scaleLow, setScaleLow] = useState("");
  const [scaleHigh, setScaleHigh] = useState("");
  const tags = image.tags?.map(tag => tag.trim().toLowerCase()) || [];
  const eligible = (tags.includes('deep sky') || Boolean(image.plateSolved)) && !tags.some(tag => SOLAR_SYSTEM_TAGS.has(tag));
  const processing = job?.status === 'processing';

  const solve = useMutation({
    mutationFn: async () => {
      const hint = ra.trim() && dec.trim()
        ? { ra: ra.trim(), dec: dec.trim(), radius: radius.trim() || undefined, scaleLow: scaleLow.trim() || undefined, scaleHigh: scaleHigh.trim() || undefined }
        : undefined;
      const response = await apiRequest("POST", `/api/plate-solving/images/${image.id}/plate-solve`, hint ? { hint } : {});
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/images", image.id, "plate-solving-job"] });
      queryClient.invalidateQueries({ queryKey: ["/api/plate-solving/jobs"] });
    },
  });

  const muted = dark ? "text-gray-400" : "text-muted-foreground";
  const inputClass = dark ? "h-8 text-xs bg-black/40 border-white/20 text-white" : "h-8 text-xs";
  const errorText = solve.error instanceof Error ? solve.error.message.replace(/^\d+:\s*/, '') : null;

  return (
    <div className="mt-3 space-y-2">
      {annotationsSource === 'legacy' && annotationsMessage && (
        <p className="text-xs text-amber-300 flex gap-1"><AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />{annotationsMessage}</p>
      )}
      {job?.status === 'failed' && job.error && (
        <p className="text-xs text-red-400 break-words">Last attempt failed: {job.error}</p>
      )}
      {!eligible ? (
        <p className={`text-xs ${muted}`}>Add the Deep Sky tag to plate solve this image (Solar System frames cannot be solved).</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={processing || solve.isPending}
              onClick={() => solve.mutate()}
              className={dark ? "bg-black/50 text-white border-white/20 hover:bg-black/70" : undefined}
            >
              {processing || solve.isPending ? <Loader className="mr-2 h-4 w-4 animate-spin" /> : <Crosshair className="mr-2 h-4 w-4" />}
              {processing ? "Solving…" : image.plateSolved ? "Re-solve locally" : "Solve locally"}
            </Button>
            <button type="button" onClick={() => setShowHint(value => !value)} className={`text-xs flex items-center gap-1 ${muted} hover:underline`}>
              {showHint ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Coordinate hint
            </button>
          </div>
          {showHint && (
            <div className="grid grid-cols-2 gap-2">
              <label className={`text-[11px] ${muted}`}>RA (° or hh:mm:ss)
                <Input value={ra} onChange={event => setRa(event.target.value)} placeholder="12:05:15" className={inputClass} />
              </label>
              <label className={`text-[11px] ${muted}`}>Dec (° or ±dd:mm:ss)
                <Input value={dec} onChange={event => setDec(event.target.value)} placeholder="+76:54:21" className={inputClass} />
              </label>
              <label className={`text-[11px] ${muted}`}>Search radius (°)
                <Input value={radius} onChange={event => setRadius(event.target.value)} inputMode="decimal" className={inputClass} />
              </label>
              <div className="grid grid-cols-2 gap-1">
                <label className={`text-[11px] ${muted}`}>Scale min ("/px)
                  <Input value={scaleLow} onChange={event => setScaleLow(event.target.value)} inputMode="decimal" className={inputClass} />
                </label>
                <label className={`text-[11px] ${muted}`}>max ("/px)
                  <Input value={scaleHigh} onChange={event => setScaleHigh(event.target.value)} inputMode="decimal" className={inputClass} />
                </label>
              </div>
              <p className={`col-span-2 text-[11px] ${muted}`}>
                Optional. Sparse or noisy frames solve far more reliably near the target position. Without a hint Sidereal tries the previous solution, FITS pointing and any M/NGC/IC name in the title, then searches blind.
              </p>
            </div>
          )}
          {errorText && <p className="text-xs text-red-400">{errorText}</p>}
        </>
      )}
    </div>
  );
}
