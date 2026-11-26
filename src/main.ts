import * as THREE from "three";
import { BusDuty } from "./busDuty";
import { BIKE, BUS, CAR, Car } from "./car";
import { Ground } from "./ground";
import { type Controls, readControls } from "./input";
import { Buildings, type BuildingData } from "./buildings";
import { Labels } from "./labels";
import { Land, type LandData } from "./land";
import { loadJson } from "./mapData";
import { type Destination, MapSearch } from "./mapSearch";
import { Minimap } from "./minimap";
import { Pedestrians } from "./pedestrians";
import { type PlaceData, Places } from "./places";
import { Player } from "./player";
import { Roads, type RoadData } from "./roads";
import { Station } from "./station";
import { Train } from "./train";
import { Traffic } from "./traffic";
import { Trees } from "./trees";
import { loadVehicleModels } from "./vehicleModels";
import { SUN_OFFSET, buildWorld } from "./world";

// --- Setup: renderer (draws), scene (holds objects), camera (the eye) -----
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 900);

// The map is four files, and the car models are more files. They all have to
// be loaded before anything can be built. Promise.all downloads them at the same time instead of one by one.
// (`await` at the top of a module is allowed; the rest of the file waits.)
const [roadData, buildingData, landData, placeData] = await Promise.all([
  loadJson<RoadData>("kannur-roads.json"),
  loadJson<BuildingData>("kannur-buildings.json"),
  loadJson<LandData>("kannur-land.json"),
  loadJson<PlaceData>("kannur-places.json"),
  loadVehicleModels(),
]);
const world = buildWorld(scene, renderer, roadData.halfWidth, roadData.halfDepth);
const land = new Land(landData);
const roads = new Roads(roadData);
const buildings = new Buildings(buildingData);
const traffic = new Traffic(roadData);
const pedestrians = new Pedestrians(roadData, placeData, (x, z) => buildings.hits(x, z));
const places = new Places(placeData);
const labels = new Labels(placeData);
const ground = new Ground(buildingData, roadData.halfWidth, roadData.halfDepth);
const trees = new Trees(roadData, landData.rails, buildings, land, ground);
scene.add(ground.mesh, labels.group, trees.group, pedestrians.group);
// The railway station and the trains that call at it.
const station = new Station(landData, buildingData);
const train = new Train(landData);
scene.add(station.group, train.group);
const minimap = new Minimap(document.querySelector<HTMLCanvasElement>("#minimap")!, roadData, landData, buildingData);
scene.add(land.group, roads.group, buildings.mesh, traffic.group);

// --- Your vehicles -----------------------------------------------------------
// You start in the bus. A car and a motorbike are parked at the roadside
// near it. Walk up to any of them and press E to take it.
const spawn = roads.findSpawn();
const bus = new Car(BUS, spawn, roadData.halfWidth, roadData.halfDepth);

const solidWorld = (x: number, z: number) => buildings.hits(x, z) || land.inWater(x, z);
// A vehicle also cannot climb a platform or drive through a train.
const solidForVehicles = (x: number, z: number) => solidWorld(x, z) || station.blocksVehicle(x, z) || train.hits(x, z);

/** A free spot on the road's edge near the bus, out of the way of traffic. */
function parkingSpot(taken: { x: number; z: number }[]): { x: number; z: number; heading: number } {
  const edge = spawn.roadWidth / 2 + 1.3;
  // Try further and further from the bus, behind it and in front, both sides.
  for (let along = 9; along < 80; along += 6) {
    for (const [side, a] of [[edge, -along], [-edge, -along], [edge, along], [-edge, along]]) {
      const spot = bus.spotBeside(side, a);
      const free = [-2, 0, 2].every((d) => {
        const p = bus.spotBeside(side, a + d);
        return !solidWorld(p.x, p.z);
      });
      if (free && taken.every((t) => Math.hypot(t.x - spot.x, t.z - spot.z) > 5)) {
        return { ...spot, heading: spawn.heading };
      }
    }
  }
  return { ...bus.spotBeside(0, -12), heading: spawn.heading }; // nowhere free: behind the bus
}
const carSpot = parkingSpot([]);
const bikeSpot = parkingSpot([carSpot]);
const vehicles = [
  bus,
  new Car(CAR, carSpot, roadData.halfWidth, roadData.halfDepth),
  new Car(BIKE, bikeSpot, roadData.halfWidth, roadData.halfDepth),
];
/** The vehicle you are in, or the last one you were in. */
let car = bus;

