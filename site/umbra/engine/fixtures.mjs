// SIGNAL ZERO - deterministic station fixtures
//
// Plain-integer configuration objects used by tests, the headless benchmark
// and the UI scenario loader. No randomness at build time - all runtime
// variation flows through the seeded engine RNG.
//
// Oxygen is a scaled integer 0..oxygenCapacity; here capacity is 100000
// (= 100.0%) to give fine, float-free resolution for consumption/diffusion.

import { Priority, Resource, FailureType } from './models.mjs';

const P = Resource.POWER, O = Resource.OXYGEN, C = Resource.COOLANT;
export const O2_CAP = 100000;

/**
 * A 10-module research station roughly matching the spec's example modules.
 * Total power demand (158) exceeds reactor output (120) so priority handling
 * is exercised. Fully connected ring + spokes. Crew total = 14.
 */
export function buildStation(seed = 1) {
  const modules = [
    { id: 'reactor', name: 'Reactor', x: 400, y: 300, priority: Priority.CRITICAL,
      isReactor: true, reactorOutput: 120, powerDemand: 0,
      isReactorHeatSource: true, temperature: 4200, coolingEfficiency: 100,
      oxygen: 50000, oxygenCapacity: O2_CAP },
    { id: 'command', name: 'Command', x: 400, y: 120, priority: Priority.CRITICAL,
      powerDemand: 20, crew: 3, oxygen: 90000, oxygenCapacity: O2_CAP },
    { id: 'oxygen', name: 'Oxygen', x: 220, y: 200, priority: Priority.HIGH,
      powerDemand: 35, isOxygenGenerator: true, oxygenOutput: 250,
      oxygen: 100000, oxygenCapacity: O2_CAP },
    { id: 'cooling', name: 'Cooling', x: 580, y: 200, priority: Priority.HIGH,
      powerDemand: 30, coolingCapacity: 90, coolingEfficiency: 100,
      oxygen: 70000, oxygenCapacity: O2_CAP },
    { id: 'laboratory', name: 'Laboratory', x: 620, y: 420, priority: Priority.LOW,
      powerDemand: 40, crew: 2, oxygen: 80000, oxygenCapacity: O2_CAP },
    { id: 'crew', name: 'Crew Quarters', x: 220, y: 420, priority: Priority.NORMAL,
      powerDemand: 10, crew: 6, oxygen: 95000, oxygenCapacity: O2_CAP },
    { id: 'medical', name: 'Medical', x: 300, y: 520, priority: Priority.NORMAL,
      powerDemand: 8, crew: 2, oxygen: 90000, oxygenCapacity: O2_CAP },
    { id: 'battery', name: 'Battery', x: 500, y: 520, priority: Priority.LOW,
      powerDemand: 5, oxygen: 40000, oxygenCapacity: O2_CAP },
    { id: 'comms', name: 'Communications', x: 120, y: 300, priority: Priority.NORMAL,
      powerDemand: 6, crew: 1, oxygen: 85000, oxygenCapacity: O2_CAP },
    { id: 'airlock', name: 'Airlock', x: 680, y: 300, priority: Priority.LOW,
      powerDemand: 4, oxygen: 60000, oxygenCapacity: O2_CAP },
  ];

  const connections = [
    { id: 'C1', a: 'reactor', b: 'command', resources: [P], capacity: 60, length: 2 },
    { id: 'C2', a: 'reactor', b: 'oxygen', resources: [P, O], capacity: 50, length: 2 },
    // C3 carries POWER only; the sole coolant line to the reactor is C7 so a
    // coolant failure genuinely removes cooling.
    { id: 'C3', a: 'reactor', b: 'cooling', resources: [P], capacity: 50, length: 2 },
    { id: 'C4', a: 'reactor', b: 'laboratory', resources: [P], capacity: 60, length: 3 },
    { id: 'C5', a: 'reactor', b: 'battery', resources: [P], capacity: 40, length: 3 },
    { id: 'C6', a: 'oxygen', b: 'crew', resources: [P, O], capacity: 40, length: 2 },
    { id: 'C7', a: 'cooling', b: 'reactor', resources: [C], capacity: 90, length: 1 },
    { id: 'C8', a: 'command', b: 'comms', resources: [P, O], capacity: 30, length: 2 },
    { id: 'C9', a: 'crew', b: 'medical', resources: [P, O], capacity: 25, length: 2 },
    { id: 'C10', a: 'laboratory', b: 'airlock', resources: [P, O], capacity: 25, length: 2 },
    { id: 'C11', a: 'oxygen', b: 'comms', resources: [P, O], capacity: 20, length: 3 },
    { id: 'C12', a: 'battery', b: 'medical', resources: [P], capacity: 20, length: 2 },
  ];

  const drones = [
    { id: 'drone-1', atNode: 'command', speed: 250, queue: { tasks: [] } },
    { id: 'drone-2', atNode: 'reactor', speed: 250, queue: { tasks: [] } },
    { id: 'drone-3', atNode: 'laboratory', speed: 250, queue: { tasks: [] } },
  ];

  return { seed, speed: 1, name: 'Research Station', modules, connections, drones, failures: [] };
}

/**
 * The predefined "Seven Minutes" scenario. Starting conditions: reactor output
 * 110, cooling efficiency 76%, 3 drones, 14 crew, 7-minute goal. The timed
 * in-run failures fire from scenarioEvents through the seeded engine:
 *   60 s  -> coolant line C7 fails (cooling lost, reactor heats)
 *  120 s  -> oxygen leak begins in Crew Quarters
 *  180 s  -> one random power connection fails
 */
export function buildSevenMinutes(seed = 70000) {
  const cfg = buildStation(seed);
  cfg.name = 'Seven Minutes';
  cfg.goalTicks = 4200; // 7 minutes * 60 * 10 ticks
  const reactor = cfg.modules.find(m => m.id === 'reactor');
  reactor.reactorOutput = 110;
  reactor.reactorBaseOutput = 110;
  const cooling = cfg.modules.find(m => m.id === 'cooling');
  cooling.coolingEfficiency = 76;
  cfg.scenarioEvents = [
    { tick: 600, failure: { type: FailureType.COOLANT_LEAK, targetId: 'C7', severity: 2 } },
    { tick: 1200, failure: { type: FailureType.OXYGEN_LEAK, targetId: 'crew', severity: 2 } },
    { tick: 1800, random: true, failure: { type: FailureType.POWER_CABLE } },
  ];
  return cfg;
}

/**
 * Small graph purpose-built for capacity tests: one reactor, two loads, and a
 * deliberately narrow connection that throttles delivery to load-b.
 */
export function buildCapacityStation(seed = 7) {
  const modules = [
    { id: 'src', name: 'Reactor', x: 0, y: 0, priority: Priority.CRITICAL,
      isReactor: true, reactorOutput: 100, powerDemand: 0 },
    { id: 'a', name: 'Load A', x: 1, y: 0, priority: Priority.HIGH, powerDemand: 30 },
    { id: 'b', name: 'Load B', x: 2, y: 0, priority: Priority.HIGH, powerDemand: 50 },
  ];
  const connections = [
    { id: 'E1', a: 'src', b: 'a', resources: [P], capacity: 100, length: 1 },
    // Narrow link: only 20 units can reach b even though 50 is demanded.
    { id: 'E2', a: 'a', b: 'b', resources: [P], capacity: 20, length: 1 },
  ];
  return { seed, speed: 1, name: 'Capacity Test', modules, connections, drones: [], failures: [] };
}
