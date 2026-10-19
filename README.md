<p align="center">
  <img src="assets/brand/astroviabin-logo.svg" width="220" alt="AstroviaBin logo">
</p>
<h1 align="center">ASTROVIABIN</h1>
<p align="center"><b>Self-hosted, cyberpunk-styled vault for astrophotography images and FITS.</b></p>

<p align="center">
  <a href="./docker"><img src="https://img.shields.io/badge/Docker-Ready-00f0ff?logo=docker&logoColor=white&labelColor=07040f"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-ff2bd6?labelColor=07040f" /></a>
  <a href="https://github.com/kroryan/AstroviaBIn/actions/workflows/docker-build-test.yml"><img src="https://github.com/kroryan/AstroviaBIn/actions/workflows/docker-build-test.yml/badge.svg" alt="Build Status" /></a>
</p>

**AstroviaBin** is a self-hosted photo and FITS library for astrophotographers. It stores uploads in its own database and local media directories, solves image fields with local Astrometry.net software (full WCS with SIP distortion and exact catalogue annotations), and provides saved FITS difference analyses with HOTPANTS and Photutils — all behind a login with per-user roles.

AstroviaBin is a fork of [Sidereal](https://github.com/sidereal-io/sidereal) (MIT). It does **not** require Immich or an Astrometry.net account; existing Immich assets can be migrated, but new uploads go directly to AstroviaBin. Original photos and FITS are never submitted to an external plate-solving service.

<div align="center">
  <img width="90%" src="assets/images/screenshots/01_gallery.png" alt="AstroviaBin gallery" />
  <br/>
  <a href="assets/images/screenshots">View all screenshots</a>
</div>

> **Upgrading from Sidereal?** Existing installs keep working: `SIDEREAL_*` environment variables are still accepted as aliases for `ASTROVIABIN_*`, and an existing `/app/config/sidereal.db` is used when no `astroviabin.db` exists. Users have to sign in again once because the session cookie was renamed.

## Features

### **Self-Hosted Image Management**
- **Private local library**: Upload and manage photos and FITS directly in AstroviaBin
- **Interactive Sky Map**: Explore your collection on a high-fidelity celestial atlas powered by Aladin Lite v3
- **Astrophotography Filtering**: Filter by telescopes, cameras, targets, constellations, and acquisition details
- **Deep Zoom Viewer**: High-resolution exploration of your deep-sky images with OpenSeaDragon
- **Metadata Preservation**: Automatic EXIF handling for astrophotography workflows
  > **Note**: XMP sidecar generation is experimental. Keep backups of originals and metadata.
- **External-disk friendly storage**: Mount library, FITS originals, derivatives, cache, and analysis directories independently
- **Location Editing**: Save and reuse observing sites with a map picker
- **Gallery catalogs**: Group photos and FITS into named catalogs (e.g. "Messier marathon", "M42 raw frames"), filter the gallery by catalog, and add the currently shown images in one click

### **DSO Catalog & Target Tracking**
- **Built-in OpenNGC Catalog**: Browse, search, and filter thousands of deep-sky objects by type, constellation, magnitude, and angular size
- **DSS Thumbnails**: Cached Digitized Sky Survey preview images for catalog objects
- **Target Wishlists**: Annotate catalog objects with personal notes and tags on the Targets page
- **Solar System target**: Every Sun, Moon and planet image (by tag) is grouped under a single "Solar System" target
- **Target Backfill**: Automatically match plate-solved images to catalog objects via the admin panel

### **Acquisition Logging**
- **Per-Filter Tracking**: Record exposure details per filter including frame count, exposure time, gain, offset, binning, and sensor temperature
- **Integration Summary**: Automatic calculation of total frames, total integration time, and filter breakdown per image

### **Plate Solving**
- **Local Astrometry.net solver**: Automatic coordinate solving without uploading photos or FITS
- **Background Processing**: Non-blocking worker processes with job queuing
- **Real-time Updates**: Live progress tracking via WebSocket connections
- **Batch Processing**: Handle multiple images simultaneously
- **Results Storage**: Persistent RA/Dec coordinates, field information, and the full WCS (TAN + SIP distortion)
- **Exact annotations**: Every OpenNGC object in the field is projected through the stored WCS at native resolution, so overlays line up with the real objects at any zoom
- **Hard fields**: A noise-robust star extractor, automatic hints (previous solution, FITS pointing, M/NGC/IC names in the title) and an optional manual RA/Dec hint rescue sparse or noisy frames; add narrow-field index files with `download-astrometry-indexes`
- **FITS difference analysis**: HOTPANTS subtraction followed by Photutils point-source checks, saved evidence, and optional second-exposure verification

### **Astrophotography Equipment Tracking**
- **Telescope Catalog**: Manage your telescopes, mounts, and accessories with specifications
- **Camera Database**: Track sensors, filters, and imaging configurations specific to astrophotography
- **Equipment Groups**: Bundle equipment into reusable presets and apply them to images in one click
- **Session Logging**: Automatic equipment association from EXIF metadata and manual tagging

### **Admin Interface**
- **Configuration Management**: Library, catalog, worker, and local solver settings
- **Worker Supervisor**: Background plate-solving workers automatically restart on failure with exponential backoff when Auto mode is enabled
- **Database Backup**: One-click SQLite database download from the admin panel (PostgreSQL users should use `pg_dump`)
- **Catalog Management**: Load, reload, and check for OpenNGC catalog updates; backfill target names for existing images

### **Real-Time Notifications**
- **Live Updates**: WebSocket-powered notifications for plate-solving results and other events
- **Notification Badge**: Unacknowledged notification count displayed in the navigation

### **Security & Deployment**
- **Login required**: Every page, API route, and WebSocket needs a signed session cookie (brute-force throttled)
- **Users & roles**: A built-in admin from environment variables, plus accounts created in **Admin → Users & roles** as `admin` (everything), `editor` (upload, edit, solve, catalogs) or `viewer` (read only); role changes apply immediately and password changes sign the account out
- **Automatic maintenance**: Daily consistent SQLite backups (14 kept) and bounded preview/tile caches
- **Docker Ready**: Multi-stage containerization with health checks
- **UnRAID Support**: Ready-to-use container templates
- **Database Options**: Built-in SQLite (default), optional PostgreSQL support

## Quick Start

> **Prerequisites**: Docker Compose and sufficient disk space for your own media. The source-build image includes the local solver, index files, HOTPANTS, and Photutils. No Immich server or remote Astrometry.net API key is needed.

### Option 1: Build this fork with Docker Compose (recommended)

This branch is not the upstream GHCR image. Build it from source so the local-only astrometry and FITS analysis dependencies are included:

```bash
git clone --branch v0.x https://github.com/kroryan/AstroviaBIn.git
cd astroviabin
cat > .env <<'ENV'
ASTROVIABIN_ADMIN_USER=choose-a-user
ASTROVIABIN_ADMIN_PASSWORD=choose-a-strong-password
# Optional: put the library on another disk (defaults to ./data/...)
# ASTROVIABIN_HOST_DATA=/srv/astroviabin/AppData
# ASTROVIABIN_HOST_LIBRARY=/srv/astroviabin/Media
ENV
docker compose up -d --build
```

Open `http://localhost:5000` and sign in. Without `ASTROVIABIN_ADMIN_USER`/`ASTROVIABIN_ADMIN_PASSWORD` the login is **admin / admin** — change it before exposing the port. The default Compose file stores everything under `./data`; set `ASTROVIABIN_HOST_DATA`, `ASTROVIABIN_HOST_LIBRARY`, and `FITS_HOST_*` to use another disk. The SQLite database lives in `AppData`; original media lives under `Media` and `FITS`, not inside the container. Back up both the database and those directories together.

> **PostgreSQL option**: If you prefer PostgreSQL, download [`docker-compose.postgres.yml`](docker-compose.postgres.yml) and layer it on:
> ```bash
> echo "POSTGRES_PASSWORD=your_secure_password" > .env
> docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
> ```

### Option 2: Standalone Docker container

Build the same source locally and bind-mount persistent directories:

```bash
docker build -t astroviabin:local .
docker run -d \
  --name astroviabin \
  -p 5000:5000 \
  -e NODE_ENV=production \
  -e FITS_ANALYSIS_DIR=/app/fits-analysis \
  -v /srv/astroviabin/AppData:/app/config \
  -v /srv/astroviabin/Media:/app/library \
  -v /srv/astroviabin/FITS/library:/app/fits:ro \
  -v /srv/astroviabin/FITS/uploads:/app/fits-upload \
  -v /srv/astroviabin/FITS/derivatives:/app/fits-derived \
  -v /srv/astroviabin/FITS/analysis:/app/fits-analysis \
  astroviabin:local
```

> To use PostgreSQL instead, add `-e DATABASE_URL="postgresql://user:password@host:5432/astroviabin"` to the command above.

### Option 3: UnRAID

The historical UnRAID template targets an upstream container and is not
configured for this fork's local science stack. Build the repository
locally and map AppData, Media, and each FITS directory to persistent
UnRAID shares as described in the [Docker guide](docker/README.md).

### Option 4: Development Setup

```bash
# Clone and install dependencies
git clone --branch v0.x https://github.com/kroryan/AstroviaBIn.git
cd astroviabin
npm install

# Option A: Build and run with Docker Compose (builds from source)
# Configure host storage paths before starting
docker compose up -d

# Option B: Local development server
cp .env.example .env.local
# Node development alone does not install the local Python/CFITSIO analysis stack.
# Use the Docker image for end-to-end FITS analyses.
npm run dev

# Option C: Worker-only deployment (standalone)
cp .env.worker.example .env.worker
# Edit .env.worker with database settings if running a separate worker
npm run dev:worker:standalone

# Access at http://localhost:5000 (Docker) or http://localhost:5173 (local)
```

## Requirements

### Core Requirements
- **Docker**: 20.10+ (for containerized deployment)
- **Database**: Built-in SQLite (default, no setup required). PostgreSQL 15+ optionally supported.
  - Automatic schema management with Drizzle ORM
  - Migration script included for moving data between SQLite and PostgreSQL (see [Docker docs](docker/README.md#migrating-between-sqlite-and-postgresql))

### Development Requirements
- **Node.js**: 20+ (for building from source)

### Optional Integrations
- **Historical survey reference**: SkyView access is optional. This sends field coordinates and requested survey parameters, never your FITS pixels. Choose another local FITS to avoid even that network request.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | _(empty)_ | Optional PostgreSQL connection string. Leave empty to use built-in SQLite. |
| `PORT` | `5000` | HTTP server port |
| `NODE_ENV` | `development` | Application environment |
| `ENABLE_PLATE_SOLVING` | `true` | Enable background worker |
| `PLATE_SOLVE_MAX_CONCURRENT` | `3` | Max simultaneous jobs |
| `XMP_SIDECAR_PATH` | `/app/sidecars` | Directory for XMP sidecar files |
| `FITS_LIBRARY_DIR` | `data/fits` | Local directory scanned for source `.fit`, `.fits`, and `.fts` files |
| `FITS_DERIVATIVES_DIR` | `data/fits-derived` | Local directory where processed FITS derivatives are written |
| `FITS_UPLOAD_DIR` | `data/fits-upload` | Local directory used by AstroviaBin's direct FITS upload button |
| `FITS_CACHE_DIR` | `data/fits-cache` | PNG preview cache for FITS files |
| `FITS_ANALYSIS_DIR` | `data/fits-analysis` | Private HOTPANTS runs, evidence, and follow-up checks; put this on spacious persistent storage |
| `ASTROVIABIN_MAX_UPLOAD_BYTES` | `21474836480` | Maximum direct upload size (20 GiB) |
| `FITS_MAX_PROCESS_BYTES` | `1073741824` | Maximum uncompressed primary FITS image size processed in memory |
| `FITS_FULL_PREVIEW_MAX` | `4096` | Longest side of the non-tiled FITS fallback preview (the zoom viewer uses native-resolution tiles) |
| `ASTROVIABIN_ADMIN_USER` / `ASTROVIABIN_ADMIN_PASSWORD` | `admin` / `admin` | Built-in administrator (always available, cannot be removed from the UI). **Change them.** More users are managed in Admin settings. |
| `ASTROVIABIN_SESSION_SECRET` | _(generated)_ | Cookie signing key; generated once and stored as `.session-secret` next to the database when unset |
| `ASTROVIABIN_AUTH_DISABLED` | `false` | Turn the login off only when another authenticating proxy sits in front |
| `ASTROMETRY_EXTRA_INDEX_DIRS` | `/app/config/astrometry-index` | Colon-separated extra index directories (narrow fields) |
| `ASTROMETRY_TIMEOUT_MS` | `900000` | Total time budget per local solve (hinted attempts, then blind) |
| `ASTROVIABIN_BACKUP_DIR` / `ASTROVIABIN_BACKUP_KEEP` | `<db dir>/backups` / `14` | Daily SQLite backups |
| `ASTROVIABIN_CACHE_MAX_BYTES` / `ASTROVIABIN_CACHE_MAX_AGE_DAYS` | `10 GiB` / `60` | Preview and tile cache bounds per cache directory |

### FITS in the main gallery

FITS is a local source in the existing gallery, not a separate gallery. Use **Upload** in the header to send a frame straight to AstroviaBin, or mount/configure a source folder and use **Scan FITS**. Direct uploads are stored in `FITS_UPLOAD_DIR`; mounted source files stay read-only. Plate solving uses bundled Astrometry.net binaries and index files locally; no FITS or preview is submitted to the public Astrometry.net site.

The FITS panel offers linear, asinh, logarithmic, and gamma stretches plus background neutralization. **Save processed FITS** writes a new 32-bit floating-point derivative to `FITS_DERIVATIVES_DIR`; it never overwrites the original. The current reader supports uncompressed primary-HDU mono and RGB FITS with `BITPIX` 8, 16, 32, 64, -32, or -64. Set `FITS_MAX_PROCESS_BYTES` according to available RAM for large frames.

Tags are editable from every image sheet: create your own, remove them, or use the `Deep Sky`, `Solar System`, Sun, Moon, and planet presets. `Solar System` and each planet tag exclude an image from manual, bulk, and automatic plate solving, because Astrometry.net solves stellar fields rather than planetary images.

Open a FITS and expand **HOTPANTS** above **FITS processing** to save a difference analysis. The pipeline uses the unmodified HOTPANTS binary and Photutils point-source detection. A historical DSS survey is useful for exploration but is often a different band, resolution, and epoch; its residuals are **not** supernova confirmations. A second, locally stored FITS from a different exposure in the same filter can provide repeat-detection evidence. You can delete any finished report and all of its generated files without deleting the original FITS. See [FITS difference analysis](docs/hotpants.md) for validation limits, privacy, advanced options, and licenses.

With Docker Compose, configure host folders in a Compose `.env` file or your shell before starting:

```bash
FITS_HOST_LIBRARY=/srv/astroviabin/FITS/library
FITS_HOST_DERIVATIVES=/srv/astroviabin/FITS/derivatives
FITS_HOST_UPLOADS=/srv/astroviabin/FITS/uploads
FITS_HOST_ANALYSIS=/srv/astroviabin/FITS/analysis
# Optional; default is 1 GiB
FITS_MAX_PROCESS_BYTES=1073741824
```

### Narrow fields of view

The image bundles the 2MASS index files for fields of roughly 30′ and wider. For longer focal lengths, download smaller scales once into the persistent AppData folder (about 5 GB for 4203–4207, fields down to ~8′):

```bash
docker exec -u "$(id -u)" astroviabin download-astrometry-indexes
```

New index files are picked up by the next solve; no restart is needed.

### Admin Configuration

After startup, access the admin interface at `/admin` to configure:

- **Library**: Local storage and catalog controls
- **Astrometry Settings**: Local solver and background processing
- **Worker Management**: Enable/disable background processing

> **Tip**: Configuration via admin interface takes precedence over environment variables and persists across container restarts.

## Database Migration

AstroviaBin includes a bidirectional migration script for moving data between SQLite and PostgreSQL:

```bash
# PostgreSQL → SQLite
node tools/scripts/migrate-db.js \
  --from postgresql://user:pass@host:5432/astroviabin \
  --to sqlite:path/to/astroviabin.db

# SQLite → PostgreSQL
node tools/scripts/migrate-db.js \
  --from sqlite:path/to/local.db \
  --to postgresql://user:pass@host:5432/astroviabin
```

Inside a Docker container:
```bash
node /app/dist/tools/scripts/migrate-db.js \
  --from postgresql://... \
  --to sqlite:/app/config/astroviabin.db
```
To avoid running the command manually inside the container, set the `AUTO_DB_MIGRATE_FROM` environment variable (and optional `AUTO_DB_MIGRATE_TO`) on the AstroviaBin service. The Docker startup script runs the migration before launching the app, deletes any existing SQLite target file (unless `AUTO_DB_MIGRATE_RESET_SQLITE=false`), and writes a marker to `/app/config/.auto-db-migrated` so it only happens once unless you delete that file or set `AUTO_DB_MIGRATE_ONCE=false`.

The script handles all type conversions (timestamps, booleans, JSON, arrays) and respects foreign key ordering automatically. SQLite targets run the bundled Drizzle migrations during the copy; PostgreSQL targets should be initialized once beforehand so the schema exists.

## Container images

Build this fork's `v0.x` branch locally with `docker compose up -d --build`.
The upstream `ghcr.io/kroryan/astroviabin` images are a different project
line and must not be used as a substitute for this fork's private FITS workflow.

## Architecture

```
Browser ──► AstroviaBin (React + Hono/Node)
                ├──► local SQLite or optional PostgreSQL
                ├──► mounted private photo/FITS/analysis directories
                ├──► local Astrometry.net solver + index files
                └──► local HOTPANTS + Photutils

Optional historical reference request ──► NASA SkyView (coordinates only)
```

## Project Structure

```
AstroviaBin/
├── apps/
│   ├── client/                 # React frontend application
│   │   ├── src/
│   │   │   ├── components/     # UI components (shadcn/ui)
│   │   │   ├── pages/          # Route components
│   │   │   ├── lib/            # Utilities and API clients
│   │   │   └── hooks/          # Custom React hooks
│   │   └── dist/               # Built frontend assets
│   └── server/                 # Node.js backend application
│       ├── src/
│       │   ├── routes/         # API route handlers
│       │   ├── services/       # Business logic services
│       │   ├── workers/        # Background job processors
│       │   └── db.ts           # Database configuration
│       └── dist/               # Compiled backend code
├── packages/
│   └── shared/                 # Shared types and schemas
│       ├── src/
│       │   ├── db/             # Database schemas (SQLite/PostgreSQL)
│       │   ├── schemas/        # Zod validation schemas
│       │   └── types/          # TypeScript type definitions
├── docker/                     # Containerization files
│   ├── startup.sh              # Container entry point
│   └── unraid-templates/       # UnRAID deployment templates
├── tools/                      # Development and migration tools
│   ├── scripts/                # Utility scripts
│   └── migrations/             # Database migration files
├── vendor/hotpants/            # Unmodified upstream HOTPANTS source and licenses
├── Dockerfile                  # Multi-stage local-science build
├── docker-compose.yml          # Persistent local storage mounts
├── docs/                       # Documentation
└── assets/                     # Static assets and examples
```

## Development

### Prerequisites

```bash
# Install Node.js 20+
node --version  # v20+
npm --version   # 10+

# Clone repository
git clone --branch v0.x https://github.com/kroryan/AstroviaBIn.git
cd astroviabin
```

### Setup

```bash
# Install dependencies
npm install

# Setup environment (choose one based on your needs)
cp .env.example .env.local           # Main application settings
cp .env.worker.example .env.worker   # Worker-only deployment
# Configure your development settings

# Database schema is managed automatically on startup via Drizzle ORM
```

### Development Commands

```bash
# Start development server (SQLite database by default)
npm run dev                      # Full stack: server + frontend + worker
npm run dev:server:watch         # Server only with file watching
npm run dev:worker               # Worker process only
npm run dev:worker:standalone    # Standalone worker (uses .env.worker)

# Build for production
npm run build          # Build frontend and backend
npm run build:docker   # Build with Docker assets

# Docker development (uses SQLite by default)
docker compose up -d               # Full stack via Docker
```

### Testing

AstroviaBin includes comprehensive end-to-end testing using Playwright:

```bash
# Run all tests
npm run test:e2e       # Run Playwright end-to-end tests

# Interactive testing
npm run test:e2e:ui    # Run tests with Playwright UI mode
npm run test:e2e:debug # Debug tests with Playwright inspector
npm run test:e2e:headed # Run tests in headed browser mode
```

**Test Structure:**
- `tests/e2e/` - End-to-end test specifications
- `tests/e2e/pages/` - Page Object Model classes for maintainable tests
- `playwright.config.ts` - Playwright configuration with multiple browsers

**Prerequisites for Testing:**
- AstroviaBin application running on `http://localhost:5173`
- Test database with sample data
- All dependencies installed via `npm install`

### Code Quality

```bash
# Type checking
npm run check          # TypeScript compilation check
```

## Deployment checks

Run `npm run check`, `npm run build`, and `docker compose build` after
changes. Check `http://localhost:5000/api/health` after deployment. This
fork's source build is the supported path for local FITS analysis.

## Upgrading from Sidereal or Skymmich

AstroviaBin was previously released as Sidereal (and before that as Skymmich). Sidereal installs upgrade in place: old `SIDEREAL_*` variables and an existing `sidereal.db` keep working. See the [Migration Guide](docs/MIGRATION.md) for details and the Skymmich steps.

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## Roadmap

### Core Features
- [x] **Direct photo and FITS uploads**: AstroviaBin owns its local library
- [x] **Interactive Sky Map**: Celestial atlas visualization for plate-solved image collections
- [ ] Advanced image statistics and analytics for astrophotography sessions
- [ ] Equipment usage reporting and session tracking
- [x] XMP sidecar generation for astrophotography metadata
- [ ] XMP sidecar viewer and editor for astrophotography metadata

### Integrations
- [ ] **NINA Plugin**: Sync session data (targets, equipment, acquisition details) directly from N.I.N.A. to AstroviaBin
- [x] **Local Plate Solving**: Bundled Astrometry.net binaries and index files; no remote submission
- [x] **FITS Difference Analysis**: HOTPANTS with local Photutils validation and second-exposure checks

### Advanced Features
- [ ] Advanced search and filtering with saved queries
- [ ] Bulk image processing workflows and batch operations
- [ ] View saved/tagged targets on the Sky Map
- [ ] Raw data and calibration frame management
- [ ] Mobile app companion for field use
- [ ] Community features (sharing, public galleries)

### Community & Help
- **Bug Reports**: [GitHub Issues](https://github.com/kroryan/AstroviaBIn/issues)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

Third-party components keep their own licenses. In particular, the Docker image builds and ships the unmodified [HOTPANTS](vendor/hotpants) programs, which are distributed under the GNU GPL v2 (`vendor/hotpants/COPYING`); their complete source is included in this repository and in the image at `/usr/share/doc/hotpants/source`. Astrometry.net and its index files are installed from Debian under their respective licenses.

## Acknowledgments

- **[Immich](https://immich.app/)** - Original inspiration for photo management; not a runtime dependency
- **[Astrometry.net](https://astrometry.net/)** - Locally installed plate-solving technology
- **[HOTPANTS](https://github.com/acbecker/hotpants)** - Image subtraction (see bundled notices)
- **[Photutils](https://github.com/astropy/photutils)** - Local point-source detection (BSD-3-Clause)
- **[shadcn/ui](https://ui.shadcn.com/)** - Beautiful and accessible React components
- **[Drizzle ORM](https://orm.drizzle.team/)** - Type-safe database toolkit

---

<div align="center">

**Built for the astrophotography community**

[Star this repo](https://github.com/kroryan/AstroviaBIn) | [Report bug](https://github.com/kroryan/AstroviaBIn/issues)

</div>
