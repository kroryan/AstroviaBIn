#!/usr/bin/env python3
"""Prepare inputs and validate outputs for unmodified upstream HOTPANTS helpers."""

import sys
from pathlib import Path

import numpy as np
from astropy.io import fits


def lattice(source, output):
    with fits.open(source, memmap=True) as hdus:
        height, width = hdus[0].data.shape
        spacing = int(hdus[-1].header.get('FWKERN', 0))
    if not 1 <= spacing <= 255:
        raise ValueError('No usable HOTPANTS kernel width was saved')
    impulses = np.zeros((height, width), dtype=np.float32)
    impulses[spacing // 2::spacing, spacing // 2::spacing] = 1
    fits.writeto(output, impulses, overwrite=True)


def validate(source):
    total = finite = nonzero = 0
    with fits.open(source, memmap=True) as hdus:
        data = hdus[0].data
        if data is None or data.ndim != 2:
            raise ValueError('Expected a 2D FITS kernel image')
        for start in range(0, data.shape[0], 256):
            block = data[start:start + 256]
            good = np.isfinite(block)
            total += block.size
            finite += np.count_nonzero(good)
            nonzero += np.count_nonzero(block[good])
    if total == 0 or finite != total or nonzero == 0:
        raise ValueError('Extractor produced a blank or non-finite FITS; output rejected')


if __name__ == '__main__':
    try:
        mode = sys.argv[1]
        if mode == 'lattice':
            lattice(Path(sys.argv[2]), Path(sys.argv[3]))
        elif mode == 'validate':
            validate(Path(sys.argv[2]))
        else:
            raise ValueError('Unsupported HOTPANTS auxiliary action')
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
