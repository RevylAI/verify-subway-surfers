import { open } from '@revyl/verify';
import { withFastInput } from './fast-input.ts';
import { play } from './play.ts';
import { decodeFrame, isPlaying } from './vision.ts';

const GAME_URL = 'https://poki.com/en/g/subway-surfers';
const START_TAP = { x: 480, y: 220 };

const appId = process.env.REVYL_APP_ID;
if (!process.env.REVYL_API_KEY || !appId) {
  console.error('Set REVYL_API_KEY and REVYL_APP_ID (see .env.example).');
  process.exit(1);
}
const budgetMs = Number(process.env.PLAY_SECONDS ?? 360) * 1000;
const runs = Number(process.env.RUNS ?? 3);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const session = await open({ platform: 'web', app: { appId, url: GAME_URL }, viewport: { width: 960, height: 540 } });
try {
  await session.tap({ target: 'Fullscreen button in the white bar under the game' });
  const startBy = Date.now() + 60_000;
  while (!isPlaying(decodeFrame(await session.screenshot()))) {
    if (Date.now() > startBy) throw new Error('The game did not start within a minute.');
    await session.tap(START_TAP);
    await sleep(3000);
  }
  const input = withFastInput(session);
  await play(
    { screenshot: () => session.screenshot(), pressKey: input.pressKey, tap: input.tap },
    { budgetMs, runs, print: (line) => console.log(line) },
  );
} finally {
  await session.close();
}
