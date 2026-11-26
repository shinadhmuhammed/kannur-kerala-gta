import * as THREE from "three";
import { pointInOutline } from "./mapData";
import { RibbonBuilder, flatMaterial } from "./ribbon";

// Everything on the ground that is not a road or a building: the sea,
// beaches, ponds, streams, parks, sports grounds, the railway, and a few
// landmarks (the fort's walls, the breakwater, the lighthouse).

export interface LandData {
  // Outlines: each is a flat list [x0, z0, x1, z1, ...].
  sea: number[][];
  beaches: number[][];
  water: number[][]; // ponds and temple tanks
  wetland: number[][];
  green: number[][]; // parks, playgrounds, grass
  pitches: number[][]; // sports grounds and stadiums
  platforms: number[][]; // railway station platforms
  // Lines.
  streams: { width: number; points: number[] }[];
  rails: number[][];
  fortWalls: number[][];
  breakwaters: number[][];
  // Single spots [x, z].
  lighthouses: [number, number][];
  /** Where trains stop: one point on the track for each platform number. */
  trainStops: { platform: string; x: number; z: number }[];
}

export class Land {
  readonly group = new THREE.Group();

  constructor(private readonly data: LandData) {
    // Flat areas. The last number is the layer: bigger = drawn on top.
    this.group.add(
      flatShapes(data.sea, 0x2f86c4, 1),
      flatShapes(data.beaches, 0xe8d6a4, 2),
      flatShapes(data.wetland, 0x6f8f5a, 2),
      flatShapes(data.green, 0x5f9a4a, 2),
      flatShapes(data.pitches, 0x74b05a, 3),
      flatShapes(data.water, 0x3f8f8a, 3), // ponds are greener than the sea
      flatShapes(data.platforms, 0xb5b2aa, 5),
    );

    const streams = new RibbonBuilder();
    for (const s of data.streams) streams.addRibbon(s.points, s.width, 0.012);
    this.group.add(streams.build(0x4a90a8, 3));

    this.addRailway(data.rails);
    for (const wall of data.fortWalls) this.addWall(wall, 2, 7, 0x8a4b32); // laterite stone
    for (const wall of data.breakwaters) this.addWall(wall, 5, 1.6, 0x77766f);
    for (const [x, z] of data.lighthouses) this.addLighthouse(x, z);
  }

  /** Is this spot in the sea or a pond? Stops the car driving on water. */
  inWater(x: number, z: number): boolean {
    return (
      this.data.sea.some((outline) => pointInOutline(x, z, outline)) ||
      this.data.water.some((outline) => pointInOutline(x, z, outline))
    );
  }

  /** Track bed, sleepers and two steel rails for every railway line. */
  private addRailway(rails: number[][]): void {
    const bed = new RibbonBuilder();
    const sleepers = new RibbonBuilder();
    const steel = new RibbonBuilder();
    const GAUGE = 1.676; // Indian broad gauge: metres between the two rails
    for (const line of rails) {
      bed.addRibbon(line, 3.4, 0.03);
      // Sleepers are just a very wide dashed line: 25 cm of wood, 45 cm gap.
      sleepers.addDashes(line, 2.6, 0.06, 0, 0.25, 0.45);
      steel.addRibbon(line, 0.1, 0.16, GAUGE / 2);
      steel.addRibbon(line, 0.1, 0.16, -GAUGE / 2);
    }
    this.group.add(bed.build(0x6e625a, 5), sleepers.build(0x3e3229, 6), steel.build(0x9aa0a6, 7));
  }

  /** A wall along a line: one stretched box per piece of the line. */
  private addWall(points: number[], thickness: number, height: number, colour: number): void {
    const material = new THREE.MeshStandardMaterial({ color: colour, roughness: 1 });
    for (let i = 0; i + 3 < points.length; i += 2) {
      const dx = points[i + 2] - points[i];
      const dz = points[i + 3] - points[i + 1];
      // A box is made lying along z, then turned to point along the wall.
      // It is made a little too long so the corners have no gaps.
      const box = new THREE.Mesh(new THREE.BoxGeometry(thickness, height, Math.hypot(dx, dz) + thickness), material);
      box.position.set(points[i] + dx / 2, height / 2, points[i + 1] + dz / 2);
      box.rotation.y = Math.atan2(dx, dz);
      box.castShadow = true;
      box.receiveShadow = true;
      this.group.add(box);
    }
  }

  /** A red and white banded tower with a lamp room on top. */
  private addLighthouse(x: number, z: number): void {
    const tower = new THREE.Group();
    const BANDS = 5;
    const BAND_HEIGHT = 4.2;
    for (let i = 0; i < BANDS; i++) {
      // The tower narrows as it goes up: each band is a cut-off cone.
      const bottom = 2.4 - i * 0.2;
      const band = new THREE.Mesh(
        new THREE.CylinderGeometry(bottom - 0.2, bottom, BAND_HEIGHT, 16),
        new THREE.MeshStandardMaterial({ color: i % 2 === 0 ? 0xc62828 : 0xf5f5f5, roughness: 0.8 }),
      );
      band.position.y = BAND_HEIGHT * (i + 0.5);
      band.castShadow = true;
      tower.add(band);
    }
    const lamp = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.1, 2, 12),
      new THREE.MeshStandardMaterial({ color: 0xfff3b0, emissive: 0xffe066, emissiveIntensity: 0.6 }),
    );
    lamp.position.y = BANDS * BAND_HEIGHT + 1;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.4, 1.2, 12), new THREE.MeshStandardMaterial({ color: 0x7a1c1c }));
    roof.position.y = BANDS * BAND_HEIGHT + 2.6;
    tower.add(lamp, roof);
    tower.position.set(x, 0, z);
    this.group.add(tower);
  }
}

/** One mesh that fills all the given outlines with a colour. */
function flatShapes(outlines: number[][], colour: number, layer: number): THREE.Mesh {
  const shapes = outlines.map((p) => {
    // THREE.Shape is a 2D drawing in x/y. We draw with y = -z, then lay the
    // result flat below, which turns that y back into our z.
    const shape = new THREE.Shape();
    shape.moveTo(p[0], -p[1]);
    for (let i = 2; i < p.length; i += 2) shape.lineTo(p[i], -p[i + 1]);
    return shape;
  });
  // ShapeGeometry cuts each outline into triangles for us ("triangulation"),
  // because a graphics card can only draw triangles.
  const geometry = new THREE.ShapeGeometry(shapes);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, flatMaterial(colour, layer));
  mesh.position.y = 0.004 * layer;
  mesh.receiveShadow = true;
  return mesh;
}
