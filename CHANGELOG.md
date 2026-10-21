# Changelog

All notable changes to Sidereal will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Stacking applied registration offsets in the wrong direction, doubling the misalignment; frames with a WCS now align through it. Stacks made before this fix should be redone.
- HOTPANTS analysis failed on FITS with a SIP WCS (`'crpix' of 'astropy.wcs.Sip' objects is not writable`) and rebinned images kept an unscaled CD matrix; the binned WCS is now built exactly (CD/CDELT, CRPIX and SIP coefficients).
- FITS written by AstroviaBin use the standard fixed format and HISTORY/COMMENT cards.
- The HOTPANTS pipeline's own plate solve uses the narrow-field indexes and the pixel-scale hint.

### Added
- HOTPANTS reference surveys: Pan-STARRS1 g/r/i/z/y, DESI Legacy Surveys DR10 g/r/i/z, SDSS u/g/r/i/z, DSS1/DSS2 and 2MASS J/H/K, with an "Auto" default that picks the deepest survey covering the field in the band matching the science FILTER (blank out-of-footprint cutouts are detected and skipped).
- Data-driven HOTPANTS defaults: seeing measured by Gaussian fits on both images sets the kernel half-width, stamp size and Gaussian basis; valid-data ranges come from the data (negative, background-subtracted references stay valid); saturated blocks are masked; gain and read noise come from GAIN/RDNOISE/NCOMBINE. Explicit user flags always win.
- HOTPANTS masks bright, saturated and bleeding stars in the reference (brightness, elongation, and a Legacy-Surveys-style catalogue mask from the offline Tycho-2/HYG data) so they no longer appear as false candidates; reports show the masked fraction.
- HOTPANTS reports list known asteroids and comets in the field (IMCCE SkyBoT with the observatory's topocentric position, sent as `-observer`) and flag candidates that coincide with one — verified on 1620 Geographos to 0.7".

### Changed
- Upload a whole folder: Upload → "Folder (with subfolders)…", or drop folders on the page. Every photo and FITS in the folder and its subfolders is uploaded; other files (sidecars, notes, hidden files) are skipped and counted in the summary.
- Stacking guide on the Stack page covering every kind of FITS — frame types (light, bias, dark, flat, dark flat, observatory-reduced), filters (L/Clear, RGB, Johnson UBVRI, SDSS/Pan-STARRS, narrowband Hα/Hβ/OIII/SII/NII, near-IR, planetary), mono vs one-shot colour vs colour composites, processing level, binning, exposure — with what to stack for each use (deep image, LRGB, SHO, photometry, transients, asteroids/comets, astrometry, planets, calibration masters) and what must never be stacked together. A live "Selection check" applies those rules to the chosen frames (mixed filters, composites with mono, different fields, earlier stacks, sizes, exposures, nights, moving targets); earlier stacks are listed apart in each field.
- FITS are organized by observation date (UTC) and filter: inside an album the FITS section lists each night, then each filter (L, R, G, B, Hα, OIII, SII, SDSS r′…, colour composites) with the frames in time order and their UTC time. Filter names from different observatories are normalized (Luminance/L, Red/R, Halpha/Hα, rp/r′…).
- The Stack page groups frames by field (frames whose plate solutions match share an album), then night, then filter, with "+ select" / "only these" for any group, the UTC time on each frame, and a warning (the Stack button is disabled) when a selection mixes filters.
- One Upload button for everything: pick (or drop anywhere on the page) any number of photos and FITS together; each file goes to the right library by its extension, one at a time, with per-file progress, a summary at the end and the reason for any file that fails.
- Inside an album, images are grouped into categories: the Solar System album has one section per body (Sun, Moon, each planet, comets, asteroids, other Solar System), every other album separates FITS from photos.
- Dates and times are shown in UTC by default (with a "UTC" suffix), including the capture-time editor, which now reads and writes UTC; each browser can switch to local time in Admin → Dates and times.
- New uploads (photos and FITS) are tagged Deep Sky by default so they can be plate-solved, unless the title, file name or FITS OBJECT names a planet, the Sun or the Moon (Spanish or English), which gets that tag instead and goes to the Solar System album. Adding a planet tag to an image removes its Deep Sky tag (comets and asteroids keep it).

### Added (gallery)
- Automatic gallery catalogs: plate-solved images of the same field (overlapping solutions) or the same identified target (mosaic panels, a moving asteroid) are filed together in a catalog named after the target (e.g. "M 42 (NGC 1976)"), and planets, Sun and Moon go to a "Solar System" catalog. Runs after every plate solve, when an image is tagged as Solar System, and from the new "Auto-classify" button. Only images in no catalog are filed: when part of a field is already in one of your catalogs the rest joins it, and images you take out by hand are not put back. A field with a single image stays loose until a second one arrives.
- Every plate-solved image now gets an album, even when it is the only image of its field; later images of that field join it. Albums are named after a descriptive image title (e.g. "Tau Canis Majoris") unless a title names the identified target ("M 42 (NGC 1976)"), since the identified target can be an incidental object in the field; generated position names are replaced once a better name exists, never a name you typed.
- Compact gallery: albums, unclassified images and album contents use the same small square tiles (about a third of the previous width), laid out so only whole tiles fit on each row; FITS/WCS status shows as small chips on the thumbnail and the catalog bar wraps instead of scrolling.
- The gallery shows catalogs as folders with only the unclassified images below ("Group by catalog", on by default); searching or filtering lists matching images flat. Stacks inherit the reference frame's tags and target and are queued for plate solving.

### Fixed (plate solving)
- Frames without coordinates in their header (e.g. Slooh) were solved blind over every field size from 5′ to 33° and could time out after 15 minutes. The pixel scale is now read from the header — INSTRUME text such as "2.94arcsec/pix @ Binning 1x1", or FOCALLEN and XPIXSZ, with binning handled correctly (XPIXSZ already includes it in the SBIG/MaxIm convention; it was counted twice) — and used for every attempt, including blind ones. A real Slooh frame that had failed after 15 minutes now solves in under a minute.
- Position hints come from more places: another frame of the same session that is already solved (same "<target>_<date>" file-name prefix), M/NGC/IC designations in names with underscores ("m45_2026…" was not recognized), HD/HIP numbers and proper star names from the offline catalogue ("hd19373", "algolbetapersei"), coordinates written in the file name ("095102p115201") and, online, CDS Sesame name resolution. A hint only tells Astrometry.net where to look first: every solution is still verified by its star matching, and when no hinted attempt verifies, the blind search runs as before.
- FITS previews that fail (server restarting or busy) are retried automatically before an error is shown, and the error says why.

### Fixed (uploads)
- FITS whose image is not in the primary HDU — an IMAGE extension or a tile-compressed (RICE/GZIP/HCOMPRESS, fpack) image, as in Slooh "_cal.fit" files — failed to upload ("NAXIS1 is required"). They are now rewritten on upload as a standard FITS (pixels unchanged, observation keywords from all headers merged) and the original file is kept beside it as "<name>.orig". Unreadable FITS return a clear 400 error instead of a server error.

### Changed (stacking)
- Stacking is now done with Astropy CCDProc (`tools/scripts/ccdproc_stack.py`, pinned in `requirements-science.txt`): optional bias/dark/flat calibration with overscan, trim, dark scaling by exposure and bad-pixel masks (`ccdmask`), cosmic-ray cleaning (astroscrappy L.A.Cosmic or median), registration of every frame onto the reference through its WCS (stored plate solutions are used when the header has none), exposure/median normalization and weighting, and mean/median/sigma-clip (MAD) combination with optional extrema and min/max clipping. Originals are opened read-only; each frame's offset, skipped duplicates and all settings are reported and written to the FITS HISTORY.
- Stacking unsigned 16-bit camera frames (BITPIX 16 with BZERO = 32768, e.g. the Geographos set) failed with "Cannot load a memory-mapped image"; frames are now read into memory with their integer scaling applied, and the float output carries no BZERO/BSCALE.

### Fixed (Plate-solving list, 0.12.5)
- An old failed attempt is no longer listed as a failure once a later job solved the same image (the history is kept in the database).

### Fixed (Plate solving of sparse frames, 0.12.4)
- Frames too sparse for Astrometry.net (e.g. 4 s through a B filter on a 17" telescope, mostly hot pixels and column defects) now get the WCS of a solved frame of the same pointing: the observatory takes the filters back to back without moving, so the frame is aligned to its solved sibling (same session, telescope and size) with astroalign and the WCS is fitted with Astropy to the matched stars. It is accepted only for the same pointing (at least 15 matched stars, residuals under 1 pixel, scale within 1 %, rotation under 1 degree); otherwise the usual attempts run. Checked on the two frames that failed: 73 and 71 stars matched, 0.27 and 0.30 px residuals, solved in 9 s. Failed jobs are re-queued once more for this strategy.
- astroalign (MIT) and SEP (LGPL 3.0+, unmodified) are bundled in the installers and credited in About.

### Fixed / Added (Start-up after a power cut, plate solving, 0.12.3)
- AstroviaBin no longer refuses to start after a power cut: when SQLite left a hot rollback journal (or WAL), the start-up safety check lets SQLite run its own crash recovery before its read-only check and backup, instead of failing with "attempt to write a readonly database" on every start.
- "Pause plate solving" / "Resume plate solving" button in the sidebar: the worker takes no job while paused and stops the solve in progress within seconds (only its solver processes); that job returns to the queue instead of failing. Spectroscopy, HOTPANTS and stacking are not affected.
- Sparse frames (short, binned, blue) that timed out: every hinted attempt is also tried with solve-field's own source extraction (e.g. a 20 s blue Slooh frame that needed over 3 minutes with the robust star list now solves in under 2 minutes). Failed Deep Sky jobs are re-queued once automatically for the improved strategy.
- Slooh Moon mission names that join the words ("waxinggibbousmoon", "fullmoon") are recognised as the Moon, so those photos are no longer queued for plate solving.

### Fixed (Uploads, 0.12.2)
- A page left open across an update kept running the old upload code, which sent every file (including those already stored) one by one. The page now notices a newer server before uploading (and when you come back to the tab) and reloads; `index.html` is no longer cached by browsers.
- The first duplicate check of a large folder had to read the whole FITS library (about 40 s for 500 FITS on a USB disk): the server now indexes it in the background after starting, so the check takes a fraction of a second. The upload panel shows how many files have been checked.

### Added / Changed (Uploads, albums and speed, 0.12.1)
- Uploading a folder (or any selection) first reviews every file against the server and skips, without uploading them, files with the name and size of a stored file, files whose content (SHA-256) is already stored under another name, and repeated copies inside the same selection. Existing files are never changed. The server checks again on upload, so a duplicate can never be stored twice. Only files whose size matches a stored file are hashed, in the browser (hash-wasm, works on plain-http LAN addresses).
- Uploads run three at a time, and FITS stored names stay unique even for parallel uploads of files that share a name.
- Spectroscopy FITS (which cannot be plate-solved) join albums by the target position in their FITS header (SDSS fibre PLUG_RA/DEC, OBJCTRA/OBJCTDEC, RA/DEC): the album of the solved field that contains them, else that of a spectrum within 15′, else an album of their own; an image solved later in that area joins that album. New "Classify spectra" button next to Auto-classify; spectra already uploaded are filed when the server starts.
- Faster with large libraries: the sidebar polls a small plate-solving summary (counts and the latest four jobs, about 0.5 kB instead of every solution, about 2 MB; every 30 s when nothing is queued), the job list no longer runs one database query per job, gallery tiles load lazily, and FITS tiles use a 512 px JPEG thumbnail that browsers keep and revalidate with an ETag (a 304 in milliseconds instead of a new render).

### Added (Stellar spectroscopy, 0.12.0)
- Spectroscopy panel below FITS processing: analyse every usable star of a slitless (Star Analyser) frame, a 2-D spectrum strip or a 1-D spectrum (SDSS spec-*.fits, tables, 1-D images). Frames are calibrated with CCDProc (optional bias/dark/flat, L.A.Cosmic), zero orders found with Photutils, first orders traced, background-subtracted and extracted with Specreduce, lines and equivalent widths measured with Specutils, and spectral types fitted with pPXF against the Pickles library.
- PDF report with every plot, each star marked on the field with its pixel and sky position, plus CSV and FITS exports.
- Optional "Check known spectroscopy" before the analysis (SIMBAD, Gaia DR3 and SDSS through Astroquery); only when used, the comparison is added to the same PDF.
- Spectroscopy FITS are recognised on upload: 1-D spectra are tagged Spectrum / 1-D spectrum (not Deep Sky) and get a plotted preview; slitless frames get Spectroscopy / Slitless spectrum.
- Honest limits: slitless wavelengths need the instrument dispersion (no self-calibration from assumed lines); strips without a spectral WCS stay in pixels; spectral types are template matches (about ±2 subclasses), never "High" confidence without a reference lamp; no radial velocities from the low-resolution library; quasars get no stellar type.
- pPXF and capfit (non-commercial license, not redistributable) are not bundled: the .deb, the Windows installer and the MSIX first start download the official, version-pinned and SHA-256-verified packages from PyPI into the application folder, with retry on failure; uninstalling AstroviaBin removes them. Specutils, Specreduce and Astroquery are bundled. Astropy/Astroquery caches live inside AstroviaBin's data folder.
- Credits for Specutils, Specreduce, Astroquery, pPXF/capfit, the Pickles atlas and SDSS in Admin → About.

### Fixed (FITS display, 0.11.4)
- Some FITS showed an orange (or olive, magenta) washed-out sky even with "Original": blank borders (0 after registration) set the black point far below the sky, and background neutralization stretched each channel to its own range, which recoloured the whole image. The black point now never goes below the sky minus 2.8σ (robust, from the MAD), the white point never closer than ten times the sky's distance (so mostly empty fields no longer turn bright grey), and neutralization places every channel's sky at the same level with one shared range, keeping the objects' real colours (PixInsight/Siril auto-stretch rules).
- Gallery tiles, thumbnails and HOTPANTS report images use the same neutral rendering; the panel's checkbox can still turn it off.
- Checked on every FITS in a real library (129 files: mono, RGB, narrowband composites, Slooh frames, stacks): no colour cast (largest channel difference 8/255) and no washed-out sky. Previously cached renders are not reused.

### Changed (FITS processing, 0.11.3)
- New default colour map "Original (no colour map)": the preview shows the image as it is (natural colour for RGB FITS, grey for mono), so you can always return to it after trying a palette. "Grey" is now a true greyscale for RGB FITS too (luminance), and every palette's reset button returns to Original.

### Added (FITS processing, 0.11.2)
- Every FITS processing option has its own reset button (enabled only when the option differs from its default), and "Reset all" — at the top and bottom of the panel, with the number of changed options — restores every option at once: stretch and its parameters, clipping, colour map, noise and detail, colour calibration, background neutralization and the output filename.

### Fixed (stacking, 0.11.1)
- Colour FITS (RGB cubes from one-shot-colour cameras, Slooh `_cal` frames, narrowband composites) could not be stacked ("WCS alignment is available for 2-D CCD frames"). Each colour plane is now calibrated, aligned through the frame's WCS and combined with CCDProc, and the cube is reassembled; calibration masters may be 2-D (applied to every plane) or cubes (plane by plane). Verified on NGC 7293 and 51 Andromedae: levels preserved, noise reduced, star size unchanged.
- The Stack page only said "Failed to stack FITS frames"; it now shows the actual reason (missing plate solution, mixed mono and colour frames, missing Python packages…) and lists every warning.
- Frames without EXPTIME no longer make exposure normalization fail: they are normalized to the reference's median level, with a warning. Mixing exposures without a master bias/dark is flagged, since exposure scaling then also scales the bias pedestal.
- Blank (NaN/Inf) pixels are masked instead of propagating into the stack; stacked colour FITS keep a clean, readable 2-axis celestial WCS (the deprecated RADECSYS keyword no longer hides it), so a stack can be stacked again.
- The pipeline script is found wherever the server runs from, and a missing analysis Python is reported clearly instead of "spawn ENOENT".

### Fixed (FITS processing)
- Colour maps did nothing on colour (3-channel) FITS — only "inverted" changed the preview. Every map now works on colour FITS by applying it to the luminance (Rec. 709); "grey" keeps natural colour.
- Hot-pixel removal treated ordinary noise as hot pixels on smooth images (MAD of 0); the threshold now has a floor from the measured pixel-to-pixel noise.
- Background extraction subtracted part of galaxies and nebulae (a box blur of the image); it now fits a SExtractor-style mesh background (3σ-clipped box medians, 3×3 median filter, bilinear interpolation extrapolated to the edges), so extended objects are kept.
- Sharpen and denoise use a true Gaussian blur instead of a single box blur.
- Previews were point-sampled, aliasing stars and noise when zoomed out; they are now area-averaged and cached, so changing parameters re-renders in about half a second (the first render of a large FITS takes a few seconds). A failed preview is retried before an error is shown ("Preview failed" on the Jupiter FITS).
- Processed FITS keep the original WCS, are marked as normalized non-linear data and record every processing setting in HISTORY.
- The zoom percentage no longer overlaps the preview's fullscreen button, and the "Updating preview…" label is centred.

### Added (desktop app)
- AstroviaBin desktop app (`desktop/`, Electron): a system-tray app that runs the server, with a styled first-run setup that explains every option and must be completed before the server starts (address and port, administrator account, database file, separate photo and FITS folders, cache/sidecars/backups/logs, plate-solving tools and indexes, HOTPANTS/Python analysis, online catalogues). The tray reopens the settings, starts/stops/restarts the server, opens the web UI, logs and folders. Before each start the database is checked read-only and a verified online SQLite backup is made.
- 0.11.1: the `.deb` bundles its own Python 3.13 (python-build-standalone) with NumPy, SciPy, Astropy, Matplotlib, CCDProc, Photutils and astroscrappy preinstalled and pinned — the same versions as the Windows build — so stacking and HOTPANTS work on any distribution (Debian 12, Ubuntu 22.04/24.04…) without pip or internet; 0.11.0 only shipped Python 3.13 wheels and failed elsewhere.
- 0.11.1: AstroviaBin opens in its own app window (setting "Open AstroviaBin in": app window or web browser), keeps you signed in, sends links to other sites to the browser, and reconnects while the server restarts. The tray menu switches sharing between "Only this computer" and "Every device on my local network" (restarting the server) and lists the LAN addresses to copy. When the astroviabin.service systemd unit serves AstroviaBin, the tray can restart and stop it too.
- 0.11.1: clean uninstall. Linux (`apt remove`): stops every AstroviaBin server and tray app, disables the user service and the login autostart for every user, removes Electron caches; `apt purge` also removes settings and the regenerable caches. Upgrades restart running services on the new version. Windows: the installer and uninstaller close the tray app and its server (only processes from the install folder), the uninstaller removes the login autostart and Electron caches and asks whether to delete the settings. Databases, backups, photos and FITS are never deleted.
- Installers: Linux `.deb` (also installs the headless `astroviabin-server` command and an `astroviabin.service` systemd user unit, with the scientific Python packages in `/opt/AstroviaBin/python`), Windows `.exe` (NSIS) and `.msix` (built on Linux with Microsoft's MSIX SDK, test-signed). Each bundles Node, the server, the offline sky catalogues and HOTPANTS.

### Added (HOTPANTS verification)
- Every completed analysis now gets verification products in the background: a weighted PSF fit on the difference image with formal errors; astrometry tied to the nearest Gaia DR3 stars (proper motions at the observation date, local offset + gradient), with a 1σ uncertainty that includes local systematics; a Gaia-calibrated magnitude; and cross-matches with Gaia DR3, AAVSO VSX, SIMBAD and OpenNGC host-galaxy ellipses, plus the known-asteroid check. Each candidate gets a reasoned verdict (known asteroid, known variable, stellar variability, possible extragalactic transient, unclassified new source).
- Marked stamps (science, reference, difference, finder chart with exact subpixel crosshair, error circle, N/E compass and scale bar), a science ↔ PSF-matched-reference blink GIF, and links to Aladin Lite, the Legacy Surveys viewer, TNS, SIMBAD, VSX and ESASky.
- Downloadable PDF report: observation and method summary, the full field with numbered candidates, and one page per candidate with stamps, finder chart, measurements, checks, verdict and clickable links. "Regenerate" includes later second-epoch checks.
- Validated against Gaia stars withheld from the calibration: median error 0.05" (single frame), 0.15" (3.7"/px wide field) and 0.21" (stack), every one within 2σ of the stated uncertainty; 1620 Geographos lands 0.23" from its IMCCE ephemeris.

### Fixed (HOTPANTS)
- New sources were discarded wherever HOTPANTS set the informational FLAG_OK_CONV bit; only FLAG_OUTPUT_ISBAD pixels are excluded now.
- Survey holes (exact 0.0 pixels where Legacy/PS1 coadds masked saturated star cores) were used as real sky, so those stars appeared as new sources; they are now treated as missing reference data.
- Single exposures are cleaned of cosmic rays and hot pixels (astroscrappy / L.A.Cosmic) at native resolution before binning; on a real single frame they had produced ~1500 detections and 10 false candidates.
- The science-to-reference registration is refined with matched stars (sigma-clipped polynomial) before subtracting; plate solutions of wide fields were off by up to 2.4 px at the edges, turning every edge star into a false candidate (residual 1.0 → 0.2 px on NGC 253).
- A candidate on top of any significant reference peak counts as an existing object even when the survey star is saturated or bleeding (cross-shaped DECam stars passed the PSF-shape test).
- The bleed-trail mask measured close star pairs as trails and covered ~8% of undersampled fields; it now measures only the connected blob of each star (1%).
- The subtraction-dipole test only looks for a negative lobe adjacent to the source, so candidates on a galaxy's disk are no longer discarded by unrelated residuals.
- Verified with fake sources injected into real frames: zero false candidates on the test images; recovered 4/6 on the NGC 253 frame (the two misses fell on existing sources) and every source with peak ≥ 10σ on a stack.
- Star masks never cover extended galaxies (nucleus and disk stay searchable for supernovae); the bleed mask only applies to thin, bright, compact trails.

### Added
- Online catalogues for annotations when the server has internet: Gaia DR3 stars (VizieR) and named SIMBAD objects, merged without duplicates and cached per image on disk (`AppData/online-catalog-cache`); a "Rescan annotations" button next to "Re-solve locally" refreshes them (online when reachable, otherwise offline). Only field coordinates are sent; `ASTROVIABIN_ONLINE_CATALOGS=false` disables it.
- Astro-style annotations: named stars (proper name, Bayer, Flamsteed), HD/HIP and Tycho-2 stars with magnitudes and proper motion, deep-sky outlines with catalogue size and position angle, constellation figures and names, and an RA/Dec grid — all projected through each image's WCS from an offline bundle built at image build time. Layer toggles, constant on-screen marker size and label decluttering in the viewer.

### Fixed
- Constellation lookup now uses the official IAU boundaries (Roman 1987); existing images are corrected on startup (it previously used rough rectangles).
- OpenNGC entries that are single/double stars or "Other" are no longer drawn as deep-sky objects.
- Non-tiled previews (FITS processing panel) failed to open in the viewer.

## [0.11.0] - 2026-10-19

First release as **AstroviaBin** (formerly Sidereal; history below keeps the old name).

### Changed
- Rebranded to AstroviaBin: new name, logo and icon set (SVG, PNG, favicon), and a cyberpunk interface theme (neon palette, Orbitron/Rajdhani/Share Tech Mono fonts bundled locally, chamfered panels, grid background, scanlines), including the login page.
- Environment variables are now `ASTROVIABIN_*`; the previous `SIDEREAL_*` names are still accepted as aliases. A new install uses `/app/config/astroviabin.db`, an existing `sidereal.db` is used automatically when present. The session cookie was renamed, so users sign in once more.
- Docker image, container, Compose services, Unraid template and CI image names use `astroviabin`.

### Added
- User management in Admin settings: create accounts, assign admin / editor / viewer roles, change passwords, delete users (scrypt hashes, role checked on every request, sessions revoked on password change or deletion).
- Stack FITS frames: load a gallery catalog, filter frames, see each frame's size/filter/exposure, pick the alignment reference, flag size mismatches, and save the selection as a catalog.
- Sun, Moon and planet images are grouped under one "Solar System" target.
- Login page and signed session cookies protecting every page, API route and the WebSocket (`SIDEREAL_ADMIN_USER` / `SIDEREAL_ADMIN_PASSWORD`, default admin / admin), with login throttling and sign-out.
- Gallery catalogs: named groups of photos and FITS, gallery filter, per-image picker, bulk "add shown images".
- Local plate solving stores the full WCS (TAN + SIP); annotations for every OpenNGC object in the field are projected from it at native resolution.
- Noise-robust star extraction, automatic solve hints (previous solution, FITS pointing, M/NGC/IC names) and a manual RA/Dec hint; "Re-solve locally" from the image sheet.
- Support for extra narrow-field Astrometry.net index directories and a `download-astrometry-indexes` helper.
- Daily consistent SQLite backups and bounded preview/tile caches.

### Fixed
- Annotations from solves imported from nova.astrometry.net were drawn in the coordinate space of the resized upload; they are now scaled to native pixels and flagged until re-solved.
- Sparse or noisy frames failing to solve because the built-in extractor found too few stars.
- `preview=full` FITS renders are bounded (`FITS_FULL_PREVIEW_MAX`) instead of allocating the whole frame.
- `/api/health` reports the real version; the worker no longer logs the auto-solve-disabled message every cycle.
- Queued plate solves show as "Queued" and only the frame being solved as "Solving"; the sidebar no longer shows a fixed "~3 min" and fake progress bar.
- The app shell no longer loads a third-party Replit script.
- Stale route tests after the move away from Immich and multipart uploads.

## [0.10.5] - 2026-10-06

### Fixed
- **Astrometry polling**: Null job placeholders and processing timestamps no longer produce false solve failures. Both polling paths validate remote IDs and calibration before completing jobs (#309).
- **Plate solving recovery**: Synchronous polling exhaustion returns HTTP 202 with the existing submission. Check status reuses that submission and can recover historical false failures without another upload.
- **Plate Solving page**: Added waiting/solving messages, processing details, compact per-record status checks, terminal-only completion dates, and 30-second active-job/focus refresh. The image modal uses the registered solve endpoint and handles HTTP 202.

### Security
- **Docker runtime**: Remove npm and npx after production dependency installation to eliminate vulnerable bundled tooling. Node and Corepack remain available; `docker exec` commands using npm or npx now require a separate development container.
- **shell-quote**: Override the development dependency to 1.11.0 to fix critical command injection via newline-bearing tokens after comments (CVE-2026-102422).

## [0.10.3] - 2026-09-25

### Fixed
- **Immich album sync**: With Immich 3.x, **Sync by album only** found the selected albums but imported no images, because Immich no longer lists an album's images in its album response. Sidereal now fetches each selected album's images through Immich's metadata search (#293).

### Changed
- **Immich album sync**: Album sync now imports only images, as full-library sync already did. Videos in a selected album are no longer imported.
- **Dependencies**: drizzle-orm 0.45.2 → 0.45.3 and @types/better-sqlite3 7 → 9.

## [0.10.2] - 2026-09-25

### Fixed
- **Docker images**: The weekly prune job deleted the platform images behind the `latest` and `0.10.x` tags, so `docker pull` failed with `manifest unknown`. The job now keeps any manifest a kept tag references.
- **Image location**: The compose file, README, and Unraid template now point to `ghcr.io/sidereal-io/sidereal` (#256).

### Security
- **Docker image**: Replaced the pinned npm 11.14.1 install, which now downgraded npm, with an upgrade to the newest npm 11.x. This patches npm's bundled `tar`, `brace-expansion`, and `ip-address`. The image has no fixable high or critical Trivy findings.

### Changed
- **Dependencies**: Brought dependencies up to date with `main`, including majors: TypeScript 6 → 7, better-sqlite3 12 → 13, framer-motion 12 → 13, and nanoid 5 → 6.
- **TypeScript**: Removed `baseUrl` from `tsconfig.json`; TypeScript 7 no longer supports it, and `paths` resolve without it.
- **Docker build**: The builder stage installs `python3`, `make`, and `g++` so native modules without a prebuilt binary compile.
- **CI**: Typecheck, tests, build, Docker lint, and image builds now run for `v0.x` pushes and pull requests. Branch pushes publish a `v0.x` image tag; `latest` still comes only from releases.

## [0.10.1] - 2026-06-10

### Security
- **hono**: Updated 4.12.18 → 4.12.25 to fix four medium CVEs: cookie `sameSite`/`priority` injection (CVE-2026-47675), `app.mount()` percent-encoded path routing (CVE-2026-47676), IPv6 non-canonical address bypass in IP restriction (CVE-2026-47674), JWT middleware accepting non-Bearer schemes (CVE-2026-47673).
- **ws**: Updated 8.20.0 → 8.21.0 to fix uninitialized memory disclosure (CVE-2026-45736).
- **tmp**: Updated 0.2.5 → 0.2.7 to fix path traversal via unsanitized prefix/postfix (CVE-2026-44705).
- **concurrently**: Updated 9.2.1 → 10.0.3 to resolve critical shell-quote newline injection vulnerability (CVE) via transitive dependency.

### Changed
- **Dependencies**: Updated all production and development dependencies within semver ranges.
- **GitHub Actions**: Bumped `actions/download-artifact` v4 → v8 in release and Docker build workflows.

## [0.10.0] - 2026-05-15

### Changed
- **Rebrand**: Renamed project from Skymmich to Sidereal across all code, configuration, documentation, and Docker artifacts. See the [Migration Guide](docs/MIGRATION.md) for upgrade steps.
- **Dependencies**: Updated production dependencies — @tanstack/react-query 5.100.10, framer-motion 12.38.0, hono 4.12.18, lucide-react 1.14.0, react 19.2.6, react-dom 19.2.6, react-resizable-panels 4.11.0, tailwind-merge 3.6.0, zod 4.4.3, and others.
- **Dev Dependencies**: Updated development dependencies including drizzle-kit, esbuild, postcss, tailwindcss, tsx, vite, and various @types packages.
- **CI**: Replaced QEMU ARM64 emulation with native `ubuntu-24.04-arm` runners for faster multi-arch builds.
- **CI**: Use tag references instead of digests for Trivy and SBOM steps.

### Security
- **npm**: Bumped to 11.14.1 to resolve CVE-2026-42338.

### Breaking Changes
- **Environment variable**: `SKYMMICH_PORT` → `SIDEREAL_PORT`
- **Docker volumes**: `skymmich-*` → `sidereal-*` (existing volumes must be renamed or remapped)
- **PostgreSQL defaults**: database name and user renamed from `skymmich` to `sidereal`
- **SQLite default path**: `/app/config/skymmich.db` → `/app/config/sidereal.db`
- **Container system user**: `skymmich` → `sidereal`
- **Unraid template paths**: `/mnt/user/appdata/skymmich/` → `/mnt/user/appdata/sidereal/`
- **Asset filename**: `skymmich-transparent.png` → `sidereal-transparent.png`

## [0.9.2] - 2026-04-08

### Security
- **hono**: Updated to 4.12.12 to fix cookie name validation bypass, IP matching in ipRestriction(), path traversal in toSSG(), and middleware bypass via repeated slashes in serveStatic.
- **@hono/node-server**: Updated to 1.19.13 to fix middleware bypass via repeated slashes in serveStatic.
- **vite**: Updated to 8.0.5 to fix path traversal in optimized deps, `server.fs.deny` bypass, and arbitrary file read via WebSocket.

## [0.9.1] - 2026-03-31

### Changed
- **Dependencies**: Updated production dependencies — @tanstack/react-query 5.95.2, drizzle-orm 0.45.2, hono 4.12.9, lucide-react 1.7.0, react-resizable-panels 4.8.0, recharts 3.8.1.
- **Dev Dependencies**: Updated TypeScript to 6.0.2 and Vite to 8.0.3.
- **GitHub Icon**: Replaced lucide-react `Github` icon (removed in v1.0) with inline SVG.
- **TypeScript Config**: Added `ignoreDeprecations: "6.0"` for TypeScript 6.x `baseUrl` deprecation.
- **CI**: Upgraded GitHub Actions workflows from Node 20 to Node 24.

### Security
- **picomatch**: Override to >=4.0.4 to fix method injection vulnerability (GHSA).
- **brace-expansion**: Updated to fix zero-step sequence hang vulnerability.

## [0.9.0] - 2026-03-23

### Added
- **Sky Map Equipment FOV Overlay**: Select telescope and camera from the sky map to display a real-time field-of-view rectangle overlay, calculated from focal length, pixel size, and sensor resolution. Includes a toggle to show/hide the FOV and displays which equipment specs are missing when the overlay can't be computed.
- **Sky Map UI Improvements**: Repositioned Aladin Lite controls — coordinates and zoom in bottom-left, overlays menu in bottom-right, telescope/camera selectors in top-left. Added fullscreen support with responsive control placement.
- **Database Admin Section**: New admin panel section showing database engine, file size, and last modified timestamp. Includes a one-click backup download button for SQLite databases.
- **Database Migration Script**: New `migrate-db` tool for migrating data between PostgreSQL and SQLite in either direction. Discovers tables and column types dynamically from database metadata — no manual updates needed when the schema changes. SQLite targets automatically run Drizzle migrations to ensure the schema exists.
- **Auto-Migration on Startup**: Set `AUTO_DB_MIGRATE_FROM` environment variable to automatically migrate data during Docker container startup. Supports one-time migration with a marker file, optional SQLite reset, and credential masking in logs.
- **Target Name Column**: New `target_name` column on astrophotography images (migration 0008).

### Changed
- **Default Database**: SQLite is now the default database for all deployments including Docker and UnRAID. No external database setup required — data is stored in `/app/config/skymmich.db`.
- **PostgreSQL Optional**: PostgreSQL remains fully supported as an optional external database. Use `docker-compose.postgres.yml` as a compose override or set `DATABASE_URL` to enable it.
- **Docker Compose**: Simplified to a single-container setup by default. PostgreSQL service moved to a separate `docker-compose.postgres.yml` override file.
- **UnRAID Template**: Removed PostgreSQL as a requirement. `DATABASE_URL` is now optional with an empty default.
- **Dockerfile**: `better-sqlite3` is now included in the production image for built-in SQLite support.
- **SQLite Path**: Configurable via `SQLITE_DB_PATH` env var, defaults to `/app/config/skymmich.db` in production and `local.db` in development.
- **SQLite Migrations Path**: Migrations folder is now resolved dynamically across multiple candidate paths, fixing issues when running inside Docker.
- **Build Order**: `build:docker` now runs vite, copy-assets, then esbuild in the correct order to ensure the migration script is bundled properly.
- **XMP Sidecar**: Marked as experimental in documentation — feature is under active development and may not work as intended in all configurations.

### Fixed
- **Tag Filtering**: Image tag filtering now works on both SQLite (using `json_each`) and PostgreSQL (using native array overlap). Previously only PostgreSQL was supported.

## [0.8.0] - 2026-03-22

### Changed
- **Server Framework**: Migrated from Express to Hono with `@hono/node-server` for HTTP routing. All 13 route files converted to Hono's context-based handler API.
- **HTTP Client**: Replaced axios with native `fetch` across all server services and routes. Uses `AbortSignal.timeout()` for request timeouts and native `FormData` for multipart uploads.
- **WebSocket**: Replaced Socket.IO with native WebSocket using the `ws` package on the server and browser-native `WebSocket` on the client. Added automatic reconnection with exponential backoff.
- **Asset Proxy**: Immich asset proxy now streams responses via `fetch()` passthrough instead of axios stream piping.
- **Mobile Navigation**: Added hamburger menu for mobile viewports. Navigation links, Sync Immich, and Admin Settings are accessible from a slide-out drawer on the right. Desktop header is unchanged.
- **Toast Position**: Toast notifications now appear at the bottom of the screen on mobile instead of the top.

### Removed
- **Dependencies**: Removed express, axios, form-data, socket.io, socket.io-client, cors, passport, passport-local, connect-pg-simple, memorystore, and their associated type packages.
- **Stale Overrides**: Removed `qs` and `socket.io-parser` npm overrides that were only needed for Express/Socket.IO transitive dependencies.

### Fixed
- **Missing Dependency**: Added `pg` as an explicit dependency. It was previously resolved as a transitive dependency of `connect-pg-simple`.
- **Connection Test Responses**: Added missing `success` field to Immich and Astrometry test connection responses so the frontend can correctly show green/red status styling.
- **Catalog Backfill Counter**: Fixed matched count never incrementing during catalog backfill.
- **Notification Timestamps**: Fixed field mismatch (`timestamp` → `createdAt`) in notification display.
- **Plate Solving Timeout**: Added 60-minute timeout to plate solving poll loop to prevent infinite hangs.
- **Remote Image URLs**: Fixed `RemoteImage` component stripping query parameters from image URLs.
- **Redacted Key Handling**: Properly handle redacted API keys in test connection and album endpoints to avoid overwriting stored keys.
- **Async File I/O**: Replaced blocking `readFileSync`/`writeFileSync` with async `fs` operations.
- **Astrometry HTTPS**: Changed all Astrometry.net API calls from HTTP to HTTPS.
- **API Key Masking**: Mask API keys in `GET /admin/settings` response, showing only the last 4 characters.
- **Database URL Redaction**: Redact `DATABASE_URL` password in Docker startup logs.
- **Stats Query**: Rewrote `getStats()` to use SQL aggregation instead of loading all rows into memory.
- **Dead Code Removal**: Removed unused `apiToken` localStorage code from the client.
- **Shared Notification Type**: Created shared `Notification` type, removing 3 duplicate interface definitions.
- **Immich Sync Refactor**: Extracted Immich image sync into a service layer; cron calls service directly.
- **Query Filters**: Replaced fragile positional `queryKey` array with typed `QueryFilters` object.
- **Schema Improvements**: Added missing foreign key references to SQLite schema and sync comments between pg and sqlite files.

## [0.7.2] - 2026-03-21

### Fixed
- **ReDoS Vulnerability**: Fixed polynomial regular expression in catalog name normalization that could cause denial-of-service with crafted input.
- **Thumbnail Path Safety**: Serve cached thumbnails via static middleware instead of manual file reads, delegating path safety to the framework.
- **Thumbnail Rate Limiting**: Added global throttle on external survey image fetches to prevent abuse of the upstream API.

## [0.7.1] - 2026-03-20

### Fixed
- **Docker Permissions**: Added `/app/cache` to startup permission management. This ensures that the container automatically handles ownership of survey images and thumbnails regardless of host environment or PUID/PGID settings.
- **Persistence**: Fixed missing cache volume mappings in production Docker Compose and Unraid templates.

## [0.7.0] - 2026-03-20

### Added
- **Deep Sky Catalog & Targets**: New "Targets" page for browsing and filtering astronomical objects (Messier and NGC/IC catalogs).
- **Advanced Target Filtering**: Search by name/aliases, multi-select object types, filter by constellation, magnitude range, and minimum size.
- **Survey Thumbnails**: Automatic DSS2 survey image previews from Aladin Lite (hips2fits) with local disk caching.
- **"Best Now" Sorting**: Intelligently rank targets based on current date and observer location to find what's best to image tonight.
- **Visibility Filtering**: Support for hiding targets currently below the horizon based on managed location coordinates.
- **Auto-Matching**: Automatically assign catalog targets to images after successful plate solving.
- **Target Picker Modal**: Interactive search tool to manually assign catalog targets to gallery images.
- **Backfill Administrative Tool**: New "Backfill Targets" button in Admin to re-match all existing plate-solved images against the catalog.
- **Immich Metadata Sync**: Full writeback of metadata to Immich, including image description, constellation, and celestial coordinates.
- **Metadata Configuration**: Granular admin toggles to enable/disable specific metadata fields for Immich sync.
- **Gallery Equipment Filter**: Clicking an equipment badge in the image overlay now automatically filters the gallery to show all images using that equipment.

### Changed
- **Header Navigation**: Added "Targets" to the main site navigation.
- **Dockerfile**: Added persistent cache directory for thumbnails (`/app/cache/thumbnails`).
- **App Layout**: Registered new `/targets` route and updated global UI components.
- **Persistence**: Added new `/app/cache` volume requirement. **Existing Docker and Unraid users should manually add this path mapping to ensure survey images and thumbnails persist across restarts.**

### Fixed
- **Thumbnail Cache**: Improved thumbnail serving performance via disk-based caching and immutable headers.
- **Plate Solving**: More robust target matching during the post-processing phase of plate solving jobs.

## [0.6.1] - 2026-03-19

### Fixed
- **PostgreSQL Migration**: Added missing `created_at` column to `equipment_group_members` table in PostgreSQL DDL.

### Security
- **socket.io-parser CVE**: Overrode socket.io-parser to >=4.2.6 to fix high-severity unbounded binary attachments vulnerability.
- **Docker Image**: Patched node-tar and zlib CVEs in Docker image.
- **Dockerfile Lint**: Added hadolint ignore for DL3002 since root is required for PUID/PGID remapping at startup.

### Changed
- **Dependencies**: Updated production dependencies (better-sqlite3, framer-motion, nanoid, openseadragon, react-resizable-panels).

## [0.6.0] - 2026-03-11

### Added
- **Equipment Groups**: Create named equipment groups (e.g., "Deep Sky Rig") to bundle telescopes, cameras, and accessories together for quick assignment to images.
- **Apply Group to Image**: Apply an equipment group to an image from the gallery overlay, with preview of members and duplicate detection.
- **Equipment Cost & Acquisition Date**: Track purchase cost and acquisition date for equipment items.
- **Real-time Notifications**: Notifications now use React Query with socket.io events for instant updates across tabs.

### Changed
- **Dependencies**: Updated production and development dependencies (axios, react-day-picker, react-resizable-panels, autoprefixer, @types/node).
- **GitHub Actions**: Updated docker/setup-buildx (v4), docker/login (v4), docker/metadata (v6), docker/build-push (v7), actions/upload-artifact (v7), aquasecurity/trivy-action (0.35.0).
- **Dockerfile**: Fixed linting errors (DL3003, DL3042) and improved caching efficiency.
- **Docs**: Consolidated feature documentation into `docs/features/` directory.

### Fixed
- **GHCR Prune**: Fixed image pruning workflow to preserve semver release tags.
- **Equipment Form**: Restructured form layout to row-based and improved dark mode contrast for inputs and labels.
- **Database**: Added missing `original_path` column to SQLite schema migration.

## [0.5.1] - 2026-03-01

### Fixed
- **Immich Auto-Sync**: Fixed automatic sync cron job failing with HTTP 404 due to incorrect API route path.
- **Plate Solving Error Messages**: Improved error messages for failed plate solving jobs with actionable context (e.g., incorrect scale hints, expired jobs).
- **Plate Solving Null Jobs**: Smarter handling of null Astrometry.net jobs — distinguishes between still-processing and truly failed submissions.
- **Notification Badge**: Header notification badge now updates instantly when alerts are acknowledged in admin.
- **Image Deletion Cascade**: Deleting an image now properly cascades to plate solving jobs, equipment links, and acquisition entries.
- **Sync Metadata Errors**: Sync-metadata errors now show actionable messages instead of generic failures.

### Added
- **Astrometry.net Links**: Plate solving job details now include direct links to Astrometry.net submission and annotated result pages.
- **Gallery Auto-Refresh**: Gallery automatically refreshes after a successful Immich sync.

### Changed
- **CI**: Removed `latest` tag from main branch Docker builds.
- **Sync Error Messages**: Improved error messages during metadata sync to Immich.

## [0.5.0] - 2026-02-28

### Added
- **Equipment Catalog & Management**: Full equipment system with type-specific specification fields (focal length/aperture for telescopes, sensor type/pixel size for cameras, etc.) and custom field support.
- **Per-Filter Acquisition Tracking**: New acquisition editor for recording sub-exposure details per filter, including frame count, exposure time, gain/ISO, binning, sensor temp, and date.
- **Auto-Computed Image Summaries**: Total integration time, frame count, and filter lists are automatically computed from acquisition entries and linked equipment.
- **Location Management**: Interactive map picker for managing imaging locations.
- **Advanced Search Filters**: New search and filtering capabilities in the UI.

### Changed
- **Immich Sync**: Replaced multi-endpoint fallback sync with paginated `/api/search/metadata` for reliable full-library sync across all Immich versions.
- **Tag Filtering**: Extracted shared tag filtering logic into a reusable module; plate solving tags are now filtered consistently across sync, XMP sidecars, and the tags API.
- **Equipment Manager**: Replaced generic key/value specs with structured fields per equipment type, plus custom field support.
- **Technical Details**: Replaced the manual technical details editor with the acquisition editor for structured per-filter data entry.
- **Database Schema**: Updated to support locations, acquisitions, and enhanced metadata; migrations run automatically on startup.
- **Themed UI Components**: Replaced native select elements with themed Shadcn components.

### Fixed
- **Immich Sync Pagination**: Library sync no longer silently caps at 5000 assets; properly paginates through all results.
- **Immich Non-Album Sync**: Resolved sync issues when not using album-based sync.
- **Equipment Settings Removal**: Fixed a bug where removing image-specific equipment settings would not persist after reload.
- **Acquisition Save Errors**: Added visible error messages when saving acquisition entries fails.

### Security
- **Rollup Dependency**: Overrode Rollup to v4.59.0 to address security vulnerabilities.
- **Minimatch ReDoS**: Overrode minimatch to >=10.2.3 to fix ReDoS vulnerability from combinatorial backtracking.

## [0.4.1] - 2026-02-26

### Added
- **Visual Image Renaming**: Ability to set a custom display title for images without changing the underlying system filename.
- **PUID/PGID Support**: Support for remapping the container user ID and group ID to match host volume permissions (standard for Unraid and Linux environments).

### Changed
- **Themed UI Components**: Replaced native select and input elements with themed Shadcn components for a consistent visual identity.

### Fixed
- **Permissions**: Resolved `EACCES` errors when creating date-organized sidecar directories in Docker by supporting UID/GID remapping.

### Security
- **Rollup Dependency**: Overrode Rollup version to v4.59.0 to address multiple security vulnerabilities.

## [0.4.0] - 2026-02-26

### Added
- **Interactive Sky Map**: A high-fidelity celestial atlas powered by Aladin Lite v3 for visualizing your plate-solved image collection.
- **Image Deep Linking**: Added `?image=ID` URL parameter support to open specific image overlays directly from the sky map or shared links.
- **Pleiades (M45) Test Data**: Added high-accuracy coordinate data for Pleiades to development seed scripts.
- **Automatic GHCR Pruning**: Weekly GitHub Action to automatically clean up old or untagged Docker images from the container registry.

### Changed
- **Aladin Lite v3**: Upgraded to the latest Aladin Lite engine for improved performance and WebGL2 support.
- **Coordinate Precision**: Standardized internal coordinate storage to decimal degree strings for accurate map plotting.
- **Navigation Cleanup**: Removed unimplemented "Collections" link from the sidebar.

### Fixed
- **WebGL Detection**: Added browser capability detection with user-friendly error messages for unsupported environments.
- **Global UI Tweaks**: Added `cursor: pointer` to all button elements for better interactivity feedback.

## [0.3.0] - 2026-02-25

### Added
- **XMP Sidecar Generation**: Automatic generation of astronomical metadata sidecars for plate-solved images.
- **Date-based Organization**: Option to organize sidecar files in `YYYY-MM/` subdirectories.
- **Sidecar Download API**: Endpoint to download generated XMP files directly from the gallery.
- **Admin Configuration**: New settings panel for XMP sidecar output paths and organization rules.

### Changed
- **EXIF Extraction**: Improved lens and telescope detection from Immich metadata to auto-populate equipment fields.
- **Worker Robustness**: Enhanced plate solving worker with better error recovery and continuous polling logic.

## [0.2.0] - 2025-07-06

### Added
- **Docker Multi-stage Builds**: Optimized production-ready container images with multi-architecture support.
- **UnRAID Integration**: Dedicated templates for easy deployment on home servers.
- **PostgreSQL Support**: Full support for production-scale databases while maintaining SQLite for development.
- **Worker Management**: Fine-grained control over the plate solving background process via the UI.
- **Health Checks**: Added container health check endpoints for monitoring.

### Changed
- **Monorepo Structure**: Reorganized codebase into `/apps/` and `/packages/` for better maintainability.
- **Configuration Service**: Enhanced to prioritize database settings over environment variables.

### Fixed
- **Thumbnail Proxy**: Fixed 500 errors by ensuring proper configuration service integration.
- **Security Vitals**: Removed all hardcoded secrets and transitioned to secure environment variables.

### Security
- **SSRF Protection**: Added protocol and host validation for all external API integrations.
- **Non-root Execution**: Transitioned Docker containers to run as a dedicated user.

## [0.1.0] - 2025-01-27

### Added
- **Initial Release**: Core functionality including Immich synchronization and image management.
- **Plate Solving**: Astrometry.net integration for automatic celestial coordinate detection.
- **Equipment Catalog**: Manage telescopes, cameras, and accessories.
- **Deep Zoom Viewer**: OpenSeaDragon integration for high-resolution exploration.
- **Real-time Updates**: WebSocket (Socket.io) support for live processing status.
- **Cron Scheduling**: Automated synchronization tasks.
