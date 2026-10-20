#!/usr/bin/env python3
"""Rewrite a FITS whose image is not in the primary HDU as a standard single-HDU FITS.

Observatories (e.g. Slooh "_cal.fit", fpack ".fz") deliver frames with an empty primary HDU and
the image in an IMAGE extension or a tile-compressed (RICE/GZIP/HCOMPRESS) BINTABLE. The image is
decompressed and written as the primary HDU; observation keywords from the primary header and the
image extension are merged (the extension wins), structural/compression keywords are dropped.

Usage: fits_normalize.py <input> <output>
A 1-D spectrum (no image) becomes a 1 x N image plus a SPECTRUM table (see spectroscopy.to_image).
Prints a JSON summary; exits 2 when the file contains neither an image nor a 1-D spectrum.
"""

import json
import sys
import warnings
from pathlib import Path

import numpy as np
from astropy.io import fits

STRUCTURAL = {'SIMPLE', 'XTENSION', 'BITPIX', 'EXTEND', 'PCOUNT', 'GCOUNT', 'TFIELDS', 'THEAP',
              'CHECKSUM', 'DATASUM', 'EXTNAME', 'EXTVER', 'EXTLEVEL', 'INHERIT', 'BSCALE', 'BZERO', 'BLANK', 'END'}
STRUCTURAL_PREFIXES = ('NAXIS', 'TTYPE', 'TFORM', 'TUNIT', 'TDIM', 'TSCAL', 'TZERO', 'TNULL', 'ZIMAGE', 'ZCMPTYPE',
                       'ZBITPIX', 'ZNAXIS', 'ZTILE', 'ZNAME', 'ZVAL', 'ZQUANTIZ', 'ZDITHER', 'ZSIMPLE', 'ZEXTEND',
                       'ZTENSION', 'ZPCOUNT', 'ZGCOUNT', 'ZHECKSUM', 'ZDATASUM', 'ZBLANK', 'ZSCALE', 'ZZERO')


def keep(card):
    key = card.keyword
    return key and key not in STRUCTURAL and not key.startswith(STRUCTURAL_PREFIXES)


def main(source, destination):
    warnings.simplefilter('ignore')
    with fits.open(source, memmap=False) as hdus:
        index, image = next(((i, hdu) for i, hdu in enumerate(hdus)
                             if hdu.is_image and hdu.data is not None and hdu.data.ndim in (2, 3)), (None, None))
        if image is None:
            # No image: a 1-D spectrum (SDSS spec tables, tabular or 1-D image spectra) is written as a
            # 1 x N image for the gallery with the full spectrum in a SPECTRUM table (spectroscopy.py).
            try:
                sys.path.insert(0, str(Path(__file__).resolve().parent))
                import spectroscopy
                summary = spectroscopy.to_image(source, destination)
                print(json.dumps(summary))
                return 0
            except Exception as error:  # noqa: BLE001 - reported to the uploader
                print(json.dumps({'error': f'The FITS file contains no 2D or 3D image and no readable 1-D spectrum ({error})'}))
                return 2
        header = fits.Header()
        for source_header in ([hdus[0].header] if index else []) + [image.header]:
            for card in source_header.cards:
                if not keep(card):
                    continue
                if card.keyword in ('HISTORY', 'COMMENT'):
                    header.add_history(card.value) if card.keyword == 'HISTORY' else header.add_comment(card.value)
                else:
                    header[card.keyword] = (card.value, card.comment)
        data = image.data
        # Tile-compressed float data comes back as float; keep integers as they are (astropy writes
        # the BZERO/BSCALE needed for unsigned types itself).
        if data.dtype.kind == 'f' and data.dtype.itemsize > 4:
            data = data.astype(np.float32)
        header['HISTORY'] = f'AstroviaBin: image from HDU {index} ({type(image).__name__}) written as the primary HDU'
        fits.PrimaryHDU(data=data, header=header).writeto(destination, overwrite=True, output_verify='silentfix')
        print(json.dumps({'hdu': index, 'type': type(image).__name__, 'shape': list(data.shape), 'dtype': str(data.dtype)}))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
