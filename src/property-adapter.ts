/** Value kinds supported by a registered property. */
export type PropertyValueKind = 'number' | 'boolean' | 'string' | 'color' | 'vector2';

/** Restoration policy used after a property feedback settles. */
export type RestoreMode = 'never' | 'onComplete' | 'onStop' | 'always';

/** Public metadata for one safe property. */
export interface PropertyDescriptor {
  readonly property: string;
  readonly kind: PropertyValueKind;
  readonly interpolable: boolean;
  readonly readable: boolean;
  readonly writable: boolean;
  readonly defaultRestore: RestoreMode;
  readonly targetType: string;
}

/** Explicit safe access contract for a family of runtime targets. */
export interface PropertyAdapter {
  readonly id: string;
  readonly descriptors: readonly PropertyDescriptor[];
  canHandle(target: unknown, property: string): boolean;
  read(target: unknown, property: string): unknown;
  write(target: unknown, property: string, value: unknown): void;
}

/** Ordered, unregisterable collection of safe property adapters. */
export class PropertyAdapterRegistry {
  #adapters: PropertyAdapter[] = [];

  register(adapter: PropertyAdapter): () => void {
    if (!adapter.id.trim()) throw new TypeError('Property adapter id must be a non-empty string');
    if (this.#adapters.some(candidate => candidate.id === adapter.id)) throw new Error(`Property adapter "${adapter.id}" is already registered`);
    this.#adapters.push(adapter);
    return () => {
      const index = this.#adapters.indexOf(adapter);
      if (index >= 0) this.#adapters.splice(index, 1);
    };
  }

  find(target: unknown, property: string): PropertyAdapter | undefined {
    assertSafePropertyName(property);
    return this.#adapters.find(adapter => adapter.canHandle(target, property));
  }

  require(target: unknown, property: string): PropertyAdapter {
    const adapter = this.find(target, property);
    if (!adapter) throw new Error(`No PropertyAdapter accepts "${property}" on this target`);
    return adapter;
  }

  descriptors(): readonly PropertyDescriptor[] {
    return Object.freeze(this.#adapters.flatMap(adapter => adapter.descriptors));
  }
}

interface Lease {
  readonly token: object;
  value: unknown;
}

interface PropertyOwnership {
  readonly adapter: PropertyAdapter;
  base: unknown;
  readonly leases: Lease[];
}

/** One exclusive, stack-aware claim on a target property. */
export interface PropertyLease {
  write(value: unknown): void;
  release(restore: boolean): void;
}

/** Prevents overlapping feedbacks from restoring stale intermediate values. */
export class PropertyOwnershipManager {
  #targets = new WeakMap<object, Map<string, PropertyOwnership>>();

  acquire(target: object, property: string, adapter: PropertyAdapter): PropertyLease {
    let properties = this.#targets.get(target);
    if (!properties) {
      properties = new Map();
      this.#targets.set(target, properties);
    }
    let ownership = properties.get(property);
    if (!ownership) {
      ownership = {adapter, base: adapter.read(target, property), leases: []};
      properties.set(property, ownership);
    } else if (ownership.adapter !== adapter) {
      throw new Error(`Property "${property}" is already owned through another adapter`);
    }
    const lease: Lease = {token: {}, value: adapter.read(target, property)};
    ownership.leases.push(lease);
    let active = true;
    return Object.freeze({
      write: (value: unknown): void => {
        if (!active) return;
        lease.value = value;
        if (ownership?.leases.at(-1) === lease) adapter.write(target, property, value);
      },
      release: (restore: boolean): void => {
        if (!active) return;
        active = false;
        const index = ownership?.leases.indexOf(lease) ?? -1;
        if (!ownership || index < 0) return;
        const wasTop = index === ownership.leases.length - 1;
        ownership.leases.splice(index, 1);
        if (!restore) ownership.base = lease.value;
        if (wasTop && restore) {
          const previous = ownership.leases.at(-1);
          adapter.write(target, property, previous?.value ?? ownership.base);
        }
        if (ownership.leases.length === 0) properties?.delete(property);
      },
    });
  }
}

export const phaserScalarPropertyDescriptors = Object.freeze([
  descriptor('x', 'number'), descriptor('y', 'number'), descriptor('scaleX', 'number'), descriptor('scaleY', 'number'),
  descriptor('rotation', 'number'), descriptor('alpha', 'number'), descriptor('depth', 'number'),
  descriptor('displayWidth', 'number'), descriptor('displayHeight', 'number'),
  descriptor('visible', 'boolean', false), descriptor('active', 'boolean', false), descriptor('tint', 'color'),
] satisfies readonly PropertyDescriptor[]);

/** Safe built-in adapter for audited Phaser 4 scalar properties. */
export class PhaserScalarPropertyAdapter implements PropertyAdapter {
  readonly id = 'phaser.scalar';
  readonly descriptors = phaserScalarPropertyDescriptors;
  #properties = new Map(this.descriptors.map(item => [item.property, item]));

  canHandle(target: unknown, property: string): boolean {
    return isObject(target) && this.#properties.has(property) && property in target;
  }

  read(target: unknown, property: string): unknown {
    if (!isObject(target)) throw new TypeError('phaser.scalar target must be an object');
    const descriptor = this.requireDescriptor(target, property);
    const value = Reflect.get(target, property);
    assertKind(value, descriptor.kind, property);
    return value;
  }

  write(target: unknown, property: string, value: unknown): void {
    if (!isObject(target)) throw new TypeError('phaser.scalar target must be an object');
    const descriptor = this.requireDescriptor(target, property);
    assertKind(value, descriptor.kind, property);
    if (!Reflect.set(target, property, value)) throw new Error(`Unable to write property "${property}"`);
  }

  private requireDescriptor(target: unknown, property: string): PropertyDescriptor {
    const descriptor = this.#properties.get(property);
    if (!descriptor || !isObject(target) || !(property in target)) throw new Error(`phaser.scalar cannot access "${property}"`);
    return descriptor;
  }
}

/** Creates the built-in property registry. */
export function createDefaultPropertyAdapterRegistry(): PropertyAdapterRegistry {
  const registry = new PropertyAdapterRegistry();
  registry.register(new PhaserScalarPropertyAdapter());
  return registry;
}

function descriptor(property: string, kind: PropertyValueKind, interpolable = true): PropertyDescriptor {
  return Object.freeze({property, kind, interpolable, readable: true, writable: true, defaultRestore: 'never', targetType: 'Phaser.GameObjects.GameObject'});
}

function assertSafePropertyName(property: string): void {
  if (!property || property.includes('.') || property === '__proto__' || property === 'prototype' || property === 'constructor') {
    throw new TypeError(`Unsafe property name "${property}"`);
  }
}

function assertKind(value: unknown, kind: PropertyValueKind, property: string): void {
  if ((kind === 'number' || kind === 'color') && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TypeError(`Property "${property}" requires a finite number`);
  }
  if (kind === 'boolean' && typeof value !== 'boolean') throw new TypeError(`Property "${property}" requires a boolean`);
  if (kind === 'string' && typeof value !== 'string') throw new TypeError(`Property "${property}" requires a string`);
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}
