# Licenses, credits and legal notices

AstroviaBin is built on many third-party projects, datasets and online services. This document says, for each of them:
- what its license or terms of use are;
- how AstroviaBin distributes or uses it;
- what anyone who uses, redistributes or publishes results with AstroviaBin must do to respect those terms.

It was reviewed on 2026-10-22 for AstroviaBin 0.12.8. It is a good-faith summary, not legal advice. The license texts themselves are authoritative.

## Where the license files are

| Distribution | Location |
|---|---|
| Linux `.deb` | `/opt/AstroviaBin/resources/licenses/` (this document is `THIRD-PARTY-NOTICES.md`); Electron and Chromium notices in `/opt/AstroviaBin/LICENSE.electron.txt` and `LICENSES.chromium.html`; Node.js in `resources/runtime/LICENSE` |
| Windows installer | `resources\licenses\` inside the installation folder, with the same files |
| Docker image | `/usr/share/doc/astroviabin/`, `/usr/share/doc/hotpants/` (with the HOTPANTS source), and the Debian `copyright` files under `/usr/share/doc/<package>/` |
| Source repository | `LICENSE`, `licenses/third-party/`, `vendor/hotpants/`, `docs/licenses/` |

In the app, the same documents are linked from **Admin → About**.

Generated inventories (rebuilt at every installer build):
- [`docs/licenses/python-packages.md`](licenses/python-packages.md): every bundled Python package with its version, license and the path of its license text.
- [`docs/licenses/javascript-packages.md`](licenses/javascript-packages.md) and `javascript-licenses.txt`: every production JavaScript package, including the ones compiled into the web client, with the full license texts.

## 1. AstroviaBin

AstroviaBin is distributed under the **MIT license** (`LICENSE`). It is a fork of **Sidereal**, also MIT, and Sidereal's copyright notice is retained in `LICENSE`.

The MIT license covers AstroviaBin's own code only. Every component below keeps its own license.

## 2. Scientific software bundled in the installers

The `.deb` and the Windows installer contain a private Python with these packages, unmodified. The Docker image installs the same packages with pip on top of Debian's Python, NumPy, SciPy and Astropy.

| Component | Version | License | Use in AstroviaBin |
|---|---|---|---|
| Astropy | 8.0.2 | BSD-3-Clause | FITS, WCS, coordinates, units, statistics, model fitting |
| NumPy | 2.5.4 | BSD-3-Clause and bundled parts (0BSD, MIT, Zlib, CC0; OpenBLAS BSD; libgfortran GPL-3.0 with GCC Runtime Library Exception) | Numerical arrays |
| SciPy | 1.18.1 | BSD-3-Clause and bundled parts (same runtime libraries) | Fitting, KD-trees, filters |
| CCDProc | 2.5.1 | BSD-3-Clause | CCD calibration, combination, stacking |
| reproject | 0.21.0 | BSD-3-Clause | WCS reprojection for stacking |
| Photutils | 3.1.1 | BSD-3-Clause | Background, source detection (DAOStarFinder), centroids, aperture photometry |
| astroscrappy | 1.3.0 | BSD-3-Clause | L.A.Cosmic cosmic-ray rejection |
| scikit-image | 0.26.0 | BSD-3-Clause | Image utilities (dependency of astroalign) |
| Specutils | 2.4.0 | BSD-3-Clause | Spectral lines, continuum, equivalent widths |
| Specreduce | 1.9.0 | BSD-3-Clause | Spectral tracing, background, extraction |
| Astroquery | 0.4.11 | BSD-3-Clause | SIMBAD, Gaia (VizieR) and SDSS queries |
| astroalign | 2.6.2 | MIT | Aligning frames too sparse to plate-solve to a solved frame of the same pointing |
| SEP | 1.4.1 | **LGPL-3.0-or-later** (with BSD and MIT parts) | Star extraction inside astroalign |
| Matplotlib | 3.11.2 | PSF-based Matplotlib license (bundled DejaVu and STIX fonts with their own free licenses) | Plots and PDF reports |
| Pillow | 13.0.0 | MIT-CMU | Images in reports |
| Other dependencies | — | BSD, MIT, Apache-2.0, MPL-2.0 (certifi), PSF-2.0 | See `python-packages.md` |

### Other bundled programs

| Component | License | Use in AstroviaBin |
|---|---|---|
| HOTPANTS (Andrew Becker; upstream commit `63e1260`) | **GPL-2.0** (`COPYING`), plus an MIT notice (`LICENSE`) | Image subtraction |
| CFITSIO (NASA HEASARC) | Permissive NASA/GSFC license | Linked into HOTPANTS on Windows, with its license in `bin/CFITSIO-LICENSE.txt`. On Linux the system package `libcfitsio10` is used and not redistributed |
| CPython 3.13.12 | PSF-2.0 (`python/lib/python3.13/LICENSE.txt`, or `python\LICENSE.txt` on Windows) | Runs the analysis scripts |
| python-build-standalone 20260325 (Linux) | **MPL-2.0** for its build files; includes statically linked libraries | The Python runtime of the `.deb` |

The libraries inside python-build-standalone are OpenSSL, SQLite, libffi, xz/liblzma, zlib, bzip2, libedit, ncurses, mpdecimal, expat, Tcl/Tk, libX11/libxcb, libuuid and Berkeley DB. Every one of their license texts is in `licenses/third-party/python-build-standalone/`.

### Licenses that need more than keeping a notice

- **HOTPANTS (GPL-2.0).** The installers distribute HOTPANTS as binaries.
  - The complete corresponding source travels with them in `licenses/sources/hotpants/`: the unmodified upstream source plus the exact build scripts.
  - The Docker image has it in `/usr/share/doc/hotpants/source/`, and the repository in `vendor/hotpants/`.
  - AstroviaBin only runs HOTPANTS as a separate program, so AstroviaBin's own code is not a derivative of it.
- **SEP (LGPL-3.0-or-later).** It is distributed unmodified as a separate, replaceable Python extension.
  - Its license texts are in `licenses/third-party/sep/` and `licenses/third-party/gnu/` (LGPL-3.0 and GPL-3.0). The wheel itself ships none.
  - Its exact source release is in `licenses/sources/sep-<version>.tar.gz`, or `/usr/share/doc/astroviabin/sources/` in Docker.
- **libvips in sharp (LGPL).** sharp, which makes the thumbnails, loads a prebuilt libvips shared library: `@img/sharp-libvips-*` 1.3.4 on Linux, the libvips DLLs of `@img/sharp-win32-x64` on Windows.
  - That library is LGPL-3.0-or-later as distributed, and libvips itself is LGPL-2.1-or-later. Their texts are in `licenses/third-party/javascript/` and `licenses/third-party/gnu/`.
  - It is dynamically linked and can be replaced.
  - **Source:** the corresponding source is published by the upstream projects at <https://github.com/lovell/sharp-libvips> (release v1.3.4, with build scripts naming every bundled library) and <https://github.com/libvips/libvips>.
  - **Written offer:** for at least three years after each AstroviaBin release, the AstroviaBin maintainers will provide the complete corresponding source of these LGPL components on request, through the project's GitHub issues, at no more than the cost of providing it.
- **Astrometry.net and its index files (GPL-2.0 or later, with BSD parts).**
  - **Not redistributed by the installers.** The `.deb` declares Debian's `astrometry.net` package as a dependency. The narrow-field 4200-series index files are downloaded by each user's computer from `data.astrometry.net`, together with their license (`LICENSE-4200.txt`, GPL-2.0). The Windows installer does not include a solver.
  - **Docker image:** it installs the Debian packages `astrometry.net` and `astrometry-data-2mass-*`, whose source is available from the Debian archive and whose `copyright` files are in the image.
- **numpy and scipy runtime libraries.** The wheels include OpenBLAS (BSD) and libgfortran/libquadmath (GPL-3.0 with the GCC Runtime Library Exception). That exception allows distribution with no source obligation; the notices are inside each wheel.

## 3. Software AstroviaBin may not redistribute

**pPXF and capfit** (Michele Cappellari) carry this license:

> This software is provided as is with no warranty. You may use it for non-commercial purposes and modify it for personal or internal use, as long as you include this copyright and disclaimer in all copies. You may not redistribute the code.

- **How AstroviaBin complies.** AstroviaBin does **not** include pPXF or capfit in its repository, installers, Docker image or release assets. During installation each user's own computer downloads the official, version-pinned wheels from PyPI and verifies their SHA-256 checksums (`tools/scripts/install_ppxf.py`). They go into `resources/optional-ppxf/` (`.deb` and Windows), the app data folder (MSIX) or `/app/third-party/ppxf` (Docker), and uninstalling AstroviaBin removes them.
- **What you must do:**
  - Use the spectral classification only for **non-commercial** purposes.
  - Do not copy an installed AstroviaBin folder that contains `optional-ppxf` to anyone else.
  - Cite pPXF in publications: Cappellari & Emsellem 2004, PASP 116, 138; Cappellari 2017, MNRAS 466, 798; Cappellari 2023, MNRAS 526, 3273.
  - Downloading pPXF through AstroviaBin does not change its terms.

## 4. Data bundled with AstroviaBin

| Data | Source and license | What you must do |
|---|---|---|
| Star catalogue for annotations | HYG database v4 (David Nash), **CC BY-SA 4.0**; Tycho-2 (Høg et al. 2000, A&A 355, L27, via CDS); HD positions from the Astrometry.net `hd.fits` | Keep the attribution. The derived files (`sky/stars.json.gz`, `tycho.*`) are shared under **CC BY-SA 4.0**: if you redistribute them, keep this attribution and the same license |
| Deep-sky objects | OpenNGC (Mattia Verga), **CC BY-SA 4.0** (`licenses/third-party/OpenNGC-CC-BY-SA-4.0.txt`) | Same as above for `sky/dso.json.gz`; downloaded updates are also CC BY-SA 4.0 |
| Constellation figures and names | d3-celestial (Olaf Frohn), BSD-3-Clause | Keep the license text (`sky/LICENSES/`) |
| Stellar templates (`tools/data/spectral-library.fits`) | Pickles (1998) atlas from the STScI Reference Atlases (DOI 10.17909/t9-khb7-4049), resampled | Cite Pickles 1998, PASP 110, 863 and the STScI DOI |
| Earth orientation data (astropy-iers-data) | IERS data distributed by Astropy, BSD-3-Clause | None beyond the notice |
| Interface fonts (Orbitron, Rajdhani, Share Tech Mono) | **SIL Open Font License 1.1** | Keep the license files (`dist/public/fonts/`); the fonts may not be sold on their own |
| SDSS test spectra (repository only, `tools/test-data/sdss/`) | SDSS public data | Acknowledge SDSS (see section 6) |

## 5. Online services

AstroviaBin sends only sky coordinates and search parameters to these services, never images or FITS files, and only when online features are enabled. Each service has its own conditions; respect their fair-use limits.

| Service | Used for | Terms and credit |
|---|---|---|
| CDS SIMBAD, VizieR and Sesame (Strasbourg) | Object names, catalogue cross-matches, name resolution | CDS conditions of use; acknowledge SIMBAD and VizieR when publishing |
| ESA Gaia DR3 (through VizieR) | Star positions, proper motions and calibration | Gaia data © ESA, **CC BY-SA 3.0 IGO**; the Gaia acknowledgement is required |
| AAVSO VSX | Known variable stars | Acknowledge VSX (Watson, Henden & Price 2006) |
| IMCCE SkyBoT | Known asteroids and comets | Cite Berthier et al. 2006 |
| SDSS (SkyServer, SAS, through Astroquery) | Spectra and spectroscopic comparison | SDSS data policy; the SDSS acknowledgement is required |
| STScI Pan-STARRS1 image cutouts | HOTPANTS reference images | The PS1 acknowledgement is required |
| NASA SkyView (DSS1/DSS2, SDSS, 2MASS images) | HOTPANTS reference images | The SkyView acknowledgement plus the survey's own (DSS, SDSS, 2MASS) |
| DESI Legacy Imaging Surveys | HOTPANTS reference images | The Legacy Surveys acknowledgement is required |
| PyPI (`files.pythonhosted.org`) | Downloading pPXF and capfit at installation | See section 3 |
| `data.astrometry.net` | Downloading narrow-field index files | GPL-2.0 (`LICENSE-4200.txt`) |
| GitHub (OpenNGC) | Catalogue updates | CC BY-SA 4.0 |

## 6. Publishing results obtained with AstroviaBin

The HOTPANTS and spectroscopy PDF reports end with a **"Data credits and acknowledgements"** page listing exactly what was used for that report. The texts are in `tools/scripts/credits.py`.

When you publish anything derived from a report (a paper, a Zenodo record, an AAVSO submission, a web page):
1. **Reproduce the acknowledgements and citations from that page.** They are required by Gaia (CC BY-SA 3.0 IGO), SDSS, Pan-STARRS1, the Legacy Surveys, DSS, 2MASS, SkyView, CDS and AAVSO, and requested by the software authors (Astropy, Photutils, HOTPANTS, pPXF and others).
2. **Share-alike data.** If you republish Gaia-derived tables (CC BY-SA 3.0 IGO) or the HYG/OpenNGC-derived catalogues (CC BY-SA 4.0), publish them under a compatible share-alike license with attribution.
3. **Your own observations.** Follow the data policy of the observatory or service that took them (for example a remote-telescope provider's terms or written permission) and credit it as it requires. AstroviaBin does not change those rights.
4. **Spectral types from pPXF.** These come from software free for non-commercial use only (section 3). Present them as template matches with their quoted uncertainties, as the reports do.
5. **Say what AstroviaBin is.** It is open-source software built on the libraries above, not a validated pipeline of any survey. Describe results as preliminary unless they have been independently confirmed, as the reports also state.

## 7. Desktop runtime and web interface

| Component | License | Where the notice is |
|---|---|---|
| Electron 43 | MIT | `LICENSE.electron.txt` |
| Chromium | BSD-3-Clause and many components | `LICENSES.chromium.html` |
| Node.js runtime | MIT, with third-party notices | `resources/runtime/LICENSE` |
| JavaScript packages (server and web client) | Mostly MIT, ISC, Apache-2.0, BSD, 0BSD and Unlicense; OFL-1.1 for fonts; LGPL for libvips (section 2) | `javascript-packages.md`, `javascript-licenses.txt`; texts missing from some packages (drizzle-orm, embla-carousel, sharp-libvips, libvips) in `licenses/third-party/javascript/` |
| **react-leaflet and @react-leaflet/core** (the map) | **Hippocratic License 2.1** | `javascript-licenses.txt` |

The Hippocratic License is not an OSI-approved open-source license. It allows use, modification and redistribution, but it obliges every licensee not to use the software to violate the human-rights standards it lists, and to keep its notice. AstroviaBin's use, a private astronomy library, complies. Anyone redistributing AstroviaBin passes those conditions on with the map component.

The MSIX packaging tools (MSIX Packaging SDK, MIT; osslsigncode, GPL-3.0) are used only to build and are not shipped.

## 8. If you redistribute AstroviaBin

- **Keep the license material:**
  - `LICENSE`;
  - this document;
  - the whole `licenses/` folder, including `licenses/sources/` with the HOTPANTS and SEP source;
  - the sky-data `LICENSES/` folder;
  - the Electron and Node notices.
- **Do not include pPXF or capfit** (`optional-ppxf`). Let each installation download them.
- **If you modify HOTPANTS,** distribute your modified source under the GPL-2.0.
- **Keep the CC BY-SA 4.0 attribution** of the bundled sky catalogues, and their share-alike license.
- **Pass on the Hippocratic License 2.1 conditions** of the map component.

## 9. Trademarks and endorsement

Names of projects, missions, observatories and services (Astropy, Gaia, ESA, SDSS, Pan-STARRS, NASA, CDS, AAVSO, Slooh and others) are used only to give credit and describe compatibility. They belong to their owners, and their use does not imply any endorsement of AstroviaBin.

## 10. Keeping this document correct

- `desktop/scripts/stage.mjs` regenerates the Python and JavaScript inventories from the exact packages being shipped, at every installer build.
- When a dependency is added, also do these by hand:
  - add it to this document and to Admin → About;
  - check whether its wheel ships its license text, and if not, add it to `licenses/third-party/`;
  - for copyleft licenses, make sure the source travels with the binaries.
