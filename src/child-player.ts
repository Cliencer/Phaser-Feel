import type {Feedback, FeedbackResult, FeelContext, FeelHandle, FeelPlayer} from './runtime.js';

/** Plays another immutable Player as one feedback node. */
export class ChildPlayerFeedback<TData = unknown> implements Feedback<FeelContext<TData>> {
  readonly type = 'player.child';
  #active = new Map<AbortSignal, FeelHandle<TData>>();

  constructor(readonly player: FeelPlayer<TData>) {}

  async play(context: FeelContext<TData>, signal: AbortSignal): Promise<FeedbackResult> {
    const handle = this.player.play(context, {
      random: context.random,
      direction: context.direction,
      intensity: context.intensity,
    });
    this.#active.set(signal, handle);
    const stop = () => handle.stop();
    signal.addEventListener('abort', stop, {once: true});
    try {
      const result = await handle.completion;
      if (result.status === 'failed') throw result.error;
      return result.status === 'stopped' ? {status: 'stopped'} : {status: 'completed'};
    } finally {
      signal.removeEventListener('abort', stop);
      this.#active.delete(signal);
    }
  }

  pause(signal: AbortSignal): void { this.#active.get(signal)?.pause(); }
  resume(signal: AbortSignal): void { this.#active.get(signal)?.resume(); }
  skipToEnd(_context: FeelContext<TData>, signal: AbortSignal): void { this.#active.get(signal)?.skipToEnd(); }
}
