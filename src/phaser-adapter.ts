import type {CameraShakeRequest, EventEmitRequest, FeelContext, FeelPlayer, NumericTweenRequest, RuntimeAdapter, TimeDomainSyncRequest, TweenController} from './runtime.js';
import type {TargetSelector} from './target-resolver.js';
import {TimeDomainRegistry} from './time-domain.js';

interface PhaserCameraLike {
  shake(duration: number, intensity: number, force: boolean, callback: (_camera: unknown, progress: number) => void): unknown;
  shakeEffect?: {reset(): void};
}

interface EventEmitterLike { emit(event: string, data?: unknown): unknown }
interface SceneEventsLike {
  once(event: 'shutdown' | 'destroy', callback: () => void): unknown;
  off?(event: 'shutdown' | 'destroy', callback: () => void): unknown;
}
interface PhaserTweenLike {
  getValue(): number | null;
  pause(): unknown;
  resume(): unknown;
  stop(): unknown;
  complete(): unknown;
}
interface PhaserTweenManagerLike {
  timeScale: number;
  paused: boolean;
  addCounter?(config: {
    from: number;
    to: number;
    duration: number;
    ease: string;
    onUpdate: (tween: PhaserTweenLike) => void;
    onComplete: () => void;
    onStop: () => void;
  }): PhaserTweenLike;
}
interface TaggedObject {readonly tags?: readonly string[]}
interface PhaserSceneLike {
  events?: SceneEventsLike;
  tweens?: PhaserTweenManagerLike;
  children?: {readonly list?: readonly unknown[]; getByName?(name: string): unknown};
  cameras?: {readonly main?: unknown; readonly cameras?: readonly {readonly id?: number}[]};
  scene?: {get?(key: string): unknown; isPaused?(): boolean; pause?(): unknown; resume?(): unknown};
  time?: {timeScale: number; paused: boolean};
}

type ControllableSceneLike = PhaserSceneLike;

interface TimeDomainBinding {
  readonly timeScale: number;
  readonly timePaused: boolean;
  readonly tweenScale: number;
  readonly tweenPaused: boolean;
  readonly managerPaused: boolean;
  appliedManagerPaused: boolean;
}

/** Structural Phaser 4 adapter kept behind the core runtime boundary. */
export class PhaserRuntimeAdapter implements RuntimeAdapter {
  #domainPaused = new WeakMap<object, boolean>();
  #timeBindings = new WeakMap<object, TimeDomainBinding>();
  constructor(
    readonly phaserVersion = '4',
    readonly reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  ) {}

  cameraShake(request: CameraShakeRequest, signal: AbortSignal): Promise<'completed' | 'missing-target'> {
    if (!isCameraLike(request.target)) return Promise.resolve('missing-target');
    const camera = request.target;
    return new Promise(resolve => {
      if (signal.aborted) return resolve('completed');
      camera.shake(request.duration, request.intensity, request.force, (_camera, progress) => {
        if (progress === 1) resolve('completed');
      });
      signal.addEventListener('abort', () => {
        camera.shakeEffect?.reset();
        resolve('completed');
      }, {once: true});
    });
  }

  emitEvent(request: EventEmitRequest): 'completed' | 'missing-target' {
    if (!isEventEmitterLike(request.target)) return 'missing-target';
    request.target.emit(request.event, request.data);
    return 'completed';
  }

  resolveTarget(
    selector: Exclude<TargetSelector, {readonly kind: 'context'} | {readonly kind: 'resolver'}>,
    context: Readonly<FeelContext>,
  ): unknown | readonly unknown[] | undefined {
    const scene = isSceneLike(context.scene) ? context.scene : undefined;
    if (selector.kind === 'scene') return selector.key ? scene?.scene?.get?.(selector.key) : scene;
    if (selector.kind === 'name') return scene?.children?.getByName?.(selector.name) ?? undefined;
    if (selector.kind === 'camera') {
      if (selector.id === undefined) return scene?.cameras?.main;
      return scene?.cameras?.cameras?.find(camera => camera.id === selector.id);
    }
    const matches = (scene?.children?.list ?? []).filter(target => isTagged(target) && target.tags?.includes(selector.tag));
    return selector.all ? Object.freeze(matches) : matches[0];
  }

