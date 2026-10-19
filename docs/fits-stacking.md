# FITS stacking

AstroviaBin stacks same-channel FITS frames onto the first selected frame's
pixel grid (the reference, marked ★ in the UI).

## Registration

Each frame gets a geometric mapping from reference pixels to its own pixels:

1. **Base mapping.** When the reference and the frame both have a plate
   solution (the FITS header WCS, or the latest stored local solve when the
   header has none), the mapping goes through both full WCS solutions — TAN
   projection plus SIP distortion — so rotation, scale and optical distortion
   are all handled. Without a plate solution, a zero-mean normalized
   cross-correlation translation is the starting point (frames must then have
   the reference's size).
2. **Star refinement.** Up to 400 isolated, unsaturated stars are detected in
   the reference and in the frame (cosmic rays and saturated cores are skipped),
   matched through the base mapping, and a sigma-clipped 2D polynomial (order
   1–3, depending on the number of matches) absorbs what the base mapping
   misses: a frame-to-frame rotation for translation bases, or each plate
   solution's residual error.
3. **Verification.** The matched-star residual RMS is reported per frame. A frame
   with enough stars that still does not line up (residual above 1 px, or too few
   matches) is left out with the reason instead of blurring the stack. Frames
   with too few stars to verify (e.g. planetary frames) use the base mapping and
   a warning.

Frames are resampled once with Catmull-Rom bicubic interpolation; flux is scaled
by the pixel-area ratio when plate scales differ (not for surface-brightness
units). Exact duplicate frames (identical pixels) are skipped.

On the 1620 Geographos test set (six 2400×2400 exposures, 0.1° rotation and up
to 110 px of drift between frames) the residual per frame is 0.16–0.21 px, the
stack agrees with the reference frame to 0.08 px, and stars are sharper than
with the former integer translation (FWHM 3.70 px vs 3.98 px).

## Combination

Mean, median, and iterative robust median/MAD sigma-clipped mean (default).
Non-finite samples are ignored; pixels with no coverage are written as NaN
rather than fabricated zero-valued data. Filters and `BUNIT` must agree. If every
frame has a valid `EXPTIME`, pixel values are scaled to the reference exposure
before combination; data already expressed as a rate (for example, ADU/s) are
not exposure-scaled.

## Output

Floating-point FITS on the reference grid, with the reference's celestial WCS
(including distortion terms) and detector/observatory metadata, `NCOMBINE`, and
`HISTORY` cards recording the method and, per frame, the registration method,
matched stars, residual and offset. Stacking runs in a worker thread and never
alters source images.
