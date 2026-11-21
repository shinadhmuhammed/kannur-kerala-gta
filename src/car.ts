import * as THREE from "three";
import type { Controls } from "./input";
import { type VehicleModel, buildBike, buildBus, buildCar } from "./vehicleModels";

// A vehicle you can drive: the bus, the car or the motorbike. (The class is
// called Car because the game started with only a car.)
//
// Units: 1 unit = 1 metre, speed is metres per second, angles are radians.

/** What makes one vehicle different from another. */
export interface VehicleSpec {
  /** Shown in the hint: "E  drive the car". */
  name: string;
  verb: "drive" | "ride";
  model: () => VehicleModel;
  // The "feel". Change these numbers and see what happens.
  maxSpeed: number; // m/s
  maxReverse: number;
  engine: number; // acceleration, m/s²
  brake: number;
  handbrake: number;
  drag: number; // slows it when no key is pressed
  turnRate: number; // radians per second at full grip
  /** A bike leans into turns and you sit on it in the open. */
  isBike: boolean;
}

// A bus is heavy: slow to speed up, slow to stop, wide turns. A car is the
// all-rounder. A bike is the quickest off the line and the most nimble, and
// it fits down lanes the bus cannot.
export const BUS: VehicleSpec = {
  name: "the bus", verb: "drive", model: () => buildBus(0xe85d04),
  maxSpeed: 22, maxReverse: 5, engine: 6, brake: 18, handbrake: 26, drag: 3, turnRate: 1.25, isBike: false,
};
export const CAR: VehicleSpec = {
  name: "the car", verb: "drive", model: () => buildCar("sedan-sports"),
  maxSpeed: 32, maxReverse: 8, engine: 11, brake: 28, handbrake: 40, drag: 4, turnRate: 2.1, isBike: false,
};
export const BIKE: VehicleSpec = {
  name: "the bike", verb: "ride", model: () => buildBike(0xc62828, false),
  maxSpeed: 30, maxReverse: 2, engine: 14, brake: 24, handbrake: 30, drag: 3.5, turnRate: 2.7, isBike: true,
};

export class Car {
  /** The 3D object. Its position and rotation are what the player sees. */
  readonly mesh = new THREE.Group();
  /** Signed speed: positive = forward, negative = reverse. */
  speed = 0;
  /** Direction it points, as an angle around the up (Y) axis. */
  heading = 0;
  /** How far a bike is tipped over, in radians (positive = to its left). */
  lean = 0;

  /** Size on the ground, in metres. */
  readonly width: number;
  readonly length: number;

  private readonly body: THREE.Group;
  private readonly frontWheels: THREE.Object3D[];

  /**
   * @param spec which vehicle this is
   * @param spawn where it starts, and where R puts it back
   * @param mapHalfWidth,mapHalfDepth the edge of the map; it cannot leave it
   */
  constructor(
    readonly spec: VehicleSpec,
    private readonly spawn: { x: number; z: number; heading: number },
    private readonly mapHalfWidth: number,
    private readonly mapHalfDepth: number,
  ) {
    // The shapes live in vehicleModels.ts, shared with traffic. Everything
    // below (collisions, doors, camera) works from the model's size, so any
    // model can be dropped in.
    const model = spec.model();
    this.body = model.group;
    this.mesh.add(model.group);
    this.frontWheels = model.frontWheels;
    this.width = model.width;
    this.length = model.length;
    this.toSpawn();
  }

  private toSpawn(): void {
    this.mesh.position.set(this.spawn.x, 0, this.spawn.z);
    this.speed = 0;
    this.heading = this.spawn.heading;
    this.mesh.rotation.y = this.heading;
  }

