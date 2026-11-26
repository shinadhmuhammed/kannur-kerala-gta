import * as THREE from "three";
import type { BuildingData } from "./buildings";
import type { LandData } from "./land";
import { pointInOutline } from "./mapData";
import { randomPerson } from "./personModel";
import { tileTexture, wallTexture } from "./textures";

// Kannur railway station, built by hand on top of the real map data.
//
// From OpenStreetMap we know exactly WHERE things are: the outline of the
// station building, the two platforms (platform 1 beside the building, and
// the island with platforms 2 and 3), the tracks, and the two footbridges.
// What they LOOK like is modelled here in the usual style of a Kerala
// station: raised platforms with sheet-roof shelters on steel pillars, yellow
// name boards in Malayalam, Hindi and English, covered footbridges with
// stairs, and a cream building with a tiled roof.
//
// Everything is placed in the station's own directions instead of north and
// east, because the tracks run diagonally across the map:
//   s = metres ALONG the tracks      (the group's local x)
//   n = metres ACROSS the tracks     (the group's local z)
// One rotated group (`local`) holds all the parts, so inside this file a
// platform is simply "from s = -120 to s = 150".

const PLATFORM_HEIGHT = 0.6; // metres above the rails' ground
const DECK = 6.8; // height of a footbridge's floor: clear of trains and wires
const DECK_WIDTH = 3.2;
const STAIR_WIDTH = 2.4;
const STAIR_RUN = 17; // metres along the ground from bottom step to top

// The footbridges, from the map (game metres): the two ends of each deck.
const BRIDGE_SOUTH = { a: [136.7, -246.0], b: [173.2, -286.0] }; // platform 1 -> island -> east side
const BRIDGE_NORTH = { a: [308.5, -86.3], b: [322.5, -101.4] }; // platform 1 -> island

// Colours.
const CREAM = 0xf1e2b8;
const MAROON = 0x8a3a2c;
const STEEL = 0x55626b;
const SHEET = 0x8296a1; // roofing sheets
const CONCRETE = 0xb9b6ae;

const NAME = ["കണ്ണൂർ", "कण्णूर", "KANNUR"]; // Malayalam, Hindi, English

/** A rectangle in station directions. */
interface Rect { s0: number; s1: number; n0: number; n1: number }
const inside = (r: Rect, s: number, n: number) => s >= r.s0 && s <= r.s1 && n >= r.n0 && n <= r.n1;

/** A staircase: a ramp, as far as walking is concerned. */
interface Stair { rect: Rect; bottomS: number; topS: number; bottomY: number }

export class Station {
  /** Add this to the scene. */
  readonly group = new THREE.Group();

  private readonly local = new THREE.Group();
  private readonly people = new THREE.Group();
  private readonly ux: number; // direction along the tracks, as a unit arrow
  private readonly uz: number;
  private readonly platforms: number[][];
  private readonly decks: Rect[] = [];
  private readonly stairs: Stair[] = [];
  private readonly centre: { x: number; z: number };

