/** Inclusive numeric bounds used by schema-aware tools. */
export type NumberRange = readonly [min: number, max: number];

/** Declarative metadata for one numeric feedback parameter. */
export interface NumberField {
  readonly kind: 'number';
  readonly default: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: 'milliseconds' | 'ratio' | 'pixels' | 'radians';
}

/** Declarative metadata for one boolean feedback parameter. */
export interface BooleanField {
  readonly kind: 'boolean';
  readonly default: boolean;
}

/** Declarative metadata for one string feedback parameter. */
export interface StringField {
  readonly kind: 'string';
  readonly default: string;
  readonly minLength?: number;
  readonly enum?: readonly string[];
  readonly pattern?: string;
}

/** A field definition supported by the milestone schema DSL. */
export type SchemaField = NumberField | BooleanField | StringField;
/** Named fields in a feedback schema. */
export type SchemaShape = Readonly<Record<string, SchemaField>>;

/** Resolves a schema shape to the immutable runtime parameter type. */
export type InferSchema<T extends SchemaShape> = {
  readonly [K in keyof T]: T[K] extends NumberField
    ? number
    : T[K] extends BooleanField
      ? boolean
      : T[K] extends StringField
        ? string
      : never;
};

/** A structured validation problem for future editor integrations. */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Runtime and tooling contract produced by {@link defineFeedbackSchema}. */
export interface FeedbackSchema<TType extends string, TShape extends SchemaShape> {
  readonly type: TType;
  readonly shape: TShape;
  defaults(): InferSchema<TShape>;
  parse(input: unknown): InferSchema<TShape>;
  toJSONSchema(): Readonly<Record<string, unknown>>;
}

/** Constructors for the supported schema fields. */
export const field = {
  number(config: Omit<NumberField, 'kind'>): NumberField {
    return Object.freeze({kind: 'number', ...config});
  },
  boolean(config: Omit<BooleanField, 'kind'>): BooleanField {
    return Object.freeze({kind: 'boolean', ...config});
  },
  string(config: Omit<StringField, 'kind'>): StringField {
    return Object.freeze({kind: 'string', ...config});
  },
};

/** Defines one immutable, strict feedback schema. */
export function defineFeedbackSchema<const TType extends string, const TShape extends SchemaShape>(
  type: TType,
  shape: TShape,
): FeedbackSchema<TType, TShape> {
  const defaults = (): InferSchema<TShape> => Object.fromEntries(
    Object.entries(shape).map(([key, definition]) => [key, definition.default]),
  ) as InferSchema<TShape>;

  return Object.freeze({
    type,
    shape: Object.freeze(shape),
    defaults,
    parse(input: unknown): InferSchema<TShape> {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        throw new TypeError(`${type} params must be an object`);
      }
      const result: Record<string, boolean | number | string> = {...defaults()};
      for (const [key, value] of Object.entries(input)) {
        const definition = shape[key];
        if (!definition) throw new TypeError(`${type} has unknown parameter "${key}"`);
        if (definition.kind === 'number') {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new TypeError(`${type}.${key} must be a finite number`);
          }
          if (definition.min !== undefined && value < definition.min) {
            throw new RangeError(`${type}.${key} must be >= ${definition.min}`);
          }
          if (definition.max !== undefined && value > definition.max) {
            throw new RangeError(`${type}.${key} must be <= ${definition.max}`);
          }
        } else if (definition.kind === 'boolean') {
          if (typeof value !== 'boolean') throw new TypeError(`${type}.${key} must be a boolean`);
        } else {
          if (typeof value !== 'string') throw new TypeError(`${type}.${key} must be a string`);
          if (definition.minLength !== undefined && value.length < definition.minLength) {
            throw new RangeError(`${type}.${key} must contain at least ${definition.minLength} character(s)`);
          }
          if (definition.enum && !definition.enum.includes(value)) {
            throw new RangeError(`${type}.${key} must be one of: ${definition.enum.join(', ')}`);
          }
          if (definition.pattern && !new RegExp(definition.pattern, 'u').test(value)) {
            throw new RangeError(`${type}.${key} must match ${definition.pattern}`);
          }
        }
        result[key] = value as boolean | number | string;
      }
      return Object.freeze(result) as InferSchema<TShape>;
    },
    toJSONSchema(): Readonly<Record<string, unknown>> {
      const properties = Object.fromEntries(Object.entries(shape).map(([key, definition]) => [key, {
        type: definition.kind,
        default: definition.default,
        ...('min' in definition && definition.min !== undefined ? {minimum: definition.min} : {}),
        ...('max' in definition && definition.max !== undefined ? {maximum: definition.max} : {}),
        ...('minLength' in definition && definition.minLength !== undefined ? {minLength: definition.minLength} : {}),
        ...('enum' in definition && definition.enum !== undefined ? {enum: definition.enum} : {}),
        ...('pattern' in definition && definition.pattern !== undefined ? {pattern: definition.pattern} : {}),
      }]));
      return Object.freeze({$schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties, additionalProperties: false});
    },
  });
}
