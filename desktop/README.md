# AstroviaBin desktop installers

The desktop package contains the tray/setup application plus the AstroviaBin web server,
local catalogues, FITS analysis tools and local Astrometry.net integration. AstroviaBin opens
in its own app window (or, if you prefer, your web browser: setting "Open AstroviaBin in").
The tray menu's "Share AstroviaBin with" switches between this computer only and every device
on the local network. The server is headless-capable for machines without a desktop.

## Linux `.deb`

From the repository root, run `cd desktop && npm ci && npm run dist:linux`. The package is
written to `desktop/out/`. It installs the program under `/opt/AstroviaBin`, the desktop
launcher and the optional user-systemd server command. It needs no Python, pip or internet
from the system: a self-contained Python 3.13 (python-build-standalone, pinned and
checksum-verified) with NumPy, SciPy, Astropy, Matplotlib, CCDProc, Photutils and
astroscrappy is bundled in `/opt/AstroviaBin/resources/python`, so stacking and HOTPANTS
behave identically on any distribution. Upgrading restarts any running `astroviabin.service`
on the new version (each start makes a verified database backup first).

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
another AstroviaBin process on the same port.

Uninstalling leaves nothing running: `sudo apt remove astroviabin` stops every AstroviaBin
server and tray app (only processes started from `/opt/AstroviaBin`), disables the user
service and the "start at login" entry for every user, and removes the program and Electron's
caches. `sudo apt purge astroviabin` also removes each user's AstroviaBin settings (including
the saved password) and the regenerable caches (thumbnails, zoom tiles, FITS previews).
Databases, backups, photos, FITS, analyses and sidecars are never deleted.

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
uninstall does not remove the configured database or media. Installing over an older
version and uninstalling close the tray app and its server first (only processes running from
the install folder); the uninstaller also removes the "start at login" entry and Electron's
caches, and asks whether to delete the settings (default: keep them). Windows removes an MSIX
package completely, including its startup task.
