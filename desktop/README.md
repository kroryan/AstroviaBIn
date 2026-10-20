# AstroviaBin desktop installers

The desktop package contains the tray/setup application plus the AstroviaBin web server,
local catalogues, FITS analysis tools and local Astrometry.net integration. The server is
headless-capable; the browser is the main application UI.

## Linux `.deb`

From the repository root, run `cd desktop && npm ci && npm run dist:linux`. The package is
written to `desktop/out/`. It installs the program under `/opt/AstroviaBin`, the desktop
launcher and the optional user-systemd server command. Install or upgrade it while the
currently running AstroviaBin server is stopped.

The installer does not migrate, move, or remove your database, photos, FITS, sidecars,
analysis reports, or user settings. On first setup, select the existing database file and
existing storage folders exactly as they are; the setup checks whether a database already
exists and is a writable SQLite database before saving. It also validates permissions and
available space. Before every start of an existing database, the packaged server runs
`quick_check`, creates an online SQLite backup in the configured backup folder, validates
that backup, and only then runs idempotent schema migrations. A failed check or backup keeps
the server stopped. Do not choose a fresh default database if you intend to continue an
existing installation. Keep the previous service/database backup until the new version has
been opened and verified.

For a headless Server Panel/systemd-user installation, open the setup once under the same
Linux account that will run the service, configure the existing database and media paths,
then set `ASTROVIABIN_ADMIN_PASSWORD` in
`~/.config/AstroviaBin/server.env` (mode `0600`). Enable and start the user service with:

```sh
systemctl --user daemon-reload
systemctl --user enable --now astroviabin.service
```

The service runs as that user and reads the same desktop settings. It must not run alongside
another AstroviaBin process on the same port. The package's remove script only removes
program files and the service unit; it deliberately does not delete user settings, the
database, backups, photos, FITS, annotations, or caches.

## Windows `.exe` and `.msix`

On Linux, `cd desktop && npm ci && npm run dist:win` stages the Windows server (Node, embedded
Python with the CCDProc packages, HOTPANTS cross-compiled with MinGW), creates the NSIS installer
(`.exe`) and then runs `scripts/build-msix.mjs`, which builds the `.msix` from `out/win-unpacked`
with Microsoft's open-source MSIX Packaging SDK (`makemsix`, pinned and built in Docker from
`packaging/makemsix.Dockerfile`), signs it with `osslsigncode` and validates it (the signature
verifies, and the package unpacks with its manifest, executable, server and Node runtime).
`npm run dist:win:msix` rebuilds only the MSIX from an existing `out/win-unpacked`.

The MSIX is not Store-signed. Without `MSIX_PFX`/`MSIX_PFX_PASSWORD` (a real certificate whose
subject matches `MSIX_PUBLISHER`), the script creates a self-signed test certificate once
(`CN=AstroviaBin`, kept in the git-ignored `.cache/msix-cert/`) and writes its public part as
`out/AstroviaBin-test-certificate.cer`. Import that `.cer` once into
**Local Machine → Trusted People** (double-click → Install Certificate) before installing the
MSIX. The `.exe` installer needs no certificate (Windows SmartScreen may warn because it is
unsigned). Both Windows installers keep application data outside the install directory, and
uninstall does not remove the configured database or media.
