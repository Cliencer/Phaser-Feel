/** A cancellable callback scheduled by a {@link FeelClock}. */
export interface ScheduledCall {
  cancel(): void;
}

/** Injectable monotonic time source used by the deterministic scheduler. */
export interface FeelClock {
  now(): number;
  schedule(delayMs: number, callback: () => void): ScheduledCall;
}

/** Default real-time clock for browser and Node.js runtimes. */
export class SystemClock implements FeelClock {
  now(): number { return globalThis.performance?.now() ?? Date.now(); }

  schedule(delayMs: number, callback: () => void): ScheduledCall {
    const timer = globalThis.setTimeout(callback, Math.max(0, delayMs));
    return {cancel: () => globalThis.clearTimeout(timer)};
  }
}

/** Deterministic pseudo-random number source. */
export interface RandomSource {
  next(): number;
}

/** Mulberry32 random source with reproducible output for a fixed seed. */
export class SeededRandom implements RandomSource {
  #state: number;

  constructor(seed: number) { this.#state = seed >>> 0; }

  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let value = this.#state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  }
}

