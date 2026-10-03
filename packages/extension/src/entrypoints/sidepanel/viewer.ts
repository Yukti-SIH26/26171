/**
 * The comparison viewer.
 *
 * One job: let somebody look at the two images from a single step, large, and satisfy
 * themselves that the black rectangles landed on their data and nowhere else.
 *
 * That is not a nicety. The entire privacy claim of this extension reduces to "the
 * thing we sent does not contain your data", and the only honest way to support that
 * claim is to show both frames and let the viewer check. A thumbnail in a 400px side
 * panel cannot do it — at that size a mask covering a phone number and a mask three
 * hundred pixels to the left look identical.
 *
 * So there are three ways to look, because they answer different questions:
 *
 *   wipe        drag a divider across a single frame. The two images are pixel-aligned
 *               by construction, so a box either sits exactly over the value or it
 *               visibly does not. This is the one that convinces people.
 *   side by side both frames stacked at full width, for reading the labels.
 *   one at a time  full width, no split, for pointing at a single detail.
 *
 * Plus "open full size", which hands the untouched data URL to a new tab. On a
 * projector that is the version worth showing: no downscaling at all.
 */

export interface ComparePair {
  /** Step number, for the heading. */
  readonly step: number;
  readonly url: string;
  /** Original pixels with every detection outlined and labelled. Stays local. */
  readonly found?: string;
  /** What actually went out. */
  readonly sent?: string;
}

type Mode = 'wipe' | 'stack' | 'found' | 'sent';

const MODES: readonly { readonly id: Mode; readonly label: string }[] = [
  { id: 'wipe', label: 'Drag to compare' },
  { id: 'stack', label: 'Side by side' },
  { id: 'found', label: 'What it saw' },
  { id: 'sent', label: 'What was sent' },
];

export class Viewer {
  private readonly dialog: HTMLDialogElement;
  private readonly stage: HTMLDivElement;
  private readonly caption: HTMLParagraphElement;
  private readonly tabs = new Map<Mode, HTMLButtonElement>();

  private pair: ComparePair | undefined;
  private mode: Mode = 'wipe';
  /** Divider position in the wipe view, 0..1. */
  private split = 0.5;

