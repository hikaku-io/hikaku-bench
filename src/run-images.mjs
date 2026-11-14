// Runs Hikaku's detection pipeline (metadata, then screenshot filter, then visual
// model) over the scraped images and compares the results to the weak labels.
// Node resizing differs from browser canvas. Use npm run compare for browser-native model comparisons.
//
// Usage: npm run images -- [--limit=N]
// Needs: the extension repo with model weights (run npm run setup -- --model=uint8 there)
// Output: results/images.jsonl, results/images.md
import * as ort from 'onnxruntime-web';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DATA as BENCH, RESULTS, HIKAKU_DIR, MODEL, modelFile,
  rgbaToCHW, aiProbability, resizeRGBA, looksLikeGraphic, extractMetadata, evaluate, CLASSIFIER,
} from './hikaku.mjs';

mkdirSync(RESULTS, { recursive: true });
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? Infinity);
const FLAGGED = new Set(['ai', 'ai-edited', 'likely-ai']);

if (!existsSync(join(BENCH, 'manifest.jsonl'))) { console.error('No data/manifest.jsonl. Run npm run scrape first.'); process.exit(1); }
if (!existsSync(modelFile())) { console.error(`Missing model. In ${HIKAKU_DIR}, run: npm run setup -- --model=uint8`); process.exit(1); }

