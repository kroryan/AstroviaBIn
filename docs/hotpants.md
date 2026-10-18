# FITS difference analysis

Open a FITS in Sidereal and select **Analyze FITS** to create a saved run.
Sidereal prepares a science image, obtains or verifies its WCS with the
locally installed Astrometry.net solver, acquires a reference, resamples it
onto the science image, then invokes the unmodified HOTPANTS binary.
The science FITS, uploaded auxiliary files, intermediate FITS, and reports
stay on this server under `FITS_ANALYSIS_DIR`. Automatic reference lookup
requests DSS2 survey data from NASA SkyView using coordinates and field size
only; it does not send image pixels, FITS, or thumbnails. To avoid any
external reference request, choose **Another local FITS**.

The UI exposes survey band, local reference, maximum processing resolution,
and candidate signal/noise threshold. Advanced mode accepts the upstream
HOTPANTS flags, except `-inim`, `-tmplim`, and `-outim`, which Sidereal sets
to its private run files. File-based inputs such as masks, noise arrays,
stamp lists, region files, and PCA kernels must first be uploaded as
auxiliary files for the science FITS. Output filenames are confined to the
run directory. The [upstream README](../vendor/hotpants/README.md) lists
all parameters and their scientific meanings.

Each completed run retains science and aligned reference FITS, the
difference, noise, convolved image, bad-pixel mask, HOTPANTS log, and a JSON
report. The GUI displays aligned previews and pixel/WCS positions of peaks.
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
OpenNGC proximity is not a transient-discovery check: Sidereal does not
currently cross-match a transient registry, perform photometric calibration,
or classify supernovae. Visual inspection and independent confirmation are
required; mismatched epochs, filters, seeing, saturation, and alignment can
produce false positives.

HOTPANTS source, copyright notices, and both upstream license documents are
in [`vendor/hotpants`](../vendor/hotpants/UPSTREAM.md). Sidereal's Settings
page links to the full local license texts. Survey data may require its
provider's attribution; see [SkyView credits](https://skyview.gsfc.nasa.gov/current/docs/credits.html).
