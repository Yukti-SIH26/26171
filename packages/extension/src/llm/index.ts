/**
 * Talking to the remote reasoning model.
 *
 * Called straight from the side panel — there is no backend of ours in the middle.
 * A relay would be one more machine holding the redacted screenshot, one more thing
 * to trust, and one more thing to secure. Direct is one hop, and the user's own key
 * never leaves their machine because it was never in ours.
 */

export {
  ProviderError,
  chat,
  connect,
  ensureProviderAccess,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type ConnectResult,
  type ContentPart,
} from './client.ts';

export {
  KEY_SLOT,
  clearApiKey,
  hasApiKey,
  loadSettings,
  readApiKey,
  saveApiKey,
  saveSettings,
} from './settings.ts';

export {
  buildMessages,
  pageMessage,
  systemPrompt,
  userMessage,
  type BuildMessagesOptions,
  type ReasoningTaskState,
  type UserMessageOptions,
} from './prompt.ts';

export { planTask, type TaskPlan } from './planner.ts';

export {
  parseAction,
  type ParseFailure,
  type ParseResult,
  type ParseSuccess,
} from './parse.ts';
