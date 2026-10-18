import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Settings, FileUp, FileImage, Loader2, Menu, ScanLine, Upload, LogOut } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Link, useLocation } from "wouter";
import { useState, useEffect, useRef } from "react";
import { useSocket } from "@/hooks/use-socket";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import type { Notification } from '@shared/types';

const NAV_LINKS = [
  { href: '/', label: 'Gallery' },
  { href: '/targets', label: 'Targets' },
  { href: '/equipment', label: 'Equipment' },
  { href: '/plate-solving', label: 'Plate Solving' },
  { href: '/fits-stacking', label: 'Stacking' },
  { href: '/sky-map', label: 'Sky Map' },
  { href: '/locations', label: 'Locations' },
] as const;

export function Header() {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  };
  const [fitsScanning, setFitsScanning] = useState(false);
  const [uploadType, setUploadType] = useState<'image' | 'fits' | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStage, setUploadStage] = useState<'uploading' | 'processing' | 'complete' | 'failed'>('uploading');
  const [uploadName, setUploadName] = useState('');
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fitsInputRef = useRef<HTMLInputElement>(null);
  const socket = useSocket();
  const { toast } = useToast();

  const isActive = (path: string) => location === path;

  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ["/api/notifications"],
  });

  const refreshNotifications = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/notifications"] });
  };

  useEffect(() => {
    if (!socket) return;

    socket.on('plate-solving-update', refreshNotifications);

    return () => {
      socket.off('plate-solving-update', refreshNotifications);
    };
  }, [socket]);

  const handleFitsScan = async () => {
    setFitsScanning(true);
    try {
      const response = await fetch('/api/fits/scan', { method: 'POST', credentials: 'include' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || `Server returned ${response.status}`);
      toast({ title: 'FITS scan completed', description: `${data.imported || 0} imported · ${data.updated || 0} updated${data.errors?.length ? ` · ${data.errors.length} failed` : ''}` });
      queryClient.invalidateQueries({ queryKey: ["/api/images"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tags"] });
    } catch (error) {
      toast({ title: 'FITS scan failed', description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setFitsScanning(false);
    }
  };

  const handleUpload = async (file: File, kind: 'image' | 'fits') => {
    setUploadType(kind);
    setUploadProgress(0);
    setUploadStage('uploading');
    setUploadName(file.name);
    try {
      const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const request = new XMLHttpRequest();
        const endpoint = kind === 'fits' ? '/api/fits/upload' : '/api/library/upload';
        request.open('POST', `${endpoint}?${new URLSearchParams({ filename: file.name })}`);
        request.withCredentials = true;
        request.setRequestHeader('Content-Type', 'application/octet-stream');
        request.upload.addEventListener('progress', progressEvent => {
          if (!progressEvent.lengthComputable) return;
          const progress = Math.min(100, Math.round((progressEvent.loaded / progressEvent.total) * 100));
          setUploadProgress(progress);
          if (progress === 100) setUploadStage('processing');
        });
        request.addEventListener('load', () => {
          let response: Record<string, unknown> = {};
          try { response = request.responseText ? JSON.parse(request.responseText) as Record<string, unknown> : {}; } catch { /* handled below */ }
          if (request.status >= 200 && request.status < 300) resolve(response);
          else reject(new Error(typeof response.message === 'string' ? response.message : `Server returned ${request.status}`));
        });
        request.addEventListener('error', () => reject(new Error(`Network error while uploading ${kind === 'fits' ? 'FITS' : 'image'}`)));
        request.addEventListener('abort', () => reject(new Error('Upload was cancelled')));
        request.send(file);
      });
      setUploadProgress(100);
      setUploadStage('complete');
      const image = data.image && typeof data.image === 'object' ? data.image as Record<string, unknown> : undefined;
      const savedName = kind === 'fits' ? data.output : image?.filename;
      toast({ title: kind === 'fits' ? 'FITS uploaded' : 'Image uploaded', description: `${typeof savedName === 'string' ? savedName : file.name} was saved in Sidereal's local library.` });
      queryClient.invalidateQueries({ queryKey: ["/api/images"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tags"] });
      window.setTimeout(() => setUploadType(null), 1800);
    } catch (error) {
      setUploadStage('failed');
      toast({ title: `${kind === 'fits' ? 'FITS' : 'Image'} upload failed`, description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' });
      window.setTimeout(() => setUploadType(null), 5000);
    }
  };

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void handleUpload(file, 'image');
    event.target.value = '';
  };

  const handleFitsUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void handleUpload(file, 'fits');
    event.target.value = '';
  };

  const unacknowledgedCount = notifications.length;

  return (
    <header className="bg-card border-b border-border sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <Link href="/" className="flex items-center space-x-2 hover:opacity-80 transition-opacity">
            <img src="/logo.png" alt="Sidereal Logo" className="h-8 w-8" />
            <h1 className="text-xl font-bold text-foreground">Sidereal</h1>
          </Link>

          {/* Desktop navigation */}
          <nav className="hidden xl:flex items-center space-x-5">
            {NAV_LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={`transition-colors ${isActive(href) ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {label}
              </Link>
            ))}
          </nav>

          {/* Right-side actions */}
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <input ref={imageInputRef} type="file" accept="image/jpeg,image/png,image/tiff,image/webp,image/gif,image/bmp,image/avif,image/heic,.jpg,.jpeg,.png,.tif,.tiff,.webp,.gif,.bmp,.avif,.heic,.heif" className="hidden" onChange={handleImageUpload} />
            <input ref={fitsInputRef} type="file" accept=".fit,.fits,.fts,application/fits" className="hidden" onChange={handleFitsUpload} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button disabled={uploadType !== null} title="Upload to Sidereal's private library" aria-label="Upload" variant="outline" className="hidden h-9 px-2 md:inline-flex 2xl:px-3">
                  {uploadType ? <Loader2 className="h-4 w-4 animate-spin 2xl:mr-2" /> : <Upload className="h-4 w-4 2xl:mr-2" />}
                  <span>{uploadType ? 'Uploading…' : 'Upload'}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => imageInputRef.current?.click()}><FileImage className="mr-2 h-4 w-4" />Photo or image</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => fitsInputRef.current?.click()}><FileUp className="mr-2 h-4 w-4" />FITS file</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={handleFitsScan} disabled={fitsScanning} title="Scan FITS library" aria-label="Scan FITS library" variant="outline" className="hidden h-9 px-2 md:inline-flex 2xl:px-3">
              {fitsScanning ? <Loader2 className="h-4 w-4 animate-spin 2xl:mr-2" /> : <ScanLine className="h-4 w-4 2xl:mr-2" />}
              <span className="inline 2xl:hidden">{fitsScanning ? 'Scanning…' : 'FITS Scan'}</span><span className="hidden 2xl:inline">{fitsScanning ? 'Scanning FITS…' : 'Scan FITS'}</span>
            </Button>
            <a
              href="https://github.com/sidereal-io/sidereal"
              target="_blank"
              rel="noopener noreferrer"
              title="View on GitHub"
              className="hidden md:inline-flex"
            >
              <Button variant="ghost" size="icon" className="h-9 w-9">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
              </Button>
            </a>
            <Link href="/admin" className="hidden md:inline-flex">
              <Button
                variant="ghost"
                size="icon"
                className="relative h-9 w-9"
                title={unacknowledgedCount > 0 ? `${unacknowledgedCount} unacknowledged notification${unacknowledgedCount > 1 ? 's' : ''}` : 'Admin Settings'}
              >
                <span className="relative inline-block">
                  <Settings className="h-5 w-5" />
                  {unacknowledgedCount > 0 && (
                    <span
                      className="absolute -top-1.5 -right-1.5 bg-red-600 text-white h-4 w-4 rounded-full flex items-center justify-center text-xs font-bold border-2 border-white"
                      style={{ minWidth: '1rem', minHeight: '1rem' }}
                    >
                      {unacknowledgedCount > 9 ? '9+' : unacknowledgedCount}
                    </span>
                  )}
                </span>
              </Button>
            </Link>
            <Button variant="ghost" size="icon" className="hidden md:inline-flex h-9 w-9" title="Sign out" onClick={signOut}>
              <LogOut className="h-5 w-5" />
            </Button>

            {/* Mobile hamburger menu */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="xl:hidden">
                  <Menu className="h-5 w-5" />
                  <span className="sr-only">Open menu</span>
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-64 p-0">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <div className="flex items-center space-x-2 px-4 h-16 border-b border-border">
                  <img src="/logo.png" alt="Sidereal Logo" className="h-8 w-8" />
                  <span className="text-xl font-bold text-foreground">Sidereal</span>
                </div>
                <nav className="flex flex-col py-2">
                  {NAV_LINKS.map(({ href, label }) => (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setMobileOpen(false)}
                      className={`px-4 py-3 text-sm font-medium transition-colors ${
                        isActive(href)
                          ? 'bg-accent text-foreground'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      }`}
                    >
                      {label}
                    </Link>
                  ))}
                  <div className="border-t border-border my-2" />
                  <button
                    onClick={() => { setMobileOpen(false); imageInputRef.current?.click(); }}
                    disabled={uploadType !== null}
                    className="px-4 py-3 text-sm font-medium transition-colors text-muted-foreground hover:bg-accent/50 hover:text-foreground flex items-center gap-2 text-left"
                  >
                    {uploadType === 'image' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileImage className="h-4 w-4" />}
                    {uploadType === 'image' ? 'Uploading image…' : 'Upload image'}
                  </button>
                  <button
                    onClick={() => { setMobileOpen(false); fitsInputRef.current?.click(); }}
                    disabled={uploadType !== null}
                    className="px-4 py-3 text-sm font-medium transition-colors text-muted-foreground hover:bg-accent/50 hover:text-foreground flex items-center gap-2 text-left"
                  >
                    {uploadType === 'fits' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
                    {uploadType === 'fits' ? 'Uploading FITS…' : 'Upload FITS'}
                  </button>
                  <button
                    onClick={() => { setMobileOpen(false); handleFitsScan(); }}
                    disabled={fitsScanning}
                    className="px-4 py-3 text-sm font-medium transition-colors text-muted-foreground hover:bg-accent/50 hover:text-foreground flex items-center gap-2 text-left"
                  >
                    {fitsScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}
                    {fitsScanning ? 'Scanning FITS...' : 'Scan FITS'}
                  </button>
                  <Link
                    href="/admin"
                    onClick={() => setMobileOpen(false)}
                    className={`px-4 py-3 text-sm font-medium transition-colors flex items-center justify-between ${
                      isActive('/admin')
                        ? 'bg-accent text-foreground'
                        : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                    }`}
                  >
                    Admin Settings
                    {unacknowledgedCount > 0 && (
                      <span className="bg-red-600 text-white h-5 w-5 rounded-full flex items-center justify-center text-xs font-bold">
                        {unacknowledgedCount > 9 ? '9+' : unacknowledgedCount}
                      </span>
                    )}
                  </Link>
                  <button
                    onClick={signOut}
                    className="px-4 py-3 text-sm font-medium transition-colors text-muted-foreground hover:bg-accent/50 hover:text-foreground flex items-center gap-2 text-left"
                  >
                    <LogOut className="h-4 w-4" /> Sign out
                  </button>
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
      {uploadType !== null && (
        <div className="fixed bottom-4 right-4 z-50 w-72 rounded-lg border border-border bg-card p-3 shadow-lg" role="status" aria-live="polite">
          <div className="mb-2 flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-medium">{uploadName}</span>
            <span className={uploadStage === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
              {uploadStage === 'uploading' ? `${uploadProgress}%` : uploadStage === 'processing' ? 'Saving' : uploadStage === 'complete' ? 'Done' : 'Failed'}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className={`h-full rounded-full transition-all duration-200 ${uploadStage === 'failed' ? 'bg-destructive' : uploadStage === 'complete' ? 'bg-green-500' : 'bg-primary'}`} style={{ width: `${uploadProgress}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {uploadStage === 'uploading' ? `Uploading ${uploadType === 'fits' ? 'FITS' : 'image'}…` : uploadStage === 'processing' ? 'Saving locally and adding to the gallery…' : uploadStage === 'complete' ? 'Saved to Sidereal’s local library.' : 'Upload failed; see the notification for details.'}
          </p>
        </div>
      )}
    </header>
  );
}
