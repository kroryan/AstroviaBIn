#!/bin/bash
# AstroviaBin .deb pre-removal (runs as root, before the program files are removed).
# On "remove"/"purge": stop every running AstroviaBin server and tray app, disable the systemd user
# service and the login autostart for every user. On "upgrade" nothing is stopped here: the new
# package's post-install restarts running services with the new version.
# Settings, databases, photos and FITS are never touched here (see after-remove.sh for purge).
set -u
INSTALL_DIR='/opt/AstroviaBin'

case "${1:-remove}" in
  upgrade|failed-upgrade) exit 0 ;;
esac

# Every account with a home directory (regular users and root).
users() { getent passwd | awk -F: '($3 >= 1000 && $3 < 60000) || $3 == 0 { print $1 ":" $3 ":" $6 }'; }

while IFS=: read -r name uid home; do
  [ -d "$home" ] || continue
  # Stop and disable the systemd user service when that user's service manager is running.
  if [ -d "/run/user/$uid" ]; then
    runuser -u "$name" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user disable --now astroviabin.service >/dev/null 2>&1 || true
  fi
  # Disabled even when the user is logged out (the enablement is just this link).
  rm -f "$home/.config/systemd/user/default.target.wants/astroviabin.service"
  # "Start AstroviaBin when I log in" entry written by the tray app.
  rm -f "$home/.config/autostart/astroviabin.desktop"
done < <(users)

# Anything still running from the package (tray app, its server, a manually started astroviabin-server)
# plus the programs those started (python, hotpants, solve-field). Matched by the executable path or the
# program path on the command line (/proc/<pid>/exe is not always readable), so no unrelated node or
# python process is touched.
from_package() {
  for proc in /proc/[0-9]*; do
    exe=$(readlink "$proc/exe" 2>/dev/null || true)
    first=$({ tr '\0' '\n' < "$proc/cmdline"; } 2>/dev/null | head -n 1 || true)
    case "$exe|$first" in "$INSTALL_DIR"/*|*"|$INSTALL_DIR"/*) echo "${proc#/proc/}" ;; esac
  done
}
pids() {
  local roots all children pid
  roots=$(from_package)
  all="$roots"
  # Descendants, by parent PID (field 4 of /proc/<pid>/stat, after the command name in parentheses).
  while [ -n "$roots" ]; do
    children=''
    for proc in /proc/[0-9]*; do
      pid=${proc#/proc/}
      parent=$({ sed 's/^.*) [A-Za-z] \([0-9]*\).*$/\1/' < "$proc/stat"; } 2>/dev/null) || continue
      for root in $roots; do [ "$parent" = "$root" ] && children="$children $pid"; done
    done
    roots=$(echo $children)
    all="$all $roots"
  done
  echo $all | tr ' ' '\n' | grep -v "^$$\$" | sort -u | tr '\n' ' '
}
running=$(pids)
if [ -n "$running" ]; then
  kill -TERM $running 2>/dev/null || true
  # The server finishes its database writes on SIGTERM; give it up to 15 seconds.
  for _ in $(seq 1 15); do
    [ -z "$(pids)" ] && break
    sleep 1
  done
  running=$(pids)
  [ -n "$running" ] && kill -KILL $running 2>/dev/null || true
fi
exit 0
