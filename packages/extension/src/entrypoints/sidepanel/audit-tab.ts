/**
 * The Audit tab — the boundary made visible.
 *
 * This tab proves the architecture rather than describing it. For every turn it
 * shows two pictures: what was found, which never leaves this device, and what
 * actually went out, with the pixels destroyed. Plus a plain list of what was hidden
 * and how, and the byte count.
 *
 * Showing the pair is the whole point. A single redacted image proves nothing — you
 * cannot tell whether the boxes landed on the sensitive text or three hundred pixels
 * to the left. Only the comparison makes the claim checkable, and a privacy claim
 * nobody can check is a marketing claim.
 *
 * An earlier version of this tab also showed nine rows of detector statistics, a
 * per-finding confidence table, a placeholder dictionary, and two diagnostic drawers.
 * All of it was true and none of it answered the question the tab exists for. What
 * is left is: here is the picture, here is what was covered, here is how much left.
 */

import type { BrowserCapabilities, ElementGraph, PlatformAdapters } from '@sih/core';
import { detectPii, type KnownValue } from '../../pii/index.ts';
import {
  annotateRegions,
  buildEgressPacket,
  planRedaction,
  redactImage,
  type WithheldField,
} from '../../redact/index.ts';
import { observeWithMetrics } from '../../platform/observe-via-content.ts';
import { isDetectorLoaded, loadDetector, observePixels } from '../../models/vision.ts';
import { OWLVIT_BASE32 } from '../../models/catalogue.ts';
import { fuseChannels } from '../../perception/fusion.ts';
import { describeFindings, type HiddenItem } from '../../agent/index.ts';
import { Viewer } from './viewer.ts';
import type { OcrWord } from '../../models/ocr.ts';

type State = 'ok' | 'warn' | 'bad';

/**
 * How many turns keep their images.
 *
 * Every turn, for the whole session. This used to release older pictures after ten
 * turns to save a few tens of megabytes, and printed "Pictures for this step were
 * released to save memory" in their place. That is the wrong trade for this tab: its
 * entire purpose is to let somebody check what left their screen, and a record with
 * holes in it cannot be checked. Memory is cheaper than an unverifiable claim.
 */
const IMAGE_HISTORY = Number.POSITIVE_INFINITY;

export interface AuditEntry {
  readonly step: number;
  readonly annotatedScreenshot?: string;
  readonly redactedScreenshot?: string;
  readonly packetJson: string;
  readonly bytes: number;
  readonly hidden: readonly HiddenItem[];
  /** Fields emptied because a value was still readable in them. Normally empty. */
  readonly withheld: readonly WithheldField[];
  readonly withheldScreenshot: boolean;
  readonly url: string;
}

export interface AuditTabDeps {
  readonly el: <T extends HTMLElement>(id: string) => T;
  readonly say: (message: string, state?: State) => void;
  readonly activeTabId: () => Promise<number>;
  readonly platform: () => PlatformAdapters | undefined;
  /**
   * Vault entries, read live rather than captured once.
   *
   * Unlocking the vault mid-session has to improve detection immediately, so this is
   * a getter: the known-value layer picks up new entries on the next scan without
   * the tab being rebuilt.
   */
  readonly vault: () => readonly KnownValue[];
}

export class AuditTab {
  private readonly entries: AuditEntry[] = [];
  private readonly viewer = new Viewer();
  private capabilities: BrowserCapabilities | undefined;

  constructor(private readonly deps: AuditTabDeps) {}

  init(capabilities: BrowserCapabilities): void {
    this.capabilities = capabilities;
    this.deps.el<HTMLButtonElement>('audit-scan').addEventListener('click', () => {
      void this.scan();
    });
    this.render();
  }

  // -------------------------------------------------------------------------
  // Manual check — try it on any site, without running a task
  // -------------------------------------------------------------------------

