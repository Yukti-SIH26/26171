#!/usr/bin/env node
/**
 * Build the extension's bundled model assets.
 *
 * Everything the perception layer needs ships *inside* the extension. There is
 * no runtime download path at all — `env.allowRemoteModels` is false, so if a
 * file is missing the model simply fails to load rather than quietly reaching
 * out to a CDN.
 *
 * Reasons this is worth the size:
 *   - The problem statement requires offline deployment. Bundled weights make
 *     that unconditionally true.
 *   - A 180 MiB download during a live demo on venue wifi is a demo that fails.
 *   - Asking a CDN for a model tells that CDN you are running this extension.
 *     Small, but it is a hole in a privacy tool.
 *
 * The weights are too large to commit as one file, so they are split into ONNX
 * external-data chunks under GitHub's 100 MiB per-file limit. That split is
 * reproducible from this script, and the outputs are gitignored.
 *
 * Run once after cloning:  npm run assets
 */

import { createWriteStream } from 'node:fs';
import { mkdir, stat, copyFile, readdir, rm, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// This file lives at packages/scripts/, so the repository root is two levels up.
const ROOT = resolve(HERE, '..', '..');
const PUBLIC = join(ROOT, 'packages', 'extension', 'src', 'public');
const NODE_MODULES = join(ROOT, 'node_modules');
const CACHE = join(ROOT, '.cache', 'onnx');

const MODEL_ID = 'Xenova/owlvit-base-patch32';
const HF = 'https://huggingface.co';

/**
 * int8 (`model_quantized.onnx`), addressed by transformers.js as dtype `q8`.
 *
 * This used to be `model_q4.onnx`, chosen on the theory that 4-bit was the one
 * variant both execution providers could run. That turned out to be false in the
 * only way that matters: ONNX Runtime cannot assign the classification head's
 * `Cast` node to any provider in the 4-bit graph, so session creation fails
 * outright — on WebGPU *and* on WASM — with
 *
 *   Provider type for Cast node with name '/class_head/Cast' is not set
 *
 * A model that cannot open is not a trade-off, so the choice is now made on op
 * coverage rather than on size. int8 is the smallest variant with full CPU-backend
 * coverage; `model_uint8.onnx` is the equivalent second choice, fp32 the fallback
 * of last resort at 612 MiB.
 *
 * 155 MiB splits into two chunks well under the 100 MiB per-file ceiling.
 */
const ONNX_FILE = 'model_quantized.onnx';

/** Chunk ceiling in MiB. GitHub rejects at 100 MiB; this leaves headroom. */
const CHUNK_LIMIT = 97;

/**
 * Small files fetched verbatim.
 *
 * The tokenizer files are not optional: this is a *text-queried* detector, so
 * the UI queries ("a button", "a text input field") are tokenized locally at
 * inference time.
 */
const SUPPORT_FILES = [
  'config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'vocab.json',
  'merges.txt',
];

/**
 * ONNX Runtime's own wasm is deliberately NOT copied here.
 *
 * It still has to be local — left to itself, transformers.js fetches it from
 * jsDelivr, which would reintroduce the network and be blocked by MV3's CSP. But
 * `src/models/env.ts` imports it with Vite's `?url`, so the bundler emits it once
 * and reports the final path. Copying it here as well would ship 26 MiB twice, and
 * a hand-copied file would not fail the build if it went missing.
 */

/** OCR engine files, copied out of node_modules rather than fetched. */
const TESSERACT_COPIES = [
  // Loading the worker from a real extension file rather than a blob: URL is
  // required — MV3's content security policy forbids blob-backed workers.
  ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  ['tesseract.js-core/LICENSE', 'LICENSE-tesseract-core.txt'],
];

/**
 * English traineddata, integer-quantized "best" variant: the accuracy of the
 * LSTM best models at roughly a third of the size.
 */
const TRAINEDDATA =
  'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz';

const MB = 1024 * 1024;

function mib(bytes) {
  return `${(bytes / MB).toFixed(1)} MiB`;
}

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

/**
 * Expected size of a remote file, or 0 when the server will not say.
 *
 * Hugging Face serves LFS-backed files through a redirect and does not always
 * return `content-length` on a HEAD, but it does expose `x-linked-size` on the
 * hub response. Treating an unknown size as 0 and handling that case explicitly
 * is what keeps this from looping on a file it cannot measure.
 */
async function remoteSize(url) {
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    const direct = Number(head.headers.get('content-length') ?? '0');
    if (direct > 0) return direct;
    return Number(head.headers.get('x-linked-size') ?? '0');
  } catch {
    return 0;
  }
}

/**
 * Download with resume.
 *
 * The Hugging Face CDN drops long connections often enough that a single
 * straight-through fetch of 180 MiB fails more often than it succeeds, so this
 * writes to a `.part` file, resumes from whatever is already there, and only
 * promotes it to the real name once the size is confirmed.
 */
