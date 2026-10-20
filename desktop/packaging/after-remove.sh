#!/bin/bash
# AstroviaBin .deb post-remove: program files only. Your settings, database and images are never removed.
rm -f /usr/bin/astroviabin-desktop /usr/bin/astroviabin-server /usr/lib/systemd/user/astroviabin.service
rm -rf /opt/AstroviaBin/python
exit 0
