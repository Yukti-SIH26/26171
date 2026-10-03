// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { computeRole, implicitRole, roleIsInteractive } from '../src/perception/roles.ts';
import { accessibleName } from '../src/perception/accname.ts';
import { extractElementGraph } from '../src/perception/extract.ts';
import { ElementRegistry } from '../src/perception/registry.ts';
import type { ElementGraph, ElementNode } from '@sih/core';

function setBody(html: string): void {
  document.body.innerHTML = html;
}

/**
 * happy-dom has no layout engine, so `getBoundingClientRect()` returns all
 * zeros for every element. The extractor correctly reads a zero-size box as
 * "not actionable", which would make every node hidden here.
 *
 * So geometry is stubbed for elements the author did not hide, giving each a
 * plausible box. Anything genuinely hidden keeps its zero rect, which is what a
 * real browser reports for it too.
 */
function applyFakeLayout(): void {
  let top = 0;
  for (const node of Array.from(document.querySelectorAll('*'))) {
    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();

    const authorHidden =
      element.getAttribute('type') === 'hidden' ||
      element.getAttribute('aria-hidden') === 'true' ||
      element.style.display === 'none' ||
      element.style.visibility === 'hidden' ||
      tag === 'script' ||
      tag === 'style' ||
      tag === 'template';

    const rect: DOMRect = authorHidden
      ? ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 } as DOMRect)
      : ({
          x: 8,
          y: top,
          width: 180,
          height: 24,
          top,
          left: 8,
          right: 188,
          bottom: top + 24,
        } as DOMRect);

    if (!authorHidden) top += 28;
    element.getBoundingClientRect = (): DOMRect => rect;
  }
}

function q(selector: string): Element {
  const found = document.querySelector(selector);
  if (found === null) throw new Error(`no element for ${selector}`);
  return found;
}

function observe(html: string): ElementGraph {
  setBody(html);
  applyFakeLayout();
  return extractElementGraph(document, new ElementRegistry(), {}).graph;
}

function byId(graph: ElementGraph, id: string): ElementNode {
  const node = graph.nodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`no node ${id}`);
  return node;
}

function findByName(graph: ElementGraph, name: string): ElementNode | undefined {
  return graph.nodes.find((n) => n.name === name);
}

/**
 * Find by name *and* role.
 *
 * Needed because ARIA grants `row` and `cell` name-from-content, so a table row
 * containing only a submit button carries the same accessible name as the button
 * itself. Both nodes are spec-correct; only one is clickable.
 */
