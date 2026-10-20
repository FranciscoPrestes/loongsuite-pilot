import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import schema from '../../schemas/ntconsult-analytics/v1/analytics-observation-v1.schema.json' with { type: 'json' };
import type { Observation } from './observation-contract.js';
export type { Observation } from './observation-contract.js';

// Schema is bundled by esbuild and also shipped for independent hash checks.
// Coercion/default insertion/removal are disabled: observations are additive evidence.
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => void;
addFormats(ajv);
const validate = ajv.compile<Observation>(schema);

export function validateObservation(value: unknown): Observation {
  if (!validate(value)) throw new TypeError(`Invalid analytics observation: ${ajv.errorsText(validate.errors)}`);
  return value;
}