  /**
   * Move the vehicle forward in time by `dt` seconds.
   * @param blocked answers "is there something solid at this spot?"
   */
  update(dt: number, c: Controls, blocked: (x: number, z: number) => boolean): void {
    const s = this.spec;
    if (c.reset) this.toSpawn();

    // --- Speed ---------------------------------------------------------
    // Pressing against the direction of travel brakes; otherwise it drives.
    if (c.throttle !== 0) {
      const braking = this.speed !== 0 && Math.sign(c.throttle) !== Math.sign(this.speed);
      this.speed += c.throttle * (braking ? s.brake : s.engine) * dt;
    } else {
      this.speed = towardsZero(this.speed, s.drag * dt);
    }
    if (c.handbrake) this.speed = towardsZero(this.speed, s.handbrake * dt);
    this.speed = THREE.MathUtils.clamp(this.speed, -s.maxReverse, s.maxSpeed);

    // --- Steering ------------------------------------------------------
    // A real vehicle cannot turn while standing still, so the turn rate
    // grows with speed (up to 8 m/s). Multiplying by the sign of the speed
    // makes steering flip in reverse, like a real car.
    const grip = Math.min(Math.abs(this.speed) / 8, 1);
    const heading = this.heading + c.steer * s.turnRate * grip * Math.sign(this.speed) * dt;

    // --- Position ------------------------------------------------------
    // heading 0 points along +Z. sin/cos turn the angle into a direction.
    const p = this.mesh.position;
    const dirX = Math.sin(heading);
    const dirZ = Math.cos(heading);
    const x = THREE.MathUtils.clamp(p.x + dirX * this.speed * dt, -this.mapHalfWidth, this.mapHalfWidth);
    const z = THREE.MathUtils.clamp(p.z + dirZ * this.speed * dt, -this.mapHalfDepth, this.mapHalfDepth);

    // --- Collision -----------------------------------------------------
    // Work out where it WOULD be, then test five points along its length,
    // from nose to tail. (A bus is long: testing only nose, middle and tail
    // would let a wall corner slip in between them.) If any point is inside
    // something solid, do not move or turn at all and bounce back a little.
    // Because we only ever accept a free spot, it can never end up stuck
    // inside a wall.
    const nose = this.length / 2;
    const along = [nose, nose / 2, 0, -nose / 2, -nose];
    // One exception: if something is ALREADY inside us where we stand (a
    // traffic vehicle that drove into our side, say), every move would count
    // as a crash and we would be stuck for good. Then we let the move
    // happen, so you can always drive out of a tangle.
    const oldX = Math.sin(this.heading);
    const oldZ = Math.cos(this.heading);
    // Checked every metre along the body, finer than the crash test, so a
    // small bike under the middle of a bus is not missed.
    let tangled = false;
    for (let d = -nose; d <= nose && !tangled; d += 1) tangled = blocked(p.x + oldX * d, p.z + oldZ * d);
    const crash = !tangled && along.some((d) => blocked(x + dirX * d, z + dirZ * d));
    if (crash) {
      this.speed *= -0.3;
    } else {
      this.heading = heading;
      p.x = x;
      p.z = z;
    }

    this.mesh.rotation.y = this.heading;
    for (const w of this.frontWheels) w.rotation.y = c.steer * 0.45;

    // --- Lean (bikes only) -------------------------------------------------
    // A bike tips into the turn, more the faster it goes. It eases towards
    // the wanted angle so it rolls over smoothly. Turning the body around
    // its length (the z axis) by a negative angle tips it to the left.
    if (s.isBike) {
      const wanted = c.steer * Math.min(Math.abs(this.speed) / 14, 1) * 0.5;
      this.lean += (wanted - this.lean) * (1 - Math.exp(-8 * dt));
      this.body.rotation.z = -this.lean;
    }
  }

  /**
   * Turn a spot given relative to the vehicle ("1.9 m to its right") into a
   * spot in the world. `side` is metres to its left (negative = right),
   * `along` is metres towards its front (negative = behind).
   */
  spotBeside(side: number, along: number): { x: number; z: number } {
    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    const p = this.mesh.position;
    return { x: p.x + side * cos + along * sin, z: p.z - side * sin + along * cos };
  }

  /**
   * Places to stand after getting out, best first. In India the passenger
   * door of a bus is on the LEFT, the side next to the kerb.
   */
  doorSpots(): { x: number; z: number }[] {
    const beside = this.width / 2 + 0.9;
    return [
      this.spotBeside(beside, this.length / 4), // left, towards the front
      this.spotBeside(-beside, this.length / 4), // right
      this.spotBeside(0, -(this.length / 2 + 1)), // behind
    ];
  }

  /** Is this spot inside the body? Stops the player walking through it. */
  contains(x: number, z: number): boolean {
    // The reverse of spotBeside: world spot -> "how far to the side / along".
    const dx = x - this.mesh.position.x;
    const dz = z - this.mesh.position.z;
    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    const side = dx * cos - dz * sin;
    const along = dx * sin + dz * cos;
    return Math.abs(side) < this.width / 2 + 0.25 && Math.abs(along) < this.length / 2 + 0.25;
  }
}

/** Move `value` towards 0 by `amount`, without overshooting past 0. */
function towardsZero(value: number, amount: number): number {
  if (Math.abs(value) <= amount) return 0;
  return value - Math.sign(value) * amount;
}
