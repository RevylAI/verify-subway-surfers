import type { Lane, LaneView, Move, Prompt, Scene } from './vision.ts';

export type GameKey = 'arrowleft' | 'arrowright' | 'arrowup' | 'arrowdown' | 'space';

export const KEY_FOR: Record<Move, GameKey> = { left: 'arrowleft', right: 'arrowright', jump: 'arrowup', roll: 'arrowdown' };

type Gate = Exclude<Prompt, 'go'>;
const GATE_KEY: Record<Gate, GameKey> = { ...KEY_FOR, hoverboard: 'space' };
const GATE_TEXT: Record<Gate, string> = {
  jump: 'Press Arrow Key Up',
  roll: 'Press Arrow Key Down',
  left: 'Press Arrow Key Left',
  right: 'Press Arrow Key Right',
  hoverboard: 'Press Space for Hoverboard',
};

export interface Decision {
  /** Keys to send now. */
  presses: GameKey[];
  /** One line for the terminal: what the agent saw and why it acted. */
  note: string;
}

// Rows are in the 960x476 reference frame of vision.ts; bigger is closer. An obstacle takes about as long
// to reach the runner from the far end of the visible track as one screenshot and one key take, so the
// agent leaves a lane as soon as anything shows up in it, for whichever lane is clear or blocked farther
// away. It decides again only on screenshots taken after its last key landed.
const MIN_TRACK_FIT = 0.3;
const MOVE_MARGIN_ROWS = 12;
const PASS_THROUGH_BEFORE = 300;
const JUMP_FROM_ROW = 236;
const STALE_FRAME_MS = 1200;
// A tutorial gate takes its key only while its prompt is up, about a second, which is shorter than the
// screenshot-to-key round trip, so reacting to a prompt is always too late. A missed gate replays on a
// steady cycle, and some gates follow each other within a second. The agent learns both from what it sees
// and sends each key ahead of time, so that Revyl answers it about half a second after the prompt it
// expects. Keys take about 0.8 s on a cloud browser and 0.35 s on a Mac, so it times them by the answers so far.
const ANSWER_AFTER_PROMPT_MS = 520;
const FIRST_KEY_GUESS_MS = 770;
const AIM_NUDGES_MS = [0, -150, 150, -300];
const NEW_PROMPT_AFTER_MS = 600;
const FOLLOW_UP_WITHIN_MS = 2000;
const REPLAY_RANGE_MS = [1500, 15000] as const;
const NO_TUTORIAL_AFTER_MS = 20_000;

interface Onset {
  gate: Gate;
  at: number;
  context: string;
}

interface Scheduled {
  key: GameKey;
  at: number;
  target: Onset;
}

function describe(view: LaneView): string {
  if (view.blockedAt === null) return 'clear';
  return `${view.short ? 'barrier' : 'train'}@${view.blockedAt}`;
}

