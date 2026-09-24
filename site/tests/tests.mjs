// SIGNAL ZERO - automated tests (full station spine + power + oxygen + thermal
// + failures + drones + canonical persistence/save-load + black-box replay).
// Framework-free; runs under Node (node tests/run.mjs) and in the renderer.

import { test, assert, assertEqual, assertNotEqual } from './harness.mjs';
import {
  DeterministicRng, Engine, checksum, StationGraph, solvePower,
  Priority, Commands, SimClock, FailureType, dronePath, spawnFailure,
  serialize, deserialize, loadEngine, tryLoad, SAVE_VERSION, SAVE_FORMAT,
  canonicalJSON, sha256Hex, digestOf,
  BlackBox, replay, verifyReplay,
} from '../umbra/engine/index.mjs';
import { buildStation, buildCapacityStation, buildSevenMinutes } from '../umbra/engine/fixtures.mjs';
import { runBenchmark } from '../umbra/engine/benchmark.mjs';

// ---- RNG determinism -------------------------------------------------------
test('rng: same seed yields identical sequence', () => {
  const a = new DeterministicRng(12345);
  const b = new DeterministicRng(12345);
  for (let i = 0; i < 1000; i++) assertEqual(a.nextU32(), b.nextU32(), `i=${i}`);
});

test('rng: getState/setState reproduces the stream', () => {
  const r = new DeterministicRng(99);
  for (let i = 0; i < 50; i++) r.nextU32();
  const snap = r.getState();
  const expected = [r.nextU32(), r.nextU32(), r.nextU32()];
  r.setState(snap);
  assertEqual([r.nextU32(), r.nextU32(), r.nextU32()], expected);
});

test('rng: nextInt stays within inclusive bounds', () => {
  const r = new DeterministicRng(3);
  for (let i = 0; i < 5000; i++) {
    const v = r.nextInt(5, 9);
    assert(v >= 5 && v <= 9, 'out of range ' + v);
  }
});

// ---- Shortest path ---------------------------------------------------------
test('graph: shortest path picks lowest total length', () => {
  const g = StationGraph.fromJSON(buildStation());
  assertEqual(g.shortestPath('reactor', 'command'), ['reactor', 'command']);
  assertEqual(g.distance('reactor', 'command'), 2);
});

test('graph: reroutes around a broken connection', () => {
  const g = StationGraph.fromJSON(buildStation());
  assertEqual(g.shortestPath('reactor', 'oxygen'), ['reactor', 'oxygen']);
  g.getConnection('C2').broken = true;
  g.invalidate();
  const r = g.shortestPath('reactor', 'oxygen');
  assert(r !== null && r.length > 2, 'expected a longer detour');
  assertEqual(r[0], 'reactor');
  assertEqual(r[r.length - 1], 'oxygen');
});

test('graph: no route returns null (disconnected)', () => {
  const g = StationGraph.fromJSON({
    modules: [
      { id: 'x', name: 'X', isReactor: true, reactorOutput: 10 },
      { id: 'y', name: 'Y', powerDemand: 5 },
    ],
    connections: [],
  });
  assertEqual(g.shortestPath('x', 'y'), null);
  assert(!g.isConnected(), 'graph should be reported disconnected');
});

test('drones: dronePath skips broken and door-jammed edges', () => {
  const g = StationGraph.fromJSON(buildStation());
  assertEqual(dronePath(g, 'command', 'oxygen'), ['command', 'reactor', 'oxygen']);
  g.getConnection('C1').doorBlocked = true; // command<->reactor jammed for drones
  g.invalidate();
  const r = dronePath(g, 'command', 'oxygen');
  assert(r && r[0] === 'command' && r[r.length - 1] === 'oxygen', 'expected a route');
  assert(r.indexOf('reactor') === -1 || r.length > 3, 'should avoid the jammed door');
});

