// SIGNAL ZERO - domain models (spec: integer / fixed-point-scaled-integer only)
//
// NO floats are used for any sim-affecting quantity. Where a physical value
// needs sub-unit resolution we store a scaled integer and document the scale.
//
// Scales:
//   power          : whole integer units (no scale)
//   oxygen          : scaled integer 0..oxygenCapacity (fixtures: 100000 = 100%)
//   temperature     : TEMP_SCALE per degree C (deci-degrees, 8000 = 800.0 C)
//   drone progress  : PROGRESS_SCALE per edge length unit
//
// Every model round-trips losslessly through toJSON()/fromJSON() so the
// canonical serializer can persist and restore the EXACT state.

export const OXY_SCALE = 1000;      // legacy scale constant (kept for callers)
export const TEMP_SCALE = 10;       // 1 degree C  = 10 stored ticks
export const PROGRESS_SCALE = 1000; // full traversal of one length unit

export const Priority = Object.freeze({
  CRITICAL: 1,
  HIGH: 2,
  NORMAL: 3,
  LOW: 4,
});

export const PRIORITY_ORDER = [
  Priority.CRITICAL,
  Priority.HIGH,
  Priority.NORMAL,
  Priority.LOW,
];

export const Resource = Object.freeze({
  POWER: 'power',
  OXYGEN: 'oxygen',
  COOLANT: 'coolant',
});

export class Module {
  /**
   * @param {object} o
   */
  constructor(o) {
    this.id = o.id;
    this.name = o.name;
    // Grid position for the interactive map (integers, layout only).
    this.x = o.x | 0;
    this.y = o.y | 0;

    this.priority = o.priority || Priority.NORMAL;

    // Power (integer units). powerReceived is restored from a save so a loaded
    // snapshot is byte-identical to the saved one before the next power solve.
    this.powerDemand = o.powerDemand | 0;   // requested this tick
    this.powerReceived = o.powerReceived | 0; // solved per tick (restorable)

    // Reactor role.
    this.isReactor = !!o.isReactor;
    this.reactorOutput = o.reactorOutput | 0;       // integer units of power
    this.reactorBaseOutput = (o.reactorBaseOutput | 0) || (o.reactorOutput | 0);
    this.reactorShutdown = !!o.reactorShutdown;
    this.reactorDamaged = !!o.reactorDamaged;
    // Cooling efficiency (integer percent, 0..100).
    this.coolingEfficiency = (typeof o.coolingEfficiency === 'number') ? (o.coolingEfficiency | 0) : 100;

    // Oxygen (scaled integer).
    this.oxygen = (o.oxygen | 0);            // current stored oxygen
    this.oxygenCapacity = (o.oxygenCapacity | 0);
    this.isOxygenGenerator = !!o.isOxygenGenerator;
    this.oxygenOutput = o.oxygenOutput | 0;  // per-tick generation (scaled)
    this.o2Warn = !!o.o2Warn;                // danger-threshold latch

    // Heat / temperature (scaled integer, TEMP_SCALE).
    this.isReactorHeatSource = !!o.isReactorHeatSource;
    this.temperature = o.temperature | 0;         // current temperature (scaled)
    this.coolingCapacity = o.coolingCapacity | 0; // heat removed per tick capacity
    this.tempWarn = !!o.tempWarn;                 // 800C threshold latch

    // Crew and health.
    this.crew = o.crew | 0;
    this.crewHealth = (typeof o.crewHealth === 'number') ? (o.crewHealth | 0) : 100;

    // Damage 0..100 (integer percent).
    this.damage = o.damage | 0;

    // Failure flags resolved for map rendering.
    this.onFire = !!o.onFire;
    this.sensorFault = !!o.sensorFault;
  }

  get powered() {
    if (this.powerDemand === 0) return true;
    return this.powerReceived >= this.powerDemand;
  }

  toJSON() {
    return {
      id: this.id, name: this.name, x: this.x, y: this.y,
      priority: this.priority,
      powerDemand: this.powerDemand, powerReceived: this.powerReceived,
      isReactor: this.isReactor, reactorOutput: this.reactorOutput,
      reactorBaseOutput: this.reactorBaseOutput,
      reactorShutdown: this.reactorShutdown, reactorDamaged: this.reactorDamaged,
      coolingEfficiency: this.coolingEfficiency,
      oxygen: this.oxygen, oxygenCapacity: this.oxygenCapacity,
      isOxygenGenerator: this.isOxygenGenerator, oxygenOutput: this.oxygenOutput,
      o2Warn: this.o2Warn,
      isReactorHeatSource: this.isReactorHeatSource,
      temperature: this.temperature, coolingCapacity: this.coolingCapacity,
      tempWarn: this.tempWarn,
      crew: this.crew, crewHealth: this.crewHealth,
      damage: this.damage, onFire: this.onFire, sensorFault: this.sensorFault,
    };
  }

  static fromJSON(o) { return new Module(o); }
}

