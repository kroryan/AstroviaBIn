import { AlertTriangle, BookOpen, CheckCircle2, Info, XCircle } from "lucide-react";
import type { SelectionNote } from "@shared/stacking-checks";

/** What can be stacked together, what must stay apart, and what to stack for each purpose. */

export { checkSelection } from "@shared/stacking-checks";

const ICON: Record<SelectionNote["level"], React.ReactNode> = {
  error: <XCircle className="h-4 w-4 shrink-0 text-destructive" />,
  warning: <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />,
  info: <Info className="h-4 w-4 shrink-0 text-cyan-400" />,
  ok: <CheckCircle2 className="h-4 w-4 shrink-0 text-green-500" />,
};

export function SelectionNotes({ notes }: { notes: SelectionNote[] }) {
  if (!notes.length) return null;
  return (
    <ul className="space-y-1.5 rounded-md border border-border p-3 text-xs">
      <li className="font-semibold text-foreground">Selection check</li>
      {notes.map(note => <li key={note.text} className="flex gap-2">{ICON[note.level]}<span>{note.text}</span></li>)}
    </ul>
  );
}

function Section({ title, children, open = false }: { title: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details open={open} className="rounded-md border border-border/70 px-3 py-2">
      <summary className="cursor-pointer text-sm font-semibold text-foreground">{title}</summary>
      <div className="mt-2 space-y-2 text-xs leading-relaxed text-muted-foreground">{children}</div>
    </details>
  );
}

