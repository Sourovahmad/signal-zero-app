// SIGNAL ZERO - deterministic seeded RNG (spec: single seeded RNG source)
//
// Pure integer arithmetic on 32-bit words. This is the ONLY source of
// randomness in the engine. State is fully captured by getState/setState,
// so save/load and replay reproduce identical sequences.
//
// Algorithm: SplitMix32 seeding -> Mulberry32 stream. Deterministic across
// platforms because every operation is masked to 32 bits with >>> 0.

const MASK32 = 0xffffffff;

function toU32(n) {
  // Coerce any integer-ish value into an unsigned 32-bit word.
  return (n >>> 0);
}

export class DeterministicRng {
  /**
   * @param {number} seed - integer seed (any 32-bit range value).
   */
  constructor(seed = 0) {
    this._state = toU32(seed);
  }

  /** Serialise the full generator state (plain integer). */
  getState() {
    return this._state;
  }

  /** Restore a previously serialised state. */
  setState(state) {
    this._state = toU32(state);
    return this;
  }

  /** Return an independent copy at the current position. */
  clone() {
    return new DeterministicRng(0).setState(this._state);
  }

  /** Advance the stream and return an unsigned 32-bit integer. */
  nextU32() {
    // Mulberry32.
    let z = (this._state = (this._state + 0x6d2b79f5) >>> 0);
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return (z ^ (z >>> 14)) >>> 0;
  }

  /**
   * Uniform integer in [min, max] inclusive. Deterministic and unbiased
   * enough for simulation seeding (rejection sampling).
   * @param {number} min
   * @param {number} max
   */
  nextInt(min, max) {
    min = min | 0;
    max = max | 0;
    if (max < min) {
      const t = min; min = max; max = t;
    }
    const range = (max - min + 1) >>> 0;
    if (range === 0) {
      // Full 32-bit span requested.
      return (min + this.nextU32()) | 0;
    }
    // Rejection sampling to remove modulo bias.
    const limit = (MASK32 - (MASK32 % range)) >>> 0;
    let r;
    do {
      r = this.nextU32();
    } while (r > limit);
    return min + (r % range);
  }

  /** Deterministic boolean with 1-in-n odds of being true. */
  chance(n) {
    if (n <= 1) return true;
    return this.nextInt(0, n - 1) === 0;
  }

  /** Pick a deterministic element from a non-empty array. */
  pick(arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[this.nextInt(0, arr.length - 1)];
  }
}

export function makeRng(seed) {
  return new DeterministicRng(seed);
}
