import {defineFeedbackSchema, field, type InferSchema} from './schema.js';
import type {Feedback, FeedbackResult, FeelContext} from './runtime.js';

/** Runtime-validated parameter schema for the `camera.shake` feedback. */
export const cameraShakeSchema = defineFeedbackSchema('camera.shake', {
  duration: field.number({default: 120, min: 0, unit: 'milliseconds'}),
  intensity: field.number({default: 0.01, min: 0, max: 1, unit: 'ratio'}),
  force: field.boolean({default: false}),
});

/** Parameters accepted by {@link CameraShakeFeedback}. */
export type CameraShakeParams = InferSchema<typeof cameraShakeSchema.shape>;

/** A cancellable 2D camera shake feedback for Phaser 4 adapters. */
export class CameraShakeFeedback implements Feedback {
  readonly type = cameraShakeSchema.type;
  readonly params: CameraShakeParams;
  /** Creates a feedback and validates all supplied parameters immediately. */
  constructor(params: Partial<CameraShakeParams> = {}) { this.params = cameraShakeSchema.parse(params); }

  async play(context: FeelContext, signal: AbortSignal): Promise<FeedbackResult> {
    if (!context.runtime) return {status: 'skipped', reason: 'unsupported'};
    if (context.runtime.reducedMotion) return {status: 'skipped', reason: 'reduced-motion'};
    const outcome = await context.runtime.cameraShake({
      target: context.target,
      duration: this.params.duration,
      intensity: this.params.intensity * context.intensity,
      force: this.params.force,
    }, signal);
    if (outcome !== 'completed') return {status: 'skipped', reason: outcome};
    return signal.aborted ? {status: 'stopped'} : {status: 'completed'};
  }
}
