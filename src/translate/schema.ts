// Tool parameter schemas for Cloud Code Assist.
//
// Gemini takes full JSON Schema in `parametersJsonSchema`. Claude behind Cloud Code
// Assist goes through the older `parameters` field (an OpenAPI subset) that the
// backend turns into Anthropic's input_schema, so it needs cleaning first.

import { isRecord, type JsonObject } from "../fsutil.ts";

const NAME_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SUBSCHEMAS = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "items",
  "prefixItems",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
]);

/** Gemini ignores `const` in parametersJsonSchema but honors a single-value `enum`. */
export function forGeminiJsonSchema(schema: unknown, isNameMap = false): unknown {
  if (Array.isArray(schema)) return schema.map((s) => forGeminiJsonSchema(s));
  if (!isRecord(schema)) return schema;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (isNameMap || SUBSCHEMAS.has(key)) out[key] = forGeminiJsonSchema(value);
    else if (NAME_MAPS.has(key)) out[key] = forGeminiJsonSchema(value, true);
    else out[key] = value;
  }
  if (!isNameMap && "const" in out && out.enum === undefined && (typeof out.const === "string" || typeof out.const === "number")) {
    out.enum = [out.const];
    delete out.const;
  }
  return out;
}

const pureConst = (v: unknown) => isRecord(v) && Object.keys(v).length === 1 && "const" in v;

function liftTypeArray(out: JsonObject, value: unknown[]): void {
  const nonNull = value.filter((t) => t !== "null");
  if (value.includes("null")) out.nullable = true;
  out.type = nonNull[0] ?? "string";
}

/** Keywords the `parameters` proto rejects for every model. */
const CLAUDE_DROP = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "$comment",
  "if",
  "then",
  "else",
  "not",
  "patternProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contentEncoding",
  "contentMediaType",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "propertyNames",
  "uniqueItems",
  "deprecated",
]);

function mergeUnion(key: string, variants: JsonObject[], out: JsonObject, clean: (s: unknown) => unknown): void {
  const cleaned = variants.map(clean).filter((v): v is JsonObject => isRecord(v) && Object.keys(v).length > 0);
  if (!cleaned.length) return;
  if (key !== "allOf") {
    const nullIdx = cleaned.findIndex((v) => v.type === "null" && Object.keys(v).length === 1);
    if (nullIdx !== -1) {
      const rest = cleaned.filter((_, i) => i !== nullIdx);
      if (rest.length) {
        Object.assign(out, rest[0], { nullable: true });
        return;
      }
    }
  }
  if (key === "allOf" || cleaned.every((v) => v.type === "object" && isRecord(v.properties))) {
    const props: JsonObject = {};
    const requiredSets = cleaned.map((v) => new Set(Array.isArray(v.required) ? (v.required as string[]) : []));
    for (const v of cleaned) for (const [k, s] of Object.entries((v.properties as JsonObject | undefined) ?? {})) props[k] ??= s;
    const required =
      key === "allOf"
        ? [...new Set(requiredSets.flatMap((s) => [...s]))]
        : [...(requiredSets[0] ?? [])].filter((r) => requiredSets.every((s) => s.has(r)));
    const merged: JsonObject = key === "allOf" ? Object.assign({}, ...cleaned) : { ...cleaned[0] };
    if (Object.keys(props).length) merged.properties = props;
    if (required.length) merged.required = required;
    else delete merged.required;
    Object.assign(out, merged);
    return;
  }
  // Complex unions do not survive the trip to Claude; keep the first shape.
  Object.assign(out, cleaned[0]);
}

export function forClaudeParameters(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (CLAUDE_DROP.has(key) || key.startsWith("x-")) continue;
    if (key === "const") {
      out.enum = [value];
    } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      if (value.every(pureConst)) {
        out.enum = value.map((v) => (v as JsonObject).const);
        if (value.every((v) => typeof (v as JsonObject).const === "string")) out.type ??= "string";
      } else if (
        value.length > 0 &&
        value.every((v) => isRecord(v) && Object.keys(v).length === 2 && "type" in v && "const" in v && v.type === (value[0] as JsonObject).type)
      ) {
        out.type ??= (value[0] as JsonObject).type;
        out.enum = value.map((v) => (v as JsonObject).const);
      } else {
        mergeUnion(key, value.filter(isRecord), out, forClaudeParameters);
      }
    } else if (key === "type" && Array.isArray(value)) {
      liftTypeArray(out, value);
    } else if (key === "properties" && isRecord(value)) {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, forClaudeParameters(v)]));
    } else {
      out[key] = isRecord(value) ? forClaudeParameters(value) : key === "items" && Array.isArray(value) ? value.map(forClaudeParameters) : value;
    }
  }
  // The proto only accepts string enums.
  if (Array.isArray(out.enum) && !out.enum.every((v) => typeof v === "string")) {
    if (!out.type && out.enum.length && out.enum.every((v) => typeof v === "boolean")) out.type = "boolean";
    delete out.enum;
  }
  return out;
}

/** Keywords the Gemini `parameters` proto rejects. Only used when parametersJsonSchema is refused. */
const GEMINI_LEGACY_DROP = new Set([
  ...CLAUDE_DROP,
  "const",
  "examples",
  "minimum",
  "maximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "title",
  "default",
  "additionalProperties",
]);

export function forGeminiLegacyParameters(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (GEMINI_LEGACY_DROP.has(key) || key.startsWith("x-")) continue;
    if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
      if (value.every(pureConst)) {
        out.enum = value.map((v) => String((v as JsonObject).const));
        out.type ??= "string";
      } else {
        mergeUnion(key, value.filter(isRecord), out, forGeminiLegacyParameters);
      }
    } else if (key === "type" && Array.isArray(value)) {
      liftTypeArray(out, value);
    } else if (key === "properties" && isRecord(value)) {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, forGeminiLegacyParameters(v)]));
    } else {
      out[key] = isRecord(value) ? forGeminiLegacyParameters(value) : value;
    }
  }
  if (Array.isArray(out.enum)) out.enum = out.enum.map(String);
  return out;
}
