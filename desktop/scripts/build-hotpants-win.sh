#!/bin/bash
# Cross-compiles HOTPANTS for Windows x64 with MinGW-w64, linking CFITSIO and zlib statically so the
# .exe files need no extra DLLs (runs inside an ubuntu:25.10 container).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq --no-install-recommends make gcc-mingw-w64-x86-64 binutils-mingw-w64-x86-64 libz-mingw-w64-dev curl ca-certificates >/dev/null
CC=x86_64-w64-mingw32-gcc
PREFIX=/opt/mingw
mkdir -p $PREFIX /build && cd /build
curl -fsSL -o cfitsio.tar.gz https://heasarc.gsfc.nasa.gov/FTP/software/fitsio/c/cfitsio-4.6.2.tar.gz
tar xzf cfitsio.tar.gz && cd cfitsio-4.6.2
./configure -q --host=x86_64-w64-mingw32 --prefix=$PREFIX --disable-curl --disable-shared --enable-static CC=$CC >/dev/null
# Only the library (the bundled utilities use POSIX shared memory, which MinGW lacks).
make -s -j"$(nproc)" libcfitsio.la >/dev/null
mkdir -p $PREFIX/lib $PREFIX/include
cp .libs/libcfitsio.a $PREFIX/lib/
cp fitsio.h longnam.h $PREFIX/include/
cp -r /src /build/hotpants && cd /build/hotpants
FLAGS="-fcommon -O3 -std=c99 -D_GNU_SOURCE -I$PREFIX/include"
LIBS="$PREFIX/lib/libcfitsio.a -lz -lm -lws2_32 -static"
for f in main vargs alard functions; do $CC $FLAGS -c $f.c; done
$CC main.o vargs.o alard.o functions.o -o hotpants.exe $LIBS
$CC $FLAGS extractkern.c -o extractkern.exe $LIBS
$CC $FLAGS extractkernOnes.c -o extractkern-ones.exe $LIBS
$CC $FLAGS maskim.c -o maskim.exe $LIBS
x86_64-w64-mingw32-strip *.exe
cp hotpants.exe extractkern.exe extractkern-ones.exe maskim.exe COPYING LICENSE /out/
cp /build/cfitsio-4.6.2/licenses/License.txt /out/CFITSIO-LICENSE.txt
chown -R "$(stat -c %u:%g /out)" /out
