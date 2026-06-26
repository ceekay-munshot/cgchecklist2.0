import Ajv, { type Schema, type ValidateFunction } from "ajv";
import type { CompleteOpts, CompleteResult } from "./types";
import { LlmJsonError } from "./types";

const ajv = new Ajv({ allErrors: true, strict: false });

// Cache compiled validators by schema object identity.
const validatorCache = new WeakMap<object, ValidateFunction>();

function getValidator(schema: object): ValidateFunction {
  let validate = validatorCache.get(schema);
  if (!validate) {
    validate = ajv.compile(schema as unknown as Schema);
    validatorCache.set(schema, validate);
  }
  return validate;
}

/**
 * Pull a JSON value out of a model response that may be wrapped in prose or
 * ```json code fences```.
 */
export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : trimmed).trim();

  const firstBrace = body.search(/[{[]/);
  if (firstBrace === -1) return body;
  const lastBrace = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  return lastBrace > firstBrace ? body.slice(firstBrace, lastBrace + 1) : body;
}

/** Retries on invalid JSON, as required by the brief (2 retries => 3 attempts). */
export const JSON_MAX_RETRIES = 2;

/**
 * Shared structured-output driver. Calls `complete`, parses + validates the
 * output against `schema`, and on failure retries up to JSON_MAX_RETRIES times,
 * feeding the validation error back to the model so it can self-correct.
 */
export async function completeJSONWith<T>(
  provider: string,
  complete: (opts: CompleteOpts) => Promise<CompleteResult>,
  opts: CompleteOpts,
  schema: object,
): Promise<T> {
  const validate = getValidator(schema);
  const schemaText = JSON.stringify(schema);
  let lastError: string | undefined;
  let lastText: string | undefined;

  for (let attempt = 0; attempt <= JSON_MAX_RETRIES; attempt++) {
    const instructions =
      "Respond with a single JSON value and nothing else " +
      "(no prose, no markdown, no code fences). It MUST validate against this " +
      `JSON Schema:\n${schemaText}` +
      (lastError
        ? `\n\nYour previous response was invalid: ${lastError}\n` +
          "Return corrected JSON only."
        : "");

    const { text } = await complete({
      ...opts,
      json: true,
      prompt: `${opts.prompt}\n\n${instructions}`,
    });
    lastText = text;

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(text));
    } catch (e) {
      lastError = `not valid JSON (${(e as Error).message})`;
      continue;
    }

    if (validate(parsed)) {
      return parsed as T;
    }
    lastError = ajv.errorsText(validate.errors, { separator: "; " });
  }

  throw new LlmJsonError(
    provider,
    `failed to produce schema-valid JSON after ${JSON_MAX_RETRIES + 1} attempts: ${lastError}`,
    JSON_MAX_RETRIES + 1,
    lastText,
  );
}
