// SIGNAL ZERO - simulation engine (deterministic spine + live systems)
//
// The engine owns the entire simulation state and advances it ONLY through
// discrete 100 ms ticks. It has ZERO UI dependency and is fully testable
// headless. All randomness comes from a single seeded RNG; all player intent
// comes from timestamped commands applied at tick boundaries.
//
// Per-tick ordering (fixed, deterministic):
//   1. apply commands scheduled at this tick (insertion order)
//   2. fire any scenario events scheduled at this tick
//   3. solve the power network
//   4. apply continuous failure consequences (+ seeded spawns)
//   5. oxygen (generate / consume / leak / diffuse / crew health)
//   6. thermal (reactor heat balance / droop / shutdown / damage)
//   7. drones (physical travel + task execution + re-planning)
//   8. evaluate end conditions
//   9. increment the tick counter

import { DeterministicRng } from './rng.mjs';
import { StationGraph } from './graph.mjs';
import { Drone, Failure, Task, Priority } from './models.mjs';
import { CommandLog, CommandType } from './commands.mjs';
import { solvePower } from './power.mjs';
import { formatSimTime } from './clock.mjs';
import { stepOxygen } from './oxygen.mjs';
import { stepThermal } from './thermal.mjs';
import { stepFailures, applyFailureOnset, spawnFailure, injectRandomFailure } from './failures.mjs';
import { stepDrones } from './drones.mjs';

export class SimState {
  constructor() {
    this.seed = 0;
    this.tick = 0;
    this.speed = 1;
    this.name = 'Station';
    this.goalTicks = 0;              // 0 = no victory clock
    this.initialCrew = 0;
    this.outcome = 'running';        // running | victory | survived | defeat
    this.graph = new StationGraph();
    this.drones = new Map();         // id -> Drone
    this.failures = new Map();       // id -> Failure
    this.failureRate = 0;            // 0 = no seeded background spawns
    this.failureSeq = 0;             // deterministic failure id counter
    this.taskSeq = 0;                // deterministic task id counter
    this.scenarioEvents = [];        // [{tick, failure, random}]
    this.rng = new DeterministicRng(0);
    this.eventLog = [];              // {tick, level, text}
    this.commandLog = new CommandLog();
    this.lastPower = { totalOutput: 0, totalDemand: 0, delivered: 0, available: 0, deficit: 0 };
  }

