/**
 * Implicit ARIA role mapping, following HTML-AAM.
 *
 * Why roles at all: a role is the most portable description of *what a thing is*
 * that the web platform offers. `<button>`, `<div role="button">`, and a styled
 * `<a>` acting as a button are wildly different markup but the same thing to a
 * user, and the same thing to an agent deciding where to click.
 *
 * This is also why the structure channel is not "per-site rules". There is one
 * HTML specification, not a million site-specific conventions.
 */

/** Roles whose accessible name may come from their own text content. */
const NAME_FROM_CONTENT = new Set([
  'button',
  'cell',
  'checkbox',
  'columnheader',
  'gridcell',
  'heading',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'row',
  'rowheader',
  'switch',
  'tab',
  'tooltip',
  'treeitem',
]);

/** Roles a user can click, type into, or otherwise operate. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

const INPUT_TYPE_ROLES: Readonly<Record<string, string>> = {
  button: 'button',
  checkbox: 'checkbox',
  color: 'textbox',
  date: 'textbox',
  'datetime-local': 'textbox',
  email: 'textbox',
  file: 'button',
  image: 'button',
  month: 'textbox',
  number: 'spinbutton',
  // HTML-AAM gives password no corresponding role. We report `textbox` so the
  // agent can reason about it as an entry field; the sensitivity signal travels
  // separately on `inputType`, which is never inferred and never wrong.
  password: 'textbox',
  radio: 'radio',
  range: 'slider',
  reset: 'button',
  search: 'searchbox',
  submit: 'button',
  tel: 'textbox',
  text: 'textbox',
  time: 'textbox',
  url: 'textbox',
  week: 'textbox',
};

const TAG_ROLES: Readonly<Record<string, string>> = {
  article: 'article',
  aside: 'complementary',
  blockquote: 'blockquote',
  button: 'button',
  caption: 'caption',
  dd: 'definition',
  dfn: 'term',
  dialog: 'dialog',
  dl: 'list',
  dt: 'term',
  fieldset: 'group',
  figure: 'figure',
  form: 'form',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  hr: 'separator',
  li: 'listitem',
  main: 'main',
  math: 'math',
  menu: 'list',
  meter: 'meter',
  nav: 'navigation',
  ol: 'list',
  optgroup: 'group',
  option: 'option',
  output: 'status',
  p: 'paragraph',
  progress: 'progressbar',
  search: 'search',
  summary: 'button',
  table: 'table',
  tbody: 'rowgroup',
  td: 'cell',
  textarea: 'textbox',
  tfoot: 'rowgroup',
  th: 'columnheader',
  thead: 'rowgroup',
  tr: 'row',
  ul: 'list',
};

function selectRole(el: Element): string {
  const multiple = el.hasAttribute('multiple');
  const sizeAttr = el.getAttribute('size');
  const size = sizeAttr === null ? 1 : Number.parseInt(sizeAttr, 10);
  return multiple || size > 1 ? 'listbox' : 'combobox';
}

/**
 * `<header>`/`<footer>` map to banner/contentinfo only at document scope. Nested
 * inside an article or section they are just groups, and treating a card footer
 * as the page footer would mislead the planner.
 */
function scopedLandmarkRole(el: Element, landmark: string): string {
  let parent = el.parentElement;
  while (parent !== null) {
    const tag = parent.tagName.toLowerCase();
    if (
      tag === 'article' ||
      tag === 'aside' ||
      tag === 'main' ||
      tag === 'nav' ||
      tag === 'section'
    ) {
      return 'generic';
    }
    parent = parent.parentElement;
  }
  return landmark;
}

export function implicitRole(el: Element): string {
  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case 'a':
    case 'area':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'input': {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      // An input with a datalist behaves as a combobox regardless of type.
      if (el.hasAttribute('list') && (type === 'text' || type === 'search')) return 'combobox';
      return INPUT_TYPE_ROLES[type] ?? 'textbox';
    }
    case 'select':
      return selectRole(el);
    case 'img': {
      const alt = el.getAttribute('alt');
      // alt="" is an explicit statement that the image is decorative.
      return alt === '' ? 'presentation' : 'img';
    }
    case 'header':
      return scopedLandmarkRole(el, 'banner');
    case 'footer':
      return scopedLandmarkRole(el, 'contentinfo');
    case 'section':
      // A section is only a landmark once it has a name to announce.
      return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')
        ? 'region'
        : 'generic';
    default:
      return TAG_ROLES[tag] ?? 'generic';
  }
}

/** Author-declared role wins over the implicit one, per ARIA. */
export function computeRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit !== null && explicit.trim() !== '') {
    // role may be a fallback list; the first valid token applies.
    const first = explicit.trim().split(/\s+/)[0];
    if (first !== undefined && first !== '') return first.toLowerCase();
  }
  return implicitRole(el);
}

export function roleSupportsNameFromContent(role: string): boolean {
  return NAME_FROM_CONTENT.has(role);
}

export function roleIsInteractive(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}

export function roleIsTextEntry(role: string): boolean {
  return role === 'textbox' || role === 'searchbox' || role === 'spinbutton';
}
