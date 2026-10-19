# Deploying this AstroviaBin fork

This fork stores photos and FITS locally and bundles the offline
Astrometry.net solver, HOTPANTS, and Photutils. Do not deploy the upstream
`ghcr.io/kroryan/astroviabin` image for this workflow: it is not the
same build. Immich and a remote Astrometry.net account are not required.

## Docker Compose installation

From the repository root:

```bash
git clone --branch v0.x https://github.com/kroryan/AstroviaBIn.git
cd astroviabin
mkdir -p /srv/astroviabin/AppData /srv/astroviabin/Media
mkdir -p /srv/astroviabin/FITS/{library,derivatives,uploads,analysis}
docker compose up -d --build
docker compose ps
```

Open `http://localhost:5000`. Both `docker-compose.yml` and
`docker-compose.prod.yml` build this fork's image locally. The default
paths use `/srv/astroviabin`; put the following in a Compose
`.env` file to use another disk:

```dotenv
ASTROVIABIN_PORT=5000
ASTROVIABIN_HOST_DATA=/srv/astroviabin/AppData
ASTROVIABIN_HOST_LIBRARY=/srv/astroviabin/Media
FITS_HOST_LIBRARY=/srv/astroviabin/FITS/library
FITS_HOST_DERIVATIVES=/srv/astroviabin/FITS/derivatives
FITS_HOST_UPLOADS=/srv/astroviabin/FITS/uploads
FITS_HOST_ANALYSIS=/srv/astroviabin/FITS/analysis
```

The mounted FITS library is read-only to the container. Direct uploads
go to `FITS_HOST_UPLOADS`, derivatives to
`FITS_HOST_DERIVATIVES`, and saved analyses, reports, evidence, and
follow-up checks to `FITS_HOST_ANALYSIS`. Set the latter three on
spacious persistent storage. SQLite lives in `ASTROVIABIN_HOST_DATA`.
Back up AppData, Media, and all FITS directories together.

The image build installs public Astrometry.net index files, builds the
unmodified HOTPANTS C source, and installs Photutils 3.1.1 in a Python
environment that uses Debian's Astropy/NumPy/SciPy. No science FITS,
photo, or preview is submitted to an external astrometry service.
Optional NASA SkyView lookup sends coordinates and field size only;
choose a local FITS reference to avoid that network request.

## FITS analysis and report management

Open a FITS, expand **HOTPANTS** above **FITS processing**, and run an
analysis. Raw subtraction peaks are filtered with Photutils point-source
shape checks and artifact vetoes. A DSS2 comparison is exploratory:
different filters, epochs, seeing, and calibration can still mimic new
objects. A second local FITS exposure in the same filter at another
observation time can provide repeat-detection evidence, never an
automatic supernova confirmation. Finished reports can be deleted from
the FITS panel; this removes the report and generated analysis files,
not the original FITS. See [the detailed analysis guide](../docs/hotpants.md).

## PostgreSQL and migration

SQLite requires no additional service. To use PostgreSQL, set
`POSTGRES_PASSWORD` and start with the repository's PostgreSQL
override:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d --build
```

If migrating an existing database, back it up before using
`tools/scripts/migrate-db.js`. See [the migration guide](../docs/MIGRATION.md)
and [the database migration section](../README.md#database-migration).
Do not point an old upstream image at this fork's database.

## Operations

```bash
docker compose logs -f astroviabin
docker compose ps
docker compose up -d --build
```

The health endpoint is `http://localhost:5000/api/health`. If an
analysis fails, check the report's error and its private `hotpants.log`
in the analysis directory. Verify free space and permissions on every
mounted path. For local-only FITS analysis, verify the Docker image
contains `/usr/local/bin/hotpants`,
`/opt/astroviabin-python/bin/python`, and the Astrometry.net index files.

The historical UnRAID template references an upstream image and does
not install this fork's scientific stack. Build this branch locally and
map the same persistent directories to shares before using it on
UnRAID.
