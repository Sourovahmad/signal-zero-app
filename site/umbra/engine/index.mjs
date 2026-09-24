// SIGNAL ZERO - engine package barrel (headless, UI-free simulation spine)
//
// Re-exports the deterministic simulation engine and all live systems. NOTHING
// here imports UI code; this package is fully headless and testable on its own.

export { DeterministicRng, makeRng } from './rng.mjs';
export {
  OXY_SCALE, TEMP_SCALE, PROGRESS_SCALE,
  Priority, PRIORITY_ORDER, Resource,
  Module, Connection,
  TaskType, Task, TaskQueue, Drone,
  FailureType, Failure,
  nextTaskId, resetTaskSeq, currentTaskSeq,
} from './models.mjs';
export { StationGraph } from './graph.mjs';
export { solvePower } from './power.mjs';
export {
  CommandType, Command, Commands, CommandLog,
} from './commands.mjs';
export { SimClock, TICK_MS, ALLOWED_SPEEDS, formatSimTime } from './clock.mjs';
export { SimState, Engine, checksum } from './engine.mjs';

// Live systems (Beta stage).
export { stepOxygen, O2_CAPACITY_DEFAULT } from './oxygen.mjs';
export { stepThermal, THERMAL_THRESHOLDS } from './thermal.mjs';
export {
  stepFailures, spawnFailure, injectRandomFailure,
  applyFailureOnset, clearFailuresOnTarget,
} from './failures.mjs';
export { stepDrones, dronePath } from './drones.mjs';

// Persistence + replay (canonical serializer, save/load, black box).
export {
  SAVE_FORMAT, SAVE_VERSION, SaveError,
  canonicalJSON, sha256Hex, digestOf,
  makeSave, serialize, validateSave, deserialize,
  loadEngine, loadSave, tryLoad,
} from './persistence.mjs';
export {
  REPLAY_FORMAT, REPLAY_VERSION, BlackBox, replay, verifyReplay,
} from './replay.mjs';
