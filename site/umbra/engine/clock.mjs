// SIGNAL ZERO - deterministic clock + accumulator loop
//
// The simulation advances ONLY in fixed 100 ms integer ticks. Real elapsed
// wall time is accumulated; each whole 100 ms of (real time * speed) releases
// exactly one tick. Speed multipliers (1x/2x/4x/8x) release N whole ticks per
// real interval - they NEVER scale the tick duration. Therefore the same
// number of ticks (with the same commands) yields identical state regardless
// of speed or render frame rate.

export const TICK_MS = 100;
export const ALLOWED_SPEEDS = [0, 1, 2, 4, 8]; // 0 = paused

export class SimClock {
  constructor() {
    this._accumMs = 0;   // accumulated (real * speed) milliseconds, integer
    this._maxCatchUp = 200; // cap ticks per pump to avoid runaway on stalls
  }

  reset() { this._accumMs = 0; }

  /**
   * Feed real elapsed wall-clock milliseconds and the current speed. Returns
   * the number of whole 100 ms ticks that should be executed now. The engine
   * runs exactly that many discrete steps; leftover sub-tick time is retained.
   *
   * @param {number} realMs - real elapsed ms since last pump (>=0)
   * @param {number} speed  - 0 (paused) | 1 | 2 | 4 | 8
   * @returns {number} whole ticks to run
   */
  pump(realMs, speed) {
    if (speed <= 0 || realMs <= 0) return 0;
    // Integer-only accumulation: we scale real time by the integer speed.
    this._accumMs += Math.floor(realMs) * (speed | 0);
    let ticks = Math.floor(this._accumMs / TICK_MS);
    this._accumMs -= ticks * TICK_MS;
    if (ticks > this._maxCatchUp) {
      // Drop excess to preserve responsiveness; determinism is defined by the
      // number of ticks actually stepped + commands, which the engine records.
      ticks = this._maxCatchUp;
      this._accumMs = 0;
    }
    return ticks;
  }
}

/** Format a tick count as MM:SS.d simulation time (used by UI + event log). */
export function formatSimTime(tick) {
  const totalMs = tick * TICK_MS;
  const totalDeci = Math.floor(totalMs / 100); // tenths of a second
  const tenths = totalDeci % 10;
  const totalSec = Math.floor(totalDeci / 10);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60);
  const mm = String(min).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return `${mm}:${ss}.${tenths}`;
}
