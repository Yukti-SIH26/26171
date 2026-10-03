/**
 * Stable element identity.
 *
 * The remote model returns `click(el_42)`, and by the time that arrives the page
 * may have re-rendered. So IDs must satisfy two properties:
 *
 *  1. Re-observing an unchanged page yields the same ID for the same element.
 *     Otherwise every observation invalidates every pending action.
 *  2. An ID resolves back to a live DOM node, or fails loudly. A silently wrong
 *     resolution means clicking the wrong thing.
 *
 * Identity is keyed on the DOM node itself rather than a derived signature.
 * Path- or content-based signatures break exactly when it matters most: dynamic
 * lists, re-ordered rows, and text that changes between observations.
 *
 * `WeakMap` and `WeakRef` keep this from retaining detached nodes, so a
 * long-lived content script on a busy SPA does not leak the whole DOM history.
 */

import { formatElementId, type ElementId } from '@sih/core';

export class ElementRegistry {
  /** Element -> assigned ID. Weak, so detached nodes are collectable. */
  private readonly forward = new WeakMap<Element, ElementId>();
  /** ID -> element, weakly held so stale IDs resolve to undefined. */
  private readonly reverse = new Map<ElementId, WeakRef<Element>>();
  private counter = 0;

  /** Existing ID for this element, or a newly minted one. */
  idFor(el: Element): ElementId {
    const existing = this.forward.get(el);
    if (existing !== undefined) return existing;

    const id = formatElementId(this.counter++);
    this.forward.set(el, id);
    this.reverse.set(id, new WeakRef(el));
    return id;
  }

  /**
   * Resolve an ID back to a live element.
   *
   * Returns undefined when the node was garbage collected or detached, which the
   * action validator reports as `unknown_target` rather than guessing.
   */
  resolve(id: ElementId): Element | undefined {
    const ref = this.reverse.get(id);
    if (ref === undefined) return undefined;

    const el = ref.deref();
    if (el === undefined) {
      this.reverse.delete(id);
      return undefined;
    }
    // Present in the registry but no longer in the document: the page replaced
    // it, so the ID is stale.
    if (!el.isConnected) return undefined;
    return el;
  }

  has(id: ElementId): boolean {
    return this.resolve(id) !== undefined;
  }

  /** Drop entries whose elements are gone. Cheap to call between observations. */
  prune(): number {
    let removed = 0;
    for (const [id, ref] of this.reverse) {
      const el = ref.deref();
      if (el === undefined || !el.isConnected) {
        this.reverse.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.reverse.size;
  }

  /** Full reset, for navigation to a new document. */
  clear(): void {
    this.reverse.clear();
    this.counter = 0;
  }
}
