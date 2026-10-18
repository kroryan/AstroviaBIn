# Multi-stage build for Sidereal
# SECURITY: This image does not contain any secrets or API keys
# All sensitive configuration is provided via environment variables at runtime
FROM node:24-alpine AS builder

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
FROM node:24-trixie-slim AS hotpants-builder
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends make gcc libc6-dev libcfitsio-dev ca-certificates && rm -rf /var/lib/apt/lists/*
COPY vendor/hotpants/ /opt/hotpants/
RUN cd /opt/hotpants && make CFITSIOINCDIR=/usr/include LIBDIR=/usr/lib CC='gcc -fcommon' && \
    gcc -fcommon -O3 -std=c99 -D_GNU_SOURCE -I/usr/include extractkernOnes.c -o extractkern-ones -lm -lcfitsio

# Production stage
FROM node:24-trixie-slim AS runtime

# Upgrade npm to the newest 11.x; node:24-alpine bundles an npm whose own
# dependencies (tar, brace-expansion, ip-address) have known CVEs
RUN npm install -g npm@11 && npm cache clean --force

# Enable Debian contrib. The local solver is installed after native build tools have
# been purged so --auto-remove cannot delete Astrometry.net or its index files.
RUN sed -i 's/Components: main/Components: main contrib/' /etc/apt/sources.list.d/debian.sources

# Create app user for security (will be remapped via PUID/PGID if provided)
RUN groupadd --system --gid 1001 nodejs && \
    useradd --system --uid 1001 --gid nodejs --home-dir /home/sidereal --create-home --shell /usr/sbin/nologin sidereal

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
      python3-astropy python3-scipy python3-numpy python3-venv libcfitsio10t64 && \
    rm -rf /var/lib/apt/lists/*

# Photutils is an independent, BSD-3-Clause source-detection and photometry
# library. Keep Debian's Astropy/NumPy/SciPy visible to avoid duplicate stacks.
RUN /usr/bin/python3 -m venv --system-site-packages /opt/sidereal-python && \
    /opt/sidereal-python/bin/pip install --no-cache-dir --no-deps photutils==3.1.1

COPY --from=hotpants-builder /opt/hotpants/hotpants /usr/local/bin/hotpants
COPY --from=hotpants-builder /opt/hotpants/extractkern /usr/local/bin/extractkern
COPY --from=hotpants-builder /opt/hotpants/extractkern-ones /usr/local/bin/extractkern-ones
COPY --from=hotpants-builder /opt/hotpants/maskim /usr/local/bin/maskim
COPY --from=hotpants-builder /opt/hotpants/COPYING /usr/share/doc/hotpants/COPYING
COPY --from=hotpants-builder /opt/hotpants/LICENSE /usr/share/doc/hotpants/LICENSE
# Accompany container-distributed HOTPANTS binaries with corresponding source.
COPY vendor/hotpants/ /usr/share/doc/hotpants/source/
COPY LICENSE /usr/share/doc/sidereal/LICENSE

# Remove package-manager tooling after production dependencies are installed
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Copy built application from builder stage (includes tools, config, and public assets)
COPY --from=builder /build/dist ./dist
COPY tools/scripts/hotpants_pipeline.py ./tools/scripts/hotpants_pipeline.py
COPY tools/scripts/hotpants_aux.py ./tools/scripts/hotpants_aux.py

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
