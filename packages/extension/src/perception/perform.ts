/**
 * Performing actions in the page.
 *
 * Runs inside the content script, which means events dispatched from here are
 * `isTrusted: false`. A minority of hardened sites legitimately ignore untrusted
 * input, and Chrome can do better via the debugger API — but Firefox cannot, so
 * this path has to work on its own rather than being a fallback. It is the
 * portable baseline; CDP is an accelerator layered on top where available.
 *
 * Getting synthetic input to actually work on real sites is mostly about
 * faithfulness to what a browser does. Two things matter more than they look:
 *
 *  - **Typing must produce the full event sequence.** React and Vue listen to
 *    `input` with the native value setter having been called; assigning
 *    `el.value` directly updates the DOM but leaves the framework's internal
 *    state stale, so the field visually fills and then reverts on blur. The
 *    native setter is invoked explicitly for that reason.
 *
 *  - **Clicks must be checked for interception first.** If another element covers
 *    the target's centre, clicking dispatches to the covering element. That is
 *    clickjacking from the agent's perspective, so the hit test is a refusal, not
 *    a warning.
 *
 * Nothing here retains a value. The text passed in is used and the local
 * reference dropped; the caller is responsible for not holding it either.
 */

import type { ElementRegistry } from './registry.ts';

export interface PerformResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly obscured?: boolean;
}

/** Does the element at the target's centre belong to the target's own subtree? */
function hitTest(el: Element): { ok: boolean; covering?: Element } {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { ok: false };

  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const top = document.elementFromPoint(x, y);
  if (top === null) return { ok: false };

  // A child of the target is fine — a <span> inside a <button> is the normal case.
  if (top === el || el.contains(top) || top.contains(el)) return { ok: true };
  return { ok: false, covering: top };
}

function centreOf(el: Element): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id === '' ? '' : `#${el.id}`;
  const text = (el.textContent ?? '').trim().slice(0, 40);
  return `<${tag}${id}>${text === '' ? '' : ` "${text}"`}`;
}

/** Scroll the element into view and wait for the scroll to settle. */
async function ensureVisible(el: Element): Promise<void> {
  const rect = el.getBoundingClientRect();
  const fullyVisible =
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth;

  if (fullyVisible) return;

  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  // Two frames: one for the scroll to apply, one for any sticky header to settle.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/**
 * Dispatch a full pointer-and-mouse sequence.
 *
 * Real browsers fire pointer events before mouse events, and many component
 * libraries bind to `pointerdown` alone. Sending only `click` misses them.
 */
function dispatchClickSequence(el: Element, point: { x: number; y: number }): void {
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    view: window,
  };

  el.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(
    new PointerEvent('pointerenter', { ...base, pointerId: 1, isPrimary: true }),
  );
  el.dispatchEvent(new MouseEvent('mouseover', base));
  el.dispatchEvent(new MouseEvent('mousemove', base));
  el.dispatchEvent(
    new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true, button: 0 }),
  );
  el.dispatchEvent(new MouseEvent('mousedown', { ...base, button: 0, detail: 1 }));

  if (el instanceof HTMLElement) el.focus({ preventScroll: true });

  el.dispatchEvent(
    new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true, button: 0 }),
  );
  el.dispatchEvent(new MouseEvent('mouseup', { ...base, button: 0, detail: 1 }));
  el.dispatchEvent(new MouseEvent('click', { ...base, button: 0, detail: 1 }));
}

export async function performClick(
  registry: ElementRegistry,
  targetId: string,
): Promise<PerformResult> {
  const el = registry.resolve(targetId);
  if (el === undefined) return { ok: false, detail: `${targetId} is no longer in the page` };

  await ensureVisible(el);

  const hit = hitTest(el);
  if (!hit.ok) {
    return {
      ok: false,
      obscured: true,
      detail:
        hit.covering === undefined
          ? `${targetId} has no clickable area`
          : `${describe(hit.covering)} covers ${targetId} — refusing to click through it`,
    };
  }

  dispatchClickSequence(el, centreOf(el));
  return { ok: true, detail: `clicked ${describe(el)}` };
}