const items = readFileSync(join(BENCH, 'manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(0, LIMIT);
ort.env.wasm.numThreads = 4;
const session = await ort.InferenceSession.create(readFileSync(modelFile()), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
  if (buf[0] === 0x89 && buf[1] === 0x50) return PNG.sync.read(buf);
  return null; // WebP/GIF/AVIF/video can't be decoded in Node, so they count as "not scored"
}

const results = [];
const t0 = Date.now();
for (const [i, it] of items.entries()) {
  const buf = readFileSync(join(BENCH, it.file));
  const md = await extractMetadata(buf);
  const fromMeta = evaluate(md);
  let classifier, p = null;
  if (fromMeta.verdict === 'ai' || fromMeta.verdict === 'captured') classifier = { status: 'skipped', reason: 'provenance conclusive' };
  else {
    const img = it.kind === 'image' ? (() => { try { return decode(buf); } catch { return null; } })() : null;
    if (!img) classifier = { status: 'skipped', reason: `not decodable in Node (${it.kind})` };
    else if (Math.min(img.width, img.height) < MODEL.minSide) classifier = { status: 'skipped', reason: 'too small' };
    else {
      const rgba = resizeRGBA(img.data, img.width, img.height);
      if (looksLikeGraphic(rgba)) classifier = { status: 'skipped', reason: 'screenshot/graphic' };
      else {
        const out = await session.run({ [MODEL.inputName]: new ort.Tensor('float32', rgbaToCHW(rgba), [1, 3, MODEL.size, MODEL.size]) });
        p = aiProbability(out[MODEL.outputName].data);
        classifier = { status: 'ok', score: p };
      }
    }
  }
  const r = evaluate(md, classifier);
  results.push({
    id: it.id, subreddit: it.subreddit, label: it.label, kind: it.kind, title: it.title, permalink: it.permalink, url: it.url,
    verdict: r.verdict, flagged: FLAGGED.has(r.verdict), score: r.score, p,
    skipped: classifier.status === 'skipped' ? classifier.reason : null,
    metadataSignals: r.signals.filter((s) => s.source !== 'classifier' && s.strength > 0).map((s) => s.label),
  });
  if ((i + 1) % 25 === 0) process.stdout.write(`  ${i + 1}/${items.length}\n`);
}
writeFileSync(join(RESULTS, 'images.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n');

// ------------------------------------------------------------ report

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : 'n/a');
const lines = [];
const L = (s = '') => lines.push(s);
L('# Hikaku benchmark: soci.ly / Reddit, weak labels');
L();
L(`Generated ${new Date().toISOString()} · ${results.length} items · ${((Date.now() - t0) / 1000).toFixed(0)} s · model uint8/WASM`);
L();
L('> Labels come from the subreddit (r/midjourney counts as AI, r/EarthPorn as real). They are noisy, so read through the disagreement lists below before trusting the numbers.');
L();
L('## Summary by label');
L();
L('| Label | Items | Scored by model | Skipped (graphic / other) | Metadata hits | Flagged (Balanced) |');
L('|---|---:|---:|---:|---:|---:|');
for (const label of ['ai', 'real', 'unknown']) {
  const rs = results.filter((r) => r.label === label);
  if (!rs.length) continue;
  const graphic = rs.filter((r) => r.skipped === 'screenshot/graphic').length;
  const otherSkip = rs.filter((r) => r.skipped && r.skipped !== 'screenshot/graphic' && r.skipped !== 'provenance conclusive').length;
  L(`| ${label} | ${rs.length} | ${rs.filter((r) => r.p != null).length} | ${graphic} / ${otherSkip} | ${rs.filter((r) => r.metadataSignals.length).length} | ${pct(rs.filter((r) => r.flagged).length, rs.length)} |`);
}
L();
L('## Visual model at different thresholds (model-scored items only)');
L();
L('| Threshold | AI caught (TPR) | Real wrongly flagged (FPR) |');
L('|---:|---:|---:|');
const aiP = results.filter((r) => r.label === 'ai' && r.p != null), realP = results.filter((r) => r.label === 'real' && r.p != null);
for (const t of [0.5, 0.7, CLASSIFIER.likely, 0.95, 0.99]) {
  L(`| ${t.toFixed(2)}${t === CLASSIFIER.likely ? ' (default)' : ''} | ${pct(aiP.filter((r) => r.p >= t).length, aiP.length)} (${aiP.length}) | ${pct(realP.filter((r) => r.p >= t).length, realP.length)} (${realP.length}) |`);
}
L();
L('## By subreddit');
L();
L('| Subreddit | Label | Items | Flagged | Median P(AI) | Graphic-skipped |');
L('|---|---|---:|---:|---:|---:|');
const subs = [...new Set(results.map((r) => r.subreddit))];
for (const s of subs) {
  const rs = results.filter((r) => r.subreddit === s);
  const ps = rs.map((r) => r.p).filter((x) => x != null).sort((a, b) => a - b);
  const med = ps.length ? ps[ps.length >> 1].toFixed(2) : 'n/a';
  L(`| r/${s} | ${rs[0].label} | ${rs.length} | ${pct(rs.filter((r) => r.flagged).length, rs.length)} | ${med} | ${rs.filter((r) => r.skipped === 'screenshot/graphic').length} |`);
}
const list = (title, rs) => {
  L(); L(`## ${title}`); L();
  if (!rs.length) { L('_None._'); return; }
  for (const r of rs) L(`- **${r.p != null ? r.p.toFixed(3) : r.verdict}** · r/${r.subreddit} · [${(r.title || r.id).replace(/[[\]]/g, '')}](${r.permalink || r.url})`);
};
list('Likely false positives: "real" items that got flagged (label noise or model error?)', results.filter((r) => r.label === 'real' && r.flagged).sort((a, b) => (b.p ?? 1) - (a.p ?? 1)).slice(0, 15));
list('Likely misses: "ai" items that were not flagged (lowest scores first)', results.filter((r) => r.label === 'ai' && !r.flagged && r.p != null).sort((a, b) => a.p - b.p).slice(0, 15));
list('Provenance hits (metadata survived upload)', results.filter((r) => r.metadataSignals.length).slice(0, 15));
writeFileSync(join(RESULTS, 'images.md'), lines.join('\n') + '\n');
console.log(lines.slice(0, 40).join('\n'));
console.log(`\nFull report: ${join(RESULTS, 'images.md')}`);