// ---- Power priority distribution ------------------------------------------
test('power: higher priority served before lower under deficit', () => {
  const eng = Engine.create(buildStation());
  const g = eng.state.graph;
  const rec = id => g.getModule(id).powerReceived;
  assertEqual(eng.state.lastPower.totalOutput, 120);
  assert(eng.state.lastPower.deficit > 0, 'expected a deficit');
  assertEqual(rec('command'), 20);
  assertEqual(rec('oxygen'), 35);
  assertEqual(rec('cooling'), 30);
  assert(eng.state.lastPower.delivered <= 120, 'over-delivered');
});

test('power: changing priority reallocates supply', () => {
  const eng = Engine.create(buildStation());
  const g = eng.state.graph;
  eng.schedule(Commands.setPriority(0, 'laboratory', Priority.CRITICAL));
  eng.schedule(Commands.setPriority(0, 'command', Priority.LOW));
  eng.step();
  assertEqual(g.getModule('laboratory').powerReceived, 40, 'lab critical -> full');
});

test('power: zero reactor output leaves everyone unpowered', () => {
  const cfg = buildStation();
  cfg.modules.find(m => m.id === 'reactor').reactorOutput = 0;
  const eng = Engine.create(cfg);
  for (const m of eng.state.graph.moduleList()) {
    if (m.powerDemand > 0) assertEqual(m.powerReceived, 0, m.id);
  }
  assertEqual(eng.state.lastPower.delivered, 0);
});

test('power: per-connection capacity throttles delivery', () => {
  const g = StationGraph.fromJSON(buildCapacityStation());
  const r = solvePower(g);
  assertEqual(g.getModule('a').powerReceived, 30, 'a fully served');
  assertEqual(g.getModule('b').powerReceived, 20, 'b throttled by capacity');
  assertEqual(r.delivered, 50);
});

// ---- Oxygen ----------------------------------------------------------------
test('oxygen: crew consumption drains a crewed module', () => {
  const eng = Engine.create({
    seed: 1, modules: [
      { id: 'r', name: 'R', isReactor: true, reactorOutput: 0 },
      { id: 'c', name: 'Crew', crew: 3, oxygen: 50000, oxygenCapacity: 100000 },
    ], connections: [], drones: [], failures: [],
  });
  const o0 = eng.state.graph.getModule('c').oxygen;
  eng.run(50);
  const o1 = eng.state.graph.getModule('c').oxygen;
  assert(o1 < o0, `expected drain, ${o1} < ${o0}`);
});

test('oxygen: a leaking connection removes oxygen from both ends', () => {
  const eng = Engine.create({
    seed: 1, modules: [
      { id: 'a', name: 'A', oxygen: 60000, oxygenCapacity: 100000 },
      { id: 'b', name: 'B', oxygen: 60000, oxygenCapacity: 100000 },
    ],
    connections: [{ id: 'E', a: 'a', b: 'b', resources: ['power', 'oxygen'], capacity: 40, leaking: true, severity: 2 }],
    drones: [], failures: [],
  });
  const g = eng.state.graph;
  const a0 = g.getModule('a').oxygen, b0 = g.getModule('b').oxygen;
  eng.run(20);
  assert(g.getModule('a').oxygen < a0 && g.getModule('b').oxygen < b0, 'leak must reduce both');
});

test('oxygen: crew health falls when a crewed module hits zero oxygen', () => {
  const eng = Engine.create({
    seed: 1, modules: [
      { id: 'c', name: 'Crew', crew: 2, oxygen: 500, oxygenCapacity: 100000, crewHealth: 100 },
    ], connections: [], drones: [], failures: [],
  });
  eng.run(200); // oxygen hits 0 quickly, then health decays
  const m = eng.state.graph.getModule('c');
  assert(m.oxygen === 0, 'oxygen should be depleted');
  assert(m.crewHealth < 100 || m.crew === 0, 'health must decay at zero oxygen');
});

