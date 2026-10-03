/**
 * Screenshot redaction.
 *
 * Paints over sensitive regions and re-encodes. The output is a new image built
 * from pixels, not the original with an overlay — an overlay would be trivially
 * strippable and the original bytes would still be in the payload.
 *
 * Two rules that are enforced here rather than trusted:
 *
 *  1. **Solid masks are drawn opaque, never translucent.** A 90%-opacity black
 *     rectangle over dark text still leaves recoverable contrast. `globalAlpha` is
 *     reset to 1 before every mask draw so no earlier state can weaken it.
 *
 *  2. **Blur never reaches text.** `canvas.filter = 'blur()'` is reversible enough
 *     on structured text (a 12-digit number in a known font) to be unsafe, so the
 *     policy layer forbids it for those types and this module treats any blur
 *     request as pixelation-plus-blur: destructive downsampling first, so there is
 *     no high-frequency detail left for a deblurring model to recover, then a blur
 *     for appearance.
 *
 * The redacted image is also re-encoded as JPEG by default, which discards the
 * original's exact pixel values as a side effect. That is a small additional
 * safety margin rather than the main mechanism.
 */

import type { Rect } from '@sih/core';
import type { PaintOp } from './plan.ts';

export interface RedactImageOptions {
  /** Original screenshot as a `data:` URL. */
  readonly dataUrl: string;
  readonly paints: readonly PaintOp[];
  /**
   * Scale from the coordinate space of `paints` to image pixels.
   *
   * Findings are in CSS pixels; the screenshot is in device pixels. Getting this
   * wrong on a HiDPI screen means every mask lands at half size in the top-left
   * quadrant, so it is a required argument rather than a defaulted one.
   */
  readonly scale: number;
  readonly format?: 'image/jpeg' | 'image/png';
  readonly quality?: number;
  /**
   * Also produce a smaller copy for transmission, capped to this long edge.
   *
   * Two copies rather than one because they answer to different people. The full-size
   * one is for the Audit tab, where somebody has to be able to see that a mask actually
   * covers the number underneath it — on a projector, in front of a room. The small one
   * is for the wire, where a HiDPI frame is four times the bytes for text no larger than
   * what the user is looking at.
   *
   * Both are encoded from the same masked pixel buffer, so the small copy is a resample
   * of a redacted image and never a second redaction. The order matters: masking at full
   * resolution and then shrinking cannot uncover anything, whereas computing masks
   * against a shrunken frame would round every rectangle inwards.
   */
  readonly wireMaxEdge?: number;
}

export interface RedactImageResult {
  readonly dataUrl: string;
  readonly width: number;
  readonly height: number;
  readonly painted: number;
  readonly durationMs: number;
  readonly bytes: number;
  /**
   * The transmission copy, when one was asked for and was actually smaller.
   *
   * Absent when the frame was already within the cap, so the caller falls back to
   * `dataUrl` and never sends a needlessly re-encoded image.
   */
  readonly wireDataUrl?: string;
  readonly wireWidth?: number;
  readonly wireHeight?: number;
  readonly wireBytes?: number;
}

/** Downsample factor for pixelation. Higher destroys more detail. */
const PIXELATE_BLOCK = 14;

/** Blur radius applied after pixelation, purely cosmetic. */
const BLUR_RADIUS = 8;

function scaleRect(rect: Rect, scale: number): Rect {
  return {
    x: Math.floor(rect.x * scale),
    y: Math.floor(rect.y * scale),
    width: Math.ceil(rect.width * scale),
    height: Math.ceil(rect.height * scale),
  };
}

async function loadImage(dataUrl: string): Promise<ImageBitmap> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

/**
 * Destroy detail in a region by downsampling and scaling back up.
 *
 * Genuinely lossy, unlike a blur: the intermediate buffer physically has fewer
 * pixels, so the information is gone rather than smeared. This is what makes it
 * acceptable where a blur would not be.
 */
