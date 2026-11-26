// Downloads central Kannur from OpenStreetMap and saves it as small JSON files
// the game can load: roads, buildings, land (sea, water, parks, railway, ...)
// and named places.
//
// Run it with:  npm run fetch-map
//
// Why a script and saved files, instead of asking the map server from the
// game? The map server (Overpass) is a free shared service: slow, rate-limited
// and sometimes down. We ask it once, keep the answer in the repo, and the
// game always starts fast and works offline.
//
// Data licence: © OpenStreetMap contributors, ODbL. The game must show that
// credit on screen (main.ts puts it in the corner).

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// The area to download: about 4 km x 4 km, from Payyambalam beach (west) past
// the town centre, down to St. Angelo Fort (south). Change these to grow the map.
const SOUTH = 11.852, WEST = 75.348, NORTH = 11.888, EAST = 75.384;
const BOX = `${SOUTH},${WEST},${NORTH},${EAST}`;
// The coastline is asked for in a bigger box, so the sea continues past the
// edge of the map instead of stopping in a straight line.
const PAD = 0.02;
const COAST_BOX = `${SOUTH - PAD},${WEST - PAD},${NORTH + PAD},${EAST + PAD}`;

// Road kinds we can drive on, and how wide (metres) to draw each when the map
// does not say how many lanes it has. Checked by eye against satellite photos
// of the town centre: Kannur's roads are narrow, and side lanes are barely
// one bus wide.
const WIDTHS = {
  trunk: 11, trunk_link: 6,
  primary: 9, primary_link: 6,
  secondary: 7.5, secondary_link: 5.5,
  tertiary: 6.5, tertiary_link: 5,
  unclassified: 4.5, residential: 4, living_street: 3.5,
  service: 3,
};
// Ways for walking. Drawn as narrow paths; traffic does not use them.
const PATH_KINDS = ["footway", "path", "steps", "pedestrian", "track", "cycleway"];

// Overpass QL. Each line picks things by tag inside a box. "way" = a line or
// an outline, "node" = a single point. "out geom" returns the coordinates.
const query = `
[out:json][timeout:180];
(
  way["highway"~"^(${[...Object.keys(WIDTHS), ...PATH_KINDS].join("|")})$"](${BOX});
  way["building"](${BOX});
  way["railway"~"^(rail|platform)$"](${BOX});
  way["natural"~"^(beach|water|wetland)$"](${BOX});
  way["waterway"~"^(stream|canal|drain)$"](${BOX});
  way["leisure"~"^(park|pitch|stadium|playground)$"](${BOX});
  way["landuse"~"^(grass|meadow|recreation_ground)$"](${BOX});
  way["historic"="fort"](${BOX});
  way["man_made"~"^(breakwater|lighthouse)$"](${BOX});
  way["natural"="coastline"](${COAST_BOX});
  node["name"](${BOX});
  way["name"]["amenity"](${BOX});
  way["name"]["tourism"](${BOX});
  way["name"]["railway"="station"](${BOX});
);
out geom;`;

