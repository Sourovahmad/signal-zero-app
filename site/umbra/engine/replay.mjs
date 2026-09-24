// SIGNAL ZERO - black-box recorder + replay driver
//
// The black box stores exactly the three things needed to reproduce a session
// deterministically:
//   * the INITIAL seed (carried inside the initial config),
//   * the initial CONFIG (scenario data used to create the engine at tick 0),
//   * the timestamped PLAYER COMMANDS (each command carries its sim tick), and
//   * the sim TIMESTAMP the recording ended at (finalTick).
//
// Because the engine is fully deterministic (single seeded RNG, integer state,
// commands applied only at tick boundaries), re-creating the engine from the
// same config, feeding the identical command log, and running to finalTick
// reproduces the byte-identical final state - verified by checksum match.
//
// This module is UI-free and runs headless (Node) and in the renderer alike.

import { Engine, checksum } from './engine.mjs';
import { CommandLog } from './commands.mjs';
import { canonicalJSON, sha256Hex } from './persistence.mjs';

export const REPLAY_FORMAT = 'signalzero.replay';
export const REPLAY_VERSION = 1;

/** Deep JSON clone so a recorder can never be mutated by later engine steps. */
function cloneJSON(v) {
  return v === null || v === undefined ? null : JSON.parse(JSON.stringify(v));
}

export class BlackBox {
  /**
   * @param {object} o
   * @param {object} o.config - initial engine config (JSON-safe, carries seed)
   * @param {Array}  [o.commands] - CommandLog.toJSON() array (timestamped)
   * @param {number} [o.finalTick] - sim tick the recording ended at
   * @param {number} [o.seed] - convenience copy of the initial seed
   */
  constructor(o) {
    this.config = cloneJSON(o.config);
    this.seed = (o.seed !== undefined ? o.seed : (this.config ? this.config.seed : 0)) | 0;
    this.commands = (o.commands || []).map(c => ({
      tick: c.tick | 0, type: c.type, payload: c.payload ? { ...c.payload } : {},
    }));
    this.finalTick = o.finalTick | 0;
  }

  /**
   * Capture a black box from a live engine. The engine's command log already
   * holds every timestamped command since tick 0, so recording is just a copy
   * of (config + command log + current tick).
   * @param {Engine} engine
   * @param {object} config - the config the engine was created from
   */
  static fromEngine(engine, config) {
    return new BlackBox({
      config,
      seed: config ? config.seed : engine.state.seed,
      commands: engine.state.commandLog.toJSON(),
      finalTick: engine.tick,
    });
  }

  /** Total number of recorded player commands. */
  get commandCount() { return this.commands.length; }

  toJSON() {
    const body = {
      config: this.config,
      seed: this.seed,
      commands: this.commands.map(c => ({ tick: c.tick, type: c.type, payload: { ...c.payload } })),
      finalTick: this.finalTick,
    };
    return {
      format: REPLAY_FORMAT,
      version: REPLAY_VERSION,
      digest: sha256Hex(canonicalJSON({ version: REPLAY_VERSION, ...body })),
      ...body,
    };
  }

  /** Serialise to canonical (sorted-key) JSON text. */
  serialize() { return canonicalJSON(this.toJSON()); }

  /** Parse + validate a recording (string or object). Throws on problems. */
  static fromJSON(textOrObj) {
    let o = textOrObj;
    if (typeof textOrObj === 'string') {
      try {
        o = JSON.parse(textOrObj);
      } catch (e) {
        throw new Error('malformed replay JSON: ' + (e && e.message ? e.message : e));
      }
    }
    if (!o || typeof o !== 'object') throw new Error('replay is not an object');
    if (o.format !== REPLAY_FORMAT) throw new Error('not a SIGNAL ZERO replay recording');
    if (typeof o.version !== 'number' || o.version > REPLAY_VERSION) {
      throw new Error('unsupported replay version');
    }
    if (!o.config || typeof o.config !== 'object') throw new Error('replay missing initial config');
    if ('commands' in o && !Array.isArray(o.commands)) throw new Error('replay commands must be an array');
    if ('digest' in o) {
      const expected = sha256Hex(canonicalJSON({
        version: o.version,
        config: o.config,
        seed: o.seed !== undefined ? o.seed : (o.config ? o.config.seed : 0),
        commands: o.commands || [],
        finalTick: o.finalTick | 0,
      }));
      if (expected !== o.digest) throw new Error('replay integrity check failed \u2014 corrupted');
    }
    return new BlackBox(o);
  }
}

/**
 * Re-run a black box headlessly and return the resulting engine at finalTick.
 * @param {BlackBox|object|string} blackbox
 * @returns {Engine}
 */
export function replay(blackbox) {
  const bb = (blackbox instanceof BlackBox) ? blackbox : BlackBox.fromJSON(blackbox);
  const eng = Engine.create(bb.config);
  // Feed the exact recorded, timestamped command history. step() will apply
  // each command at its own tick boundary, reproducing the original run.
  eng.state.commandLog = CommandLog.fromJSON(bb.commands);
  eng.run(bb.finalTick);
  return eng;
}

/**
 * Replay a recording and compare its final checksum against an expectation.
 * @param {BlackBox|object|string} blackbox
 * @param {number} [expectedChecksum] - if omitted, only computes the checksum
 * @returns {{engine:Engine, checksum:number, match:boolean}}
 */
export function verifyReplay(blackbox, expectedChecksum) {
  const engine = replay(blackbox);
  const sum = checksum(engine.snapshot());
  return {
    engine,
    checksum: sum,
    match: expectedChecksum === undefined ? true : (sum === (expectedChecksum >>> 0)),
  };
}
