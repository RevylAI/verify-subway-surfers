import { PNG } from 'pngjs';

export type Move = 'left' | 'right' | 'jump' | 'roll';
export type Prompt = Move | 'hoverboard' | 'go';

export interface Frame {
  width: number;
  height: number;
  data: Buffer;
}

// Every position below is in pixels of a 960-wide screenshot whose game area is 476 rows tall
// (a 960x540 browser with Poki's player in fullscreen), and is scaled to the real screenshot.
const REF_WIDTH = 960;
const REF_GAME_HEIGHT = 476;

export function decodeFrame(png: Uint8Array): Frame {
  const { width, height, data } = PNG.sync.read(Buffer.from(png));
  return { width, height, data };
}

/** The game area ends where Poki's white bar starts. */
export function gameHeight(frame: Frame): number {
  const { width: W, height: H, data } = frame;
  for (let y = Math.floor(H * 0.75); y < H; y++) {
    let white = 0;
    for (let x = 0; x < W; x += 8) {
      const i = (y * W + x) * 4;
      if (data[i]! > 240 && data[i + 1]! > 240 && data[i + 2]! > 240) white++;
    }
    if (white > 0.9 * (W / 8)) return y;
  }
  return H;
}

function rgb(frame: Frame, x: number, y: number): [number, number, number] {
  const xi = Math.min(frame.width - 1, Math.max(0, Math.round(x)));
  const yi = Math.min(frame.height - 1, Math.max(0, Math.round(y)));
  const i = (yi * frame.width + xi) * 4;
  return [frame.data[i]!, frame.data[i + 1]!, frame.data[i + 2]!];
}

