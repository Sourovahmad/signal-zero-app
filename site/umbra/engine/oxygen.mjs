// SIGNAL ZERO - OXYGEN system (Beta stage)
//
// Per-module oxygen STORAGE, generation, crew consumption, inter-module
// diffusion across OXYGEN-carrying connections, leak sink terms on damaged
// connections, dangerous-level detection and crew-health decay when a crewed
// module reaches zero oxygen. Pure integer arithmetic; called once per 100 ms
// tick by the engine AFTER the power solve (so a de-powered generator stops
// producing and a cascade can occur).
//
// Units: oxygen is a scaled integer 0..oxygenCapacity. With the Beta fixtures
// capacity is 100000 (= 100.0%). Danger is a percentage of capacity so the
// scale can change without breaking callers.

export const O2_CAPACITY_DEFAULT = 100000;

// Per-tick rates (1 tick = 100 ms => 10 ticks per simulated second).
const GEN_PER_TICK = 250;          // scaled O2 a powered generator adds / tick
const CREW_DRAIN_PER_TICK = 18;    // scaled O2 drained per crew member / tick
const DIFFUSION_DIV = 8;           // fraction of the gradient moved / tick
const LEAK_PER_TICK = 400;         // scaled O2 lost per severity per leaking edge
const DANGER_PCT = 30;             // warn below this percent of capacity
const RECOVER_PCT = 40;            // clear the warning above this percent
const HEALTH_DECAY_PER_TICK = 1;   // crew health lost / tick at zero oxygen
const HEALTH_REGEN_PER_TICK = 1;   // crew health regained / 5 ticks when safe

/**
 * Advance the oxygen model by one tick, writing directly onto the modules and
 * connections of the graph. Emits threshold-crossing events through `engine`.
 * @param {import('./engine.mjs').SimState} state
 * @param {import('./engine.mjs').Engine} engine
 */
export function stepOxygen(state, engine) {
  const g = state.graph;
  const mods = g.moduleList();

  // 1. Generation (only powered generators produce; power loss cascades here).
  for (const m of mods) {
    if (m.isOxygenGenerator && m.powered) {
      const out = Math.floor((m.oxygenOutput > 0 ? m.oxygenOutput : GEN_PER_TICK));
      m.oxygen = Math.min(m.oxygenCapacity, m.oxygen + out);
    }
  }

  // 2. Crew consumption (drains the module the crew occupy).
  for (const m of mods) {
    if (m.crew > 0 && m.oxygen > 0) {
      const drain = m.crew * CREW_DRAIN_PER_TICK;
      m.oxygen = Math.max(0, m.oxygen - drain);
    }
  }

  // 3. Leak sink terms: damaged/leaking OXYGEN connections bleed both endpoints.
  for (const c of g.connectionList()) {
    if (c.broken || !c.leaking) continue;
    if (c.resources.indexOf('oxygen') === -1) continue;
    const loss = LEAK_PER_TICK * Math.max(1, c.severity || 1);
    const a = g.getModule(c.a), b = g.getModule(c.b);
    if (a) a.oxygen = Math.max(0, a.oxygen - loss);
    if (b) b.oxygen = Math.max(0, b.oxygen - loss);
  }

  // 4. Diffusion across OXYGEN edges, computed from a start-of-step snapshot so
  //    the result is order-independent and conserves mass (flow out of A equals
  //    flow into B before clamping).
  const before = new Map();
  for (const m of mods) before.set(m.id, m.oxygen);
  const delta = new Map();
  for (const m of mods) delta.set(m.id, 0);

  for (const c of g.connectionList()) {
    if (c.broken) continue;
    if (c.resources.indexOf('oxygen') === -1) continue;
    const oa = before.get(c.a), ob = before.get(c.b);
    if (oa === undefined || ob === undefined) continue;
    // Move a fraction of the gradient toward the lower side. A leaking (but not
    // broken) edge still carries some oxygen but at reduced efficiency.
    const grad = oa - ob;
    let flow = Math.trunc(grad / DIFFUSION_DIV);
    if (c.leaking) flow = Math.trunc(flow / 2);
    // Respect connection capacity (scaled so a "unit" of capacity moves 1000).
    const cap = c.capacity * 100;
    if (flow > cap) flow = cap;
    if (flow < -cap) flow = -cap;
    delta.set(c.a, delta.get(c.a) - flow);
    delta.set(c.b, delta.get(c.b) + flow);
  }
  for (const m of mods) {
    const nv = m.oxygen + delta.get(m.id);
    m.oxygen = Math.max(0, Math.min(m.oxygenCapacity, nv));
  }

  // 5. Danger detection (threshold-crossing, logged once) + crew health.
  for (const m of mods) {
    const cap = m.oxygenCapacity > 0 ? m.oxygenCapacity : O2_CAPACITY_DEFAULT;
    const pct = Math.floor((m.oxygen * 100) / cap);

    if (m.crew > 0) {
      if (!m.o2Warn && pct < DANGER_PCT) {
        m.o2Warn = true;
        engine.logEvent(`Oxygen critical in ${m.name} (${pct}%).`, 'danger');
      } else if (m.o2Warn && pct >= RECOVER_PCT) {
        m.o2Warn = false;
        engine.logEvent(`Oxygen restored in ${m.name} (${pct}%).`, 'info');
      }
    }

    // Health decay when a crewed module has zero oxygen; slow regen otherwise.
    if (m.crew > 0) {
      if (m.oxygen <= 0) {
        m.crewHealth = Math.max(0, m.crewHealth - HEALTH_DECAY_PER_TICK);
        if (m.crewHealth <= 0) {
          engine.logEvent(`Crew lost in ${m.name} \u2014 asphyxiation (${m.crew}).`, 'danger');
          m.crew = 0;
          m.crewHealth = 0;
          m.o2Warn = false;
        }
      } else if (m.crewHealth < 100 && pct >= RECOVER_PCT) {
        if (state.tick % 5 === 0) {
          m.crewHealth = Math.min(100, m.crewHealth + HEALTH_REGEN_PER_TICK);
        }
      }
    }
  }
}
