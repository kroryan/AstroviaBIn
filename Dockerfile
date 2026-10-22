# Multi-stage build for AstroviaBin
# SECURITY: This image does not contain any secrets or API keys
# All sensitive configuration is provided via environment variables at runtime
FROM node:25-alpine AS builder

# Build tools for native modules (better-sqlite3) that lack a prebuilt binary
# hadolint ignore=DL3018
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /build

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY vite.config.ts ./
COPY tailwind.config.ts ./
COPY postcss.config.js ./
COPY drizzle.config.ts ./

# Install all dependencies (including dev dependencies for build)
# Handle npm bug with Rollup optional dependencies on ARM64/musl
RUN npm ci || (npm cache clean --force && npm install)

# Copy source code
COPY apps/ ./apps/
COPY packages/ ./packages/
COPY tools/ ./tools/

# Build frontend and copy assets
RUN npm run build:docker

# Build vendored upstream HOTPANTS programs, including its alternative
# extractkernOnes helper. The C source and numerical methods are unmodified.
FROM node:25-trixie-slim AS hotpants-builder
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends make gcc libc6-dev libcfitsio-dev ca-certificates && rm -rf /var/lib/apt/lists/*
COPY vendor/hotpants/ /opt/hotpants/
RUN cd /opt/hotpants && make CFITSIOINCDIR=/usr/include LIBDIR=/usr/lib CC='gcc -fcommon' && \
    gcc -fcommon -O3 -std=c99 -D_GNU_SOURCE -I/usr/include extractkernOnes.c -o extractkern-ones -lm -lcfitsio

# Production stage
FROM node:25-trixie-slim AS runtime

# Upgrade npm to the newest 11.x; node:24-alpine bundles an npm whose own
# dependencies (tar, brace-expansion, ip-address) have known CVEs
RUN npm install -g npm@11 && npm cache clean --force

# Enable Debian contrib. The local solver is installed after native build tools have
# been purged so --auto-remove cannot delete Astrometry.net or its index files.
RUN sed -i 's/Components: main/Components: main contrib/' /etc/apt/sources.list.d/debian.sources

# Create app user for security (will be remapped via PUID/PGID if provided)
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs --home-dir /home/astroviabin --create-home --shell /usr/sbin/nologin astroviabin

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies (including better-sqlite3 for built-in SQLite support)
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 make g++ && \
    npm ci --omit=dev && \
    apt-get purge -y --auto-remove python3 make g++ && \
    rm -rf /var/lib/apt/lists/* && \
    npm cache clean --force

# Install the offline plate solver and public index files last. User photos/FITS are
# never sent anywhere by this image or by the local solver.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      astrometry.net astrometry-data-2mass-08-19 ca-certificates curl gosu passwd \
      python3-astropy python3-scipy python3-numpy python3-matplotlib python3-venv libcfitsio10t64 && \
    rm -rf /var/lib/apt/lists/*

# Offline sky-annotation data (stars, deep-sky outlines, constellations), built once at image
# build time so annotating never contacts a third party. Sources are pinned to fixed revisions;
# see /usr/share/astroviabin/sky/SOURCES.txt and LICENSES/ for provenance and licences.
ARG HYG_REV=c7f7f883fe678cc7680169a50ccd7dcc49b060ce
ARG OPENNGC_REV=be3cd6c5498806a2fbb2f7e0452ef802dbb02be0
ARG D3_CELESTIAL_REV=7e720a3de062059d4c5400a379146a601d9010e0
COPY tools/scripts/build_sky_catalog.py /tmp/build_sky_catalog.py
RUN set -eu; src=/tmp/sky-src; out=/usr/share/astroviabin/sky; mkdir -p "$src" "$out/LICENSES"; cd "$src"; \
    fetch() { curl -fsSL --retry 5 -o "$1" "$2"; }; \
    fetch hyg.csv "https://raw.githubusercontent.com/astronexus/HYG-Database/${HYG_REV}/hyg/CURRENT/hygdata_v41.csv"; \
    fetch "$out/LICENSES/HYG-LICENSE.md" "https://raw.githubusercontent.com/astronexus/HYG-Database/${HYG_REV}/LICENSE"; \
    fetch hd.fits "https://data.astrometry.net/hd.fits"; \
    fetch NGC.csv "https://raw.githubusercontent.com/mattiaverga/OpenNGC/${OPENNGC_REV}/database_files/NGC.csv"; \
    fetch addendum.csv "https://raw.githubusercontent.com/mattiaverga/OpenNGC/${OPENNGC_REV}/database_files/addendum.csv"; \
    fetch constellations.lines.json "https://raw.githubusercontent.com/ofrohn/d3-celestial/${D3_CELESTIAL_REV}/data/constellations.lines.json"; \
    fetch constellations.json "https://raw.githubusercontent.com/ofrohn/d3-celestial/${D3_CELESTIAL_REV}/data/constellations.json"; \
    fetch "$out/LICENSES/d3-celestial-LICENSE.txt" "https://raw.githubusercontent.com/ofrohn/d3-celestial/${D3_CELESTIAL_REV}/LICENSE"; \
    for i in $(seq -w 0 19); do fetch "tyc2.dat.$i.gz" "https://cdsarc.cds.unistra.fr/ftp/I/259/tyc2.dat.$i.gz"; done; \
    fetch "$out/LICENSES/Tycho-2-ReadMe.txt" "https://cdsarc.cds.unistra.fr/ftp/I/259/ReadMe"; \
    /usr/bin/python3 /tmp/build_sky_catalog.py --src "$src" --out "$out"; \
    cd /; rm -rf "$src" /tmp/build_sky_catalog.py

# CCDProc owns CCD calibration, WCS reprojection, masks, uncertainty propagation and
# combination. Photutils and astroscrappy support source analysis and L.A.Cosmic.
# Keep Debian's Astropy/NumPy/SciPy visible to avoid a duplicate numerical stack.
COPY requirements-science.txt /tmp/requirements-science.txt
RUN /usr/bin/python3 -m venv --system-site-packages /opt/astroviabin-python && \
    /opt/astroviabin-python/bin/pip install --no-cache-dir -r /tmp/requirements-science.txt && \
    rm /tmp/requirements-science.txt

COPY --from=hotpants-builder /opt/hotpants/hotpants /usr/local/bin/hotpants
COPY --from=hotpants-builder /opt/hotpants/extractkern /usr/local/bin/extractkern
COPY --from=hotpants-builder /opt/hotpants/extractkern-ones /usr/local/bin/extractkern-ones
COPY --from=hotpants-builder /opt/hotpants/maskim /usr/local/bin/maskim
COPY --from=hotpants-builder /opt/hotpants/COPYING /usr/share/doc/hotpants/COPYING
COPY --from=hotpants-builder /opt/hotpants/LICENSE /usr/share/doc/hotpants/LICENSE
# Accompany container-distributed HOTPANTS binaries with corresponding source.
COPY vendor/hotpants/ /usr/share/doc/hotpants/source/
COPY LICENSE /usr/share/doc/astroviabin/LICENSE
# Third-party notices (docs/LICENSES.md), license texts missing from some wheels, the inventory of the
# Python packages in this image and the source of the LGPL SEP library (pulled in by astroalign).
COPY docs/LICENSES.md /usr/share/doc/astroviabin/THIRD-PARTY-NOTICES.md
COPY licenses/third-party/ /usr/share/doc/astroviabin/third-party/
COPY docs/licenses/javascript-packages.md docs/licenses/javascript-licenses.txt /usr/share/doc/astroviabin/
COPY tools/scripts/third_party_inventory.py /tmp/third_party_inventory.py
RUN /opt/astroviabin-python/bin/python /tmp/third_party_inventory.py /usr/share/doc/astroviabin/python-packages.md && \
    mkdir -p /usr/share/doc/astroviabin/sources && \
    /opt/astroviabin-python/bin/python -c "import importlib.metadata as m, urllib.request as u; v = m.version('sep'); u.urlretrieve(f'https://files.pythonhosted.org/packages/source/s/sep/sep-{v}.tar.gz', f'/usr/share/doc/astroviabin/sources/sep-{v}.tar.gz')" && \
    rm /tmp/third_party_inventory.py

# Remove package-manager tooling after production dependencies are installed
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Copy built application from builder stage (includes tools, config, and public assets)
COPY --from=builder /build/dist ./dist
COPY tools/scripts/hotpants_pipeline.py ./tools/scripts/hotpants_pipeline.py
COPY tools/scripts/hotpants_report.py ./tools/scripts/hotpants_report.py
COPY tools/scripts/fits_normalize.py ./tools/scripts/fits_normalize.py
COPY tools/scripts/hotpants_aux.py ./tools/scripts/hotpants_aux.py
COPY tools/scripts/star_extract.py ./tools/scripts/star_extract.py
COPY tools/scripts/ccdproc_stack.py ./tools/scripts/ccdproc_stack.py
COPY tools/scripts/spectroscopy.py ./tools/scripts/spectroscopy.py
COPY tools/scripts/wcs_transfer.py ./tools/scripts/wcs_transfer.py
COPY tools/scripts/credits.py ./tools/scripts/credits.py
COPY tools/scripts/install_ppxf.py ./tools/scripts/install_ppxf.py
COPY tools/data/spectral-library.fits ./tools/data/spectral-library.fits
COPY tools/scripts/download-astrometry-indexes.sh /usr/local/bin/download-astrometry-indexes

# Create directories for runtime
RUN mkdir -p /app/config /app/logs /app/sidecars /app/cache/thumbnails /app/cache/deep-zoom /app/library /app/fits-analysis

# Copy startup script
COPY docker/startup.sh ./
RUN chmod +x startup.sh

# Run as root initially to allow PUID/PGID remapping in startup.sh
# hadolint ignore=DL3002,DL3066
USER root

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD ["sh", "-c", "curl -f http://localhost:5000/api/health || exit 1"]

# Start application
CMD ["./startup.sh"]
