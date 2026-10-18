# Vendored HOTPANTS

This directory is an unmodified copy of the source tree from
<https://github.com/acbecker/hotpants>, commit
`63e126081509a52e96260acdcf2f77b31096c173`.

HOTPANTS (High Order Transform of PSF ANd Template Subtraction) is by
Andrew Becker and contributors. The upstream distribution contains both
`LICENSE` (an MIT license notice) and `COPYING` (GNU GPL version 2). Both
documents and the upstream source are preserved here. The Docker build
compiles the upstream programs without changing their C source. Sidereal
uses the upstream `extractkernOnes.c` variant for PSF kernel visualizations,
as its result was numerically finite on the local integration sample.

Sidereal's FITS preparation, local WCS registration, reporting, and GUI
are separate code in `tools/scripts/hotpants_pipeline.py`,
`apps/server/src/services/hotpants.ts`, and the client components.
The output of image subtraction is not proof of a new astronomical object.
