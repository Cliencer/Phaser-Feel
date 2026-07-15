import {SeededRandom, SystemClock, type FeelClock, type RandomSource} from './clock.js';
import {SchedulerControl} from './scheduler.js';
import {TargetResolverRegistry, type TargetSelector} from './target-resolver.js';
import type {TimeDomainRegistry, TimeDomainState} from './time-domain.js';

/** The observable lifecycle state of a {@link FeelHandle}. */
export type FeelHandleState = 'pending' | 'playing' | 'paused' | 'completed' | 'stopped' | 'failed';

/** Runtime services used by Phaser-specific feedbacks. */
export interface RuntimeAdapter {
  readonly phaserVersion: string;
  readonly reducedMotion?: boolean;
  cameraShake(request: CameraShakeRequest, signal: AbortSignal): Promise<'completed' | 'unsupported' | 'missing-target'>;
  emitEvent(request: EventEmitRequest): 'completed' | 'unsupported' | 'missing-target';
  resolveTarget(selector: Exclude<TargetSelector, {readonly kind: 'context'} | {readonly kind: 'resolver'}>, context: Readonly<FeelContext>): unknown | readonly unknown[] | undefined;
  createTween(request: NumericTweenRequest): TweenController | undefined;
  syncTimeDomain(request: TimeDomainSyncRequest): 'completed' | 'unsupported';
}

/** Request used to synchronize one domain with Phaser subsystems. */
export interface TimeDomainSyncRequest {
  readonly scene?: unknown;
  readonly state: Readonly<TimeDomainState>;
}

/** Runtime-neutral request for a Phaser-backed number tween. */
export interface NumericTweenRequest {
  readonly scene?: unknown;
  readonly from: number;
  readonly to: number;
  readonly duration: number;
  readonly ease: string;
  readonly onUpdate: (value: number) => void;
}

/** Unified lifecycle controller returned by a RuntimeAdapter tween. */
export interface TweenController {
  readonly completion: Promise<'completed' | 'stopped'>;
  pause(): void;
  resume(): void;
  stop(): void;
  skipToEnd(): void;
}

/** Adapter request for a Phaser 4 camera shake. */
export interface CameraShakeRequest {
  readonly target?: unknown;
  readonly duration: number;
  readonly intensity: number;
  readonly force: boolean;
}

/** Adapter request for emitting an event. */
export interface EventEmitRequest {
  readonly target?: unknown;
  readonly event: string;
  readonly data?: unknown;
}

/** Values shared with every feedback played by a {@link FeelPlayer}. */
export interface FeelContext<TData = unknown> {
  readonly scene?: unknown;
  readonly source?: unknown;
  readonly target?: unknown;
  readonly targets?: readonly unknown[];
  readonly position?: Readonly<{x: number; y: number}>;
  readonly intensity: number;
  readonly data?: TData;
  readonly direction: 1 | -1;
  readonly random: RandomSource;
  readonly runtime?: RuntimeAdapter;
  readonly timeDomains?: TimeDomainRegistry;
}

/** Result returned by one feedback. */
export type FeedbackResult =
  | {readonly status: 'completed'}
  | {readonly status: 'stopped'}
  | {readonly status: 'skipped'; readonly reason: 'unsupported' | 'missing-target' | 'disabled' | 'chance' | 'reduced-motion'};

/** Executable unit in a Phaser-Feel composition. */
export interface Feedback<TContext extends FeelContext = FeelContext> {
  readonly type: string;
  play(context: TContext, signal: AbortSignal): Promise<FeedbackResult>;
  pause?(signal: AbortSignal): void;
  resume?(signal: AbortSignal): void;
  skipToEnd?(context: TContext, signal: AbortSignal): void | Promise<void>;
}

/** One feedback positioned on the Player timeline. */
export interface FeelPlayerEntry<TData = unknown> {
  readonly feedback: Feedback<FeelContext<TData>>;
  readonly at?: number;
  readonly hold?: boolean;
  readonly enabled?: boolean;
  readonly chance?: number;
  readonly intensity?: number;
  readonly target?: TargetSelector;
}

/** Construction options for a {@link FeelPlayer}. */
export interface FeelPlayerOptions {
  readonly id?: string;
  readonly clock?: FeelClock;
  readonly direction?: 1 | -1;
  readonly loop?: number;
  readonly targetResolvers?: TargetResolverRegistry;
}

/** Per-run options for {@link FeelPlayer.play}. */
export interface PlayOptions {
  readonly seed?: number;
  readonly random?: RandomSource;
  readonly direction?: 1 | -1;
  readonly intensity?: number;
}

