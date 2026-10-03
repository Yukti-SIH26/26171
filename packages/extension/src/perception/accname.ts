/**
 * Accessible name computation, a pragmatic subset of AccName 1.2.
 *
 * The accessible name is what a screen reader would announce, which makes it the
 * closest thing the platform has to "what a human would call this control". It
 * is what lets a remote model say "click the Login button" and have that resolve
 * to a real element without ever seeing a CSS selector.
 *
 * Full AccName is large and recursive. This implements the parts that matter for
 * interactive controls in priority order, and deliberately stops short of the
 * rarely-relevant branches rather than pretending to be complete.
 */

import { roleSupportsNameFromContent } from './roles.ts';

const MAX_NAME_LENGTH = 300;

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

/**
 * Tags that flow inline with the surrounding text.
 *
 * Everything else gets whitespace inserted around its contribution. That asymmetry is
 * the whole point: `un<b>believ</b>able` is one word and must stay one word, whereas
 * `<div>OUTR</div><cite>https://www.outr.ac.in</cite>` is two separate pieces of
 * information and gluing them produced accessible names like
 * `OUTROUTRhttps://www.outr.ac.in`.
 *
 * That is not a cosmetic problem. The accessible name is the only handle the remote
 * model has on an element, so a garbled name means it picks the wrong one, gets
 * refused, and tries again — which is most of what an apparently confused agent is
 * actually doing.
 *
 * A tag list rather than `getComputedStyle` on every child: this runs for every
 * candidate element in a full-document walk, and a style lookup per node there is far
 * more expensive than being slightly wrong about an unusual `display` override.
 */
const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'data',
  'dfn',
  'em',
  'i',
  'kbd',
  'mark',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
]);

/** Text content, skipping subtrees that are hidden from assistive tech. */
function visibleTextContent(el: Element, depth = 0): string {
  if (depth > 12) return '';

  let out = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const child = node as Element;
    if (child.getAttribute('aria-hidden') === 'true') continue;

    const tag = child.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript') {
      continue;
    }

    // A line break is a word boundary even though `br` carries no text.
    if (tag === 'br') {
      out += ' ';
      continue;
    }

    // An image inside a button contributes its alt text to the button's name.
    if (tag === 'img') {
      const alt = child.getAttribute('alt');
      if (alt !== null && alt !== '') out += ` ${alt} `;
      continue;
    }

    // A nested control contributes its own value, not its markup.
    if (tag === 'input') {
      const type = (child.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        out += ` ${child.getAttribute('value') ?? ''} `;
      }
      continue;
    }

    const inner = visibleTextContent(child, depth + 1);
    if (inner === '') continue;

    // `normalize` collapses runs of whitespace afterwards, so padding generously here
    // costs nothing and guarantees the boundary survives.
    out += INLINE_TAGS.has(tag) ? inner : ` ${inner} `;
  }
  return out;
}

/** Resolve an IDREF list into the concatenated names of the targets. */
function textFromIdRefs(el: Element, attribute: string): string {
  const refs = el.getAttribute(attribute);
  if (refs === null || refs.trim() === '') return '';

  const doc = el.ownerDocument;
  const parts: string[] = [];
  for (const id of refs.trim().split(/\s+/)) {
    const target = doc.getElementById(id);
    if (target === null) continue;
    // aria-label on the target takes precedence over its text.
    const label = target.getAttribute('aria-label');
    parts.push(label !== null && label.trim() !== '' ? label : visibleTextContent(target));
  }
  return normalize(parts.join(' '));
}

/** The `<label>` elements associated with a form control. */
function labelText(el: Element): string {
  const parts: string[] = [];

  if (el.id !== '') {
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(el.id)
        : el.id.replace(/["\\]/g, '\\$&');
    for (const label of Array.from(
      el.ownerDocument.querySelectorAll(`label[for="${escaped}"]`),
    )) {
      parts.push(visibleTextContent(label));
    }
  }

  // A wrapping <label> also names the control.
  const wrapping = el.closest('label');
  if (wrapping !== null) parts.push(visibleTextContent(wrapping));

  return normalize(parts.join(' '));
}

function nativeName(el: Element): string {
  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case 'input': {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') {
        const value = el.getAttribute('value');
        if (value !== null && value.trim() !== '') return normalize(value);
        // Browsers supply defaults for unlabelled submit/reset buttons.
        return type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '';
      }
      if (type === 'image') {
        const alt = el.getAttribute('alt');
        if (alt !== null && alt.trim() !== '') return normalize(alt);
        return 'Submit';
      }
      const fromLabel = labelText(el);
      if (fromLabel !== '') return fromLabel;
      // Placeholder is a weak last resort, but on real-world forms it is often
      // the only naming an author bothered to provide.
      const placeholder = el.getAttribute('placeholder');
      if (placeholder !== null && placeholder.trim() !== '') return normalize(placeholder);
      return '';
    }

    case 'textarea':
    case 'select': {
      const fromLabel = labelText(el);
      if (fromLabel !== '') return fromLabel;
      const placeholder = el.getAttribute('placeholder');
      if (placeholder !== null && placeholder.trim() !== '') return normalize(placeholder);
      return '';
    }

    case 'img':
    case 'area': {
      const alt = el.getAttribute('alt');
      return alt === null ? '' : normalize(alt);
    }

    case 'fieldset': {
      const legend = el.querySelector('legend');
      return legend === null ? '' : normalize(visibleTextContent(legend));
    }

    case 'table': {
      const caption = el.querySelector('caption');
      return caption === null ? '' : normalize(visibleTextContent(caption));
    }

    case 'figure': {
      const caption = el.querySelector('figcaption');
      return caption === null ? '' : normalize(visibleTextContent(caption));
    }

    default:
      return '';
  }
}

/**
 * Compute an element's accessible name.
 *
 * Priority: aria-labelledby, then aria-label, then the native mechanism for the
 * element, then name-from-content for roles that allow it, then title.
 */
export function accessibleName(el: Element, role: string): string {
  const fromLabelledBy = textFromIdRefs(el, 'aria-labelledby');
  if (fromLabelledBy !== '') return fromLabelledBy;

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel !== null && ariaLabel.trim() !== '') return normalize(ariaLabel);

  const native = nativeName(el);
  if (native !== '') return native;

  if (roleSupportsNameFromContent(role)) {
    const content = normalize(visibleTextContent(el));
    if (content !== '') return content;
  }

  const title = el.getAttribute('title');
  if (title !== null && title.trim() !== '') return normalize(title);

  return '';
}

/** Accessible description, used as a secondary hint for ambiguous controls. */
export function accessibleDescription(el: Element): string {
  const fromDescribedBy = textFromIdRefs(el, 'aria-describedby');
  if (fromDescribedBy !== '') return fromDescribedBy;
  const title = el.getAttribute('title');
  return title === null ? '' : normalize(title);
}

export { normalize as normalizeAccName, visibleTextContent };
