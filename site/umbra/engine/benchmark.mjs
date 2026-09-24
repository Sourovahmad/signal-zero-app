// SIGNAL ZERO - headless benchmark / stress scenario
//
// Generates a large deterministic station (default 100 modules, 250
// connections, 50 failures, 3 drones) from a single seed and advances it for
// 10 simulated minutes (6000 ticks of 100 ms). Emits execution time, ticks
// executed and a deterministic final-state checksum. Every live system
// (power, oxygen, thermal, failures, drones) runs each tick.

import { DeterministicRng } from './rng.mjs';
import { Priority, Resource, FailureType } from './models.mjs';
import { Engine, checksum } from './engine.mjs';

const P = Resource.POWER, O = Resource.OXYGEN, C = Resource.COOLANT;
const PRIORITIES = [Priority.CRITICAL, Priority.HIGH, Priority.NORMAL, Priority.LOW];
const FAILS = Object.values(FailureType);
const O2_CAP = 100000;

/**
 * Build a large, guaranteed-connected station deterministically from a seed.
 * @returns {object} engine config
 */
export function generateLargeStation({
  seed = 20240501, modules = 100, connections = 250, failures = 50,
} = {}) {
  const rng = new DeterministicRng(seed);
  const mods = [];
  for (let i = 0; i < modules; i++) {
    const isReactor = i === 0;
    const isCooler = !isReactor && (i % 7 === 0);
    const isGen = !isReactor && (i % 5 === 0);
    mods.push({
      id: 'm' + i,
      name: (isReactor ? 'Reactor ' : 'Module ') + i,
      x: (i % 10) * 90 + 40,
      y: Math.floor(i / 10) * 90 + 40,
      priority: PRIORITIES[rng.nextInt(0, 3)],
      isReactor,
      isReactorHeatSource: isReactor,
      reactorOutput: isReactor ? 4000 : 0,
      reactorBaseOutput: isReactor ? 4000 : 0,
      temperature: isReactor ? 4000 : 0,
      coolingCapacity: isCooler ? rng.nextInt(30, 90) : 0,
      coolingEfficiency: 100,
      isOxygenGenerator: isGen,
      oxygenOutput: isGen ? rng.nextInt(150, 350) : 0,
      powerDemand: isReactor ? 0 : rng.nextInt(5, 50),
      crew: rng.nextInt(0, 3),
      oxygen: rng.nextInt(20000, 100000),
      oxygenCapacity: O2_CAP,
    });
  }

  const conns = [];
  const seen = new Set();
  const key = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const resFor = () => {
    const r = [P];
    if (rng.chance(2)) r.push(O);
    if (rng.chance(3)) r.push(C);
    return r;
  };

  // Spanning tree first so the graph is guaranteed connected.
  for (let i = 1; i < modules; i++) {
    const j = rng.nextInt(0, i - 1);
    seen.add(key(i, j));
    conns.push({
      id: 'C' + conns.length,
      a: 'm' + i, b: 'm' + j,
      resources: resFor(), capacity: rng.nextInt(30, 120), length: rng.nextInt(1, 4),
    });
  }
  // Extra random edges up to the target count.
  let guard = 0;
  while (conns.length < connections && guard++ < connections * 20) {
    const a = rng.nextInt(0, modules - 1);
    const b = rng.nextInt(0, modules - 1);
    if (a === b) continue;
    const k = key(a, b);
    if (seen.has(k)) continue;
    seen.add(k);
    conns.push({
      id: 'C' + conns.length,
      a: 'm' + a, b: 'm' + b,
      resources: resFor(), capacity: rng.nextInt(20, 120), length: rng.nextInt(1, 4),
    });
  }

  const fails = [];
  for (let i = 0; i < failures; i++) {
    const type = FAILS[rng.nextInt(0, FAILS.length - 1)];
    const onConn = rng.chance(2);
    fails.push({
      id: 'F' + i,
      type,
      targetId: onConn
        ? 'C' + rng.nextInt(0, conns.length - 1)
        : 'm' + rng.nextInt(0, modules - 1),
      startTick: 0,
      active: true,
      severity: rng.nextInt(1, 3),
    });
  }

  const drones = [
    { id: 'drone-1', atNode: 'm0', speed: 250, queue: { tasks: [] } },
    { id: 'drone-2', atNode: 'm0', speed: 250, queue: { tasks: [] } },
    { id: 'drone-3', atNode: 'm0', speed: 250, queue: { tasks: [] } },
  ];

  return { seed, speed: 1, modules: mods, connections: conns, drones, failures: fails };
}

/**
 * Run the benchmark and return metrics. Deterministic: identical inputs give
 * identical ticks and checksum on every run and machine.
 */
export function runBenchmark(opts = {}) {
  const cfg = generateLargeStation(opts);
  const ticks = opts.ticks || 6000; // 10 simulated minutes
  const clock = () => (globalThis.performance ? performance.now() : Date.now());

  const eng = Engine.create(cfg);
  const t0 = clock();
  eng.run(ticks);
  const t1 = clock();

  const snap = eng.snapshot();
  const sum = checksum(snap);
  return {
    seed: cfg.seed,
    moduleCount: cfg.modules.length,
    connectionCount: cfg.connections.length,
    failureCount: cfg.failures.length,
    droneCount: cfg.drones.length,
    ticksExecuted: eng.tick,
    requestedTicks: ticks,
    executionMs: Math.round((t1 - t0) * 1000) / 1000,
    checksum: sum,
    checksumHex: '0x' + (sum >>> 0).toString(16).padStart(8, '0'),
    lastPower: snap.lastPower,
    dashboard: eng.dashboard(),
  };
}
