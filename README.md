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

## Enemies

Fourteen kinds, introduced gradually (a toast announces each new one): Swarmer, Grunt, Brute, Titan (boss every tenth wave), plus Sprinter (very fast), Plated (every bullet and shell loses 10 damage, beams and fire ignore armor), Medic (heals enemies around it), Phantom (blinks out of reach about a third of the time), Shielded (regenerating shield, burning bypasses it) and Berserker (speeds up as it is hurt).

Four heavy units arrive in later waves and turn the late game into a siege. Juggernaut (wave 22, armor 22), Warlord (wave 28, rallies nearby enemies to run 35 percent faster), Behemoth (waves 35, 45, 55 and so on, armor 40) and Leviathan (waves 50, 75, 100 and so on, armor 60, costs 40 lives if it reaches the gate). Bullets and shells lose their damage to armor (never more than 70 percent), so beams, flames and the armor piercing upgrades matter. A single wave is capped at 1500 bodies; past that, extra strength shows up as heavier units instead of more swarmers.

Waves launch on a timer, there is no skip button. Gold is deliberately scarce: kills pay little, so where you spend matters.

## Research

Dying earns research points (more for higher waves and more kills). Spend them in the research tree, opened from the game-over card or the menu, for permanent bonuses in six branches: Economy (starting gold, bounties, wave income, salvage), Defense (lives, damage, range, slower enemies), Engineering (cheaper towers and upgrades, workshop budget and slots), Arsenal (unlocks for workshop perks), Mastery (opens tier 4 and tier 5 upgrades for each weapon) and Logistics (starting iron and coal, drill speed, warehouse size, ammo efficiency, level 3 drills). Progress is saved in the browser's local storage.

## Turret workshop

Design your own turret from the menu, game-over card or the in-game Workshop button. Pick a behaviour (gun, laser, flame or mortar), spread stat points over its sliders within a budget, choose up to two perks, name and colour it. The price follows the stats, and a design left at defaults costs exactly the standard tower. Saved designs appear as build options and keep the behaviour's upgrade tree. Research raises the point budget and slots and unlocks more perks.

## Mining and ammunition

Towers burn ammunition from a shared stockpile: iron for guns (0.12 per shot) and mortars (1.1 per shell), coal for flames (0.5 per second) and lasers (0.35 per second). Tap an ore patch on the high ground beside the canyon to build a drill (45 gold, up to four per patch, upgradable to level 2 and 3). Drills feed the stockpile, richer patches pay more, and a warehouse cap stops hoarding. When a resource hits zero every tower that uses it goes dark until mining catches up, so faster fire rates, bigger crowds and more towers all have to be paid for. The HUD shows both stocks with their net income. Ammo use is billed from a per tower counter the GPU keeps, read back with the other counters, so it costs nothing per enemy.

## Maps

The menu offers the hand-drawn sketch canyon or a random map. A random map is built from a seed: a winding canyon, six to eight rock islands to build on and ore patches in the walls. Every candidate is validated before you see it (`js/mapgen.js`): no sealed pockets, no area where the flow field points back toward the entry (a bucket enemies would fall into and cluster), no pinch narrower than the biggest enemy, and simulated walkers of three sizes starting from every entry row have to reach the gate without stalling. Failing seeds are re-rolled, and the menu tells you how often. The seed is shown so a good map can be replayed.

## Upgrade trees

Every tower has its own tree: pick one of two paths (tier 1), then one of two specialties inside it (tier 2), then take the shared Veteran capstone (tier 3). Research unlocks two more tiers per weapon: a mastery that builds on the specialty you chose (tier 4, four per weapon) and one of two ultimates (tier 5). The new stats are armor piercing, crit chance and an execute bonus against nearly dead enemies, on top of the existing ones. Each choice locks out its alternatives for that tower, so two guns can end up as very different weapons. Open the full tree from a tower's panel with "Upgrade tree". Selling returns 70 percent of everything spent on it.

| Tower | Path A | Path B |
| --- | --- | --- |
| Gun | Rapid Fire, then Gatling (more speed) or Frag Rounds (splash) | Long Barrel, then Piercing Rounds (hits a whole line) or Armor Breaker (percent of max health) |
| Laser | Wide Lens, then Overcharge (damage ramps while locked on) or Cryo Beam (slows) | Focus Lens, then Searing Beam (ignites) or Deadeye (percent of max health) |
| Flame | Napalm, then Wildfire (fire spreads between enemies) or Brimstone (slows) | Dragon Breath, then Blue Flame (more damage) or Firestorm (wide cone) |
| Mortar | Heavy Shells, then Siege Breaker (big targets) or Shock Shells (slows) | Rapid Mortar, then Incendiary (ignites) or Saturation (huge radius) |

| Tower | Tier 4 masteries (by specialty) | Tier 5 ultimates |
| --- | --- | --- |
| Gun | Minigun (crits), Cluster Rounds (wider splash), Railgun (armor piercing), Executioner (finishes the weak) | Overwatch (range and crits), Tungsten Core (ignores all armor) |
| Laser | Meltdown (ramps to x5), Absolute Zero (70 percent slow), Plasma Beam (very hot burn), Annihilator (percent of max health, execute) | Prism Array (wide beam), Sun Lance (range and damage) |
| Flame | Chain Inferno (fire jumps far), Tar Pits (60 percent slow), White Fire (damage and percent of max health), Cataclysm (huge cone) | Dragonfire (damage and reach), Thermite (burn x2.5) |
| Mortar | Bunker Buster (percent of max health, armor piercing), Cryo Barrage (75 percent slow), Napalm Shells, Carpet Bombing | Siege Engine (damage and range), Barrage (rapid fire) |

The nodes and numbers live in `js/data.js`; their effects run in the shaders.

## How it works

All enemy simulation runs in WebGPU compute shaders (`js/shaders.js`). Up to 4096 enemies (fourteen kinds, with armor, shields, healing, phasing and rage handled in the shader) live in a GPU buffer, double-buffered each step:

1. `clearGrid` and `buildGrid` bin enemies into a 24 px spatial hash.
2. `towers` picks targets and decides what fires, one thread per tower.
3. `enemies` applies tower damage, steers along a precomputed flow field, separates neighbours through the hash grid, pushes out of terrain using a signed distance field, spawns new enemies from a ring buffer and counts kills, gold and leaks atomically.

Enemies, tower bodies, beams, flames, shells and explosions are drawn straight from those buffers by instanced SDF shaders, so the CPU never touches per-enemy data. Only a 16 byte counter block and the per tower ammo counters are read back each frame, for gold, lives and ammunition.

`js/map.js` turns a layout (wall polygons and rock polygons, from the sketch or from the generator) into the flow field (Dijkstra with a wall-clearance penalty) and the distance field. The terrain itself is a static 2D canvas under the GPU canvas.

## Files

- `js/data.js` tower stats, upgrade trees, enemy and wave tables
- `js/meta.js` saved progress and the research tree
- `js/design.js` workshop maths (stats, pricing, perks)
- `js/research.js`, `js/workshop.js` the two overlays
- `js/map.js` level geometry, flow and distance fields, build checks
- `js/mapgen.js` seeded map generator, ore placement and the dead-end validator
- `js/economy.js` drills, stockpile and ammunition accounting
- `js/shaders.js` WGSL for the simulation and rendering
- `js/gpu.js` WebGPU setup, buffers, per-frame submission
- `js/main.js` game state, waves, UI
- `test/game.test.mjs` map reachability, generated map validation, mining and ammo accounting, tables and wave checks (`node --test test/game.test.mjs`)

Tuning lives in `js/data.js`.
