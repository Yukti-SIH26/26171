/**
 * Local agent machinery.
 *
 * The planner lives on a server; everything that decides whether a plan is allowed
 * to touch the page lives here. That split is the point: the model is treated as a
 * useful but untrusted source of suggestions, and the authority to act stays on the
 * user's machine.
 */

export {
  INTERCHANGEABLE_IDENTIFIERS,
  NON_TEXT_INPUT_TYPES,
  RATE_LIMIT_ACTIONS,
  RATE_LIMIT_WINDOW_MS,
  validateAction,
  validateSequence,
  type ValidatorContext,
} from './validator.ts';

export {
  SuppliedValues,
  executeAction,
  type ExecuteOptions,
  type StepRecord,
} from './executor.ts';

export {
  describeFindings,
  runLoop,
  type AuditSnapshot,
  type HiddenItem,
  type LoopCallbacks,
  type LoopOptions,
  type LoopPhase,
  type LoopResult,
  type SayTone,
} from './loop.ts';

export { inferType, rememberAnswer, type RememberOptions } from './remember.ts';