export class Connection {
  constructor(o) {
    this.id = o.id;
    this.a = o.a;                 // module id
    this.b = o.b;                 // module id
    this.resources = o.resources ? o.resources.slice() : [Resource.POWER];
    this.capacity = o.capacity | 0;   // max units carried (power/oxygen)
    this.broken = !!o.broken;         // fully severed (no resource, no drones)
    this.leaking = !!o.leaking;       // leaks oxygen / loses coolant conduction
    this.doorBlocked = !!o.doorBlocked; // impassable to drones (resources flow)
    this.length = (o.length | 0) || 1; // graph weight (>=1)
    this.severity = (o.severity | 0) || 1; // leak magnitude multiplier
  }

  carries(resource) {
    return !this.broken && this.resources.indexOf(resource) !== -1;
  }

  other(nodeId) {
    return nodeId === this.a ? this.b : this.a;
  }

  toJSON() {
    return {
      id: this.id, a: this.a, b: this.b,
      resources: this.resources.slice(),
      capacity: this.capacity, broken: this.broken,
      leaking: this.leaking, doorBlocked: this.doorBlocked,
      length: this.length, severity: this.severity,
    };
  }

  static fromJSON(o) { return new Connection(o); }
}

export const TaskType = Object.freeze({
  REPAIR_CONNECTION: 'repair_connection',
  REPAIR_MODULE: 'repair_module',
  EXTINGUISH_FIRE: 'extinguish_fire',
  INSPECT_MODULE: 'inspect_module',
});

let TASK_SEQ = 0;
export function nextTaskId() { return `task-${++TASK_SEQ}`; }
export function resetTaskSeq(n) { TASK_SEQ = n | 0; }
export function currentTaskSeq() { return TASK_SEQ; }

export class Task {
  constructor(o) {
    this.id = o.id || nextTaskId();
    this.type = o.type;
    this.targetId = o.targetId;        // module id or connection id
    this.progress = o.progress | 0;    // work done (scaled integer)
    this.workRequired = (o.workRequired | 0) || 100;
    this.failed = !!o.failed;
  }
  toJSON() {
    return {
      id: this.id, type: this.type, targetId: this.targetId,
      progress: this.progress, workRequired: this.workRequired,
      failed: this.failed,
    };
  }
  static fromJSON(o) { return new Task(o); }
}

export class TaskQueue {
  constructor(o) {
    this.tasks = (o && o.tasks) ? o.tasks.map(Task.fromJSON) : [];
  }
  add(task) { this.tasks.push(task); return task; }
  remove(taskId) {
    const i = this.tasks.findIndex(t => t.id === taskId);
    if (i === -1) return false;
    this.tasks.splice(i, 1);
    return true;
  }
  reorder(taskId, toIndex) {
    const i = this.tasks.findIndex(t => t.id === taskId);
    if (i === -1) return false;
    const [t] = this.tasks.splice(i, 1);
    const clamped = Math.max(0, Math.min(toIndex | 0, this.tasks.length));
    this.tasks.splice(clamped, 0, t);
    return true;
  }
  head() { return this.tasks[0]; }
  toJSON() { return { tasks: this.tasks.map(t => t.toJSON()) }; }
  static fromJSON(o) { return new TaskQueue(o); }
}

export class Drone {
  constructor(o) {
    this.id = o.id;
    this.atNode = o.atNode;            // current module id (when not mid-edge)
    this.edgeFrom = o.edgeFrom || null;
    this.edgeTo = o.edgeTo || null;
    this.edgeProgress = o.edgeProgress | 0; // 0..(length*PROGRESS_SCALE)
    this.route = o.route ? o.route.slice() : []; // remaining node ids
    this.queue = TaskQueue.fromJSON(o.queue || { tasks: [] });
    this.speed = (o.speed | 0) || 250; // progress units per second
    this.busy = !!o.busy;
  }

  get available() {
    return this.queue.tasks.length === 0 && !this.busy && !this.edgeTo;
  }

  toJSON() {
    return {
      id: this.id, atNode: this.atNode,
      edgeFrom: this.edgeFrom, edgeTo: this.edgeTo,
      edgeProgress: this.edgeProgress, route: this.route.slice(),
      queue: this.queue.toJSON(), speed: this.speed, busy: this.busy,
    };
  }
  static fromJSON(o) { return new Drone(o); }
}

export const FailureType = Object.freeze({
  POWER_CABLE: 'power_cable_failure',
  OXYGEN_LEAK: 'oxygen_leak',
  COOLANT_LEAK: 'coolant_leak',
  MODULE_FIRE: 'module_fire',
  SENSOR_MALFUNCTION: 'sensor_malfunction',
  DOOR_FAILURE: 'door_failure',
  REACTOR_INSTABILITY: 'reactor_instability',
});

export class Failure {
  constructor(o) {
    this.id = o.id;
    this.type = o.type;
    this.targetId = o.targetId;        // module id or connection id
    this.startTick = o.startTick | 0;
    this.active = (o.active === undefined) ? true : !!o.active;
    this.severity = (o.severity | 0) || 1;
  }
  toJSON() {
    return {
      id: this.id, type: this.type, targetId: this.targetId,
      startTick: this.startTick, active: this.active, severity: this.severity,
    };
  }
  static fromJSON(o) { return new Failure(o); }
}
