#!/usr/bin/env python3
"""Build AstroviaBin's offline sky-annotation bundle.

Inputs (downloaded by the Dockerfile or by hand):
  hyg.csv            HYG star database v4.x (astronexus, CC BY-SA 4.0)
  hd.fits            Henry Draper catalogue kd-tree from data.astrometry.net (HD + 1949
                     extension, Tycho-2 positions where cross-matched; the same file
                     nova.astrometry.net uses to label HD stars)
  NGC.csv, addendum.csv  OpenNGC (Mattia Verga, CC BY-SA 4.0)
  constellations.lines.json, constellations.json  d3-celestial (Olaf Frohn, BSD-3-Clause)
  tyc2.dat.00.gz … tyc2.dat.19.gz  optional Tycho-2 main catalogue (Høg et al. 2000, CDS I/259)

Output (in --out):
  stars.json.gz      columnar star table sorted by declination
  dso.json.gz        deep-sky objects with size and position angle
  constellations.json  stick figures and label positions
  tycho.bin.gz + tycho.json  Tycho-2 stars not in Hipparcos, columnar little-endian arrays
  SOURCES.txt        provenance and licences

Usage: build_sky_catalog.py --src <download dir> --out <output dir>
"""
import argparse
import csv
import gzip
import json
import math
import os
import re

import numpy as np

GREEK = {
    'Alp': 'α', 'Bet': 'β', 'Gam': 'γ', 'Del': 'δ', 'Eps': 'ε', 'Zet': 'ζ', 'Eta': 'η', 'The': 'θ',
    'Iot': 'ι', 'Kap': 'κ', 'Lam': 'λ', 'Mu': 'μ', 'Nu': 'ν', 'Xi': 'ξ', 'Omi': 'ο', 'Pi': 'π',
    'Rho': 'ρ', 'Sig': 'σ', 'Tau': 'τ', 'Ups': 'υ', 'Phi': 'φ', 'Chi': 'χ', 'Psi': 'ψ', 'Ome': 'ω',
}
DSO_TYPES = {'G', 'GPair', 'GTrpl', 'GGroup', 'PN', 'HII', 'EmN', 'Neb', 'RfN', 'SNR', 'OCl', 'GCl', 'Cl+N', '*Ass', 'DrkN'}


def bayer_label(bayer, con):
    if not bayer or not con:
        return ''
    letters = ''.join(ch for ch in bayer if ch.isalpha())
    digits = ''.join(ch for ch in bayer if ch.isdigit() or ch == '-').strip('-')
    greek = GREEK.get(letters)
    if not greek:
        return ''
    return f"{greek}{('¹²³⁴⁵⁶⁷⁸⁹'[int(digits) - 1]) if digits.isdigit() and 0 < int(digits) < 10 else ''} {con}"


def num(value):
    try:
        out = float(value)
        return out if math.isfinite(out) else None
    except (TypeError, ValueError):
        return None


def load_hyg(path):
    stars = {}
    extra = []
    with open(path, newline='') as handle:
        for row in csv.DictReader(handle):
            if row.get('proper') == 'Sol':
                continue
            ra = num(row['ra'])
            dec = num(row['dec'])
            if ra is None or dec is None:
                continue
            hd = int(row['hd']) if row.get('hd') else None
            star = {
                'ra': ra * 15.0, 'dec': dec, 'mag': num(row['mag']),
                'pmra': num(row.get('pmra')) or 0.0, 'pmdec': num(row.get('pmdec')) or 0.0,
                'hd': hd, 'hip': int(row['hip']) if row.get('hip') else None,
                'name': (row.get('proper') or '').strip(),
                'bayer': bayer_label(row.get('bayer'), row.get('con')),
                'flam': f"{row['flam']} {row['con']}" if row.get('flam') and row.get('con') else '',
            }
            if hd:
                stars[hd] = star
            else:
                extra.append(star)
    return stars, extra


def load_hd(path):
    from astropy.io import fits
    with fits.open(path) as hdus:
        bounds = np.frombuffer(hdus[5].data.tobytes(), '<f8')
        low, scale = bounds[0:3], bounds[6]
        data = np.frombuffer(hdus[6].data.tobytes(), '<u4').reshape(-1, 3).astype(np.float64)
        perm = np.frombuffer(hdus[3].data.tobytes(), '<u4').astype(np.int64)
    xyz = low + data / scale
    xyz /= np.linalg.norm(xyz, axis=1)[:, None]
    ra = np.degrees(np.arctan2(xyz[:, 1], xyz[:, 0])) % 360
    dec = np.degrees(np.arcsin(np.clip(xyz[:, 2], -1, 1)))
    # Row order follows the kd-tree; the permutation gives the catalogue row, i.e. HD number - 1.
    return {int(perm[i]) + 1: (float(ra[i]), float(dec[i])) for i in range(len(perm))}


