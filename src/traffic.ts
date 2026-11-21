import * as THREE from "three";
import type { RoadData } from "./roads";
import { type CarKind, type VehicleModel, buildAuto, buildBike, buildBus, buildCar } from "./vehicleModels";

// Traffic: cars, auto-rickshaws and buses that drive along the roads.
//
// The trick that keeps this simple: traffic does not "drive" like the player.
// Each vehicle is a bead sliding along a road's line of points, like a train
// on rails. It only decides three things: how fast to go, when to stop for
// something in front, and which road to take when its road ends.
//
// The whole city is NOT full of traffic. Vehicles exist only in a ring around
// the player; ones left far behind are removed and new ones appear ahead.
// Every open-world game does this, because you can only see what is near you.

const MAX_VEHICLES = 30;
const SPAWN_NEAR = 110; // metres from the player: not closer, or you see them pop in
const SPAWN_FAR = 260;
const REMOVE_BEYOND = 380;
const CELL = 100; // size of the squares used to find road points near a spot

// Everyday cars are listed more than once so they turn up more often than
// police cars and ambulances.
const CAR_MIX: CarKind[] = [
  "sedan", "sedan", "hatchback-sports", "hatchback-sports", "suv", "suv", "suv-luxury",
  "van", "van", "taxi", "taxi", "truck", "delivery", "sedan-sports", "police", "ambulance",
];
const BIKE_COLOURS = [0x1c1c1c, 0xc62828, 0x1f4e9c, 0x8d9399];
const BUS_COLOURS = [0xc0392b, 0x2e7d4f, 0x2a5db0];

interface Vehicle {
  model: VehicleModel;
  road: number; // which road it is on (index into the roads list)
  segment: number; // it is between point `segment` and `segment + 1`
  along: number; // metres travelled from point `segment`
  direction: 1 | -1; // 1 = towards the road's last point, -1 = towards its first
  speed: number;
  x: number; // where it is now (the model eases towards the "rail" position)
  z: number;
  heading: number;
  waited: number; // seconds it has been standing still behind other traffic
  pushing: number; // seconds left of "stop waiting, just go" (see drive)
  tangled: number; // seconds it has been overlapping one of your vehicles
}

/** Something traffic must not drive into: the player's car, or the player. */
export interface Obstacle {
  x: number;
  z: number;
  /** Metres from this point to the edge of the thing: about 1 for a car's side, 0.4 for a person. */
  radius: number;
}

export class Traffic {
  readonly group = new THREE.Group();
  private readonly vehicles: Vehicle[] = [];
  private readonly roads: RoadData["roads"];
  /** For each map point: every (road, point number) that sits exactly on it. */
  private readonly junctions = new Map<string, [road: number, point: number][]>();
  /** For each 100 m square: the road points inside it. Used to spawn nearby. */
  private readonly cells = new Map<string, [road: number, point: number][]>();

  constructor(data: RoadData) {
    this.roads = data.roads;
    data.roads.forEach((road, r) => {
      if (road.kind === "service") return; // driveways and car parks: no traffic
      for (let i = 0; i < road.points.length / 2; i++) {
        const x = road.points[i * 2];
        const z = road.points[i * 2 + 1];
        // Roads that meet share the exact same point in OpenStreetMap, so
        // "same x and z" is a reliable way to find junctions.
        push(this.junctions, `${x},${z}`, [r, i]);
        push(this.cells, `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`, [r, i]);
      }
    });
  }

  /**
   * Move all traffic forward in time by `dt` seconds.
   * @param focus where the player is; traffic lives around this spot
   * @param obstacles things to stop for
   */
  update(dt: number, focus: { x: number; z: number }, obstacles: Obstacle[]): void {
    // Keep the ring around the player populated.
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      if (Math.hypot(v.x - focus.x, v.z - focus.z) > REMOVE_BEYOND) {
        this.group.remove(v.model.group);
        this.vehicles.splice(i, 1);
      }
    }
    // At the very start, fill the streets nearby so the city is not empty.
    const starting = this.vehicles.length < MAX_VEHICLES / 2;
    for (let tries = 0; tries < 4 && this.vehicles.length < MAX_VEHICLES; tries++) {
      this.trySpawn(focus, starting ? 40 : SPAWN_NEAR);
    }