function Table({ rows, head }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-left">
        <thead><tr>{head.map(cell => <th key={cell} className="border-b border-border px-2 py-1 font-semibold text-foreground">{cell}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row[0]}>{row.map((cell, index) => <td key={index} className="border-b border-border/50 px-2 py-1 align-top">{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function StackingGuide() {
  return (
    <details className="rounded-lg border border-primary/30 bg-primary/5 p-3">
      <summary className="flex cursor-pointer items-center gap-2 font-semibold text-foreground">
        <BookOpen className="h-4 w-4 text-primary" /> Stacking guide — what to stack together, what never to, and what to stack for each use
      </summary>
      <div className="mt-3 space-y-2">
        <Section title="The rule" open>
          <p>Stack only frames of the <b>same kind</b>: same field, same filter (bandpass), same frame type (lights with lights), same processing level (all raw or all calibrated, all linear) and ideally the same camera, binning and gain. Different filters are not stacked: each filter is stacked on its own and the stacks are combined into colour (LRGB, SHO…) afterwards.</p>
          <p>Stacking averages away noise (signal-to-noise grows with √N), and sigma-clipping rejects what appears in only one frame: cosmic rays, satellites, planes, hot pixels — and anything that moves.</p>
        </Section>

        <Section title="Frame types (IMAGETYP / OBSTYPE)">
          <Table head={["Type", "What it is", "Stack with", "Never with"]} rows={[
            ["Light / Object / Science / EXPOSE", "The sky exposure", "Other lights of the same field and filter", "Bias, darks, flats"],
            ["Bias / Offset / Zero", "0 s readout pattern", "Many biases (≥ 20, median) → master bias", "Lights; biases of another gain/offset/readout mode"],
            ["Dark", "Shutter closed, same exposure and temperature as the lights", "Darks of the same exposure, temperature, gain → master dark", "Lights; darks of another exposure or temperature"],
            ["Flat / Sky flat / Dome flat", "Even illumination per filter", "Flats of the same filter, focus and rotation → master flat", "Lights; flats of another filter or optical setup"],
            ["Dark flat / Flat dark", "Darks matching the flat exposure", "Each other → master dark flat", "Anything else"],
            ["Reduced / calibrated (e.g. LCO BANZAI e91, Slooh processed)", "Lights already bias/dark/flat-corrected", "Other reduced lights", "Raw lights (e00); do not calibrate them a second time"],
          ]} />
          <p>AstroviaBin stacks lights. Calibrate them first (or use observatory-reduced frames); calibration masters are built from their own type only.</p>
        </Section>

        <Section title="Filters (bandpasses)">
          <Table head={["Filter", "Use", "Stack together", "Do not mix with"]} rows={[
            ["L — Luminance, Clear, UV/IR-cut", "Detail and depth; faint objects", "All L of the field, any night", "Colour or narrowband frames"],
            ["R, G, B (RGB imaging)", "Colour of LRGB images", "Each channel with itself", "The other channels; Johnson R or SDSS r′ (different bandpasses)"],
            ["Johnson-Cousins U, B, V, R, I", "Standard photometry", "Same letter only", "RGB filters with the same letter; SDSS"],
            ["SDSS / Pan-STARRS u′ g′ r′ i′ z′, z_s, y", "Survey photometry (LCO uses these)", "Same band only", "Johnson or RGB filters"],
            ["Hα, Hβ, OIII, SII, NII", "Emission nebulae, SHO/HOO palettes", "Same line and bandwidth only (3 nm ≠ 7 nm)", "Broadband; other lines"],
            ["Near-infrared J, H, K, Ks", "Dust-obscured objects", "Same band only", "Optical filters"],
            ["Methane, UV, IR-pass (planetary)", "Planet details", "Same filter, same session", "Other filters"],
            ["Photometric clear / no filter recorded", "Unknown bandpass", "Only frames you know share it", "Anything named — check the FITS header"],
          ]} />
          <p>Hα can be <i>blended</i> into the red channel (HaRGB) after stacking — that is composition, not stacking.</p>
        </Section>

        <Section title="Colour data: mono, one-shot colour (OSC), composites">
          <p><b>Mono</b> frames have one filter each — the normal case for observatories (Slooh, LCO).</p>
          <p><b>OSC raw</b> frames (BAYERPAT/COLORTYP in the header) carry a Bayer mosaic: debayer them first and stack only with other OSC frames of the same camera and Bayer pattern — never with mono frames.</p>
          <p><b>Colour composites</b> (three-channel FITS, e.g. Slooh "R,B,V" files) are already combined final products: do not mix them with single-filter frames; re-stack them only if they are repeated composites of the same field and channel order.</p>
        </Section>

        <Section title="Processing level, geometry and exposure">
          <ul className="list-disc space-y-1 pl-4">
            <li><b>Linear vs stretched:</b> stack only linear data. Stretched, contrast-enhanced or exported (JPEG/PNG) images are non-linear and cannot be averaged meaningfully.</li>
            <li><b>Stacks:</b> do not re-stack a stack together with the frames it came from (their signal would count twice). Stacks of different frames of the same field and filter can be combined.</li>
            <li><b>Binning / pixel scale / telescope:</b> frames are aligned through their plate solutions, so different setups do line up, but their PSFs differ and the result is softer. Prefer one setup per stack; plate-solve frames before stacking.</li>
            <li><b>Mosaics:</b> panels of different fields do not overlap enough to stack — they need a mosaic tool.</li>
            <li><b>Exposure time:</b> different exposures are normalized by EXPTIME, but long frames may saturate stars that short ones do not; keep one exposure per stack when possible.</li>
            <li><b>Quality:</b> leave out frames with clouds, bad focus, trailing or much worse seeing — they add noise. Single satellite or plane trails are removed by sigma-clipping.</li>
          </ul>
        </Section>

        <Section title="What to stack for each use">
          <Table head={["Goal", "Stack", "Avoid"]} rows={[
            ["Deep, clean image", "All lights of one filter, any number of nights, sigma-clip; repeat per filter (L, R, G, B or Hα, OIII, SII) and combine colour afterwards", "Mixing filters; bad frames"],
            ["Colour LRGB", "L stack + R stack + G stack + B stack (e.g. Slooh: 3×L, then 1×R, 1×G, 1×B)", "Stacking R, G and B together"],
            ["Narrowband SHO / HOO", "One stack per line", "Broadband frames in a line stack"],
            ["Photometry, variable stars, exoplanet transits", "Measure single frames, or stack only consecutive frames within a short window (much shorter than the variation), same filter", "Stacking across nights or long spans; median combine; stretched data"],
            ["Supernova / transient search (HOTPANTS)", "Same-night, same-filter frames for depth, compared against a reference in the same band", "Stacking the two epochs you want to compare"],
            ["Asteroids and comets", "Single frames for detection and astrometry; a track-and-stack on the object's motion for faint movers; comets stacked on the nucleus", "Normal star-aligned stacking — the mover is smeared or clipped away"],
            ["Astrometry (positions)", "Single frames with their exact times; a stack only to detect a faint object (position at mid-time)", "Stacks spanning long times for moving targets"],
            ["Planets, Moon, Sun", "Lucky imaging from video (SER/AVI) with dedicated software; a few FITS of one session at most", "Long-exposure deep-sky stacking; frames from different times (planets rotate)"],
            ["Calibration masters", "Bias with bias, darks with matching darks, flats per filter", "Any lights"],
          ]} />
        </Section>

        <Section title="Never stack together">
          <ul className="list-disc space-y-1 pl-4">
            <li>Different filters or bandpasses (L with R, R with Johnson R, Hα 3 nm with Hα 7 nm, optical with infrared).</li>
            <li>Different frame types (lights with bias, darks or flats).</li>
            <li>Raw with calibrated frames, or linear with stretched/processed images.</li>
            <li>Mono with one-shot-colour raw frames, or single-filter frames with colour composites.</li>
            <li>A stack with the frames it was made from.</li>
            <li>Different, non-overlapping fields (mosaic panels).</li>
            <li>Frames from different epochs when the goal is to measure change (photometry, transients, moving objects).</li>
          </ul>
        </Section>
      </div>
    </details>
  );
}