const LANE_NAME: Record<Lane, string> = { [-1]: 'left', 0: 'middle', 1: 'right' };
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export class Agent {
  private settledAfter = 0;
  private keysInFlight = 0;
  private tutorialDone = false;
  private playingSince = 0;
  private lastCaptureWithoutPrompt = 0;
  private lastSeen: Partial<Record<Gate, number>> = {};
  private lastOnset: Onset | null = null;
  /** What came next after a prompt seen in a given context, when it was missed. */
  private replays = new Map<string, { gate: Gate; afterMs: number }>();
  /** A prompt that appears right after another one is passed. */
  private followUps = new Map<Gate, { gate: Gate; afterMs: number }>();
  private attempts = new Map<Gate, number>();
  private schedule: Scheduled[] = [];
  private keyTimes: number[] = [];

  /**
   * Called when Revyl answers a key, with how long it took, or when the key fails: screenshots taken after
   * this show its effect, so the agent may decide again.
   */
  keyLanded(key: GameKey, now: number, tookMs?: number): void {
    if (tookMs !== undefined) this.keyTimes = [...this.keyTimes, tookMs].slice(-9);
    this.keysInFlight = Math.max(0, this.keysInFlight - 1);
    if (this.keysInFlight === 0) this.settledAfter = now + (key === 'arrowleft' || key === 'arrowright' ? 300 : 450);
  }

  /** Keys the agent timed in advance that are due now. */
  takeDue(now: number): GameKey[] {
    const due = this.schedule.filter((s) => s.at <= now);
    this.schedule = this.schedule.filter((s) => s.at > now);
    return due.map((s) => s.key);
  }

  decide(scene: Scene, capturedAt: number, now = capturedAt): Decision {
    if (!scene.playing) {
      this.playingSince = 0;
      this.lastCaptureWithoutPrompt = capturedAt;
      return { presses: [], note: 'not running' };
    }
    this.playingSince ||= capturedAt;
    if (scene.prompt === 'go') {
      this.tutorialDone = true;
      this.schedule = [];
      return { presses: [], note: 'tutorial: "You rock! Now GO!", playing on my own from here' };
    }
    if (scene.prompt) return this.tutorialGate(scene.prompt, capturedAt);
    this.lastCaptureWithoutPrompt = capturedAt;
    if (!this.tutorialDone) {
      if (capturedAt - Math.max(this.lastOnset?.at ?? 0, this.playingSince) < NO_TUTORIAL_AFTER_MS) {
        return { presses: [], note: 'tutorial: waiting for the next prompt' };
      }
      this.tutorialDone = true;
    }
    if (now - capturedAt > STALE_FRAME_MS) return { presses: [], note: 'frame too old to act on' };
    return this.dodge(scene, capturedAt);
  }

  private tutorialGate(gate: Gate, capturedAt: number): Decision {
    const label = `tutorial: "${GATE_TEXT[gate]}"`;
    const lastSeen = this.lastSeen[gate] ?? -Infinity;
    this.lastSeen[gate] = capturedAt;
    if (this.lastCaptureWithoutPrompt < lastSeen || capturedAt - lastSeen < NEW_PROMPT_AFTER_MS) return { presses: [], note: label };

    const onset: Onset = {
      gate,
      at: capturedAt - Math.min(capturedAt - this.lastCaptureWithoutPrompt, 700) / 2,
      context: `${this.lastOnset?.gate ?? 'start'}>${gate}`,
    };
    const previous = this.lastOnset;
    if (previous) {
      const afterMs = onset.at - previous.at;
      if (previous.gate !== gate && afterMs < FOLLOW_UP_WITHIN_MS) this.followUps.set(previous.gate, { gate, afterMs });
      else this.replays.set(previous.context, { gate, afterMs });
    }
    this.lastOnset = onset;
    const followUp = this.followUps.get(gate);
    this.schedule = this.schedule.filter((s) => followUp && s.target.gate === followUp.gate && Math.abs(s.target.at - (onset.at + followUp.afterMs)) < 1000);

    const presses: GameKey[] = gate === 'hoverboard' ? ['space'] : [];
    const replay = this.replays.get(onset.context);
    if (!replay || replay.afterMs < REPLAY_RANGE_MS[0] || replay.afterMs > REPLAY_RANGE_MS[1]) {
      return { presses, note: `${label}${presses.length ? ' -> SPACE' : ''} (timing how it replays)` };
    }
    const next: Onset = { gate: replay.gate, at: onset.at + replay.afterMs, context: `${gate}>${replay.gate}` };
    const timed = [this.aim(next)];
    const nextFollowUp = this.followUps.get(next.gate);
    if (nextFollowUp) timed.push(this.aim({ gate: nextFollowUp.gate, at: next.at + nextFollowUp.afterMs, context: `${next.gate}>${nextFollowUp.gate}` }));
    const plan = timed.map((s) => `${s.key} in ${seconds(s.at - capturedAt)}`).join(', then ');
    return { presses, note: `${label} -> if missed, "${GATE_TEXT[next.gate]}" returns in ${seconds(next.at - capturedAt)}: ${plan}` };
  }

  private aim(target: Onset): Scheduled {
    const attempt = this.attempts.get(target.gate) ?? 0;
    this.attempts.set(target.gate, attempt + 1);
    const keyMs = this.keyTimes.length ? [...this.keyTimes].sort((x, y) => x - y)[this.keyTimes.length >> 1]! : FIRST_KEY_GUESS_MS;
    const scheduled = { key: GATE_KEY[target.gate], at: target.at + ANSWER_AFTER_PROMPT_MS - keyMs + AIM_NUDGES_MS[attempt % AIM_NUDGES_MS.length]!, target };
    this.schedule.push(scheduled);
    return scheduled;
  }

  private dodge(scene: Scene, capturedAt: number): Decision {
    const { lane, lanes, track } = scene;
    const seen = `lane ${LANE_NAME[lane]} | ahead ${describe(lanes[lane])} | left ${lane > -1 ? describe(lanes[(lane - 1) as Lane]) : 'wall'} | right ${lane < 1 ? describe(lanes[(lane + 1) as Lane]) : 'wall'}`;
    if (track.fit < MIN_TRACK_FIT) return { presses: [], note: `can't see the rails (${Math.round(track.fit * 100)}%)` };
    if (capturedAt < this.settledAfter) return { presses: [], note: `${seen} | waiting for the last key to show` };
    const ahead = lanes[lane].blockedAt;
    if (ahead === null) return { presses: [], note: seen };
    const openness = (l: Lane) => (lanes[l].blockedAt === null ? Infinity : -lanes[l].blockedAt!);
    const passable = (l: Lane) => (lanes[l].blockedAt ?? 0) < PASS_THROUGH_BEFORE;
    const reachable = ([-1, 0, 1] as const).filter((l) => l !== lane && (Math.abs(l - lane) === 1 || passable(0)));
    const best = reachable.sort((x, y) => openness(y) - openness(x) || Math.abs(x - lane) - Math.abs(y - lane))[0];
    if (best !== undefined && openness(best) > openness(lane) + MOVE_MARGIN_ROWS) {
      const key: GameKey = best < lane ? 'arrowleft' : 'arrowright';
      const steps = Math.abs(best - lane);
      this.keysInFlight += steps;
      this.settledAfter = Infinity;
      return { presses: Array(steps).fill(key), note: `${seen} -> ${key === 'arrowleft' ? 'LEFT' : 'RIGHT'}${steps > 1 ? ' x2' : ''}` };
    }
    if (ahead >= JUMP_FROM_ROW) {
      this.keysInFlight++;
      this.settledAfter = Infinity;
      return { presses: ['arrowup'], note: `${seen} -> JUMP` };
    }
    return { presses: [], note: `${seen} | no better lane` };
  }
}
