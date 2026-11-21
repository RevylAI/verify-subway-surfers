import { open } from '@revyl/verify';
import { play } from './play.ts';
import { decodeFrame, gameHeight, isPlaying } from './vision.ts';

const GAME_URL = 'https://poki.com/en/g/subway-surfers';

if (!process.env.REVYL_API_KEY) {
  console.error('Set REVYL_API_KEY (see .env.example).');
  process.exit(1);
}
const budgetMs = Number(process.env.PLAY_SECONDS ?? 360) * 1000;
const runs = Number(process.env.RUNS ?? 3);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const computer = await open({ platform: 'mac', startTimeout: 600_000 });
try {
  await computer.exec(['open', '-a', 'Safari', GAME_URL]);
  await sleep(15_000);
  await computer.tap({ target: 'Fullscreen button in the white bar under the game' });
  await sleep(3000);
  const frame = decodeFrame(await computer.screenshot());
  if (gameHeight(frame) === frame.height) throw new Error('The game did not go fullscreen; check the screenshot in the Revyl session.');
  const start = { x: Math.round(frame.width / 2), y: Math.round(gameHeight(frame) * 0.4) };
  const startBy = Date.now() + 60_000;
  while (!isPlaying(decodeFrame(await computer.screenshot()))) {
    if (Date.now() > startBy) throw new Error('The game did not start within a minute.');
    await computer.tap(start);
    await sleep(3000);
  }
  await play(
    { screenshot: () => computer.screenshot(), pressKey: (key) => computer.pressKey(key), tap: (at) => computer.tap(at) },
    { budgetMs, runs, print: (line) => console.log(line) },
  );
} finally {
  await computer.close();
}
