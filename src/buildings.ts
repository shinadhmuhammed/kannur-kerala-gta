import * as THREE from "three";
import { pointInOutline } from "./mapData";
import { MeshPart } from "./meshPart";
import { concreteTexture, tileTexture, wallTexture } from "./textures";

// Builds every building in the map as a simple box-like shape: the outline
// from OpenStreetMap pushed straight up to the building's height, with a tiled
// sloping roof on houses and a flat roof on bigger buildings. All 12,000+
// buildings go into just THREE meshes (see the note in ribbon.ts on why):
// walls, tiled roofs and flat roofs, one per texture. Each building still
// gets its own paint through "vertex colours".

interface Building {
  height: number; // metres
  points: number[]; // outline, flat list [x0, z0, x1, z1, ...]
  /** Set on the few buildings that have their own hand-made model. */
  kind?: string;
}

export interface BuildingData {
  buildings: Building[];
}

// Wall paints you see around Kannur: whites, creams, light blue, pink, yellow.
const WALLS = [0xf2ead8, 0xe8d9b5, 0xf6f1e7, 0xd5e3ec, 0xf0d0b8, 0xe3e8c9, 0xf3dd8c];
const TILE_ROOF = 0xb5523b; // Mangalore clay tiles, for houses
const CONCRETE_ROOF = 0x9d9c96; // for big buildings
const BIG = 250; // m². Larger than this counts as a big building.
const FLOOR = 3.2; // metres. The wall texture is one floor tall ...
const BAY = 3.4; // ... and one window wide.

// For collisions we must find the buildings near the car quickly. Checking
// all 12,000 every frame is wasteful, so the map is cut into square cells and
// each cell remembers which buildings touch it. Then we only check one cell.
const CELL = 40; // metres
const cellKey = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

export class Buildings {
  readonly mesh = new THREE.Group();
  private readonly cells = new Map<string, Building[]>();

  constructor(data: BuildingData) {
    const walls = new MeshPart();
    const tileRoofs = new MeshPart();
    const flatRoofs = new MeshPart();
    const colour = new THREE.Color();

    data.buildings.forEach((building, n) => {
      // The railway station is drawn by station.ts. It is still remembered
      // below, so you cannot drive or walk through it.
      if (building.kind === "train_station") {
        this.addToCells(building);
        return;
      }
      const h = building.height;
      const area = signedArea(building.points);
      // Outlines come drawn in either direction. Make them all go the same
      // way round, so "outside" is always on the same side of each wall.
      const p = area > 0 ? building.points : reversed(building.points);
      const count = p.length / 2;

      // --- Walls: one rectangle per edge of the outline --------------------
      colour.setHex(WALLS[n % WALLS.length]);
      for (let i = 0; i < count; i++) {
        const j = (i + 1) % count;
        const x1 = p[i * 2], z1 = p[i * 2 + 1];
        const x2 = p[j * 2], z2 = p[j * 2 + 1];
        const len = Math.hypot(x2 - x1, z2 - z1) || 1;
        const nx = (z2 - z1) / len; // the edge turned 90 degrees = facing out
        const nz = -(x2 - x1) / len;
        // Texture positions. Across: one picture per BAY metres, placed so a
        // window sits in the middle of the wall. Up: one picture per floor.
        const u1 = 0.5 - len / BAY / 2;
        const u2 = 0.5 + len / BAY / 2;
        const top = h / FLOOR;
        const a = walls.vertex(x1, 0, z1, nx, 0, nz, colour, u1, 0); // bottom corners
        const b = walls.vertex(x2, 0, z2, nx, 0, nz, colour, u2, 0);
        const c = walls.vertex(x2, h, z2, nx, 0, nz, colour, u2, top); // top corners
        const d = walls.vertex(x1, h, z1, nx, 0, nz, colour, u1, top);
        walls.triangle(a, c, b); // two triangles make the rectangle
        walls.triangle(a, d, c);
      }

      // --- Roof ---------------------------------------------------------------
      const corners: THREE.Vector2[] = [];
      let midX = 0, midZ = 0;
      for (let i = 0; i < count; i++) {
        corners.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]));
        midX += p[i * 2] / count;
        midZ += p[i * 2 + 1] / count;
      }
      const isHouse = Math.abs(area) <= BIG && count <= 8 && pointInOutline(midX, midZ, p);

