<p align="center">
  <img src="apps/client/public/logo.png" width="300">
  <h1 style="font-size: 55px" align="center">SIDEREAL</h1>
</p>

<p align="center">
  <a href="./docker"><img src="https://img.shields.io/badge/Docker-Ready-blue?logo=docker"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" />
  <a href="./docker/unraid-templates"><img src="https://img.shields.io/badge/UnRAID-Compatible-orange)" /></a>
  <a href="https://discord.gg/ffZ8cuJ8Kh"><img src="https://img.shields.io/badge/Discord-Join%20Chat-5865F2?logo=discord&logoColor=white" alt="Join us on Discord" /></a>
</p>

<p align="center">
  <a href="https://github.com/kroryan/sidereal/actions/workflows/docker-build-test.yml"><img src="https://github.com/kroryan/sidereal/actions/workflows/docker-build-test.yml/badge.svg" alt="Build Status" /></a>
  <a href="https://github.com/kroryan/sidereal/actions/workflows/release.yml"><img src="https://github.com/kroryan/sidereal/actions/workflows/release.yml/badge.svg" alt="Release" /></a>
</p>

**Sidereal** is a self-hosted photo and FITS library for astrophotographers. It stores uploads in its own database and local media directories, solves image fields with local Astrometry.net software, and provides saved FITS difference analyses with HOTPANTS and Photutils.

Perfect for organizing, analyzing, and showcasing your astrophotography collection with full control over your data and infrastructure.

This fork does **not** require Immich or an Astrometry.net account. Existing Immich assets can be migrated, but new uploads go directly to Sidereal. The original photos and FITS are never submitted to an external plate-solving service.

<div align="center">
  <img width="80%" src="assets/images/demo.gif" />
  <br/>
  <a href="assets/images/screenshots">View all screenshots</a>
</div>

## Features

### **Self-Hosted Image Management**
- **Private local library**: Upload and manage photos and FITS directly in Sidereal
- **Interactive Sky Map**: Explore your collection on a high-fidelity celestial atlas powered by Aladin Lite v3
- **Astrophotography Filtering**: Filter by telescopes, cameras, targets, constellations, and acquisition details
- **Deep Zoom Viewer**: High-resolution exploration of your deep-sky images with OpenSeaDragon
- **Metadata Preservation**: Automatic EXIF handling for astrophotography workflows
  > **Note**: XMP sidecar generation is experimental. Keep backups of originals and metadata.
- **Expansion-friendly storage**: Mount library, FITS originals, derivatives, cache, and analysis directories independently
- **Location Editing**: Save and reuse observing sites with a map picker

### **DSO Catalog & Target Tracking**
- **Built-in OpenNGC Catalog**: Browse, search, and filter thousands of deep-sky objects by type, constellation, magnitude, and angular size
- **DSS Thumbnails**: Cached Digitized Sky Survey preview images for catalog objects
- **Target Wishlists**: Annotate catalog objects with personal notes and tags on the Targets page
- **Target Backfill**: Automatically match plate-solved images to catalog objects via the admin panel

### **Acquisition Logging**
- **Per-Filter Tracking**: Record exposure details per filter including frame count, exposure time, gain, offset, binning, and sensor temperature
- **Integration Summary**: Automatic calculation of total frames, total integration time, and filter breakdown per image

### **Plate Solving**
- **Local Astrometry.net solver**: Automatic coordinate solving without uploading photos or FITS
- **Background Processing**: Non-blocking worker processes with job queuing
- **Real-time Updates**: Live progress tracking via WebSocket connections
- **Batch Processing**: Handle multiple images simultaneously
- **Results Storage**: Persistent RA/Dec coordinates and field information
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
- **Docker Ready**: Multi-stage containerization with health checks
- **UnRAID Support**: Ready-to-use container templates
- **Database Options**: Built-in SQLite (default), optional PostgreSQL support

## Quick Start

> **Prerequisites**: Docker Compose and sufficient disk space for your own media. The source-build image includes the local solver, index files, HOTPANTS, and Photutils. No Immich server or remote Astrometry.net API key is needed.

### Option 1: Build this fork with Docker Compose (recommended)

This branch is not the upstream GHCR image. Build it from source so the local-only astrometry and FITS analysis dependencies are included:

