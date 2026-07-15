import {SystemClock, type FeelClock, type ScheduledCall} from './clock.js';
import type {Feedback, FeedbackResult, FeelContext} from './runtime.js';
import {defineFeedbackSchema, field, type InferSchema} from './schema.js';
import type {TimeDomainLease} from './time-domain.js';

const domainNamePattern = '^[a-z][a-z0-9.-]*$';

/** Parameter schema for {@link TimeScaleFeedback}. */
export const timeScaleSchema = defineFeedbackSchema('time.scale', {
  scale: field.number({default: 0.5, min: 0, unit: 'ratio'}),
  duration: field.number({default: 250, min: 0, unit: 'milliseconds'}),
  domain: field.string({default: 'scene', minLength: 1, pattern: domainNamePattern}),
});

/** Parameters accepted by time.scale. */
export type TimeScaleParams = InferSchema<typeof timeScaleSchema.shape>;

/** Parameter schema for {@link TimeHitStopFeedback}. */
export const timeHitStopSchema = defineFeedbackSchema('time.hitStop', {
  duration: field.number({default: 80, min: 0, unit: 'milliseconds'}),
  scale: field.number({default: 0, min: 0, max: 1, unit: 'ratio'}),
  domain: field.string({default: 'scene', minLength: 1, pattern: domainNamePattern}),
});

/** Parameters accepted by time.hitStop. */
export type TimeHitStopParams = InferSchema<typeof timeHitStopSchema.shape>;

interface ActiveModifier {
  readonly lease: TimeDomainLease;
  finish(status: 'completed' | 'stopped'): void;
}

/** Temporarily multiplies a TimeDomain scale and restores it using real time. */
export class TimeScaleFeedback implements Feedback {
  readonly type = 'time.scale';
  #active = new WeakMap<AbortSignal, ActiveModifier>();

  constructor(
    readonly params: TimeScaleParams = timeScaleSchema.defaults(),
    private readonly clock: FeelClock = new SystemClock(),
  ) {}

  play(context: FeelContext, signal: AbortSignal): Promise<FeedbackResult> {
    return playTimedModifier(context, signal, this.params.domain, this.params.duration, {scale: this.params.scale}, this.clock, this.#active);
  }

  skipToEnd(_context: FeelContext, signal: AbortSignal): void {
    this.#active.get(signal)?.finish('completed');
  }
}

/** Short impact-oriented freeze or slowdown that leaves other domains running. */
export class TimeHitStopFeedback implements Feedback {
  readonly type = 'time.hitStop';
  #active = new WeakMap<AbortSignal, ActiveModifier>();

  constructor(
    readonly params: TimeHitStopParams = timeHitStopSchema.defaults(),
    private readonly clock: FeelClock = new SystemClock(),
  ) {}

  play(context: FeelContext, signal: AbortSignal): Promise<FeedbackResult> {
    const modifier = this.params.scale === 0 ? {paused: true} : {scale: this.params.scale};
    return playTimedModifier(context, signal, this.params.domain, this.params.duration, modifier, this.clock, this.#active);
  }

  skipToEnd(_context: FeelContext, signal: AbortSignal): void {
    this.#active.get(signal)?.finish('completed');
  }
}

function playTimedModifier(
  context: FeelContext,
  signal: AbortSignal,
  domainName: string,
  duration: number,
  modifier: {readonly scale?: number; readonly paused?: boolean},
  clock: FeelClock,
  active: WeakMap<AbortSignal, ActiveModifier>,
): Promise<FeedbackResult> {
  const domain = context.timeDomains?.get(domainName);
  if (!domain) return Promise.resolve({status: 'skipped', reason: 'unsupported'});
  if (signal.aborted) return Promise.resolve({status: 'stopped'});
  if (duration === 0) return Promise.resolve({status: 'completed'});
  return new Promise(resolve => {
    const lease = domain.acquire(modifier);
    let settled = false;
    let call: ScheduledCall | undefined;
    const finish = (status: 'completed' | 'stopped'): void => {
      if (settled) return;
      settled = true;
      call?.cancel();
      lease.release();
      signal.removeEventListener('abort', stop);
      active.delete(signal);
      resolve({status});
    };
    const stop = (): void => finish('stopped');
    call = clock.schedule(duration, () => finish('completed'));
    if (settled) call.cancel();
    else {
      active.set(signal, Object.freeze({lease, finish}));
      signal.addEventListener('abort', stop, {once: true});
    }
  });
}
