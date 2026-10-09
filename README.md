# Towers of Defense

Landscape, iPad-first static browser tower defense with real ball physics. Goblins are coloured balls that tumble down a
procedurally generated Voronoi cave from the left of the screen to the castle on the right; towers can be placed anywhere. Endless waves (up to 300 balls per
wave) until the castle falls. Shards earned each run buy permanent upgrades in a small tech tree.

## Run
No build step. Serve the folder with any static server (ES modules need http, not `file://`):

    python3 -m http.server 8000

## Deploy (GitHub Pages)
Settings → Pages → Source: **GitHub Actions**. The included workflow runs the sim tests and publishes the repo root on pushes to `main`.

## Test
    node test/sim.test.mjs

Runs sanity checks, a greedy-bot balance run (with and without tech) and a worst-case perf check.

## Why no WebAssembly? (re-measured with full physics)
The physics (gravity, drag, ball-ball and ball-rock collisions via spatial hashing, 3 substeps per tick) plus targeting
and weapons cost ~0.25 ms per 60 Hz tick (worst single tick ~2-6 ms, dominated by GC/JIT noise) with 300 balls dropped
as one dense blob and 70 max-level towers, against a 16.7 ms budget. Drawing the canvas is the other cost, and WASM
can't speed that up. WASM would add a toolchain and JS<->WASM glue for no visible gain. `js/physics.js` has no DOM
dependency, so it is a clean candidate to port if the ball count ever grows by 10x or more.

## Physics notes
- The simulation runs with gravity along +y; the renderer and input layer transpose x/y, so on screen the balls flow left to right.
  The arena fills the screen: its length follows the screen aspect ratio (clamped to 1.25-2.3) when a run starts.
- The renderer draws in screen-aligned axes with a pre-rendered background (no rotated blits) - this cut frame cost ~5x in software rendering.
- The cave is generated from a seed: relaxed Voronoi sites, each cell shrunk to leave 36 px veins between rocks.
  Every cave is validated by dropping a test batch of balls (including Warlords); caves with dead-end pockets are rerolled.
- Towers do not collide with balls (so they can never block the cave). Archers nudge balls, Cannons blast them
  outwards and upwards, Frost slows, Tesla jolts. Heavier balls move less.
- Prices: every owned tower makes the next one 7% more expensive.

## Layout
- `js/data.js` balls, towers, tech tree, wave formulas · `js/physics.js` cave + ball physics · `js/sim.js` game rules · `js/render.js` canvas
- `js/meta.js` save data (localStorage) · `js/main.js` UI and game loop
