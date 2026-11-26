# Kannur Game

A small open-world driving game set in the real town of Kannur, Kerala. You drive a
bus, a car or a motorbike, or walk, through streets built from OpenStreetMap data.
It runs in the browser with Three.js.

The world is about 4 km × 4 km: from Payyambalam beach in the west, through the
town centre, down to St. Angelo Fort in the south. It has 1,246 roads, 12,536
buildings and 895 named places, all at their real positions.

## What you can do

- **Drive three vehicles.** You start in the bus. A car and a motorbike are parked
  next to it.
- **Walk.** Get out, walk around, and get into any of your vehicles.
- **Do bus duty.** Drive a loop of six real Kannur bus stops. Passengers get on and
  off, pay fares, and each leg has a time allowance. At the end you get a summary.
- **Find any place.** Press M for a map of the whole town with a search box. Type a
  place or road name, or click the map, and the game marks it as your destination.
- **Visit Kannur railway station.** The platforms, tracks and both footbridges are
  where they really are. Walk onto a platform, climb the stairs, cross the bridge,
  and watch a train come in, stop and leave.
- **Share the road.** Traffic drives the streets and stops for you. Pedestrians walk
  the pavements and wait at bus stops.

## Controls

| Key | Action |
| --- | --- |
| W or ↑ | Forward |
| S or ↓ | Brake, then reverse |
| A D or ← → | Steer |
| Space | Handbrake |
| Shift | Run (on foot) |
| E | Get in or out of a vehicle |
| B | Start or end bus duty (from the bus driver's seat) |
| M | Open or close the map and search |
| Esc | Close the map |
| R | Reset the vehicle |

## Run it

You need Node.js 20 or newer.

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:5174.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Type-checks, then builds the game into `dist/` |
| `npm run typecheck` | Type-checks only |
| `npm run fetch-map` | Downloads the map again from OpenStreetMap |

## Map and search

Press M to open the big map. The game pauses while it is open.

- Type a name such as "St Angelo Fort", "Fort Road" or "petrol pump". Small typos
  are forgiven.
- Pick a result with the mouse, or with the arrow keys and Enter.
- Or click anywhere on the map to drop a pin.

The chosen place gets a tall blue light in the world, a yellow dot on the corner
map and its distance on screen. When you are within 25 m, the game says you have
arrived. It shows direction and distance, not a route along the roads.

The search uses the game's own list of places and road names. There is no server
and no AI.

## How the map data works

`scripts/fetch-map.mjs` asks OpenStreetMap's Overpass server for central Kannur
once, and saves the answer as four JSON files in `public/`:

| File | Contents |
| --- | --- |
| `kannur-roads.json` | Roads and footpaths, with widths and names |
| `kannur-buildings.json` | Building outlines |
| `kannur-land.json` | Sea, beaches, water, parks, pitches, railway |
| `kannur-places.json` | Named places: shops, schools, temples, bus stops, ... |

The files are saved in the repository, so the game starts fast and does not depend
on the map server. To cover a different area, change the box at the top of the
script and run `npm run fetch-map`.

## Code layout

Everything is in `src/`, one topic per file.

| File | What it does |
| --- | --- |
| `main.ts` | Sets everything up and runs the game loop |
| `world.ts`, `ground.ts`, `land.ts`, `trees.ts` | Sky, sun, ground, sea, parks, trees |
| `roads.ts`, `ribbon.ts` | Road surfaces and road names |
| `buildings.ts`, `textures.ts` | Buildings and their walls and windows |
| `car.ts`, `vehicleModels.ts` | How your vehicles drive and look |
| `player.ts`, `personModel.ts` | Walking on foot |
| `traffic.ts`, `pedestrians.ts` | Other vehicles and people |
| `busDuty.ts` | The rules of bus duty |
| `minimap.ts`, `mapSearch.ts` | The corner map, the big map and the search |
| `station.ts`, `train.ts` | Kannur railway station, and the trains and overhead wires |
| `places.ts`, `labels.ts` | Named places and their signs |
| `input.ts` | Keyboard |

## Railway station

The station's layout comes from the map: the building's outline, platform 1, the
island with platforms 2 and 3, the tracks and the two footbridges. Its look is
modelled by hand in the usual style of a Kerala station, not copied from photos.

- On foot you can step onto the platforms and use the footbridge stairs.
- Vehicles cannot climb the platforms.
- A train arrives every few minutes, alternating between platforms 1 and 2,
  and waits half a minute.
- The train brakes if you or one of your vehicles is on the line, and traffic
  waits for it to pass.

## Built with

- [Three.js](https://threejs.org/) for 3D
- [Vite](https://vite.dev/) and TypeScript

## Credits

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
  under the Open Database Licence (ODbL).
- Car models from the Car Kit by [Kenney](https://www.kenney.nl), CC0.
