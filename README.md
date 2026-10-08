# Towers of Defense

Mobile-first, static browser tower defense. Endless waves of goblins (up to 300 per wave) until your castle falls.
Permanent progression: shards earned each run buy upgrades in a small tech tree.

## Run
No build step. Serve the folder with any static server (ES modules need http, not `file://`):

    python3 -m http.server 8000

## Deploy (GitHub Pages)
Settings → Pages → Source: **GitHub Actions**. The included workflow runs the sim tests and publishes the repo root on pushes to `main`.

## Test
    node test/sim.test.mjs

Runs sanity checks, a greedy-bot balance run (with and without tech) and a worst-case perf check.

## Why no WebAssembly?
Measured, not guessed: the simulation (movement, targeting, damage) with 300 goblins and 80 max-level towers costs
~0.06 ms per 60 Hz tick (budget ≈ 16.7 ms), under 1% of a frame, even before allowing for a slower phone CPU. The real
cost is canvas drawing, which WASM can't speed up (it has no direct canvas access). WASM would add a toolchain, a binary
and JS↔WASM glue for no visible gain. The sim uses struct-of-arrays typed arrays in `js/sim.js` with no DOM
dependency, so it could be ported later if scale grows by orders of magnitude.

## Layout
- `js/data.js` map, goblins, towers, tech tree, wave formulas · `js/sim.js` simulation · `js/render.js` canvas
- `js/meta.js` save data (localStorage) · `js/main.js` UI and game loop