// The raw answer is kept in scripts/cache/ (not committed). Run again and the
// script reuses it, so changing a width or colour rule below does not need
// the map server at all. To download fresh data:  npm run fetch-map -- --fresh
const cacheFile = new URL("./cache/kannur-raw.json", import.meta.url);
let elements;
if (!process.argv.includes("--fresh") && existsSync(cacheFile)) {
  console.log("Using the saved download (add --fresh to download again)...");
  ({ elements } = JSON.parse(await readFile(cacheFile, "utf8")));
} else {
  // The server is often busy. Try a few times, waiting longer each time.
  for (let attempt = 1; ; attempt++) {
    console.log(`Asking OpenStreetMap for Kannur (try ${attempt})...`);
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "kannur-game-map-fetch" },
      body: "data=" + encodeURIComponent(query),
    });
    if (res.ok) {
      const text = await res.text();
      ({ elements } = JSON.parse(text));
      await mkdir(new URL("./cache/", import.meta.url), { recursive: true });
      await writeFile(cacheFile, text);
      break;
    }
    if (attempt === 5) throw new Error(`Overpass answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    console.log(`  server busy (${res.status}), waiting ${attempt * 20} s`);
    await new Promise((done) => setTimeout(done, attempt * 20000));
  }
}
const ways = elements.filter((e) => e.type === "way" && e.geometry?.length >= 2);
const nodes = elements.filter((e) => e.type === "node");

// --- Latitude/longitude -> metres -------------------------------------------
// The game works in metres on a flat ground. For an area this small the Earth
// is nearly flat, so a simple conversion around the centre point is accurate
// to well under a metre:
//   1 degree of latitude  = ~110,574 m everywhere
//   1 degree of longitude = ~111,320 m x cos(latitude)  (the lines get closer
//                           together away from the equator)
const LAT0 = (SOUTH + NORTH) / 2, LON0 = (WEST + EAST) / 2;
const M_PER_LAT = 110574;
const M_PER_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const round = (n) => Math.round(n * 10) / 10; // 10 cm is plenty
// East is +x. North is -z, because in three.js +z comes "towards the viewer",
// so north must be -z for the map not to be mirrored.
const toX = (lon) => round((lon - LON0) * M_PER_LON);
const toZ = (lat) => round(-(lat - LAT0) * M_PER_LAT);

/** Flat list [x0, z0, x1, z1, ...]. */
const toMetres = (geometry) => geometry.flatMap((p) => [toX(p.lon), toZ(p.lat)]);

/** An outline's last point repeats its first. Drop the repeat. */
function outline(way) {
  const p = toMetres(way.geometry);
  const n = p.length;
  if (n >= 4 && p[0] === p[n - 2] && p[1] === p[n - 1]) p.length = n - 2;
  return p;
}
const isClosed = (way) => way.nodes[0] === way.nodes.at(-1);
/** All closed outlines whose tags pass the test. */
const outlines = (test) => ways.filter((w) => w.tags && isClosed(w) && test(w.tags)).map(outline).filter((p) => p.length >= 6);
/** All lines (open or closed) whose tags pass the test. */
const lines = (test) => ways.filter((w) => w.tags && test(w.tags)).map((w) => toMetres(w.geometry));

/** Area of an outline in m² (the "shoelace" formula). */
function area(p) {
  let sum = 0;
  for (let i = 0; i < p.length; i += 2) {
    const j = (i + 2) % p.length;
    sum += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return Math.abs(sum) / 2;
}

function centre(p) {
  let x = 0, z = 0;
  for (let i = 0; i < p.length; i += 2) { x += p[i]; z += p[i + 1]; }
  return [round(x / (p.length / 2)), round(z / (p.length / 2))];
}

/** Prefer the English name when the mapper gave one. */
const nameOf = (tags) => tags["name:en"] ?? tags.name ?? "";

// --- Roads -------------------------------------------------------------------
const roads = ways
  .filter((w) => WIDTHS[w.tags?.highway])
  .map((way) => {
    const t = way.tags;
    const lanes = parseInt(t.lanes) || 0;
    return {
      kind: t.highway,
      // When mappers counted the lanes, trust that: 2.8 m per lane (town
      // lanes are narrow) plus a little edge. Otherwise use our guess for
      // this kind of road.
      width: lanes ? round(lanes * 2.8 + 0.6) : WIDTHS[t.highway],
      lanes,
      name: nameOf(t),
      // One-way roads and roundabouts may only be driven from the first point
      // towards the last. Traffic needs to know, or it goes round Caltex
      // Circle the wrong way.
      oneWay: t.oneway === "yes" || t.junction === "roundabout",
      // asphalt / concrete / paving_stones / unpaved / dirt, or "" if unknown
      surface: t.surface ?? "",
      points: toMetres(way.geometry),
    };
  });

const paths = ways
  .filter((w) => PATH_KINDS.includes(w.tags?.highway))
  .map((way) => ({ kind: way.tags.highway, points: toMetres(way.geometry) }));

// --- Buildings ---------------------------------------------------------------
/**
 * Kannur is a low town: mostly one- and two-floor houses, with taller blocks
 * only in the centre. When the map does not give a height, guess the number
 * of floors from how big the building is on the ground. The id makes the
 * guess vary from house to house, but stay the same on every run.
 */
function guessFloors(squareMetres, id) {
  if (squareMetres < 60) return 1; // sheds, small shops, small houses
  if (squareMetres < 200) return id % 3 === 0 ? 2 : 1; // houses
  if (squareMetres < 600) return id % 4 === 0 ? 3 : 2; // big houses, shops
  if (squareMetres < 2000) return 2 + (id % 3); // commercial blocks: 2 to 4
  return 3 + (id % 2); // malls, hospitals, halls: 3 or 4
}

// The map has the outline of each building, but usually not its height. Use
// the real height or number of floors when a mapper added it; otherwise make
// one up from the building's id, so it is varied but the same on every run.
const buildings = ways
  .filter((w) => w.tags?.building)
  .map((way) => {
    const points = outline(way);
    const floors = parseFloat(way.tags["building:levels"]);
    const tagged = parseFloat(way.tags.height) || (floors ? floors * 3.2 : 0);
    const building = { height: round(tagged || guessFloors(area(points), way.id) * 3.2 + 0.4), points };
    // The railway station gets its own hand-made model (src/station.ts), so
    // the game must know which outline it is.
    if (way.tags.building === "train_station") building.kind = "train_station";
    return building;
  })
  .filter((b) => b.points.length >= 6); // need at least 3 corners

// --- Land: everything flat that is not a road --------------------------------
const land = {
  sea: [], // filled in below
  beaches: outlines((t) => t.natural === "beach"),
  water: outlines((t) => t.natural === "water"), // ponds and temple tanks
  wetland: outlines((t) => t.natural === "wetland"),
  green: outlines((t) => t.leisure === "park" || t.leisure === "playground" || ["grass", "meadow", "recreation_ground"].includes(t.landuse)),
  pitches: outlines((t) => t.leisure === "pitch" || t.leisure === "stadium"),
  platforms: outlines((t) => t.railway === "platform"),
  streams: ways
    .filter((w) => w.tags?.waterway)
    .map((w) => ({ width: w.tags.waterway === "canal" ? 5 : 2, points: toMetres(w.geometry) })),
  rails: lines((t) => t.railway === "rail"),
  fortWalls: lines((t) => t.historic === "fort"),
  breakwaters: lines((t) => t.man_made === "breakwater"),
  lighthouses: ways.filter((w) => w.tags?.man_made === "lighthouse").map((w) => centre(outline(w))),
  // Where trains stop at the station: one point on the track per platform.
  trainStops: nodes
    .filter((n) => n.tags?.railway === "stop")
    .map((n) => ({ platform: n.tags.ref ?? "", x: toX(n.lon), z: toZ(n.lat) })),
};

// --- Sea ---------------------------------------------------------------------
// OpenStreetMap does not store the sea as a shape. It stores the COASTLINE as
// many short lines, always drawn so that land is on the left and water is on
// the right. To get a sea shape we:
//   1. join the short lines end-to-start into one long coastline,
//   2. close it into a shape by adding two far-away points on the water side.
const coastWays = ways.filter((w) => w.tags?.natural === "coastline");
const byFirstNode = new Map(coastWays.map((w) => [w.nodes[0], w]));
const lastNodes = new Set(coastWays.map((w) => w.nodes.at(-1)));
for (const start of coastWays.filter((w) => !lastNodes.has(w.nodes[0]))) {
  // `start` begins where no other piece ends, so it is the start of a chain.
  const chain = [];
  for (let w = start; w; w = byFirstNode.get(w.nodes.at(-1))) {
    const p = toMetres(w.geometry);
    chain.push(...(chain.length ? p.slice(2) : p)); // skip the shared point
  }
  // Direction from the chain's start to its end, and the direction to its
  // right (the water side). Turning (dx, dz) right gives (-dz, dx) here.
  const n = chain.length;
  const dx = chain[n - 2] - chain[0];
  const dz = chain[n - 1] - chain[1];
  const len = Math.hypot(dx, dz) || 1;
  const FAR = 12000; // metres out to sea
  const rx = (-dz / len) * FAR;
  const rz = (dx / len) * FAR;
  land.sea.push([...chain, round(chain[n - 2] + rx), round(chain[n - 1] + rz), round(chain[0] + rx), round(chain[1] + rz)]);
}

// --- Named places ------------------------------------------------------------
// Shops, banks, schools, temples, mosques, bus stops ... anything with a name,
// whether the mapper drew it as a point or as a named building. The game
// shows the nearest one, so you can tell where in Kannur you are.
const kindOf = (t) =>
  t.amenity ?? t.shop ?? t.tourism ?? t.railway ?? t.office ?? t.historic ?? t.leisure ?? t.natural ?? t.highway ?? t.place ?? "";
const place = (t, x, z) => ({ name: nameOf(t), kind: kindOf(t) || "building", religion: t.religion ?? "", x, z });
const places = [
  ...nodes
    .filter((n) => n.tags?.name && !["city", "town", "suburb", "state"].includes(n.tags.place))
    .map((n) => place(n.tags, toX(n.lon), toZ(n.lat))),
  ...ways
    .filter((w) => w.tags?.name && !w.tags.highway && !w.tags.waterway)
    .map((w) => place(w.tags, ...centre(outline(w)))),
];

// --- Save --------------------------------------------------------------------
const credit = "Map data © OpenStreetMap contributors";
const dir = new URL("../public/", import.meta.url);
await mkdir(dir, { recursive: true });
async function save(name, data) {
  const json = JSON.stringify(data);
  await writeFile(new URL(name, dir), json);
  console.log(`  ${name}: ${(json.length / 1024).toFixed(0)} KB`);
}
console.log("Saved to public/:");
await save("kannur-roads.json", {
  credit,
  centre: { lat: LAT0, lon: LON0 },
  halfWidth: round(((EAST - WEST) / 2) * M_PER_LON),
  halfDepth: round(((NORTH - SOUTH) / 2) * M_PER_LAT),
  roads,
  paths,
});
await save("kannur-buildings.json", { buildings });
await save("kannur-land.json", land);
await save("kannur-places.json", { places });

const tagged = ways.filter((w) => w.tags?.building && (w.tags.height || w.tags["building:levels"])).length;
console.log(`${roads.length} roads (${roads.filter((r) => r.lanes).length} with a real lane count), ${paths.length} footpaths, ` +
  `${buildings.length} buildings (${tagged} with a real height), ${places.length} named places`);
console.log(Object.entries(land).map(([k, v]) => `${k}: ${v.length}`).join(", "));
