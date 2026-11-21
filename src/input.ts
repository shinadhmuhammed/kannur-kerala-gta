// Keyboard input.
//
// Why not act inside the keydown event? Key events fire at the keyboard's repeat
// rate, not once per frame, so the car would move unevenly. Instead we only
// remember which keys are down, and the game loop asks "is W down right now?"
// every frame.

const down = new Set<string>();
// Keys pressed since the last frame. "Get in / get out" must happen once per
// press, not 60 times a second while the key is held, so it needs this.
const justPressed = new Set<string>();

// While the big map is open the keyboard belongs to its search box, so the
// game must not see the keys: typing "w" would drive the bus.
let paused = false;
export function setKeysPaused(value: boolean): void {
  paused = value;
  down.clear();
  justPressed.clear();
}

window.addEventListener("keydown", (e) => {
  if (paused) return;
  // e.repeat is true for the automatic repeats while a key is held down.
  if (!e.repeat) justPressed.add(e.code);
  down.add(e.code);
  // Stop the arrow keys and Space from scrolling the page.
  if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
});
window.addEventListener("keyup", (e) => down.delete(e.code));
// If the window loses focus we never get the keyup, so release everything.
window.addEventListener("blur", () => down.clear());

const any = (...codes: string[]) => codes.some((c) => down.has(c));

/** What the player is asking the car to do this frame. */
export interface Controls {
  throttle: number; // 1 = forward, -1 = brake / reverse, 0 = nothing
  steer: number; // 1 = left, -1 = right, 0 = straight
  handbrake: boolean;
  reset: boolean;
  run: boolean; // Shift, on foot
  enter: boolean; // E was pressed this frame: get in or out of the car
  duty: boolean; // B was pressed this frame: start or end bus duty
}

export function readControls(): Controls {
  const forward = any("KeyW", "ArrowUp") ? 1 : 0;
  const back = any("KeyS", "ArrowDown") ? 1 : 0;
  const left = any("KeyA", "ArrowLeft") ? 1 : 0;
  const right = any("KeyD", "ArrowRight") ? 1 : 0;
  const enter = justPressed.has("KeyE");
  const duty = justPressed.has("KeyB");
  justPressed.clear(); // each press is reported in exactly one frame
  return {
    throttle: forward - back,
    steer: left - right,
    handbrake: down.has("Space"),
    reset: down.has("KeyR"),
    run: any("ShiftLeft", "ShiftRight"),
    enter,
    duty,
  };
}
