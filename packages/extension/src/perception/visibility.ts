/**
 * Visibility, interactivity, and editability.
 *
 * Two distinctions matter and are easy to conflate:
 *
 *  - Hidden from *users*: display:none, visibility:hidden, zero-size, or
 *    aria-hidden. An agent must not try to click these.
 *  - Hidden but *present*: rendered off-screen, or scrolled out of view. Real
 *    and clickable after scrolling, so they stay in the graph.
 *
 * Getting this wrong in either direction is costly: treat hidden nodes as real
 * and the planner targets phantoms; drop off-screen nodes and the agent cannot
 * scroll to anything.
 *
 * It also matters for privacy. `display:none` fields routinely hold prefilled
 * personal data and CSRF tokens, so they are still scanned for PII even though
 * they are never action targets.
 */

import { roleIsInteractive, roleIsTextEntry } from './roles.ts';

export interface VisibilityFacts {
  readonly hidden: boolean;
  readonly inViewport: boolean;
  readonly interactive: boolean;
  readonly focusable: boolean;
  readonly editable: boolean;
  readonly disabled: boolean;
  /**
   * A CSS `background-image` paints a raster here.
   *
   * Read off the computed style this function already fetched, so it costs nothing.
   * Gradients are excluded — only a `url()` reference can put text on screen that the
   * DOM does not describe.
   */
  readonly rasterBackground: boolean;
}

const NATIVELY_DISABLEABLE = new Set([
  'button',
  'fieldset',
  'input',
  'optgroup',
  'option',
  'select',
  'textarea',
]);

function isDisabled(el: Element): boolean {
  if (el.getAttribute('aria-disabled') === 'true') return true;
  const tag = el.tagName.toLowerCase();
  if (NATIVELY_DISABLEABLE.has(tag)) {
    if (el.hasAttribute('disabled')) return true;
    // `disabled` on a fieldset cascades to its descendants.
    const fieldset = el.closest('fieldset[disabled]');
    if (fieldset !== null) return true;
  }
  return false;
}

function isAriaHidden(el: Element): boolean {
  // aria-hidden inherits down the tree, so an ancestor decides too.
  return el.closest('[aria-hidden="true"]') !== null;
}

function isEditable(el: Element, role: string): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    return ![
      'button',
      'submit',
      'reset',
      'image',
      'checkbox',
      'radio',
      'file',
      'hidden',
    ].includes(type);
  }
  if (
    el.getAttribute('contenteditable') === 'true' ||
    el.getAttribute('contenteditable') === ''
  ) {
    return true;
  }
  return roleIsTextEntry(role) && el.getAttribute('aria-readonly') !== 'true';
}

function isFocusable(el: Element): boolean {
  const tabIndex = el.getAttribute('tabindex');
  if (tabIndex !== null) {
    const parsed = Number.parseInt(tabIndex, 10);
    if (!Number.isNaN(parsed)) return parsed >= 0;
  }
  const tag = el.tagName.toLowerCase();
  if (tag === 'a' || tag === 'area') return el.hasAttribute('href');
  if (['button', 'input', 'select', 'textarea', 'summary'].includes(tag))
    return !isDisabled(el);
  return el.getAttribute('contenteditable') === 'true';
}

/**
 * Elements a user can operate.
 *
 * Includes the `div`-with-click-handler case, which is extremely common in
 * modern frameworks and invisible to a role-only check. We cannot see listeners
 * from an isolated content script, so `cursor: pointer` plus a tabindex or an
 * interactive-ish role is the available proxy. The pixel channel exists partly
 * to cover what this heuristic still misses.
 */
function isInteractive(el: Element, role: string, style: CSSStyleDeclaration): boolean {
  if (roleIsInteractive(role)) return true;

  const tag = el.tagName.toLowerCase();
  if (tag === 'summary' || tag === 'label') return true;
  if (tag === 'a' && el.hasAttribute('href')) return true;

  if (el.hasAttribute('onclick')) return true;

  const tabIndex = el.getAttribute('tabindex');
  if (tabIndex !== null && Number.parseInt(tabIndex, 10) >= 0 && style.cursor === 'pointer') {
    return true;
  }

  return false;
}

export function computeVisibility(
  el: Element,
  role: string,
  rect: DOMRect,
  viewport: { width: number; height: number },
): VisibilityFacts {
  const view = el.ownerDocument.defaultView;
  const style =
    view === null
      ? ({
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          cursor: 'auto',
          backgroundImage: 'none',
        } as CSSStyleDeclaration)
      : view.getComputedStyle(el);

  const zeroSize = rect.width <= 0 || rect.height <= 0;
  const cssHidden =
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse';
  const transparent = Number.parseFloat(style.opacity) === 0;
  const inputHidden =
    el.tagName.toLowerCase() === 'input' &&
    (el.getAttribute('type') ?? '').toLowerCase() === 'hidden';

  const hidden = cssHidden || transparent || inputHidden || isAriaHidden(el) || zeroSize;

  const inViewport =
    !zeroSize &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < viewport.height &&
    rect.left < viewport.width;

  return {
    hidden,
    inViewport,
    interactive: isInteractive(el, role, style),
    focusable: isFocusable(el),
    editable: isEditable(el, role),
    disabled: isDisabled(el),
    // `url(` covers a plain image, an `image-set`, and an inline SVG data URI. A
    // `linear-gradient` has no `url(` in it and cannot carry text.
    rasterBackground: /url\(/i.test(style.backgroundImage ?? 'none'),
  };
}
