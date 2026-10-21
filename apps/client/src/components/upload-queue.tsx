import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, CopyCheck, Loader2, Upload, X, XCircle } from "lucide-react";
import { createSHA256 } from "hash-wasm";
import { uploadNameKey } from "@shared/upload-names";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

/**
 * Upload any mix of photos and FITS in one go: each file goes to its endpoint by extension,
 * one at a time, with per-file progress and a summary at the end. Files whose exact content is already
 * in the library (same size and SHA-256, whatever the name) are skipped without uploading them.
 */

const FITS_EXTENSIONS = [".fit", ".fits", ".fts"];
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".tif", ".tiff", ".webp", ".gif", ".bmp", ".avif", ".heic", ".heif"];
/** For the file picker: every supported photo and FITS type. */
export const UPLOAD_ACCEPT = [...IMAGE_EXTENSIONS, ...FITS_EXTENSIONS, "image/*", "application/fits"].join(",");

type Kind = "image" | "fits";
type Stage = "queued" | "checking" | "uploading" | "processing" | "done" | "duplicate" | "failed";
export interface UploadItem { id: number; name: string; kind: Kind | null; progress: number; stage: Stage; error?: string }

export function kindOf(name: string): Kind | null {
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  if (FITS_EXTENSIONS.includes(extension)) return "fits";
  if (IMAGE_EXTENSIONS.includes(extension)) return "image";
  return null;
}

/** SHA-256 of a file, read in chunks (hash-wasm: works on plain-http LAN addresses where crypto.subtle is unavailable). */
async function sha256Of(file: File): Promise<string> {
  const hasher = await createSHA256();
  hasher.init();
  const chunk = 8 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunk) {
    hasher.update(new Uint8Array(await file.slice(offset, offset + chunk).arrayBuffer()));
  }
  return hasher.digest("hex");
}

/** Which of these (size, SHA-256) are already stored on the server. */
async function existingHashes(files: Array<{ size: number; sha256: string }>): Promise<Set<string>> {
  const found = new Set<string>();
  for (let start = 0; start < files.length; start += 2000) {
    const response = await fetch("/api/library/upload-check", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: files.slice(start, start + 2000) }),
    });
    if (!response.ok) continue; // The server checks again on upload.
    for (const sha256 of (await response.json() as { existing: string[] }).existing) found.add(sha256);
  }
  return found;
}

/** What the server holds: byte sizes, and "name key:size" of every stored file. */
async function storedFiles(): Promise<{ sizes: Set<number>; named: Set<string> }> {
  try {
    const response = await fetch("/api/library/upload-check", { credentials: "include" });
    if (!response.ok) return { sizes: new Set(), named: new Set() };
    const known = await response.json() as { sizes: number[]; named: string[] };
    return { sizes: new Set(known.sizes), named: new Set(known.named) };
  } catch {
    return { sizes: new Set(), named: new Set() };
  }
}

/** Parallel uploads: enough to keep the connection busy while the server saves the previous files. */
const PARALLEL_UPLOADS = 3;

/** Resolves "duplicate" when the server found the same content already stored. */
function send(file: File, kind: Kind, onProgress: (percent: number) => void): Promise<"stored" | "duplicate"> {
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
      if (request.status >= 200 && request.status < 300) resolve((response as { duplicate?: unknown }).duplicate ? "duplicate" : "stored");
      else reject(new Error(typeof response.message === "string" ? response.message : `Server returned ${request.status}`));
    });
    request.addEventListener("error", () => reject(new Error("Network error")));
    request.addEventListener("abort", () => reject(new Error("Upload was cancelled")));
    request.send(file);
  });
}

const ACTIVE: Stage[] = ["queued", "checking", "uploading", "processing"];

