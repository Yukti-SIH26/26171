/**
 * The structure channel: DOM to Element Graph.
 *
 * Walks the rendered document and emits one node per element worth reasoning
 * about. This is one of the two perception channels and it is deliberately not
 * CDP-based, so the exact same code runs on Chrome and Firefox.
 *
 * Privacy is enforced at this layer, not downstream. Values of password fields
 * are never read into the graph at all. A later redaction step cannot leak what
 * was never collected, and that ordering is the difference between a privacy
 * guarantee and a privacy intention.
 */

import {
  ELEMENT_GRAPH_NODE_CAP,
  ELEMENT_GRAPH_SCHEMA_VERSION,
  computeStats,
  EMPTY_FLAGS,
  type ElementGraph,
  type ElementNode,
  type Rect,
  type ViewportInfo,
} from '@sih/core';
import { accessibleName } from './accname.ts';
import { computeRole } from './roles.ts';
import { computeVisibility } from './visibility.ts';
import { ElementRegistry } from './registry.ts';

export interface ExtractOptions {
  /** Cap on emitted nodes, to bound payload size and latency. */
  readonly maxNodes?: number;
  /** Include nodes hidden from users. They are still scanned for PII. */
  readonly includeHidden?: boolean;
  /** Emit layout/text nodes as well as interactive ones. */
  readonly includeStructural?: boolean;
}

const MAX_TEXT_LENGTH = 400;

/**
 * Tags that put pixels on screen rather than text.
 *
 * `iframe`, `object` and `embed` are on the list because the content script runs with
 * `allFrames: false`: whatever a subframe renders is, to us, an image. A cross-origin
 * frame showing the user's own data is exactly the case where that matters.
 */
const IMAGE_TAGS = new Set([
  'img',
  'canvas',
  'svg',
  'video',
  'picture',
  'object',
  'embed',
  'iframe',
  'math',
]);

/** Never walked: no user-visible content, and `<template>` is inert. */
const SKIPPED_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'meta',
  'link',
  'title',
  'head',
  'base',
]);

/**
 * Roles kept even when non-interactive, because they carry the page's meaning:
 * landmarks for orientation, headings and cells for reading data out.
 */
const INFORMATIVE_ROLES = new Set([
  'heading',
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'region',
  'form',
  'search',
  'table',
  'row',
  'cell',
  'columnheader',
  'rowheader',
  'list',
  'listitem',
  'article',
  'dialog',
  'alert',
  'status',
  'img',
]);

function toRect(domRect: DOMRect): Rect {
  return { x: domRect.x, y: domRect.y, width: domRect.width, height: domRect.height };
}

/**
 * Read a control's current value, refusing anything credential-bearing.
 *
 * Returns `undefined` for password inputs rather than a masked string: the point
 * is that the value never enters our data structures, so it cannot later be
 * serialized by a logging change or a new code path.
 */
function safeValue(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();

  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    if (type === 'password') return undefined;
    if (type === 'checkbox' || type === 'radio') {
      return (el as HTMLInputElement).checked ? 'checked' : 'unchecked';
    }
    if (type === 'file') return undefined;
    const value = (el as HTMLInputElement).value;
    return value === '' ? undefined : value.slice(0, MAX_TEXT_LENGTH);
  }

  if (tag === 'textarea') {
    const value = (el as HTMLTextAreaElement).value;
    return value === '' ? undefined : value.slice(0, MAX_TEXT_LENGTH);
  }

  if (tag === 'select') {
    const select = el as HTMLSelectElement;
    const option = select.selectedOptions[0];
    return option === undefined
      ? undefined
      : option.textContent?.trim().slice(0, MAX_TEXT_LENGTH);
  }

  return undefined;
}

/** Controls that participate in constraint validation. */
const VALIDATABLE_TAGS = new Set(['input', 'select', 'textarea']);

interface ValidatableControl {
  readonly validity?: ValidityState;
  readonly validationMessage?: string;
}

/**
 * Resolve the text of the elements an `aria-*` reference points at.
 *
 * A site that does its own validation almost never sets `setCustomValidity`; it renders
 * a red span and wires it up with `aria-errormessage` or `aria-describedby`. Reading
 * that span is the only way to see those failures.
 */
function referencedText(doc: Document, el: Element, attribute: string): string | undefined {
  const ids = el.getAttribute(attribute);
  if (ids === null || ids.trim() === '') return undefined;

  const parts: string[] = [];
  for (const id of ids.trim().split(/\s+/)) {
    const target = doc.getElementById(id);
    const text = target?.textContent?.replace(/\s+/g, ' ').trim();
    if (text !== undefined && text !== '') parts.push(text);
  }

  const joined = parts.join(' ');
  return joined === '' ? undefined : joined.slice(0, MAX_TEXT_LENGTH);
}

