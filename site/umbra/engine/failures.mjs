// SIGNAL ZERO - FAILURE system (Beta stage)
//
// Failures are generated ONLY from the single seeded RNG (deterministic) and
// every failure has a real, ongoing consequence in the simulation - it never
// merely raises an alert. Many failures can be active simultaneously.
//
// Consequences:
//   POWER_CABLE          connection severed (broken) -> loses edge capacity
//   OXYGEN_LEAK          connection: leaks O2 (oxygen.mjs) OR module: drains O2
//   COOLANT_LEAK         coolant connection stops conducting heat (thermal.mjs)
//   MODULE_FIRE          drains O2, heats + damages the module each tick
//   SENSOR_MALFUNCTION   accumulating undetected damage on the module
//   DOOR_FAILURE         connection impassable to drones (resources still flow)
//   REACTOR_INSTABILITY  injects extra heat into the reactor each tick

import { Failure, FailureType, Resource } from './models.mjs';

const MODULE_TARGET_TYPES = new Set([
  FailureType.OXYGEN_LEAK, FailureType.MODULE_FIRE,
  FailureType.SENSOR_MALFUNCTION, FailureType.REACTOR_INSTABILITY,
]);
const CONNECTION_TARGET_TYPES = new Set([
  FailureType.POWER_CABLE, FailureType.COOLANT_LEAK, FailureType.DOOR_FAILURE,
]);

const FIRE_O2_DRAIN = 300;      // scaled O2 / tick / severity
const FIRE_HEAT = 200;          // temp units / tick / severity
const FIRE_DAMAGE_EVERY = 5;    // ticks between +1 damage
const SENSOR_DAMAGE_EVERY = 20; // ticks between +1 damage
const MODULE_LEAK_DRAIN = 500;  // scaled O2 / tick / severity for module leak
const INSTABILITY_HEAT = 250;   // temp units / tick / severity

function nextFailureId(state) {
  state.failureSeq = (state.failureSeq | 0) + 1;
  return 'F' + state.failureSeq;
}

/**
 * Apply the one-time structural onset of a failure (severing a cable, opening
 * a leak, jamming a door, igniting a module...). Idempotent.
 */
export function applyFailureOnset(state, engine, f) {
  const g = state.graph;
  switch (f.type) {
    case FailureType.POWER_CABLE: {
      const c = g.getConnection(f.targetId);
      if (c) { c.broken = true; g.invalidate(); }
      break;
    }
    case FailureType.COOLANT_LEAK: {
      const c = g.getConnection(f.targetId);
      if (c) c.leaking = true;
      break;
    }
    case FailureType.DOOR_FAILURE: {
      const c = g.getConnection(f.targetId);
      if (c) { c.doorBlocked = true; g.invalidate(); }
      break;
    }
    case FailureType.OXYGEN_LEAK: {
      const c = g.getConnection(f.targetId);
      if (c) { c.leaking = true; break; }
      // else it targets a module: handled per-tick in stepFailures.
      break;
    }
    case FailureType.MODULE_FIRE: {
      const m = g.getModule(f.targetId);
      if (m) m.onFire = true;
      break;
    }
    case FailureType.SENSOR_MALFUNCTION: {
      const m = g.getModule(f.targetId);
      if (m) m.sensorFault = true;
      break;
    }
    case FailureType.REACTOR_INSTABILITY:
      // continuous effect only.
      break;
    default:
      break;
  }
}

/** Human label for the log. */
function label(type) {
  return ({
    [FailureType.POWER_CABLE]: 'Power cable failure',
    [FailureType.OXYGEN_LEAK]: 'Oxygen leak',
    [FailureType.COOLANT_LEAK]: 'Coolant leak',
    [FailureType.MODULE_FIRE]: 'Module fire',
    [FailureType.SENSOR_MALFUNCTION]: 'Sensor malfunction',
    [FailureType.DOOR_FAILURE]: 'Door failure',
    [FailureType.REACTOR_INSTABILITY]: 'Reactor instability',
  })[type] || type;
}

/**
 * Create, register, log and onset a new failure. Returns the Failure.
 */
export function spawnFailure(state, engine, { type, targetId, severity = 1 }) {
  const f = new Failure({
    id: nextFailureId(state), type, targetId,
    startTick: state.tick, active: true, severity,
  });
  state.failures.set(f.id, f);
  applyFailureOnset(state, engine, f);
  const name = describeTarget(state, targetId);
  engine.logEvent(`${label(type)} detected in ${name}.`, 'danger');
  return f;
}

function describeTarget(state, targetId) {
  const m = state.graph.getModule(targetId);
  if (m) return m.name;
  const c = state.graph.getConnection(targetId);
  if (c) return 'connection ' + c.id;
  return targetId;
}

/**
 * Pick a deterministic random failure of an optional forced type and inject it.
 * Uses ONLY the engine RNG.
 */