      if (isHouse) {
        // A sloping tiled roof, as on Kerala houses: every wall top rises to
        // one peak above the middle of the house.
        colour.setHex(TILE_ROOF);
        const peak = h + Math.min(2.4, Math.sqrt(Math.abs(area)) * 0.2);
        for (let i = 0; i < count; i++) {
          const a = corners[i], b = corners[(i + 1) % count];
          // The slope faces partly up and partly outwards. The "normal" is
          // the arrow sticking straight out of the surface; the cross product
          // of two edges of the triangle gives it.
          const ux = b.x - a.x, uz = b.y - a.y;
          const vx = midX - a.x, vy = peak - h, vz = midZ - a.y;
          let nx = -uz * vy, ny = uz * vx - ux * vz, nz = ux * vy;
          const flip = ny < 0; // make sure the roof faces the sky
          if (flip) { nx = -nx; ny = -ny; nz = -nz; }
          const len = Math.hypot(nx, ny, nz) || 1;
          // Roof textures are laid on by map position: 2.5 m of roof per
          // picture, seen from above.
          const T = 2.5;
          const va = tileRoofs.vertex(a.x, h, a.y, nx / len, ny / len, nz / len, colour, a.x / T, a.y / T);
          const vb = tileRoofs.vertex(b.x, h, b.y, nx / len, ny / len, nz / len, colour, b.x / T, b.y / T);
          const top = tileRoofs.vertex(midX, peak, midZ, nx / len, ny / len, nz / len, colour, midX / T, midZ / T);
          if (flip) tileRoofs.triangle(va, vb, top);
          else tileRoofs.triangle(va, top, vb);
        }
      } else {
        // A flat concrete roof: the outline itself, cut into triangles.
        colour.setHex(CONCRETE_ROOF);
        const first = flatRoofs.vertexCount;
        for (const corner of corners) flatRoofs.vertex(corner.x, h, corner.y, 0, 1, 0, colour, corner.x / 7, corner.y / 7);
        for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(corners, [])) {
          // A triangle is only visible from the side where its corners go
          // anticlockwise. Make sure every roof triangle faces up.
          const a = corners[i], b = corners[j], c = corners[k];
          const facesUp = (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y) > 0;
          flatRoofs.triangle(first + i, first + (facesUp ? j : k), first + (facesUp ? k : j));
        }
      }

      this.addToCells(building);
    });

    this.mesh.add(walls.build(wallTexture(), 0.9), tileRoofs.build(tileTexture(), 0.8), flatRoofs.build(concreteTexture(), 1));
  }

  /** Is this spot inside a building? */
  hits(x: number, z: number): boolean {
    const nearby = this.cells.get(cellKey(x, z));
    return nearby !== undefined && nearby.some((b) => pointInOutline(x, z, b.points));
  }

  /** Remember the building in every cell its outline's bounding box touches. */
  private addToCells(building: Building): void {
    const p = building.points;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
      minZ = Math.min(minZ, p[i + 1]); maxZ = Math.max(maxZ, p[i + 1]);
    }
    for (let x = Math.floor(minX / CELL); x <= Math.floor(maxX / CELL); x++) {
      for (let z = Math.floor(minZ / CELL); z <= Math.floor(maxZ / CELL); z++) {
        const key = `${x},${z}`;
        const list = this.cells.get(key);
        if (list) list.push(building);
        else this.cells.set(key, [building]);
      }
    }
  }
}

/** Shoelace formula. The sign tells which way round the outline is drawn. */
function signedArea(p: number[]): number {
  let sum = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    sum += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return sum / 2;
}

/** The same outline, drawn the other way round. */
function reversed(p: number[]): number[] {
  const out: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1]);
  return out;
}
