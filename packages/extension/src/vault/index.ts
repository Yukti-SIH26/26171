/**
 * The Profile Vault.
 *
 * The user's own sensitive values, encrypted at rest with a key derived from their
 * passphrase, never transmitted anywhere. It exists for two reasons that reinforce
 * each other: the agent can fill in a value the server asked for by placeholder,
 * and the same values become a high-precision redaction dictionary.
 */

export {
  ENVELOPE_VERSION,
  PBKDF2_ITERATIONS,
  assessPassphrase,
  type Envelope,
} from './crypto.ts';

export {
  asRedactionDictionary,
  consumeEphemeral,
  destroy,
  downgradeToDeviceKey,
  findByToken,
  initialise,
  keyMode,
  list,
  lock,
  openAutomatically,
  put,
  rebind,
  recordUse,
  remove,
  resetForTesting,
  reveal,
  status,
  summary,
  unlock,
  upgradeToPassphrase,
  verifyPassphrase,
  type EntryView,
  type KeyMode,
  type PutOptions,
} from './store.ts';
