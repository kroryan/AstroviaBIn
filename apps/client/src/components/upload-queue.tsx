import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Upload, X, XCircle } from "lucide-react";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

/**
 * Upload any mix of photos and FITS in one go: each file goes to its endpoint by extension,
 * one at a time, with per-file progress and a summary at the end.
 */

const FITS_EXTENSIONS = [".fit", ".fits", ".fts"];
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".gif", ".bmp", ".avif", ".heic", ".heif"];
/** For the file picker: every supported photo and FITS type. */
export const UPLOAD_ACCEPT = [...IMAGE_EXTENSIONS, ...FITS_EXTENSIONS, "image/*", "application/fits"].join(",");

type Kind = "image" | "fits";
type Stage = "queued" | "uploading" | "processing" | "done" | "failed";
export interface UploadItem { id: number; name: string; kind: Kind | null; progress: number; stage: Stage; error?: string }

export function kindOf(name: string): Kind | null {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (FITS_EXTENSIONS.includes(extension)) return "fits";
  if (IMAGE_EXTENSIONS.includes(extension)) return "image";
  return null;
}

function send(file: File, kind: Kind, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const endpoint = kind === "fits" ? "/api/fits/upload" : "/api/library/upload";
    request.open("POST", `${endpoint}?${new URLSearchParams({ filename: file.name })}`);
    request.withCredentials = true;
    request.setRequestHeader("Content-Type", "application/octet-stream");
    request.upload.addEventListener("progress", event => {
      if (event.lengthComputable) onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    });
    request.addEventListener("load", () => {
      let response: { message?: unknown } = {};
      try { response = request.responseText ? JSON.parse(request.responseText) : {}; } catch { /* handled below */ }
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(typeof response.message === "string" ? response.message : `Server returned ${request.status}`));
    });
    request.addEventListener("error", () => reject(new Error("Network error")));
    request.addEventListener("abort", () => reject(new Error("Upload was cancelled")));
    request.send(file);
  });
}

export function useUploadQueue() {
  const [items, setItems] = useState<UploadItem[]>([]);
  const queue = useRef<Array<{ id: number; file: File }>>([]);
  const running = useRef(false);
  const nextId = useRef(1);
  const batch = useRef({ done: 0, failed: 0, images: 0, fits: 0, skipped: 0 });
  const { toast } = useToast();

  const update = (id: number, patch: Partial<UploadItem>) =>
    setItems(previous => previous.map(item => (item.id === id ? { ...item, ...patch } : item)));

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    while (queue.current.length) {
      const { id, file } = queue.current.shift()!;
      const kind = kindOf(file.name);
      if (!kind) {
        update(id, { stage: "failed", error: "Not a supported photo or FITS file" });
        batch.current.failed++;
        continue;
      }
      update(id, { stage: "uploading" });
      try {
        await send(file, kind, progress => update(id, { progress, stage: progress >= 100 ? "processing" : "uploading" }));
        update(id, { stage: "done", progress: 100 });
        batch.current.done++;
        batch.current[kind === "fits" ? "fits" : "images"]++;
        queryClient.invalidateQueries({ queryKey: ["/api/images"] });
      } catch (error) {
        update(id, { stage: "failed", error: error instanceof Error ? error.message : "Upload failed" });
        batch.current.failed++;
      }
    }
    running.current = false;
    const { done, failed, images, fits, skipped } = batch.current;
    batch.current = { done: 0, failed: 0, images: 0, fits: 0, skipped: 0 };
    for (const key of ["/api/images", "/api/stats", "/api/tags", "/api/fits", "/api/gallery-catalogs"]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
    const parts = [images && `${images} photo${images === 1 ? "" : "s"}`, fits && `${fits} FITS`].filter(Boolean).join(" and ");
    toast({
      title: failed ? `${done} uploaded, ${failed} failed` : `${done} file${done === 1 ? "" : "s"} uploaded`,
      description: `${done ? `${parts} saved in AstroviaBin's local library.` : "See the upload panel for the reasons."}${skipped ? ` ${skipped} other file${skipped === 1 ? "" : "s"} in the folder skipped.` : ""}`,
      variant: failed && !done ? "destructive" : undefined,
    });
  }, [toast]);

  /** `skipUnsupported`: folder uploads silently leave out non-photo/FITS files (sidecars, notes…). */
  const enqueue = useCallback((files: File[] | FileList, options: { skipUnsupported?: boolean } = {}) => {
    const all = [...files].filter(file => !/^\./.test(file.name)); // hidden files (.DS_Store…)
    const list = options.skipUnsupported ? all.filter(file => kindOf(file.name)) : all;
    const skipped = [...files].length - list.length;
    if (!list.length) {
      if (skipped) toast({ title: "Nothing to upload", description: `No photos or FITS found (${skipped} other file${skipped === 1 ? "" : "s"} skipped).` });
      return;
    }
    batch.current.skipped += skipped;
    const added = list.map(file => ({ id: nextId.current++, file }));
    queue.current.push(...added);
    const continuing = running.current;
    setItems(previous => [
      // A new batch replaces the finished list; files added during a batch join it.
      ...(continuing ? previous : []),
      ...added.map(({ id, file }) => ({ id, name: file.name, kind: kindOf(file.name), progress: 0, stage: "queued" as Stage })),
    ]);
    void run();
  }, [run, toast]);

  const clear = useCallback(() => setItems(previous => previous.filter(item => item.stage === "queued" || item.stage === "uploading" || item.stage === "processing")), []);
  const busy = items.some(item => item.stage === "queued" || item.stage === "uploading" || item.stage === "processing");
  return { items, busy, enqueue, clear };
}

