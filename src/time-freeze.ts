import {SystemClock, type FeelClock, type ScheduledCall} from './clock.js';
import type {Feedback, FeedbackResult, FeelContext} from './runtime.js';
import {defineFeedbackSchema, field, type InferSchema} from './schema.js';
import type {TimeDomainLease} from './time-domain.js';

/** Parameter schema for {@link TimeFreezeFeedback}. */
export const timeFreezeSchema = defineFeedbackSchema('time.freeze', {
  duration: field.number({default: 80, min: 0, unit: 'milliseconds'}),
  domain: field.string({default: 'scene', minLength: 1, pattern: '^[a-z][a-z0-9.-]*$'}),
});

/** Parameters accepted by time.freeze. */
export type TimeFreezeParams = InferSchema<typeof timeFreezeSchema.shape>;

interface ActiveFreeze {
  readonly lease: TimeDomainLease;
  finish(status: 'completed' | 'stopped'): void;
}

/** Temporarily pauses a TimeDomain and restores it using real time. */
export class TimeFreezeFeedback implements Feedback {
  readonly type = 'time.freeze';
  #active = new WeakMap<AbortSignal, ActiveFreeze>();

  constructor(
    readonly params: TimeFreezeParams = timeFreezeSchema.defaults(),
    private readonly clock: FeelClock = new SystemClock(),
  ) {}

  play(context: FeelContext, signal: AbortSignal): Promise<FeedbackResult> {
    const domain = context.timeDomains?.get(this.params.domain);
    if (!domain) return Promise.resolve({status: 'skipped', reason: 'unsupported'});
    if (signal.aborted) return Promise.resolve({status: 'stopped'});
    if (this.params.duration === 0) return Promise.resolve({status: 'completed'});
    return new Promise(resolve => {
      const lease = domain.acquire({paused: true});
      let settled = false;
      let call: ScheduledCall | undefined;
      const finish = (status: 'completed' | 'stopped'): void => {
        if (settled) return;
        settled = true;
        call?.cancel();
        lease.release();
        signal.removeEventListener('abort', stop);
        this.#active.delete(signal);
        resolve({status});
      };
      const stop = (): void => finish('stopped');
      call = this.clock.schedule(this.params.duration, () => finish('completed'));
      if (settled) call.cancel();
      else {
        this.#active.set(signal, Object.freeze({lease, finish}));
        signal.addEventListener('abort', stop, {once: true});
      }
    });
  }

  skipToEnd(_context: FeelContext, signal: AbortSignal): void {
    this.#active.get(signal)?.finish('completed');
  }
}
