import * as THREE from "three";
import type { LandData } from "./land";

// The railway: a train that runs on the real tracks through Kannur station,
// and the overhead wires above the main line.
//
// A train comes in from the edge of the map, slows down, stops at the
// platform for half a minute, and leaves the other way. Then, after a pause,
// one comes the other way on the next track. If you (or one of your
// vehicles) are on the line ahead, the driver brakes and waits.
//
// How a train follows the track: the track is a long line of points (a
// "path"). The train only remembers ONE number, how many metres along the
// path its front is. Each coach is then placed a fixed number of metres
// behind the front, and turned to face along the track there.

const CRUISE = 22; // m/s, about 80 km/h
const DWELL = 28; // seconds stopped at the platform
const PAUSE = 40; // seconds between one train leaving the map and the next
const HALF_WIDTH = 1.55; // metres from a coach's middle to its side
const COACHES = 9;
const COACH = 21.3; // length of a coach
const LOCO = 19;
const GAP = 0.7; // between two vehicles
const EDGE = 2350; // the path is cut this far from the map's centre

/** A line of points with a "how far along" for each, so we can ask for any spot. */
class Path {
  readonly length: number;
  private readonly far: number[] = [0]; // metres from the start to each point

  constructor(readonly points: number[]) {
    for (let i = 2; i < points.length; i += 2) {
      this.far.push(this.far[this.far.length - 1] + Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]));
    }
    this.length = this.far[this.far.length - 1];
  }

  /** The spot `s` metres along, and the direction the track runs there. */
  at(s: number): { x: number; z: number; heading: number } {
    const p = this.points;
    const last = this.far.length - 1;
    // Find the piece that contains s. Halving the search each time
    // ("binary search") finds it in a few steps even on a long path.
    let lo = 0, hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.far[mid] <= s) lo = mid;
      else hi = mid;
    }
    const piece = this.far[hi] - this.far[lo] || 1;
    const t = (s - this.far[lo]) / piece; // may be below 0 or above 1: carries on straight
    const dx = p[hi * 2] - p[lo * 2], dz = p[hi * 2 + 1] - p[lo * 2 + 1];
    return { x: p[lo * 2] + dx * t, z: p[lo * 2 + 1] + dz * t, heading: Math.atan2(dx, dz) };
  }

  /** How far along the path is the point nearest to (x, z)? */
  nearest(x: number, z: number): number {
    const p = this.points;
    let best = Infinity, bestS = 0;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const dx = p[i + 2] - p[i], dz = p[i + 3] - p[i + 1];
      const len2 = dx * dx + dz * dz || 1;
      const t = THREE.MathUtils.clamp(((x - p[i]) * dx + (z - p[i + 1]) * dz) / len2, 0, 1);
      const d = Math.hypot(p[i] + dx * t - x, p[i + 1] + dz * t - z);
      if (d < best) {
        best = d;
        bestS = this.far[i / 2] + Math.sqrt(len2) * t;
      }
    }
    return bestS;
  }
}

/**
 * The map stores a track as many separate pieces. Join the pieces that pass
 * through (x, z) into one long line: start with the nearest piece, then keep
 * adding whichever piece continues most nearly straight on. At a switch
 * that picks the line that carries straight on.
 */