/**
 * Click a raw viewport coordinate.
 *
 * Used by the grounder path when the element graph cannot name a target. Whatever
 * is under the point is reported back, because a coordinate click is inherently
 * less certain than an element click and the audit trail should say what was hit.
 */
export function performClickPoint(point: { x: number; y: number }): PerformResult {
  const el = document.elementFromPoint(point.x, point.y);
  if (el === null) {
    return { ok: false, detail: `nothing at (${String(point.x)}, ${String(point.y)})` };
  }
  dispatchClickSequence(el, point);
  return {
    ok: true,
    detail: `clicked ${describe(el)} at (${String(point.x)}, ${String(point.y)})`,
  };
}

/**
 * Set a field's value the way a user would.
 *
 * The native setter call is the important line. Frameworks that wrap `value` with
 * their own property descriptor track changes through it; assigning `el.value`
 * bypasses that wrapper, so React sees no change, keeps its stale state, and
 * reverts the field on the next render.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (descriptor?.set !== undefined) descriptor.set.call(el, value);
  else el.value = value;
}

export async function performType(
  registry: ElementRegistry,
  targetId: string,
  text: string,
  options: { clear?: boolean; submit?: boolean } = {},
): Promise<PerformResult> {
  const el = registry.resolve(targetId);
  if (el === undefined) return { ok: false, detail: `${targetId} is no longer in the page` };

  await ensureVisible(el);

  const editable =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el
      : el instanceof HTMLElement && el.isContentEditable
        ? el
        : undefined;

  if (editable === undefined) return { ok: false, detail: `${targetId} does not accept text` };

  editable.focus({ preventScroll: true });

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const expected = options.clear === false ? el.value + text : text;
    if (options.clear !== false) setNativeValue(el, '');

    // `beforeinput` first: some editors cancel it to implement validation, and a
    // sequence that skips it looks nothing like real typing.
    el.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType: 'insertText',
      }),
    );
    setNativeValue(el, expected);
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        data: text,
        inputType: 'insertText',
      }),
    );
    el.dispatchEvent(new Event('change', { bubbles: true }));

    // Controlled fields can revert synthetic input on their next render. Verify
    // locally before claiming success or consuming a one-time value. execCommand is
    // a compatibility fallback for editors that only observe browser editing paths.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (el.value !== expected) {
      editable.focus({ preventScroll: true });
      if (options.clear !== false) el.select();
      document.execCommand('insertText', false, text);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    // Accept what the field made of the text.
    //
    // A strict equality check here failed real inputs for reasons that are not failures:
    // `maxlength` truncates, an uppercase or digits-only mask rewrites, a formatter adds
    // spaces to a card number. Those all mean the value landed. Only an empty field, or
    // one that kept something unrelated, is a genuine rejection.
    const landed = el.value.replace(/\s/g, '');
    const wanted = expected.replace(/\s/g, '');
    const accepted =
      el.value === expected ||
      landed.toLowerCase() === wanted.toLowerCase() ||
      (landed.length > 0 && wanted.toLowerCase().startsWith(landed.toLowerCase()));

    if (!accepted) {
      return { ok: false, detail: `${targetId} would not keep the text` };
    }

    if (options.submit === true) {
      const enter = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
      };
      el.dispatchEvent(new KeyboardEvent('keydown', enter));
      el.dispatchEvent(new KeyboardEvent('keypress', enter));
      el.dispatchEvent(new KeyboardEvent('keyup', enter));
      // A lone Enter does not submit in every browser when the form has no submit
      // button, so request it explicitly as well.
      const form = el.closest('form');
      if (form !== null) form.requestSubmit?.();
    }
  } else {
    const expected = options.clear !== false ? text : (editable.textContent ?? '') + text;
    if (options.clear !== false) editable.textContent = '';
    editable.textContent = expected;
    editable.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if ((editable.textContent ?? '') !== expected) {
      return { ok: false, detail: `${targetId} rejected the local typing attempt` };
    }
  }

  // Report length, never content. An audit log that echoes the value defeats the
  // purpose of the vault.
  return { ok: true, detail: `typed ${String(text.length)} characters into ${describe(el)}` };
}

export async function performHover(
  registry: ElementRegistry,
  targetId: string,
): Promise<PerformResult> {
  const el = registry.resolve(targetId);
  if (el === undefined) return { ok: false, detail: `${targetId} is no longer in the page` };

  await ensureVisible(el);
  const point = centreOf(el);
  const base = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y,
    view: window,
  };

  el.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerId: 1, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseover', base));
  el.dispatchEvent(new MouseEvent('mousemove', base));
  return { ok: true, detail: `hovered ${describe(el)}` };
}

export async function performSelect(
  registry: ElementRegistry,
  targetId: string,
  value: string,
): Promise<PerformResult> {
  const el = registry.resolve(targetId);
  if (el === undefined) return { ok: false, detail: `${targetId} is no longer in the page` };
  if (!(el instanceof HTMLSelectElement)) {
    return { ok: false, detail: `${targetId} is not a dropdown` };
  }

  await ensureVisible(el);

  // Match by value, then by visible label. Models tend to emit what the user would
  // read rather than the underlying value attribute.
  const options = [...el.options];
  const match =
    options.find((o) => o.value === value) ??
    options.find((o) => o.text.trim() === value.trim()) ??
    options.find((o) => o.text.trim().toLowerCase() === value.trim().toLowerCase());

  if (match === undefined) {
    const available = options
      .slice(0, 8)
      .map((o) => o.text.trim())
      .join(', ');
    return { ok: false, detail: `no option "${value}" — available: ${available}` };
  }

  el.focus({ preventScroll: true });
  el.value = match.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, detail: `selected "${match.text.trim()}"` };
}

export function performScroll(
  registry: ElementRegistry,
  deltaX: number,
  deltaY: number,
  targetId?: string,
): PerformResult {
  const el = targetId === undefined ? undefined : registry.resolve(targetId);

  if (el !== undefined) {
    el.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
    return { ok: true, detail: `scrolled ${describe(el)} by ${String(deltaY)}px` };
  }

  window.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' });
  return {
    ok: true,
    detail: `scrolled page by ${String(deltaY)}px to y=${String(Math.round(window.scrollY))}`,
  };
}

/**
 * Press a key chord such as `Enter`, `Escape`, or `Control+a`.
 *
 * Sent to the focused element so it behaves like a real keystroke, falling back to
 * the body when nothing has focus.
 */