/**
 * Is this field being rejected, and what does the page say about it?
 *
 * Both halves of the answer are needed. A live run clicked the same submit button three
 * times while Chrome held a validation bubble open next to a field the agent could not
 * see; nothing in the packet said the page had refused, so every retry looked to the
 * model like the first attempt.
 */
function validationState(
  doc: Document,
  el: Element,
): { readonly invalid: boolean; readonly message?: string } {
  const flaggedByPage = el.getAttribute('aria-invalid') === 'true';
  let nativeMessage: string | undefined;

  if (VALIDATABLE_TAGS.has(el.tagName.toLowerCase())) {
    // `validity` is absent in some non-browser DOM implementations, so this is read
    // defensively rather than asserted.
    const control = el as unknown as ValidatableControl;
    const validity = control.validity;
    if (validity !== undefined && !validity.valid && !validity.valueMissing) {
      const message = control.validationMessage;
      nativeMessage =
        message === undefined || message === '' ? 'the value is not accepted' : message;
    }
  }

  if (nativeMessage === undefined && !flaggedByPage) return { invalid: false };

  const pageMessage =
    referencedText(doc, el, 'aria-errormessage') ?? referencedText(doc, el, 'aria-describedby');

  const message = pageMessage ?? nativeMessage;
  return message === undefined ? { invalid: true } : { invalid: true, message };
}

/** Cap on the option labels read from one `<select>`. */
const MAX_OPTIONS = 40;

/**
 * The labels a `<select>` will actually accept.
 *
 * Without them the model has to guess the wording of an option, and "Semester 5" against
 * a list reading "SEM-5" fails locally every time. Listing them turns selection from a
 * guess into a choice.
 */