function joinTrack(rails: number[][], x: number, z: number): number[] {
  let start = 0, best = Infinity;
  rails.forEach((line, n) => {
    for (let i = 0; i + 3 < line.length; i += 2) {
      const dx = line[i + 2] - line[i], dz = line[i + 3] - line[i + 1];
      const t = THREE.MathUtils.clamp(((x - line[i]) * dx + (z - line[i + 1]) * dz) / (dx * dx + dz * dz || 1), 0, 1);
      const d = Math.hypot(line[i] + dx * t - x, line[i + 1] + dz * t - z);
      if (d < best) { best = d; start = n; }
    }
  });
  const used = new Set([start]);
  const reverse = (line: number[]) => {
    const out: number[] = [];
    for (let i = line.length - 2; i >= 0; i -= 2) out.push(line[i], line[i + 1]);
    return out;
  };
  const grow = (chain: number[]): number[] => {
    for (;;) {
      const n = chain.length;
      const ex = chain[n - 2], ez = chain[n - 1];
      const dirX = ex - chain[n - 4], dirZ = ez - chain[n - 3];
      const dirLen = Math.hypot(dirX, dirZ) || 1;
      let next: number[] | null = null, nextIndex = -1, straightest = 0.8; // 0.8 = at most ~35 degrees off
      rails.forEach((line, i) => {
        if (used.has(i)) return;
        // Tracks do not only meet end to end: at a switch one track ends
        // part-way along another. So look for ANY point of the other piece
        // that touches our end, and try carrying on from there both ways.
        for (let k = 0; k < line.length; k += 2) {
          if (Math.hypot(line[k] - ex, line[k + 1] - ez) > 0.3) continue;
          for (const candidate of [line.slice(k), reverse(line.slice(0, k + 2))]) {
            if (candidate.length < 4) continue;
            const cx = candidate[2] - candidate[0], cz = candidate[3] - candidate[1];
            const straight = (cx * dirX + cz * dirZ) / ((Math.hypot(cx, cz) || 1) * dirLen);
            if (straight > straightest) { straightest = straight; next = candidate; nextIndex = i; }
          }
        }
      });
      if (!next) return chain;
      used.add(nextIndex);
      chain.push(...(next as number[]).slice(2));
    }
  };
  // Grow from the far end, turn the whole thing round, and grow again.
  const whole = grow(reverse(grow([...rails[start]])));
  // Keep only the part near the map: the real line runs on for kilometres.
  const kept: number[] = [];
  for (let i = 0; i < whole.length; i += 2) {
    if (Math.abs(whole[i]) < EDGE && Math.abs(whole[i + 1]) < EDGE) kept.push(whole[i], whole[i + 1]);
    else if (kept.length) break;
  }
  return kept;
}

interface Service {
  path: Path;
  stopAt: number; // where the FRONT of the train is when it has stopped
}

export class Train {
  /** Add this to the scene. */
  readonly group = new THREE.Group();

  private readonly cars: { mesh: THREE.Group; length: number; behind: number }[] = [];
  private readonly trainLength: number;
  private readonly services: Service[] = [];
  private current = 0;
  private phase: "waiting" | "arriving" | "stopped" | "leaving" = "waiting";
  private timer = 3; // seconds left in "waiting" or "stopped"
  private front = 0; // metres along the path
  /** Metres per second. */
  speed = 0;

  constructor(land: LandData) {
    // --- The train: a locomotive and coaches ----------------------------------
    const train = new THREE.Group();
    let behind = 0; // metres from the train's front to this vehicle's middle
    const add = (mesh: THREE.Group, length: number): void => {
      this.cars.push({ mesh, length, behind: behind + length / 2 });
      behind += length + GAP;
      train.add(mesh);
    };
    add(buildLoco(), LOCO);
    const sides = coachSides();
    for (let i = 0; i < COACHES; i++) add(buildCoach(sides), COACH);
    this.trainLength = behind - GAP;
    train.visible = false;
    this.group.add(train);
    this.train = train;

    // --- The tracks trains use: platforms 1 and 2 ------------------------------
    const paths: Path[] = [];
    for (const [platform, backwards] of [["1", false], ["2", true]] as const) {
      const stop = land.trainStops.find((t) => t.platform === platform);
      if (!stop) continue;
      let points = joinTrack(land.rails, stop.x, stop.z);
      if (points.length < 4) continue;
      if (backwards) {
        const turned: number[] = [];
        for (let i = points.length - 2; i >= 0; i -= 2) turned.push(points[i], points[i + 1]);
        points = turned;
      }
      const path = new Path(points);
      paths.push(path);
      // The stop point on the map is where the MIDDLE of the train should be.
      this.services.push({ path, stopAt: path.nearest(stop.x, stop.z) + this.trainLength / 2 });
    }
    this.group.add(buildOverhead(paths));
  }

