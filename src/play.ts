import { Agent, type GameKey } from './agent.ts';
import { readScene, type Scene } from './vision.ts';

export interface Game {
  screenshot(): Promise<Uint8Array>;
  pressKey(key: GameKey, options: { settle: false }): Promise<void>;
  tap(at: { x: number; y: number }): Promise<unknown>;
}

export interface PlayOptions {
  /** Stop after this long, in ms. */
  budgetMs: number;
  /** Stop after this many runs end. */
  runs: number;
  print: (line: string) => void;
}

export interface Run {
  startedAt: number;
  endedAt: number;
  /** When the tutorial said "Now GO!", for the first run of a fresh browser. */
  tutorialEndedAt?: number;
}

export interface PlayReport {
  runs: Run[];
  shotMs: number[];
  keyMs: number[];
  decisions: number;
}

const SCREENSHOT_WORKERS = 3;
// Where inside a screenshot request the frame is taken, as a fraction of the round trip.
const CAPTURE_POINT = 0.5;
const RUN_OVER_AFTER_MS = 1500;
const TIMED_KEY_TICK_MS = 20;
// After a run: "Save me!" times out, an ad may play, then "Press Space to continue", then the score board.
const CONTINUE_AFTER_MS = 5000;
const CONTINUE_EVERY_MS = 2500;
const PLAY_TAP_EVERY_MS = 4000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? NaN;

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const color = (code: number, s: string) => `\x1b[${code}m${s}\x1b[0m`;

function paint(note: string): string {
  return note
    .replace(/-> ([A-Z]+)$/, (_, action: string) => '-> ' + bold(color(33, action)))
    .replace(/train@\d+|barrier@\d+/g, (m) => color(31, m))
    .replace(/\bclear\b/g, (m) => color(32, m));
}

export async function play(game: Game, options: PlayOptions): Promise<PlayReport> {
  const agent = new Agent();
  const t0 = Date.now();
  const clock = (t = Date.now()) => ((t - t0) / 1000).toFixed(1).padStart(6) + 's';
  const report: PlayReport = { runs: [], shotMs: [], keyMs: [], decisions: 0 };
  let run: Run | null = null;
  let lastPlayingAt = 0;
  let newestCapture = 0;
  let runOverAt = 0;
  let lastContinueAt = 0;
  let lastPlayTapAt = 0;
  let stopped = false;

  const send = (key: GameKey, why?: string) => {
    const sentAt = Date.now();
    game.pressKey(key, { settle: false }).then(
      () => {
        const tookMs = Date.now() - sentAt;
        report.keyMs.push(tookMs);
        if (why) options.print(`${clock()}  ${dim(`${why} ${key}: Revyl answered in ${(tookMs / 1000).toFixed(2)} s`)}`);
        agent.keyLanded(key, Date.now(), tookMs);
      },
      (error: unknown) => {
        options.print(`${clock()}  ${color(31, `${key} failed: ${error instanceof Error ? error.message : String(error)}`)}`);
        agent.keyLanded(key, Date.now());
      },
    );
  };

  const startNextRun = (scene: Scene, now: number) => {
    if (scene.scoreBoard) {
      if (now - lastPlayTapAt < PLAY_TAP_EVERY_MS) return;
      lastPlayTapAt = now;
      options.print(`${clock()}  score board -> tap PLAY`);
      game.tap(scene.playButton).catch(() => undefined);
      return;
    }
    if (lastPlayTapAt > runOverAt) return;
    if (now - runOverAt < CONTINUE_AFTER_MS || now - lastContinueAt < CONTINUE_EVERY_MS) return;
    lastContinueAt = now;
    send('space');
  };

  const observe = async (offsetMs: number) => {
    await sleep(offsetMs);
    while (!stopped) {
      const requestedAt = Date.now();
      let png: Uint8Array;
      try {
        png = await game.screenshot();
      } catch (error) {
        options.print(`${clock()}  ${color(31, `screenshot failed: ${error instanceof Error ? error.message : String(error)}`)}`);
        await sleep(500);
        continue;
      }
      const receivedAt = Date.now();
      report.shotMs.push(receivedAt - requestedAt);
      const capturedAt = requestedAt + CAPTURE_POINT * (receivedAt - requestedAt);
      if (capturedAt <= newestCapture) continue;
      newestCapture = capturedAt;
      const scene = readScene(png);
      if (scene.playing) {
        lastPlayingAt = capturedAt;
        if (!run) {
          run = { startedAt: capturedAt, endedAt: capturedAt };
          options.print(`${clock()}  ${bold(`run ${report.runs.length + 1} started`)}`);
        }
        run.endedAt = capturedAt;
        if (scene.prompt === 'go') run.tutorialEndedAt ??= capturedAt;
      } else if (run && capturedAt - lastPlayingAt > RUN_OVER_AFTER_MS) {
        report.runs.push(run);
        const seconds = (run.endedAt - run.startedAt) / 1000;
        const free = run.tutorialEndedAt ? `, ${((run.endedAt - run.tutorialEndedAt) / 1000).toFixed(1)} s after the tutorial` : '';
        options.print(`${clock()}  ${bold(color(31, `run ${report.runs.length} over after ${seconds.toFixed(1)} s${free}`))}`);
        run = null;
        runOverAt = Date.now();
        if (report.runs.length >= options.runs) stopped = true;
      } else if (!run && runOverAt) {
        startNextRun(scene, Date.now());
      }
      const decision = agent.decide(scene, capturedAt, Date.now());
      if (decision.presses.length) report.decisions++;
      for (const key of decision.presses) send(key);
      if (scene.playing || decision.presses.length) {
        options.print(`${clock()}  ${dim(`shot ${((receivedAt - requestedAt) / 1000).toFixed(2)}s`)}  ${paint(decision.note)}`);
      }
    }
  };

  const sendTimedKeys = async () => {
    while (!stopped) {
      for (const key of agent.takeDue(Date.now())) send(key, 'timed');
      await sleep(TIMED_KEY_TICK_MS);
    }
  };

  const budget = setTimeout(() => (stopped = true), options.budgetMs);
  try {
    await Promise.all([...Array.from({ length: SCREENSHOT_WORKERS }, (_, i) => observe((i * 1000) / SCREENSHOT_WORKERS)), sendTimedKeys()]);
  } finally {
    stopped = true;
    clearTimeout(budget);
  }
  if (run) report.runs.push(run);
  options.print('');
  options.print(bold('Summary'));
  options.print(`  screenshots: ${report.shotMs.length}, median ${(median(report.shotMs) / 1000).toFixed(2)} s`);
  options.print(`  keys: ${report.keyMs.length}, median ${(median(report.keyMs) / 1000).toFixed(2)} s from send to Revyl's answer`);
  report.runs.forEach((r, i) => {
    const free = r.tutorialEndedAt ? ` (${((r.endedAt - r.tutorialEndedAt) / 1000).toFixed(1)} s after the tutorial)` : '';
    options.print(`  run ${i + 1}: ${((r.endedAt - r.startedAt) / 1000).toFixed(1)} s${free}`);
  });
  return report;
}