```bash
git clone --branch v0.x https://github.com/kroryan/sidereal.git
cd sidereal
mkdir -p /mnt/Expansion/Sidereal/AppData /mnt/Expansion/Sidereal/Media
mkdir -p /mnt/Expansion/Sidereal/FITS/{library,derivatives,uploads,analysis}
docker compose up -d --build
```

Open `http://localhost:5000`. The default Compose file uses `/mnt/Expansion/Sidereal`; set `SIDEREAL_HOST_DATA`, `SIDEREAL_HOST_LIBRARY`, and `FITS_HOST_*` before starting if your disk is mounted elsewhere. The SQLite database lives in `AppData`; original media lives under `Media` and `FITS`, not inside the container. Back up both the database and those directories together.

> **PostgreSQL option**: If you prefer PostgreSQL, download [`docker-compose.postgres.yml`](docker-compose.postgres.yml) and layer it on:
> ```bash
> echo "POSTGRES_PASSWORD=your_secure_password" > .env
> docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d
> ```

### Option 2: Standalone Docker container

Build the same source locally and bind-mount persistent directories:

```bash
docker build -t sidereal:local .
docker run -d \
  --name sidereal \
  -p 5000:5000 \
  -e NODE_ENV=production \
  -e FITS_ANALYSIS_DIR=/app/fits-analysis \
  -v /mnt/Expansion/Sidereal/AppData:/app/config \
  -v /mnt/Expansion/Sidereal/Media:/app/library \
  -v /mnt/Expansion/Sidereal/FITS/library:/app/fits:ro \
  -v /mnt/Expansion/Sidereal/FITS/uploads:/app/fits-upload \
  -v /mnt/Expansion/Sidereal/FITS/derivatives:/app/fits-derived \
  -v /mnt/Expansion/Sidereal/FITS/analysis:/app/fits-analysis \
  sidereal:local
```

> To use PostgreSQL instead, add `-e DATABASE_URL="postgresql://user:password@host:5432/sidereal"` to the command above.

### Option 3: UnRAID

The historical UnRAID template targets an upstream container and is not
configured for this fork's local science stack. Build the repository
locally and map AppData, Media, and each FITS directory to persistent
UnRAID shares as described in the [Docker guide](docker/README.md).

### Option 4: Development Setup

```bash
# Clone and install dependencies
git clone --branch v0.x https://github.com/kroryan/sidereal.git
cd sidereal
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
| `FITS_UPLOAD_DIR` | `data/fits-upload` | Local directory used by Sidereal's direct FITS upload button |
| `FITS_CACHE_DIR` | `data/fits-cache` | PNG preview cache for FITS files |
| `FITS_ANALYSIS_DIR` | `data/fits-analysis` | Private HOTPANTS runs, evidence, and follow-up checks; put this on spacious persistent storage |
| `SIDEREAL_MAX_UPLOAD_BYTES` | `21474836480` | Maximum direct upload size (20 GiB) |
| `FITS_MAX_PROCESS_BYTES` | `1073741824` | Maximum uncompressed primary FITS image size processed in memory |

### FITS in the main gallery

FITS is a local source in the existing gallery, not a separate gallery. Use **Upload** in the header to send a frame straight to Sidereal, or mount/configure a source folder and use **Scan FITS**. Direct uploads are stored in `FITS_UPLOAD_DIR`; mounted source files stay read-only. Plate solving uses bundled Astrometry.net binaries and index files locally; no FITS or preview is submitted to the public Astrometry.net site.

The FITS panel offers linear, asinh, logarithmic, and gamma stretches plus background neutralization. **Save processed FITS** writes a new 32-bit floating-point derivative to `FITS_DERIVATIVES_DIR`; it never overwrites the original. The current reader supports uncompressed primary-HDU mono and RGB FITS with `BITPIX` 8, 16, 32, 64, -32, or -64. Set `FITS_MAX_PROCESS_BYTES` according to available RAM for large frames.

Tags are editable from every image sheet: create your own, remove them, or use the `Deep Sky`, `Solar System`, Sun, Moon, and planet presets. `Solar System` and each planet tag exclude an image from manual, bulk, and automatic plate solving, because Astrometry.net solves stellar fields rather than planetary images.

Open a FITS and expand **HOTPANTS** above **FITS processing** to save a difference analysis. The pipeline uses the unmodified HOTPANTS binary and Photutils point-source detection. A historical DSS survey is useful for exploration but is often a different band, resolution, and epoch; its residuals are **not** supernova confirmations. A second, locally stored FITS from a different exposure in the same filter can provide repeat-detection evidence. You can delete any finished report and all of its generated files without deleting the original FITS. See [FITS difference analysis](docs/hotpants.md) for validation limits, privacy, advanced options, and licenses.

With Docker Compose, configure host folders in a Compose `.env` file or your shell before starting:

```bash
FITS_HOST_LIBRARY=/mnt/Expansion/Sidereal/FITS/library
FITS_HOST_DERIVATIVES=/mnt/Expansion/Sidereal/FITS/derivatives
FITS_HOST_UPLOADS=/mnt/Expansion/Sidereal/FITS/uploads
FITS_HOST_ANALYSIS=/mnt/Expansion/Sidereal/FITS/analysis
# Optional; default is 1 GiB
FITS_MAX_PROCESS_BYTES=1073741824
```

### Admin Configuration

After startup, access the admin interface at `/admin` to configure:

- **Library**: Local storage and catalog controls
- **Astrometry Settings**: Local solver and background processing
- **Worker Management**: Enable/disable background processing

> **Tip**: Configuration via admin interface takes precedence over environment variables and persists across container restarts.

## Database Migration

Sidereal includes a bidirectional migration script for moving data between SQLite and PostgreSQL:

```bash
# PostgreSQL → SQLite
node tools/scripts/migrate-db.js \
  --from postgresql://user:pass@host:5432/sidereal \
  --to sqlite:path/to/sidereal.db

