import type {FeelClock, ScheduledCall} from './clock.js';

/** Mutable playback controls shared by one scheduler run. */
export class SchedulerControl {
  readonly signal: AbortSignal;
  #controller = new AbortController();
  #paused = false;
  #skipToEnd = false;
  #waits = new Set<PausableWait>();
  #pauseListeners = new Set<(paused: boolean) => void>();
  #skipListeners = new Set<() => void>();

  constructor(readonly clock: FeelClock) { this.signal = this.#controller.signal; }

  get paused(): boolean { return this.#paused; }
  get skippingToEnd(): boolean { return this.#skipToEnd; }

  wait(delayMs: number): Promise<boolean> {
    if (this.signal.aborted || this.#skipToEnd) return Promise.resolve(!this.signal.aborted);
    if (delayMs <= 0 && !this.#paused) return Promise.resolve(true);
    return new Promise(resolve => {
      const wait = new PausableWait(this.clock, delayMs, completed => {
        this.#waits.delete(wait);
        resolve(completed && !this.signal.aborted);
      });
      this.#waits.add(wait);
      if (!this.#paused) wait.resume();
    });
  }

  pause(): void {
    if (this.#paused || this.signal.aborted) return;
    this.#paused = true;
    for (const wait of this.#waits) wait.pause();
    for (const listener of this.#pauseListeners) listener(true);
  }

  resume(): void {
    if (!this.#paused || this.signal.aborted) return;
    this.#paused = false;
    for (const wait of this.#waits) wait.resume();
    for (const listener of this.#pauseListeners) listener(false);
  }

  stop(): void {
    if (this.signal.aborted) return;
    this.#controller.abort();
    for (const wait of this.#waits) wait.cancel();
    this.#waits.clear();
  }

  skipToEnd(): void {
    if (this.#skipToEnd || this.signal.aborted) return;
    this.#skipToEnd = true;
    for (const wait of this.#waits) wait.finish();
    this.#waits.clear();
    for (const listener of this.#skipListeners) listener();
  }

  onPauseChange(listener: (paused: boolean) => void): () => void {
    this.#pauseListeners.add(listener);
    return () => this.#pauseListeners.delete(listener);
  }

  onSkipToEnd(listener: () => void): () => void {
    this.#skipListeners.add(listener);
    return () => this.#skipListeners.delete(listener);
  }
}

class PausableWait {
  #remaining: number;
  #startedAt = 0;
  #call: ScheduledCall | undefined;
  #settled = false;

  constructor(
    private readonly clock: FeelClock,
    delayMs: number,
    private readonly settle: (completed: boolean) => void,
  ) { this.#remaining = Math.max(0, delayMs); }

  pause(): void {
    if (!this.#call || this.#settled) return;
    this.#call.cancel();
    this.#call = undefined;
    this.#remaining = Math.max(0, this.#remaining - (this.clock.now() - this.#startedAt));
  }

  resume(): void {
    if (this.#call || this.#settled) return;
    this.#startedAt = this.clock.now();
    this.#call = this.clock.schedule(this.#remaining, () => this.finish());
  }

  finish(): void { this.#complete(true); }
  cancel(): void { this.#complete(false); }

  #complete(completed: boolean): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#call?.cancel();
    this.#call = undefined;
    this.settle(completed);
  }
}
