/**
 * The Element Graph: the single canonical description of what is on screen.
 *
 * Two independent perception channels produce nodes:
 *  - `structure`: DOM walk computing ARIA role, accessible name, geometry.
 *    Reliable where the page is well built, blind on canvas and div soup.
 *  - `pixel`: vision models over a screenshot. Markup-independent, so it sees
 *    image-only buttons and canvas UIs that the structure channel cannot.
 *
 * Fusion merges them by spatial overlap into `fused` nodes. Neither channel is
 * a fallback for the other; they are peers.
 *
 * The graph is also the redaction surface and the action target space, so
 * element IDs must stay stable across re-observation of an unchanged page.
 */

import type { Rect } from './geometry.ts';

/** Opaque stable handle for an element. Format: `el_<n>`. */
export type ElementId = string;

export type ElementSource = 'structure' | 'pixel' | 'fused';

/**
 * ARIA role, or a pixel-channel detector label.
 * Kept as a string rather than a union because the ARIA role set is large,
 * open, and versioned independently of this code.
 */
export type ElementRole = string;

export interface ElementFlags {
  /** Reachable by click/keyboard in principle (button, link, input, [role] widget). */
  interactive: boolean;
  focusable: boolean;
  /** Accepts text entry: input, textarea, or contenteditable. */
  editable: boolean;
  disabled: boolean;
  /** Not rendered: display:none, visibility:hidden, aria-hidden, zero box. */
  hidden: boolean;
  inViewport: boolean;
  /**
   * Another element sits on top of this one's centre point.
   * Filled in by the pre-execution overlay check, not during observation.
   */
  obscured: boolean;
}

export const EMPTY_FLAGS: ElementFlags = {
  interactive: false,
  focusable: false,
  editable: false,
  disabled: false,
  hidden: false,
  inViewport: false,
  obscured: false,
};

export interface ElementNode {
  id: ElementId;
  role: ElementRole;
  /** Accessible name per the AccName algorithm, or a pixel-channel caption. */
  name: string;
  rect: Rect;
  source: ElementSource;
  /** 0..1. Structure-channel nodes are 1; pixel-channel nodes carry detector score. */
  confidence: number;
  flags: ElementFlags;

  parentId?: ElementId;
  /** Frame this node came from. Absent means the top-level document. */
  frameId?: string;
  /** Position in document order, for stable serialization and reading order. */
  order?: number;

  // Structure-channel only. These are the cheapest and most authoritative
  // signals available for PII detection, so they are first-class fields.
  tag?: string;
  /** `input[type]`, lowercased. `password` here is a certainty, not a guess. */
  inputType?: string;
  /** `autocomplete` attribute, e.g. `cc-number`, `tel`, `street-address`. */
  autocomplete?: string;
  /**
   * The `name` or `id` attribute of a form control.
   *
   * Kept separately from the accessible name because they often disagree in ways
   * that matter: a field can render the label "Enter number" while carrying
   * `name="txtAadharNo"`. The attribute is written for the server and tends to be
   * more literal about what the field holds than the text shown to the user.
   */
  fieldName?: string;
  placeholder?: string;
  /** Visible text content, trimmed and length-capped. Redaction rewrites this. */
  text?: string;
  /** Current field value. Redaction rewrites this. */
  value?: string;
  required?: boolean;

  /**
   * Which form this control belongs to. `0` means "editable, but in no `<form>`".
   *
   * Grouping matters because a form is the unit a task is completed in. Without it
   * the agent saw a flat list of boxes and could not tell the header search field
   * from the eleven login fields below it, so it treated whatever was on screen as
   * the whole job and submitted half a form.
   *
   * `0` is a real group rather than an absence because most modern sign-in pages use
   * no `<form>` element at all; treating those fields as ungrouped would leave the
   * grouping empty on exactly the pages that need it.
   */
  formId?: number;

