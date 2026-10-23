#!/bin/bash
# AstroviaBin .deb post-removal (runs as root).
# remove: program files, commands and the service unit are gone; Electron's own caches are cleared.
# purge:  also every user's AstroviaBin settings (including the stored password) and the regenerable
#         caches (thumbnails, zoom tiles, FITS previews) in the configured cache folder.
# Databases, backups, photos, FITS, analyses and sidecars are NEVER removed.
set -u

case "${1:-remove}" in
  upgrade|failed-upgrade|abort-install|abort-upgrade|disappear) exit 0 ;;
esac

rm -f /usr/bin/astroviabin-desktop /usr/bin/astroviabin-server /usr/lib/systemd/user/astroviabin.service
rm -rf /opt/AstroviaBin

# Folders Electron (Chromium) creates in the settings folder; they only hold browser caches and state.
ELECTRON_STATE=('Cache' 'Code Cache' 'GPUCache' 'DawnGraphiteCache' 'DawnWebGPUCache' 'Crashpad' 'blob_storage'
  'Local Storage' 'Session Storage' 'Shared Dictionary' 'shared_proto_db' 'WebStorage' 'VideoDecodeStats' 'Network'
  'Partitions' 'IndexedDB' 'Service Worker' 'Cookies' 'Cookies-journal' 'Preferences' 'Local State' 'Trust Tokens'
  'Trust Tokens-journal' 'TransportSecurity' 'SingletonLock' 'SingletonCookie' 'SingletonSocket' 'Dictionaries')

getent passwd | awk -F: '($3 >= 1000 && $3 < 60000) || $3 == 0 { print $6 }' | while read -r home; do
  config="$home/.config/AstroviaBin"
  [ -d "$config" ] || continue
  for entry in "${ELECTRON_STATE[@]}"; do rm -rf "${config:?}/$entry"; done
  if [ "${1:-remove}" = purge ]; then
    settings="$config/astroviabin-desktop.json"
    if [ -f "$settings" ]; then
      # Regenerable caches only, inside the configured cache folder.
      cache=$(sed -n 's/^ *"cacheDir": *"\(.*\)",\{0,1\}$/\1/p' "$settings" | head -1)
      if [ -n "$cache" ] && [ -d "$cache" ]; then
        rm -rf "$cache/thumbnails" "$cache/deep-zoom" "$cache/fits"
        rmdir "$cache" 2>/dev/null || true
      fi
    fi
    rm -f "$settings" "$config/server.env" "$config/astroviabin-desktop.json.tmp"
  fi
  rmdir "$config" 2>/dev/null || true
done
if [ "${1:-remove}" = purge ]; then rm -f /var/log/astroviabin-install.log; fi
exit 0
