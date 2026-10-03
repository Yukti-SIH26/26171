/**
 * Debug overlay: draws the Element Graph on top of the live page.
 *
 * This is a development and demonstration surface, not part of the agent loop,
 * but it earns its place. Perception bugs are close to impossible to reason
 * about from a JSON dump: a box in the wrong place, a control the walk missed, a
 * name attached to the wrong node are all instantly obvious visually and nearly
 * invisible in a list.
 *
 * Rendered in a closed shadow root so page CSS cannot restyle it and page script
 * cannot read it. It is also `pointer-events: none` throughout, so it can never
 * intercept a click the agent or the user meant for the page.
 */

import type { ElementGraph, ElementNode } from '@sih/core';

const HOST_ID = 'kavach-overlay-host';
const Z_INDEX = '2147483646';

type Palette = { border: string; fill: string; label: string };

/**
 * Colour by what the node *is*, so miscategorisation is visible at a glance.
 * Text entry is called out separately because those are the fields that hold
 * PII and therefore matter most.
 */
function paletteFor(node: ElementNode): Palette {
  if (node.inputType === 'password') {
    return { border: '#f87171', fill: 'rgba(248,113,113,0.16)', label: '#f87171' };
  }
  if (node.flags.editable) {
    return { border: '#fbbf24', fill: 'rgba(251,191,36,0.13)', label: '#fbbf24' };
  }
  if (node.flags.interactive) {
    return { border: '#4ade80', fill: 'rgba(74,222,128,0.11)', label: '#4ade80' };
  }
  return { border: '#60a5fa', fill: 'rgba(96,165,250,0.07)', label: '#60a5fa' };
}

function removeExisting(doc: Document): void {
  doc.getElementById(HOST_ID)?.remove();
}

export interface OverlayOptions {
  /** Draw non-interactive structural nodes too. Noisy but sometimes necessary. */
  readonly includeStructural?: boolean;
  /** Draw nodes that are hidden from users. Off by default: they have no box. */
  readonly includeHidden?: boolean;
}

export function drawOverlay(
  doc: Document,
  graph: ElementGraph,
  options: OverlayOptions = {},
): number {
  removeExisting(doc);

  const includeStructural = options.includeStructural ?? false;
  const includeHidden = options.includeHidden ?? false;

  const host = doc.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = [
    'position:fixed',
    'inset:0',
    'pointer-events:none',
    `z-index:${Z_INDEX}`,
    'contain:strict',
  ].join(';');

  // Closed mode: the page cannot reach into this tree.
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = doc.createElement('style');
  style.textContent = `
    .box {
      position: fixed;
      pointer-events: none;
      box-sizing: border-box;
      border-width: 1.5px;
      border-style: solid;
      border-radius: 2px;
    }
    .tag {
      position: fixed;
      pointer-events: none;
      font: 600 9px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 1px 3px;
      border-radius: 2px;
      background: #0f1115;
      white-space: nowrap;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;
  shadow.appendChild(style);

  let drawn = 0;
  for (const node of graph.nodes) {
    if (node.flags.hidden && !includeHidden) continue;
    if (!node.flags.interactive && !includeStructural) continue;
    if (node.rect.width <= 0 || node.rect.height <= 0) continue;

    const palette = paletteFor(node);

    const box = doc.createElement('div');
    box.className = 'box';
    box.style.left = `${String(node.rect.x)}px`;
    box.style.top = `${String(node.rect.y)}px`;
    box.style.width = `${String(node.rect.width)}px`;
    box.style.height = `${String(node.rect.height)}px`;
    box.style.borderColor = palette.border;
    box.style.background = palette.fill;
    shadow.appendChild(box);

    const tag = doc.createElement('div');
    tag.className = 'tag';
    tag.style.color = palette.label;
    tag.style.borderTop = `1.5px solid ${palette.border}`;
    tag.textContent = `${node.id} ${node.role}`;
    // Flip the label below the box when it would be clipped off the top.
    const labelTop = node.rect.y - 13 < 0 ? node.rect.y + node.rect.height : node.rect.y - 13;
    tag.style.left = `${String(node.rect.x)}px`;
    tag.style.top = `${String(labelTop)}px`;
    shadow.appendChild(tag);

    drawn++;
  }

  (doc.body ?? doc.documentElement).appendChild(host);
  return drawn;
}

export function clearOverlay(doc: Document): void {
  removeExisting(doc);
}

export function isOverlayVisible(doc: Document): boolean {
  return doc.getElementById(HOST_ID) !== null;
}
