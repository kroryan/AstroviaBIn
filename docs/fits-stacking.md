# FITS stacking

AstroviaBin stacks same-sized, same-channel FITS frames onto the first selected
frame's pixel grid. The optional registrar estimates integer-pixel translations
using zero-mean normalized cross-correlation, after anti-aliased block averaging
for large frames. Featureless frames are kept at zero offset instead of being
assigned an arbitrary shift; weak or incompatible structure is rejected. This
is translation-only registration: it does not correct rotation, scale, optical
distortion, or subpixel drift. Use already aligned/plate-solved frames for
precision photometry.

The combiner supports arithmetic mean, median, and iterative robust
median/MAD sigma-clipped mean. Non-finite samples are ignored; pixels with no
coverage are written as NaN rather than fabricated zero-valued data. Filters and
`BUNIT` must agree. If every frame has a valid `EXPTIME`, pixel values are
scaled to the first selected frame's exposure before combination. Data already
expressed as a rate (for example, ADU/s) are not exposure-scaled. When exposure
metadata is missing from all frames, values are combined as supplied; the user
must ensure their calibration and exposure scales are compatible.

The output is floating-point FITS, retains the first frame's celestial WCS and
detector metadata, and records the method and registration offsets in `HISTORY`.
Its output grid remains the first frame's grid, so edge pixels without coverage
are NaN. Stacking does not alter source images.
