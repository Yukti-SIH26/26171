/**
 * Redaction: the boundary between what stays on this machine and what does not.
 *
 * The pipeline is deliberately three separate stages rather than one function:
 *
 *   plan    decide what to hide and whether the result is still worth sending
 *   image   destroy the pixels
 *   packet  build the outbound payload from an allow-list, then prove no secret
 *           survived
 *
 * Splitting them means each is testable on its own, and the packet stage can
 * refuse to emit even if the earlier stages were wrong.
 */

export {
  HEAVY_COVERAGE,
  REFUSE_COVERAGE,
  SAFETY_PAD,
  placeholderFor,
  planRedaction,
  syntheticFor,
  type BudgetVerdict,
  type PaintOp,
  type PlanOptions,
  type RedactionPlan,
  type TextEdit,
} from './plan.ts';

export {
  annotateRegions,
  redactImage,
  type RedactImageOptions,
  type RedactImageResult,
} from './image.ts';

export {
  buildEgressPacket,
  type BuildPacketOptions,
  type BuildPacketResult,
  type EgressPacket,
  type PlaceholderInfo,
  type RedactedRegion,
  type SanitizedNode,
  type WithheldField,
} from './packet.ts';
