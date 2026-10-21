import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function AboutSection() {
  return <Card className="mb-6">
    <CardHeader>
      <CardTitle>About AstroviaBin & third-party notices</CardTitle>
      <CardDescription>Software provenance, scientific limitations, and license documents.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4 text-sm">
      <div>
        <h3 className="font-semibold">AstroviaBin</h3>
        <p className="text-muted-foreground">Local-first astronomy image vault and FITS analysis. AstroviaBin is distributed under the MIT license; the application source and full license are available in the project repository.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="/api/licenses/astroviabin" target="_blank" rel="noreferrer">AstroviaBin MIT license</a>
          <a className="text-primary underline" href="https://github.com/kroryan/AstroviaBIn" target="_blank" rel="noreferrer">Source code</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Based on Sidereal</h3>
        <p className="text-muted-foreground">AstroviaBin is a fork of Sidereal, the self-hosted astrophotography gallery by its original authors, released under the MIT license. Their copyright notice is retained in the license file.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://github.com/sidereal-io/sidereal" target="_blank" rel="noreferrer">Original Sidereal project</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Photutils</h3>
        <p className="text-muted-foreground">AstroviaBin uses the independent Photutils project for local point-source shape checks and second-exposure follow-up. Photutils is distributed under the BSD 3-Clause license. Its checks reduce false positives but do not confirm an astrophysical discovery.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://photutils.readthedocs.io/en/stable/development/license.html" target="_blank" rel="noreferrer">Photutils license</a>
          <a className="text-primary underline" href="https://github.com/astropy/photutils" target="_blank" rel="noreferrer">Photutils source and documentation</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">astroscrappy</h3>
        <p className="text-muted-foreground">Cosmic-ray and hot-pixel rejection for single exposures before HOTPANTS uses astroscrappy by Curtis McCully and contributors, an implementation of the L.A.Cosmic algorithm (van Dokkum 2001, PASP 113, 1420). astroscrappy is distributed under the BSD 3-Clause license.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://github.com/astropy/astroscrappy/blob/main/LICENSE.rst" target="_blank" rel="noreferrer">astroscrappy license</a>
          <a className="text-primary underline" href="https://github.com/astropy/astroscrappy" target="_blank" rel="noreferrer">astroscrappy source and documentation</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">HOTPANTS</h3>
        <p className="text-muted-foreground">High Order Transform of PSF ANd Template Subtraction by Andrew Becker and contributors. AstroviaBin vendors and builds the upstream C source without scientific or mathematical changes, including the alternative extractkernOnes helper for PSF visualization. The upstream repository contains both an MIT LICENSE notice and a GPL version 2 COPYING document; both are retained and offered here verbatim. Review the upstream notices for redistribution obligations.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="/api/licenses/hotpants/LICENSE" target="_blank" rel="noreferrer">HOTPANTS LICENSE</a>
          <a className="text-primary underline" href="/api/licenses/hotpants/COPYING" target="_blank" rel="noreferrer">HOTPANTS COPYING (GPL v2)</a>
          <a className="text-primary underline" href="https://github.com/acbecker/hotpants" target="_blank" rel="noreferrer">Upstream source and documentation</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Astrometry.net</h3>
        <p className="text-muted-foreground">Plate solving runs on this server with the Astrometry.net solve-field program (Dustin Lang, David W. Hogg and contributors), installed from Debian. The software is BSD 3-Clause licensed, with some components under GPL v2+/v3+ and Zlib as listed in its copyright file. No image or FITS is sent to nova.astrometry.net.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="/api/licenses/astrometry/software" target="_blank" rel="noreferrer">Astrometry.net copyright and licenses</a>
          <a className="text-primary underline" href="https://astrometry.net/" target="_blank" rel="noreferrer">Astrometry.net</a>
          <a className="text-primary underline" href="https://github.com/dstndstn/astrometry.net" target="_blank" rel="noreferrer">Source code</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Astrometry.net index files (2MASS)</h3>
        <p className="text-muted-foreground">Star-pattern index files 4208–4219 ship with the image (Debian astrometry-data-2mass-08-19). Optional narrow-field files 4203–4207 are downloaded from data.astrometry.net into the AppData folder by <code>download-astrometry-indexes</code>. The index files are distributed under the GNU GPL v2 or later. They are built from the Two Micron All Sky Survey, whose catalog products are in the public domain: this product makes use of data products from the Two Micron All Sky Survey, which is a joint project of the University of Massachusetts and the Infrared Processing and Analysis Center/California Institute of Technology, funded by the National Aeronautics and Space Administration and the National Science Foundation.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="/api/licenses/astrometry/index-2mass" target="_blank" rel="noreferrer">Bundled index copyright (GPL v2+, 2MASS public domain)</a>
          <a className="text-primary underline" href="/api/licenses/astrometry/index-4200" target="_blank" rel="noreferrer">Downloaded 4200-series index license</a>
          <a className="text-primary underline" href="https://data.astrometry.net/4200/" target="_blank" rel="noreferrer">data.astrometry.net/4200</a>
          <a className="text-primary underline" href="https://irsa.ipac.caltech.edu/Missions/2mass.html" target="_blank" rel="noreferrer">2MASS at IRSA</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Star and sky annotation data</h3>
        <p className="text-muted-foreground">Image annotations are drawn offline from a bundle built when the server image is made. Named stars, Bayer/Flamsteed designations, HD and HIP numbers and proper motions come from the HYG database (David Nash / astronexus, CC BY-SA 4.0). Fainter stars come from the Tycho-2 Catalogue (Høg et al. 2000, A&amp;A 355, L27; ESA Hipparcos mission, distributed by CDS as I/259). Henry Draper star positions come from Astrometry.net's hd.fits (HD Catalogue and Extension with Tycho-2 cross-identifications), the file nova.astrometry.net uses for HD labels. Constellation figures and names come from d3-celestial by Olaf Frohn (BSD 3-Clause). The derived bundle is shared under CC BY-SA 4.0 where its sources require it. This publication makes use of data products from the Two Micron All Sky Survey (see the index-file notice above).</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="/api/licenses/sky/sources" target="_blank" rel="noreferrer">Sky data sources</a>
          <a className="text-primary underline" href="/api/licenses/sky/hyg" target="_blank" rel="noreferrer">HYG license (CC BY-SA 4.0)</a>
          <a className="text-primary underline" href="/api/licenses/sky/tycho2" target="_blank" rel="noreferrer">Tycho-2 catalogue description</a>
          <a className="text-primary underline" href="/api/licenses/sky/d3-celestial" target="_blank" rel="noreferrer">d3-celestial license (BSD 3-Clause)</a>
          <a className="text-primary underline" href="https://github.com/astronexus/HYG-Database" target="_blank" rel="noreferrer">HYG database</a>
          <a className="text-primary underline" href="https://cdsarc.cds.unistra.fr/viz-bin/cat/I/259" target="_blank" rel="noreferrer">Tycho-2 at CDS</a>
          <a className="text-primary underline" href="https://github.com/ofrohn/d3-celestial" target="_blank" rel="noreferrer">d3-celestial</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Online catalogues (Gaia DR3, SIMBAD, VizieR)</h3>
        <p className="text-muted-foreground">When the server is online, annotations add deeper stars from Gaia DR3 and named objects from SIMBAD. Only the field centre and radius are sent; images never leave the server. Results are cached per image on local disk (AppData/online-catalog-cache) and reused. Disable with ASTROVIABIN_ONLINE_CATALOGS=false. This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), processed by the Gaia Data Processing and Analysis Consortium (DPAC); Gaia data are © ESA, licensed CC BY-SA 3.0 IGO. This research has made use of the SIMBAD database and the VizieR catalogue access tool, operated at CDS, Strasbourg Astronomical Observatory, France.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://www.cosmos.esa.int/web/gaia/dr3" target="_blank" rel="noreferrer">Gaia DR3</a>
          <a className="text-primary underline" href="https://www.cosmos.esa.int/web/gaia-users/license" target="_blank" rel="noreferrer">Gaia data licence</a>
          <a className="text-primary underline" href="https://simbad.cds.unistra.fr/" target="_blank" rel="noreferrer">SIMBAD</a>
          <a className="text-primary underline" href="https://vizier.cds.unistra.fr/" target="_blank" rel="noreferrer">VizieR</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Candidate verification (Gaia DR3, AAVSO VSX, SIMBAD)</h3>
        <p className="text-muted-foreground">HOTPANTS candidate reports tie each position to nearby Gaia DR3 stars, calibrate magnitudes against Gaia, and check the AAVSO International Variable Star Index (VSX) and SIMBAD through VizieR/CDS. Only candidate coordinates are sent. This research made use of the International Variable Star Index (VSX) database, operated at AAVSO, Cambridge, Massachusetts, USA (Watson, Henden &amp; Price 2006). Report links open external services (Aladin Lite, DESI Legacy Surveys viewer, the IAU Transient Name Server, ESASky); their contents belong to their operators.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://www.aavso.org/vsx/" target="_blank" rel="noreferrer">AAVSO VSX</a>
          <a className="text-primary underline" href="https://www.aavso.org/terms-of-use" target="_blank" rel="noreferrer">AAVSO terms of use</a>
          <a className="text-primary underline" href="https://www.wis-tns.org/" target="_blank" rel="noreferrer">Transient Name Server</a>
          <a className="text-primary underline" href="https://aladin.cds.unistra.fr/AladinLite/" target="_blank" rel="noreferrer">Aladin Lite</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">OpenNGC catalog</h3>
        <p className="text-muted-foreground">Target identification and deep-sky annotations (outlines with catalogue size and position angle) use OpenNGC by Mattia Verga, licensed under CC BY-SA 4.0. Every annotation is projected through each image's own WCS solution (TAN with SIP distortion); outlines are only as accurate as the catalogue's sizes.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://github.com/mattiaverga/OpenNGC" target="_blank" rel="noreferrer">OpenNGC source</a>
          <a className="text-primary underline" href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Astropy, CCDProc, NumPy and SciPy</h3>
        <p className="text-muted-foreground">FITS stacking and CCD reduction use Astropy CCDData/FITS/WCS and CCDProc for overscan and trim, bias/dark/flat correction, bad-pixel masks, gain and uncertainty propagation, L.A.Cosmic cleaning, WCS reprojection, normalization, weighting and image combination. CCDProc and Astropy are BSD 3-Clause licensed. The pipeline calls their public APIs without modifying either project. NumPy and SciPy are also BSD licensed. Verification stamps and PDF reports use Matplotlib (PSF-based license) and Pillow (MIT-CMU).</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://www.astropy.org/" target="_blank" rel="noreferrer">Astropy</a>
          <a className="text-primary underline" href="https://github.com/astropy/ccdproc" target="_blank" rel="noreferrer">CCDProc source</a>
          <a className="text-primary underline" href="https://ccdproc.readthedocs.io/en/latest/license.html" target="_blank" rel="noreferrer">CCDProc BSD license</a>
          <a className="text-primary underline" href="https://numpy.org/" target="_blank" rel="noreferrer">NumPy</a>
          <a className="text-primary underline" href="https://scipy.org/" target="_blank" rel="noreferrer">SciPy</a>
          <a className="text-primary underline" href="https://matplotlib.org/stable/project/license.html" target="_blank" rel="noreferrer">Matplotlib license</a>
          <a className="text-primary underline" href="https://github.com/python-pillow/Pillow/blob/main/LICENSE" target="_blank" rel="noreferrer">Pillow license</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Spectroscopy: Specutils, Specreduce, Astroquery, pPXF, Pickles and SDSS</h3>
        <p className="text-muted-foreground">Stellar spectroscopy uses Specutils (continuum, line centroids, equivalent widths, FWHM) and Specreduce (trace, background and box extraction of slitless first orders and 2-D strips), both Astropy projects under the BSD 3-Clause license. Zero orders are found with Photutils and frames are calibrated with CCDProc. Spectral types come from template fitting with pPXF and capfit by Michele Cappellari (Cappellari 2023, MNRAS 526, 3273) against the Pickles (1998, PASP 110, 863) stellar library distributed by STScI. pPXF and capfit are free for non-commercial use only and may not be redistributed: AstroviaBin does not bundle them; its installers download the official, version-pinned and checksum-verified packages from PyPI during installation (this needs Internet access) into the application folder, and uninstalling AstroviaBin removes them. Downloading them does not change their license terms. The optional known-spectroscopy check queries SIMBAD (CDS), Gaia DR3 (ESA/DPAC) and SDSS through Astroquery (BSD 3-Clause), sending only coordinates; its caches stay inside AstroviaBin's data folder. Validation spectra come from the Sloan Digital Sky Survey (funding for SDSS has been provided by the Alfred P. Sloan Foundation, the participating institutions, NSF and the U.S. Department of Energy). A template fit is a low-resolution match (about ±2 subclasses) and not a definitive classification; slitless wavelengths without a reference lamp and spectra without a spectral WCS are reported as such.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://specutils.readthedocs.io/" target="_blank" rel="noreferrer">Specutils</a>
          <a className="text-primary underline" href="https://specreduce.readthedocs.io/" target="_blank" rel="noreferrer">Specreduce</a>
          <a className="text-primary underline" href="https://astroquery.readthedocs.io/" target="_blank" rel="noreferrer">Astroquery</a>
          <a className="text-primary underline" href="https://pypi.org/project/ppxf/" target="_blank" rel="noreferrer">pPXF (non-commercial license)</a>
          <a className="text-primary underline" href="https://pypi.org/project/capfit/" target="_blank" rel="noreferrer">capfit (non-commercial license)</a>
          <a className="text-primary underline" href="https://www.stsci.edu/hst/instrumentation/reference-data-for-calibration-and-tools/astronomical-catalogs/pickles-atlas" target="_blank" rel="noreferrer">Pickles atlas (STScI)</a>
          <a className="text-primary underline" href="https://www.sdss.org/collaboration/citing-sdss/" target="_blank" rel="noreferrer">Citing SDSS</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">astroalign and SEP</h3>
        <p className="text-muted-foreground">Frames too sparse to plate-solve (a few seconds through a blue filter) are aligned to a solved frame of the same pointing with astroalign by Martin Beroiz and contributors (MIT license; Beroiz, Cabral &amp; Sanchez 2020, Astronomy and Computing 32, 100384), which uses SEP, the Source Extractor library by Kyle Barbary and contributors (LGPL 3.0 or later, with BSD parts; Barbary 2016, JOSS 1, 58), bundled unmodified. The WCS is fitted with Astropy to the matched stars and accepted only for the same pointing (at least 15 stars, residuals under 1 pixel, same scale and rotation).</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://github.com/quatrope/astroalign/blob/master/LICENSE.txt" target="_blank" rel="noreferrer">astroalign license</a>
          <a className="text-primary underline" href="https://github.com/kbarbary/sep" target="_blank" rel="noreferrer">SEP source and licenses</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">hash-wasm</h3>
        <p className="text-muted-foreground">Before an upload, the browser computes SHA-256 checksums with hash-wasm by Dani Biró (MIT license) to skip files already stored on the server. Only checksums and sizes are sent; files that are already stored are not uploaded.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://github.com/Daninet/hash-wasm/blob/master/LICENSE" target="_blank" rel="noreferrer">hash-wasm license</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Desktop app and installers</h3>
        <p className="text-muted-foreground">The AstroviaBin desktop app (system tray and setup window) is built with Electron (MIT) and packaged with electron-builder (MIT). The installers bundle the Node.js runtime (MIT, with the third-party notices in its LICENSE), better-sqlite3 (MIT) with SQLite (public domain) and sharp/libvips (Apache 2.0 / LGPL 3.0). Both installers bundle CPython (PSF License) with NumPy, SciPy, Astropy, Matplotlib, CCDProc, Photutils, reproject, scikit-image, astroscrappy, Specutils, Specreduce and Astroquery (BSD-style licenses; pPXF and capfit are downloaded during installation, not bundled): the Linux package uses the python-build-standalone distribution by Astral (BSD 3-Clause, with the third-party licenses it lists) and Windows the official embeddable CPython. HOTPANTS is built against NASA HEASARC CFITSIO (a permissive NASA/GSFC license). The MSIX package is built with Microsoft's open-source MSIX Packaging SDK (MIT) and signed with osslsigncode (GPL 3.0); neither tool is shipped in the package.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://github.com/electron/electron/blob/main/LICENSE" target="_blank" rel="noreferrer">Electron license</a>
          <a className="text-primary underline" href="https://github.com/nodejs/node/blob/main/LICENSE" target="_blank" rel="noreferrer">Node.js license</a>
          <a className="text-primary underline" href="https://docs.python.org/3/license.html" target="_blank" rel="noreferrer">Python license</a>
          <a className="text-primary underline" href="https://github.com/astral-sh/python-build-standalone/blob/main/LICENSE" target="_blank" rel="noreferrer">python-build-standalone license</a>
          <a className="text-primary underline" href="https://heasarc.gsfc.nasa.gov/docs/software/fitsio/c/f_user/node9.html" target="_blank" rel="noreferrer">CFITSIO license</a>
          <a className="text-primary underline" href="https://github.com/microsoft/msix-packaging/blob/master/LICENSE" target="_blank" rel="noreferrer">MSIX Packaging SDK license</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Fonts</h3>
        <p className="text-muted-foreground">The interface bundles Orbitron (The Orbitron Project Authors), Rajdhani (Indian Type Foundry) and Share Tech Mono (Carrois Type Design, Ralph du Carrois) via Fontsource, all licensed under the SIL Open Font License 1.1. They are served from this server; no font is loaded from a third party.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="/fonts/LICENSE-orbitron.txt" target="_blank" rel="noreferrer">Orbitron license</a>
          <a className="text-primary underline" href="/fonts/LICENSE-rajdhani.txt" target="_blank" rel="noreferrer">Rajdhani license</a>
          <a className="text-primary underline" href="/fonts/LICENSE-share-tech-mono.txt" target="_blank" rel="noreferrer">Share Tech Mono license</a>
          <a className="text-primary underline" href="https://openfontlicense.org/" target="_blank" rel="noreferrer">SIL OFL 1.1</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">IMCCE SkyBoT</h3>
        <p className="text-muted-foreground">HOTPANTS reports check the field for known asteroids and comets with the SkyBoT service of IMCCE, Observatoire de Paris (Berthier et al. 2006, ASP Conf. Ser. 351, 367). Only the field centre, radius, observation time and observatory code are sent.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://ssp.imcce.fr/webservices/skybot/" target="_blank" rel="noreferrer">SkyBoT</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Reference surveys</h3>
        <p className="text-muted-foreground">Automatic HOTPANTS references can use DSS1/DSS2, SDSS and 2MASS through NASA SkyView, Pan-STARRS1 DR2 g/r/i/z/y stacks through STScI/MAST, and DESI Legacy Imaging Surveys DR10 g/r/i/z cutouts through the Legacy Surveys viewer. This work can use data from the Pan-STARRS1 Surveys, the Sloan Digital Sky Survey, the Two Micron All Sky Survey and the DESI Legacy Imaging Surveys; follow each provider's acknowledgement requirements when publishing results. Only sky coordinates and cutout parameters are sent; your image, FITS, and thumbnails stay local. Pan-STARRS stack coverage is primarily north of Dec −30° and cutouts are limited to about 25 arcminutes. Survey imagery retains its provider's rights and citation requirements. Analysis results are candidates, not verified discoveries.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://skyview.gsfc.nasa.gov/current/docs/credits.html" target="_blank" rel="noreferrer">SkyView credits and survey acknowledgements</a>
          <a className="text-primary underline" href="https://www.legacysurvey.org/acknowledgment/" target="_blank" rel="noreferrer">Legacy Surveys acknowledgement</a>
          <a className="text-primary underline" href="https://panstarrs.stsci.edu/" target="_blank" rel="noreferrer">Pan-STARRS1 at MAST</a>
          <a className="text-primary underline" href="https://outerspace.stsci.edu/pages/viewpage.action?pageId=392364125" target="_blank" rel="noreferrer">Pan-STARRS image cutout documentation</a>
        </div>
      </div>
    </CardContent>
  </Card>;
}