function pixelate(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  rect: Rect,
  sourceWidth: number,
  sourceHeight: number,
): void {
  const smallWidth = Math.max(1, Math.floor(rect.width / PIXELATE_BLOCK));
  const smallHeight = Math.max(1, Math.floor(rect.height / PIXELATE_BLOCK));

  const scratch = document.createElement('canvas');
  scratch.width = smallWidth;
  scratch.height = smallHeight;
  const scratchCtx = scratch.getContext('2d');
  if (scratchCtx === null) return;

  // Clamp the source read to the image, or drawImage silently yields transparent
  // pixels for the out-of-bounds part and the region ends up uncovered.
  const sx = Math.max(0, Math.min(rect.x, sourceWidth - 1));
  const sy = Math.max(0, Math.min(rect.y, sourceHeight - 1));
  const sw = Math.max(1, Math.min(rect.width, sourceWidth - sx));
  const sh = Math.max(1, Math.min(rect.height, sourceHeight - sy));

  scratchCtx.imageSmoothingEnabled = true;
  scratchCtx.drawImage(source, sx, sy, sw, sh, 0, 0, smallWidth, smallHeight);

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = false;
  ctx.filter = `blur(${String(BLUR_RADIUS)}px)`;
  // Clip so the blur cannot bleed outside the region it is meant to cover.
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.drawImage(
    scratch,
    0,
    0,
    smallWidth,
    smallHeight,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
  );
  ctx.restore();
}

/**
 * Draw an opaque mask.
 *
 * `globalAlpha` and `filter` are reset explicitly. Relying on canvas state left
 * by a previous operation is how a mask ends up semi-transparent, and a
 * semi-transparent mask over text is not a redaction.
 */
function maskSolid(ctx: CanvasRenderingContext2D, rect: Rect): void {
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000000';
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

  // A thin outline in a distinct colour, so a human reviewing the redacted image
  // can see that a region was deliberately covered rather than rendered black by
  // the page itself. Purely for auditability.
  ctx.strokeStyle = '#ff3b30';
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
  ctx.restore();
}

/**
 * Produce a redacted copy of a screenshot.
 *
 * Throws rather than returning the original if anything fails. A redaction
 * pipeline that silently falls back to the unredacted image on error is worse than
 * one that stops, because the failure is invisible at exactly the moment it
 * matters.
 */
export async function redactImage(options: RedactImageOptions): Promise<RedactImageResult> {
  const started = performance.now();
  const { dataUrl, paints, scale } = options;

  const bitmap = await loadImage(dataUrl);
  // Captured before `close()`, after which the bitmap reports zero dimensions.
  const width = bitmap.width;
  const height = bitmap.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx === null) {
    bitmap.close();
    throw new Error('2D canvas unavailable, cannot redact the screenshot');
  }

  ctx.drawImage(bitmap, 0, 0);

  let painted = 0;
  for (const op of paints) {
    const rect = scaleRect(op.rect, scale);
    if (rect.width <= 0 || rect.height <= 0) continue;

    switch (op.mode) {
      case 'blur':
        // Pixelate first so there is no fine detail left for a deblurring model,
        // then blur for appearance. A plain canvas blur alone would not be enough.
        pixelate(ctx, bitmap, rect, width, height);
        painted++;
        break;

      case 'mask_solid':
      case 'placeholder':
      case 'synthetic':
      case 'drop':
        // Everything that is not an explicit blur is masked opaque in the image.
        // `placeholder` and `synthetic` describe what replaces the value in the
        // *text* payload; in pixels there is nothing to substitute, so the only
        // correct action is to cover it.
        maskSolid(ctx, rect);
        painted++;
        break;

      case 'none':
        break;
    }
  }

  bitmap.close();

  const format = options.format ?? 'image/jpeg';
  const quality = options.quality ?? 0.82;
  const out = canvas.toDataURL(format, quality);

  // The wire copy, resampled from the masked canvas before it is released.
  let wire: { dataUrl: string; width: number; height: number } | undefined;
  const cap = options.wireMaxEdge;
  if (cap !== undefined && cap > 0) {
    const longest = Math.max(width, height);
    if (longest > cap) {
      const ratio = cap / longest;
      const wireWidth = Math.max(1, Math.round(width * ratio));
      const wireHeight = Math.max(1, Math.round(height * ratio));
      const small = document.createElement('canvas');
      small.width = wireWidth;
      small.height = wireHeight;
      const smallCtx = small.getContext('2d', { alpha: false });
      if (smallCtx !== null) {
        smallCtx.imageSmoothingEnabled = true;
        smallCtx.imageSmoothingQuality = 'high';
        smallCtx.drawImage(canvas, 0, 0, width, height, 0, 0, wireWidth, wireHeight);
        wire = {
          dataUrl: small.toDataURL(format, quality),
          width: wireWidth,
          height: wireHeight,
        };
      }
      small.width = 0;
      small.height = 0;
    }
  }

  // Release the backing store immediately. A full-viewport HiDPI canvas is tens of
  // megabytes and this runs on every agent step.
  canvas.width = 0;
  canvas.height = 0;

  return {
    dataUrl: out,
    width,
    height,
    painted,
    durationMs: performance.now() - started,
    bytes: encodedBytes(out),
    ...(wire === undefined
      ? {}
      : {
          wireDataUrl: wire.dataUrl,
          wireWidth: wire.width,
          wireHeight: wire.height,
          wireBytes: encodedBytes(wire.dataUrl),
        }),
  };
}

