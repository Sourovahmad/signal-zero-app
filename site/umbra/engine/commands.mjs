// SIGNAL ZERO - command-sourcing layer
//
// All player intent enters the engine as timestamped Commands. Commands are
// applied ONLY at tick boundaries (never mid-tick), so the full history of
// (seed + commands) reproduces state exactly. Players never mutate sim
// objects directly.

export const CommandType = Object.freeze({
  NOOP: 'noop',
  SET_PRIORITY: 'set_priority',
  ADD_TASK: 'add_task',
  REMOVE_TASK: 'remove_task',
  REORDER_TASK: 'reorder_task',
  SET_SPEED: 'set_speed',
});

export class Command {
  /**
   * @param {object} o
   * @param {number} o.tick - the tick at whose boundary this applies
   * @param {string} o.type - CommandType
   * @param {object} [o.payload] - type-specific data (plain integers/strings)
   */
  constructor(o) {
    this.tick = o.tick | 0;
    this.type = o.type;
    this.payload = o.payload ? { ...o.payload } : {};
  }

  toJSON() {
    return { tick: this.tick, type: this.type, payload: { ...this.payload } };
  }

  static fromJSON(o) { return new Command(o); }
}

// Convenience constructors (keep payload shapes consistent across the app).
export const Commands = {
  noop(tick) {
    return new Command({ tick, type: CommandType.NOOP });
  },
  setPriority(tick, moduleId, priority) {
    return new Command({
      tick, type: CommandType.SET_PRIORITY,
      payload: { moduleId, priority: priority | 0 },
    });
  },
  addTask(tick, droneId, task) {
    return new Command({
      tick, type: CommandType.ADD_TASK,
      payload: { droneId, task },
    });
  },
  removeTask(tick, droneId, taskId) {
    return new Command({
      tick, type: CommandType.REMOVE_TASK,
      payload: { droneId, taskId },
    });
  },
  reorderTask(tick, droneId, taskId, toIndex) {
    return new Command({
      tick, type: CommandType.REORDER_TASK,
      payload: { droneId, taskId, toIndex: toIndex | 0 },
    });
  },
  setSpeed(tick, speed) {
    return new Command({
      tick, type: CommandType.SET_SPEED,
      payload: { speed: speed | 0 },
    });
  },
};

/**
 * A deterministic ordered command buffer. Commands are grouped by tick and,
 * within a tick, applied in insertion order.
 */
export class CommandLog {
  constructor(commands) {
    this.commands = commands ? commands.map(Command.fromJSON) : [];
  }

  add(command) {
    this.commands.push(command);
    return command;
  }

  /** Commands scheduled exactly at the given tick, in insertion order. */
  at(tick) {
    return this.commands.filter(c => c.tick === tick);
  }

  toJSON() { return this.commands.map(c => c.toJSON()); }
  static fromJSON(arr) { return new CommandLog(arr); }
}
