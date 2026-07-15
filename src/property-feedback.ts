import {
  PropertyOwnershipManager,
  type PropertyAdapterRegistry,
  type PropertyLease,
  type RestoreMode,
  createDefaultPropertyAdapterRegistry,
} from './property-adapter.js';
import type {Feedback, FeedbackResult, FeelContext, TweenController} from './runtime.js';
import {defineFeedbackSchema, field, type InferSchema} from './schema.js';

const restoreModes = ['never', 'onComplete', 'onStop', 'always'] as const;
const transformProperties = ['x', 'y', 'scaleX', 'scaleY', 'rotation'] as const;

/** Parameter schema for {@link ObjectPropertyFeedback}. */
export const objectPropertySchema = defineFeedbackSchema('object.property', {
  property: field.string({default: 'alpha', minLength: 1}),
  value: field.number({default: 1}),
  duration: field.number({default: 200, min: 0, unit: 'milliseconds'}),
  ease: field.string({default: 'Sine.easeOut', minLength: 1}),
  relative: field.boolean({default: false}),
  restore: field.string({default: 'never', enum: restoreModes}),
});

/** Parameter schema for {@link UiTransformFeedback}. */
export const uiTransformSchema = defineFeedbackSchema('ui.transform', {
  property: field.string({default: 'x', enum: transformProperties}),
  value: field.number({default: 0}),
  duration: field.number({default: 200, min: 0, unit: 'milliseconds'}),
  ease: field.string({default: 'Sine.easeOut', minLength: 1}),
  relative: field.boolean({default: false}),
  restore: field.string({default: 'never', enum: restoreModes}),
});

/** Parameters accepted by object.property. */
export type ObjectPropertyParams = InferSchema<typeof objectPropertySchema.shape>;
/** Parameters accepted by ui.transform. */
export type UiTransformParams = InferSchema<typeof uiTransformSchema.shape>;

interface NumericPropertyParams {
  readonly property: string;
  readonly value: number;
  readonly duration: number;
  readonly ease: string;
  readonly relative: boolean;
  readonly restore: string;
}

interface ActiveTween {
  readonly controller: TweenController;
  readonly lease: PropertyLease;
}

const defaultAdapters = createDefaultPropertyAdapterRegistry();
const defaultOwnership = new PropertyOwnershipManager();

abstract class NumericPropertyFeedback implements Feedback {
  abstract readonly type: string;
  #active = new WeakMap<AbortSignal, ActiveTween>();

  protected constructor(
    protected readonly params: NumericPropertyParams,
    private readonly adapters: PropertyAdapterRegistry,
    private readonly ownership: PropertyOwnershipManager,
    private readonly allowedProperties?: readonly string[],
  ) {}

  async play(context: FeelContext, signal: AbortSignal): Promise<FeedbackResult> {
    const prepared = this.prepare(context);
    if (!prepared) return {status: 'skipped', reason: 'missing-target'};
    if (signal.aborted) return {status: 'stopped'};
    const duration = context.runtime?.reducedMotion ? 0 : this.params.duration;
    if (duration === 0) {
      prepared.lease.write(prepared.to);
      prepared.lease.release(shouldRestore(this.restoreMode(), 'completed'));
      return {status: 'completed'};
    }
    const controller = context.runtime?.createTween({
      scene: context.scene,
      from: prepared.from,
      to: prepared.to,
      duration,
      ease: this.params.ease,
      onUpdate: value => prepared.lease.write(value),
    });
    if (!controller) {
      prepared.lease.release(false);
      return {status: 'skipped', reason: 'unsupported'};
    }
    const active = {controller, lease: prepared.lease};
    this.#active.set(signal, active);
    const stop = (): void => controller.stop();
    let destroyed = false;
    const removeDestroyListener = bindDestroy(context.target, () => {
      destroyed = true;
      controller.stop();
    });
    signal.addEventListener('abort', stop, {once: true});
    try {
      const status = await controller.completion;
      prepared.lease.release(!destroyed && shouldRestore(this.restoreMode(), status));
      return {status};
    } finally {
      signal.removeEventListener('abort', stop);
      removeDestroyListener();
      this.#active.delete(signal);
    }
  }

  pause(signal: AbortSignal): void { this.#active.get(signal)?.controller.pause(); }
  resume(signal: AbortSignal): void { this.#active.get(signal)?.controller.resume(); }

  skipToEnd(context: FeelContext, signal: AbortSignal): void {
    const active = this.#active.get(signal);
    if (active) {
      active.controller.skipToEnd();
      return;
    }
    const prepared = this.prepare(context);
    if (!prepared) return;
    prepared.lease.write(prepared.to);
    prepared.lease.release(shouldRestore(this.restoreMode(), 'completed'));
  }

  private prepare(context: FeelContext): {from: number; to: number; lease: PropertyLease} | undefined {
    if (!isObject(context.target)) return undefined;
    if (this.allowedProperties && !this.allowedProperties.includes(this.params.property)) return undefined;
    const adapter = this.adapters.find(context.target, this.params.property);
    const descriptor = adapter?.descriptors.find(candidate => candidate.property === this.params.property);
    if (!adapter || descriptor?.kind !== 'number' || !descriptor.interpolable) return undefined;
    const from = adapter.read(context.target, this.params.property);
    if (typeof from !== 'number' || !Number.isFinite(from)) return undefined;
    const intensity = context.intensity;
    const to = this.params.relative
      ? from + this.params.value * intensity
      : from + (this.params.value - from) * intensity;
    return {from, to, lease: this.ownership.acquire(context.target, this.params.property, adapter)};
  }

  private restoreMode(): RestoreMode {
    return isRestoreMode(this.params.restore) ? this.params.restore : 'never';
  }
}

/** Tweens one explicitly whitelisted numeric property. */
export class ObjectPropertyFeedback extends NumericPropertyFeedback {
  readonly type = 'object.property';

  constructor(
    params: ObjectPropertyParams = objectPropertySchema.defaults(),
    adapters: PropertyAdapterRegistry = defaultAdapters,
    ownership: PropertyOwnershipManager = defaultOwnership,
  ) { super(params, adapters, ownership); }
}

/** Tweens one audited 2D transform property. */
export class UiTransformFeedback extends NumericPropertyFeedback {
  readonly type = 'ui.transform';

  constructor(
    params: UiTransformParams = uiTransformSchema.defaults(),
    adapters: PropertyAdapterRegistry = defaultAdapters,
    ownership: PropertyOwnershipManager = defaultOwnership,
  ) { super(params, adapters, ownership, transformProperties); }
}

function shouldRestore(mode: RestoreMode, status: 'completed' | 'stopped'): boolean {
  return mode === 'always' || mode === (status === 'completed' ? 'onComplete' : 'onStop');
}

function isRestoreMode(value: string): value is RestoreMode {
  return value === 'never' || value === 'onComplete' || value === 'onStop' || value === 'always';
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function bindDestroy(target: unknown, listener: () => void): () => void {
  if (!isDestroyEmitter(target)) return () => undefined;
  target.once('destroy', listener);
  return () => target.off?.('destroy', listener);
}

function isDestroyEmitter(value: unknown): value is {
  once(event: 'destroy', listener: () => void): unknown;
  off?(event: 'destroy', listener: () => void): unknown;
} {
  return typeof value === 'object' && value !== null && 'once' in value && typeof value.once === 'function';
}
