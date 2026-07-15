import {defineFeedbackSchema, field, type InferSchema} from './schema.js';
import type {Feedback, FeedbackResult, FeelContext} from './runtime.js';

/** Runtime-validated parameter schema for `event.emit`. */
export const eventEmitSchema = defineFeedbackSchema('event.emit', {
  event: field.string({default: 'feel', minLength: 1}),
});

/** Parameters accepted by {@link EventEmitFeedback}. */
export type EventEmitParams = InferSchema<typeof eventEmitSchema.shape>;

/** Emits a named event through the active RuntimeAdapter. */
export class EventEmitFeedback implements Feedback {
  readonly type = eventEmitSchema.type;
  readonly params: EventEmitParams;

  constructor(params: Partial<EventEmitParams> = {}) { this.params = eventEmitSchema.parse(params); }

  async play(context: FeelContext): Promise<FeedbackResult> {
    if (!context.runtime) return {status: 'skipped', reason: 'unsupported'};
    const outcome = context.runtime.emitEvent({target: context.target, event: this.params.event, data: context.data});
    return outcome === 'completed' ? {status: 'completed'} : {status: 'skipped', reason: outcome};
  }
}