/** Decoded size of a `data:` URL's payload, without decoding it. */
function encodedBytes(dataUrl: string): number {
  return Math.floor(((dataUrl.length - (dataUrl.indexOf(',') + 1)) * 3) / 4);
}

/**
 * Draw the redaction regions on a copy of the original without covering anything,
 * so a human can check that the boxes land where they should.
 *
 * This is the "what was found" half of the audit pair, and it carries more weight
 * than it looks: the redacted image on its own proves nothing, because you cannot
 * tell whether a black rectangle covered the Aadhaar number or the whitespace next
 * to it. Only this image, held next to that one, makes the claim checkable.
 *
 * So it is drawn to be read at a distance and on a projector, not just in a 400px
 * side panel: thick strokes that survive downscaling, a translucent wash that keeps
 * the underlying text legible, and every box labelled with what was recognised
 * there. A viewer should be able to look at one region and say "yes, that is a
 * phone number, and yes, it is covered in the other image".
 *
 * Never sent anywhere — this image contains the unredacted pixels by definition.
 */
export async function annotateRegions(
  dataUrl: string,
  paints: readonly PaintOp[],
  scale: number,
): Promise<string> {
  const bitmap = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx === null) {
    bitmap.close();
    throw new Error('2D canvas unavailable');
  }

  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  // Stroke and type scale with the image, so a 2560-wide HiDPI capture does not end
  // up with hairlines that vanish the moment it is scaled to fit a panel.
  const unit = Math.max(1, Math.round(canvas.width / 900));
  const stroke = 2 * unit;
  const fontSize = Math.max(11, 11 * unit);

  for (const op of paints) {
    const rect = scaleRect(op.rect, scale);
    if (rect.width <= 0 || rect.height <= 0) continue;

    const colour = op.mode === 'blur' ? '#0a84ff' : '#ff3b30';

    ctx.save();
    // Light wash rather than a heavy fill: the point of this image is that the real
    // value is still readable underneath, so it can be compared against the other.
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = colour;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

    ctx.globalAlpha = 1;
    ctx.strokeStyle = colour;
    ctx.lineWidth = stroke;
    ctx.strokeRect(
      rect.x + stroke / 2,
      rect.y + stroke / 2,
      Math.max(1, rect.width - stroke),
      Math.max(1, rect.height - stroke),
    );
    ctx.restore();

    drawLabel(ctx, rect, op.piiTypes.join(' + ').replace(/_/g, ' '), colour, fontSize, unit);
  }

  // Higher quality than the outgoing image. This one never travels, and it is the
  // one that has to stay legible when it is put on a screen in front of a room.
  const out = canvas.toDataURL('image/jpeg', 0.94);
  canvas.width = 0;
  canvas.height = 0;
  return out;
}

/**
 * Caption a region with what was recognised in it.
 *
 * Placed above the box where there is room and inside the top edge where there is
 * not, because a label clipped off the canvas is the one case where this would make
 * the image harder to read rather than easier.
 */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  text: string,
  colour: string,
  fontSize: number,
  unit: number,
): void {
  if (text === '') return;

  ctx.save();
  ctx.font = `600 ${String(fontSize)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'top';

  const padX = 3 * unit;
  const padY = 2 * unit;
  const textWidth = ctx.measureText(text).width;
  const boxHeight = fontSize + padY * 2;
  const boxWidth = textWidth + padX * 2;

  const above = rect.y - boxHeight - unit;
  const y = above >= 0 ? above : rect.y + unit;
  // Keep the label on canvas horizontally too, for a region flush with the right edge.
  const x = Math.max(0, Math.min(rect.x, ctx.canvas.width - boxWidth));

  ctx.fillStyle = colour;
  ctx.fillRect(x, y, boxWidth, boxHeight);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x + padX, y + padY);
  ctx.restore();
}