export function injectRandomFailure(state, engine, forcedType = null) {
  const rng = state.rng;
  const types = Object.values(FailureType);
  const type = forcedType || types[rng.nextInt(0, types.length - 1)];
  let targetId = null;

  if (CONNECTION_TARGET_TYPES.has(type)) {
    const conns = candidateConnections(state, type);
    if (conns.length === 0) return null;
    targetId = conns[rng.nextInt(0, conns.length - 1)].id;
  } else {
    const mods = candidateModules(state, type);
    if (mods.length === 0) return null;
    targetId = mods[rng.nextInt(0, mods.length - 1)].id;
  }
  const severity = rng.nextInt(1, 3);
  return spawnFailure(state, engine, { type, targetId, severity });
}

function candidateConnections(state, type) {
  const list = state.graph.connectionList();
  if (type === FailureType.POWER_CABLE) {
    return list.filter(c => !c.broken && c.resources.indexOf(Resource.POWER) !== -1);
  }
  if (type === FailureType.COOLANT_LEAK) {
    return list.filter(c => !c.broken && !c.leaking && c.resources.indexOf(Resource.COOLANT) !== -1);
  }
  if (type === FailureType.DOOR_FAILURE) {
    return list.filter(c => !c.broken && !c.doorBlocked);
  }
  return list;
}

function candidateModules(state, type) {
  const list = state.graph.moduleList();
  if (type === FailureType.REACTOR_INSTABILITY) {
    return list.filter(m => m.isReactor || m.isReactorHeatSource);
  }
  if (type === FailureType.MODULE_FIRE) return list.filter(m => !m.onFire);
  if (type === FailureType.SENSOR_MALFUNCTION) return list.filter(m => !m.sensorFault);
  return list;
}

/**
 * Advance the failure system by one tick: optionally spawn new seeded failures
 * (when state.failureRate > 0) and apply the continuous consequence of every
 * active failure.
 * @param {import('./engine.mjs').SimState} state
 * @param {import('./engine.mjs').Engine} engine
 */
export function stepFailures(state, engine) {
  const g = state.graph;

  // Seeded background failure generation (used by the stress benchmark and any
  // free-play seed with a nonzero rate). One RNG draw per tick keeps the
  // stream deterministic regardless of whether a failure is produced.
  if (state.failureRate > 0) {
    if (state.rng.chance(state.failureRate)) {
      injectRandomFailure(state, engine);
    }
  }

  for (const f of state.failureList()) {
    if (!f.active) continue;
    const sev = Math.max(1, f.severity || 1);
    switch (f.type) {
      case FailureType.OXYGEN_LEAK: {
        // Module-target leaks drain directly (connection leaks are handled by
        // the oxygen diffusion/leak pass).
        const m = g.getModule(f.targetId);
        if (m) m.oxygen = Math.max(0, m.oxygen - MODULE_LEAK_DRAIN * sev);
        break;
      }
      case FailureType.MODULE_FIRE: {
        const m = g.getModule(f.targetId);
        if (m) {
          m.onFire = true;
          m.oxygen = Math.max(0, m.oxygen - FIRE_O2_DRAIN * sev);
          m.temperature = m.temperature + FIRE_HEAT * sev;
          if (state.tick % FIRE_DAMAGE_EVERY === 0) {
            m.damage = Math.min(100, m.damage + 1);
          }
        }
        break;
      }
      case FailureType.SENSOR_MALFUNCTION: {
        const m = g.getModule(f.targetId);
        if (m) {
          m.sensorFault = true;
          if (state.tick % SENSOR_DAMAGE_EVERY === 0) {
            m.damage = Math.min(100, m.damage + 1);
          }
        }
        break;
      }
      case FailureType.REACTOR_INSTABILITY: {
        const m = g.getModule(f.targetId);
        if (m) m.temperature = m.temperature + INSTABILITY_HEAT * sev;
        break;
      }
      // POWER_CABLE / COOLANT_LEAK / DOOR_FAILURE are structural (their onset
      // mutation persists on the connection until a drone repairs it).
      default:
        break;
    }
  }
}

/**
 * Resolve (clear) a failure and reverse its structural effect. Called when a
 * repair drone completes a task. Returns true if a failure was cleared.
 */
export function clearFailuresOnTarget(state, engine, targetId, only = null) {
  const g = state.graph;
  let cleared = false;
  for (const f of state.failureList()) {
    if (!f.active || f.targetId !== targetId) continue;
    if (only && f.type !== only) continue;
    f.active = false;
    cleared = true;
  }
  if (!cleared) return false;

  const c = g.getConnection(targetId);
  if (c) {
    // Only lift structural flags that no remaining active failure still imposes.
    const active = state.failureList().filter(f => f.active && f.targetId === targetId);
    const has = t => active.some(f => f.type === t);
    if (!has(FailureType.POWER_CABLE)) c.broken = false;
    if (!has(FailureType.COOLANT_LEAK) && !has(FailureType.OXYGEN_LEAK)) c.leaking = false;
    if (!has(FailureType.DOOR_FAILURE)) c.doorBlocked = false;
    g.invalidate();
  }
  const m = g.getModule(targetId);
  if (m) {
    const active = state.failureList().filter(f => f.active && f.targetId === targetId);
    const has = t => active.some(f => f.type === t);
    if (!has(FailureType.MODULE_FIRE)) m.onFire = false;
    if (!has(FailureType.SENSOR_MALFUNCTION)) m.sensorFault = false;
  }
  return true;
}
