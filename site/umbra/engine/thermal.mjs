// SIGNAL ZERO - COOLING / THERMAL loop (Beta stage)
//
// A stateful reactor heat balance:
//   heat_in  = fuel rate (reactorBaseOutput) while running, or a decaying
//              residual fraction while shut down.
//   heat_out = powered cooling capacity that can still reach the reactor over
//              non-broken COOLANT connections, scaled by cooling efficiency.
// A power loss to a cooling module, or a severed coolant line, therefore
// cascades into a temperature rise. Past a warning threshold reactor
// efficiency droops (reducing power output -> further cascade); at a critical
// threshold the reactor auto-shuts-down; if residual heat keeps rising after
// shutdown the core is permanently damaged.
//
// Temperature is a scaled integer (TEMP_SCALE = 10, so 8000 = 800.0 C).

import { Resource } from './models.mjs';

const WARN_TEMP = 8000;      // 800.0 C - efficiency droop + warning
const CRIT_TEMP = 12000;     // 1200.0 C - automatic shutdown
const DAMAGE_TEMP = 15000;   // 1500.0 C - permanent damage if still rising
const RESTART_TEMP = 7000;   // 700.0 C - auto-restart after a cooldown
const AMBIENT = 300;         // 30.0 C floor

const HEAT_IN_PER_OUTPUT = 5;  // temp units / tick per unit of fuel rate
const COOL_PER_CAP = 9;        // temp units / tick per unit of cooling capacity
const RESIDUAL_NUM = 2, RESIDUAL_DEN = 5; // residual heat = 40% of fuel rate
const DROOP_DIV = 40;          // efficiency loss slope past the warning temp

/**
 * BFS over non-broken COOLANT connections: can `fromId` reach `toId`?
 */
function coolantReaches(graph, fromId, toId) {
  if (fromId === toId) return true;
  const seen = new Set([fromId]);
  const stack = [fromId];
  while (stack.length) {
    const cur = stack.pop();
    for (const { conn, to } of graph.neighbors(cur)) {
      if (conn.broken) continue;
      if (conn.resources.indexOf(Resource.COOLANT) === -1) continue;
      if (seen.has(to)) continue;
      if (to === toId) return true;
      seen.add(to);
      stack.push(to);
    }
  }
  return false;
}

/**
 * Advance the thermal model by one tick for every reactor heat source.
 * @param {import('./engine.mjs').SimState} state
 * @param {import('./engine.mjs').Engine} engine
 */
export function stepThermal(state, engine) {
  const g = state.graph;
  const reactors = g.moduleList().filter(m => m.isReactorHeatSource || m.isReactor);

  for (const r of reactors) {
    // --- heat_out: powered cooling capacity that can reach this reactor ---
    let coolCap = 0;
    for (const m of g.moduleList()) {
      if (m.coolingCapacity <= 0) continue;
      if (!m.powered) continue;                       // power loss cascades
      if (!coolantReaches(g, m.id, r.id)) continue;   // coolant line severed
      const eff = Math.max(0, Math.min(100, m.coolingEfficiency));
      coolCap += Math.floor((m.coolingCapacity * eff) / 100);
    }
    const heatOut = coolCap * COOL_PER_CAP;

    // --- heat_in: fuel rate while running, residual fraction while down ---
    let heatIn;
    if (r.reactorDamaged) {
      heatIn = 0; // dead core - it can only cool now
    } else if (r.reactorShutdown) {
      heatIn = Math.floor((r.reactorBaseOutput * RESIDUAL_NUM * HEAT_IN_PER_OUTPUT) / RESIDUAL_DEN);
    } else {
      heatIn = r.reactorBaseOutput * HEAT_IN_PER_OUTPUT;
    }

    const prevTemp = r.temperature;
    let temp = prevTemp + (heatIn - heatOut);
    if (temp < AMBIENT) temp = AMBIENT;
    r.temperature = temp;

    // --- warning threshold crossing (logged once) ---
    if (!r.tempWarn && temp >= WARN_TEMP) {
      r.tempWarn = true;
      engine.logEvent(`Reactor temperature exceeded 800\u00B0C (${(temp / 10).toFixed(1)}\u00B0C).`, 'warn');
    } else if (r.tempWarn && temp < WARN_TEMP) {
      r.tempWarn = false;
    }

    // --- automatic shutdown at critical temperature ---
    if (!r.reactorShutdown && !r.reactorDamaged && temp >= CRIT_TEMP) {
      r.reactorShutdown = true;
      engine.logEvent(`Reactor AUTO-SHUTDOWN at ${(temp / 10).toFixed(1)}\u00B0C.`, 'danger');
    }

    // --- permanent damage: shut down, yet residual heat still rising past the
    //     damage threshold means the core cooks itself ---
    if (r.reactorShutdown && !r.reactorDamaged && temp >= DAMAGE_TEMP && temp > prevTemp) {
      r.reactorDamaged = true;
      engine.logEvent(`Reactor PERMANENTLY DAMAGED at ${(temp / 10).toFixed(1)}\u00B0C.`, 'danger');
    }

    // --- auto-restart once safely cooled (unless permanently damaged) ---
    if (r.reactorShutdown && !r.reactorDamaged && temp < RESTART_TEMP) {
      r.reactorShutdown = false;
      engine.logEvent(`Reactor restarted (cooled to ${(temp / 10).toFixed(1)}\u00B0C).`, 'info');
    }

    // --- efficiency droop -> throttled power output (drives the cascade) ---
    let effOut;
    if (r.reactorDamaged || r.reactorShutdown) {
      effOut = 0;
    } else if (temp <= WARN_TEMP) {
      effOut = r.reactorBaseOutput;
    } else {
      const effPct = Math.max(0, 100 - Math.floor((temp - WARN_TEMP) / DROOP_DIV));
      effOut = Math.floor((r.reactorBaseOutput * effPct) / 100);
    }
    r.reactorOutput = effOut;
  }
}

export const THERMAL_THRESHOLDS = { WARN_TEMP, CRIT_TEMP, DAMAGE_TEMP, RESTART_TEMP, AMBIENT };
