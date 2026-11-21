import { setKeysPaused } from "./input";
import type { Minimap } from "./minimap";
import type { PlaceData } from "./places";
import type { RoadData } from "./roads";

// The big map with a search box (press M).
//
// It shows the whole town, where you are, and lets you find any named place
// or road in the game: type a name, pick a result, and that place becomes
// your destination. You can also click anywhere on the map to drop a pin.
// The game then shows the way with a dot on the corner map, a tall light
// in the world and the distance on screen (main.ts does that part).
//
// There is no server and no AI here. The game already has the list of named
// places (kannur-places.json); every key press checks all of them, which
// takes about a millisecond.

/** A place you have chosen to go to. */
export interface Destination {
  name: string;
  x: number;
  z: number;
}

interface Entry extends Destination {
  kind: string; // shown under the name: "Hospital", "Road", ...
  words: string[]; // the words of the name, cleaned
  extra: string[]; // the words of its kind, so "hospital" finds hospitals
}

// Other words people use for a kind of place.
const ALSO: Record<string, string> = {
  fuel: "petrol pump",
  pharmacy: "medical store chemist",
  medical_supply: "medical store pharmacy",
  hospital: "clinic",
  temple: "kshetram ambalam",
  mosque: "masjid palli",
  church: "palli",
  bus_station: "bus stand",
  station: "railway train",
  restaurant: "hotel food",
  fast_food: "food restaurant",
  hotel: "lodge stay",
  cinema: "theatre movie talkies",
  atm: "cash bank",
  road: "street",
};
const WORSHIP: Record<string, string> = { hindu: "temple", muslim: "mosque", christian: "church" };
// Small words that mean nothing in "hospital near fort road".
const SKIP = new Set(["in", "near", "at", "the", "of", "to", "a"]);

/** Lower case, punctuation turned into spaces. Malayalam letters are kept. */
function clean(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
}

/**
 * How many single-letter changes turn one word into the other, giving up
 * (returning 3) once it is more than 2. Forgives typos: "paymbalam".
 */
function typos(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, row[j]);
    }
    if (best > 2) return 3;
    prev = row;
  }
  return prev[b.length];
}

export class MapSearch {
  private readonly overlay = document.getElementById("map-overlay")!;
  private readonly input = document.getElementById("map-q") as HTMLInputElement;
  private readonly list = document.getElementById("map-results")!;
  private readonly note = document.getElementById("map-note")!;
  private readonly canvas = document.getElementById("map-big") as HTMLCanvasElement;
  private readonly entries: Entry[] = [];
  private shown: Entry[] = []; // the results in the list right now
  private active = -1; // which one the arrow keys are on
  private you = { x: 0, z: 0, heading: 0 };
  private destination: Destination | null = null;