const player = new Player();
scene.add(player.mesh, ...vehicles.map((v) => v.mesh));

// What a vehicle cannot drive through: the world, traffic, and your other
// parked vehicles.
const blockedFor = (self: Car) => (x: number, z: number) =>
  solidForVehicles(x, z) || traffic.hits(x, z) || vehicles.some((v) => v !== self && v.contains(x, z));

// --- In a vehicle or on foot -------------------------------------------------
// The whole game is in one of two "modes". Each frame, the mode decides who
// gets the keyboard, who the camera follows and what E does.
let onFoot = false;

// What a vehicle gets while nobody is driving it: nothing pressed, handbrake on.
const PARKED: Controls = { throttle: 0, steer: 0, handbrake: true, reset: false, run: false, enter: false, duty: false };

// --- Bus duty ------------------------------------------------------------------
// The rules live in busDuty.ts. Here we only feed it the bus's position and
// show what it reports.
const duty = new BusDuty(roadData, placeData, spawn.x, spawn.z);
scene.add(duty.beacon);

// --- Big map and search (M) -----------------------------------------------------
// mapSearch.ts finds the place. Here we only remember it and show the way:
// a tall light at the place, a dot on the corner map, the distance on screen.
let destination: Destination | null = null;
const destinationLight = new THREE.Mesh(
  new THREE.CylinderGeometry(1.2, 1.2, 120, 12, 1, true),
  new THREE.MeshBasicMaterial({ color: 0x35d0ff, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }),
);
destinationLight.visible = false;
scene.add(destinationLight);
function setDestination(next: Destination | null): void {
  destination = next;
  destinationLight.visible = next !== null;
  if (next) destinationLight.position.set(next.x, 60, next.z);
}
const mapSearch = new MapSearch(minimap, placeData, roadData, setDestination);
const destinationLabel = document.getElementById("dest")!;
let arrived = ""; // "Arrived at ..." message
let arrivedFor = 0; // seconds it stays on screen

// The player cannot walk through the world, traffic or any parked vehicle.
// On foot you CAN step up onto a platform and climb the footbridge stairs;
// the station only stops you walking off the side of a bridge.
const blockedOnFoot = (x: number, z: number) =>
  solidWorld(x, z) || traffic.hits(x, z) || train.hits(x, z) ||
  station.blocksWalker(x, z, player.mesh.position.y) || vehicles.some((v) => v.contains(x, z));

const EXIT_SPEED = 3; // m/s. You cannot jump out of a moving vehicle (yet).

/** The vehicle close enough to get into, or null. Nearest one wins. */
function vehicleInReach(): Car | null {
  let best: Car | null = null;
  let bestDist = Infinity;
  for (const v of vehicles) {
    const dist = player.mesh.position.distanceTo(v.mesh.position);
    // Reach is measured from the vehicle's middle, so longer ones reach further.
    if (dist < v.length / 2 + 2 && dist < bestDist) {
      bestDist = dist;
      best = v;
    }
  }
  return best;
}

function getOut(): void {
  // Try each door spot in turn. A spot is no good if something is there.
  for (const spot of car.doorSpots()) {
    if (blockedOnFoot(spot.x, spot.z)) continue;
    player.placeAt(spot.x, spot.z, car.heading);
    player.mesh.visible = true;
    onFoot = true;
    return;
  }
}

function getIn(vehicle: Car): void {
  car = vehicle;
  // Inside a car or bus you cannot be seen. On a bike you can.
  player.mesh.visible = vehicle.spec.isBike;
  onFoot = false;
}

