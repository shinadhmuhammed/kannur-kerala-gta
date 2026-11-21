import type { BuildingData } from "./buildings";
import type { LandData } from "./land";
import type { RoadData } from "./roads";

// The round map in the corner.
//
// Drawing 1,246 roads and 12,536 buildings 60 times a second would be slow.
// So the WHOLE map is painted once, at start-up, onto a big hidden canvas.
// Each frame we only copy the small square around the player onto the
// visible canvas, which costs almost nothing.

const PIXELS = 3072; // size of the hidden canvas
const VIEW = 260; // metres from the player to the edge of the minimap

export class Minimap {
  private readonly whole = document.createElement("canvas");
  private readonly screen: CanvasRenderingContext2D;
  private readonly scale: number; // pixels per metre on the hidden canvas
  private readonly half: number; // metres from the map's centre to its edge

  constructor(private readonly canvas: HTMLCanvasElement, roads: RoadData, land: LandData, buildings: BuildingData) {
    this.screen = canvas.getContext("2d")!;
    this.half = Math.max(roads.halfWidth, roads.halfDepth) + 100;
    this.scale = PIXELS / (this.half * 2);
    this.whole.width = this.whole.height = PIXELS;

    const c = this.whole.getContext("2d")!;
    // From here on we can draw in metres: the canvas does the conversion.
    // Map x goes right and map z goes down, exactly like canvas x and y,
    // so north ends up at the top.
    c.scale(this.scale, this.scale);
    c.translate(this.half, this.half);

    c.fillStyle = "#dfe6c8";
    c.fillRect(-this.half, -this.half, this.half * 2, this.half * 2);

    const fill = (outlines: number[][], colour: string): void => {
      c.fillStyle = colour;
      for (const p of outlines) {
        c.beginPath();
        c.moveTo(p[0], p[1]);
        for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1]);
        c.fill();
      }
    };
    const stroke = (points: number[], colour: string, width: number): void => {
      c.strokeStyle = colour;
      c.lineWidth = width;
      c.beginPath();
      c.moveTo(points[0], points[1]);
      for (let i = 2; i < points.length; i += 2) c.lineTo(points[i], points[i + 1]);
      c.stroke();
    };

    fill(land.sea, "#8ec5e8");
    fill(land.beaches, "#f1e3b8");
    fill(land.green, "#b5d99c");
    fill(land.pitches, "#9fd08a");
    fill(land.water, "#8ec5e8");
    for (const s of land.streams) stroke(s.points, "#8ec5e8", s.width);
    fill(buildings.buildings.map((b) => b.points), "#c9c2b4");

    c.lineCap = c.lineJoin = "round";
    // Small roads first, so the main roads are painted over them.
    const isMain = (kind: string) => /^(trunk|primary|secondary)/.test(kind);
    for (const road of roads.roads) if (!isMain(road.kind)) stroke(road.points, "#ffffff", road.width);
    for (const road of roads.roads) if (isMain(road.kind)) stroke(road.points, "#f6c453", road.width + 2);
    for (const line of land.rails) stroke(line, "#555555", 2);
  }

  /** Copy the whole painted town onto another canvas (the big map, key M). */
  drawWhole(target: HTMLCanvasElement): void {
    target.getContext("2d")!.drawImage(this.whole, 0, 0, PIXELS, PIXELS, 0, 0, target.width, target.height);
  }

  /** Where a world point is on the whole map: 0..1 across and 0..1 down. */
  toMap(x: number, z: number): [number, number] {
    return [(x + this.half) / (this.half * 2), (z + this.half) / (this.half * 2)];
  }

  /** The opposite: a spot on the whole map (0..1, 0..1) as a world point. */
  toWorld(across: number, down: number): [number, number] {
    return [across * this.half * 2 - this.half, down * this.half * 2 - this.half];
  }

  /**
   * Redraw the corner map around the player.
   * @param target a place to mark, such as the next bus stop
   */
  update(x: number, z: number, heading: number, target: { x: number; z: number } | null = null): void {
    const s = this.screen;
    const size = this.canvas.width;
    s.fillStyle = "#8ec5e8"; // shows beyond the edge of the painted map
    s.fillRect(0, 0, size, size);

    // The square of the hidden canvas around the player, in its pixels.
    const left = (x - VIEW + this.half) * this.scale;
    const top = (z - VIEW + this.half) * this.scale;
    const span = VIEW * 2 * this.scale;
    s.drawImage(this.whole, left, top, span, span, 0, 0, size, size);

    if (target) {
      // Where the target is on the little map, measured from its middle.
      const pixelsPerMetre = size / (VIEW * 2);
      let tx = (target.x - x) * pixelsPerMetre;
      let ty = (target.z - z) * pixelsPerMetre;
      // If it is off the map, pin the dot to the rim in its direction, so
      // you still know which way to drive.
      const rim = size / 2 - 14;
      const far = Math.hypot(tx, ty);
      if (far > rim) {
        tx *= rim / far;
        ty *= rim / far;
      }
      s.beginPath();
      s.arc(size / 2 + tx, size / 2 + ty, 11, 0, Math.PI * 2);
      s.fillStyle = "#ffd23f";
      s.strokeStyle = "#1b2a4a";
      s.lineWidth = 4;
      s.fill();
      s.stroke();
    }

    // The player: an arrow in the middle, turned to face the way they face.
    s.save();
    s.translate(size / 2, size / 2);
    s.rotate(-heading);
    s.beginPath();
    s.moveTo(0, 9); // tip (drawn pointing down, which is heading 0 = +z)
    s.lineTo(6, -7);
    s.lineTo(0, -3);
    s.lineTo(-6, -7);
    s.closePath();
    s.fillStyle = "#d62828";
    s.strokeStyle = "#ffffff";
    s.lineWidth = 2;
    s.stroke();
    s.fill();
    s.restore();
  }
}