  droneList() {
    return [...this.drones.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  failureList() {
    return [...this.failures.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  totalCrew() {
    let c = 0;
    for (const m of this.graph.moduleList()) c += m.crew;
    return c;
  }
}

export class Engine {
  /** @param {SimState} state */
  constructor(state) {
    this.state = state;
  }

  /**
   * Build an engine from a plain config object.
   * @param {object} cfg { seed, modules[], connections[], drones[], failures[],
   *   speed, name, goalTicks, failureRate, scenarioEvents[] }
   */
  static create(cfg) {
    const s = new SimState();
    s.seed = cfg.seed | 0;
    s.rng = new DeterministicRng(s.seed);
    s.speed = (cfg.speed === undefined) ? 1 : (cfg.speed | 0);
    s.name = cfg.name || 'Station';
    s.goalTicks = cfg.goalTicks | 0;
    s.failureRate = cfg.failureRate | 0;
    s.scenarioEvents = (cfg.scenarioEvents || []).map(e => ({
      tick: e.tick | 0, failure: e.failure, random: !!e.random, done: false,
    }));
    if (cfg.graph) {
      s.graph = StationGraph.fromJSON(cfg.graph);
    } else {
      s.graph = StationGraph.fromJSON({
        modules: cfg.modules || [],
        connections: cfg.connections || [],
      });
    }
    for (const d of (cfg.drones || [])) {
      s.drones.set(d.id, Drone.fromJSON(d));
    }
    const eng = new Engine(s);
    // Register + onset any pre-existing failures (deterministic id order).
    for (const f of (cfg.failures || [])) {
      const failure = Failure.fromJSON(f);
      s.failures.set(failure.id, failure);
      const n = /(\d+)/.exec(failure.id);
      if (n) s.failureSeq = Math.max(s.failureSeq, parseInt(n[1], 10));
      applyFailureOnset(s, eng, failure);
    }
    s.initialCrew = s.totalCrew();
    // Initial power solve so a freshly created state is coherent at tick 0.
    eng._solve();
    return eng;
  }

  /**
   * Rebuild an engine from a previously captured snapshot() (plus an optional
   * command list). Unlike create(), this restores the EXACT saved world state
   * verbatim: it does NOT re-run failure onsets (their structural mutations are
   * already baked into the serialised graph) and it restores the RNG position,
   * scenario-event "done" flags, tick counter, event log and command history.
   * Continuing to step() a restored engine is therefore indistinguishable from
   * never having closed the session.
   *
   * @param {object} snap - a snapshot() object
   * @param {Array} [commands] - CommandLog.toJSON() array (else snap.commandLog)
   */
  static fromSnapshot(snap, commands) {
    if (!snap || typeof snap !== 'object') {
      throw new Error('fromSnapshot: snapshot must be an object');
    }
    const s = new SimState();
    s.seed = snap.seed | 0;
    s.tick = snap.tick | 0;
    s.speed = (snap.speed === undefined) ? 1 : (snap.speed | 0);
    s.name = snap.name || 'Station';
    s.goalTicks = snap.goalTicks | 0;
    s.initialCrew = snap.initialCrew | 0;
    s.outcome = snap.outcome || 'running';
    s.failureRate = snap.failureRate | 0;
    s.failureSeq = snap.failureSeq | 0;
    s.taskSeq = snap.taskSeq | 0;
    s.rng = new DeterministicRng(0).setState((snap.rngState >>> 0));
    s.graph = StationGraph.fromJSON(snap.graph || { modules: [], connections: [] });
    for (const d of (snap.drones || [])) s.drones.set(d.id, Drone.fromJSON(d));
    for (const f of (snap.failures || [])) s.failures.set(f.id, Failure.fromJSON(f));
    s.scenarioEvents = (snap.scenarioEvents || []).map(e => ({
      tick: e.tick | 0, failure: e.failure, random: !!e.random, done: !!e.done,
    }));
    s.lastPower = snap.lastPower
      ? { ...snap.lastPower }
      : { totalOutput: 0, totalDemand: 0, delivered: 0, available: 0, deficit: 0 };
    s.eventLog = (snap.eventLog || []).map(e => ({ ...e }));
    const cmds = commands || snap.commandLog || [];
    s.commandLog = CommandLog.fromJSON(cmds);
    return new Engine(s);
  }

  get tick() { return this.state.tick; }
  get simTime() { return formatSimTime(this.state.tick); }

  /** Record an event at the current simulation time. */
  logEvent(text, level = 'info') {
    this.state.eventLog.push({ tick: this.state.tick, level, text });
  }

  /**
   * Enqueue a command to apply at the current tick boundary. Returns the
   * command. This is how live play submits intent; replay feeds the same
   * commands with their recorded ticks via schedule().
   */
  enqueue(command) {
    command.tick = this.state.tick;
    this.state.commandLog.add(command);
    return command;
  }

  /** Enqueue a command that already carries an absolute tick (replay/scenario). */
  schedule(command) {
    this.state.commandLog.add(command);
    return command;
  }

  _applyCommand(cmd) {
    const s = this.state;
    switch (cmd.type) {
      case CommandType.NOOP:
        break;
      case CommandType.SET_PRIORITY: {
        const m = s.graph.getModule(cmd.payload.moduleId);
        if (m) {
          m.priority = cmd.payload.priority || Priority.NORMAL;
          this.logEvent(`Priority of ${m.name} set to tier ${m.priority}.`);
        }
        break;
      }
      case CommandType.SET_SPEED:
        s.speed = cmd.payload.speed | 0;
        break;
      case CommandType.ADD_TASK: {
        const d = s.drones.get(cmd.payload.droneId);
        if (d) {
          // Assign a deterministic id at apply time so replay reproduces ids
          // regardless of any id the UI proposed.
          s.taskSeq += 1;
          const t = Task.fromJSON({ ...cmd.payload.task, id: 'task-' + s.taskSeq });
          d.queue.tasks.push(t);
          this.logEvent(`Drone ${droneNum(d)} assigned: ${t.type} \u2192 ${t.targetId}.`);
        }
        break;
      }
      case CommandType.REMOVE_TASK: {
        const d = s.drones.get(cmd.payload.droneId);
        if (d) d.queue.remove(cmd.payload.taskId);
        break;
      }
      case CommandType.REORDER_TASK: {
        const d = s.drones.get(cmd.payload.droneId);
        if (d) d.queue.reorder(cmd.payload.taskId, cmd.payload.toIndex);
        break;
      }
      default:
        break;
    }
  }

  _solve() {
    this.state.lastPower = solvePower(this.state.graph);
  }

  _runScenarioEvents() {
    const s = this.state;
    for (const ev of s.scenarioEvents) {
      if (ev.done || ev.tick !== s.tick) continue;
      ev.done = true;
      if (ev.random) {
        injectRandomFailure(s, this, ev.failure ? ev.failure.type : null);
      } else if (ev.failure) {
        spawnFailure(s, this, ev.failure);
      }
    }
  }

  _evaluateEnd() {
    const s = this.state;
    if (s.outcome !== 'running') return;
    const crew = s.totalCrew();
    if (s.initialCrew > 0 && crew <= 0) {
      s.outcome = 'defeat';
      this.logEvent('ALL CREW LOST \u2014 mission failed.', 'danger');
    } else if (s.goalTicks > 0 && s.tick + 1 >= s.goalTicks) {
      s.outcome = (crew >= s.initialCrew) ? 'victory' : 'survived';
      this.logEvent(
        s.outcome === 'victory'
          ? `VICTORY \u2014 all ${crew} crew survived ${formatSimTime(s.goalTicks)}.`
          : `TIME REACHED \u2014 ${crew}/${s.initialCrew} crew survived.`,
        s.outcome === 'victory' ? 'info' : 'warn');
    }
  }

  /** Advance exactly one 100 ms tick. */
  step() {
    const s = this.state;

    const due = s.commandLog.at(s.tick);
    for (const cmd of due) this._applyCommand(cmd);

    this._runScenarioEvents();
    this._solve();
    stepFailures(s, this);
    stepOxygen(s, this);
    stepThermal(s, this);
    stepDrones(s, this);
    this._evaluateEnd();

    s.tick += 1;
  }

  /** Advance N whole ticks. */
  run(nTicks) {
    for (let i = 0; i < nTicks; i++) this.step();
  }

  /** The eight canonical dashboard readouts (pure derived integers). */
  dashboard() {
    const s = this.state;
    const mods = s.graph.moduleList();
    let crew = 0, oxySum = 0, oxyN = 0, reactorTemp = 0, activeFail = 0;
    let availDrones = 0;
    for (const m of mods) {
      crew += m.crew;
      if (m.oxygenCapacity > 0) { oxySum += Math.floor((m.oxygen * 100) / m.oxygenCapacity); oxyN++; }
      if (m.isReactor || m.isReactorHeatSource) reactorTemp = Math.max(reactorTemp, m.temperature);
    }
    for (const f of s.failureList()) if (f.active) activeFail++;
    for (const d of s.droneList()) if (d.available) availDrones++;
    return {
      crewAlive: crew,
      reactorTempC: reactorTemp / 10,
      availablePower: s.lastPower.totalOutput,
      totalDemand: s.lastPower.totalDemand,
      deliveredPower: s.lastPower.delivered,
      avgOxygenPct: oxyN ? Math.round(oxySum / oxyN) : 0,
      activeFailures: activeFail,
      availableDrones: availDrones,
      simTime: formatSimTime(s.tick),
      outcome: s.outcome,
    };
  }

  /** Deep, read-only plain-object snapshot of the whole state. */
  snapshot() {
    const s = this.state;
    return {
      seed: s.seed,
      tick: s.tick,
      speed: s.speed,
      name: s.name,
      goalTicks: s.goalTicks,
      initialCrew: s.initialCrew,
      outcome: s.outcome,
      failureRate: s.failureRate,
      failureSeq: s.failureSeq,
      taskSeq: s.taskSeq,
      rngState: s.rng.getState(),
      graph: s.graph.toJSON(),
      drones: s.droneList().map(d => d.toJSON()),
      failures: s.failureList().map(f => f.toJSON()),
      scenarioEvents: s.scenarioEvents.map(e => ({ tick: e.tick, failure: e.failure, random: e.random, done: e.done })),
      lastPower: { ...s.lastPower },
      eventLog: s.eventLog.map(e => ({ ...e })),
    };
  }
}

function droneNum(d) {
  const m = /(\d+)/.exec(d.id);
  return m ? m[1] : d.id;
}

/**
 * Deterministic 32-bit checksum of a state snapshot. Order-stable because all
 * list accessors sort by id. Used by tests and the headless benchmark.
 */
export function checksum(snapshot) {
  let h = 2166136261 >>> 0; // FNV-1a offset basis
  const str = stableStringify(snapshot);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}
