import OpenSeadragon from "openseadragon";

/** Mirrors the server's SkyOverlay (apps/server/src/services/sky-overlay.ts). */
export type Point = [number, number];

export interface SkyOverlayObject {
  id: string; label: string; common?: string | null; names: string[]; type: string; typeLabel: string;
  x: number; y: number; rx: number; ry: number; angle: number; mag: number | null; ra: number; dec: number; priority: number;
}

export interface SkyOverlayStar {
  label: string; names: string[]; mag: number | null; x: number; y: number; ra: number; dec: number; priority: number;
}

export interface SkyOverlayData {
  version: 2;
  imageWidth: number;
  imageHeight: number;
  epoch: number;
  field: { ra: number; dec: number; widthDeg: number; heightDeg: number; pixelScale: number; constellation: string | null };
  objects: SkyOverlayObject[];
  stars: SkyOverlayStar[];
  constellations: { lines: Array<{ id: string; points: Point[] }>; labels: Array<{ id: string; name: string; x: number; y: number }> };
  grid: { raStepDeg: number; decStepDeg: number; lines: Array<{ kind: "ra" | "dec"; value: number; label: string; points: Point[] }> };
  online?: { fetchedAt: string; gaia: number; simbad: number };
}

export interface SkyLayers {
  objects: boolean;
  stars: boolean;
  constellations: boolean;
  grid: boolean;
  labels: boolean;
}

export const DEFAULT_SKY_LAYERS: SkyLayers = { objects: true, stars: true, constellations: true, grid: false, labels: true };

const SVG = "http://www.w3.org/2000/svg";
const COLORS = { object: "#00f0ff", star: "#f9f002", named: "#ffffff", constellation: "#ff2bd6", grid: "#7a5cff" };

function el<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

interface Label {
  node: SVGTextElement;
  layer: keyof SkyLayers;
  /** Anchor in image pixels and offset direction in screen pixels. */
  x: number;
  y: number;
  dx: number;
  dy: number;
  priority: number;
  text: string;
  fontPx: number;
}

/**
 * Draws a SkyOverlay on an OpenSeadragon viewer as one SVG in image-pixel coordinates. Strokes,
 * markers and text keep a constant on-screen size at every zoom, and labels are thinned by
 * priority so they never overlap.
 */
export class SkyOverlayRenderer {
  private readonly root: SVGSVGElement;
  private readonly container: HTMLDivElement;
  private readonly stars: Array<{ node: SVGCircleElement; radius: number }> = [];
  private readonly dots: Array<{ node: SVGCircleElement; radius: number }> = [];
  private labels: Label[] = [];
  private readonly groups: Record<keyof SkyLayers, SVGGElement>;
  private frame = 0;
  private readonly onUpdate = () => this.schedule();

  constructor(private readonly viewer: OpenSeadragon.Viewer, private readonly data: SkyOverlayData, private layers: SkyLayers) {
    this.container = document.createElement("div");
    this.container.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:visible;";
    this.root = el("svg", { viewBox: `0 0 ${data.imageWidth} ${data.imageHeight}`, width: "100%", height: "100%", preserveAspectRatio: "none" });
    this.root.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;font-family:Rajdhani,'Share Tech Mono',sans-serif;";
    this.container.appendChild(this.root);
    this.groups = {
      grid: el("g"), constellations: el("g"), objects: el("g"), stars: el("g"), labels: el("g"),
    };
    for (const key of ["grid", "constellations", "objects", "stars", "labels"] as const) this.root.appendChild(this.groups[key]);
    this.build();

    const tiledImage = viewer.world.getItemAt(0);
    viewer.addOverlay({ element: this.container, location: tiledImage.getBounds() });
    viewer.addHandler("animation", this.onUpdate);
    viewer.addHandler("animation-finish", this.onUpdate);
    viewer.addHandler("resize", this.onUpdate);
    this.applyLayers();
    this.update();
  }

  setLayers(layers: SkyLayers) {
    this.layers = layers;
    this.applyLayers();
    this.update();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.viewer.removeHandler("animation", this.onUpdate);
    this.viewer.removeHandler("animation-finish", this.onUpdate);
    this.viewer.removeHandler("resize", this.onUpdate);
    try { this.viewer.removeOverlay(this.container); } catch { /* viewer already destroyed */ }
  }

