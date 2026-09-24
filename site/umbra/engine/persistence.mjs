// SIGNAL ZERO - canonical persistence / save system
//
// This module is the ONE canonical serializer for the whole project. The same
// order-independent, sorted-key JSON representation powers:
//   * the SAVE / LOAD system (full state incl. RNG position, task queues,
//     active repairs and event history),
//   * the black-box replay integrity digest, and
//   * the deterministic benchmark checksum helper.
//
// It is completely UI-free and runs identically headless under Node and inside
// the offline Electron renderer (pure integer / string arithmetic; no platform
// APIs, no external crypto dependency).
//
// Design goals:
//   * VERSIONED schema so future changes are detectable.
//   * ORDER-INDEPENDENT: canonicalJSON sorts object keys recursively, so two
//     states that are logically equal serialise to byte-identical text (and
//     therefore share a checksum) regardless of insertion order.
//   * INTEGRITY: every save carries a SHA-256 digest of its canonical payload;
//     load recomputes and rejects any mismatch (corruption / tampering).
//   * DEFENSIVE: malformed JSON, wrong format, incompatible version or missing
//     structure are rejected with a typed SaveError - never an uncaught crash.

import { Engine } from './engine.mjs';

export const SAVE_FORMAT = 'signalzero.save';
export const SAVE_VERSION = 1;

/** Typed error so callers can distinguish "bad save" from a real bug. */
export class SaveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SaveError';
  }
}

// ---------------------------------------------------------------------------
// Canonical, order-independent JSON.
// ---------------------------------------------------------------------------

/**
 * Serialise any JSON-compatible value with object keys sorted recursively.
 * Undefined is normalised to null so the output is always valid, parseable
 * JSON. This is the canonical form used for digests and checksums.
 */