/** Aggregate result of a player run. */
export interface FeelResult {
  readonly status: 'completed' | 'stopped' | 'failed';
  readonly feedbacks: readonly FeedbackResult[];
  readonly error?: unknown;
}

/** Lifecycle event names emitted by a {@link FeelPlayer}. */
export type FeelLifecycleEventType =
  | 'playstart' | 'pausestart' | 'pauseend' | 'directionchange'
  | 'feedbackstart' | 'feedbackcomplete' | 'feedbackskip' | 'feedbackerror'
  | 'complete' | 'stop' | 'dispose';

/** Structured observation emitted during playback. */
export interface FeelLifecycleEvent<TData = unknown> {
  readonly type: FeelLifecycleEventType;
  readonly player: FeelPlayer<TData>;
  readonly handle: FeelHandle<TData>;
  readonly context: Readonly<FeelContext<TData>>;
  readonly time: number;
  readonly feedback?: Feedback<FeelContext<TData>>;
  readonly result?: FeedbackResult;
  readonly error?: unknown;
}

/** Receives all lifecycle events for one Player. */
export type FeelLifecycleListener<TData = unknown> = (event: FeelLifecycleEvent<TData>) => void;

let nextPlayerId = 1;
let nextHandleId = 1;
const playerStackKey = Symbol('phaser-feel-player-stack');

/**
 * A cancellable, awaitable reference to one playback run.
 *
 * Pause, resume, stop and skip operations are idempotent.
 */
export class FeelHandle<TData = unknown> implements PromiseLike<FeelResult> {
  readonly id = `feel-handle-${nextHandleId++}`;
  readonly completion: Promise<FeelResult>;
  readonly startedAt: number;
  #state: FeelHandleState = 'pending';
  #intensity: number;
  #direction: 1 | -1;
  #baseContext: Readonly<FeelContext<TData>>;
  #resolve!: (result: FeelResult) => void;

