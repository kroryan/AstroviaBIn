import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Settings, Loader2, Menu, ScanLine, Upload, LogOut } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useState, useEffect, useRef } from "react";
import { useSocket } from "@/hooks/use-socket";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import { UPLOAD_ACCEPT, UploadQueuePanel, useFileDrop, useUploadQueue } from "@/components/upload-queue";
import { createPortal } from "react-dom";
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
  const { user, isAdmin, canEdit } = useCurrentUser();
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  };
  const [fitsScanning, setFitsScanning] = useState(false);
  const uploads = useUploadQueue();
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const dragging = useFileDrop(canEdit, uploads.enqueue);
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

  const handleFilesChosen = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files?.length) uploads.enqueue(event.target.files);
    event.target.value = '';
  };

  const unacknowledgedCount = notifications.length;

  return (
    <header className="cyber-header sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <Link href="/" className="flex shrink-0 items-center gap-2 mr-6 hover:opacity-90 transition-opacity">
            <img src="/logo.svg" alt="AstroviaBin logo" className="h-9 w-9 drop-shadow-[0_0_8px_rgba(0,240,255,0.6)]" />
            <h1 className="cyber-wordmark text-lg whitespace-nowrap" style={{ textShadow: 'none' }}>ASTROVIA<span className="opacity-90">BIN</span></h1>
          </Link>

          {/* Desktop navigation */}
          <nav className="hidden xl:flex flex-1 items-center gap-4">
            {NAV_LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className={`font-display whitespace-nowrap text-[0.66rem] uppercase tracking-[0.14em] transition-all ${isActive(href) ? 'neon-text-cyan border-b border-[#00f0ff] pb-0.5' : 'text-muted-foreground hover:text-[#ff2bd6]'}`}
              >
                {label}
              </Link>
            ))}
          </nav>

          {/* Right-side actions */}
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <input ref={uploadInputRef} type="file" multiple accept={UPLOAD_ACCEPT} className="hidden" onChange={handleFilesChosen} />
            {canEdit && <Button onClick={() => uploadInputRef.current?.click()} title="Upload photos and FITS (several at once, or drop them on the page)" aria-label="Upload" variant="outline" className="hidden h-9 px-2 md:inline-flex 2xl:px-3">
              {uploads.busy ? <Loader2 className="h-4 w-4 animate-spin 2xl:mr-2" /> : <Upload className="h-4 w-4 2xl:mr-2" />}
              <span>{uploads.busy ? 'Uploading…' : 'Upload'}</span>
            </Button>}
            {canEdit && <Button onClick={handleFitsScan} disabled={fitsScanning} title="Scan FITS library" aria-label="Scan FITS library" variant="outline" className="hidden h-9 px-2 md:inline-flex 2xl:px-3">
              {fitsScanning ? <Loader2 className="h-4 w-4 animate-spin 2xl:mr-2" /> : <ScanLine className="h-4 w-4 2xl:mr-2" />}
              <span className="inline 2xl:hidden">{fitsScanning ? 'Scanning…' : 'FITS Scan'}</span><span className="hidden 2xl:inline">{fitsScanning ? 'Scanning FITS…' : 'Scan FITS'}</span>
            </Button>}
            <a
              href="https://github.com/kroryan/AstroviaBIn"
              target="_blank"
              rel="noopener noreferrer"
              title="View on GitHub"
              className="hidden md:inline-flex"
            >
              <Button variant="ghost" size="icon" className="h-9 w-9">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
              </Button>
            </a>
            {isAdmin && <Link href="/admin" className="hidden md:inline-flex">
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
            </Link>}
            <Button variant="ghost" size="icon" className="hidden md:inline-flex h-9 w-9" title={user ? `Sign out ${user.username} (${user.role})` : "Sign out"} onClick={signOut}>
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
                  <img src="/logo.svg" alt="AstroviaBin logo" className="h-8 w-8" />
                  <span className="cyber-wordmark text-lg">ASTROVIABIN</span>
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
                  {canEdit && <>
                  <button
                    onClick={() => { setMobileOpen(false); uploadInputRef.current?.click(); }}
                    className="px-4 py-3 text-sm font-medium transition-colors text-muted-foreground hover:bg-accent/50 hover:text-foreground flex items-center gap-2 text-left"
                  >
                    {uploads.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    {uploads.busy ? 'Uploading…' : 'Upload photos & FITS'}
                  </button>
                  <button
                    onClick={() => { setMobileOpen(false); handleFitsScan(); }}
                    disabled={fitsScanning}
                    className="px-4 py-3 text-sm font-medium transition-colors text-muted-foreground hover:bg-accent/50 hover:text-foreground flex items-center gap-2 text-left"
                  >
                    {fitsScanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}
                    {fitsScanning ? 'Scanning FITS...' : 'Scan FITS'}
                  </button>
                  </>}
                  {isAdmin && <Link
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
                  </Link>}
                  <button
                    onClick={signOut}
                    className="px-4 py-3 text-sm font-medium transition-colors text-muted-foreground hover:bg-accent/50 hover:text-foreground flex items-center gap-2 text-left"
                  >
                    <LogOut className="h-4 w-4" /> Sign out{user ? ` (${user.username})` : ''}
                  </button>
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
      {/* Portaled: the header's backdrop filter would otherwise make these fixed layers header-relative. */}
      {createPortal(<>
        <UploadQueuePanel items={uploads.items} busy={uploads.busy} onClose={uploads.clear} />
        {dragging && (
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="rounded-xl border-2 border-dashed border-primary px-8 py-6 text-center">
              <Upload className="mx-auto mb-2 h-8 w-8 text-primary" />
              <p className="font-display uppercase tracking-wider text-foreground">Drop photos and FITS to upload</p>
            </div>
          </div>
        )}
      </>, document.body)}
    </header>
  );
}