export function UploadQueuePanel({ items, busy, onClose }: { items: UploadItem[]; busy: boolean; onClose: () => void }) {
  if (!items.length) return null;
  const finished = items.filter(item => item.stage === "done" || item.stage === "failed").length;
  const current = items.find(item => item.stage === "uploading" || item.stage === "processing");
  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-3 shadow-lg" role="status" aria-live="polite">
      <div className="mb-2 flex items-center justify-between gap-2 text-sm">
        <span className="font-medium">{busy ? `Uploading ${Math.min(finished + 1, items.length)} of ${items.length}` : `Uploads finished (${items.length})`}</span>
        {!busy && <button type="button" aria-label="Close upload panel" className="text-muted-foreground hover:text-foreground" onClick={onClose}><X className="h-4 w-4" /></button>}
      </div>
      <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-all duration-200"
          style={{ width: `${Math.round(((finished + (current ? current.progress / 100 : 0)) / items.length) * 100)}%` }} />
      </div>
      <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
        {items.map(item => (
          <li key={item.id} className="flex items-center gap-2 min-w-0" title={item.error || item.name}>
            {item.stage === "done" ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
              : item.stage === "failed" ? <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
              : item.stage === "queued" ? <Upload className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              : <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
            <span className="truncate flex-1">{item.name}</span>
            <span className={`shrink-0 font-mono ${item.stage === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
              {item.kind === "fits" ? "FITS " : ""}{item.stage === "uploading" ? `${item.progress}%` : item.stage === "processing" ? "saving" : item.stage === "failed" ? "failed" : item.stage === "done" ? "done" : "queued"}
            </span>
          </li>
        ))}
      </ul>
      {items.some(item => item.stage === "failed") && !busy && (
        <p className="mt-2 text-[11px] text-destructive">Hover a failed file for the reason.</p>
      )}
    </div>
  );
}

/** Drop photos and FITS anywhere on the page to upload them. */
export function useFileDrop(enabled: boolean, onFiles: (files: File[] | FileList, options?: { skipUnsupported?: boolean }) => void): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const hasFiles = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes("Files"));
    const enter = (event: DragEvent) => { if (hasFiles(event)) { depth++; setDragging(true); } };
    const leave = (event: DragEvent) => { if (hasFiles(event)) { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); } };
    const over = (event: DragEvent) => { if (hasFiles(event)) event.preventDefault(); };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const entries = [...(event.dataTransfer?.items ?? [])].map(item => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => Boolean(entry));
      if (entries.some(entry => entry.isDirectory)) {
        // Dropped folders: walk them (and their subfolders) for photos and FITS.
        void Promise.all(entries.map(filesIn)).then(lists => onFiles(lists.flat(), { skipUnsupported: true }));
      } else if (event.dataTransfer?.files.length) {
        onFiles(event.dataTransfer.files);
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [enabled, onFiles]);
  return dragging;
}

/** Every file in a dropped file or folder entry, subfolders included. */
async function filesIn(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) {
    return new Promise(resolve => (entry as FileSystemFileEntry).file(file => resolve([file]), () => resolve([])));
  }
  if (!entry.isDirectory) return [];
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  // readEntries returns at most ~100 entries per call; keep reading until it returns none.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>(resolve => reader.readEntries(resolve, () => resolve([])));
    if (!batch.length) break;
    children.push(...batch);
  }
  return (await Promise.all(children.map(filesIn))).flat();
}