  constructor(
    readonly player: FeelPlayer<TData>,
    context: Readonly<FeelContext<TData>>,
    readonly control: SchedulerControl,
  ) {
    this.#intensity = context.intensity;
    this.#direction = context.direction;
    this.#baseContext = context;
    this.startedAt = control.clock.now();
    this.completion = new Promise(resolve => { this.#resolve = resolve; });
  }

  get state(): FeelHandleState { return this.#state; }
  get intensity(): number { return this.#intensity; }
  get direction(): 1 | -1 { return this.#direction; }
  get context(): Readonly<FeelContext<TData>> {
    return Object.freeze({...this.#baseContext, intensity: this.#intensity, direction: this.#direction});
  }

  /** Pauses scheduler time and pause-aware active feedbacks. */
  pause(): void {
    if (this.#state !== 'pending' && this.#state !== 'playing') return;
    this.control.pause();
    this.#state = 'paused';
    this.player.notifyHandleEvent('pausestart', this);
  }

  /** Resumes a paused run. */
  resume(): void {
    if (this.#state !== 'paused') return;
    this.control.resume();
    this.#state = 'playing';
    this.player.notifyHandleEvent('pauseend', this);
  }

  /** Requests cancellation of the run and all currently active feedback. */
  stop(): void {
    if (isTerminal(this.#state)) return;
    this.control.stop();
    this.#state = 'stopped';
    this.player.notifyHandleEvent('stop', this);
  }

  /** Skips pending time and asks feedbacks to apply their final state. */
  skipToEnd(): void {
    if (isTerminal(this.#state)) return;
    this.control.skipToEnd();
  }

  /** Changes the intensity multiplier for feedbacks that have not started yet. */
  setIntensity(value: number): void {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Handle intensity must be a finite number >= 0');
    this.#intensity = value;
  }

  /** @internal */
  setDirection(direction: 1 | -1): void { this.#direction = direction; }

  /** @internal */
  start(): void { if (this.#state === 'pending') this.#state = 'playing'; }

  /** @internal */
  settle(result: FeelResult): void {
    if (result.status === 'completed') this.#state = 'completed';
    else if (result.status === 'failed') this.#state = 'failed';
    else this.#state = 'stopped';
    this.#resolve(result);
  }

  then<TResult1 = FeelResult, TResult2 = never>(
    onfulfilled?: ((value: FeelResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.completion.then(onfulfilled, onrejected);
  }
}

/** Plays an immutable deterministic feedback timeline. */
export class FeelPlayer<TData = unknown> {
  readonly id: string;
  readonly entries: readonly FeelPlayerEntry<TData>[];
  readonly clock: FeelClock;
  readonly activeHandles = new Set<FeelHandle<TData>>();
  #direction: 1 | -1;
  #loop: number;
  #listeners = new Set<FeelLifecycleListener<TData>>();
  #disposed = false;
  readonly #targetResolvers: TargetResolverRegistry;

  constructor(
    feedbacks: readonly (Feedback<FeelContext<TData>> | FeelPlayerEntry<TData>)[],
    options: FeelPlayerOptions = {},
  ) {
    this.id = options.id ?? `feel-player-${nextPlayerId++}`;
    this.clock = options.clock ?? new SystemClock();
    this.#direction = options.direction ?? 1;
    this.#loop = validateLoop(options.loop ?? 1);
    this.#targetResolvers = options.targetResolvers ?? new TargetResolverRegistry();
    this.entries = Object.freeze(feedbacks.map(item => Object.freeze(
      isPlayerEntry(item) ? {...item} : {feedback: item, hold: true},
    )));
  }

  /** Backwards-compatible view of feedbacks in timeline order. */
  get feedbacks(): readonly Feedback<FeelContext<TData>>[] { return this.entries.map(entry => entry.feedback); }
  get direction(): 1 | -1 { return this.#direction; }

  /** Starts a new independent run. */
  play(
    context: Partial<Omit<FeelContext<TData>, 'direction' | 'random'>> = {},
    options: PlayOptions = {},
  ): FeelHandle<TData> {
    if (this.#disposed) throw new Error(`FeelPlayer "${this.id}" is disposed`);
    const stack = (context as {[playerStackKey]?: readonly object[]})[playerStackKey] ?? [];
    if (stack.includes(this)) throw new Error(`Child Player cycle detected at "${this.id}"`);
    const direction = options.direction ?? this.#direction;
    const normalized: FeelContext<TData> = {
      ...context,
      intensity: options.intensity ?? context.intensity ?? 1,
      direction,
      random: options.random ?? new SeededRandom(options.seed ?? 0),
    };
    Object.defineProperty(normalized, playerStackKey, {value: Object.freeze([...stack, this]), enumerable: true});
    const control = new SchedulerControl(this.clock);
    const handle = new FeelHandle(this, Object.freeze(normalized), control);
    this.activeHandles.add(handle);
    void Promise.resolve().then(() => this.run(handle));
    return handle;
  }

  /** Subscribes to structured lifecycle events. */
  on(listener: FeelLifecycleListener<TData>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Changes direction for active and future runs. Active runs switch on their next loop pass. */
  setDirection(direction: 1 | -1): void {
    if (direction !== 1 && direction !== -1) throw new RangeError('Direction must be 1 or -1');
    if (this.#direction === direction) return;
    this.#direction = direction;
    for (const handle of this.activeHandles) {
      handle.setDirection(direction);
      this.emit({type: 'directionchange', handle});
    }
  }

  /** Changes the finite loop count for future runs. */
  setLoop(loop: number): void { this.#loop = validateLoop(loop); }
  pause(): void { for (const handle of this.activeHandles) handle.pause(); }
  resume(): void { for (const handle of this.activeHandles) handle.resume(); }
  stop(): void { for (const handle of this.activeHandles) handle.stop(); }

  /** Stops active runs and permanently closes this Player. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const handle of [...this.activeHandles]) {
      handle.stop();
      this.emit({type: 'dispose', handle});
    }
    this.#listeners.clear();
  }

  /** @internal */
  notifyHandleEvent(type: 'pausestart' | 'pauseend' | 'stop', handle: FeelHandle<TData>): void {
    this.emit({type, handle});
  }

  private async run(handle: FeelHandle<TData>): Promise<void> {
    if (handle.control.signal.aborted) {
      handle.settle({status: 'stopped', feedbacks: []});
      this.activeHandles.delete(handle);
      return;
    }
    handle.start();
    this.emit({type: 'playstart', handle});
    const results: FeedbackResult[] = [];
    const active = new Set<Feedback<FeelContext<TData>>>();
    const removePauseListener = handle.control.onPauseChange(paused => {
      for (const feedback of active) (paused ? feedback.pause : feedback.resume)?.call(feedback, handle.control.signal);
    });
    const removeSkipListener = handle.control.onSkipToEnd(() => {
      for (const feedback of active) void feedback.skipToEnd?.(handle.context, handle.control.signal);
    });
    try {
      for (let pass = 0; pass < this.#loop && !handle.control.signal.aborted; pass += 1) {
        await this.runPass(handle, results, active);
      }
      if (handle.control.signal.aborted) {
        handle.settle({status: 'stopped', feedbacks: results});
      } else {
        handle.settle({status: 'completed', feedbacks: results});
        this.emit({type: 'complete', handle});
      }
    } catch (error) {
      if (handle.control.signal.aborted) handle.settle({status: 'stopped', feedbacks: results});
      else handle.settle({status: 'failed', feedbacks: results, error});
    } finally {
      removePauseListener();
      removeSkipListener();
      this.activeHandles.delete(handle);
    }
  }

  private async runPass(
    handle: FeelHandle<TData>,
    results: FeedbackResult[],
    active: Set<Feedback<FeelContext<TData>>>,
  ): Promise<void> {
    const entries = handle.context.direction === 1 ? this.entries : [...this.entries].reverse();
    const passStart = this.clock.now();
    let parallel: Promise<void>[] = [];
    for (const entry of entries) {
      if (entry.hold !== false) {
        await Promise.all(parallel);
        parallel = [];
        await this.runEntryAt(entry, passStart, handle, results, active);
      } else {
        parallel.push(this.runEntryAt(entry, passStart, handle, results, active));
      }
      if (handle.control.signal.aborted) break;
    }
    await Promise.all(parallel);
  }

  private async runEntryAt(
    entry: FeelPlayerEntry<TData>,
    passStart: number,
    handle: FeelHandle<TData>,
    results: FeedbackResult[],
    active: Set<Feedback<FeelContext<TData>>>,
  ): Promise<void> {
    const delay = Math.max(0, passStart + (entry.at ?? 0) - this.clock.now());
    if (!await handle.control.wait(delay)) return;
    const result = await this.runFeedback(entry, handle, active);
    results.push(result);
  }

  private async runFeedback(
    entry: FeelPlayerEntry<TData>,
    handle: FeelHandle<TData>,
    active: Set<Feedback<FeelContext<TData>>>,
  ): Promise<FeedbackResult> {
    const feedback = entry.feedback;
    if (entry.enabled === false) return this.skip(feedback, handle, 'disabled');
    const chance = entry.chance ?? 1;
    if (!Number.isFinite(chance) || chance < 0 || chance > 1) throw new RangeError(`${feedback.type} chance must be between 0 and 1`);
    if (handle.context.random.next() >= chance) return this.skip(feedback, handle, 'chance');
    const resolvedTarget = this.#targetResolvers.resolve(entry.target, handle.context);
    const context: FeelContext<TData> = Object.freeze({
      ...handle.context,
      ...(entry.target === undefined ? {} : {target: Array.isArray(resolvedTarget) ? resolvedTarget[0] : resolvedTarget}),
      ...(Array.isArray(resolvedTarget) ? {targets: resolvedTarget} : {}),
      intensity: handle.intensity * (entry.intensity ?? 1),
    });
    if (handle.control.skippingToEnd) {
      if (!feedback.skipToEnd) return this.skip(feedback, handle, 'unsupported');
      await feedback.skipToEnd(context, handle.control.signal);
      const result = {status: 'completed'} as const;
      this.emit({type: 'feedbackcomplete', handle, feedback, result});
      return result;
    }
    this.emit({type: 'feedbackstart', handle, feedback});
    active.add(feedback);
    try {
      const result = await feedback.play(context, handle.control.signal);
      this.emit({type: result.status === 'skipped' ? 'feedbackskip' : 'feedbackcomplete', handle, feedback, result});
      return result;
    } catch (error) {
      this.emit({type: 'feedbackerror', handle, feedback, error});
      throw error;
    } finally {
      active.delete(feedback);
    }
  }

  private skip(
    feedback: Feedback<FeelContext<TData>>,
    handle: FeelHandle<TData>,
    reason: 'unsupported' | 'disabled' | 'chance',
  ): FeedbackResult {
    const result = {status: 'skipped', reason} as const;
    this.emit({type: 'feedbackskip', handle, feedback, result});
    return result;
  }

  private emit(input: {
    type: FeelLifecycleEventType;
    handle: FeelHandle<TData>;
    feedback?: Feedback<FeelContext<TData>>;
    result?: FeedbackResult;
    error?: unknown;
  }): void {
    const event: FeelLifecycleEvent<TData> = Object.freeze({
      ...input,
      player: this,
      context: input.handle.context,
      time: this.clock.now(),
    });
    for (const listener of this.#listeners) listener(event);
  }
}

function isTerminal(state: FeelHandleState): boolean {
  return state === 'completed' || state === 'stopped' || state === 'failed';
}

function isPlayerEntry<TData>(
  value: Feedback<FeelContext<TData>> | FeelPlayerEntry<TData>,
): value is FeelPlayerEntry<TData> {
  return 'feedback' in value;
}

function validateLoop(loop: number): number {
  if (!Number.isInteger(loop) || loop < 1) throw new RangeError('Player loop must be a positive integer');
  return loop;
}