  constructor(land: LandData, buildings: BuildingData) {
    this.platforms = land.platforms;
    const stop = land.trainStops.find((t) => t.platform === "1") ?? land.trainStops[0];
    this.centre = { x: stop.x, z: stop.z };

    // --- Which way do the tracks run? ----------------------------------------
    // Take the piece of rail nearest to where trains stop.
    let best = Infinity;
    let ux = 1, uz = 0;
    for (const line of land.rails) {
      for (let i = 0; i + 3 < line.length; i += 2) {
        const mx = (line[i] + line[i + 2]) / 2, mz = (line[i + 1] + line[i + 3]) / 2;
        const d = Math.hypot(mx - stop.x, mz - stop.z);
        const len = Math.hypot(line[i + 2] - line[i], line[i + 3] - line[i + 1]);
        if (d < best && len > 5) {
          best = d;
          ux = (line[i + 2] - line[i]) / len;
          uz = (line[i + 3] - line[i + 1]) / len;
        }
      }
    }
    if (ux < 0) { ux = -ux; uz = -uz; } // always point the same way (north-east)
    this.ux = ux;
    this.uz = uz;
    // Turning the group by this angle makes its x axis lie along the tracks.
    this.local.rotation.y = Math.atan2(-uz, ux);
    this.group.add(this.local, this.raisedPlatforms());
    this.local.add(this.people);

    // --- Platforms in station directions --------------------------------------
    // Platform 1 is the one whose outline is nearest the station building.
    const building = buildings.buildings.find((b) => b.kind === "train_station");
    const outlines = this.platforms.map((p) => this.toLocalOutline(p));
    const stopN = this.toLocal(stop.x, stop.z)[1];
    // Sort by distance across the tracks from platform 1's track.
    const crossAt = (outline: number[], s: number) => crossings(outline, s).slice(0, 2);
    const stopS = this.toLocal(stop.x, stop.z)[0];
    outlines.sort((a, b) => Math.abs(crossAt(a, stopS)[0] - stopN) - Math.abs(crossAt(b, stopS)[0] - stopN));
    const [one, island] = outlines;
    // Which side of platform 1's track is platform 1 on? (+1 or -1 across.)
    const side = Math.sign((crossAt(one, stopS)[0] + crossAt(one, stopS)[1]) / 2 - stopN);

    // --- Footbridges -----------------------------------------------------------
    const south = this.bridgeLine(BRIDGE_SOUTH);
    const north = this.bridgeLine(BRIDGE_NORTH);
    const islandMid = (s: number) => {
      const c = crossAt(island, s);
      return (c[0] + c[1]) / 2;
    };
    const oneMid = (s: number) => {
      const c = crossAt(one, s);
      return (c[0] + c[1]) / 2;
    };
    // South bridge: stairs down to platform 1, to the island, and to the
    // ground on the far (east) side of all the tracks.
    this.addFootbridge(south.s, south.n0, south.n1, [
      { n: oneMid(south.s), towards: 1, bottomY: PLATFORM_HEIGHT },
      { n: islandMid(south.s), towards: 1, bottomY: PLATFORM_HEIGHT },
      { n: side > 0 ? south.n0 + 1.2 : south.n1 - 1.2, towards: 1, bottomY: 0 },
    ]);
    // North bridge: only between platform 1 and the island.
    this.addFootbridge(north.s, Math.min(islandMid(north.s), oneMid(north.s)) - 1.4, Math.max(islandMid(north.s), oneMid(north.s)) + 1.4, [
      { n: oneMid(north.s), towards: 1, bottomY: PLATFORM_HEIGHT },
      { n: islandMid(north.s), towards: -1, bottomY: PLATFORM_HEIGHT },
    ]);

    // --- Shelters, boards, benches, people -------------------------------------
    // The shelters stop short of the stairs, which rise through the roof line.
    const gaps = this.stairs.map((st) => [Math.min(st.bottomS, st.topS) - 3, Math.max(st.bottomS, st.topS) + 4] as const);
    const ranges = (from: number, to: number, n: (s: number) => number): [number, number][] => {
      // Cut [from, to] at every staircase standing on this platform.
      let parts: [number, number][] = [[from, to]];
      this.stairs.forEach((st, i) => {
        if (Math.abs((st.rect.n0 + st.rect.n1) / 2 - n(st.topS)) > 3) return; // not on this platform
        const [g0, g1] = gaps[i];
        parts = parts.flatMap(([a, b]) => (g1 <= a || g0 >= b ? [[a, b]] : [[a, g0], [g1, b]])) as [number, number][];
      });
      return parts.filter(([a, b]) => b - a > 12);
    };
    for (const [from, to] of ranges(stopS - 60, stopS + 215, oneMid)) this.addShelter(one, from, to, "lean", side);
    for (const [from, to] of ranges(stopS - 60, stopS + 215, islandMid)) this.addShelter(island, from, to, "butterfly", side);

    for (const s of [stopS - 150, stopS + 150, stopS + 330]) {
      // On platform 1 the board stands at the back, on the island in the middle.
      const c1 = crossAt(one, s);
      if (c1.length === 2) this.addNameBoard(s, side > 0 ? c1[1] - 0.5 : c1[0] + 0.5);
      const c2 = crossAt(island, s);
      if (c2.length === 2) this.addNameBoard(s, (c2[0] + c2[1]) / 2);
    }
    for (let s = stopS - 30; s < stopS + 200; s += 55) {
      this.addHangingSign("1", s, oneMid(s));
      this.addHangingSign("2   |   3", s, islandMid(s));
    }
    this.addPeople(one, island, stopS - 40, stopS + 200);

    if (building) this.addBuilding(this.toLocalOutline(building.points), side);
  }