// ---- Thermal / cooling -----------------------------------------------------
function thermalCfg(reactorOutput) {
  return {
    seed: 1, modules: [
      { id: 'r', name: 'R', isReactor: true, isReactorHeatSource: true,
        reactorOutput, reactorBaseOutput: 60, temperature: 4000, priority: Priority.CRITICAL, powerDemand: 0 },
      { id: 'cool', name: 'Cool', coolingCapacity: 90, coolingEfficiency: 100, powerDemand: 30, priority: Priority.HIGH },
    ],
    connections: [{ id: 'K', a: 'r', b: 'cool', resources: ['power', 'coolant'], capacity: 50, length: 1 }],
    drones: [], failures: [],
  };
}

test('cooling: powered cooling holds the reactor temperature down', () => {
  const eng = Engine.create(thermalCfg(60)); // cooling powered
  const t0 = eng.state.graph.getModule('r').temperature;
  eng.run(50);
  assert(eng.state.graph.getModule('r').temperature <= t0, 'temp should not climb while cooled');
});

test('cooling: losing power to cooling cascades into a temperature rise', () => {
  const eng = Engine.create(thermalCfg(10)); // reactor output < cooling demand
  assert(!eng.state.graph.getModule('cool').powered, 'cooling should be unpowered');
  const t0 = eng.state.graph.getModule('r').temperature;
  eng.run(30);
  assert(eng.state.graph.getModule('r').temperature > t0, 'temp must rise without cooling');
});

test('thermal: sustained overheating auto-shuts-down the reactor', () => {
  const eng = Engine.create(thermalCfg(10));
  eng.run(60);
  assert(eng.state.graph.getModule('r').reactorShutdown, 'reactor should auto-shutdown');
});

// ---- Failures --------------------------------------------------------------
test('failures: several simultaneous failures each have consequences', () => {
  const eng = Engine.create(buildStation(3));
  const s = eng.state, g = s.graph;
  spawnFailure(s, eng, { type: FailureType.POWER_CABLE, targetId: 'C1' });
  spawnFailure(s, eng, { type: FailureType.OXYGEN_LEAK, targetId: 'crew', severity: 2 });
  spawnFailure(s, eng, { type: FailureType.MODULE_FIRE, targetId: 'laboratory' });
  spawnFailure(s, eng, { type: FailureType.COOLANT_LEAK, targetId: 'C7' });
  assertEqual(s.failureList().filter(f => f.active).length, 4);
  assert(g.getConnection('C1').broken, 'cable severed');
  assert(g.getConnection('C7').leaking, 'coolant leaking');
  assert(g.getModule('laboratory').onFire, 'module ignited');
  const crewO0 = g.getModule('crew').oxygen;
  const labO0 = g.getModule('laboratory').oxygen;
  eng.run(20);
  assert(g.getModule('crew').oxygen < crewO0, 'oxygen leak drains crew quarters');
  assert(g.getModule('laboratory').oxygen < labO0, 'fire consumes lab oxygen');
});

// ---- Drones ----------------------------------------------------------------
test('drones: a drone travels to and repairs a broken connection', () => {
  const eng = Engine.create(buildStation(5));
  eng.state.graph.getConnection('C1').broken = true;
  eng.state.graph.invalidate();
  eng.enqueue(Commands.addTask(eng.tick, 'drone-1',
    { type: 'repair_connection', targetId: 'C1', workRequired: 100 }));
  eng.run(60);
  assert(!eng.state.graph.getConnection('C1').broken, 'connection should be repaired');
  assertEqual(eng.state.drones.get('drone-1').queue.tasks.length, 0, 'task consumed');
});

test('drones: reroute around an edge that breaks mid-transit', () => {
  const eng = Engine.create(buildStation(9));
  eng.enqueue(Commands.addTask(0, 'drone-1',
    { type: 'inspect_module', targetId: 'oxygen', workRequired: 20 }));
  eng.run(5); // drone-1 en route command->reactor on C1
  eng.state.graph.getConnection('C1').broken = true;
  eng.state.graph.invalidate();
  eng.run(600);
  assertEqual(eng.state.drones.get('drone-1').queue.tasks.length, 0,
    'task should still complete via an alternate route');
});

