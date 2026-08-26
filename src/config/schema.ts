import { type Static, Type } from "@sinclair/typebox";
import { Ajv, type ErrorObject } from "ajv";

const runtimePathsSchema = Type.Object(
  {
    db_path: Type.Optional(Type.String({ minLength: 1 })),
    log_path: Type.Optional(Type.String({ minLength: 1 })),
    pid_path: Type.Optional(Type.String({ minLength: 1 })),
    socket_path: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const observabilitySchema = Type.Object(
  {
    telemetry: Type.Optional(
      Type.Object(
        {
          max_excerpt_bytes: Type.Optional(Type.Integer({ minimum: 1, default: 4096 })),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const shepyConfigSchema = Type.Object(
  {
    observability: Type.Optional(observabilitySchema),
    runtime: Type.Optional(runtimePathsSchema),
  },
  { additionalProperties: false },
);

export type ShepyConfig = Static<typeof shepyConfigSchema>;

export type ValidationResult<T> = { ok: true; value: T } | { errors: ErrorObject[]; ok: false };

const ajv = new Ajv({ allErrors: true, useDefaults: true });
const validateShepyConfig = ajv.compile<ShepyConfig>(shepyConfigSchema);

export function parseShepyConfig(value: unknown): ValidationResult<ShepyConfig> {
  if (validateShepyConfig(value)) {
    return { ok: true, value: value as ShepyConfig };
  }

  return { errors: validateShepyConfig.errors ?? [], ok: false };
}