  constructor() {
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'viewer';

    const inner = document.createElement('div');
    inner.className = 'viewer-inner';

    // ---- Head ------------------------------------------------------------
    const head = document.createElement('div');
    head.className = 'viewer-head';

    this.caption = document.createElement('p');
    this.caption.className = 'viewer-caption';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn';
    close.setAttribute('aria-label', 'Close');
    const times = document.createElement('span');
    times.setAttribute('aria-hidden', 'true');
    times.textContent = '×';
    close.appendChild(times);
    close.addEventListener('click', () => {
      this.dialog.close();
    });

    head.append(this.caption, close);

    // ---- Mode switch -----------------------------------------------------
    const switcher = document.createElement('div');
    switcher.className = 'viewer-modes';
    switcher.setAttribute('role', 'tablist');

    for (const entry of MODES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'viewer-mode';
      button.textContent = entry.label;
      button.setAttribute('role', 'tab');
      button.addEventListener('click', () => {
        this.mode = entry.id;
        this.render();
      });
      this.tabs.set(entry.id, button);
      switcher.appendChild(button);
    }

    // ---- Stage -----------------------------------------------------------
    this.stage = document.createElement('div');
    this.stage.className = 'viewer-stage';

    inner.append(head, switcher, this.stage);
    this.dialog.appendChild(inner);

    // Backdrop click dismisses. A <dialog> reports a click on itself when the press
    // landed outside the content box.
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });

    // Arrow keys nudge the divider. Useful when presenting: you can line the split
    // up on a specific field without fighting a trackpad.
    this.dialog.addEventListener('keydown', (event) => {
      if (this.mode !== 'wipe') return;
      const stepSize = event.shiftKey ? 0.1 : 0.02;
      if (event.key === 'ArrowLeft') {
        this.split = Math.max(0, this.split - stepSize);
      } else if (event.key === 'ArrowRight') {
        this.split = Math.min(1, this.split + stepSize);
      } else {
        return;
      }
      event.preventDefault();
      this.render();
    });

    document.body.appendChild(this.dialog);
  }

  open(pair: ComparePair): void {
    this.pair = pair;
    // Default to whichever view is actually possible. A step where the picture was
    // withheld has only one image, and offering a comparison would be a lie.
    this.mode = pair.found !== undefined && pair.sent !== undefined ? 'wipe' : 'found';
    this.split = 0.5;
    this.render();
    this.dialog.showModal();
  }

  // -------------------------------------------------------------------------

  private render(): void {
    const pair = this.pair;
    if (pair === undefined) return;

    // Pulled into locals so the narrowing survives into the branches below, which it
    // would not through property access on `pair`.
    const { found, sent } = pair;
    const both = found !== undefined && sent !== undefined;

    this.caption.textContent = `Step ${String(pair.step)} · ${hostOf(pair.url)}`;

    for (const [id, button] of this.tabs) {
      const usable =
        id === 'wipe' || id === 'stack'
          ? both
          : id === 'found'
            ? found !== undefined
            : sent !== undefined;
      button.disabled = !usable;
      button.setAttribute('aria-selected', String(this.mode === id));
      button.classList.toggle('is-active', this.mode === id);
    }

    this.stage.textContent = '';

    if (this.mode === 'wipe' && found !== undefined && sent !== undefined) {
      this.stage.appendChild(this.renderWipe(found, sent));
      return;
    }
    if (this.mode === 'stack' && found !== undefined && sent !== undefined) {
      this.stage.append(
        this.renderSingle('What it saw', found, 'dot-bad'),
        this.renderSingle('What was sent', sent, 'dot-ok'),
      );
      return;
    }
    if (this.mode === 'sent' && sent !== undefined) {
      this.stage.appendChild(this.renderSingle('What was sent', sent, 'dot-ok'));
      return;
    }
    if (found !== undefined) {
      this.stage.appendChild(this.renderSingle('What it saw', found, 'dot-bad'));
      return;
    }
    if (sent !== undefined) {
      this.stage.appendChild(this.renderSingle('What was sent', sent, 'dot-ok'));
      return;
    }

    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No picture was kept for this step.';
    this.stage.appendChild(empty);
  }

  /**
   * The wipe view.
   *
   * Both frames are laid on top of each other and the top one is clipped to the left
   * of the divider. They line up exactly because both were rendered from the same
   * capture at the same size, so a mask that is off by even a few pixels shows up as
   * text peeking out from under the edge — which is precisely what a viewer should
   * be able to catch.
   */
  private renderWipe(found: string, sent: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'wipe';

    const base = document.createElement('img');
    base.className = 'wipe-img';
    base.src = sent;
    base.alt = 'The screen as it was sent, with sensitive areas covered';

    const overlayWrap = document.createElement('div');
    overlayWrap.className = 'wipe-overlay';
    overlayWrap.style.width = `${String(this.split * 100)}%`;

    const overlay = document.createElement('img');
    overlay.className = 'wipe-img';
    overlay.src = found;
    overlay.alt = 'The same screen with everything detected as sensitive outlined';
    overlayWrap.appendChild(overlay);

    const handle = document.createElement('div');
    handle.className = 'wipe-handle';
    handle.style.left = `${String(this.split * 100)}%`;
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-label', 'Compare position');
    handle.setAttribute('aria-valuemin', '0');
    handle.setAttribute('aria-valuemax', '100');
    handle.setAttribute('aria-valuenow', String(Math.round(this.split * 100)));
    handle.tabIndex = 0;

    const grip = document.createElement('span');
    grip.className = 'wipe-grip';
    grip.setAttribute('aria-hidden', 'true');
    handle.appendChild(grip);

    const labelLeft = document.createElement('span');
    labelLeft.className = 'wipe-label wipe-label-left';
    labelLeft.textContent = 'found on this machine';

    const labelRight = document.createElement('span');
    labelRight.className = 'wipe-label wipe-label-right';
    labelRight.textContent = 'sent to the model';

    wrap.append(base, overlayWrap, handle, labelLeft, labelRight);

    // Pointer events rather than mouse events, so a touchscreen or pen works with the
    // same code path and `setPointerCapture` keeps the drag alive outside the element.
    const move = (event: PointerEvent): void => {
      const box = wrap.getBoundingClientRect();
      if (box.width === 0) return;
      const ratio = (event.clientX - box.left) / box.width;
      this.split = Math.max(0, Math.min(1, ratio));
      overlayWrap.style.width = `${String(this.split * 100)}%`;
      handle.style.left = `${String(this.split * 100)}%`;
      handle.setAttribute('aria-valuenow', String(Math.round(this.split * 100)));
    };

    wrap.addEventListener('pointerdown', (event) => {
      wrap.setPointerCapture(event.pointerId);
      move(event);
    });
    wrap.addEventListener('pointermove', (event) => {
      if (!wrap.hasPointerCapture(event.pointerId)) return;
      move(event);
    });
    wrap.addEventListener('pointerup', (event) => {
      wrap.releasePointerCapture(event.pointerId);
    });

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      'Drag across the picture, or use the arrow keys. The two frames are the same size, ' +
      'so anything peeking out from under an edge would be a miss.';

    const holder = document.createElement('div');
    holder.className = 'viewer-block';
    holder.append(wrap, hint, openFullSize('Open the covered-up version full size', sent));
    return holder;
  }

  private renderSingle(label: string, src: string, dot: 'dot-ok' | 'dot-bad'): HTMLElement {
    const figure = document.createElement('figure');
    figure.className = 'viewer-block';

    const caption = document.createElement('figcaption');
    caption.className = 'viewer-figcap';
    const marker = document.createElement('span');
    marker.className = `dot ${dot}`;
    caption.append(marker, document.createTextNode(label));

    const img = document.createElement('img');
    img.className = 'viewer-img';
    img.src = src;
    img.alt = label;

    figure.append(caption, img, openFullSize('Open full size', src));
    return figure;
  }
}

/**
 * Hand the untouched data URL to a new tab.
 *
 * The version to put on a projector: no downscaling, no re-encoding, exactly the
 * bytes that were produced.
 */
function openFullSize(label: string, src: string): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-quiet';
  button.textContent = label;
  button.addEventListener('click', () => {
    window.open(src, '_blank', 'noopener');
  });
  return button;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