function resize(): void {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// --- Follow camera ---------------------------------------------------------
// The camera wants to sit behind and above whoever you control. Each frame it
// moves only part of the way there, which gives a smooth, slightly lagging
// chase view, and a smooth glide when you get in or out of the car.
const wanted = new THREE.Vector3();
const lookAt = new THREE.Vector3();

function updateCamera(dt: number, snap = false): void {
  const target = onFoot ? player : car;
  // On foot the camera is closer and lower, since a person is much smaller.
  // In a vehicle it scales with the vehicle's length, so a bus fits in view.
  const back = onFoot ? 4.5 : 4 + car.length * 1.3;
  const up = onFoot ? 2.6 : 2.5 + car.length * 0.5;
  const p = target.mesh.position;
  // If a building is where the camera wants to be, move the camera closer
  // until it is in the open. Otherwise you would be looking at the inside of
  // a roof. (The height comes down with it, to keep the same viewing angle.)
  let reach = back;
  const behind = (d: number) => [p.x - Math.sin(target.heading) * d, p.z - Math.cos(target.heading) * d] as const;
  while (reach > 3 && buildings.hits(...behind(reach))) reach -= 1;
  const [camX, camZ] = behind(reach);
  // p.y is not 0 when you stand on a platform or a footbridge.
  wanted.set(camX, p.y + Math.max(2.2, (up * reach) / back), camZ);
  // 1 - e^(-k·dt) gives the same smoothness at 30 fps and at 144 fps.
  camera.position.lerp(wanted, snap ? 1 : 1 - Math.exp(-5 * dt));
  lookAt.set(p.x, p.y + (onFoot ? 1.4 : 2), p.z);
  camera.lookAt(lookAt);
}
updateCamera(0, true);

// --- Game loop -------------------------------------------------------------
// The browser calls `frame` before every screen refresh (usually 60 times a
// second). Each call: read input -> update the world -> draw.
const speedLabel = document.getElementById("speed")!;
const roadLabel = document.getElementById("road")!;
const hintLabel = document.getElementById("hint")!;
const placeLabel = document.getElementById("place")!;
const dutyPanel = document.getElementById("duty")!;
let dutyShown = ""; // what the panel shows now, to avoid rewriting it every frame
document.getElementById("credit")!.textContent = roadData.credit;
let last = performance.now();
let roadCheckIn = 0; // seconds until we next look up the road name

function frame(now: number): void {
  // dt = seconds since the previous frame. Everything is multiplied by dt so
  // the car drives at the same speed on a slow and a fast computer. The cap
  // stops a huge jump after the tab was in the background.
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  // The big map: M opens it. While it is open the game stands still.
  if (mapSearch.wantsOpen) {
    const who = onFoot ? player : car;
    mapSearch.open(who.mesh.position.x, who.mesh.position.z, who.heading);
  }
  if (mapSearch.isOpen) {
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
    return;
  }

  const controls = readControls();

  // E switches mode, when that is possible right now.
  const reachable = onFoot ? vehicleInReach() : null;
  if (controls.enter && !onFoot && Math.abs(car.speed) < EXIT_SPEED) getOut();
  else if (controls.enter && reachable) getIn(reachable);

  // The keyboard goes to the player on foot, otherwise to the vehicle you
  // are in. Every other vehicle stays parked.
  for (const v of vehicles) v.update(dt, !onFoot && v === car ? controls : PARKED, blockedFor(v));
  if (onFoot) {
    player.update(dt, controls, blockedOnFoot);
    // Stand on whatever floor is here: ground, platform, stairs or bridge.
    const feet = player.mesh.position;
    feet.y = station.heightAt(feet.x, feet.z, feet.y);
  }
  else if (car.spec.isBike) player.rideOn(car.mesh.position.x, car.mesh.position.z, car.heading, car.lean);

  const active = onFoot ? player : car;
  const spot = active.mesh.position;
  // Traffic lives around you, and stops for your vehicles and for you on foot.
  // Each vehicle is described to traffic as a row of circles along its body,
  // one every 1.2 m or so, each as wide as the vehicle. One circle in the
  // middle is not enough for a 9 m bus: traffic would only avoid its centre.
  const obstacles: { x: number; z: number; radius: number }[] = [];
  for (const v of vehicles) {
    const steps = Math.max(1, Math.ceil(v.length / 1.2));
    for (let i = 0; i <= steps; i++) {
      const point = v.spotBeside(0, -v.length / 2 + (v.length * i) / steps);
      obstacles.push({ x: point.x, z: point.z, radius: v.width / 2 });
    }
  }
  if (onFoot) obstacles.push({ x: spot.x, z: spot.z, radius: 0.4 });
  // The train brakes for you and your vehicles; traffic waits for the train.
  train.update(dt, onFoot ? [...vehicles.map((v) => v.mesh.position), spot] : vehicles.map((v) => v.mesh.position));
  station.update(spot.x, spot.z);
  obstacles.push(...train.circles());
  traffic.update(dt, spot, obstacles);
  // People step back from your vehicles (parked or moving) and from traffic.
  pedestrians.update(dt, spot, vehicles.map((v) => v.mesh.position));
  updateCamera(dt);

  speedLabel.textContent = String(Math.round(Math.abs(active.speed) * 3.6)); // m/s -> km/h
  // --- Bus duty: B starts or ends it, but only from the driver's seat --------
  const inBus = !onFoot && car === bus;
  if (controls.duty && inBus) duty.toggle();
  duty.update(dt, bus.mesh.position.x, bus.mesh.position.z, bus.speed, inBus, (stop) => {
    // Everyone waiting gets on, so the stop is empty for the next minute.
    pedestrians.emptyStop(stop.x, stop.z, 60);
  });
  const dutyView = duty.view(bus.mesh.position.x, bus.mesh.position.z);
  const dutyHtml = dutyView.lines.map((line) => `<div>${line}</div>`).join("");
  if (dutyHtml !== dutyShown) {
    dutyPanel.innerHTML = dutyHtml;
    dutyShown = dutyHtml;
  }

  const inReach = onFoot ? vehicleInReach() : null;
  // --- Destination from the big map: distance, and "arrived" within 25 m ------
  if (destination) {
    const metres = Math.hypot(destination.x - spot.x, destination.z - spot.z);
    if (metres < 25) {
      arrived = `Arrived at ${destination.name}`;
      arrivedFor = 4;
      setDestination(null);
      mapSearch.clearDestination();
    }
  }
  arrivedFor = Math.max(0, arrivedFor - dt);

  hintLabel.textContent = inReach
    ? `E  ${inReach.spec.verb} ${inReach.spec.name}`
    : arrivedFor > 0
      ? arrived
      : inBus && dutyView.lines.length === 0 && Math.abs(bus.speed) < 1
      ? "B  start bus duty"
      : "";

  // Keep the sun (and its small shadow box) centred on you.
  world.sun.target.position.copy(spot);
  world.sun.position.copy(spot).add(SUN_OFFSET);

  // The road name changes slowly, so look it up 4 times a second, not 60.
  roadCheckIn -= dt;
  if (roadCheckIn <= 0) {
    roadCheckIn = 0.25;
    roadLabel.textContent = roads.nameAt(spot.x, spot.z);
    const near = places.nearest(spot.x, spot.z, 60);
    placeLabel.textContent = near ? `Near ${near.name}` : "";
    labels.update(spot.x, spot.z);
    if (destination) {
      const metres = Math.hypot(destination.x - spot.x, destination.z - spot.z);
      const far = metres < 1000 ? `${Math.round(metres / 10) * 10} m` : `${(metres / 1000).toFixed(1)} km`;
      destinationLabel.textContent = `Going to ${destination.name} · ${far}`;
    } else destinationLabel.textContent = "";
  }
  // On bus duty the dot shows the next stop; otherwise your chosen place.
  minimap.update(spot.x, spot.z, active.heading, dutyView.target ?? destination);

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Lets you inspect things from the browser console while learning:
// `game.car().speed`, `game.vehicles`
Object.assign(window, { game: { car: () => car, vehicles, player, roads, buildings, land, traffic, places, labels, trees, pedestrians, duty, station, train, mapSearch, destination: () => destination } });