  /** @param onChoose called with the new destination, or null when it is cleared */
  constructor(
    private readonly minimap: Minimap,
    places: PlaceData,
    roads: RoadData,
    private readonly onChoose: (destination: Destination | null) => void,
  ) {
    const add = (name: string, kind: string, x: number, z: number): void => {
      const label = kind.replace(/_/g, " ");
      this.entries.push({
        name, x, z,
        kind: label.charAt(0).toUpperCase() + label.slice(1),
        words: clean(name).split(" "),
        extra: clean(`${label} ${ALSO[kind] ?? ""}`).split(" ").filter(Boolean),
      });
    };
    for (const p of places.places) {
      if (!p.name) continue;
      const kind = p.kind === "place_of_worship" ? WORSHIP[p.religion] ?? "place of worship" : p.kind === "yes" ? "place" : p.kind;
      add(p.name, kind, p.x, p.z);
    }
    // A road is saved as many pieces with the same name. Keep the longest
    // piece of each name and point at its middle.
    const longest = new Map<string, number[]>();
    for (const road of roads.roads) {
      if (road.name && road.points.length > (longest.get(road.name)?.length ?? 0)) longest.set(road.name, road.points);
    }
    for (const [name, points] of longest) {
      const middle = Math.floor(points.length / 4) * 2; // an even index: an x
      add(name, "road", points[middle], points[middle + 1]);
    }

    this.input.addEventListener("input", () => this.search());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && this.shown.length) { e.preventDefault(); this.highlight(this.active + 1); }
      else if (e.key === "ArrowUp" && this.shown.length) { e.preventDefault(); this.highlight(this.active - 1); }
      else if (e.key === "Enter" && this.shown.length) this.choose(this.shown[Math.max(0, this.active)]);
    });
    // Click the map to drop a pin there.
    this.canvas.addEventListener("click", (e) => {
      const box = this.canvas.getBoundingClientRect();
      const [x, z] = this.minimap.toWorld((e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height);
      // Name the pin after the nearest named place, when one is close.
      let near: Entry | null = null;
      let nearDist = 60;
      for (const entry of this.entries) {
        const d = Math.hypot(entry.x - x, entry.z - z);
        if (d < nearDist) { nearDist = d; near = entry; }
      }
      this.choose({ name: near ? `Near ${near.name}` : "Pin on the map", x, z });
    });
    document.getElementById("map-clear")!.addEventListener("click", () => this.choose(null));
    document.getElementById("map-close")!.addEventListener("click", () => this.close());

    // M opens and closes the map; Esc closes it. While you are typing in the
    // search box, M is just the letter m.
    window.addEventListener("keydown", (e) => {
      const typing = e.target === this.input;
      if (e.code === "Escape" && this.isOpen) this.close();
      else if (e.code === "KeyM" && !typing && !e.repeat) {
        if (this.isOpen) this.close();
        else this.wantsOpen = true; // main.ts opens it, because it knows where you are
      }
    });
  }

  /** True once after M was pressed while the map was closed. */
  wantsOpen = false;

  get isOpen(): boolean {
    return !this.overlay.hidden;
  }

  open(x: number, z: number, heading: number): void {
    this.wantsOpen = false;
    this.you = { x, z, heading };
    this.overlay.hidden = false;
    setKeysPaused(true); // typing "w" in the search box must not drive the bus
    this.input.value = "";
    this.search();
    this.draw();
    this.input.focus();
  }

  close(): void {
    this.overlay.hidden = true;
    this.input.blur();
    setKeysPaused(false);
  }

  /** main.ts calls this when you arrive, so the pin goes away. */
  clearDestination(): void {
    this.destination = null;
  }

  private choose(destination: Destination | null): void {
    this.destination = destination && { name: destination.name, x: destination.x, z: destination.z };
    this.onChoose(this.destination);
    this.draw();
    this.showNote();
  }

  private showNote(): void {
    const d = this.destination;
    this.note.textContent = d
      ? `Going to ${d.name} · ${this.far(d)}. Press M or Esc to drive.`
      : "Type a name, or click the map to drop a pin.";
    document.getElementById("map-clear")!.hidden = !d;
  }

  /** "450 m" or "1.2 km" from where you are. */
  private far(p: { x: number; z: number }): string {
    const metres = Math.hypot(p.x - this.you.x, p.z - this.you.z);
    return metres < 1000 ? `${Math.round(metres / 10) * 10} m` : `${(metres / 1000).toFixed(1)} km`;
  }

  // Every typed word must be found in the place: in its name (worth a lot)
  // or in its kind (worth a little). If hardly anything matches, try again
  // forgiving one or two wrong letters.
  private search(): void {
    const q = clean(this.input.value);
    const tokens = q.split(" ").filter((t) => t && !SKIP.has(t));
    let hits: { entry: Entry; score: number }[] = [];
    for (const forgiving of [false, true]) {
      if (tokens.length === 0 || hits.length >= 5) break;
      hits = [];
      for (const entry of this.entries) {
        let score = 0;
        for (const t of tokens) {
          let best = 0;
          for (const w of entry.words) {
            if (w === t) best = Math.max(best, 10);
            else if (w.startsWith(t)) best = Math.max(best, 6);
            else if (t.length >= 3 && w.includes(t)) best = Math.max(best, 3);
            else if (forgiving && t.length >= 4 && typos(t, w) <= (t.length >= 7 ? 2 : 1)) best = Math.max(best, 2.5);
          }
          if (best < 6 && entry.extra.some((w) => w === t || (t.length >= 3 && w.startsWith(t)))) best = Math.max(best, 2);
          if (best === 0) { score = -1; break; }
          score += best;
        }
        if (score < 0) continue;
        const name = entry.words.join(" ");
        if (name === q) score += 40;
        else if (name.startsWith(q)) score += 15;
        // Among equal matches, the nearer place comes first.
        score -= Math.hypot(entry.x - this.you.x, entry.z - this.you.z) / 2000;
        hits.push({ entry, score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    this.shown = hits.slice(0, 25).map((h) => h.entry);
    this.active = -1;

    // Built with textContent, never innerHTML: the names come from a public
    // map that anyone can edit.
    this.list.replaceChildren(
      ...this.shown.map((entry) => {
        const li = document.createElement("li");
        const name = document.createElement("b");
        name.textContent = entry.name;
        const sub = document.createElement("span");
        sub.textContent = `${entry.kind} · ${this.far(entry)}`;
        li.append(name, sub);
        li.addEventListener("click", () => this.choose(entry));
        return li;
      }),
    );
    if (tokens.length && this.shown.length === 0) this.note.textContent = `Nothing on this map matches “${this.input.value.trim()}”.`;
    else this.showNote();
  }

  private highlight(i: number): void {
    this.active = (i + this.shown.length) % this.shown.length;
    [...this.list.children].forEach((li, n) => li.classList.toggle("on", n === this.active));
    this.list.children[this.active]?.scrollIntoView({ block: "nearest" });
  }

  /** The whole town, your arrow, and the destination's pin. */
  private draw(): void {
    const c = this.canvas.getContext("2d")!;
    const size = this.canvas.width;
    this.minimap.drawWhole(this.canvas);

    if (this.destination) {
      const [x, y] = this.minimap.toMap(this.destination.x, this.destination.z);
      c.beginPath();
      c.arc(x * size, y * size, 13, 0, Math.PI * 2);
      c.fillStyle = "#ffd23f";
      c.strokeStyle = "#1b2a4a";
      c.lineWidth = 5;
      c.fill();
      c.stroke();
    }

    const [x, y] = this.minimap.toMap(this.you.x, this.you.z);
    c.save();
    c.translate(x * size, y * size);
    c.rotate(-this.you.heading);
    c.beginPath();
    c.moveTo(0, 18);
    c.lineTo(12, -14);
    c.lineTo(0, -6);
    c.lineTo(-12, -14);
    c.closePath();
    c.fillStyle = "#d62828";
    c.strokeStyle = "#ffffff";
    c.lineWidth = 4;
    c.stroke();
    c.fill();
    c.restore();
  }
}