def build_stars(hyg_path, hd_path):
    hyg, extra = load_hyg(hyg_path)
    hd_positions = load_hd(hd_path)
    stars = list(hyg.values()) + extra
    for hd, (ra, dec) in hd_positions.items():
        if hd not in hyg:
            stars.append({'ra': ra, 'dec': dec, 'mag': None, 'pmra': 0.0, 'pmdec': 0.0, 'hd': hd,
                          'hip': None, 'name': '', 'bayer': '', 'flam': ''})
    stars.sort(key=lambda star: star['dec'])
    columns = {key: [star[key] for star in stars] for key in ('ra', 'dec', 'mag', 'pmra', 'pmdec', 'hd', 'hip', 'name', 'bayer', 'flam')}
    columns['ra'] = [round(value, 6) for value in columns['ra']]
    columns['dec'] = [round(value, 6) for value in columns['dec']]
    columns['mag'] = [None if value is None else round(value, 2) for value in columns['mag']]
    columns['pmra'] = [round(value, 2) for value in columns['pmra']]
    columns['pmdec'] = [round(value, 2) for value in columns['pmdec']]
    return {'epoch': 2000.0, 'count': len(stars), **columns}


def sexagesimal(value, hours):
    if not value:
        return None
    sign = -1 if value.strip().startswith('-') else 1
    parts = [float(part) for part in value.strip().lstrip('+-').split(':')]
    degrees = parts[0] + parts[1] / 60 + parts[2] / 3600
    return degrees * 15 if hours else sign * degrees


def build_dso(paths):
    objects = []
    for path in paths:
        with open(path, newline='', encoding='utf-8') as handle:
            for row in csv.DictReader(handle, delimiter=';'):
                kind = row.get('Type') or ''
                if kind not in DSO_TYPES:
                    continue
                ra = sexagesimal(row.get('RA'), True)
                dec = sexagesimal(row.get('Dec'), False)
                if ra is None or dec is None:
                    continue
                raw = row['Name'].strip()
                match = re.match(r'^(NGC|IC)0*(\d+)(.*)$', raw)
                name = f"{match.group(1)} {match.group(2)}{match.group(3)}" if match else raw
                messier = f"M {int(row['M'])}" if row.get('M') else ''
                common = [item.strip() for item in (row.get('Common names') or '').split(',') if item.strip()]
                objects.append({
                    'name': name, 'messier': messier, 'common': common, 'type': kind,
                    'ra': round(ra, 6), 'dec': round(dec, 6),
                    'maj': num(row.get('MajAx')), 'min': num(row.get('MinAx')), 'pa': num(row.get('PosAng')),
                    'mag': num(row.get('V-Mag')) if num(row.get('V-Mag')) is not None else num(row.get('B-Mag')),
                })
    return objects


def build_constellations(lines_path, names_path):
    lines = json.load(open(lines_path))
    names = json.load(open(names_path))
    figures = {feature['id']: feature['geometry']['coordinates'] for feature in lines['features']}
    out = []
    for feature in names['features']:
        props = feature['properties']
        ra, dec = feature['geometry']['coordinates']
        out.append({
            'id': feature['id'], 'name': props.get('name') or props.get('en'), 'genitive': props.get('gen'),
            'label': [ra % 360, dec],
            # d3-celestial stores RA in [-180, 180); keep degrees in [0, 360).
            'lines': [[[point[0] % 360, point[1]] for point in segment] for segment in figures.get(feature['id'], [])],
        })
    return out


