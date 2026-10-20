#!/bin/bash
# AstroviaBin .deb post-install (runs as root).
set -e
INSTALL_DIR='/opt/AstroviaBin'

# Desktop app on PATH (the default electron-builder steps this script replaces).
ln -sf "$INSTALL_DIR/astroviabin-desktop" /usr/bin/astroviabin-desktop
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true 2>/dev/null; }; then
  chmod 4755 "$INSTALL_DIR/chrome-sandbox" || true
else
  chmod 0755 "$INSTALL_DIR/chrome-sandbox" || true
fi

# Headless server command and systemd user unit (for machines managed without a desktop session).
cat > /usr/bin/astroviabin-server <<'SCRIPT'
#!/bin/sh
exec /opt/AstroviaBin/resources/runtime/node /opt/AstroviaBin/resources/server/launch-server.cjs "$@"
SCRIPT
chmod 755 /usr/bin/astroviabin-server
install -D -m 644 "$INSTALL_DIR/resources/astroviabin.service" /usr/lib/systemd/user/astroviabin.service

# Python for FITS stacking and transient analysis. Reuse Debian's numerical stack and install
# the exact CCDProc/Photutils/AstroScrappy runtime plus any missing wheels without internet.
rm -rf "$INSTALL_DIR/python"
python3 -m venv --system-site-packages "$INSTALL_DIR/python"
if ! "$INSTALL_DIR/python/bin/pip" install --quiet --no-index --find-links "$INSTALL_DIR/resources/wheels" ccdproc==2.5.1 photutils==3.1.1 astroscrappy==1.3.0 2>/dev/null; then
  "$INSTALL_DIR/python/bin/pip" install --quiet ccdproc==2.5.1 photutils==3.1.1 astroscrappy==1.3.0 || echo "AstroviaBin: scientific Python packages could not be installed; FITS stacking and HOTPANTS analyses will be unavailable." >&2
fi

update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
gtk-update-icon-cache -q -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
exit 0
