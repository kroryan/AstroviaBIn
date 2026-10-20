#!/bin/bash
# Builds the vendored HOTPANTS programs for the .deb (runs inside an ubuntu:25.10 container).
# /src = vendor/hotpants (read-only), /out = output folder.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq --no-install-recommends make gcc libc6-dev libcfitsio-dev >/dev/null
cp -r /src /build && cd /build
make -s CFITSIOINCDIR=/usr/include LIBDIR=/usr/lib/x86_64-linux-gnu CC='gcc -fcommon'
gcc -fcommon -O3 -std=c99 -D_GNU_SOURCE -I/usr/include extractkernOnes.c -o extractkern-ones -lm -lcfitsio
strip hotpants extractkern extractkern-ones maskim
cp hotpants extractkern extractkern-ones maskim COPYING LICENSE /out/
chown -R "$(stat -c %u:%g /out)" /out
