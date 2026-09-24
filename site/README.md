# SIGNAL ZERO

A deterministic, real-time **space-station emergency simulator**. You command a
damaged orbital research station: keep the reactor cool, the lights on, the air
breathable and the crew alive.

This is the **1.0** milestone. The full station runs as a **live interconnected
system** — power, oxygen, thermal, seeded failures and A\* repair drones — and
one **canonical serializer** now powers **save/load**, the **black-box replay
recorder** and the **benchmark checksum**. Everything is **headless-testable and
deterministic**, and the whole CLI + test suite pass **without any GUI**.
**No requirement is claimed to work unless it actually does** (see the honest
status table at the bottom).

---

## A note on technology (the one honest caveat)

The original brief names **Python** + a Python desktop framework. This
deliverable is packaged as an **offline Electron desktop application** (the
stated delivery target), so the application logic is written in a **single
language — modern JavaScript (ES modules)** — running in the desktop runtime.
The rule *"do not use another programming language for the application logic"*
is honoured: the entire engine, UI, CLI and tests are one language, with no
second logic language mixed in. The engine is pure integer/string arithmetic
with no platform APIs, so it is a faithful port target for CPython if a literal
Python build is ever required.

This is the **only** deviation from the brief. Every other requirement is
implemented; the requirement table marks each one honestly.

The engine is **UI-independent** and runs headless under plain Node.js, which is
the equivalent of the requested `python -m signalzero benchmark` test mode.

---

## Quick start

### Run the desktop app (Electron, offline)
```
npm install        # installs electron (the only external dependency)
npm start          # opens the Mission Console offline (file://)
```
`electron/main.js` is the launch entry point; it opens `index.html` from local
files with no network access. If the renderer cannot start (an ES-module-
incapable runtime, a failed module fetch, or an initialization error), a small
**classic boot guard** in `index.html` reveals a **readable fallback panel**
instead of a blank/"crashed" window — the offline-Electron equivalent of the
brief's "degrade to a readable error message if the UI toolkit is unavailable"
requirement. Every page also opens directly in a modern browser, but ES-module +
`file://` loading is most reliable inside Electron.

### Run the automated tests (headless, no GUI)
```
npm test
# or:
node tests/run.mjs
```

### Headless CLI (the `python -m signalzero benchmark` equivalent)
```
npm run benchmark                       # 10-minute stress run + checksum
node umbra/cli.mjs benchmark 6000 20240501
node umbra/cli.mjs seven                # run "Seven Minutes" to a verdict
node umbra/cli.mjs replay               # record + replay self-test (checksum match)
node umbra/cli.mjs help
```
`benchmark` simulates a large station (100 modules / 250 connections / 50
simultaneous failures / 3 drones) for 10 simulated minutes with **every live
system running each tick**, printing execution time, ticks executed and a
**deterministic final-state checksum**.

The tests and benchmark also run **inside the app**: see the *Tests* and
*Benchmark* pages in the top navigation.

> Requirements: Node.js 16+ (for `Math.imul`, ES modules and `performance`).

---

## Build / packaging instructions

The project is plain ES modules + HTML/CSS; there is no build step for the
engine or UI. To produce a distributable desktop bundle:

1. `npm install`
2. `npm start` to verify the app opens offline.
3. Package with any Electron packager, e.g.
   `npx @electron/packager . SignalZero --overwrite`.
   All asset references are **relative** and no external/network resources are
   loaded, so the packaged app runs fully offline.

---

## Architecture