export function canonicalJSON(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

// ---------------------------------------------------------------------------
// SHA-256 (pure JS, no dependencies). Deterministic on every platform.
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

function utf8Bytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      // Surrogate pair -> single code point.
      i++;
      const c2 = str.charCodeAt(i);
      const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      bytes.push(
        0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return bytes;
}

/** SHA-256 of a string (UTF-8), returned as a 64-char lowercase hex string. */
export function sha256Hex(str) {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const bytes = utf8Bytes(String(str));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
  bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

  const w = new Uint32Array(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = ((bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) |
        (bytes[off + i * 4 + 2] << 8) | (bytes[off + i * 4 + 3])) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ ((~e) & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i++) hex += ('00000000' + H[i].toString(16)).slice(-8);
  return hex;
}

/** SHA-256 digest of any value's canonical (sorted-key) JSON form. */
export function digestOf(value) {
  return sha256Hex(canonicalJSON(value));
}

// ---------------------------------------------------------------------------
// Save object assembly.
// ---------------------------------------------------------------------------

/**
 * Build the canonical save object for a live engine.
 *
 * The payload holds the full world snapshot() (modules, connections, drones,
 * task queues, active repairs, failures, sim-time, RNG getState, event log)
 * plus the complete command history and the original session config (so a save
 * loaded mid-run can still export a black-box replay from tick 0). A SHA-256
 * digest over the canonical payload guarantees integrity on load.
 *
 * @param {Engine} engine
 * @param {object} [origin] - the initial config used to create the session
 * @returns {object} save object
 */
export function makeSave(engine, origin = null) {
  const state = engine.snapshot();
  const commands = engine.state.commandLog.toJSON();
  const payload = {
    origin: origin || null,
    state,
    commands,
  };
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    digest: digestOf({ version: SAVE_VERSION, ...payload }),
    ...payload,
  };
}

/** Serialise an engine to a canonical (sorted-key) save string. */
export function serialize(engine, origin = null) {
  return canonicalJSON(makeSave(engine, origin));
}

// ---------------------------------------------------------------------------
// Defensive validation + load.
// ---------------------------------------------------------------------------

function requireField(obj, key, kind, where) {
  if (!(key in obj)) throw new SaveError(`missing field "${key}" in ${where}`);
  const v = obj[key];
  if (kind === 'array' && !Array.isArray(v)) throw new SaveError(`field "${key}" in ${where} must be an array`);
  if (kind === 'object' && (v === null || typeof v !== 'object' || Array.isArray(v))) {
    throw new SaveError(`field "${key}" in ${where} must be an object`);
  }
  if (kind === 'number' && typeof v !== 'number') throw new SaveError(`field "${key}" in ${where} must be a number`);
  return v;
}

/**
 * Validate a parsed save object structurally, by version, and by integrity
 * digest. Throws SaveError on any problem. Returns the object on success.
 */
export function validateSave(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new SaveError('save is not an object');
  }
  if (obj.format !== SAVE_FORMAT) {
    throw new SaveError(`unrecognised format "${obj.format}" (expected "${SAVE_FORMAT}")`);
  }
  if (typeof obj.version !== 'number' || !Number.isInteger(obj.version)) {
    throw new SaveError('missing or non-integer version');
  }
  if (obj.version > SAVE_VERSION) {
    throw new SaveError(`save version ${obj.version} is newer than supported version ${SAVE_VERSION}`);
  }
  if (obj.version < 1) {
    throw new SaveError(`unsupported save version ${obj.version}`);
  }

  const state = requireField(obj, 'state', 'object', 'save');
  // commands is optional but must be an array when present.
  if ('commands' in obj && !Array.isArray(obj.commands)) {
    throw new SaveError('field "commands" must be an array');
  }

  // Core state structure.
  requireField(state, 'seed', 'number', 'state');
  requireField(state, 'tick', 'number', 'state');
  if (!('rngState' in state) || typeof state.rngState !== 'number') {
    throw new SaveError('state is missing a numeric rngState');
  }
  const graph = requireField(state, 'graph', 'object', 'state');
  requireField(graph, 'modules', 'array', 'state.graph');
  requireField(graph, 'connections', 'array', 'state.graph');
  requireField(state, 'drones', 'array', 'state');
  requireField(state, 'failures', 'array', 'state');

  // Integrity: recompute the digest over the canonical payload and compare.
  if ('digest' in obj) {
    if (typeof obj.digest !== 'string') throw new SaveError('digest must be a string');
    const expected = digestOf({
      version: obj.version,
      origin: obj.origin === undefined ? null : obj.origin,
      state: obj.state,
      commands: obj.commands || [],
    });
    if (expected !== obj.digest) {
      throw new SaveError('integrity check failed \u2014 save data is corrupted or tampered');
    }
  }

  return obj;
}

/** Parse + validate a save string (or already-parsed object). */
export function deserialize(textOrObj) {
  let obj;
  if (typeof textOrObj === 'string') {
    try {
      obj = JSON.parse(textOrObj);
    } catch (e) {
      throw new SaveError('malformed JSON: ' + (e && e.message ? e.message : e));
    }
  } else {
    obj = textOrObj;
  }
  return validateSave(obj);
}

/**
 * Load a save (string or object) into a fresh Engine. Throws SaveError on any
 * validation failure - callers get a clean error, never an uncaught crash.
 * @returns {Engine}
 */
export function loadEngine(textOrObj) {
  const obj = deserialize(textOrObj);
  return Engine.fromSnapshot(obj.state, obj.commands || []);
}

/**
 * Load a save and also return the recorded origin config (used by the UI so a
 * loaded session can still export a replay from tick 0).
 * @returns {{engine: Engine, origin: (object|null)}}
 */
export function loadSave(textOrObj) {
  const obj = deserialize(textOrObj);
  return {
    engine: Engine.fromSnapshot(obj.state, obj.commands || []),
    origin: obj.origin || null,
  };
}

/**
 * Non-throwing convenience wrapper for UIs: returns a discriminated result so
 * corrupted / incompatible data can be surfaced without try/catch at the call
 * site.
 * @returns {{ok:true, engine:Engine, origin:(object|null)} | {ok:false, error:string}}
 */
export function tryLoad(textOrObj) {
  try {
    const { engine, origin } = loadSave(textOrObj);
    return { ok: true, engine, origin };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}
