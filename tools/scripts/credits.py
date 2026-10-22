"""Data credits, acknowledgements and citations for AstroviaBin's PDF reports.

The texts are the ones requested by each data provider or software project (see docs/LICENSES.md).
A report lists only what was actually used to produce it. Anyone publishing results based on a
report must reproduce the relevant acknowledgements and citations in the publication.
"""

SKYVIEW = ('NASA SkyView', "This research has made use of NASA's SkyView facility (https://skyview.gsfc.nasa.gov) located at "
           'NASA Goddard Space Flight Center (McGlynn, Scollick & White 1998).')

CREDITS = {
    'gaia': ('Gaia DR3 (ESA), CC BY-SA 3.0 IGO',
             'This work has made use of data from the European Space Agency (ESA) mission Gaia (https://www.cosmos.esa.int/gaia), '
             'processed by the Gaia Data Processing and Analysis Consortium (DPAC, https://www.cosmos.esa.int/web/gaia/dpac/consortium). '
             'Funding for the DPAC has been provided by national institutions, in particular the institutions participating in the Gaia '
             'Multilateral Agreement. Gaia Collaboration, Vallenari et al. 2023, A&A 674, A1. Gaia data are licensed CC BY-SA 3.0 IGO.'),
    'vizier': ('VizieR (CDS)',
               'This research has made use of the VizieR catalogue access tool, CDS, Strasbourg Astronomical Observatory, France '
               '(DOI: 10.26093/cds/vizier); Ochsenbein, Bauer & Marcout 2000, A&AS 143, 23.'),
    'simbad': ('SIMBAD (CDS)', 'This research has made use of the SIMBAD database, operated at CDS, Strasbourg, France '
                               '(Wenger et al. 2000, A&AS 143, 9).'),
    'vsx': ('AAVSO VSX', 'This research has made use of the International Variable Star Index (VSX) database, operated at AAVSO, '
                         'Cambridge, Massachusetts, USA (Watson, Henden & Price 2006, SASS 25, 47).'),
    'skybot': ('IMCCE SkyBoT', 'Known Solar System objects were identified with the SkyBoT service of IMCCE, Paris Observatory '
                               '(Berthier et al. 2006, ASP Conf. Ser. 351, 367).'),
    'openngc': ('OpenNGC, CC BY-SA 4.0', 'Host galaxies from OpenNGC by Mattia Verga (https://github.com/mattiaverga/OpenNGC), '
                                         'licensed CC BY-SA 4.0.'),
    'hotpants': ('HOTPANTS', 'Image subtraction with HOTPANTS (Becker 2015, ASCL 1504.004), an implementation of the Alard & Lupton '
                             '(1998, ApJ 503, 325) method; GNU GPL v2.'),
    'astropy': ('Astropy', 'This research made use of Astropy (http://www.astropy.org), a community-developed core Python package for '
                           'Astronomy (Astropy Collaboration 2013, A&A 558, A33; 2018, AJ 156, 123; 2022, ApJ 935, 167).'),
    'photutils': ('Photutils', 'Source detection, centroids and photometry with Photutils, an Astropy package '
                               '(Bradley et al., DOI: 10.5281/zenodo.596036).'),
    'astroquery': ('Astroquery', 'Catalogue queries with Astroquery (Ginsburg et al. 2019, AJ 157, 98).'),
    'ccdproc': ('CCDProc', 'CCD calibration with CCDProc, an Astropy package (Craig et al., DOI: 10.5281/zenodo.1069648).'),
    'astroscrappy': ('astroscrappy', 'Cosmic rays removed with astroscrappy (McCully et al., DOI: 10.5281/zenodo.1482019), an '
                                     'implementation of L.A.Cosmic (van Dokkum 2001, PASP 113, 1420).'),
    'specutils': ('Specutils and Specreduce', 'Spectral extraction and analysis with Specreduce and Specutils, Astropy packages.'),
    'ppxf': ('pPXF (non-commercial license)', 'Template fitting with pPXF (Cappellari & Emsellem 2004, PASP 116, 138; '
                                             'Cappellari 2017, MNRAS 466, 798; Cappellari 2023, MNRAS 526, 3273). '
                                             'pPXF and capfit may be used for non-commercial purposes only.'),
    'pickles': ('Pickles stellar library', 'Stellar templates from the Pickles (1998, PASP 110, 863) spectral library, as distributed by STScI.'),
    'sdss': ('SDSS', 'Funding for the Sloan Digital Sky Survey has been provided by the Alfred P. Sloan Foundation, the U.S. Department '
                     'of Energy Office of Science, the participating institutions and the National Science Foundation. SDSS web site: '
                     'www.sdss.org (full acknowledgement for the data release used: https://www.sdss.org/collaboration/citing-sdss/).'),
    'dss': ('Digitized Sky Survey', 'The Digitized Sky Surveys were produced at the Space Telescope Science Institute under U.S. Government '
                                    'grant NAG W-2166. The images of these surveys are based on photographic data obtained using the Oschin '
                                    'Schmidt Telescope on Palomar Mountain and the UK Schmidt Telescope. The plates were processed into the '
                                    'present compressed digital form with the permission of these institutions.'),
    'panstarrs': ('Pan-STARRS1', 'The Pan-STARRS1 Surveys (PS1) and the PS1 public science archive have been made possible through '
                                 'contributions by the Institute for Astronomy, the University of Hawaii, the Pan-STARRS Project Office, the '
                                 'Max-Planck Society and its participating institutes and many other institutions (full text: '
                                 'https://panstarrs.stsci.edu/#acknowledgment); Chambers et al. 2016, arXiv:1612.05560.'),
    'legacy': ('DESI Legacy Imaging Surveys', 'This work uses images from the DESI Legacy Imaging Surveys (Dey et al. 2019, AJ 157, 168); '
                                              'full acknowledgement: https://www.legacysurvey.org/acknowledgment/.'),
    'twomass': ('2MASS', 'This publication makes use of data products from the Two Micron All Sky Survey, which is a joint project of the '
                         'University of Massachusetts and the Infrared Processing and Analysis Center/California Institute of Technology, '
                         'funded by the National Aeronautics and Space Administration and the National Science Foundation.'),
}


def survey_keys(survey: str) -> list:
    """Credits for the survey a HOTPANTS reference came from (names as AstroviaBin reports them)."""
    name = (survey or '').lower()
    if 'dss' in name:
        return ['dss', 'skyview']
    if 'pan-starrs' in name or 'ps1' in name:
        return ['panstarrs']
    if 'legacy' in name:
        return ['legacy']
    if 'sdss' in name:
        return ['sdss', 'skyview']
    if '2mass' in name:
        return ['twomass', 'skyview']
    return []


def credit_lines(keys) -> list:
    """Lines for a PDF text page: one bold heading and the acknowledgement text per credit."""
    lines = ['Results derived from these data must carry the acknowledgements and citations below when published.', '']
    for key in dict.fromkeys(keys):
        title, text = SKYVIEW if key == 'skyview' else CREDITS[key]
        lines += [(title, {'fontsize': 9, 'family': 'sans-serif', 'weight': 'bold'}), text, '']
    lines.append('AstroviaBin (MIT license) does not change any of these terms; see docs/LICENSES.md for every license.')
    return lines