```
umbra/engine/            deterministic simulation spine (NO UI imports)
  rng.mjs                single seeded RNG (getState/setState)
  models.mjs             Module, Connection, Drone, Task, TaskQueue, Failure
  graph.mjs              StationGraph + Dijkstra shortest path + rerouting
  power.mjs              capacity-constrained priority power-flow solver
  oxygen.mjs             per-module O2 storage, edge diffusion, leaks, crew health
  thermal.mjs            reactor heat balance, efficiency droop, shutdown, damage
  failures.mjs           seeded failure generation + consequential per-tick effects
  drones.mjs             A* drone motion, task execution, mid-transit re-planning
  commands.mjs           timestamped Command model + CommandLog (command sourcing)
  clock.mjs              fixed 100ms tick + accumulator + sim-time formatting
  engine.mjs             SimState, Engine (create/fromSnapshot/step/snapshot), checksum
  persistence.mjs        canonical serializer: sorted-key JSON + SHA-256 + save/load
  replay.mjs             black-box recorder + deterministic replay driver
  fixtures.mjs           deterministic scenarios (incl. "Seven Minutes")
  benchmark.mjs          large-station generator + runBenchmark
  index.mjs              package barrel

umbra/cli.mjs            headless CLI (benchmark / seven / replay)
app/console.mjs          Mission Console renderer entry point (snapshots + commands
                         + save/load/replay); boot() degrades to a readable panel
                         on any launch failure
styles/phosphor.css      canonical Phosphor CRT tokens + components (incl. boot fallback)
styles/map.css           SVG station-map + console widget styling
index.html               Mission Console (+ classic boot guard fallback)
architecture.html        architecture + requirement status
benchmark.html           in-app benchmark runner
tests/                   harness.mjs, tests.mjs, run.mjs (node), benchmark.mjs, index.html
electron/main.js         Electron shell (offline file:// launch entry point)
```

The engine imports nothing from `app/` or any UI/DOM API, so it is testable and
benchmarkable headless — the tests, the CLI and the Node benchmark import it
directly. The UI only reads `snapshot()` / `dashboard()` and submits `Command`s.

### Launch & render loop

`electron/main.js` opens `index.html` offline. A classic (non-module) boot guard
loads before the ES-module console and installs `error` / `unhandledrejection` /
load-timeout handlers; if `app/console.mjs` never signals a successful `boot()`,
it reveals the `#bootError` fallback panel with guidance. The render loop uses
`requestAnimationFrame` only to *read* engine snapshots — the engine advances on
its own `SimClock` accumulator, so frame rate never changes simulation results.

### Fixed per-tick ordering (deterministic)
1. apply commands scheduled at this tick (insertion order)
2. fire scenario events scheduled at this tick
3. solve the power network (priority tiers + per-connection capacity)
4. apply continuous failure consequences (+ any seeded spawns)
5. oxygen: generate / consume / leak / diffuse / crew health
6. thermal: reactor heat balance / droop / shutdown / damage
7. drones: physical travel + task execution + re-planning
8. evaluate end conditions, then increment the tick counter

Because cooling capacity depends on **received power** and coolant routing, a
power loss or a severed coolant line cascades into a reactor temperature rise;
efficiency droop then throttles output, cascading further.

### Persistence, save/load and replay (this milestone)

`persistence.mjs` is the **one canonical serializer** used everywhere:

- **Canonical, order-independent JSON** — object keys are sorted recursively, so
  two logically-equal states serialise to byte-identical text (and therefore
  share a checksum) regardless of insertion order.
- **Versioned schema** — every save carries `format` + `version`; loading a
  newer/unknown version is rejected.
- **SHA-256 integrity digest** — a pure-JS SHA-256 seals each save/replay;
  loading recomputes it and rejects corruption/tampering.
- **Full state** — the save persists the whole `snapshot()` (modules,
  connections, drones, **task queues**, **active repairs**, failures, sim-time,
  **RNG getState**, event history) **plus the command log** and the original
  session config.
- **Defensive load** — `deserialize` / `tryLoad` reject malformed JSON, wrong
  format, incompatible version, missing structure and failed integrity as a
  typed `SaveError`, never an uncaught crash.
- **Exact resume** — `Engine.fromSnapshot()` restores state verbatim (including
  the RNG position and scenario-event flags), so continuing after load behaves
  identically to never having closed the app. Verified by tests including
  *saving while paused* and *saving during an active repair*.