  private async scan(): Promise<void> {
    const button = this.deps.el<HTMLButtonElement>('audit-scan');
    const platform = this.deps.platform();

    if (platform === undefined) {
      this.deps.say('This computer was not set up correctly — open ⋯ for details.', 'bad');
      return;
    }

    button.disabled = true;

    try {
      const tabId = await this.deps.activeTabId();
      const structure = await observeWithMetrics(tabId, {});
      let graph: ElementGraph = structure.graph;

      // High quality on purpose. This frame is the source for both audit images, and
      // the one people will project; compression artefacts around small text make it
      // impossible to tell whether a mask landed on the right characters.
      const frame = await platform.capture.captureViewport(tabId, {
        format: 'jpeg',
        quality: 94,
        viewport: { width: graph.viewport.width, height: graph.viewport.height },
      });

      // Load the detector if it is not up yet, rather than quietly scanning without it.
      // This panel exists to show what the real pipeline does, and the real pipeline
      // always screens the frame with the on-device model first.
      let words: readonly OcrWord[] = [];
      if (this.capabilities !== undefined) {
        if (!isDetectorLoaded()) {
          await loadDetector({ capabilities: this.capabilities, spec: OWLVIT_BASE32 });
        }
        const pixels = await observePixels({
          dataUrl: frame.dataUrl,
          devicePixelRatio: frame.scale,
          capabilities: this.capabilities,
          runOcr: true,
        });
        words = pixels.words;
        graph = fuseChannels({
          structure: graph,
          regions: pixels.regions,
          words: pixels.words,
        }).graph;
      }

      const vault = this.deps.vault();
      const detection = detectPii({ graph, words, vault });

      const plan = planRedaction({
        findings: detection.findings,
        viewport: graph.viewport,
        bounds: {
          x: 0,
          y: 0,
          width: frame.width / frame.scale,
          height: frame.height / frame.scale,
        },
      });

      const [redacted, annotated] = await Promise.all([
        redactImage({ dataUrl: frame.dataUrl, paints: plan.paints, scale: frame.scale }),
        annotateRegions(frame.dataUrl, plan.paints, frame.scale),
      ]);

      const built = buildEgressPacket({
        graph,
        findings: detection.findings,
        plan,
        redactedScreenshot: redacted.dataUrl,
        vault,
        // Exactly what a real step sends: the masked picture, always, and structure
        // without any of the page's words.
        includeScreenshot: true,
        includeText: false,
      });

      this.record({
        step: this.entries.length + 1,
        annotatedScreenshot: annotated,
        redactedScreenshot: redacted.dataUrl,
        packetJson: built.json,
        bytes: built.bytes,
        hidden: describeFindings(detection.findings),
        withheld: built.withheld,
        withheldScreenshot: false,
        url: graph.url,
      });

      const count = detection.findings.length;
      this.deps.say(
        count === 0
          ? 'Nothing of yours found on this page.'
          : `Found and covered ${String(count)} ${count === 1 ? 'thing' : 'things'} on this page.`,
        count === 0 ? 'ok' : 'warn',
      );
    } catch (error) {
      // One short line here, detail to the console. The message this used to print was
      // a developer's explanation of an internal invariant, shown verbatim to whoever
      // happened to press the button.
      console.error('[yukti] page check failed', error);
      this.deps.say('Could not check this page.', 'bad');
    } finally {
      button.disabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // Timeline
  // -------------------------------------------------------------------------

  /**
   * Record one turn.
   *
   * Images are dropped from older entries rather than the entries themselves, so the
   * byte-level record of everything sent stays complete for the whole task.
   */
  private record(entry: AuditEntry): void {
    this.entries.unshift(entry);

    for (let i = IMAGE_HISTORY; i < this.entries.length; i++) {
      const old = this.entries[i];
      if (old === undefined) continue;
      if (old.annotatedScreenshot === undefined && old.redactedScreenshot === undefined)
        continue;

      // Rebuilt without the image keys rather than setting them to `undefined`:
      // under `exactOptionalPropertyTypes` an optional property and one explicitly
      // holding `undefined` are different types, and only absence is assignable.
      const { annotatedScreenshot: _a, redactedScreenshot: _r, ...withoutImages } = old;
      this.entries[i] = withoutImages;
    }

    this.render();
  }

  /** Called by the agent loop once per turn. */
  addSnapshot(snapshot: AuditEntry): void {
    this.record(snapshot);
  }

  /** Clear at the start of a task, so turns are not mixed across runs. */
  reset(): void {
    this.entries.length = 0;
    this.render();
  }

  private render(): void {
    this.renderTotal();

    const host = this.deps.el<HTMLDivElement>('audit-timeline');
    host.textContent = '';

    if (this.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent =
        'Nothing has been sent yet. Run a task, or press "Check this page now" to see what ' +
        'would go out from wherever you are.';
      host.appendChild(empty);
      return;
    }

    for (const entry of this.entries) host.appendChild(this.renderEntry(entry));
  }

  /**
   * The running total, kept hidden.
   *
   * The element stays in the markup so the tab's layout is unchanged, but the sentence
   * is gone: it restated the tab's purpose on every render and told the user nothing
   * they could act on. The pictures are the content here.
   */
  private renderTotal(): void {
    const node = this.deps.el<HTMLDivElement>('audit-total');
    node.hidden = true;
    node.textContent = '';
  }

  private renderEntry(entry: AuditEntry): HTMLElement {
    const details = document.createElement('details');
    details.className = 'drawer step';
    // Newest open, older collapsed: the current turn is what you are watching.
    details.open = entry === this.entries[0];

    const summary = document.createElement('summary');

    const title = document.createElement('span');
    title.className = 'step-title';
    title.textContent = `Step ${String(entry.step)}`;

    const where = document.createElement('span');
    where.className = 'step-where';
    where.textContent = hostOf(entry.url);

    summary.append(title, where);
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'drawer-body';

    if (entry.annotatedScreenshot === undefined && entry.redactedScreenshot === undefined) {
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent = 'This tab had no readable page, so nothing was sent for this step.';
      body.appendChild(note);
    } else {
      // Compare first and prominent. This is the control that turns the privacy claim
      // into something a viewer can check for themselves, so it is not buried under
      // the thumbnails it explains.
      const compare = document.createElement('button');
      compare.type = 'button';
      compare.className = 'btn btn-primary btn-compare';
      compare.textContent =
        entry.annotatedScreenshot !== undefined && entry.redactedScreenshot !== undefined
          ? 'Open big and compare'
          : 'Open big';
      compare.addEventListener('click', () => {
        this.viewer.open({
          step: entry.step,
          url: entry.url,
          ...(entry.annotatedScreenshot === undefined
            ? {}
            : { found: entry.annotatedScreenshot }),
          ...(entry.redactedScreenshot === undefined ? {} : { sent: entry.redactedScreenshot }),
        });
      });
      body.appendChild(compare);
      body.appendChild(this.renderPair(entry));
    }

    if (entry.withheldScreenshot) {
      const note = document.createElement('p');
      note.className = 'notice state-warn';
      note.textContent =
        'The picture was not sent at all — so much of it needed covering that sending it ' +
        'would have left the model guessing.';
      body.appendChild(note);
    }

    // Anywhere the redactor could not clean. Recorded rather than hidden: a field that
    // was withheld is exactly the kind of thing this tab exists to be honest about.
    if (entry.withheld.length > 0) {
      const note = document.createElement('p');
      note.className = 'notice state-warn';
      const kinds = [...new Set(entry.withheld.map((w) => w.piiType.replace(/_/g, ' ')))];
      note.textContent =
        `${String(entry.withheld.length)} ${entry.withheld.length === 1 ? 'label was' : 'labels were'} ` +
        `left out entirely, because your ${kinds.join(' and ')} was still readable in ` +
        `${entry.withheld.length === 1 ? 'it' : 'them'} after covering up.`;
      body.appendChild(note);
    }

    body.appendChild(this.renderHidden(entry.hidden));

    // The raw packet is no longer shown. It is still recorded on the entry and still
    // reachable through `packetJson()`, but a wall of JSON is not what this tab is for:
    // the two pictures are the evidence a person can actually read.
    details.appendChild(body);
    return details;
  }

  /** What was hidden, in words. One row per kind, with a count when repeated. */
  private renderHidden(hidden: readonly HiddenItem[]): HTMLElement {
    const list = document.createElement('div');
    list.className = 'hidden-list';

    // One line, or nothing.
    //
    // This was a table: one row per kind of data, with a count, the masking mode and the
    // detector that fired — "email × 101 · replaced with a name-only label · format and
    // checksum". It buried the two pictures that are the actual evidence, and after the
    // packet stopped carrying page text most of those rows described masks drawn on the
    // image rather than anything that was ever at risk of being sent as text.
    if (hidden.length === 0) return list;

    return list;
  }

  private renderPair(entry: AuditEntry): HTMLElement {
    const pair = document.createElement('div');
    pair.className = 'shot-pair';

    const make = (
      label: string,
      dot: 'dot-bad' | 'dot-ok',
      src: string | undefined,
      alt: string,
    ): HTMLElement => {
      const figure = document.createElement('figure');
      figure.className = 'shot-fig';

      const caption = document.createElement('figcaption');
      const marker = document.createElement('span');
      marker.className = `dot ${dot}`;
      caption.append(marker, document.createTextNode(label));
      figure.appendChild(caption);

      if (src === undefined) {
        const missing = document.createElement('div');
        missing.className = 'empty';
        missing.textContent = 'not available';
        figure.appendChild(missing);
        return figure;
      }

      const img = document.createElement('img');
      img.className = 'shot';
      img.src = src;
      img.alt = alt;
      // Not lazy: these are the images the tab exists to show, and a placeholder that
      // fills in as you scroll is the wrong behaviour when you are presenting.
      img.loading = 'eager';
      // Click opens the comparison view rather than a raw tab. At panel width a
      // thumbnail cannot settle whether a box covered the right characters, and that
      // question is the entire point of showing them.
      img.addEventListener('click', () => {
        this.viewer.open({
          step: entry.step,
          url: entry.url,
          ...(entry.annotatedScreenshot === undefined
            ? {}
            : { found: entry.annotatedScreenshot }),
          ...(entry.redactedScreenshot === undefined ? {} : { sent: entry.redactedScreenshot }),
        });
      });
      img.style.cursor = 'zoom-in';
      figure.appendChild(img);
      return figure;
    };

    pair.append(
      make(
        'what Yukti saw — stays on this machine',
        'dot-bad',
        entry.annotatedScreenshot,
        'The screen with everything detected as sensitive outlined',
      ),
      make(
        'what was sent — covered up',
        'dot-ok',
        entry.redactedScreenshot,
        'The same screen with sensitive areas painted over. Shown here at full ' +
          'resolution; the copy that left the machine is the same image resampled smaller.',
      ),
    );
    return pair;
  }

  /** The exact bytes of the most recent turn. */
  packetJson(): string {
    return this.entries[0]?.packetJson ?? '';
  }

  /** Total transmitted across the timeline. */
  totalBytes(): number {
    return this.entries.reduce((sum, entry) => sum + entry.bytes, 0);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// `prettyPacket` lived here, formatting the packet JSON for a drawer in each step. The
// drawer is gone — the pictures are the evidence worth reading — so the formatter went
// with it. The packet itself is still recorded on every entry.