  // === Used by the game loop ===================================================

  /** Show the platform crowd only when you are near: people are costly to draw. */
  update(x: number, z: number): void {
    this.people.visible = Math.hypot(x - this.centre.x, z - this.centre.z) < 420;
  }

  /**
   * How high the floor is at this spot, for someone standing at height `y`.
   * `y` matters because a footbridge has two floors, one above the other:
   * you are only ON the bridge if you climbed its stairs.
   */
  heightAt(x: number, z: number, y: number): number {
    const [s, n] = this.toLocal(x, z);
    if (y > DECK - 1.5 && this.decks.some((d) => inside(d, s, n))) return DECK;
    for (const stair of this.stairs) {
      if (!inside(stair.rect, s, n)) continue;
      const h = stairHeight(stair, s);
      if (Math.abs(h - y) < 1.3) return h; // you are on this part of the stairs
    }
    return this.onPlatform(x, z) ? PLATFORM_HEIGHT : 0;
  }

  /** Stops someone on foot walking off a bridge, or through the side of a staircase. */
  blocksWalker(x: number, z: number, y: number): boolean {
    const [s, n] = this.toLocal(x, z);
    const stair = this.stairs.find((st) => inside(st.rect, s, n));
    if (y > 2.5) {
      // Up high: the only places to stand are the deck and the stairs.
      if (this.decks.some((d) => inside(d, s, n))) return false;
      return !(stair && Math.abs(stairHeight(stair, s) - y) < 1.3);
    }
    // On the ground: the low end of a staircase is solid from the side.
    if (stair) {
      const above = stairHeight(stair, s) - y;
      return above >= 1.3 && above < 2.4;
    }
    return false;
  }

  /** Vehicles cannot climb onto a platform or drive through the east stairs. */
  blocksVehicle(x: number, z: number): boolean {
    if (this.onPlatform(x, z)) return true;
    const [s, n] = this.toLocal(x, z);
    return this.stairs.some((st) => st.bottomY === 0 && inside(st.rect, s, n));
  }

  private onPlatform(x: number, z: number): boolean {
    return this.platforms.some((p) => pointInOutline(x, z, p));
  }

  // === Building blocks =========================================================

  /** A map point in station directions: [along the tracks, across them]. */
  private toLocal(x: number, z: number): [number, number] {
    return [x * this.ux + z * this.uz, -x * this.uz + z * this.ux];
  }

  private toLocalOutline(points: number[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < points.length; i += 2) out.push(...this.toLocal(points[i], points[i + 1]));
    return out;
  }

  /** A footbridge from the map: where along the tracks it is, and how far across it reaches. */
  private bridgeLine(bridge: { a: number[]; b: number[] }): { s: number; n0: number; n1: number } {
    const [sa, na] = this.toLocal(bridge.a[0], bridge.a[1]);
    const [sb, nb] = this.toLocal(bridge.b[0], bridge.b[1]);
    return { s: (sa + sb) / 2, n0: Math.min(na, nb) - 1.4, n1: Math.max(na, nb) + 1.4 };
  }