  private readonly train: THREE.Group;

  /**
   * @param onLine things the driver must not run over: you and your vehicles
   */
  update(dt: number, onLine: { x: number; z: number }[]): void {
    const service = this.services[this.current];
    if (!service) return;

    if (this.phase === "waiting") {
      this.timer -= dt;
      if (this.timer > 0) return;
      // Start a little way out the first time, so there is a train to see
      // soon after the game starts.
      this.front = this.first ? Math.max(0, service.stopAt - 650) : 0;
      this.first = false;
      this.speed = CRUISE;
      this.phase = "arriving";
      this.train.visible = true;
    }

    // Is something on the line within stopping distance?
    const stopping = (this.speed * this.speed) / (2 * 1.6) + 18;
    let danger = false;
    for (let ahead = 2; ahead < stopping && !danger; ahead += 3) {
      const spot = service.path.at(this.front + ahead);
      danger = onLine.some((o) => Math.hypot(o.x - spot.x, o.z - spot.z) < 2.6);
    }

    if (danger) {
      this.speed = Math.max(0, this.speed - 1.8 * dt); // emergency brake
    } else if (this.phase === "arriving") {
      const left = service.stopAt - this.front;
      // The speed from which a gentle brake (0.5 m/s²) stops exactly there.
      const wanted = Math.min(CRUISE, Math.sqrt(Math.max(0, 2 * 0.5 * left)) + 0.25);
      this.speed += THREE.MathUtils.clamp(wanted - this.speed, -1.1 * dt, 0.5 * dt);
      if (left < 0.25) {
        this.speed = 0;
        this.phase = "stopped";
        this.timer = DWELL;
      }
    } else if (this.phase === "stopped") {
      this.timer -= dt;
      if (this.timer <= 0) this.phase = "leaving";
    } else {
      this.speed = Math.min(CRUISE, this.speed + 0.45 * dt);
      if (this.front - this.trainLength > service.path.length) {
        // Gone. The next train uses the other track.
        this.train.visible = false;
        this.phase = "waiting";
        this.timer = PAUSE;
        this.current = (this.current + 1) % this.services.length;
        return;
      }
    }
    this.front += this.speed * dt;

    for (const car of this.cars) {
      const middle = this.front - car.behind;
      // Face from the back wheels to the front wheels: smoother on curves
      // than the track's direction at the middle.
      const a = service.path.at(middle - car.length * 0.35);
      const b = service.path.at(middle + car.length * 0.35);
      car.mesh.position.set((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
      car.mesh.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
    }
  }

  private first = true;

  /** Is this spot inside the train? Stops you walking or driving through it. */
  hits(x: number, z: number): boolean {
    if (!this.train.visible) return false;
    for (const car of this.cars) {
      const dx = x - car.mesh.position.x, dz = z - car.mesh.position.z;
      if (Math.abs(dx) + Math.abs(dz) > car.length) continue; // far away: skip the sums
      const sin = Math.sin(car.mesh.rotation.y), cos = Math.cos(car.mesh.rotation.y);
      if (Math.abs(dx * sin + dz * cos) < car.length / 2 && Math.abs(dx * cos - dz * sin) < HALF_WIDTH) return true;
    }
    return false;
  }

  /**
   * The train as a row of circles, plus the track just ahead of it while it
   * moves. Traffic stops for these, like at a level crossing.
   */
  circles(): { x: number; z: number; radius: number }[] {
    const service = this.services[this.current];
    if (!service || !this.train.visible) return [];
    const out: { x: number; z: number; radius: number }[] = [];
    const ahead = this.speed > 0.5 ? 12 + this.speed * 2 : 0;
    for (let s = this.front - this.trainLength; s <= this.front + ahead; s += 3) {
      const spot = service.path.at(s);
      out.push({ x: spot.x, z: spot.z, radius: HALF_WIDTH + 0.2 });
    }
    return out;
  }
}

// === Models =======================================================================

const flat = (colour: number, roughness = 0.7) => new THREE.MeshStandardMaterial({ color: colour, roughness });
const DARK = flat(0x23262b, 0.9);

/** The dark parts under any rail vehicle: frame and two wheel sets ("bogies"). */
function addUnderframe(group: THREE.Group, length: number): void {
  const frame = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.45, length - 1.5), DARK);
  frame.position.y = 0.85;
  group.add(frame);
  for (const end of [-1, 1]) {
    const bogie = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.6, 3.6), DARK);
    bogie.position.set(0, 0.42, end * (length / 2 - 3.6));
    group.add(bogie);
  }
}

