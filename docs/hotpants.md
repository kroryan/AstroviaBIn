# FITS difference analysis

Open a FITS in Sidereal and select **Analyze FITS** to create a saved run.
Sidereal prepares a science image, obtains or verifies its WCS with the
locally installed Astrometry.net solver, acquires a reference, resamples it
onto the science image, then invokes the unmodified HOTPANTS binary. It
normalizes the subtraction to the science-image pixel scale. Photutils
DAOStarFinder then checks whether each raw positive peak is point-like in
the difference **and** science frames, absent as a point source in the
reference, clear of bad-pixel masks, and not part of a positive/negative
registration dipole. These checks reduce false alarms; they cannot prove
that a residual is an astrophysical transient.
The science FITS, uploaded auxiliary files, intermediate FITS, and reports
stay on this server under `FITS_ANALYSIS_DIR`. Automatic reference lookup
requests DSS2 survey data from NASA SkyView using coordinates and field size
only; it does not send image pixels, FITS, or thumbnails. To avoid any
external reference request, choose **Another local FITS**.

The UI exposes survey band, local reference, maximum processing resolution,
model signal/noise threshold, and expected point-source FWHM (in processed
pixels). A poor FWHM setting can miss real sources or admit artifacts.
The threshold is based on HOTPANTS' modeled noise, not calibrated
photometric significance. Advanced mode accepts the upstream
HOTPANTS flags, except `-inim`, `-tmplim`, and `-outim`, which Sidereal sets
to its private run files. File-based inputs such as masks, noise arrays,
stamp lists, region files, and PCA kernels must first be uploaded as
auxiliary files for the science FITS. Output filenames are confined to the
run directory. The [upstream README](../vendor/hotpants/README.md) lists
all parameters and their scientific meanings.

The source-build Docker image installs Photutils 3.1.1 in an isolated Python
environment with Debian's Astropy, NumPy, and SciPy packages. It builds the
bundled HOTPANTS C source and installs local Astrometry.net index files. A
Node-only development setup can display the UI but cannot run end-to-end
FITS analyses without those local scientific dependencies.

Each completed run retains science and aligned reference FITS, the
difference, noise, convolved image, bad-pixel mask, HOTPANTS log, and a JSON
report. The GUI displays aligned previews and pixel/WCS positions of
validated candidates plus counts of rejected raw peaks. Reports made by
the old peak-only detector remain available but their candidate markers
are hidden until the analysis is rerun. **Delete this report** removes only
that run directory and its generated evidence; it never deletes the
original uploaded or mounted FITS. Running analyses cannot be deleted.
The upstream `extractkern` and `maskim` utilities are also integrated:
from a saved run, inspect a candidate's PSF kernel, extract a full kernel
map, reconstruct convolution, or create a masked difference. The generated
FITS layers are attached to that run. Advanced HOTPANTS options include
noise and input masks, region/stamp lists, kernel basis files, convolution
settings, output layers, and the other documented upstream parameters.
For PSF visualization Sidereal invokes the upstream `extractkernOnes`
variant. The full-field map is produced by feeding it a regular impulse
lattice; generated kernel FITS are checked for finite, nonblank pixels
before appearing in a report. HOTPANTS' numerical source is not altered.
The report also lists nearby OpenNGC objects within three arcminutes, when
the local catalog is available. These peaks are **unconfirmed candidates**.
To examine one further, upload or select a second local FITS exposure of
the same field and use **Check in second FITS**. Sidereal locally checks
the saved sky coordinate with Photutils. A repeat detection is reported
only when a point source is found, the FITS filter matches, and the
observation timestamp differs. Missing/different filters or observation
times give an inconclusive result. Even a repeat detection is supporting
evidence, **not a confirmed supernova**; moving objects, cataloged
variables, sensor artifacts, and more epochs must still be checked.
OpenNGC proximity is not a transient-discovery check: Sidereal does not
currently cross-match a transient registry, perform photometric calibration,
or classify supernovae. DSS2 and a modern science FITS can differ greatly
in filter, pixel scale, calibration, seeing, and epoch. For example, a
`zs`-filter science frame compared with DSS2 Red should be treated as
exploratory, not as a credible transient search. Prefer a well-matched
local reference and independent exposures for follow-up.

HOTPANTS source, copyright notices, and both upstream license documents are
in [`vendor/hotpants`](../vendor/hotpants/UPSTREAM.md). Sidereal's Settings
page links to the full local license texts. Photutils is an independent
BSD-3-Clause project; its wheel and license are installed in the Docker
image, and [its license](https://photutils.readthedocs.io/en/stable/development/license.html)
and [source](https://github.com/astropy/photutils) are available upstream.
Survey data may require its
provider's attribution; see [SkyView credits](https://skyview.gsfc.nasa.gov/current/docs/credits.html).
