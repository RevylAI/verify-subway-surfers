# Verify plays Subway Surfers

An agent that plays [Subway Surfers on Poki](https://poki.com/en/g/subway-surfers) in a Revyl cloud browser, driven through the [Verify SDK](https://www.npmjs.com/package/@revyl/verify). It reads each screenshot with plain pixel checks, not a model. It gets through the game's tutorial by sending each key ahead of the prompt it expects, then dodges trains and barriers on its own until it crashes.

Everything runs on a real cloud browser over the network, so each decision lands about a second and a half after the frame it was based on. That delay is the main limit, and the numbers below show how far the agent gets with it.

## Run it

1. `npm install` (Node 22.18 or newer).
2. Copy `.env.example` to `.env` and fill in `REVYL_API_KEY` and `REVYL_APP_ID`. The app id is any Revyl web app. To create one, see Verify's [web guide](https://github.com/RevylAI/verify/blob/main/packages/verify/docs/web.md#create-the-web-app): in the Revyl dashboard click **Create app**, keep **Web** selected and enter any public HTTPS URL, or run `revyl app create --name "Subway Surfers" --platform web`.
3. `npm start`.

Each run opens one Revyl cloud browser session, plays for up to `PLAY_SECONDS` (360 by default) or `RUNS` runs (3 by default), and closes the session when it ends, errors included. The terminal prints the session link first, so you can watch live. After that it prints one line per screenshot, saying what the agent saw and which key it sent.

## How it works

`src/main.ts` is the whole Verify side:

```ts
const session = await open({ platform: 'web', app: { appId, url: GAME_URL }, viewport: { width: 960, height: 540 } });
try {
  await session.tap({ target: 'Fullscreen button in the white bar under the game' });
  while (!isPlaying(decodeFrame(await session.screenshot()))) {
    await session.tap(START_TAP);
    await sleep(3000);
  }
  const keys = withFastKeys(session);
  await play(
    { screenshot: () => session.screenshot(), pressKey: keys.pressKey, tap: (at) => session.tap(at) },
    { budgetMs, runs, print: (line) => console.log(line) },
  );
} finally {
  await session.close();
}
```

- **Seeing** (`src/vision.ts`): it fits the perspective pattern of the rails to find the track and the runner's lane. It then follows each rail into the distance and marks a lane as blocked where its rails disappear behind something. It also reads the tutorial prompts from the widths of their words, the pause button to tell that a run is on, and the PLAY button on the score board.
- **The tutorial** (`src/agent.ts`): a fresh browser always starts with it. The prompts are Up, Down, Left, Right and Left, then Space for the hoverboard. Each prompt takes its key for only about a second, which is less than one screenshot-and-key round trip, so a key sent after seeing the prompt always arrives too late. A missed prompt replays on a steady cycle of about 3–5 s, and Left comes about a second after Right. The agent learns both timings from what it sees and sends each key ahead of time, aimed just after the prompt it expects, and shifts its aim slightly after each miss. It usually finishes in 2–3 minutes.
- **Free play**: as soon as anything shows up in the runner's lane, the agent moves to the lane that is clear or blocked farthest away, two lanes over if needed. If no lane is better, it jumps when the obstacle gets close. It only acts on screenshots taken after its last key landed.
- **Restarts** (`src/play.ts`): after a crash it waits out "Save me!" and the ad break, presses Space to continue, then taps PLAY.

## Keys use a temporary direct call

`src/fast-keys.ts` sends keys through an undocumented Revyl endpoint. That's because Verify 0.6.3's `pressKey()` waits for the page to settle after every key, and a running game never settles, so each key took about 6 s. The module sends the same key action with that wait skipped, through the SDK's own client, and needs nothing but `REVYL_API_KEY`. It will move to a Verify option once one ships: the direct call will be replaced by `session.pressKey(key, { settle: false })`, and the file deleted. With settling off, a screenshot taken right after a key can still show the frame from before it. So the agent ignores any screenshot captured before Revyl answered the last key.

## Measured limits

Measured on production Revyl cloud browsers with a 960x540 viewport in November 2026:

| What | Measured |
|---|---|
| Screenshot round trip | 0.9–1.05 s median per session, three requests in flight |
| Key, from send to Revyl's answer | 0.77–0.91 s median per session |
| Tutorial | passed in all 4 sessions run with this logic, in 114–175 s |
| Free play | 3.5, 26.8 and 15.4 s with this code; 15.9, 12.0 and 6.4 s in an earlier session before a small fix to two-lane moves |

Runs are short for one reason. At the game's starting speed, an obstacle is visible for about 1–2 s before it reaches the runner, and an oncoming train for about 1 s. The agent needs about 1.4 s from a screenshot being taken until its key takes effect. It survives by moving the moment something appears. It dies when an obstacle shows up too late, or when its vision misreads the track in a tunnel or between parked trains.

## Left out

- **A model that decides each move.** A model call per frame would add a second or more to a loop that is already slower than the game.
- **Faster channels outside Verify's API.** Reading the session's live video stream would cut the delay, but that stream isn't part of the SDK.

## License

[Apache-2.0](LICENSE). Subway Surfers is a game by SYBO, hosted on Poki. This project plays it in a browser and isn't affiliated with either.
