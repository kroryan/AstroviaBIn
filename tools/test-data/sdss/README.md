# Independent spectroscopy validation data

These five observed spectra are public SDSS Legacy survey `spec` FITS files,
plate 0751, MJD 52251. The `SPECOBJ` extension supplies the independent SDSS
pipeline class, subclass and redshift; AstroviaBin does not use those labels
when fitting the four stars. Fiber 0160 is a quasar negative control.

Source pattern:
`https://dr18.sdss.org/sas/dr18/prior-surveys/sdss2-dr8-sdss/spectro/redux/26/spectra/0751/spec-0751-52251-FIBER.fits`

| Fiber | SDSS class/subclass | SHA-256 |
| --- | --- | --- |
| 0051 | STAR G2 | `8f20e4bd63fcf1dbfbf99bf2dbf48a1e2859d20417bd782925826884b730ea8f` |
| 0158 | STAR A0 | `962901083b09f56ce39012c6b80a6fc37e89b15a0528e339065d354d63cf825c` |
| 0160 | QSO BROADLINE | `9bb725b4cf74cc5b547bdffa11d8cf3bcb4949cdb21b9173163fcb500eb85fb6` |
| 0305 | STAR K5 | `25c55aaa5d184ad0ed8a67019c5aebef4d0a2e89a7dab18860d34f938a0e95e2` |
| 0340 | STAR M3 | `d98c7597a08b1314b1ef985d8b367882b06948017c31f8ceca27ca35475eed43` |

The original files and their data provenance are described by the
[SDSS DR18 data access documentation](https://www.sdss.org/dr18/data_access/get_data/).
These tests check broad classification limits, not precise MK type or radial
velocity agreement. Cite the SDSS DR18 data release when using these data in a
publication.