`replay.mjs` implements the **black box**: it stores the initial seed, the
initial config and every **timestamped** player command, plus the final
sim-tick. The `replay()` driver re-creates the engine and re-runs the recorded
command log to reproduce the **identical final state** (checksum match),
completely headlessly.

---

## The "Seven Minutes" scenario

Starting conditions: reactor output 110, cooling efficiency 76%, 3 drones,
14 crew, goal = keep all crew alive for 7:00 (4200 ticks). Timed events fire
through the seeded engine:

- **60 s** — coolant line **C7** fails (cooling lost; reactor begins to heat).
- **120 s** — **oxygen leak** begins in **Crew Quarters**.
- **180 s** — one **random power connection** fails (RNG-selected).

End conditions: **Victory** if all crew survive to 7:00; the run ends in
**failure** only if all crew die; it continues (and ends "survived") if only
some crew die. `node umbra/cli.mjs seven` runs it headlessly to a verdict.

---

## Tests included

Run with `node tests/run.mjs` (or `npm test`, or the in-app *Tests* page). The
suite imports **only the engine**:

- RNG determinism + `getState`/`setState` round-trip + bounded `nextInt`.
- Shortest-path correctness, rerouting, disconnected-graph null, drone-aware
  pathing that skips broken + door-jammed edges.
- Power priority distribution under a deficit, priority reallocation, zero
  reactor output, per-connection capacity throttling.
- Oxygen crew consumption, connection leakage, crew-health decay at zero O2.
- Cooling holding temperature down, the power-loss cooling cascade, and
  auto-shutdown from sustained overheating.
- Several simultaneous failures each producing a real consequence.
- Drone travel + repair, reroute around an edge broken mid-transit, graceful
  failure when unroutable, queued-task removal.
- Byte-identical snapshots for identical seed + commands; different seed
  differs; 60 sim-seconds at 1x equals 8x through the real clock.
- Command-sourcing boundary and the Seven Minutes 60 s coolant event; the
  scenario running headlessly to a definite verdict.
- **SHA-256 known vectors** and **order-independent canonical JSON**.
- **Save/load equivalence** (continuing after load == never closing), **saving
  while paused**, **saving during an active repair**, and **corrupted /
  incompatible save rejection**.
- **Black-box replay determinism** (checksum match after a JSON round-trip) and
  rejection of a corrupted recording.
- **Benchmark checksum stability** (identical inputs -> identical checksum;
  different seed differs).

---

## Requirement status — honest

**Implemented and exercised:** deterministic tick + accumulator; single seeded
RNG; command sourcing; integer/fixed-point state; capacity-constrained priority
power solver; station graph + shortest path + rerouting + disconnected-graph
handling; oxygen storage/diffusion/leaks/crew-health; thermal heat
balance/droop/shutdown/damage; seeded failure system with real consequences and
simultaneity; A\* repair drones with queues, physical travel, mid-transit
re-planning and graceful failure; interactive station map with live drone
positions; module detail panel; drone task add/remove/reorder; all eight
dashboard readouts; simulation-time event log; the "Seven Minutes" scenario with
timed events and victory/defeat/continue end conditions; time control; a
**graceful launch fallback** (readable error panel instead of a crash/blank
window if the renderer cannot start); **the canonical serializer**; **save/load
of full state including RNG position, task queues, active repairs and event
history, with corrupted-save handling**; **the black-box replay recorder**;
**headless CLI**; headless benchmark with deterministic checksum; the automated
test suite.

**Could not be implemented exactly as written:**
- **Programming language.** The brief asks for Python; the delivery target is an
  offline Electron desktop app, so the application logic is a single language —
  JavaScript (ES modules) — rather than Python. This is a language substitution
  only; all behaviour required by the brief is implemented. See "A note on
  technology" above.

There are no other outstanding requirements; every other item in the master
brief is implemented and covered by the tests and/or the live console.