  /** A box in station directions. x = along the tracks, z = across. */
  private box(sLen: number, height: number, nLen: number, colour: number | THREE.Material, s: number, y: number, n: number, shadow = true): THREE.Mesh {
    const material = typeof colour === "number" ? paint(colour) : colour;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sLen, height, nLen), material);
    mesh.position.set(s, y, n);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    this.local.add(mesh);
    return mesh;
  }

  /** The platforms, pushed up from flat outlines into low concrete blocks. */
  private raisedPlatforms(): THREE.Mesh {
    const shapes = this.platforms.map((p) => {
      // Drawn with y = -z and then laid flat, as in land.ts.
      const shape = new THREE.Shape();
      shape.moveTo(p[0], -p[1]);
      for (let i = 2; i < p.length; i += 2) shape.lineTo(p[i], -p[i + 1]);
      return shape;
    });
    const geometry = new THREE.ExtrudeGeometry(shapes, { depth: PLATFORM_HEIGHT, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2); // the push-out direction becomes "up"
    const mesh = new THREE.Mesh(geometry, paint(CONCRETE, 0.95));
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return mesh;
  }

  /**
   * A covered footbridge across the tracks at `s`, from n0 to n1, with
   * stairs. Each stair leaves the deck at `n` and goes down along the tracks
   * (`towards` = +1 or -1) to `bottomY`.
   */
  private addFootbridge(s: number, n0: number, n1: number, stairs: { n: number; towards: number; bottomY: number }[]): void {
    const length = n1 - n0;
    const mid = (n0 + n1) / 2;
    this.decks.push({ s0: s - DECK_WIDTH / 2, s1: s + DECK_WIDTH / 2, n0, n1 });

    this.box(DECK_WIDTH, 0.3, length, CONCRETE, s, DECK - 0.15, mid); // floor
    for (const edge of [-1, 1]) {
      // Solid side panels up to waist height, then a roof on thin posts.
      this.box(0.1, 1.1, length, 0x4f7186, s + (edge * DECK_WIDTH) / 2, DECK + 0.55, mid);
      for (let n = n0 + 0.3; n <= n1; n += 4.5) this.box(0.1, 1.5, 0.1, STEEL, s + (edge * DECK_WIDTH) / 2, DECK + 1.85, n, false);
    }
    this.box(DECK_WIDTH + 0.8, 0.12, length + 0.6, SHEET, s, DECK + 2.65, mid); // roof

    // Legs: a pair under each end and under every staircase's landing.
    const legs = new Set([n0 + 0.4, n1 - 0.4, ...stairs.map((st) => st.n)]);
    for (const n of legs) {
      for (const edge of [-1, 1]) this.box(0.35, DECK - 0.3, 0.35, STEEL, s + edge * (DECK_WIDTH / 2 - 0.2), (DECK - 0.3) / 2, n);
    }

    for (const st of stairs) {
      const topS = s + (st.towards * DECK_WIDTH) / 2;
      const bottomS = topS + st.towards * STAIR_RUN;
      this.stairs.push({
        rect: { s0: Math.min(topS, bottomS), s1: Math.max(topS, bottomS), n0: st.n - STAIR_WIDTH / 2, n1: st.n + STAIR_WIDTH / 2 },
        bottomS, topS, bottomY: st.bottomY,
      });
      this.addStairModel(bottomS, topS, st.n, st.bottomY);
    }
  }

  /** Steps and side rails for one staircase. */
  private addStairModel(bottomS: number, topS: number, n: number, bottomY: number): void {
    const rise = DECK - bottomY;
    const STEPS = Math.round(rise / 0.19);
    const run = (topS - bottomS) / STEPS;
    // All the steps are one "instanced" mesh: the same box drawn many times
    // in one go, each with its own position.
    const steps = new THREE.InstancedMesh(new THREE.BoxGeometry(Math.abs(run) + 0.02, 0.19, STAIR_WIDTH), paint(CONCRETE), STEPS);
    const at = new THREE.Matrix4();
    for (let i = 0; i < STEPS; i++) {
      at.makeTranslation(bottomS + run * (i + 0.5), bottomY + (rise * (i + 0.5)) / STEPS, n);
      steps.setMatrixAt(i, at);
    }
    steps.castShadow = true;
    steps.receiveShadow = true;
    this.local.add(steps);

    // Side rails: long thin boxes, tilted to the slope of the stairs.
    const slope = Math.atan2(rise, topS - bottomS);
    const long = Math.hypot(rise, topS - bottomS);
    for (const edge of [-1, 1]) {
      const rail = this.box(long, 1.0, 0.08, 0x4f7186, (bottomS + topS) / 2, bottomY + rise / 2 + 0.6, n + (edge * STAIR_WIDTH) / 2);
      rail.rotation.z = slope;
    }
  }

  /**
   * A roof over part of a platform, on steel pillars.
   *   "lean"      one slope, high at the back wall: platform 1
   *   "butterfly" a V, low in the middle: the island platform
   */
  private addShelter(outline: number[], from: number, to: number, kind: "lean" | "butterfly", side: number): void {
    const STEP = 6;
    const positions: number[] = [];
    const indices: number[] = [];
    const pillarSpots: [number, number][] = [];
    const benchSpots: [number, number][] = [];
    let rows = 0;
    let across = 0; // corner points across the roof at each step

    for (let s = from; s <= to + 0.01; s += STEP, rows++) {
      const c = crossings(outline, s).slice(0, 2);
      if (c.length < 2) break;
      // "front" is the edge next to the track, "back" the other edge.
      const [lo, hi] = c;
      const mid = (lo + hi) / 2;
      if (kind === "butterfly") {
        positions.push(s, PLATFORM_HEIGHT + 4.3, lo - 0.2, s, PLATFORM_HEIGHT + 3.7, mid, s, PLATFORM_HEIGHT + 4.3, hi + 0.2);
        across = 3;
        if (rows % 2 === 0) pillarSpots.push([s, mid]);
        if (rows % 4 === 1) benchSpots.push([s, mid]);
      } else {
        const front = side > 0 ? lo : hi;
        const back = side > 0 ? hi : lo;
        positions.push(s, PLATFORM_HEIGHT + 3.8, front - side * 0.3, s, PLATFORM_HEIGHT + 4.5, back);
        across = 2;
        if (rows % 2 === 0) pillarSpots.push([s, front + side * 0.9]);
        if (rows % 4 === 1) benchSpots.push([s, back - side * 0.7]);
      }
    }
    // Join each row of corner points to the next with two triangles per strip.
    for (let r = 0; r < rows - 1; r++) {
      for (let k = 0; k < across - 1; k++) {
        const a = r * across + k;
        indices.push(a, a + 1, a + across, a + 1, a + across + 1, a + across);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    // DoubleSide: you see a roof from above and from underneath.
    const roof = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: SHEET, roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide }));
    roof.castShadow = true;
    roof.receiveShadow = true;
    this.local.add(roof);

    const at = new THREE.Matrix4();
    const pillars = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 4.1, 0.22), paint(STEEL), pillarSpots.length);
    pillarSpots.forEach(([s, n], i) => pillars.setMatrixAt(i, at.makeTranslation(s, PLATFORM_HEIGHT + 2.05, n)));
    pillars.castShadow = true;
    const seats = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 0.1, 0.5), paint(0x2f5f8a), benchSpots.length);
    const backs = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 0.5, 0.08), paint(0x2f5f8a), benchSpots.length);
    benchSpots.forEach(([s, n], i) => {
      seats.setMatrixAt(i, at.makeTranslation(s + 2, PLATFORM_HEIGHT + 0.45, n));
      backs.setMatrixAt(i, at.makeTranslation(s + 2, PLATFORM_HEIGHT + 0.75, n + 0.25));
    });
    this.local.add(pillars, seats, backs);
  }

  /** The yellow station name board on two posts, readable from both sides. */
  private addNameBoard(s: number, n: number): void {
    const WIDTH = 4.8, HEIGHT = 2.2;
    const y = PLATFORM_HEIGHT + 2.5;
    for (const turn of [0, Math.PI]) {
      const face = textPlane(WIDTH, HEIGHT, (c, w, h) => {
        c.fillStyle = "#f6c416";
        c.fillRect(0, 0, w, h);
        c.strokeStyle = "#111111";
        c.lineWidth = 14;
        c.strokeRect(7, 7, w - 14, h - 14);
        c.fillStyle = "#111111";
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.font = `700 ${h * 0.27}px system-ui, sans-serif`;
        c.fillText(NAME[0], w / 2, h * 0.2);
        c.fillText(NAME[1], w / 2, h * 0.5);
        c.font = `800 ${h * 0.25}px system-ui, sans-serif`;
        c.fillText(NAME[2], w / 2, h * 0.8);
      });
      face.position.set(s, y, n + (turn ? -0.03 : 0.03));
      face.rotation.y = turn;
      this.local.add(face);
    }
    for (const edge of [-1, 1]) this.box(0.14, 3.4, 0.14, 0x222222, s + edge * (WIDTH / 2 - 0.3), PLATFORM_HEIGHT + 1.7, n);
  }

  /** A small blue platform-number sign hanging across the platform. */
  private addHangingSign(text: string, s: number, n: number): void {
    for (const turn of [Math.PI / 2, -Math.PI / 2]) {
      const sign = textPlane(1.9, 0.6, (c, w, h) => {
        c.fillStyle = "#12356b";
        c.fillRect(0, 0, w, h);
        c.fillStyle = "#ffffff";
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.font = `700 ${h * 0.62}px system-ui, sans-serif`;
        c.fillText(text, w / 2, h / 2 + 2);
      });
      sign.position.set(s + (turn > 0 ? 0.02 : -0.02), PLATFORM_HEIGHT + 3.2, n);
      sign.rotation.y = turn; // across the platform, so you read it walking along
      this.local.add(sign);
    }
  }

  /** People standing about on the platforms, waiting for a train. */
  private addPeople(one: number[], island: number[], from: number, to: number): void {
    // A fixed "random" sequence, so the same people stand in the same places
    // every time the game loads.
    let seed = 20261;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 26; i++) {
      const outline = i % 2 ? one : island;
      const s = from + random() * (to - from);
      const c = crossings(outline, s).slice(0, 2);
      if (c.length < 2) continue;
      const n = c[0] + 1.2 + random() * Math.max(0.1, c[1] - c[0] - 2.4);
      if (this.stairs.some((st) => inside(st.rect, s, n))) continue; // not on the steps
      const person = randomPerson(random).group;
      person.position.set(s, PLATFORM_HEIGHT, n);
      person.rotation.y = random() * Math.PI * 2;
      this.people.add(person);
    }
  }

  /**
   * The station building: a long two-floor block along platform 1, with
   * wings towards the road. The middle wing is the entrance, with a porch
   * and the station's name above it.
   */
  private addBuilding(outline: number[], side: number): void {
    // Read the block and its wings off the outline. Its long walls run along
    // the tracks, so they are the edges where `n` hardly changes.
    const count = outline.length / 2;
    const walls: { s0: number; s1: number; n: number }[] = [];
    let sMin = Infinity, sMax = -Infinity;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      const s0 = outline[i * 2], n0 = outline[i * 2 + 1], s1 = outline[j * 2], n1 = outline[j * 2 + 1];
      sMin = Math.min(sMin, s0);
      sMax = Math.max(sMax, s0);
      if (Math.abs(n1 - n0) < 1.5 && Math.abs(s1 - s0) > 3) walls.push({ s0: Math.min(s0, s1), s1: Math.max(s0, s1), n: (n0 + n1) / 2 });
    }
    // `out` measures distance from the platform towards the road.
    const out = (n: number) => side * n;
    const platformWall = Math.min(...walls.map((w) => out(w.n)));
    const depths = walls.map((w) => out(w.n) - platformWall).filter((d) => d > 3).sort((a, b) => a - b);
    const depth = depths[0] ?? 10; // the main block's depth
    const wings = walls.filter((w) => out(w.n) - platformWall > depth + 1);
    const HEIGHT = 7.4;

    const walled = (sLen: number, height: number, nLen: number, s: number, n: number): void => {
      this.local.add(texturedBlock(sLen, height, nLen, s, n));
      this.box(sLen + 0.3, 1.0, nLen + 0.3, MAROON, s, 0.5, n, false); // painted band at the foot
    };
    const backN = (d: number) => side * (platformWall + d); // "d metres towards the road" as an n

    // Main block and its long tiled roof.
    const length = sMax - sMin;
    walled(length, HEIGHT, depth, (sMin + sMax) / 2, backN(depth / 2));
    const tiles = tileTexture().clone();
    tiles.repeat.set(1 / 2.5, 1 / 2.5);
    tiles.needsUpdate = true;
    const tileRoof = new THREE.MeshStandardMaterial({ map: tiles, color: 0xb5523b, roughness: 0.8 });
    const gable = new THREE.Shape();
    gable.moveTo(-depth / 2 - 0.9, 0);
    gable.lineTo(depth / 2 + 0.9, 0);
    gable.lineTo(0, 2.8);
    const roofShape = new THREE.ExtrudeGeometry(gable, { depth: length + 1.4, bevelEnabled: false });
    roofShape.rotateY(Math.PI / 2); // the push-out direction now runs along the tracks
    const roof = new THREE.Mesh(roofShape, tileRoof);
    roof.position.set(sMin - 0.7, HEIGHT, backN(depth / 2));
    roof.castShadow = true;
    this.local.add(roof);

    // Wings. The widest one is the entrance.
    const entrance = wings.reduce<(typeof wings)[number] | null>((a, w) => (!a || w.s1 - w.s0 > a.s1 - a.s0 ? w : a), null);
    for (const wing of wings) {
      const reach = out(wing.n) - platformWall - depth;
      const width = wing.s1 - wing.s0;
      const tall = wing === entrance ? HEIGHT + 1.6 : HEIGHT;
      const s = (wing.s0 + wing.s1) / 2;
      const n = backN(depth + reach / 2);
      walled(width, tall, reach, s, n);
      // A four-sided tiled roof: a pyramid stretched to fit the wing.
      const pyramid = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4);
      pyramid.rotateY(Math.PI / 4);
      const top = new THREE.Mesh(pyramid, tileRoof);
      top.scale.set(width + 1.4, 2.6, reach + 1.4);
      top.position.set(s, tall + 1.3, n);
      top.castShadow = true;
      this.local.add(top);
    }

    if (entrance) {
      // The porch: a slab on four pillars, and the name board above it.
      const s = (entrance.s0 + entrance.s1) / 2;
      const reach = out(entrance.n) - platformWall;
      const width = Math.min(entrance.s1 - entrance.s0 - 2, 16);
      this.box(width, 0.35, 5, 0xe9e4d6, s, 4.4, backN(reach + 2.5));
      for (const a of [-1, 1]) for (const b of [0.6, 4.4]) this.box(0.5, 4.3, 0.5, 0xe9e4d6, s + a * (width / 2 - 0.6), 2.15, backN(reach + b));
      const board = textPlane(width - 1, 1.9, (c, w, h) => {
        c.fillStyle = "#12356b";
        c.fillRect(0, 0, w, h);
        c.fillStyle = "#ffffff";
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.font = `700 ${h * 0.5}px system-ui, sans-serif`;
        c.fillText(NAME.join("     "), w / 2, h / 2 + 4);
      });
      board.position.set(s, 5.6, backN(reach + 5.05));
      board.rotation.y = side > 0 ? 0 : Math.PI; // facing the road
      this.local.add(board);
    }
  }
}

