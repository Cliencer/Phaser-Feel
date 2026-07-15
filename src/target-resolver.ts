import type {FeelContext} from './runtime.js';

/** Serializable rule used to find a runtime target. */
export type TargetSelector =
  | {readonly kind: 'context'; readonly key?: 'target' | 'source'}
  | {readonly kind: 'name'; readonly name: string}
  | {readonly kind: 'tag'; readonly tag: string; readonly all?: boolean}
  | {readonly kind: 'camera'; readonly id?: number}
  | {readonly kind: 'scene'; readonly key?: string}
  | {readonly kind: 'resolver'; readonly key: string; readonly args?: unknown};

/** Function registered under a stable name for application-specific target lookup. */
export type NamedTargetResolver = (context: Readonly<FeelContext>, args: unknown) => unknown | readonly unknown[] | undefined;

/** Resolves built-in and named selectors without serializing object references. */
export class TargetResolverRegistry {
  #resolvers = new Map<string, NamedTargetResolver>();

  register(key: string, resolver: NamedTargetResolver): () => void {
    assertName(key, 'Resolver key');
    if (this.#resolvers.has(key)) throw new Error(`Target resolver "${key}" is already registered`);
    this.#resolvers.set(key, resolver);
    return () => {
      if (this.#resolvers.get(key) === resolver) this.#resolvers.delete(key);
    };
  }

  resolve(selector: TargetSelector | undefined, context: Readonly<FeelContext>): unknown | readonly unknown[] | undefined {
    if (!selector) return context.target;
    if (selector.kind === 'context') return selector.key === 'source' ? context.source : context.target;
    if (selector.kind === 'resolver') {
      const resolver = this.#resolvers.get(selector.key);
      if (!resolver) throw new Error(`Unknown target resolver "${selector.key}"`);
      return resolver(context, selector.args);
    }
    return context.runtime?.resolveTarget(selector, context);
  }
}

/** Validates JSON-facing selectors before a Player is created. */
export function parseTargetSelector(input: unknown): TargetSelector {
  if (!isRecord(input) || typeof input.kind !== 'string') throw new TypeError('target must be a selector object');
  switch (input.kind) {
    case 'context': {
      assertKeys(input, ['kind', 'key']);
      if (input.key !== undefined && input.key !== 'target' && input.key !== 'source') throw new TypeError('context target key must be "target" or "source"');
      return Object.freeze(input.key === undefined ? {kind: 'context'} : {kind: 'context', key: input.key});
    }
    case 'name':
      assertKeys(input, ['kind', 'name']);
      assertName(input.name, 'Target name');
      return Object.freeze({kind: 'name', name: input.name});
    case 'tag':
      assertKeys(input, ['kind', 'tag', 'all']);
      assertName(input.tag, 'Target tag');
      if (input.all !== undefined && typeof input.all !== 'boolean') throw new TypeError('tag target all must be a boolean');
      return Object.freeze({kind: 'tag', tag: input.tag, ...(input.all === undefined ? {} : {all: input.all})});
    case 'camera':
      assertKeys(input, ['kind', 'id']);
      if (input.id !== undefined && (typeof input.id !== 'number' || !Number.isInteger(input.id) || input.id < 0)) throw new RangeError('camera target id must be a non-negative integer');
      return Object.freeze({kind: 'camera', ...(typeof input.id === 'number' ? {id: input.id} : {})});
    case 'scene':
      assertKeys(input, ['kind', 'key']);
      if (input.key !== undefined) assertName(input.key, 'Scene key');
      return Object.freeze({kind: 'scene', ...(input.key === undefined ? {} : {key: input.key})});
    case 'resolver':
      assertKeys(input, ['kind', 'key', 'args']);
      assertName(input.key, 'Resolver key');
      if (input.args !== undefined) assertJsonSafe(input.args, 'Resolver args', new WeakSet());
      return Object.freeze({kind: 'resolver', key: input.key, ...(input.args === undefined ? {} : {args: input.args})});
    default:
      throw new TypeError(`Unknown target selector kind "${input.kind}"`);
  }
}

function assertName(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
}

function assertKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new TypeError(`Target selector has unknown field "${key}"`);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertJsonSafe(value: unknown, label: string, seen: WeakSet<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${label} contains a non-finite number`);
  }
  if (typeof value !== 'object') throw new TypeError(`${label} must contain only JSON-safe values`);
  if (seen.has(value)) throw new TypeError(`${label} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonSafe(item, label, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must use plain objects`);
    for (const item of Object.values(value)) assertJsonSafe(item, label, seen);
  }
  seen.delete(value);
}