# SQLite → PostgreSQL
node tools/scripts/migrate-db.js \
  --from sqlite:path/to/local.db \
  --to postgresql://user:pass@host:5432/sidereal
```

Inside a Docker container:
```bash
node /app/dist/tools/scripts/migrate-db.js \
  --from postgresql://... \
  --to sqlite:/app/config/sidereal.db
```
To avoid running the command manually inside the container, set the `AUTO_DB_MIGRATE_FROM` environment variable (and optional `AUTO_DB_MIGRATE_TO`) on the Sidereal service. The Docker startup script runs the migration before launching the app, deletes any existing SQLite target file (unless `AUTO_DB_MIGRATE_RESET_SQLITE=false`), and writes a marker to `/app/config/.auto-db-migrated` so it only happens once unless you delete that file or set `AUTO_DB_MIGRATE_ONCE=false`.

The script handles all type conversions (timestamps, booleans, JSON, arrays) and respects foreign key ordering automatically. SQLite targets run the bundled Drizzle migrations during the copy; PostgreSQL targets should be initialized once beforehand so the schema exists.

## Container images

Build this fork's `v0.x` branch locally with `docker compose up -d --build`.
The upstream `ghcr.io/sidereal-io/sidereal` images are a different project
line and must not be used as a substitute for this fork's private FITS workflow.

## Architecture

```
Browser ──► Sidereal (React + Hono/Node)
                ├──► local SQLite or optional PostgreSQL
                ├──► mounted private photo/FITS/analysis directories
                ├──► local Astrometry.net solver + index files
                └──► local HOTPANTS + Photutils

Optional historical reference request ──► NASA SkyView (coordinates only)
```

## Project Structure

```
Sidereal/
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
git clone --branch v0.x https://github.com/kroryan/sidereal.git
cd sidereal
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

Sidereal includes comprehensive end-to-end testing using Playwright:

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
- Sidereal application running on `http://localhost:5173`
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

## Upgrading from Skymmich

If you were running the project under its former name (Skymmich), see the [Migration Guide](docs/MIGRATION.md) for step-by-step instructions on renaming Docker volumes, database files, and environment variables.

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

## Roadmap

### Core Features
- [x] **Direct photo and FITS uploads**: Sidereal owns its local library
- [x] **Interactive Sky Map**: Celestial atlas visualization for plate-solved image collections
- [ ] Advanced image statistics and analytics for astrophotography sessions
- [ ] Equipment usage reporting and session tracking
- [x] XMP sidecar generation for astrophotography metadata
- [ ] XMP sidecar viewer and editor for astrophotography metadata

### Integrations
- [ ] **NINA Plugin**: Sync session data (targets, equipment, acquisition details) directly from N.I.N.A. to Sidereal
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
- **Bug Reports**: [GitHub Issues](https://github.com/kroryan/sidereal/issues)

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

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

[Star this repo](https://github.com/kroryan/sidereal) | [Report bug](https://github.com/kroryan/sidereal/issues)

</div>