export function useUploadQueue() {
  const [items, setItems] = useState<UploadItem[]>([]);
  const queue = useRef<Array<{ id: number; file: File }>>([]);
  const running = useRef(false);
  const nextId = useRef(1);
  const batch = useRef({ done: 0, failed: 0, images: 0, fits: 0, skipped: 0, duplicates: 0 });
  const { toast } = useToast();

  const update = (id: number, patch: Partial<UploadItem>) =>
    setItems(previous => previous.map(item => (item.id === id ? { ...item, ...patch } : item)));

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    while (queue.current.length) {
      // 1. Review the whole selection before uploading anything. Skipped: files with the name and size of
      //    a stored file, and files whose content (SHA-256) is stored under another name. Only files with
      //    the size of a stored file need hashing. A different file that shares a name is uploaded.
      const pending = queue.current.splice(0);
      const { sizes, named } = await storedFiles();
      const sameName = new Set<number>();
      const selected = new Set<string>();
      for (const { id, file } of pending) {
        const key = `${uploadNameKey(file.name)}:${file.size}`;
        // Already stored, or a second copy inside this same selection.
        if (named.has(key) || selected.has(key)) sameName.add(id);
        selected.add(key);
      }
      const candidates = pending.filter(({ id, file }) => !sameName.has(id) && kindOf(file.name) && sizes.has(file.size));
      for (const { id } of candidates) update(id, { stage: "checking" });
      const hashes = new Map<number, string>();
      for (const { id, file } of candidates) {
        try { hashes.set(id, await sha256Of(file)); } catch { /* unreadable here: the server still checks */ }
      }
      const stored = await existingHashes(candidates.flatMap(({ id, file }) => hashes.has(id) ? [{ size: file.size, sha256: hashes.get(id)! }] : []))
        .catch(() => new Set<string>());
      const toUpload: typeof pending = [];
      for (const item of pending) {
        const hash = hashes.get(item.id);
        if (sameName.has(item.id) || (hash && stored.has(hash))) {
          update(item.id, { stage: "duplicate", progress: 100 });
          batch.current.duplicates++;
        } else {
          if (hashes.has(item.id) || candidates.includes(item)) update(item.id, { stage: "queued" });
          toUpload.push(item);
        }
      }
      // 2. Upload only the new files, a few at a time.
      const uploadOne = async ({ id, file }: (typeof toUpload)[number]) => {
        const kind = kindOf(file.name);
        if (!kind) {
          update(id, { stage: "failed", error: "Not a supported photo or FITS file" });
          batch.current.failed++;
          return;
        }
        try {
          update(id, { stage: "uploading" });
          const outcome = await send(file, kind, progress => update(id, { progress, stage: progress >= 100 ? "processing" : "uploading" }));
          if (outcome === "duplicate") {
            update(id, { stage: "duplicate", progress: 100 });
            batch.current.duplicates++;
            return;
          }
          update(id, { stage: "done", progress: 100 });
          batch.current.done++;
          batch.current[kind === "fits" ? "fits" : "images"]++;
          queryClient.invalidateQueries({ queryKey: ["/api/images"] });
        } catch (error) {
          update(id, { stage: "failed", error: error instanceof Error ? error.message : "Upload failed" });
          batch.current.failed++;
        }
      };
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, toUpload.length) }, async () => {
        while (next < toUpload.length) await uploadOne(toUpload[next++]);
      }));
    }
    running.current = false;
    const { done, failed, images, fits, skipped, duplicates } = batch.current;
    batch.current = { done: 0, failed: 0, images: 0, fits: 0, skipped: 0, duplicates: 0 };
    for (const key of ["/api/images", "/api/stats", "/api/tags", "/api/fits", "/api/gallery-catalogs"]) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
    const parts = [images && `${images} photo${images === 1 ? "" : "s"}`, fits && `${fits} FITS`].filter(Boolean).join(" and ");
    toast({
      title: failed ? `${done} uploaded, ${failed} failed` : `${done} file${done === 1 ? "" : "s"} uploaded`,
      description: `${done ? `${parts} saved in AstroviaBin's local library.` : failed ? "See the upload panel for the reasons." : ""}${duplicates ? ` ${duplicates} already in the library (not uploaded again).` : ""}${skipped ? ` ${skipped} other file${skipped === 1 ? "" : "s"} in the folder skipped.` : ""}`,
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

  const clear = useCallback(() => setItems(previous => previous.filter(item => ACTIVE.includes(item.stage))), []);
  const busy = items.some(item => ACTIVE.includes(item.stage));
  return { items, busy, enqueue, clear };
}

export function UploadQueuePanel({ items, busy, onClose }: { items: UploadItem[]; busy: boolean; onClose: () => void }) {
  if (!items.length) return null;
  const finished = items.filter(item => !ACTIVE.includes(item.stage)).length;
  const current = items.find(item => item.stage === "uploading" || item.stage === "processing");
  const duplicates = items.filter(item => item.stage === "duplicate").length;
  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-3 shadow-lg" role="status" aria-live="polite">
      <div className="mb-2 flex items-center justify-between gap-2 text-sm">
        <span className="font-medium">{items.some(item => item.stage === "checking") ? `Checking ${items.length} file${items.length === 1 ? "" : "s"} against the server…` : busy ? `Uploading ${Math.min(finished + 1, items.length)} of ${items.length}` : `Uploads finished (${items.length})`}
          {duplicates > 0 && <span className="ml-1 font-normal text-muted-foreground">· {duplicates} already stored</span>}</span>
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
              : item.stage === "duplicate" ? <CopyCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              : item.stage === "failed" ? <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />
              : item.stage === "queued" ? <Upload className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              : <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
            <span className="truncate flex-1">{item.name}</span>
            <span className={`shrink-0 font-mono ${item.stage === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
              {item.kind === "fits" ? "FITS " : ""}{item.stage === "uploading" ? `${item.progress}%` : item.stage === "processing" ? "saving" : item.stage === "checking" ? "checking" : item.stage === "duplicate" ? "already stored" : item.stage === "failed" ? "failed" : item.stage === "done" ? "done" : "queued"}
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
