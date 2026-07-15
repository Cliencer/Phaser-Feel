/** Stable names of the domains included in every registry. */
export type BuiltInTimeDomainName = 'real' | 'scene' | 'ui';

/** Immutable observable state of one time domain. */
export interface TimeDomainState {
  readonly name: string;
  readonly scale: number;
  readonly paused: boolean;
  readonly revision: number;
}

/** Temporary change composed with other active changes on a domain. */
export interface TimeDomainLease {
  readonly domain: string;
  release(): void;
}

/** Receives a state whenever a domain's effective value changes. */
export type TimeDomainSync = (state: Readonly<TimeDomainState>) => void;

/** Construction options for a scoped TimeDomain registry. */
export interface TimeDomainRegistryOptions {
  readonly sync?: TimeDomainSync;
  readonly onDispose?: () => void;
  readonly initial?: Partial<Record<BuiltInTimeDomainName, {readonly scale?: number; readonly paused?: boolean}>>;
}

interface DomainModifier {
  readonly token: object;
  readonly scale?: number;
  readonly paused?: boolean;
}

/** A composable clock policy independent of Phaser and the DOM. */
export class TimeDomain {
  #baseScale: number;
  #basePaused: boolean;
  #revision = 0;
  #modifiers: DomainModifier[] = [];
  #listeners = new Set<TimeDomainSync>();
  #disposed = false;

  constructor(readonly name: string, initial: {readonly scale?: number; readonly paused?: boolean} = {}) {
    assertDomainName(name);
    this.#baseScale = validateScale(initial.scale ?? 1);
    this.#basePaused = initial.paused ?? false;
  }

  get state(): Readonly<TimeDomainState> {
    const scale = this.#modifiers.reduce((value, modifier) => value * (modifier.scale ?? 1), this.#baseScale);
    const paused = this.#basePaused || this.#modifiers.some(modifier => modifier.paused === true);
    return Object.freeze({name: this.name, scale, paused, revision: this.#revision});
  }

  setBase(input: {readonly scale?: number; readonly paused?: boolean}): void {
    this.assertActive();
    const scale = input.scale === undefined ? this.#baseScale : validateScale(input.scale);
    const paused = input.paused ?? this.#basePaused;
    if (scale === this.#baseScale && paused === this.#basePaused) return;
    this.#baseScale = scale;
    this.#basePaused = paused;
    this.publish();
  }

  acquire(input: {readonly scale?: number; readonly paused?: boolean}): TimeDomainLease {
    this.assertActive();
    if (input.scale === undefined && input.paused === undefined) throw new TypeError('TimeDomain lease must change scale or paused');
    const modifier: DomainModifier = Object.freeze({token: {}, ...(input.scale === undefined ? {} : {scale: validateScale(input.scale)}), ...(input.paused === undefined ? {} : {paused: input.paused})});
    this.#modifiers.push(modifier);
    this.publish();
    let active = true;
    return Object.freeze({
      domain: this.name,
      release: (): void => {
        if (!active) return;
        active = false;
        const index = this.#modifiers.indexOf(modifier);
        if (index < 0) return;
        this.#modifiers.splice(index, 1);
        this.publish();
      },
    });
  }

  subscribe(listener: TimeDomainSync, emitCurrent = true): () => void {
    this.assertActive();
    this.#listeners.add(listener);
    if (emitCurrent) listener(this.state);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#modifiers = [];
    this.publish();
    this.#disposed = true;
    this.#listeners.clear();
  }

  private publish(): void {
    this.#revision += 1;
    const state = this.state;
    for (const listener of this.#listeners) listener(state);
  }

  private assertActive(): void {
    if (this.#disposed) throw new Error(`TimeDomain "${this.name}" is disposed`);
  }
}

/** Owns built-in and application-defined time domains for one runtime scope. */
export class TimeDomainRegistry {
  #domains = new Map<string, TimeDomain>();
  #unsubscribe = new Map<string, () => void>();
  #disposed = false;
  readonly #sync: TimeDomainSync | undefined;
  readonly #onDispose: (() => void) | undefined;

  constructor(options: TimeDomainRegistryOptions = {}) {
    this.#sync = options.sync;
    this.#onDispose = options.onDispose;
    const initial = options.initial ?? {};
    this.addBuiltIn('real', initial.real);
    this.addBuiltIn('scene', initial.scene);
    this.addBuiltIn('ui', initial.ui);
  }

  get(name: string): TimeDomain | undefined { return this.#domains.get(name); }

  require(name: string): TimeDomain {
    const domain = this.#domains.get(name);
    if (!domain) throw new Error(`Unknown TimeDomain "${name}"`);
    return domain;
  }

  register(name: string, initial: {readonly scale?: number; readonly paused?: boolean} = {}): () => void {
    this.assertActive();
    assertDomainName(name);
    if (this.#domains.has(name)) throw new Error(`TimeDomain "${name}" is already registered`);
    const domain = new TimeDomain(name, initial);
    this.#domains.set(name, domain);
    if (this.#sync) this.#unsubscribe.set(name, domain.subscribe(this.#sync));
    let active = true;
    return () => {
      if (!active || this.#domains.get(name) !== domain) return;
      active = false;
      domain.dispose();
      this.#unsubscribe.get(name)?.();
      this.#unsubscribe.delete(name);
      this.#domains.delete(name);
    };
  }

  states(): readonly Readonly<TimeDomainState>[] {
    return Object.freeze([...this.#domains.values()].map(domain => domain.state));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const domain of this.#domains.values()) domain.dispose();
    for (const unsubscribe of this.#unsubscribe.values()) unsubscribe();
    this.#unsubscribe.clear();
    this.#domains.clear();
    this.#onDispose?.();
  }

  private addBuiltIn(name: BuiltInTimeDomainName, initial?: {readonly scale?: number; readonly paused?: boolean}): void {
    const domain = new TimeDomain(name, initial);
    this.#domains.set(name, domain);
    if (this.#sync) this.#unsubscribe.set(name, domain.subscribe(this.#sync));
  }

  private assertActive(): void {
    if (this.#disposed) throw new Error('TimeDomainRegistry is disposed');
  }
}

function assertDomainName(name: string): void {
  if (!/^[a-z][a-z0-9.-]*$/u.test(name)) throw new TypeError('TimeDomain name must start with a letter and contain only lowercase letters, digits, dots, or hyphens');
}

function validateScale(scale: number): number {
  if (!Number.isFinite(scale) || scale < 0) throw new RangeError('TimeDomain scale must be a finite number >= 0');
  return scale;
}
