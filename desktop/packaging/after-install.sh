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

# Upgrades: services that are running restart on the new version (try-restart leaves stopped ones alone;
# every start makes a verified database backup first).
getent passwd | awk -F: '$3 >= 1000 && $3 < 60000 { print $1 ":" $3 }' | while IFS=: read -r name uid; do
  [ -d "/run/user/$uid" ] || continue
  runuser -u "$name" -- env XDG_RUNTIME_DIR="/run/user/$uid" sh -c 'systemctl --user daemon-reload; systemctl --user try-restart astroviabin.service' >/dev/null 2>&1 || true
done

update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
gtk-update-icon-cache -q -t /usr/share/icons/hicolor >/dev/null 2>&1 || true
exit 0
