// Finds a Hikaku extension checkout, so the benchmark runs the real
// detection code and not a copy of it.
//
// Resolution order: $HIKAKU_DIR, ../hikaku, ../ai-detection
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = join(ROOT, 'data');
export const RESULTS = join(ROOT, 'results');

const candidates = [process.env.HIKAKU_DIR, join(ROOT, '..', 'hikaku'), join(ROOT, '..', 'ai-detection')].filter(Boolean).map((p) => resolve(p));
export const HIKAKU_DIR = candidates.find((p) => existsSync(join(p, 'lib', 'metadata.js')));
if (!HIKAKU_DIR) {
  console.error(`Can't find the Hikaku extension. Clone it next to this repo, or set HIKAKU_DIR.\nTried: ${candidates.join(', ')}`);
  process.exit(1);
}

const lib = (name) => import(pathToFileURL(join(HIKAKU_DIR, 'lib', name)).href);
export const { extractMetadata } = await lib('metadata.js');
export const { evaluate, CLASSIFIER } = await lib('score.js');
export const { rgbaToCHW, aiProbability, resizeRGBA, looksLikeGraphic } = await lib('preprocess.js');
export const { MODEL, localPath } = await lib('model-config.js');

export const modelFile = (variant = 'uint8') => join(HIKAKU_DIR, localPath(variant));

/** Newest built extension folder (dist/hikaku-x.y.z), or $EXT_DIR if set. */
export function builtExtension() {
  if (process.env.EXT_DIR) return resolve(process.env.EXT_DIR);
  const dist = join(HIKAKU_DIR, 'dist');
  const builds = existsSync(dist) ? readdirSync(dist).filter((d) => /^hikaku-[\d.]+$/.test(d)).sort() : [];
  return builds.length ? join(dist, builds.at(-1)) : null;
}
