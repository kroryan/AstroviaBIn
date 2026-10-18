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
          <a className="text-primary underline" href="https://github.com/sidereal-io/sidereal" target="_blank" rel="noreferrer">Sidereal source code</a>
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
        <h3 className="font-semibold">Astrometry.net and reference surveys</h3>
        <p className="text-muted-foreground">Astrometry.net plate solving runs on this server using locally installed index files. Automatic reference lookup requests public sky-survey data from NASA SkyView using coordinates only; it does not upload your image or FITS. Reference survey imagery retains its provider's rights and citation requirements. Analysis results are candidates, not verified discoveries.</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1">
          <a className="text-primary underline" href="https://astrometry.net/" target="_blank" rel="noreferrer">Astrometry.net</a>
          <a className="text-primary underline" href="https://skyview.gsfc.nasa.gov/current/docs/credits.html" target="_blank" rel="noreferrer">SkyView credits and survey acknowledgements</a>
        </div>
      </div>
    </CardContent>
  </Card>;
}