/** The picture on a coach's side: blue, with a pale band of windows and two doors. */
function coachSides(): THREE.MeshStandardMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = 2048;
  canvas.height = 256;
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#2a579c"; // Indian Railways coach blue
  c.fillRect(0, 0, 2048, 256);
  c.fillStyle = "#8fbbe6"; // the paler band the windows sit in
  c.fillRect(0, 62, 2048, 88);
  c.fillStyle = "#f3c63a"; // a thin yellow line under it
  c.fillRect(0, 158, 2048, 6);
  // Ten windows between the two doors.
  for (let i = 0; i < 10; i++) {
    const x = 250 + i * 158;
    c.fillStyle = "#16212b";
    c.fillRect(x, 74, 104, 62);
    c.fillStyle = "rgba(255,255,255,0.18)"; // the bars every sleeper coach has
    for (let bar = 1; bar < 5; bar++) c.fillRect(x, 74 + bar * 12, 104, 3);
  }
  for (const x of [70, 2048 - 70 - 84]) {
    c.fillStyle = "#1f4580";
    c.fillRect(x, 40, 84, 200);
    c.fillStyle = "#16212b";
    c.fillRect(x + 16, 64, 52, 56);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6 });
}

/** One coach. Its long side lies along z, like the cars in the game. */
function buildCoach(sides: THREE.MeshStandardMaterial): THREE.Group {
  const group = new THREE.Group();
  const blue = flat(0x2a579c, 0.6);
  // A box's six faces take six materials, in the order +x, -x, +y, -y, +z, -z.
  // The picture goes on the two long sides.
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.1, 2.75, COACH), [sides, sides, blue, blue, blue, blue]);
  body.position.y = 2.45;
  body.castShadow = true;
  // The rounded roof: a cylinder squashed flat, half sunk into the body.
  const roofShape = new THREE.CylinderGeometry(1.55, 1.55, COACH, 14);
  roofShape.rotateX(Math.PI / 2); // lay it along the coach
  const roof = new THREE.Mesh(roofShape, flat(0x8d9399, 0.8));
  roof.scale.y = 0.3;
  roof.position.y = 3.82;
  group.add(body, roof);
  addUnderframe(group, COACH);
  return group;
}