test('drones: task fails gracefully when no route exists', () => {
  const eng = Engine.create({
    seed: 1,
    modules: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    connections: [], drones: [{ id: 'drone-1', atNode: 'a', speed: 250, queue: { tasks: [] } }],
    failures: [],
  });
  eng.enqueue(Commands.addTask(0, 'drone-1',
    { type: 'inspect_module', targetId: 'b', workRequired: 20 }));
  eng.run(10);
  const d = eng.state.drones.get('drone-1');
  assertEqual(d.queue.tasks.length, 0, 'unroutable task must be dropped');
  assert(eng.state.eventLog.some(e => /no route/.test(e.text)), 'graceful-failure event logged');
});

test('drones: removing a queued task takes effect', () => {
  const eng = Engine.create(buildStation(2));
  eng.enqueue(Commands.addTask(0, 'drone-1', { type: 'inspect_module', targetId: 'reactor' }));
  eng.enqueue(Commands.addTask(0, 'drone-1', { type: 'inspect_module', targetId: 'oxygen' }));
  eng.step();
  const d = eng.state.drones.get('drone-1');
  assertEqual(d.queue.tasks.length, 2);
  const secondId = d.queue.tasks[1].id;
  eng.enqueue(Commands.removeTask(eng.tick, 'drone-1', secondId));
  eng.step();
  assert(!d.queue.tasks.some(t => t.id === secondId), 'queued task removed');
});

// ---- Determinism across the whole system -----------------------------------
function scriptCommands(eng) {
  eng.schedule(Commands.setPriority(3, 'laboratory', Priority.CRITICAL));
  eng.schedule(Commands.setPriority(10, 'command', Priority.LOW));
  eng.schedule(Commands.addTask(5, 'drone-2', { type: 'inspect_module', targetId: 'oxygen' }));
}

test('engine: same seed + commands => byte-identical snapshot', () => {
  const a = Engine.create(buildSevenMinutes(42));
  const b = Engine.create(buildSevenMinutes(42));
  scriptCommands(a); scriptCommands(b);
  a.run(2000); b.run(2000);
  assertEqual(a.snapshot(), b.snapshot());
  assertEqual(checksum(a.snapshot()), checksum(b.snapshot()));
});

test('engine: different seed => different rng state', () => {
  const a = Engine.create(buildSevenMinutes(1));
  const b = Engine.create(buildSevenMinutes(2));
  a.run(1900); b.run(1900);
  assertNotEqual(a.snapshot().rngState, b.snapshot().rngState);
});

// ---- Speed independence -----------------------------------------------------
function driveWithClock(engine, targetTicks, speed, realStepMs) {
  const clock = new SimClock();
  let guard = 0;
  while (engine.tick < targetTicks) {
    if (guard++ > 100000) throw new Error('clock failed to reach target');
    const ticks = clock.pump(realStepMs, speed);
    for (let i = 0; i < ticks && engine.tick < targetTicks; i++) engine.step();
  }
}

test('engine: 60 sim-seconds at 1x equals 8x (full systems)', () => {
  const TARGET = 700; // spans the 60s coolant-failure event
  const slow = Engine.create(buildSevenMinutes(7));
  const fast = Engine.create(buildSevenMinutes(7));
  scriptCommands(slow); scriptCommands(fast);
  driveWithClock(slow, TARGET, 1, 100);
  driveWithClock(fast, TARGET, 8, 100);
  assertEqual(slow.tick, TARGET);
  assertEqual(fast.tick, TARGET);
  assertEqual(slow.snapshot(), fast.snapshot());
});

