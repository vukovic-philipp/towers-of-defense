# Towers of Defense

A static, WebGPU tower defense game. Hundreds of enemies pour through a canyon from the left toward your gate on the right. Build on the rocks to shoot, burn and blast them. The level layout comes from a hand-drawn sketch.

No build step and no dependencies: plain ES modules, so it deploys to GitHub Pages as is.

## Play

Open `index.html` through any static server (WebGPU needs a secure context, and `localhost` counts):

```
npx http-server . -p 8080
```

Needs WebGPU: Safari on iPadOS or iOS 26 and later, or current Chrome and Edge. Designed for iPad landscape (16:9 board, letterboxed on other ratios), with touch input.

## Towers

| Tower | Effect |
| --- | --- |
| Gun | Fast single target hits on the enemy furthest along |
| Laser | Continuous beam that pierces everything on its line |
| Flame | Cone of fire that also leaves enemies burning |
| Mortar | Slow shells that explode on the densest clump |

Each tower has four levels. Selling returns 70 percent of everything spent on it.

## How it works

All enemy simulation runs in WebGPU compute shaders (`js/shaders.js`). Up to 4096 enemies live in a GPU buffer, double-buffered each step:

1. `clearGrid` and `buildGrid` bin enemies into a 24 px spatial hash.
2. `towers` picks targets and decides what fires, one thread per tower.
3. `enemies` applies tower damage, steers along a precomputed flow field, separates neighbours through the hash grid, pushes out of terrain using a signed distance field, spawns new enemies from a ring buffer and counts kills, gold and leaks atomically.

Enemies, tower bodies, beams, flames, shells and explosions are drawn straight from those buffers by instanced SDF shaders, so the CPU never touches per-enemy data. Only a 16 byte counter block is read back each frame, for gold and lives.

`js/map.js` turns the sketch polygons into the flow field (Dijkstra with a wall-clearance penalty) and the distance field at startup. The terrain itself is a static 2D canvas under the GPU canvas.

## Files

- `js/data.js` tower, enemy and wave tables
- `js/map.js` level geometry, flow and distance fields, build checks
- `js/shaders.js` WGSL for the simulation and rendering
- `js/gpu.js` WebGPU setup, buffers, per-frame submission
- `js/main.js` game state, waves, UI
- `test/game.test.mjs` map reachability, tables and wave checks (`node --test test/game.test.mjs`)

Tuning lives in `js/data.js`.