async function download(url, dest, label, { attempts = 15 } = {}) {
  await mkdir(dirname(dest), { recursive: true });

  const expected = await remoteSize(url);
  const have = await sizeOf(dest);
  if (have > 0 && (expected === 0 || have === expected)) {
    console.log(`  have  ${label} (${mib(have)})`);
    return have;
  }

  const part = `${dest}.part`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let from = Math.max(0, await sizeOf(part));

    // A partial longer than the source can only be corrupt; start clean.
    if (expected > 0 && from > expected) {
      await rm(part, { force: true });
      from = 0;
    }
    if (expected > 0 && from === expected) break;

    // Resume is only safe when we know the total, otherwise a 200 response to a
    // Range request would silently append a second copy of the whole body.
    const resuming = from > 0 && expected > 0;
    const headers = resuming ? { Range: `bytes=${String(from)}-` } : {};
    if (!resuming && from > 0) {
      await rm(part, { force: true });
      from = 0;
    }

    process.stdout.write(
      `  get   ${label} ${
        resuming ? `resume ${mib(from)}/${mib(expected)}` : expected > 0 ? mib(expected) : '?'
      } … `,
    );

    try {
      const res = await fetch(url, { headers, redirect: 'follow' });

      // The range is already satisfied: what we have is the whole file.
      if (res.status === 416) {
        console.log('complete');
        break;
      }
      if (res.body === null || (res.status !== 200 && res.status !== 206)) {
        throw new Error(`HTTP ${String(res.status)}`);
      }

      const append = res.status === 206 && resuming;
      await pipeline(
        Readable.fromWeb(res.body),
        createWriteStream(part, append ? { flags: 'a' } : {}),
      );
      console.log('ok');

      const written = await sizeOf(part);
      if (expected === 0 || written === expected) break;
    } catch (error) {
      console.log(`interrupted (${error instanceof Error ? error.message : 'unknown'})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const written = await sizeOf(part);
  if (written <= 0) throw new Error(`${label}: nothing downloaded`);
  if (expected > 0 && written !== expected) {
    throw new Error(`${label}: got ${mib(written)}, expected ${mib(expected)}`);
  }

  await rename(part, dest);
  return written;
}

async function copyFromNodeModules(from, to) {
  const src = join(NODE_MODULES, ...from.split('/'));
  const size = await sizeOf(src);
  if (size < 0) throw new Error(`missing ${from} in node_modules — run npm install first`);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(src, to);
  console.log(`  copy  ${to.replace(PUBLIC, 'public')} (${mib(size)})`);
  return size;
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${String(code)}`));
    });
  });
}

async function totalSize(dir) {
  let sum = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    sum += entry.isDirectory() ? await totalSize(full) : await sizeOf(full);
  }
  return sum;
}

async function listOversized(dir, limitBytes) {
  const out = [];
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const size = await sizeOf(full);
        if (size >= limitBytes) out.push([full.replace(PUBLIC, 'public'), size]);
      }
    }
  };
  await walk(dir);
  return out;
}

async function main() {
  console.log('Yukti assets — bundling local models into the extension\n');

  const modelDir = join(PUBLIC, 'models', ...MODEL_ID.split('/'));
  const onnxDir = join(modelDir, 'onnx');
  const source = join(CACHE, ONNX_FILE);

  console.log(`${MODEL_ID} — support files`);
  for (const file of SUPPORT_FILES) {
    await download(`${HF}/${MODEL_ID}/resolve/main/${file}`, join(modelDir, file), file);
  }

  console.log(`\n${MODEL_ID} — weights`);
  await download(`${HF}/${MODEL_ID}/resolve/main/onnx/${ONNX_FILE}`, source, ONNX_FILE);

  // Chunks from a previously bundled variant. Left behind they would ship a second
  // set of weights the extension never loads — 180 MiB of dead payload, and a
  // confusing directory for anybody checking what is actually in the build.
  try {
    for (const entry of await readdir(onnxDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith(ONNX_FILE)) continue;
      if (!entry.name.endsWith('.onnx') && !entry.name.includes('.onnx_data')) continue;
      await rm(join(onnxDir, entry.name), { force: true });
      console.log(`  prune ${entry.name} (no longer bundled)`);
    }
  } catch {
    // No directory yet: nothing to prune.
  }

  const alreadySplit = await sizeOf(join(onnxDir, `${ONNX_FILE}_data`));
  if (alreadySplit > 0) {
    console.log(`  have  split chunks already present, skipping split`);
  } else {
    console.log(`\nsplitting ${ONNX_FILE} into chunks under ${String(CHUNK_LIMIT)} MiB`);
    await run('python', [
      join(HERE, 'split_onnx.py'),
      source,
      '--out',
      onnxDir,
      '--limit',
      String(CHUNK_LIMIT),
    ]);
  }

  console.log('\ntesseract.js — OCR engine');
  const tessDir = join(PUBLIC, 'tesseract');
  for (const [from, to] of TESSERACT_COPIES) {
    await copyFromNodeModules(from, join(tessDir, to));
  }
  await download(TRAINEDDATA, join(tessDir, 'eng.traineddata.gz'), 'eng.traineddata.gz');

  const bundled = await totalSize(PUBLIC);
  const oversized = await listOversized(PUBLIC, 100 * MB);

  console.log(`\n${mib(bundled)} bundled. Nothing is fetched at runtime.`);

  if (oversized.length > 0) {
    console.error("\nFAILED — these files are at or over GitHub's 100 MiB limit:");
    for (const [path, size] of oversized) console.error(`  ${path}  ${mib(size)}`);
    process.exit(1);
  }
  console.log('Every bundled file is under the 100 MiB GitHub limit.');
}

main().catch((error) => {
  console.error(`\nfailed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