function findByRole(graph: ElementGraph, role: string, name: string): ElementNode | undefined {
  return graph.nodes.find((n) => n.role === role && n.name === name);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('implicit roles', () => {
  it('maps common interactive elements', () => {
    setBody(`
      <a href="/x" id="a">link</a>
      <a id="nohref">not a link</a>
      <button id="b">go</button>
      <textarea id="t"></textarea>
      <select id="s"><option>one</option></select>
    `);
    expect(implicitRole(q('#a'))).toBe('link');
    expect(implicitRole(q('#nohref'))).toBe('generic');
    expect(implicitRole(q('#b'))).toBe('button');
    expect(implicitRole(q('#t'))).toBe('textbox');
    expect(implicitRole(q('#s'))).toBe('combobox');
  });

  it('maps input types', () => {
    setBody(`
      <input id="text" type="text">
      <input id="pw" type="password">
      <input id="cb" type="checkbox">
      <input id="submit" type="submit" value="Go">
      <input id="num" type="number">
      <input id="search" type="search">
      <input id="bare">
    `);
    expect(implicitRole(q('#text'))).toBe('textbox');
    // HTML-AAM gives password no role; we report textbox and carry the
    // sensitivity on inputType instead.
    expect(implicitRole(q('#pw'))).toBe('textbox');
    expect(implicitRole(q('#cb'))).toBe('checkbox');
    expect(implicitRole(q('#submit'))).toBe('button');
    expect(implicitRole(q('#num'))).toBe('spinbutton');
    expect(implicitRole(q('#search'))).toBe('searchbox');
    expect(implicitRole(q('#bare'))).toBe('textbox');
  });

  it('treats a multi-select as a listbox', () => {
    setBody('<select id="m" multiple><option>a</option></select>');
    expect(implicitRole(q('#m'))).toBe('listbox');
  });

  it('treats alt="" images as decorative', () => {
    setBody('<img id="deco" alt=""><img id="real" alt="Logo">');
    expect(implicitRole(q('#deco'))).toBe('presentation');
    expect(implicitRole(q('#real'))).toBe('img');
  });

  it('only promotes header and footer to landmarks at document scope', () => {
    setBody(`
      <header id="top">site</header>
      <article><footer id="card">card meta</footer></article>
    `);
    expect(implicitRole(q('#top'))).toBe('banner');
    expect(implicitRole(q('#card'))).toBe('generic');
  });

  it('lets an author role override the implicit one', () => {
    setBody('<div id="d" role="button">Save</div>');
    expect(computeRole(q('#d'))).toBe('button');
    expect(roleIsInteractive(computeRole(q('#d')))).toBe(true);
  });
});

describe('accessible names', () => {
  it('prefers aria-labelledby over everything', () => {
    setBody(`
      <span id="lbl">Account number</span>
      <input id="i" aria-labelledby="lbl" aria-label="ignored" placeholder="also ignored">
    `);
    expect(accessibleName(q('#i'), 'textbox')).toBe('Account number');
  });

  it('falls back to aria-label', () => {
    setBody('<input id="i" aria-label="Roll number" placeholder="ignored">');
    expect(accessibleName(q('#i'), 'textbox')).toBe('Roll number');
  });

  it('uses an associated label element', () => {
    setBody('<label for="i">Registration No.</label><input id="i">');
    expect(accessibleName(q('#i'), 'textbox')).toBe('Registration No.');
  });

  it('uses a wrapping label', () => {
    setBody('<label>Password <input id="i" type="password"></label>');
    expect(accessibleName(q('#i'), 'textbox')).toBe('Password');
  });

  it('falls back to placeholder, which is often the only naming authors provide', () => {
    setBody('<input id="i" placeholder="Enter Aadhaar">');
    expect(accessibleName(q('#i'), 'textbox')).toBe('Enter Aadhaar');
  });

  it('names a button from its content', () => {
    setBody('<button id="b">  Sign   in  </button>');
    expect(accessibleName(q('#b'), 'button')).toBe('Sign in');
  });

  it('takes an icon button name from the nested image alt text', () => {
    setBody('<button id="b"><img src="x.png" alt="Download marksheet"></button>');
    expect(accessibleName(q('#b'), 'button')).toBe('Download marksheet');
  });

  it('ignores aria-hidden subtrees when naming', () => {
    setBody('<button id="b">Save<span aria-hidden="true"> (beta)</span></button>');
    expect(accessibleName(q('#b'), 'button')).toBe('Save');
  });

  it('uses the submit value, then a sensible default', () => {
    setBody('<input id="v" type="submit" value="Login"><input id="d" type="submit">');
    expect(accessibleName(q('#v'), 'button')).toBe('Login');
    expect(accessibleName(q('#d'), 'button')).toBe('Submit');
  });

  it('does not name a generic container from its content', () => {
    // Otherwise every wrapper div would absorb the whole page as its name.
    setBody('<div id="d">lots of page text here</div>');
    expect(accessibleName(q('#d'), 'generic')).toBe('');
  });

  it('falls back to title last', () => {
    setBody('<div id="d" role="button" title="Close dialog"></div>');
    expect(accessibleName(q('#d'), 'button')).toBe('Close dialog');
  });
});

describe('password values are never collected', () => {
  // The central privacy property of this layer. A later redaction step cannot
  // leak what was never read, so this is enforced at collection time.
  it('omits the value of a password field even when populated', () => {
    setBody('<label for="p">Password</label><input id="p" type="password">');
    (q('#p') as HTMLInputElement).value = 'hunter2-not-a-real-password';

    const graph = extractElementGraph(document, new ElementRegistry(), {}).graph;
    const node = findByName(graph, 'Password');

    expect(node).toBeDefined();
    expect(node?.inputType).toBe('password');
    expect(node?.value).toBeUndefined();
    expect(JSON.stringify(graph)).not.toContain('hunter2');
  });

  it('does collect ordinary text values, which redaction handles downstream', () => {
    setBody('<label for="t">City</label><input id="t" type="text">');
    (q('#t') as HTMLInputElement).value = 'Ahmedabad';

    const graph = extractElementGraph(document, new ElementRegistry(), {}).graph;
    expect(findByName(graph, 'City')?.value).toBe('Ahmedabad');
  });

  it('omits file input values, which expose local paths', () => {
    setBody('<label for="f">Upload</label><input id="f" type="file">');
    const graph = extractElementGraph(document, new ElementRegistry(), {}).graph;
    expect(findByName(graph, 'Upload')?.value).toBeUndefined();
  });

  it('reports checkbox state rather than a raw value', () => {
    setBody('<label for="c">Agree</label><input id="c" type="checkbox">');
    (q('#c') as HTMLInputElement).checked = true;
    const graph = extractElementGraph(document, new ElementRegistry(), {}).graph;
    expect(findByName(graph, 'Agree')?.value).toBe('checked');
  });
});

describe('extraction', () => {
  it('emits interactive controls with roles, names and structural hints', () => {
    const graph = observe(`
      <form>
        <label for="u">Username</label><input id="u" name="u" autocomplete="username" required>
        <label for="p">Password</label><input id="p" type="password" autocomplete="current-password">
        <button type="submit">Sign in</button>
      </form>
    `);

    const username = findByName(graph, 'Username');
    expect(username?.role).toBe('textbox');
    expect(username?.autocomplete).toBe('username');
    expect(username?.required).toBe(true);
    expect(username?.flags.editable).toBe(true);
    expect(username?.flags.interactive).toBe(true);

    const password = findByName(graph, 'Password');
    expect(password?.inputType).toBe('password');
    expect(password?.autocomplete).toBe('current-password');

    expect(findByName(graph, 'Sign in')?.role).toBe('button');
  });

  it('marks every structure-channel node as certain', () => {
    // The structure channel reads facts; it does not predict. Uncertainty
    // belongs to the pixel channel, which carries real detector scores.
    const graph = observe('<button>A</button><a href="/b">B</a>');
    for (const node of graph.nodes) {
      expect(node.source).toBe('structure');
      expect(node.confidence).toBe(1);
    }
  });

  it('keeps hidden fields but excludes them from action targets', () => {
    // display:none inputs routinely hold prefilled personal data, so they must
    // still be scanned, yet they can never be clicked.
    const graph = observe(`
      <input id="csrf" type="hidden" name="csrf" value="abc123">
      <button>Visible</button>
    `);
    const hidden = graph.nodes.filter((n) => n.flags.hidden);
    expect(hidden.length).toBeGreaterThan(0);
    for (const node of hidden) {
      expect(node.flags.inViewport).toBe(false);
    }
  });

  it('marks disabled controls', () => {
    const graph = observe('<button disabled>Locked</button>');
    expect(findByName(graph, 'Locked')?.flags.disabled).toBe(true);
  });

  it('cascades a disabled fieldset to its descendants', () => {
    const graph = observe(`
      <fieldset disabled><label for="x">Inner</label><input id="x"></fieldset>
    `);
    expect(findByName(graph, 'Inner')?.flags.disabled).toBe(true);
  });

  it('skips script, style and template content', () => {
    const graph = observe(`
      <script>const secret = 'should-not-appear';</script>
      <style>.a { color: red }</style>
      <template><button>templated</button></template>
      <button>Real</button>
    `);
    const serialized = JSON.stringify(graph);
    expect(serialized).not.toContain('should-not-appear');
    expect(serialized).not.toContain('templated');
    expect(findByName(graph, 'Real')).toBeDefined();
  });

  it('records headings so the agent can orient on the page', () => {
    const graph = observe('<h1>Attendance Summary</h1><button>Refresh</button>');
    expect(findByName(graph, 'Attendance Summary')?.role).toBe('heading');
  });

  it('links nodes to their nearest emitted ancestor, not the raw DOM parent', () => {
    const graph = observe(`
      <nav><div><span><a href="/home">Home</a></span></div></nav>
    `);
    const link = findByName(graph, 'Home');
    expect(link).toBeDefined();
    const parent = graph.nodes.find((n) => n.id === link?.parentId);
    // The wrapper div and span are not emitted, so the parent is the landmark.
    expect(parent?.role).toBe('navigation');
  });

  it('respects the node cap', () => {
    const many = Array.from({ length: 80 }, (_, i) => `<button>B${String(i)}</button>`).join(
      '',
    );
    setBody(many);
    const graph = extractElementGraph(document, new ElementRegistry(), { maxNodes: 10 }).graph;
    expect(graph.nodes.length).toBeLessThanOrEqual(10);
  });

  it('reports stats and timing for the resource budget', () => {
    setBody('<button>A</button>');
    const result = extractElementGraph(document, new ElementRegistry(), {});
    expect(result.elementsVisited).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.graph.stats.structureCount).toBe(result.graph.nodes.length);
  });
});

