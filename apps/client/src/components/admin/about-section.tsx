import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function AboutSection() {
  return <Card className="mb-6">
    <CardHeader>
      <CardTitle>About Sidereal & third-party notices</CardTitle>
      <CardDescription>Software provenance, scientific limitations, and license documents.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4 text-sm">
      <div>
        <h3 className="font-semibold">Sidereal</h3>
        <p className="text-muted-foreground">Local-first astronomy image library and FITS analysis. Sidereal is distributed under the MIT license; the application source and full license are available in the project repository.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="/api/licenses/sidereal" target="_blank" rel="noreferrer">Sidereal MIT license</a>
          <a className="text-primary underline" href="https://github.com/kroryan/sidereal/tree/v0.x" target="_blank" rel="noreferrer">This fork's source code</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Photutils</h3>
        <p className="text-muted-foreground">Sidereal uses the independent Photutils project for local point-source shape checks and second-exposure follow-up. Photutils is distributed under the BSD 3-Clause license. Its checks reduce false positives but do not confirm an astrophysical discovery.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://photutils.readthedocs.io/en/stable/development/license.html" target="_blank" rel="noreferrer">Photutils license</a>
          <a className="text-primary underline" href="https://github.com/astropy/photutils" target="_blank" rel="noreferrer">Photutils source and documentation</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">HOTPANTS</h3>
        <p className="text-muted-foreground">High Order Transform of PSF ANd Template Subtraction by Andrew Becker and contributors. Sidereal vendors and builds the upstream C source without scientific or mathematical changes, including the alternative extractkernOnes helper for PSF visualization. The upstream repository contains both an MIT LICENSE notice and a GPL version 2 COPYING document; both are retained and offered here verbatim. Review the upstream notices for redistribution obligations.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="/api/licenses/hotpants/LICENSE" target="_blank" rel="noreferrer">HOTPANTS LICENSE</a>
          <a className="text-primary underline" href="/api/licenses/hotpants/COPYING" target="_blank" rel="noreferrer">HOTPANTS COPYING (GPL v2)</a>
          <a className="text-primary underline" href="https://github.com/acbecker/hotpants" target="_blank" rel="noreferrer">Upstream source and documentation</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Astrometry.net</h3>
        <p className="text-muted-foreground">Plate solving runs on this server with the Astrometry.net solve-field program (Dustin Lang, David W. Hogg and contributors), installed from Debian. The software is BSD 3-Clause licensed, with some components under GPL v2+/v3+ and Zlib as listed in its copyright file. No image or FITS is sent to nova.astrometry.net.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="/api/licenses/astrometry/software" target="_blank" rel="noreferrer">Astrometry.net copyright and licenses</a>
          <a className="text-primary underline" href="https://astrometry.net/" target="_blank" rel="noreferrer">Astrometry.net</a>
          <a className="text-primary underline" href="https://github.com/dstndstn/astrometry.net" target="_blank" rel="noreferrer">Source code</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Astrometry.net index files (2MASS)</h3>
        <p className="text-muted-foreground">Star-pattern index files 4208–4219 ship with the image (Debian astrometry-data-2mass-08-19). Optional narrow-field files 4203–4207 are downloaded from data.astrometry.net into the AppData folder by <code>download-astrometry-indexes</code>. The index files are distributed under the GNU GPL v2 or later. They are built from the Two Micron All Sky Survey, whose catalog products are in the public domain: this product makes use of data products from the Two Micron All Sky Survey, which is a joint project of the University of Massachusetts and the Infrared Processing and Analysis Center/California Institute of Technology, funded by the National Aeronautics and Space Administration and the National Science Foundation.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="/api/licenses/astrometry/index-2mass" target="_blank" rel="noreferrer">Bundled index copyright (GPL v2+, 2MASS public domain)</a>
          <a className="text-primary underline" href="/api/licenses/astrometry/index-4200" target="_blank" rel="noreferrer">Downloaded 4200-series index license</a>
          <a className="text-primary underline" href="https://data.astrometry.net/4200/" target="_blank" rel="noreferrer">data.astrometry.net/4200</a>
          <a className="text-primary underline" href="https://irsa.ipac.caltech.edu/Missions/2mass.html" target="_blank" rel="noreferrer">2MASS at IRSA</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">OpenNGC catalog</h3>
        <p className="text-muted-foreground">Target identification and plate-solving annotations use OpenNGC by Mattia Verga, licensed under CC BY-SA 4.0. Annotation positions are projected from each image's own WCS solution (TAN with SIP distortion) and depend on the catalog's coordinates and object sizes.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://github.com/mattiaverga/OpenNGC" target="_blank" rel="noreferrer">OpenNGC source</a>
          <a className="text-primary underline" href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">CC BY-SA 4.0</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Astropy, NumPy and SciPy</h3>
        <p className="text-muted-foreground">Sidereal's star extractor for plate solving and the HOTPANTS pipeline use Astropy, NumPy and SciPy, all distributed under the BSD 3-Clause license, installed from Debian.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://www.astropy.org/" target="_blank" rel="noreferrer">Astropy</a>
          <a className="text-primary underline" href="https://numpy.org/" target="_blank" rel="noreferrer">NumPy</a>
          <a className="text-primary underline" href="https://scipy.org/" target="_blank" rel="noreferrer">SciPy</a>
        </div>
      </div>
      <div>
        <h3 className="font-semibold">Reference surveys</h3>
        <p className="text-muted-foreground">Automatic reference lookup for HOTPANTS requests public sky-survey data from NASA SkyView using coordinates only; it does not upload your image or FITS. Reference survey imagery retains its provider's rights and citation requirements. Analysis results are candidates, not verified discoveries.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://skyview.gsfc.nasa.gov/current/docs/credits.html" target="_blank" rel="noreferrer">SkyView credits and survey acknowledgements</a>
        </div>
      </div>
    </CardContent>
  </Card>;
}
