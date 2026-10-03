/**
 * Local model catalogue.
 *
 * Every model listed here ships *inside* the extension. There is no remote
 * loading path, so a model that is not bundled is not available — which is why
 * this list is short and why each entry records its real on-disk cost.
 *
 * Licences are recorded here rather than in a document, because they constrain
 * what we can ship. `yolov10n` is popular, small, and available for
 * transformers.js, and is deliberately absent: it is AGPL-3.0, which would force
 * this entire codebase open under the same terms.
 *
 * Also considered and rejected:
 *   grounding-dino-tiny  smallest variant is 144 MiB, over GitHub's per-file cap
 *                        even before splitting, and no better at UI than OWL-ViT
 *   owlv2-*              more accurate, materially heavier, same 100 MiB problem
 *   rtdetr-r18 / detr    20-41 MiB and tempting, but they are fixed-class COCO
 *                        detectors. COCO has no button, no text field, no
 *                        dropdown. Useful later for faces in page imagery;
 *                        useless for UI structure.
 */

export type ModelTask =
  /** Text-queried detection: ask for "a button" and get boxes, no training. */
  | 'zero-shot-object-detection'
  /** Text out of pixels. */
  | 'ocr';

export type ModelLicence = 'Apache-2.0' | 'MIT';

/**
 * Weight precision.
 *
 * Fixed per model by whatever was bundled, not chosen at runtime — there is only
 * one file on disk.
 */
export type Quantization = 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';

export interface ModelSpec {
  readonly key: string;
  /**
   * Hugging Face repo id. Used purely as a *local directory name*: the weights
   * are read from `models/<repo>/…` inside the extension. It is a provenance
   * record, not a network address.
   */
  readonly repo: string;
  readonly task: ModelTask;
  readonly licence: ModelLicence;
  /** Bytes this model occupies inside the extension package, in MiB. */
  readonly bundledMb: number;
  /** Approximate resident memory once loaded, in MiB. Always exceeds on-disk. */
  readonly residentMb: number;
  readonly quantization: Quantization;
  /**
   * How many ONNX external-data chunks the weights are split across, or 0 when
   * weights are inline. Must match what `scripts/split_onnx.py` produced;
   * transformers.js derives the filenames from this count.
   */
  readonly externalDataChunks: number;
  readonly purpose: string;
}

/**
 * OWL-ViT base/patch32, int8 — the primary detector.
 *
 * patch32 rather than patch16: 4x fewer image patches, which on an integrated
 * GPU is the difference between usable and not.
 *
 * int8 (`model_quantized.onnx`, addressed as dtype `q8`) after q4 was found to be
 * unloadable. The 4-bit graph cannot be partitioned by ONNX Runtime Web: it fails
 * at session creation with
 *
 *   Provider type for Cast node with name '/class_head/Cast' is not set
 *
 * on the WebGPU provider *and* on WASM, which meant the pixel channel never ran on
 * a real machine. Op coverage therefore outranks file size in this choice: int8 is
 * the smallest variant the CPU backend fully supports. `model_uint8.onnx` is the
 * equivalent second choice; fp32 works too, at 612 MiB.
 *
 * The 148 MiB of weights are split into two external-data chunks (97.0 + 49.4 MiB)
 * so every committed file stays under GitHub's 100 MiB limit. The tensors are
 * bit-identical to the single-file original; only the storage layout differs.
 */
export const OWLVIT_BASE32: ModelSpec = {
  key: 'owlvit-base-patch32',
  repo: 'Xenova/owlvit-base-patch32',
  task: 'zero-shot-object-detection',
  licence: 'Apache-2.0',
  bundledMb: 149,
  residentMb: 460,
  quantization: 'q8',
  externalDataChunks: 2,
  purpose:
    'Finds UI controls from plain-text queries such as "a button" or "a text input field".',
};

/**
 * Tesseract.js: the only OCR engine that runs in a browser with no ONNX
 * conversion, which is why it is here rather than a transformer OCR model.
 *
 * English only. Devanagari and other Indian scripts are materially worse — a
 * stated limitation, not a solved problem. A regional-language portal will have
 * lower OCR recall, and the DOM channel has to carry more of the load there.
 */
