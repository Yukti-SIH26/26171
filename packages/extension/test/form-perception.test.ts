// @vitest-environment happy-dom
/**
 * What the structure channel now reports about a form, and why each part exists.
 *
 * Every assertion in here corresponds to something the agent got wrong on a real page:
 * a form submitted with fields still empty below the fold, a submit button clicked three
 * times against a validation message nobody could see, a dropdown filled by guessing at
 * the wording of an option, and a page of images whose text was never read.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { ELEMENT_GRAPH_NODE_CAP, type ElementGraph, type ElementNode } from '@sih/core';
import { extractElementGraph } from '../src/perception/extract.ts';
import { ElementRegistry } from '../src/perception/registry.ts';

/**
 * happy-dom has no layout engine, so every `getBoundingClientRect()` is zero and the
 * extractor — correctly — reads a zero box as not rendered. Geometry is therefore stubbed
 * for anything the author did not explicitly hide.
 */
function applyFakeLayout(): void {
  let top = 0;
  for (const element of Array.from(document.querySelectorAll('*')) as HTMLElement[]) {
    const tag = element.tagName.toLowerCase();
    const authorHidden =
      element.getAttribute('type') === 'hidden' ||
      element.getAttribute('aria-hidden') === 'true' ||
      element.style.display === 'none' ||
      tag === 'script' ||
      tag === 'style' ||
      tag === 'template';

    // `data-offscreen` parks an element below the fold, which is how a form that runs past
    // the bottom of the window is reproduced without a real layout engine.
    const offscreen = element.hasAttribute('data-offscreen');
    const y = offscreen ? 5000 : top;
    const width = Number(element.getAttribute('data-w') ?? '180');
    const height = Number(element.getAttribute('data-h') ?? '24');

    const rect: DOMRect = authorHidden
      ? ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 } as DOMRect)
      : ({
          x: 8,
          y,
          width,
          height,
          top: y,
          left: 8,
          right: 8 + width,
          bottom: y + height,
        } as DOMRect);

    if (!authorHidden && !offscreen) top += 28;
    element.getBoundingClientRect = (): DOMRect => rect;
  }
}

function observe(html: string): ElementGraph {
  document.body.innerHTML = html;
  applyFakeLayout();
  return extractElementGraph(document, new ElementRegistry(), {}).graph;
}

function named(graph: ElementGraph, name: string): ElementNode {
  const node = graph.nodes.find((n) => n.name === name);
  if (node === undefined) throw new Error(`no node named ${name}`);
  return node;
}