  private schedule() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.update());
  }

  private applyLayers() {
    for (const key of Object.keys(this.groups) as Array<keyof SkyLayers>) {
      this.groups[key].style.display = this.layers[key] ? "" : "none";
    }
  }

  private polyline(points: Point[], attributes: Record<string, string | number>) {
    return el("polyline", { points: points.map(([x, y]) => `${x},${y}`).join(" "), fill: "none", "vector-effect": "non-scaling-stroke", ...attributes });
  }

  private addLabel(layer: keyof SkyLayers, text: string, x: number, y: number, dx: number, dy: number, priority: number, color: string, fontPx: number, weight = 600) {
    const node = el("text", { x, y, fill: color, "font-weight": weight, "paint-order": "stroke", stroke: "#04020a", "stroke-opacity": 0.85 });
    node.textContent = text;
    this.groups.labels.appendChild(node);
    this.labels.push({ node, layer, x, y, dx, dy, priority, text, fontPx });
  }

  private build() {
    const { data } = this;
    const minSide = Math.min(data.imageWidth, data.imageHeight);
    const diagonal = Math.hypot(data.imageWidth, data.imageHeight);

    for (const line of data.grid.lines) {
      this.groups.grid.appendChild(this.polyline(line.points, { stroke: COLORS.grid, "stroke-width": 1, "stroke-opacity": 0.55, "stroke-dasharray": "4 5" }));
      // Label where the line enters the frame.
      const entry = line.points.find(([x, y]) => x >= 0 && y >= 0 && x <= data.imageWidth && y <= data.imageHeight);
      if (entry) this.addLabel("grid", line.label, entry[0], entry[1], 4, -4, 5, COLORS.grid, 11, 500);
    }

    for (const line of data.constellations.lines) {
      this.groups.constellations.appendChild(this.polyline(line.points, { stroke: COLORS.constellation, "stroke-width": 1.6, "stroke-opacity": 0.7 }));
    }
    for (const label of data.constellations.labels) this.addLabel("constellations", label.name.toUpperCase(), label.x, label.y, 0, 0, 45, COLORS.constellation, 14, 700);

    for (const object of data.objects) {
      const reach = Math.max(object.rx, object.ry);
      const huge = reach > diagonal * 0.9;
      const large = reach > minSide * 0.45;
      if (object.rx > 0 && !huge) {
        const ellipse = el("ellipse", {
          cx: object.x, cy: object.y, rx: Math.max(object.rx, 0.5), ry: Math.max(object.ry, 0.5),
          transform: `rotate(${object.angle} ${object.x} ${object.y})`, fill: "none", stroke: COLORS.object,
          "stroke-width": large ? 1.2 : 1.8, "stroke-opacity": large ? 0.5 : 0.9, "vector-effect": "non-scaling-stroke",
          ...(large ? { "stroke-dasharray": "6 6" } : {}),
        });
        const title = el("title");
        title.textContent = `${object.names.join(" · ")} — ${object.typeLabel}${object.mag != null ? `, mag ${object.mag}` : ""}`;
        ellipse.appendChild(title);
        this.groups.objects.appendChild(ellipse);
      }
      // Point-like objects (and the centre of very large ones) get a small cross-hair dot.
      if (object.rx <= 0 || huge) {
        const dot = el("circle", { cx: object.x, cy: object.y, r: 3, fill: "none", stroke: COLORS.object, "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" });
        this.groups.objects.appendChild(dot);
        this.dots.push({ node: dot, radius: 4 });
      }
      const inFrame = object.x >= 0 && object.y >= 0 && object.x <= data.imageWidth && object.y <= data.imageHeight;
      const lx = Math.min(Math.max(object.x, 0), data.imageWidth);
      const ly = Math.min(Math.max(object.y - (object.rx > 0 && !huge && !large ? object.ry : 0), 0), data.imageHeight);
      const text = object.common && object.common !== object.label ? `${object.label} · ${object.common}` : object.label;
      this.addLabel("objects", inFrame ? text : `${text} ↗`, lx, ly, 6, -6, object.priority, COLORS.object, 13, 700);
    }

    for (const star of data.stars) {
      // Marker size follows brightness, like a star chart.
      const radius = star.mag == null ? 4 : Math.max(3.5, Math.min(11, 11 - star.mag * 0.7));
      const named = /[^\d\s-]/.test(star.label.replace(/^(HD|HIP|TYC)\s/, "")) && !/^(HD|HIP|TYC)\s/.test(star.label);
      const node = el("circle", {
        cx: star.x, cy: star.y, r: radius, fill: "none", stroke: named ? COLORS.named : COLORS.star,
        "stroke-width": named ? 1.6 : 1.1, "stroke-opacity": 0.9, "vector-effect": "non-scaling-stroke",
      });
      const title = el("title");
      title.textContent = `${star.names.join(" · ")}${star.mag != null ? ` — mag ${star.mag}` : ""}`;
      node.appendChild(title);
      this.groups.stars.appendChild(node);
      this.stars.push({ node, radius });
      this.addLabel("stars", star.mag != null && !named ? `${star.label} ${star.mag.toFixed(1)}` : star.label, star.x, star.y, radius + 4, 4,
        star.priority, named ? COLORS.named : COLORS.star, named ? 13 : 11, named ? 700 : 500);
    }
    this.labels.sort((left, right) => right.priority - left.priority);
  }

  /** Screen pixels per image pixel at the current zoom. */
  private imageZoom(): number {
    const tiledImage = this.viewer.world.getItemAt(0);
    if (!tiledImage) return 1;
    const contentWidth = tiledImage.getContentSize().x || this.data.imageWidth;
    // Overlay geometry is in data pixels; rescale if the viewer shows a resized preview.
    return tiledImage.viewportToImageZoom(this.viewer.viewport.getZoom(true)) * contentWidth / this.data.imageWidth;
  }

  private update() {
    const zoom = this.imageZoom();
    if (!Number.isFinite(zoom) || zoom <= 0) return;
    const unit = 1 / zoom; // image pixels per screen pixel
    for (const { node, radius } of this.stars) node.setAttribute("r", String(radius * unit));
    for (const { node, radius } of this.dots) node.setAttribute("r", String(radius * unit));

    // Greedy label placement in screen space, highest priority first. Each label tries the right,
    // left, top and bottom of its anchor and is hidden only when every spot collides or leaves the image.
    const placed: Array<[number, number, number, number]> = [];
    const viewport = this.viewer.viewport;
    const tiledImage = this.viewer.world.getItemAt(0);
    const scale = (tiledImage?.getContentSize().x || this.data.imageWidth) / this.data.imageWidth;
    const containerSize = this.viewer.container.getBoundingClientRect();
    const topLeft = viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
    const bottomRight = viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(this.data.imageWidth * scale, this.data.imageHeight * scale));
    const bounds = [Math.max(0, topLeft.x), Math.max(0, topLeft.y), Math.min(containerSize.width, bottomRight.x), Math.min(containerSize.height, bottomRight.y)];
    for (const label of this.labels) {
      if (!this.layers.labels || !this.layers[label.layer]) { label.node.style.display = "none"; continue; }
      const screen = viewport.imageToViewerElementCoordinates(new OpenSeadragon.Point(label.x * scale, label.y * scale));
      const width = label.text.length * label.fontPx * 0.56;
      const height = label.fontPx;
      const gap = Math.max(Math.abs(label.dx), 4);
      const candidates: Array<{ left: number; top: number; anchor: "start" | "end" | "middle" }> = [
        { left: screen.x + label.dx, top: screen.y + label.dy - height, anchor: "start" },
        { left: screen.x - gap - width, top: screen.y + label.dy - height, anchor: "end" },
        { left: screen.x - width / 2, top: screen.y - gap - height, anchor: "middle" },
        { left: screen.x - width / 2, top: screen.y + gap, anchor: "middle" },
      ];
      let chosen: (typeof candidates)[number] | null = null;
      for (const candidate of candidates) {
        const box: [number, number, number, number] = [candidate.left - 2, candidate.top - 2, candidate.left + width + 2, candidate.top + height + 2];
        const inside = box[0] >= bounds[0] - 1 && box[1] >= bounds[1] - 1 && box[2] <= bounds[2] + 1 && box[3] <= bounds[3] + 1;
        if (!inside) continue;
        if (placed.some(other => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) continue;
        placed.push(box);
        chosen = candidate;
        break;
      }
      if (!chosen) { label.node.style.display = "none"; continue; }
      // Convert the chosen screen spot back to image units for the SVG text anchor.
      const anchorX = chosen.anchor === "start" ? chosen.left : chosen.anchor === "end" ? chosen.left + width : chosen.left + width / 2;
      const baseline = chosen.top + height * 0.85;
      label.node.style.display = "";
      label.node.setAttribute("text-anchor", chosen.anchor);
      label.node.setAttribute("x", String(label.x + (anchorX - screen.x) * unit));
      label.node.setAttribute("y", String(label.y + (baseline - screen.y) * unit));
      label.node.setAttribute("font-size", String(label.fontPx * unit));
      label.node.setAttribute("stroke-width", String(3 * unit));
    }
  }
}
