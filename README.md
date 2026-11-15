# Fall Line

Fall Line is a browser ski game: one endless run down a mountain that is generated as you go,
getting faster and narrower the further you get. You steer left and right, stay on the piste, and
see how far and how high you can score before you fall.

## How to play

On a keyboard, steer with the left and right arrow keys or A and D. Any other key starts a run or
starts the next one. P or Escape pauses, and M turns the sound on and off.

On a touch screen, hold the left or right side of the screen to steer, and tap to start.

There is one idea beyond steering. The blue ice strips on the snow speed you up, and riding one, or
cutting close past a tree or other obstacle, raises a score multiplier (up to ×5). The multiplier
holds for a few seconds and then drops a level at a time unless you earn it again, so the safe line
down the middle scores less than the risky one.

Leaving the edge of the piste, missing a gap or hitting something ends the run. Your best score is
kept in the browser's local storage.

## Running it

There is no build step and nothing to install. Open `index.html` in a current browser (it needs
WebGL 2) and it runs straight from the file.

If you would rather serve it, for example to open it from a phone:

```bash
npm start                     # http://127.0.0.1:5173/
node tools/serve.mjs 8080     # another port
HOST=0.0.0.0 npm start        # reachable from other devices on your network
```

Adding `?seed=3` to the address gives the same mountain every time.

## How it is put together

The game is plain scripts on one global, `FL`, loaded in a fixed order by `index.html`. There are no
modules and no dependencies.

```
index.html     the page, its CSS and the HUD markup
fonts/         the two typefaces, as woff2
js/util.js     maths, random numbers, tuning constants
js/track.js    the track generator and the queries the rest of the game asks of it
js/sim.js      physics and scoring, at a fixed 120 steps a second; no rendering, no DOM
js/main.js     the frame loop, input, starting and ending runs
js/hud.js      the DOM overlay: score, multiplier, title and result screens
js/audio.js    sound
js/look.js     light, colour moods and materials shared by the renderer
js/gfx/        the WebGL 2 renderer: a core plus one file per layer (snow, sky, pines, skier, spray…)
tests/         bots that play the game in Node
tools/         screenshots, the local server and the single-file build
docs/DESIGN.md how all of this is meant to work, in detail
```

Because the simulation is separate from the drawing, the same `track.js` and `sim.js` run in Node
without a browser, which is what the tests rely on. `docs/DESIGN.md` covers the look, the coordinate
system, how to write a renderer layer and the performance budget.

## How it is tested

The track is generated from time budgets: how long a player has to see something, decide and move
at the fastest speed possible at that point. The tests check that claim by playing the game.

```bash
npm run fair                        # node tests/run.js fair 4 15000
node tests/run.js human 16 15000    # how far imperfect players get
npm test                            # node --test tests/
```

`fair` sends a bot with perfect reactions down four different mountains for 15 km each and must end
with `deaths 0/4`. A death there means the generator produced a stretch that could not be survived,
so a passing run shows that, on those seeds and over that distance, the track never kills a player
who did everything right. It says nothing about seeds it did not play. `human` runs bots with
delayed, imprecise steering to show how far an ordinary player is likely to get.

For the picture, `node tools/shot.mjs --out shot.png` drives the real page in headless Chromium and
saves frames to look at; its options are listed at the top of that file. It needs Playwright, which
is not a dependency of this repository.

## The single-file build

```bash
npm run build     # writes dist/fall-line.html and dist/artifact.html
npm run check     # the same, then plays both in headless Chromium
```

`dist/fall-line.html` is the whole game in one HTML file, with every script inlined and the fonts
embedded as data URIs. It makes no requests and runs by double-clicking it, so it can be emailed
or dropped on any host. `dist/artifact.html` is the same thing as a fragment, without its own
`<html>`, `<head>` or `<body>`, for a host page that supplies those.

`npm run check` fails unless both files start, request nothing, log no errors, begin a run and have
every renderer layer alive. It also needs Playwright. `dist/` is not committed.

## Fonts

The type is Barlow Condensed and Barlow Semi Condensed, used under the SIL Open Font License 1.1.
The licence text is in `fonts/OFL.txt`.