function byTag(graph: ElementGraph, tag: string): ElementNode[] {
  return graph.nodes.filter((n) => n.tag === tag);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Forms as groups
// ---------------------------------------------------------------------------

describe('form grouping', () => {
  it('numbers each form from 1 in page order', () => {
    const graph = observe(`
      <form><label>First Name<input name="first"></label></form>
      <form><label>Email<input name="email"></label></form>
    `);
    expect(named(graph, 'First Name').formId).toBe(1);
    expect(named(graph, 'Email').formId).toBe(2);
  });

  it('puts every control of one form in the same group', () => {
    const graph = observe(`
      <form>
        <label>First Name<input name="first"></label>
        <label>Last Name<input name="last"></label>
        <button type="submit">Register</button>
      </form>
    `);
    expect(named(graph, 'First Name').formId).toBe(1);
    expect(named(graph, 'Last Name').formId).toBe(1);
    expect(named(graph, 'Register').formId).toBe(1);
  });

  /**
   * Group 0 is a real group rather than an absence, because most modern sign-in pages have
   * no `<form>` element at all. Treating those fields as ungrouped would leave the form
   * section empty on exactly the pages that need it.
   */
  it('groups form-less fields under 0', () => {
    const graph = observe(`
      <div>
        <label>Roll Number<input name="roll"></label>
        <label>Password<input type="password" name="pw"></label>
      </div>
    `);
    expect(named(graph, 'Roll Number').formId).toBe(0);
    expect(named(graph, 'Password').formId).toBe(0);
  });

  /** A link is not part of a form's checklist, or the checklist becomes the page. */
  it('leaves a plain link outside every group', () => {
    const graph = observe('<a href="/help">Help</a>');
    expect(named(graph, 'Help').formId).toBeUndefined();
  });

  it('records required from the attribute and from aria', () => {
    const graph = observe(`
      <form>
        <label>First Name<input name="first" required></label>
        <label>Last Name<input name="last" aria-required="true"></label>
        <label>Nickname<input name="nick"></label>
      </form>
    `);
    expect(named(graph, 'First Name').required).toBe(true);
    expect(named(graph, 'Last Name').required).toBe(true);
    expect(named(graph, 'Nickname').required).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validation state
// ---------------------------------------------------------------------------

describe('validation state', () => {
  /**
   * The bug: submit clicked three times while the browser held a bubble reading "Please
   * fill out this field". Nothing in the payload said the page had refused, so every retry
   * looked like the first attempt.
   */
  it('reports a field the page marks invalid, with its message', () => {
    const graph = observe(`
      <form>
        <label>Date of Birth<input name="dob" aria-invalid="true" aria-errormessage="dob-err"></label>
        <span id="dob-err">Please enter a date in DD/MM/YYYY form</span>
      </form>
    `);
    const field = named(graph, 'Date of Birth');
    expect(field.invalid).toBe(true);
    expect(field.validationMessage).toBe('Please enter a date in DD/MM/YYYY form');
  });

  it('falls back to aria-describedby when there is no errormessage', () => {
    const graph = observe(`
      <form>
        <label>Pincode<input name="pin" aria-invalid="true" aria-describedby="pin-err"></label>
        <span id="pin-err">Six digits, no spaces</span>
      </form>
    `);
    expect(named(graph, 'Pincode').validationMessage).toBe('Six digits, no spaces');
  });

  /**
   * An empty required field reports `valueMissing` from the moment the page loads, so
   * counting it as invalid would mark a pristine form as entirely broken and bury the one
   * field the user actually typed wrongly. Emptiness is carried by `required` instead.
   */
  it('does not call an empty required field invalid', () => {
    const graph = observe(
      '<form><label>First Name<input name="first" required></label></form>',
    );
    const field = named(graph, 'First Name');
    expect(field.required).toBe(true);
    expect(field.invalid).toBeUndefined();
    expect(field.validationMessage).toBeUndefined();
  });

  it('says nothing about a field the page is happy with', () => {
    const graph = observe(
      '<form><label>Nickname<input name="nick" value="asha"></label></form>',
    );
    expect(named(graph, 'Nickname').invalid).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dropdowns
// ---------------------------------------------------------------------------

describe('select options', () => {
  it('lists the labels a dropdown will accept', () => {
    const graph = observe(`
      <form>
        <label>Semester
          <select name="sem">
            <option>Semester 1</option>
            <option>Semester 5</option>
          </select>
        </label>
      </form>
    `);
    const select = byTag(graph, 'select')[0];
    expect(select?.options).toEqual(['Semester 1', 'Semester 5']);
  });

  it('prefers an explicit label attribute over the text', () => {
    const graph = observe(
      '<form><select name="s"><option label="SEM-5">Semester 5 (odd)</option></select></form>',
    );
    expect(byTag(graph, 'select')[0]?.options).toEqual(['SEM-5']);
  });

  it('skips blank options rather than listing empty strings', () => {
    const graph = observe(
      '<form><select name="s"><option></option><option>Yes</option></select></form>',
    );
    expect(byTag(graph, 'select')[0]?.options).toEqual(['Yes']);
  });

  it('records nothing for a text input', () => {
    const graph = observe('<form><label>Name<input name="n"></label></form>');
    expect(named(graph, 'Name').options).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fields below the fold
// ---------------------------------------------------------------------------

describe('off-screen fields', () => {
  /**
   * The form is one form whether or not the screenshot shows all of it. Dropping the
   * out-of-view half is how a registration page got submitted with seven empty boxes.
   */
  it('keeps a field that is below the fold and marks it out of view', () => {
    const graph = observe(`
      <form>
        <label>First Name<input name="first"></label>
        <label data-offscreen>Pincode<input name="pin" data-offscreen required></label>
      </form>
    `);
    const pincode = named(graph, 'Pincode');
    expect(pincode.flags.inViewport).toBe(false);
    expect(pincode.flags.hidden).toBe(false);
    expect(pincode.formId).toBe(1);
    expect(pincode.required).toBe(true);
  });

  /** Genuinely hidden is different from merely scrolled away, and stays different. */
  it('still treats a display:none field as hidden', () => {
    const graph = observe(
      '<form><label style="display:none">Token<input name="csrf" style="display:none"></label></form>',
    );
    const token = graph.nodes.find((n) => n.fieldName === 'csrf');
    expect(token?.flags.hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Where pixels could be hiding text
// ---------------------------------------------------------------------------

describe('raster surfaces', () => {
  /**
   * This is what decides whether OCR runs, so a surface that goes unrecorded is a surface
   * whose text is never screened before the screenshot is transmitted. Each of these
   * elements has no role, no name and no text, so every other emit rule drops them.
   */
  it.each([
    ['<img src="x.png" alt="">', 'img'],
    ['<canvas width="300" height="200"></canvas>', 'canvas'],
    // No `src`: happy-dom would really try to fetch one, and the tag is what is being
    // asserted here, not the load.
    ['<iframe title="Statement"></iframe>', 'iframe'],
    ['<video src="v.mp4"></video>', 'video'],
    ['<object data="x.pdf"></object>', 'object'],
    ['<embed src="x.swf">', 'embed'],
  ])('emits %s and flags it as painting pixels', (html, tag) => {
    const graph = observe(html);
    const node = byTag(graph, tag)[0];
    expect(node).toBeDefined();
    expect(node?.paintsImage).toBe(true);
  });

  it('flags a CSS background image', () => {
    const graph = observe('<div style="background-image:url(card.png)">&nbsp;</div>');
    const node = graph.nodes.find((n) => n.paintsImage === true);
    expect(node).toBeDefined();
  });

  /** A gradient has no `url()` in it and cannot carry a glyph. */
  it('does not flag a gradient background', () => {
    const graph = observe('<div style="background-image:linear-gradient(red,blue)">hi</div>');
    expect(graph.nodes.some((n) => n.paintsImage === true)).toBe(false);
  });

  it('leaves a plain text page with no raster surfaces at all', () => {
    const graph = observe(`
      <h1>Attendance</h1>
      <p>You have attended 78% of classes.</p>
      <form><label>Semester<input name="sem"></label><button>Go</button></form>
    `);
    expect(graph.nodes.some((n) => n.paintsImage === true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The node cap
// ---------------------------------------------------------------------------

describe('the node cap', () => {
  /**
   * Shared through core rather than kept private to the extractor, because reaching it is
   * a fact the caller has to act on: a truncated walk means some of what the screenshot
   * shows was never read as text, which is the one case where OCR must cover the whole
   * frame rather than just the pictures.
   */
  it('is the default and is never exceeded', () => {
    expect(ELEMENT_GRAPH_NODE_CAP).toBe(1500);
    const graph = observe(
      Array.from({ length: 40 }, (_, i) => `<p>line ${String(i)}</p>`).join(''),
    );
    expect(graph.nodes.length).toBeLessThanOrEqual(ELEMENT_GRAPH_NODE_CAP);
  });
});
