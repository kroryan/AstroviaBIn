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

# Python for FITS stacking and transient analysis is bundled (resources/python, with every package
# preinstalled). /opt/AstroviaBin/python stays as a link to it for settings written by older versions.
rm -rf "$INSTALL_DIR/python"
ln -s "$INSTALL_DIR/resources/python" "$INSTALL_DIR/python"

# pPXF cannot be redistributed inside the .deb. Fetch the publisher's pinned wheel directly
# during installation; it is kept under this application's directory and removed with it.
# Three attempts; if all fail, the package stays unconfigured (never "installed" with spectroscopy broken)
# and "sudo dpkg --configure -a" retries once the network is back.
ppxf_ok=0
for attempt in 1 2 3; do
  if "$INSTALL_DIR/python/bin/python3" \
      "$INSTALL_DIR/resources/server/tools/scripts/install_ppxf.py" \
      "$INSTALL_DIR/resources/optional-ppxf"; then
    ppxf_ok=1; break
  fi
  echo "AstroviaBin: pPXF download attempt $attempt failed" >&2
  sleep $((attempt * 5))
done
if [ "$ppxf_ok" != 1 ]; then
  cat >&2 <<'MSG'
AstroviaBin: could not download pPXF/capfit from PyPI (needed for spectroscopy; their license forbids
bundling them, so the installer fetches the official, checksum-verified packages). Check the Internet
connection and run:   sudo dpkg --configure -a
Your database, photos and FITS files are untouched.
MSG
  exit 1
fi

# Upgrades: services that are running restart on the new version (try-restart leaves stopped ones alone;
# every start makes a verified database backup first).
getent passwd | awk -F: '$3 >= 1000 && $3 < 60000 { print $1 ":" $3 }' | while IFS=: read -r name uid; do
  [ -d "/run/user/$uid" ] || continue
  runuser -u "$name" -- env XDG_RUNTIME_DIR="/run/user/$uid" sh -c 'systemctl --user daemon-reload; systemctl --user try-restart astroviabin.service' >/dev/null 2>&1 || true
done

update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
gtk-update-icon-cache -q -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
exit 0