  /**
   * Constraint validation is failing for a reason other than "required and empty".
   *
   * Empty-and-required is deliberately excluded. Every blank required field reports
   * `valueMissing` from the moment the page loads, so including it would mark a
   * pristine form as entirely invalid — noise that buries the one field the user
   * actually typed wrongly. Emptiness is already carried by `required` plus the
   * absence of a value.
   */
  invalid?: boolean;

  /**
   * Why the field is rejected, as the page or the browser puts it.
   *
   * Either the UA's own constraint message or the text of the element referenced by
   * `aria-errormessage`/`aria-describedby`. The second source is page content and can
   * carry anything, so this is treated as untrusted and redacted like any other text.
   */
  validationMessage?: string;

  /** Choosable labels of a `<select>`, so a value can be picked rather than guessed. */
  options?: readonly string[];

  /**
   * This element paints a raster image of its own: `<img>`, `<canvas>`, an `<iframe>`
   * we cannot script, or a CSS `background-image`.
   *
   * The reason it is recorded is privacy, not layout. Text inside a picture has no DOM
   * representation, so nothing in this graph describes it, and the screenshot is
   * transmitted. Knowing exactly where such surfaces are is what lets OCR be pointed at
   * them instead of run across the whole frame — and lets it be skipped honestly when
   * there are none, because then every string in the picture is also a string in this
   * graph.
   */
  paintsImage?: boolean;

  /** Pixel-channel extras: detector label, raw score, OCR confidence. */
  detectorMeta?: Readonly<Record<string, unknown>>;
}

export interface ViewportInfo {
  readonly width: number;
  readonly height: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly devicePixelRatio: number;
}

export interface GraphStats {
  readonly structureCount: number;
  readonly pixelCount: number;
  readonly fusedCount: number;
  /** Nodes the pixel channel found that the structure channel missed entirely. */
  readonly pixelOnlyCount: number;
}

export interface ElementGraph {
  readonly schemaVersion: 1;
  /** Page URL. Sanitized before egress: query params can carry PII. */
  readonly url: string;
  readonly title: string;
  readonly viewport: ViewportInfo;
  readonly capturedAt: number;
  readonly nodes: readonly ElementNode[];
  readonly stats: GraphStats;
}

export const ELEMENT_GRAPH_SCHEMA_VERSION = 1 as const;

/**
 * Most nodes one walk will emit.
 *
 * Shared rather than local to the extractor because reaching it is a fact the rest of
 * the system has to reason about: a truncated graph means some of what the screenshot
 * shows was never read as text, so a caller deciding whether pixels need screening has
 * to know the walk ran out of room.
 */
export const ELEMENT_GRAPH_NODE_CAP = 1500;

export function formatElementId(index: number): ElementId {
  return `el_${index}`;
}

export function isElementId(value: unknown): value is ElementId {
  return typeof value === 'string' && /^el_\d+$/.test(value);
}

export function findNode(graph: ElementGraph, id: ElementId): ElementNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

/**
 * Elements an action could plausibly target: interactive, enabled, rendered.
 * The action validator uses this to reject stale or impossible targets.
 */
export function actionableNodes(graph: ElementGraph): ElementNode[] {
  return graph.nodes.filter((n) => n.flags.interactive && !n.flags.disabled && !n.flags.hidden);
}

export function computeStats(nodes: readonly ElementNode[]): GraphStats {
  let structureCount = 0;
  let pixelCount = 0;
  let fusedCount = 0;
  for (const n of nodes) {
    if (n.source === 'structure') structureCount++;
    else if (n.source === 'pixel') pixelCount++;
    else fusedCount++;
  }
  return { structureCount, pixelCount, fusedCount, pixelOnlyCount: pixelCount };
}

export function emptyGraph(url: string, title: string, viewport: ViewportInfo): ElementGraph {
  return {
    schemaVersion: ELEMENT_GRAPH_SCHEMA_VERSION,
    url,
    title,
    viewport,
    capturedAt: Date.now(),
    nodes: [],
    stats: { structureCount: 0, pixelCount: 0, fusedCount: 0, pixelOnlyCount: 0 },
  };
}