function luma(frame: Frame, x: number, y: number): number {
  const [r, g, b] = rgb(frame, x, y);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

const isTextWhite = (frame: Frame, x: number, y: number) => Math.min(...rgb(frame, x, y)) >= 235;

/** A run is on while the blue pause button with its two white bars is in the top-left corner. */
export function isPlaying(frame: Frame): boolean {
  const s = frame.width / REF_WIDTH;
  const blue = (x: number) => {
    const [r, g, b] = rgb(frame, x * s, 28 * s);
    return b > 150 && g > 100 && r < 110 && b - r > 70;
  };
  return blue(15) && blue(28) && blue(40) && luma(frame, 22 * s, 28 * s) > 215 && luma(frame, 34 * s, 28 * s) > 215;
}

/**
 * The tutorial writes "Press Arrow Key Up|Down|Left|Right", "Press Space for Hoverboard" and finally "You rock! Now GO!" in white across the
 * middle of the screen. The words are found by the gaps between them; the first three are always the same width,
 * and the last one tells the direction: "Up" is short, "Left" medium, and "Right" has a descender where "Down" has none.
 */
export function readPrompt(frame: Frame): Prompt | null {
  const { width: W, height: H } = frame;
  const rows: number[] = [];
  for (let y = Math.floor(0.35 * H); y < 0.62 * H; y++) {
    let count = 0;
    let first = W;
    let last = 0;
    for (let x = Math.floor(0.15 * W); x < 0.85 * W; x++) {
      if (!isTextWhite(frame, x, y)) continue;
      count++;
      first = Math.min(first, x);
      last = x;
    }
    if (count > 0.026 * W && Math.abs((first + last) / 2 - W / 2) < 0.03 * W && last - first > 0.15 * W) rows.push(y);
  }
  if (rows.length < 3) return null;
  const top = rows[0]!;
  const lineEnd = rows.find((y, i) => i > 0 && y - rows[i - 1]! > 3);
  const textBottom = lineEnd === undefined ? rows.at(-1)! : rows[rows.indexOf(lineEnd) - 1]!;
  const ink = (x: number) => {
    for (let y = top; y <= textBottom; y++) if (isTextWhite(frame, x, y)) return true;
    return false;
  };
  const words: Array<{ start: number; width: number }> = [];
  const gap = Math.max(3, Math.round(0.005 * W));
  for (let x = Math.floor(0.15 * W); x < 0.85 * W; x++) {
    if (!ink(x)) continue;
    const start = x;
    let blank = 0;
    while (x < 0.85 * W && blank < gap) {
      blank = ink(x) ? 0 : blank + 1;
      x++;
    }
    words.push({ start, width: x - blank - start });
  }
  const near = (px: number, ref: number) => Math.abs(px / W - ref / REF_WIDTH) <= 4 / REF_WIDTH;
  if (words.length === 3 && near(words[0]!.width, 54) && near(words[1]!.width, 58)) return 'hoverboard';
  if (words.length === 4 && near(words[0]!.width, 37) && near(words[1]!.width, 49) && near(words[2]!.width, 43)) return 'go';
  if (words.length !== 4 || !near(words[0]!.width, 53.5) || !near(words[1]!.width, 63) || !near(words[2]!.width, 36.5)) return null;
  const lastWord = words[3]!;
  const width = (lastWord.width / W) * REF_WIDTH;
  if (width < 32) return 'jump';
  if (width < 45) return 'left';
  let descender = 0;
  for (let y = textBottom + 1; y <= textBottom + Math.ceil(0.02 * H); y++) {
    for (let x = lastWord.start; x < lastWord.start + lastWord.width; x++) if (isTextWhite(frame, x, y)) descender++;
  }
  return descender > 2 ? 'right' : 'roll';
}

// The track: three lanes of two rails each. Measured on the default camera, the space between lane
// centres grows by 0.563 px per row below a vanishing row at 104.4, and each rail sits 0.225 of that
// spacing either side of its lane centre. The camera follows the runner sideways and moves in when the
// inspector chases you, so each frame is fitted with a zoom and a sideways shift.
const CENTER_X = 467;
const VANISH_Y = 104.4;
const LANE_SPACING_PER_ROW = 0.563;
const RAIL_OFFSET = 0.225;
const HORIZON_Y = 236;
const FOLLOW_FROM_Y = 262;
const FAR_Y = 150;
const FAR_DECIDE_Y = 168;
const FAR_RAIL_CONTRAST = 8;
const NEAR_RUN = 3;
const FAR_WINDOW = 10;
const FAR_HIDDEN = 8;
const ABOVE_HEAD_Y = 272;
const NEAR_Y = 468;
const FIT_ROWS = [300, 330, 360, 390, 420, 450];
const RAIL_CONTRAST = 12;

const baseSpacing = (y: number) => LANE_SPACING_PER_ROW * (y - VANISH_Y);

function railContrast(frame: Frame, sx: number, sy: number, x: number, y: number, spacing: number): number {
  const reach = Math.max(2, Math.round(0.03 * spacing));
  let rail = 0;
  for (let dx = -reach; dx <= reach; dx++) rail = Math.max(rail, luma(frame, (x + dx) * sx, y * sy));
  const gap = reach + 2 + 0.05 * spacing;
  return rail - Math.max(luma(frame, (x - gap) * sx, y * sy), luma(frame, (x + gap) * sx, y * sy));
}

export interface Track {
  zoom: number;
  /** Where the middle lane is, in lanes right of the runner: 0 in the middle lane, +1 in the left lane, -1 in the right lane. */
  shift: number;
  /** The share of sampled rail positions where a rail was found. */
  fit: number;
}

export function findTrack(frame: Frame, gameH: number): Track {
  const sx = frame.width / REF_WIDTH;
  const sy = gameH / REF_GAME_HEIGHT;
  const cache = new Map<number, number>();
  const contrastAt = (x: number, y: number, s: number) => {
    const key = Math.round(x) * 1000 + y;
    let c = cache.get(key);
    if (c === undefined) cache.set(key, (c = railContrast(frame, sx, sy, x, y, s)));
    return c;
  };
  let best: Track = { zoom: 1, shift: 0, fit: 0 };
  let bestScore = -Infinity;
  for (let zoom = 0.85; zoom <= 1.4; zoom += 0.025) {
    for (let shift = -1.3; shift <= 1.3; shift += 0.025) {
      let score = -30 * Math.abs(shift - Math.round(shift));
      let found = 0;
      for (const y of FIT_ROWS) {
        const s = zoom * baseSpacing(y);
        for (const lane of [-1, 0, 1]) {
          for (const side of [-1, 1]) {
            const x = CENTER_X + (shift + lane) * s + side * RAIL_OFFSET * s;
            if (x < 0 || x >= REF_WIDTH) continue;
            const c = contrastAt(x, y, s);
            score += Math.min(40, Math.max(0, c));
            if (c > RAIL_CONTRAST) found++;
          }
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = { zoom, shift, fit: found / (FIT_ROWS.length * 6) };
      }
    }
  }
  return best;
}

export interface LaneView {
  /** The nearest row (960x476 reference) where the lane's rails vanish behind something, or null when they run to the horizon. */
  blockedAt: number | null;
  /** The rails come back further on, so the thing in the way is short, like a barrier, not a train. */
  short: boolean;
}

// Far away the track bends, so a straight perspective model misses the rails. Past FOLLOW_FROM_Y each
// rail is followed upward from where the model last fits, a pixel or two at a time.
function followRailsVisible(frame: Frame, track: Track, lane: Lane, sx: number, sy: number): Map<number, boolean> {
  const luma2 = (x: number, y: number) => luma(frame, x * sx, y * sy);
  const at = (y: number, side: number) => {
    const spacing = track.zoom * baseSpacing(y);
    return CENTER_X + (track.shift + lane) * spacing + side * RAIL_OFFSET * spacing;
  };
  const rails = [-1, 1].map((side) => ({ x: at(FOLLOW_FROM_Y, side), slope: at(FOLLOW_FROM_Y - 2, side) - at(FOLLOW_FROM_Y, side) }));
  const visible = new Map<number, boolean>();
  for (let y = FOLLOW_FROM_Y - 2; y >= FAR_Y; y -= 2) {
    const gap = Math.max(2, 0.05 * track.zoom * baseSpacing(y));
    let seen = false;
    for (const rail of rails) {
      const predicted = rail.x + rail.slope;
      let best = -Infinity;
      let bestX = predicted;
      for (let dx = -2; dx <= 2; dx++) {
        const x = predicted + dx;
        const contrast = luma2(x, y) - Math.max(luma2(x - gap, y), luma2(x + gap, y));
        if (contrast > best) {
          best = contrast;
          bestX = x;
        }
      }
      if (best > FAR_RAIL_CONTRAST) {
        rail.slope = 0.7 * rail.slope + 0.3 * (bestX - rail.x);
        rail.x = bestX;
        seen = true;
      } else {
        rail.x = predicted;
      }
    }
    visible.set(y, seen);
  }
  return visible;
}

export function viewLane(frame: Frame, track: Track, lane: Lane, gameH: number): LaneView {
  const sx = frame.width / REF_WIDTH;
  const sy = gameH / REF_GAME_HEIGHT;
  const runnersLane = lane === -Math.round(track.shift);
  const start = runnersLane ? VANISH_Y + (ABOVE_HEAD_Y - VANISH_Y) * track.zoom : NEAR_Y;
  const followed = followRailsVisible(frame, track, lane, sx, sy);
  const rows: number[] = [];
  const visible: boolean[] = [];
  for (let y = Math.round(start); y >= FAR_Y; y -= 2) {
    rows.push(y);
    const far = followed.get(y);
    if (far !== undefined) {
      visible.push(far);
      continue;
    }
    const spacing = track.zoom * baseSpacing(y);
    const center = CENTER_X + (track.shift + lane) * spacing;
    const offset = RAIL_OFFSET * spacing;
    visible.push(railContrast(frame, sx, sy, center - offset, y, spacing) > RAIL_CONTRAST || railContrast(frame, sx, sy, center + offset, y, spacing) > RAIL_CONTRAST);
  }
  const hiddenFrom = (i: number) => {
    if (rows[i]! >= HORIZON_Y) return visible.slice(i, i + NEAR_RUN).length === NEAR_RUN && visible.slice(i, i + NEAR_RUN).every((v) => !v);
    if (rows[i]! < FAR_DECIDE_Y) return false;
    return visible.slice(i, i + FAR_WINDOW).filter((v) => !v).length >= FAR_HIDDEN;
  };
  for (let i = 0; i < visible.length; i++) {
    if (!hiddenFrom(i)) continue;
    let short = false;
    for (let j = i + NEAR_RUN; j + NEAR_RUN <= visible.length; j++) if (visible.slice(j, j + NEAR_RUN).every(Boolean)) short = true;
    return { blockedAt: rows[i]!, short };
  }
  return { blockedAt: null, short: false };
}

export type Lane = -1 | 0 | 1;

/** The green PLAY button on the score board shown after a run ends. */
export const PLAY_BUTTON = { x: 548, y: 434 };

export function isScoreBoard(frame: Frame): boolean {
  let green = 0;
  for (let y = 418; y < 452; y += 2) {
    for (let x = 500; x < 600; x += 2) {
      const [r, g, b] = rgb(frame, x, y);
      if (Math.abs(r - 44) < 14 && Math.abs(g - 125) < 16 && b < 30) green++;
    }
  }
  return green > 300;
}

export interface Scene {
  playing: boolean;
  /** The score board with its PLAY button is up. */
  scoreBoard: boolean;
  prompt: Prompt | null;
  track: Track;
  /** The runner's lane: -1 left, 0 middle, 1 right. */
  lane: Lane;
  lanes: Record<Lane, LaneView>;
}

export function readScene(png: Uint8Array): Scene {
  const frame = decodeFrame(png);
  const gameH = gameHeight(frame);
  const playing = isPlaying(frame);
  const track = findTrack(frame, gameH);
  const lane = Math.max(-1, Math.min(1, -Math.round(track.shift))) as Lane;
  return {
    playing,
    scoreBoard: !playing && isScoreBoard(frame),
    prompt: playing ? readPrompt(frame) : null,
    track,
    lane,
    lanes: { [-1]: viewLane(frame, track, -1, gameH), 0: viewLane(frame, track, 0, gameH), 1: viewLane(frame, track, 1, gameH) } as Record<Lane, LaneView>,
  };
}