describe('stable element identity', () => {
  it('returns the same id for the same element across observations', () => {
    // Without this, every re-read invalidates every pending action.
    setBody('<button id="b">Save</button><a href="/x">Link</a>');
    const registry = new ElementRegistry();

    const first = extractElementGraph(document, registry, {}).graph;
    const second = extractElementGraph(document, registry, {}).graph;

    const a = findByName(first, 'Save');
    const b = findByName(second, 'Save');
    expect(a?.id).toBeDefined();
    expect(b?.id).toBe(a?.id);
  });

  it('gives new elements fresh ids without renumbering existing ones', () => {
    setBody('<button>First</button>');
    const registry = new ElementRegistry();
    const before = extractElementGraph(document, registry, {}).graph;
    const firstId = findByName(before, 'First')?.id;

    document.body.insertAdjacentHTML('afterbegin', '<button>Zeroth</button>');
    const after = extractElementGraph(document, registry, {}).graph;

    expect(findByName(after, 'First')?.id).toBe(firstId);
    expect(findByName(after, 'Zeroth')?.id).not.toBe(firstId);
  });

  it('resolves an id back to the live element', () => {
    setBody('<button>Save</button>');
    const registry = new ElementRegistry();
    const graph = extractElementGraph(document, registry, {}).graph;
    const id = findByName(graph, 'Save')?.id;
    expect(id).toBeDefined();
    expect(registry.resolve(id as string)?.tagName.toLowerCase()).toBe('button');
  });

  it('refuses to resolve an id whose element has been removed', () => {
    // A stale id must fail loudly. Resolving it to the wrong node would mean
    // clicking something the model never chose.
    setBody('<button>Gone</button>');
    const registry = new ElementRegistry();
    const graph = extractElementGraph(document, registry, {}).graph;
    const id = byId(graph, findByName(graph, 'Gone')?.id as string).id;

    document.body.innerHTML = '';
    expect(registry.resolve(id)).toBeUndefined();
    expect(registry.has(id)).toBe(false);
  });

  it('prunes detached entries', () => {
    setBody('<button>A</button><button>B</button>');
    const registry = new ElementRegistry();
    extractElementGraph(document, registry, {});
    expect(registry.size).toBeGreaterThan(0);

    document.body.innerHTML = '';
    expect(registry.prune()).toBeGreaterThan(0);
    expect(registry.size).toBe(0);
  });

  it('never issues the same id to two different elements', () => {
    setBody(Array.from({ length: 25 }, (_, i) => `<button>B${String(i)}</button>`).join(''));
    const graph = extractElementGraph(document, new ElementRegistry(), {}).graph;
    const ids = graph.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('a realistic college portal login form', () => {
  // Shaped after the real target: table layout, weak labelling, mixed naming.
  const html = `
    <h2>Student Login</h2>
    <form action="/login" method="post">
      <table>
        <tr><td>Roll No</td><td><input type="text" name="rollno" id="rollno"></td></tr>
        <tr><td>Password</td><td><input type="password" name="pwd" id="pwd"></td></tr>
        <tr><td>Captcha</td><td><input type="text" name="cap" id="cap" placeholder="Enter code"></td></tr>
        <tr><td colspan="2"><input type="submit" value="Sign In"></td></tr>
      </table>
      <input type="hidden" name="__token" value="tok-987654">
    </form>
  `;

  it('finds every control the agent needs', () => {
    const graph = observe(html);
    // Roll number, password, captcha. The hidden token is excluded.
    const editable = graph.nodes.filter((n) => n.flags.editable && !n.flags.hidden);
    expect(editable.length).toBe(3);
    expect(findByRole(graph, 'button', 'Sign In')).toBeDefined();
    expect(findByRole(graph, 'heading', 'Student Login')).toBeDefined();
  });

  it('exposes exactly one clickable "Sign In", even though the row shares its name', () => {
    // Legacy table markup produces nested nodes with identical accessible names.
    // Only the button is a valid action target, which is what keeps the planner
    // from aiming at a container it cannot click.
    const graph = observe(html);
    const clickable = graph.nodes.filter((n) => n.name === 'Sign In' && n.flags.interactive);
    expect(clickable).toHaveLength(1);
    expect(clickable[0]?.role).toBe('button');
  });

  it('identifies the password field without reading it', () => {
    setBody(html);
    (q('#pwd') as HTMLInputElement).value = 'super-secret-value';
    const graph = extractElementGraph(document, new ElementRegistry(), {}).graph;

    const password = graph.nodes.find((n) => n.inputType === 'password');
    expect(password).toBeDefined();
    expect(password?.value).toBeUndefined();
    expect(JSON.stringify(graph)).not.toContain('super-secret-value');
  });

  it('still sees the hidden token, so redaction can act on it', () => {
    const graph = observe(html);
    expect(graph.nodes.some((n) => n.flags.hidden)).toBe(true);
  });

  it('names the captcha field from its placeholder when the cell label is unlinked', () => {
    // Table-cell labels are not associated with `for`, which is exactly the
    // weak markup the pixel channel later has to compensate for.
    const graph = observe(html);
    expect(findByName(graph, 'Enter code')).toBeDefined();
  });
});