/** An electric locomotive: white with a red band, a cab at each end. */
function buildLoco(): THREE.Group {
  const group = new THREE.Group();
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#ecebe5";
  c.fillRect(0, 0, 1024, 256);
  c.fillStyle = "#c62828";
  c.fillRect(0, 150, 1024, 60); // the red band
  c.fillStyle = "#16212b";
  for (const x of [40, 1024 - 40 - 70]) c.fillRect(x, 50, 70, 60); // cab side windows
  c.fillStyle = "#59636d";
  for (let i = 0; i < 6; i++) c.fillRect(220 + i * 100, 40, 70, 70); // air grilles
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const side = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6 });
  const white = flat(0xecebe5, 0.6);
  const body = new THREE.Mesh(new THREE.BoxGeometry(3.05, 2.9, LOCO), [side, side, white, white, white, white]);
  body.position.y = 2.5;
  body.castShadow = true;
  group.add(body);

  for (const end of [-1, 1]) {
    const screen = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.85, 0.06), flat(0x16212b, 0.3));
    screen.position.set(0, 3.2, end * (LOCO / 2 + 0.01));
    const band = new THREE.Mesh(new THREE.BoxGeometry(3.06, 0.68, 0.06), flat(0xc62828));
    band.position.set(0, 1.92, end * (LOCO / 2 + 0.01));
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.25, 0.08),
      new THREE.MeshStandardMaterial({ color: 0xfff3b0, emissive: 0xffe9a0, emissiveIntensity: 1.5 }),
    );
    lamp.position.set(0, 3.82, end * (LOCO / 2 + 0.02));
    group.add(screen, band, lamp);
  }

  // Roof gear and the "pantograph", the arm that takes power from the wire.
  const gear = new THREE.Mesh(new THREE.BoxGeometry(2, 0.35, 11), flat(0x80868c));
  gear.position.y = 4.1;
  const steel = flat(0x30343a, 0.5);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 2.1), steel);
  arm.position.set(0, 4.95, 5.2);
  arm.rotation.x = -0.75; // sloping up towards the wire
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.07, 0.3), steel);
  head.position.set(0, 5.66, 5.95);
  group.add(gear, arm, head);
  addUnderframe(group, LOCO);
  return group;
}

/**
 * Masts and wires above the tracks. The Kannur line is electric: trains take
 * their power from a wire 5.7 m above the rails.
 */
function buildOverhead(paths: Path[]): THREE.Group {
  const group = new THREE.Group();
  const SPACING = 54; // metres between masts
  const REACH = 2.9; // from the track's middle to the mast
  const poles: THREE.Matrix4[] = [];
  const arms: THREE.Matrix4[] = [];
  const turn = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);
  const ONE = new THREE.Vector3(1, 1, 1);

  paths.forEach((path, n) => {
    const other = paths[1 - n];
    const wire: THREE.Vector3[] = [];
    for (let s = 0; s <= path.length; s += 18) {
      const p = path.at(s);
      if (Math.abs(p.x) > 2100 || Math.abs(p.z) > 2100) continue; // only over the map
      wire.push(new THREE.Vector3(p.x, 5.7, p.z));
      if (Math.round(s / 18) % (SPACING / 18) !== 0) continue;
      // The arrow pointing to the track's right-hand side.
      const sideX = Math.cos(p.heading), sideZ = -Math.sin(p.heading);
      // Stand the mast on the side AWAY from the other track, so it is
      // never between the two.
      let sign = 1;
      if (other) {
        const q = other.at(other.nearest(p.x, p.z));
        const across = (q.x - p.x) * sideX + (q.z - p.z) * sideZ;
        if (Math.hypot(q.x - p.x, q.z - p.z) < 9) sign = across > 0 ? -1 : 1;
      }
      turn.setFromAxisAngle(UP, p.heading);
      poles.push(new THREE.Matrix4().compose(new THREE.Vector3(p.x + sideX * sign * REACH, 3.25, p.z + sideZ * sign * REACH), turn, ONE));
      arms.push(new THREE.Matrix4().compose(new THREE.Vector3(p.x + (sideX * sign * REACH) / 2, 6.2, p.z + (sideZ * sign * REACH) / 2), turn, ONE));
    }
    const lines = new THREE.LineBasicMaterial({ color: 0x2a2a2a });
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(wire), lines));
    // The upper wire that the lower one hangs from.
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(wire.map((w) => new THREE.Vector3(w.x, 6.25, w.z))), lines));
  });

  const grey = flat(0x6f777d, 0.6);
  const poleMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.24, 6.5, 0.24), grey, poles.length);
  const armMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(REACH, 0.1, 0.1), grey, arms.length);
  poles.forEach((m, i) => poleMesh.setMatrixAt(i, m));
  arms.forEach((m, i) => armMesh.setMatrixAt(i, m));
  poleMesh.castShadow = true;
  group.add(poleMesh, armMesh);
  return group;
}
