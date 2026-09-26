import { normalizeModelName } from './printer';

export type ModelCompatibilityMatrix = Record<string, string[]>;
export type ModelVerdict = 'exact' | 'compatible' | 'incompatible' | 'unknown';

const key = (model: string | null | undefined): string =>
  normalizeModelName(model).toUpperCase().replace(/[\s-]/g, '');

/** The target model's row lists file models it accepts; no family closure. */
export function modelCompatibility(
  fileModel: string | null | undefined,
  targetModel: string | null | undefined,
  matrix?: ModelCompatibilityMatrix,
): ModelVerdict {
  const file = key(fileModel);
  const target = key(targetModel);
  if (!file || !target) return 'unknown';
  if (file === target) return 'exact';
  if (!matrix) return 'unknown';
  const accepted = Object.entries(matrix).find(([model]) => key(model) === target)?.[1];
  return accepted?.some((model) => key(model) === file) ? 'compatible' : 'incompatible';
}