export function performKeyPress(keys: string): PerformResult {
  const parts = keys
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const key = parts[parts.length - 1];
  if (key === undefined) return { ok: false, detail: 'no key given' };

  const modifiers = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  const target: Element = document.activeElement ?? document.body;

  // Legacy `keyCode`/`which` are still what a great deal of real search and login code
  // reads for Enter, and they are absent from `KeyboardEventInit` in the DOM types. A
  // synthetic Enter without them is ignored by those handlers, which is why pressing
  // Enter on a search box appeared to do nothing at all.
  const legacy: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    Backspace: 8,
    Delete: 46,
  };
  const keyCode = legacy[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);

  const init = {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: modifiers.has('control') || modifiers.has('ctrl'),
    shiftKey: modifiers.has('shift'),
    altKey: modifiers.has('alt'),
    metaKey: modifiers.has('meta') || modifiers.has('cmd'),
  } as KeyboardEventInit;

  // `dispatchEvent` returns false when the page called preventDefault, which is how a
  // site says "I handled this key myself".
  const handled = !target.dispatchEvent(new KeyboardEvent('keydown', init));
  // A real Enter also produces keypress; some handlers listen only for that.
  if (key === 'Enter' || key.length === 1) {
    target.dispatchEvent(new KeyboardEvent('keypress', init));
  }
  target.dispatchEvent(new KeyboardEvent('keyup', init));

  // Enter in a form field submits, unless the page took the key for itself. Without
  // this, a synthetic Enter is silently inert on any form that has no keydown handler
  // — the browser's own default submit never runs for untrusted events.
  if (key === 'Enter' && !handled && modifiers.size === 0) {
    const form = target.closest('form');
    if (form !== null) {
      form.requestSubmit?.();
      return { ok: true, detail: `pressed Enter and submitted ${describe(target)}` };
    }
  }

  return { ok: true, detail: `pressed ${keys} on ${describe(target)}` };
}