test('clock: paused releases no ticks; dt is never scaled', () => {
  const c = new SimClock();
  assertEqual(c.pump(1000, 0), 0);
  assertEqual(c.pump(100, 1), 1);
  assertEqual(c.pump(50, 1) + c.pump(50, 1), 1);
  const c2 = new SimClock();
  assertEqual(c2.pump(100, 4), 4);
});

// ---- Command sourcing ------------------------------------------------------
test('engine: commands only apply at their scheduled tick boundary', () => {
  const eng = Engine.create(buildStation());
  eng.schedule(Commands.setPriority(5, 'laboratory', Priority.CRITICAL));
  eng.run(5);
  assert(eng.state.graph.getModule('laboratory').priority === Priority.LOW, 'applied too early');
  eng.step();
  assert(eng.state.graph.getModule('laboratory').priority === Priority.CRITICAL, 'not applied at boundary');
});

// ---- Scenario events -------------------------------------------------------
test('scenario: Seven Minutes fires the 60s coolant failure', () => {
  const eng = Engine.create(buildSevenMinutes(70000));
  eng.run(610); // just past 60.0s (event fires on the 601st step)
  assert(eng.state.graph.getConnection('C7').leaking, 'C7 coolant should fail at 60s');
  eng.run(200); // temperature should climb after coolant loss
  assert(eng.state.graph.getModule('reactor').temperature > 4000, 'reactor heats after coolant loss');
});

test('scenario: Seven Minutes runs headlessly to a definite verdict', () => {
  const eng = Engine.create(buildSevenMinutes(70000));
  eng.run(eng.state.goalTicks);
  assert(['victory', 'survived', 'defeat'].indexOf(eng.state.outcome) !== -1,
    'scenario must reach a win/lose/continue verdict: ' + eng.state.outcome);
  assertEqual(eng.state.tick, eng.state.goalTicks);
});

