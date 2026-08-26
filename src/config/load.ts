import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { parseShepyConfig, type ShepyConfig } from "./schema.js";

export type ConfigLoadError = {
  message: string;
  path?: string;
};

export type ConfigLoadResult =
  | { ok: true; value: ShepyConfig }
  | { errors: ConfigLoadError[]; ok: false };

export function loadShepyConfig(path: string): ConfigLoadResult {
  const source = readFileSync(path, "utf8");
  const document = parseDocument(source);

  if (document.errors.length > 0) {
    return {
      errors: document.errors.map((error) => ({
        message: error.message,
        path,
      })),
      ok: false,
    };
  }

  const result = parseShepyConfig(document.toJSON());
  if (result.ok) {
    return result;
  }

  return {
    errors: result.errors.map((error) => ({
      message: error.message ?? `${error.instancePath} failed ${error.keyword}`,
      path,
    })),
    ok: false,
  };
}
