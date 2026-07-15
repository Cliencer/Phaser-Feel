import {CameraShakeFeedback, cameraShakeSchema} from './camera-shake.js';
import {EventEmitFeedback, eventEmitSchema} from './event-emit.js';
import {ObjectPropertyFeedback, objectPropertySchema, UiTransformFeedback, uiTransformSchema} from './property-feedback.js';
import {FeelPlayer, type Feedback, type FeelContext, type FeelPlayerEntry, type FeelPlayerOptions} from './runtime.js';
import type {FeedbackSchema, InferSchema, SchemaShape} from './schema.js';
import {parseTargetSelector, type TargetSelector} from './target-resolver.js';
import {TimeFreezeFeedback, timeFreezeSchema} from './time-freeze.js';

/** Serializable boundary accepted by {@link FeedbackRegistry}. */
export interface FeedbackConfig {
  readonly type: string;
  readonly params?: unknown;
  readonly at?: number;
  readonly hold?: boolean;
  readonly enabled?: boolean;
  readonly chance?: number;
  readonly intensity?: number;
  readonly target?: TargetSelector;
}

/** Serializable Player definition. */
export interface FeelPlayerConfig {
  readonly id?: string;
  readonly direction?: 1 | -1;
  readonly loop?: number;
  readonly feedbacks: readonly FeedbackConfig[];
}

/** Factory registered for a stable feedback type. */
export type FeedbackFactory<TParams = unknown> = (params: TParams) => Feedback;

interface RegistryEntry {
  readonly factory: FeedbackFactory;
}

/** Strict registry that turns JSON-safe config into typed Feedback instances. */
export class FeedbackRegistry {
  #entries = new Map<string, RegistryEntry>();

  register<TType extends string, TShape extends SchemaShape>(
    schema: FeedbackSchema<TType, TShape>,
    factory: FeedbackFactory<InferSchema<TShape>>,
  ): () => void {
    if (this.#entries.has(schema.type)) throw new Error(`Feedback type "${schema.type}" is already registered`);
    const registration: RegistryEntry = {
      factory: params => factory(schema.parse(params)),
    };
    this.#entries.set(schema.type, registration);
    return () => {
      if (this.#entries.get(schema.type) === registration) this.#entries.delete(schema.type);
    };
  }

  create(config: FeedbackConfig): Feedback {
    assertKeys(config, ['type', 'params', 'at', 'hold', 'enabled', 'chance', 'intensity', 'target'], 'Feedback config');
    if (typeof config.type !== 'string' || config.type.length === 0) throw new TypeError('Feedback config.type must be a non-empty string');
    const entry = this.#entries.get(config.type);
    if (!entry) throw new Error(`Unknown feedback type "${config.type}"`);
    return entry.factory(config.params ?? {});
  }

  createPlayer(config: FeelPlayerConfig, options: Omit<FeelPlayerOptions, 'id' | 'direction' | 'loop'> = {}): FeelPlayer {
    assertKeys(config, ['id', 'direction', 'loop', 'feedbacks'], 'Player config');
    if (!Array.isArray(config.feedbacks)) throw new TypeError('Player config.feedbacks must be an array');
    const entries: FeelPlayerEntry[] = config.feedbacks.map(item => Object.freeze({
      feedback: this.create(item),
      ...(item.at === undefined ? {} : {at: finiteNonNegative(item.at, `${item.type}.at`)}),
      ...(item.hold === undefined ? {} : {hold: item.hold}),
      ...(item.enabled === undefined ? {} : {enabled: item.enabled}),
      ...(item.chance === undefined ? {} : {chance: item.chance}),
      ...(item.intensity === undefined ? {} : {intensity: finiteNonNegative(item.intensity, `${item.type}.intensity`)}),
      ...(item.target === undefined ? {} : {target: parseTargetSelector(item.target)}),
    }));
    return new FeelPlayer(entries, {...options, ...(config.id === undefined ? {} : {id: config.id}), ...(config.direction === undefined ? {} : {direction: config.direction}), ...(config.loop === undefined ? {} : {loop: config.loop})});
  }
}

/** Creates the registry shipped by the current package build. */
export function createDefaultFeedbackRegistry(): FeedbackRegistry {
  const registry = new FeedbackRegistry();
  registry.register(cameraShakeSchema, params => new CameraShakeFeedback(params));
  registry.register(eventEmitSchema, params => new EventEmitFeedback(params));
  registry.register(objectPropertySchema, params => new ObjectPropertyFeedback(params));
  registry.register(uiTransformSchema, params => new UiTransformFeedback(params));
  registry.register(timeFreezeSchema, params => new TimeFreezeFeedback(params));
  return registry;
}

function assertKeys(value: object, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`${label} has unknown field "${key}"`);
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be a finite number >= 0`);
  return value;
}