function selectOptions(el: Element): readonly string[] | undefined {
  if (el.tagName.toLowerCase() !== 'select') return undefined;

  const labels: string[] = [];
  for (const option of Array.from(el.querySelectorAll('option'))) {
    const label = (option.getAttribute('label') ?? option.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (label !== '') labels.push(label.slice(0, 80));
    if (labels.length >= MAX_OPTIONS) break;
  }

  return labels.length === 0 ? undefined : labels;
}

/** Own text, excluding descendants, so a container does not absorb the page. */
function ownText(el: Element): string | undefined {
  let text = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized === '' ? undefined : normalized.slice(0, MAX_TEXT_LENGTH);
}

function shouldEmit(
  role: string,
  interactive: boolean,
  hasName: boolean,
  hasText: boolean,
  paintsImage: boolean,
  includeStructural: boolean,
): boolean {
  if (interactive) return true;
  if (INFORMATIVE_ROLES.has(role)) return true;
  // Emitted whatever else is true of it, and regardless of `includeStructural`. An
  // unlabelled `<canvas>`, a cross-origin `<iframe>`, and a `<div>` with a
  // `background-image` all have no role, no name and no text, so every other rule here
  // drops them — and each one is a surface that can be showing the user's data in
  // pixels. Dropping them made the graph unable to answer "is there anything in this
  // screenshot that is not also in this graph", which is the question the OCR decision
  // rests on.
  if (paintsImage) return true;
  if (includeStructural && (hasName || hasText)) return true;
  return false;
}

export interface ExtractResult {
  readonly graph: ElementGraph;
  readonly registry: ElementRegistry;
  /** Wall-clock cost of the walk, reported against the resource criterion. */
  readonly durationMs: number;
  readonly elementsVisited: number;
}

export function extractElementGraph(
  doc: Document,
  registry: ElementRegistry,
  options: ExtractOptions = {},
): ExtractResult {
  const started = performance.now();
  const maxNodes = options.maxNodes ?? ELEMENT_GRAPH_NODE_CAP;
  const includeHidden = options.includeHidden ?? true;
  const includeStructural = options.includeStructural ?? true;

  const view = doc.defaultView;
  const viewport: ViewportInfo = {
    width: view?.innerWidth ?? 0,
    height: view?.innerHeight ?? 0,
    scrollX: view?.scrollX ?? 0,
    scrollY: view?.scrollY ?? 0,
    devicePixelRatio: view?.devicePixelRatio ?? 1,
  };

  const nodes: ElementNode[] = [];
  const idToNodeIndex = new Map<string, number>();
  // Forms are numbered from 1 in the order they are first met, so the numbers read the
  // way the page does. 0 is reserved for editable controls that belong to no `<form>`.
  const formIndices = new Map<Element, number>();
  let visited = 0;
  let order = 0;

  const walker = doc.createTreeWalker(
    doc.body ?? doc.documentElement,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node: Node): number {
        const tag = (node as Element).tagName.toLowerCase();
        // Reject the whole subtree for inert containers.
        return SKIPPED_TAGS.has(tag) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    },
  );

  // Track the nearest emitted ancestor so parent links reflect the emitted
  // graph rather than the raw DOM, which is far deeper than anything useful.
  const ancestorStack: Array<{ el: Element; id: string }> = [];

  let current: Node | null = walker.currentNode;
  while (current !== null && nodes.length < maxNodes) {
    const el = current as Element;
    visited++;

    while (
      ancestorStack.length > 0 &&
      !(ancestorStack[ancestorStack.length - 1] as { el: Element }).el.contains(el)
    ) {
      ancestorStack.pop();
    }

    const role = computeRole(el);
    const domRect = el.getBoundingClientRect();
    const rect = toRect(domRect);
    const facts = computeVisibility(el, role, domRect, viewport);

    if (includeHidden || !facts.hidden) {
      const name = accessibleName(el, role);
      const text = ownText(el);
      const paintsImage = IMAGE_TAGS.has(el.tagName.toLowerCase()) || facts.rasterBackground;
      if (
        shouldEmit(
          role,
          facts.interactive,
          name !== '',
          text !== undefined,
          paintsImage,
          includeStructural,
        )
      ) {
        const id = registry.idFor(el);
        const parent = ancestorStack[ancestorStack.length - 1];
        const tag = el.tagName.toLowerCase();
        const inputType =
          tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : undefined;
        const autocomplete = el.getAttribute('autocomplete');
        const placeholder = el.getAttribute('placeholder');
        // The form control's own identifier. Often more literal about what the
        // field holds than the visible label: `name="txtAadharNo"` next to a
        // label that just says "Enter number".
        const fieldName = el.getAttribute('name') ?? el.getAttribute('id');
        const value = safeValue(el);
        const validation = validationState(doc, el);
        const options = selectOptions(el);

        // Which form does this belong to? Only controls get a group: putting every
        // interactive element in one would make the grouping a second copy of the page.
        let formId: number | undefined;
        const ownerForm = el.closest('form');
        if (ownerForm !== null && (facts.editable || facts.interactive)) {
          const existing = formIndices.get(ownerForm);
          if (existing === undefined) {
            formId = formIndices.size + 1;
            formIndices.set(ownerForm, formId);
          } else {
            formId = existing;
          }
        } else if (facts.editable) {
          formId = 0;
        }

        const node: ElementNode = {
          id,
          role,
          name,
          rect,
          source: 'structure',
          // The structure channel reads facts rather than predicting them, so
          // there is no uncertainty to express here. The pixel channel carries
          // real detector scores.
          confidence: 1,
          flags: {
            ...EMPTY_FLAGS,
            interactive: facts.interactive,
            focusable: facts.focusable,
            editable: facts.editable,
            disabled: facts.disabled,
            hidden: facts.hidden,
            inViewport: facts.inViewport,
          },
          order: order++,
          tag,
          ...(parent === undefined ? {} : { parentId: parent.id }),
          ...(inputType === undefined ? {} : { inputType }),
          ...(autocomplete === null || autocomplete === '' ? {} : { autocomplete }),
          ...(placeholder === null || placeholder === '' ? {} : { placeholder }),
          ...(fieldName === null || fieldName === '' ? {} : { fieldName }),
          ...(text === undefined ? {} : { text }),
          ...(value === undefined ? {} : { value }),
          ...(el.hasAttribute('required') || el.getAttribute('aria-required') === 'true'
            ? { required: true }
            : {}),
          ...(formId === undefined ? {} : { formId }),
          ...(validation.invalid ? { invalid: true } : {}),
          ...(validation.message === undefined
            ? {}
            : { validationMessage: validation.message }),
          ...(options === undefined ? {} : { options }),
          ...(paintsImage ? { paintsImage: true } : {}),
        };

        idToNodeIndex.set(id, nodes.length);
        nodes.push(node);
        ancestorStack.push({ el, id });
      }
    }

    current = walker.nextNode();
  }

  const graph: ElementGraph = {
    schemaVersion: ELEMENT_GRAPH_SCHEMA_VERSION,
    url: doc.location?.href ?? '',
    title: doc.title,
    viewport,
    capturedAt: Date.now(),
    nodes,
    stats: computeStats(nodes),
  };

  return {
    graph,
    registry,
    durationMs: performance.now() - started,
    elementsVisited: visited,
  };
}