// ---- SHA-256 + canonical JSON ----------------------------------------------
test('persistence: sha256 matches known test vectors', () => {
  assertEqual(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assertEqual(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assertEqual(sha256Hex('The quick brown fox jumps over the lazy dog'),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
});

test('persistence: canonical JSON is order-independent', () => {
  assertEqual(canonicalJSON({ b: 1, a: 2, c: [3, { y: 1, x: 2 }] }),
    canonicalJSON({ c: [3, { x: 2, y: 1 }], a: 2, b: 1 }));
  assertEqual(digestOf({ a: 1, b: 2 }), digestOf({ b: 2, a: 1 }));
});

// ---- Save / load equivalence -----------------------------------------------
test('persistence: continuing after load behaves like never closing', () => {
  const a = Engine.create(buildSevenMinutes(123));
  scriptCommands(a);
  a.run(600);
  const text = serialize(a, buildSevenMinutes(123));
  const b = loadEngine(text);
  // Immediately after load the state equals the saved state, byte-for-byte.
  assertEqual(b.snapshot(), a.snapshot());
  assertEqual(b.state.commandLog.toJSON(), a.state.commandLog.toJSON());
  // Continuing both by the same amount produces identical futures.
  a.run(500); b.run(500);
  assertEqual(a.snapshot(), b.snapshot());
  assertEqual(checksum(a.snapshot()), checksum(b.snapshot()));
});

test('persistence: saving while paused round-trips and resumes', () => {
  const a = Engine.create(buildSevenMinutes(5));
  a.schedule(Commands.setSpeed(0, 0)); // pause at tick 0
  a.run(300);
  assertEqual(a.state.speed, 0, 'engine should be paused');
  const b = loadEngine(serialize(a));
  assertEqual(b.state.speed, 0);
  assertEqual(b.snapshot(), a.snapshot());
  a.run(200); b.run(200);
  assertEqual(a.snapshot(), b.snapshot());
});

test('persistence: saving during an active repair resumes identically', () => {
  const a = Engine.create(buildStation(8));
  a.state.graph.getConnection('C10').broken = true; // far from drone-1 @ command
  a.state.graph.invalidate();
  a.enqueue(Commands.addTask(a.tick, 'drone-1',
    { type: 'repair_connection', targetId: 'C10', workRequired: 100 }));
  a.run(6); // drone now physically travelling toward the repair
  assert(a.state.drones.get('drone-1').busy, 'repair should be in progress');
  const b = loadEngine(serialize(a));
  assertEqual(b.snapshot(), a.snapshot());
  a.run(400); b.run(400);
  assertEqual(a.snapshot(), b.snapshot());
  assert(!a.state.graph.getConnection('C10').broken, 'repair completes after resume');
});

test('persistence: corrupted / incompatible saves are rejected gracefully', () => {
  const a = Engine.create(buildStation(1));
  a.run(50);
  const text = serialize(a);

  const truncated = tryLoad(text.slice(0, text.length - 8));
  assert(!truncated.ok, 'truncated JSON must be rejected');

  const tampered = tryLoad(text.replace('"tick":50', '"tick":999'));
  assert(!tampered.ok && /integrity/i.test(tampered.error),
    'tampered payload must fail the integrity digest: ' + tampered.error);

  const wrongFormat = tryLoad('{"format":"not-signalzero","version":1,"state":{}}');
  assert(!wrongFormat.ok, 'wrong format must be rejected');

  const parsed = JSON.parse(text);
  parsed.version = SAVE_VERSION + 999;
  const futureVersion = tryLoad(parsed);
  assert(!futureVersion.ok && /version/i.test(futureVersion.error),
    'a newer save version must be rejected: ' + futureVersion.error);

  const missingState = tryLoad({ format: SAVE_FORMAT, version: SAVE_VERSION });
  assert(!missingState.ok, 'a save missing its state must be rejected');

  // A valid save still loads after all of the above.
  const good = tryLoad(text);
  assert(good.ok, 'the untouched save must still load');
});

// ---- Black-box replay determinism ------------------------------------------
test('replay: black box reproduces the identical final state', () => {
  const cfg = buildSevenMinutes(77);
  const eng = Engine.create(cfg);
  eng.schedule(Commands.setPriority(20, 'laboratory', Priority.CRITICAL));
  eng.schedule(Commands.addTask(40, 'drone-2', { type: 'inspect_module', targetId: 'oxygen' }));
  eng.schedule(Commands.addTask(80, 'drone-1', { type: 'repair_connection', targetId: 'C7' }));
  eng.run(1200);
  const original = eng.snapshot();

  const box = BlackBox.fromEngine(eng, cfg);
  const portable = BlackBox.fromJSON(box.serialize()); // survive a JSON round-trip
  const rEng = replay(portable);

  assertEqual(rEng.snapshot(), original);
  assertEqual(checksum(rEng.snapshot()), checksum(original));
  assert(verifyReplay(portable, checksum(original)).match, 'verifyReplay must confirm the match');
});

test('replay: rejects a corrupted recording without crashing', () => {
  const cfg = buildStation(4);
  const eng = Engine.create(cfg);
  eng.run(100);
  const text = BlackBox.fromEngine(eng, cfg).serialize();
  let threw = false;
  try {
    BlackBox.fromJSON(text.replace('"finalTick":100', '"finalTick":123'));
  } catch (e) {
    threw = true;
    assert(/integrity/i.test(e.message), 'expected an integrity error: ' + e.message);
  }
  assert(threw, 'a tampered replay must be rejected');
});

// ---- Benchmark checksum stability ------------------------------------------
test('benchmark: identical inputs produce an identical deterministic checksum', () => {
  const a = runBenchmark({ ticks: 300, seed: 424242 });
  const b = runBenchmark({ ticks: 300, seed: 424242 });
  assertEqual(a.checksum, b.checksum);
  assertEqual(a.ticksExecuted, 300);
  assertEqual(a.moduleCount, 100);
  assertEqual(a.connectionCount, 250);
  const c = runBenchmark({ ticks: 300, seed: 999999 });
  assertNotEqual(a.checksum, c.checksum);
});