def build_tycho(src, out):
    """Columnar binary: f32 ra, f32 dec, i16 mag*1000, i16 pmra, i16 pmdec, u16 tyc1, u16 tyc2, u8 tyc3.

    Hipparcos stars are skipped (HYG already has them with names). Positions are J2000 mean
    positions; stars without a mean solution use the observed Tycho-2 position (epoch ~1991.5).
    """
    import glob
    files = sorted(glob.glob(os.path.join(src, 'tyc2.dat.*.gz')))
    if not files:
        return None
    ra, dec, mag, pmra, pmdec, t1, t2, t3 = [], [], [], [], [], [], [], []
    for name in files:
        with gzip.open(name, 'rt', encoding='ascii') as handle:
            for line in handle:
                if line[142:148].strip():
                    continue  # HIP star
                vt = line[123:129].strip() or line[110:116].strip()
                if not vt:
                    continue
                if line[13] == 'X' or not line[15:27].strip():
                    r, d, pr, pd = float(line[152:164]), float(line[165:177]), 0.0, 0.0
                else:
                    r, d = float(line[15:27]), float(line[28:40])
                    pr = float(line[41:48] or 0) if line[41:48].strip() else 0.0
                    pd = float(line[49:56] or 0) if line[49:56].strip() else 0.0
                ra.append(r); dec.append(d); mag.append(float(vt)); pmra.append(pr); pmdec.append(pd)
                t1.append(int(line[0:4])); t2.append(int(line[5:10])); t3.append(int(line[11]))
    order = np.argsort(np.asarray(dec))
    def col(values, dtype):
        return np.asarray(values)[order].astype(dtype)
    columns = [
        ('ra', col(ra, '<f4')), ('dec', col(dec, '<f4')),
        ('mag', np.clip(np.round(np.asarray(mag)[order] * 1000), -32768, 32767).astype('<i2')),
        ('pmra', np.clip(np.round(np.asarray(pmra)[order]), -32768, 32767).astype('<i2')),
        ('pmdec', np.clip(np.round(np.asarray(pmdec)[order]), -32768, 32767).astype('<i2')),
        ('tyc1', col(t1, '<u2')), ('tyc2', col(t2, '<u2')), ('tyc3', col(t3, 'u1')),
    ]
    layout, offset = {}, 0
    with gzip.open(os.path.join(out, 'tycho.bin.gz'), 'wb', compresslevel=6) as handle:
        for key, array in columns:
            layout[key] = {'offset': offset, 'dtype': str(array.dtype.str)}
            handle.write(array.tobytes())
            offset += array.nbytes
    with open(os.path.join(out, 'tycho.json'), 'w') as handle:
        json.dump({'count': len(order), 'epoch': 2000.0, 'columns': layout}, handle)
    return len(order)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--src', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    stars = build_stars(os.path.join(args.src, 'hyg.csv'), os.path.join(args.src, 'hd.fits'))
    with gzip.open(os.path.join(args.out, 'stars.json.gz'), 'wt', encoding='utf-8') as handle:
        json.dump(stars, handle, ensure_ascii=False, separators=(',', ':'))
    dso = build_dso([os.path.join(args.src, 'NGC.csv'), os.path.join(args.src, 'addendum.csv')])
    with gzip.open(os.path.join(args.out, 'dso.json.gz'), 'wt', encoding='utf-8') as handle:
        json.dump(dso, handle, ensure_ascii=False, separators=(',', ':'))
    constellations = build_constellations(os.path.join(args.src, 'constellations.lines.json'), os.path.join(args.src, 'constellations.json'))
    with open(os.path.join(args.out, 'constellations.json'), 'w', encoding='utf-8') as handle:
        json.dump(constellations, handle, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(args.out, 'SOURCES.txt'), 'w', encoding='utf-8') as handle:
        handle.write(
            'AstroviaBin sky-annotation data\n\n'
            'Stars: HYG database v4 by David Nash (astronexus), CC BY-SA 4.0 — https://github.com/astronexus/HYG-Database\n'
            'HD positions: hd.fits from data.astrometry.net (Henry Draper Catalogue and Extension with Tycho-2\n'
            '  cross-identification positions), as distributed by the Astrometry.net project — https://astrometry.net\n'
            'Deep-sky objects: OpenNGC by Mattia Verga, CC BY-SA 4.0 — https://github.com/mattiaverga/OpenNGC\n'
            'Constellation figures and names: d3-celestial by Olaf Frohn, BSD-3-Clause — https://github.com/ofrohn/d3-celestial\n'
            'Faint stars: Tycho-2 Catalogue (Høg et al. 2000, A&A 355, L27), CDS catalogue I/259 — https://cdsarc.cds.unistra.fr/viz-bin/cat/I/259\n'
            'This bundle is a derived database and is shared under CC BY-SA 4.0 where its sources require it.\n')
    tycho = build_tycho(args.src, args.out)
    print(json.dumps({'stars': stars['count'], 'tycho': tycho, 'dso': len(dso), 'constellations': len(constellations)}))


if __name__ == '__main__':
    main()