// === Helpers ====================================================================

const paints = new Map<string, THREE.MeshStandardMaterial>();
/** One shared material per colour: fewer materials, faster drawing. */
function paint(colour: number, roughness = 0.85): THREE.MeshStandardMaterial {
  const key = `${colour}/${roughness}`;
  let m = paints.get(key);
  if (!m) paints.set(key, (m = new THREE.MeshStandardMaterial({ color: colour, roughness })));
  return m;
}

function stairHeight(stair: Stair, s: number): number {
  const t = THREE.MathUtils.clamp((s - stair.bottomS) / (stair.topS - stair.bottomS), 0, 1);
  return stair.bottomY + (DECK - stair.bottomY) * t;
}

/**
 * Where the line "s metres along the tracks" cuts an outline given in
 * station directions [s0, n0, s1, n1, ...]: the n values, smallest first.
 * For a platform that is its two edges, so we know its middle and width.
 */
function crossings(outline: number[], s: number): number[] {
  const found: number[] = [];
  const count = outline.length / 2;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const sa = outline[i * 2] - s, sb = outline[j * 2] - s;
    if (sa > 0 === sb > 0) continue; // both ends on the same side: no cut
    const t = sa / (sa - sb);
    found.push(outline[i * 2 + 1] + (outline[j * 2 + 1] - outline[i * 2 + 1]) * t);
  }
  return found.sort((a, b) => a - b);
}