export const TESSERACT_ENG: ModelSpec = {
  key: 'tesseract-eng',
  repo: 'builtin:tesseract.js',
  task: 'ocr',
  licence: 'Apache-2.0',
  bundledMb: 10,
  residentMb: 180,
  quantization: 'fp32',
  externalDataChunks: 0,
  purpose: 'Reads text that exists only as pixels: canvas, images, scanned documents.',
};

/**
 * ONNX Runtime's own WebAssembly build.
 *
 * Not a model, but it is 26 MiB of bundled weight-equivalent that the honest
 * accounting has to include, and forgetting it is how transformers.js ends up
 * silently fetching it from a CDN instead.
 */
export const ORT_RUNTIME_MB = 26;

export const MODEL_CATALOGUE: readonly ModelSpec[] = [OWLVIT_BASE32, TESSERACT_ENG] as const;

export function modelByKey(key: string): ModelSpec | undefined {
  return MODEL_CATALOGUE.find((m) => m.key === key);
}

/** Detectors the user can select. OCR is a companion, not an alternative. */
export function detectorSpecs(): readonly ModelSpec[] {
  return MODEL_CATALOGUE.filter((m) => m.task !== 'ocr');
}

/** One detector plus OCR: what actually runs. */
export const DEFAULT_STACK: readonly ModelSpec[] = [OWLVIT_BASE32, TESSERACT_ENG] as const;

export function totalResidentMb(models: readonly ModelSpec[]): number {
  return models.reduce((sum, m) => sum + m.residentMb, 0);
}

export function totalBundledMb(models: readonly ModelSpec[]): number {
  return models.reduce((sum, m) => sum + m.bundledMb, 0);
}

export type FitVerdict = 'comfortable' | 'tight' | 'over-budget';

/**
 * Will this stack fit in memory?
 *
 * Budgets against roughly half of system RAM, since the browser, the page, and
 * the rest of the OS also need room. Reporting "tight" rather than a boolean is
 * more useful, because tight still works — it is just slow, and the user
 * deserves to know that before waiting on a load.
 */
export function assessFit(models: readonly ModelSpec[], ramGb: number | null): FitVerdict {
  const needMb = totalResidentMb(models);
  if (ramGb === null) return needMb > 700 ? 'tight' : 'comfortable';
  const budgetMb = ramGb * 1024 * 0.5;
  if (needMb > budgetMb) return 'over-budget';
  if (needMb > budgetMb * 0.6) return 'tight';
  return 'comfortable';
}

/**
 * Text queries for the zero-shot detector.
 *
 * This is the entire "training" for UI detection in the zero-shot phase: plain
 * English descriptions of what a control looks like. It is crude, and it is the
 * honest reason a fine-tuned detector is still on the roadmap — a model trained
 * on real UI screenshots will beat these phrases by a wide margin.
 *
 * Kept deliberately short. Each query is a separate forward pass through the text
 * encoder, so the list length is a direct latency cost.
 */
export const UI_QUERIES: readonly string[] = [
  'a button',
  'a text input field',
  'a dropdown menu',
  'a checkbox',
  'a link',
  'an icon button',
  'a search box',
  'a human face',
  'a photograph of a person',
  'a handwritten signature',
] as const;

/**
 * Maps a detector label back to an element role.
 *
 * Order matters: "a search box" must be tested before the generic "box"/"input"
 * cases, and "an icon button" before "button", or the more specific role is lost.
 */
export function queryToRole(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('face') || l.includes('photograph') || l.includes('signature')) return 'img';
  if (l.includes('checkbox')) return 'checkbox';
  if (l.includes('dropdown')) return 'combobox';
  if (l.includes('search')) return 'searchbox';
  if (l.includes('text input')) return 'textbox';
  if (l.includes('link')) return 'link';
  if (l.includes('button')) return 'button';
  return 'generic';
}

/**
 * Queries whose detections are candidates for *visual* PII rather than controls.
 *
 * A detected face is not something to click; it is something to cover before a
 * screenshot leaves the machine.
 */
/** Resolve a zero-shot visual label to the sensitive type it represents. */
export function visualPiiType(label: string): 'face' | 'signature' | undefined {
  const l = label.toLowerCase();
  if (l.includes('signature')) return 'signature';
  if (l.includes('face') || l.includes('photograph') || l.includes('person')) return 'face';
  return undefined;
}

export function isVisualPiiQuery(label: string): boolean {
  return visualPiiType(label) !== undefined;
}