  createTween(request: NumericTweenRequest): TweenController | undefined {
    if (!isSceneLike(request.scene) || !request.scene.tweens?.addCounter) return undefined;
    let settled = false;
    let resolveCompletion!: (status: 'completed' | 'stopped') => void;
    const completion = new Promise<'completed' | 'stopped'>(resolve => { resolveCompletion = resolve; });
    const settle = (status: 'completed' | 'stopped'): void => {
      if (settled) return;
      settled = true;
      resolveCompletion(status);
    };
    const tween = request.scene.tweens.addCounter({
      from: request.from,
      to: request.to,
      duration: request.duration,
      ease: request.ease,
      onUpdate: current => request.onUpdate(current.getValue() ?? request.to),
      onComplete: () => settle('completed'),
      onStop: () => settle('stopped'),
    });
    return Object.freeze({
      completion,
      pause: (): void => { if (!settled) tween.pause(); },
      resume: (): void => { if (!settled) tween.resume(); },
      stop: (): void => { if (!settled) tween.stop(); },
      skipToEnd: (): void => {
        if (settled) return;
        request.onUpdate(request.to);
        tween.complete();
        settle('completed');
      },
    });
  }

  syncTimeDomain(request: TimeDomainSyncRequest): 'completed' | 'unsupported' {
    if (request.state.name !== 'scene' || !isSceneLike(request.scene)) return 'unsupported';
    const scene = request.scene;
    const binding = this.#timeBindings.get(scene);
    let synchronized = false;
    if (scene.time) {
      scene.time.timeScale = (binding?.timeScale ?? 1) * request.state.scale;
      scene.time.paused = (binding?.timePaused ?? false) || request.state.paused;
      synchronized = true;
    }
    if (scene.tweens) {
      scene.tweens.timeScale = (binding?.tweenScale ?? 1) * request.state.scale;
      scene.tweens.paused = (binding?.tweenPaused ?? false) || request.state.paused;
      synchronized = true;
    }
    if (binding) {
      const desiredPaused = binding.managerPaused || request.state.paused;
      if (desiredPaused !== binding.appliedManagerPaused) {
        if (desiredPaused) scene.scene?.pause?.();
        else scene.scene?.resume?.();
        binding.appliedManagerPaused = desiredPaused;
      }
    } else {
      const previousPaused = this.#domainPaused.get(scene);
      if (previousPaused !== request.state.paused) {
        if (request.state.paused) scene.scene?.pause?.();
        else if (previousPaused === true) scene.scene?.resume?.();
        this.#domainPaused.set(scene, request.state.paused);
      }
    }
    return synchronized || scene.scene?.pause !== undefined ? 'completed' : 'unsupported';
  }

  /** Creates built-in domains bound to one Phaser Scene lifecycle. */
  createTimeDomains(scene: ControllableSceneLike): TimeDomainRegistry {
    const managerPaused = scene.scene?.isPaused?.() ?? false;
    const binding: TimeDomainBinding = {
      timeScale: scene.time?.timeScale ?? 1,
      timePaused: scene.time?.paused ?? false,
      tweenScale: scene.tweens?.timeScale ?? 1,
      tweenPaused: scene.tweens?.paused ?? false,
      managerPaused,
      appliedManagerPaused: managerPaused,
    };
    this.#timeBindings.set(scene, binding);
    let registry!: TimeDomainRegistry;
    let bound = true;
    const dispose = (): void => registry.dispose();
    const unbind = (): void => {
      if (!bound) return;
      bound = false;
      scene.events?.off?.('shutdown', dispose);
      scene.events?.off?.('destroy', dispose);
      this.#domainPaused.delete(scene);
      this.#timeBindings.delete(scene);
    };
    registry = new TimeDomainRegistry({
      sync: state => { if (state.name === 'scene') this.syncTimeDomain({scene, state}); },
      onDispose: unbind,
    });
    scene.events?.once('shutdown', dispose);
    scene.events?.once('destroy', dispose);
    return registry;
  }

  /** Disposes a Player when its owning Phaser Scene shuts down or is destroyed. */
  bindSceneShutdown<TData>(player: FeelPlayer<TData>, scene: PhaserSceneLike): () => void {
    if (!scene.events) throw new TypeError('Phaser Scene events are required');
    const events = scene.events;
    let bound = true;
    const dispose = (): void => {
      if (!bound) return;
      bound = false;
      events.off?.('shutdown', dispose);
      events.off?.('destroy', dispose);
      player.dispose();
    };
    events.once('shutdown', dispose);
    events.once('destroy', dispose);
    return () => {
      if (!bound) return;
      bound = false;
      events.off?.('shutdown', dispose);
      events.off?.('destroy', dispose);
    };
  }
}

function isCameraLike(value: unknown): value is PhaserCameraLike {
  return typeof value === 'object' && value !== null && 'shake' in value && typeof value.shake === 'function';
}

function isEventEmitterLike(value: unknown): value is EventEmitterLike {
  return typeof value === 'object' && value !== null && 'emit' in value && typeof value.emit === 'function';
}

function isSceneLike(value: unknown): value is PhaserSceneLike {
  return typeof value === 'object' && value !== null;
}

function isTagged(value: unknown): value is TaggedObject {
  return typeof value === 'object' && value !== null && (!('tags' in value) || Array.isArray(value.tags));
}