/** A flat board with something drawn on it, as on a web page canvas. */
function textPlane(width: number, height: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void): THREE.Mesh {
  const canvas = document.createElement("canvas");
  canvas.height = 256;
  canvas.width = Math.round((256 * width) / height);
  draw(canvas.getContext("2d")!, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.7 }));
}

let wallPaint: THREE.MeshStandardMaterial | null = null;
/**
 * A block with the game's window texture on its four walls. The texture is
 * one window wide and one floor tall, so it is repeated to fit the wall.
 */
function texturedBlock(sLen: number, height: number, nLen: number, s: number, n: number): THREE.Mesh {
  const BAY = 3.4, FLOOR = 3.7;
  const geometry = new THREE.BoxGeometry(sLen, height, nLen);
  const uv = geometry.getAttribute("uv");
  // A box has 6 faces of 4 corners each, in the order +x, -x, +y, -y, +z, -z.
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 4);
    if (face === 2 || face === 3) continue; // top and bottom are hidden
    const wide = face < 2 ? nLen : sLen;
    uv.setXY(i, uv.getX(i) * Math.max(1, Math.round(wide / BAY)), uv.getY(i) * Math.round(height / FLOOR));
  }
  wallPaint ??= new THREE.MeshStandardMaterial({ map: wallTexture(), color: CREAM, roughness: 0.9 });
  const mesh = new THREE.Mesh(geometry, wallPaint);
  mesh.position.set(s, height / 2, n);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