    for (const v of this.vehicles) this.drive(v, dt, obstacles);

    // Last resort for accidents. The stopping rules keep traffic off your
    // vehicles, but you can still drive INTO traffic, or cut across its nose
    // too late for it to stop. A traffic vehicle that has been overlapping
    // one of yours for 2 seconds is taken away, so a crash never leaves two
    // vehicles fused together for good.
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i];
      const sin = Math.sin(v.heading);
      const cos = Math.cos(v.heading);
      const overlapping = obstacles.some((o) => {
        const dx = o.x - v.x;
        const dz = o.z - v.z;
        return Math.abs(dx * cos - dz * sin) < v.model.width / 2 && Math.abs(dx * sin + dz * cos) < v.model.length / 2;
      });
      v.tangled = overlapping ? v.tangled + dt : 0;
      if (v.tangled > 2) {
        this.group.remove(v.model.group);
        this.vehicles.splice(i, 1);
      }
    }
  }

  /** Is this spot inside any traffic vehicle? */
  hits(x: number, z: number): boolean {
    return this.vehicles.some((v) => {
      // Turn the world spot into "metres to the side / along" of the vehicle
      // (the same maths as Car.contains).
      const dx = x - v.x;
      const dz = z - v.z;
      const sin = Math.sin(v.heading);
      const cos = Math.cos(v.heading);
      return Math.abs(dx * cos - dz * sin) < v.model.width / 2 && Math.abs(dx * sin + dz * cos) < v.model.length / 2;
    });
  }

  get count(): number {
    return this.vehicles.length;
  }

  // --- One vehicle, one frame -------------------------------------------------

  private drive(v: Vehicle, dt: number, obstacles: Obstacle[]): void {
    const road = this.roads[v.road];

    // --- Speed: cruise, unless something is close in front ------------------
    // Your vehicles arrive as a row of circles along their bodies (see
    // main.ts), so traffic stops for any PART of a bus, even one parked
    // across the road, not only for its middle.
    const stopForPlayer = obstacles.some((o) => this.sees(v, o, o.radius, o.radius, 0));
    const stopForTraffic =
      v.pushing <= 0 &&
      this.vehicles.some((o, i) => {
        // The 2 means: ignore a vehicle whose middle is less than 2 m ahead.
        // That only happens when two vehicles already overlap (they merged at
        // a junction), and then the right thing is to drive apart.
        if (o === v || !this.sees(v, o, o.model.length / 2, o.model.width / 2, 2)) return false;
        // Other traffic counts only if it faces roughly the same way;
        // vehicles coming towards us are in the other lane.
        if (Math.sin(o.heading) * Math.sin(v.heading) + Math.cos(o.heading) * Math.cos(v.heading) <= 0) return false;
        // Two vehicles merging at a corner can each see the other in front,
        // and would both wait forever. Then the earlier one in the list goes.
        const iGoFirst = this.sees(o, v, v.model.length / 2, v.model.width / 2, 2) && this.vehicles.indexOf(v) < i;
        return !iGoFirst;
      });
    const mustStop = stopForPlayer || stopForTraffic;

    // Safety net. Simple rules like the ones above can still lock up, for
    // example three vehicles each waiting for the next in a circle. So a
    // vehicle that has waited 6 s behind traffic stops being polite for 2 s.
    // A jam that clears itself is better than a perfect rule that can freeze.
    v.pushing -= dt;
    v.waited = stopForTraffic && v.speed < 0.5 ? v.waited + dt : 0;
    if (v.waited > 6) {
      v.waited = 0;
      v.pushing = 2;
    }

    const cruise = road.width >= 7 ? 11 : 6.5; // m/s: main roads vs lanes
    if (mustStop) v.speed = Math.max(0, v.speed - 14 * dt);
    else v.speed = Math.min(cruise, v.speed + 3 * dt);

    // --- Slide along the rail ------------------------------------------------
    let step = v.speed * dt;
    for (let guard = 0; step > 0 && guard < 20; guard++) {
      const length = this.segmentLength(v);
      if (v.along + step < length) {
        v.along += step;
        break;
      }
      step -= length - v.along;
      this.nextSegment(v);
    }

    // --- Where the rail says the vehicle should be ---------------------------
    const r = this.roads[v.road].points;
    const a = v.direction === 1 ? v.segment : v.segment + 1; // point it left
    const b = v.direction === 1 ? v.segment + 1 : v.segment; // point it heads to
    const ax = r[a * 2], az = r[a * 2 + 1];
    let dx = r[b * 2] - ax;
    let dz = r[b * 2 + 1] - az;
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    // In India traffic keeps LEFT. (dz, -dx) is the direction to the left of
    // travel; a quarter of the road's width puts it in the middle of its lane.
    const lane = this.roads[v.road].width / 4;
    const railX = ax + dx * v.along + dz * lane;
    const railZ = az + dz * v.along - dx * lane;

    // The rail has sharp corners and the lane jumps at junctions. Easing
    // towards the rail position, instead of snapping to it, hides both.
    const ease = 1 - Math.exp(-6 * dt);
    v.x += (railX - v.x) * ease;
    v.z += (railZ - v.z) * ease;
    v.heading += shortestTurn(v.heading, Math.atan2(dx, dz)) * ease;

    const g = v.model.group;
    g.position.set(v.x, 0, v.z);
    g.rotation.y = v.heading;
  }

  /**
   * Is `target` close in front of vehicle `v`, in its path?
   * @param radius how far the target reaches towards us, so we stop before its edge
   * @param halfWidth how far the target reaches sideways
   * @param nearest ignore targets closer ahead than this (middle to middle)
   */
  private sees(v: Vehicle, target: { x: number; z: number }, radius: number, halfWidth: number, nearest: number): boolean {
    const fx = Math.sin(v.heading); // the direction the vehicle faces
    const fz = Math.cos(v.heading);
    const dx = target.x - v.x;
    const dz = target.z - v.z;
    const ahead = dx * fx + dz * fz; // how far in front (negative = behind)
    const aside = Math.abs(dx * fz - dz * fx); // how far off to the side
    // Stop 2.5 m short of it. The faster the vehicle goes, the further ahead
    // it must look to stop in time.
    const reach = v.model.length / 2 + radius + 2.5 + v.speed * 0.9;
    // "In its path" = the two would touch side to side, plus a small gap.
    // (This used to be a fixed 1.9 m from the target's MIDDLE, so a bus
    // could drive straight into the end of another bus beside its lane.)
    const clearance = v.model.width / 2 + halfWidth + 0.4;
    return ahead > nearest && ahead < reach && aside < clearance;
  }

  private segmentLength(v: Vehicle): number {
    const p = this.roads[v.road].points;
    const i = v.segment * 2;
    return Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
  }

  /** The vehicle reached the next point on its road. Decide where it goes. */
  private nextSegment(v: Vehicle): void {
    const p = this.roads[v.road].points;
    const last = p.length / 2 - 1;
    const reached = v.direction === 1 ? v.segment + 1 : v.segment;
    const atEnd = reached === 0 || reached === last;
    v.along = 0;

    // Other roads that pass through this exact point, and can be driven
    // from here (a one-way road cannot be entered at its far end).
    const exits = (this.junctions.get(`${p[reached * 2]},${p[reached * 2 + 1]}`) ?? []).filter(
      ([road, point]) => road !== v.road && this.canEnter(road, point),
    );

    // At the end of the road it must turn off. In the middle of a road it
    // turns off now and then; without this, traffic would only ever leave a
    // road at its two ends, and every vehicle that drove onto a roundabout
    // would circle it forever.
    if (exits.length > 0 && (atEnd || Math.random() < 0.3)) {
      const [road, point] = exits[Math.floor(Math.random() * exits.length)];
      this.enter(v, road, point);
    } else if (!atEnd) {
      v.segment += v.direction; // carry on along the same road
    } else if (p[0] === p[last * 2] && p[1] === p[last * 2 + 1]) {
      // The road is a closed loop (a roundabout): its end is its start.
      v.segment = v.direction === 1 ? 0 : last - 1;
    } else {
      v.direction = v.direction === 1 ? -1 : 1; // dead end: turn around
    }
  }

  private canEnter(road: number, point: number): boolean {
    const r = this.roads[road];
    return !r.oneWay || point < r.points.length / 2 - 1;
  }

  /** Put the vehicle on `road` at `point`, heading whichever way is allowed. */
  private enter(v: Vehicle, road: number, point: number): void {
    const r = this.roads[road];
    const canGoForward = point < r.points.length / 2 - 1;
    const canGoBack = point > 0 && !r.oneWay;
    v.road = road;
    v.direction = canGoForward && (!canGoBack || Math.random() < 0.5) ? 1 : -1;
    v.segment = v.direction === 1 ? point : point - 1;
    v.along = 0;
  }

  // --- Adding vehicles --------------------------------------------------------

  private trySpawn(focus: { x: number; z: number }, nearest: number): void {
    // Pick a random spot in the ring around the player, and see whether a
    // road passes through the square it lands in.
    const angle = Math.random() * Math.PI * 2;
    const distance = nearest + Math.random() * (SPAWN_FAR - nearest);
    const x = focus.x + Math.cos(angle) * distance;
    const z = focus.z + Math.sin(angle) * distance;
    const here = this.cells.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!here) return;
    const [road, point] = here[Math.floor(Math.random() * here.length)];
    if (!this.canEnter(road, point)) return;

    const p = this.roads[road].points;
    const px = p[point * 2];
    const pz = p[point * 2 + 1];
    // The square is bigger than the ring is precise, so check again; and do
    // not appear on top of another vehicle.
    if (Math.hypot(px - focus.x, pz - focus.z) < nearest) return;
    if (this.vehicles.some((o) => Math.hypot(o.x - px, o.z - pz) < 14)) return;

    const model = this.randomModel(this.roads[road].width);
    const v: Vehicle = { model, road, segment: 0, along: 0, direction: 1, speed: 0, x: px, z: pz, heading: 0, waited: 0, pushing: 0, tangled: 0 };
    this.enter(v, road, point);
    // Face along the road straight away, so it does not spin into place.
    const a = v.direction === 1 ? v.segment : v.segment + 1;
    const b = v.direction === 1 ? v.segment + 1 : v.segment;
    v.heading = Math.atan2(p[b * 2] - p[a * 2], p[b * 2 + 1] - p[a * 2 + 1]);
    model.group.position.set(v.x, 0, v.z);
    model.group.rotation.y = v.heading;

    this.vehicles.push(v);
    this.group.add(model.group);
  }

  private randomModel(roadWidth: number): VehicleModel {
    const pick = Math.random();
    // Buses only on roads wide enough for them.
    if (pick < 0.15 && roadWidth >= 7) return buildBus(randomOf(BUS_COLOURS));
    if (pick < 0.35) return buildAuto();
    // Kerala's roads are full of two-wheelers.
    if (pick < 0.6) return buildBike(randomOf(BIKE_COLOURS), true);
    return buildCar(randomOf(CAR_MIX));
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function randomOf<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** The smallest turn (in radians, left or right) that takes `from` to `to`. */
function shortestTurn(from: number, to: number): number {
  let turn = (to - from) % (Math.PI * 2);
  if (turn > Math.PI) turn -= Math.PI * 2;
  if (turn < -Math.PI) turn += Math.PI * 2;
  return turn;
}
