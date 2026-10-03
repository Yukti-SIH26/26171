/**
 * The Profile tab.
 *
 * A list of what Yukti knows about the user, which site each thing belongs to, and a
 * way to delete it. That is the whole surface.
 *
 * It used to carry considerably more: a paragraph explaining the encryption, a
 * four-row summary of key derivation and disk residency, and a twenty-one-row table
 * of every supported data type with its confidence threshold and blur policy. Every
 * row was true. None of it answered the question somebody opens this tab to ask,
 * which is "what does this thing know about me, and can I delete it".
 *
 * Two things are still enforced here rather than just described:
 *
 *  - Values are never rendered in the list, only their length. Revealing one is a
 *    separate, deliberate action.
 *  - The provider API key is filtered out. It lives in the same vault because that
 *    is the only encrypted store on the device, but it is not the user's personal
 *    data and listing it next to their Aadhaar number just invites them to delete it
 *    and wonder why the agent stopped working.
 */

import { policyFor, VaultAuthError, type PiiType } from '@sih/core';
import * as vault from '../../vault/index.ts';
import { assessPassphrase } from '../../vault/index.ts';
import { KEY_SLOT } from '../../llm/index.ts';
import type { EntryView } from '../../vault/store.ts';
import type { Prompter } from './prompt.ts';

type State = 'ok' | 'warn' | 'bad';

export interface ProfileTabDeps {
  readonly el: <T extends HTMLElement>(id: string) => T;
  readonly say: (message: string, state?: State) => void;
  readonly prompter: Prompter;
  /** Called after any change, so the detectors pick up the new dictionary. */
  readonly onVaultChanged: () => void;
}

/**
 * Types offered in the "add" dropdown, in the order a user is likely to want them.
 *
 * Trimmed to what a person would realistically type in by hand. The rest of the
 * taxonomy still exists and is still detected and redacted — it just does not need
 * to be in a dropdown. `face` and `signature` are absent because they are detected
 * in pixels, not stored as text, so offering them would be misleading.
 */
const OFFERED_TYPES: readonly PiiType[] = [
  'person_name',
  'roll_number',
  'registration_number',
  'email',
  'phone',
  'password',
  'api_key',
  'secret_token',
  'aadhaar',
  'pan',
  'date_of_birth',
  'address',
  'bank_account',
  'upi_id',
];

function humanise(value: string): string {
  return value.replace(/_/g, ' ');
}

/** Host as a person would say it, for the site a credential is bound to. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return origin;
  }
}

/** Accept `digilocker.gov.in` as well as a full origin, and normalise to an origin. */
function toOrigin(input: string): string | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  try {
    return new URL(trimmed).origin;
  } catch {
    try {
      return new URL(`https://${trimmed}`).origin;
    } catch {
      return undefined;
    }
  }
}

export class ProfileTab {
  constructor(private readonly deps: ProfileTabDeps) {}

  async init(): Promise<void> {
    this.populateTypes();

    this.deps.el<HTMLButtonElement>('vault-unlock').addEventListener('click', () => {
      void this.unlock();
    });
    this.deps.el<HTMLButtonElement>('vault-create').addEventListener('click', () => {
      void this.create();
    });
    this.deps.el<HTMLButtonElement>('vault-add').addEventListener('click', () => {
      void this.add();
    });
    this.deps.el<HTMLButtonElement>('vault-destroy').addEventListener('click', () => {
      void this.destroy();
    });

    // Enter in the passphrase field should do the obvious thing.
    this.deps.el<HTMLInputElement>('vault-passphrase').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const creating = !this.deps.el<HTMLButtonElement>('vault-create').hidden;
      void (creating ? this.create() : this.unlock());
    });

    // Live feedback while choosing a passphrase, rather than rejecting on submit.
    this.deps.el<HTMLInputElement>('vault-passphrase').addEventListener('input', () => {
      if (this.deps.el<HTMLButtonElement>('vault-create').hidden) return;
      const value = this.deps.el<HTMLInputElement>('vault-passphrase').value;
      const hint = this.deps.el<HTMLParagraphElement>('vault-auth-hint');
      if (value === '') {
        hint.textContent = 'There is no recovery if you forget this.';
        return;
      }
      const verdict = assessPassphrase(value);
      hint.textContent = verdict.ok ? 'Strong enough.' : (verdict.reason ?? '');
      hint.classList.toggle('state-ok', verdict.ok);
      hint.classList.toggle('state-warn', !verdict.ok);
    });

    this.deps.el<HTMLSelectElement>('vault-add-type').addEventListener('change', () => {
      this.renderAddHint();
    });

    await this.refresh();
  }

  private populateTypes(): void {
    const select = this.deps.el<HTMLSelectElement>('vault-add-type');
    select.textContent = '';
    for (const piiType of OFFERED_TYPES) {
      const option = document.createElement('option');
      option.value = piiType;
      option.textContent = humanise(piiType);
      select.appendChild(option);
    }
    this.renderAddHint();
  }

  /**
   * One line about what happens to this value, before it is typed.
   *
   * Telling somebody afterwards that their password needs a site, or that a one-time
   * code was not saved, is worse than telling them first.
   */
  private renderAddHint(): void {
    const select = this.deps.el<HTMLSelectElement>('vault-add-type');
    const hint = this.deps.el<HTMLParagraphElement>('vault-add-hint');
    const site = this.deps.el<HTMLInputElement>('vault-add-site');
    const policy = policyFor(select.value as PiiType);

    hint.classList.remove('state-ok', 'state-warn');

    // No explanatory line under the picker. The site field's own placeholder already
    // says whether a site is wanted, and the sentence it replaced described a rule the
    // user cannot change from here anyway.
    hint.textContent = '';
    site.placeholder = policy.confirmBeforeUse ? 'e.g. digilocker.gov.in' : 'not needed';
  }

  /** Render whichever of the three states the vault is in. */
  private async refresh(): Promise<void> {
    const status = await vault.status();
    const notice = this.deps.el<HTMLDivElement>('vault-status');
    const auth = this.deps.el<HTMLDivElement>('vault-auth');
    const body = this.deps.el<HTMLDivElement>('vault-body');
    const unlockBtn = this.deps.el<HTMLButtonElement>('vault-unlock');
    const createBtn = this.deps.el<HTMLButtonElement>('vault-create');
    const hint = this.deps.el<HTMLParagraphElement>('vault-auth-hint');

    notice.classList.remove('state-ok', 'state-warn', 'state-bad');

    switch (status) {
      case 'uninitialised':
        // Reached only if the automatic open failed, which should not normally
        // happen. Offering the passphrase path is the useful fallback.
        notice.hidden = false;
        notice.textContent = 'Could not open automatically. Set a passphrase to create it.';
        notice.classList.add('state-warn');
        auth.hidden = false;
        body.hidden = true;
        unlockBtn.hidden = true;
        createBtn.hidden = false;
        hint.textContent = 'There is no recovery if you forget this.';
        break;

      case 'locked':
        notice.hidden = false;
        notice.textContent = 'Locked.';
        notice.classList.add('state-warn');
        auth.hidden = false;
        body.hidden = true;
        unlockBtn.hidden = false;
        createBtn.hidden = true;
        hint.textContent = '';
        break;

      case 'unlocked':
        // Nothing to say when it is open and working, so nothing is said.
        notice.hidden = true;
        auth.hidden = true;
        body.hidden = false;
        this.deps.el<HTMLInputElement>('vault-passphrase').value = '';
        this.renderEntries();
        break;
    }
  }

  /** Everything the user put in, or the agent learned. The provider key is not that. */
  private userEntries(): EntryView[] {
    return vault.list().filter((entry) => entry.slot !== KEY_SLOT);
  }

  private renderEntries(): void {
    const list = this.deps.el<HTMLDivElement>('vault-entries');
    list.textContent = '';

    const entries = this.userEntries();
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Nothing remembered yet.';
      list.appendChild(empty);
      return;
    }

    for (const entry of entries) list.appendChild(this.renderEntry(entry));
  }

  private renderEntry(entry: EntryView): HTMLElement {
    const rowEl = document.createElement('div');
    rowEl.className = 'entry-row';

    const label = document.createElement('div');
    label.className = 'entry-label';
    label.textContent = entry.label;

    const actions = document.createElement('div');
    actions.className = 'el-actions';

    const revealBtn = document.createElement('button');
    revealBtn.type = 'button';
    revealBtn.className = 'btn-icon';
    revealBtn.textContent = 'Show';
    revealBtn.addEventListener('click', () => {
      void this.reveal(entry, revealBtn);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-icon danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      void this.remove(entry);
    });

    actions.append(revealBtn, deleteBtn);

    const meta = document.createElement('div');
    meta.className = 'entry-meta';

    const kind = document.createElement('span');
    kind.className = 'pill pill-int';
    kind.textContent = humanise(entry.piiType);
    meta.appendChild(kind);

    // Which site it belongs to. The single most useful fact about a stored
    // credential, because it is also the rule that governs where it may be used.
    if (entry.site !== undefined) {
      const site = document.createElement('span');
      site.className = 'pill pill-fused';
      site.textContent = hostOf(entry.site);
      meta.appendChild(site);
    } else if (policyFor(entry.piiType).confirmBeforeUse) {
      const site = document.createElement('span');
      site.className = 'pill pill-edit';
      site.textContent = 'no site yet';
      meta.appendChild(site);
    }

    if (entry.lifetime === 'ephemeral') {
      const mem = document.createElement('span');
      mem.className = 'pill pill-hidden';
      mem.textContent = 'not saved';
      meta.appendChild(mem);
    }

    // Value length, never the value.
    meta.append(document.createTextNode(`${String(entry.length)} characters`));

    rowEl.append(label, actions, meta);
    return rowEl;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  private async create(): Promise<void> {
    const field = this.deps.el<HTMLInputElement>('vault-passphrase');
    const hint = this.deps.el<HTMLParagraphElement>('vault-auth-hint');

    const verdict = assessPassphrase(field.value);
    if (!verdict.ok) {
      hint.textContent = verdict.reason ?? 'Choose a stronger passphrase.';
      hint.classList.add('state-warn');
      return;
    }

    const button = this.deps.el<HTMLButtonElement>('vault-create');
    button.disabled = true;
    hint.textContent = 'Deriving the key… this takes a moment on purpose.';
    try {
      await vault.initialise(field.value);
      field.value = '';
      await this.refresh();
      this.deps.onVaultChanged();
    } catch (error) {
      hint.textContent = error instanceof Error ? error.message : 'could not create it';
      hint.classList.add('state-bad');
    } finally {
      button.disabled = false;
    }
  }

  private async unlock(): Promise<void> {
    const field = this.deps.el<HTMLInputElement>('vault-passphrase');
    const hint = this.deps.el<HTMLParagraphElement>('vault-auth-hint');
    const button = this.deps.el<HTMLButtonElement>('vault-unlock');

    if (field.value === '') {
      hint.textContent = 'Enter your passphrase.';
      return;
    }

    button.disabled = true;
    hint.classList.remove('state-bad');
    hint.textContent = 'Deriving the key…';
    try {
      await vault.unlock(field.value);
      field.value = '';
      hint.textContent = '';
      await this.refresh();
      this.deps.onVaultChanged();
    } catch (error) {
      hint.textContent =
        error instanceof VaultAuthError ? 'Incorrect passphrase.' : String(error);
      hint.classList.add('state-bad');
    } finally {
      button.disabled = false;
    }
  }

  private async add(): Promise<void> {
    const typeField = this.deps.el<HTMLSelectElement>('vault-add-type');
    const valueField = this.deps.el<HTMLInputElement>('vault-add-value');
    const siteField = this.deps.el<HTMLInputElement>('vault-add-site');
    const hint = this.deps.el<HTMLParagraphElement>('vault-add-hint');

    if (valueField.value === '') {
      hint.textContent = 'Enter the value first.';
      hint.classList.add('state-warn');
      return;
    }

    const piiType = typeField.value as PiiType;
    const site = toOrigin(siteField.value);

    if (site === undefined && siteField.value.trim() !== '') {
      hint.textContent = 'That does not look like a web address.';
      hint.classList.add('state-warn');
      return;
    }

    // The label is derived rather than asked for. One fewer field, and it stays
    // consistent with the labels the agent writes when it learns something itself.
    const label =
      site === undefined ? humanise(piiType) : `${hostOf(site)} ${humanise(piiType)}`;

    try {
      await vault.put({
        piiType,
        label,
        value: valueField.value,
        ...(site === undefined ? {} : { site }),
      });

      // Clear immediately: no reason for the plaintext to stay in the DOM.
      valueField.value = '';
      siteField.value = '';
      this.renderAddHint();
      await this.refresh();
      this.deps.onVaultChanged();
    } catch (error) {
      hint.textContent = error instanceof Error ? error.message : 'could not save';
      hint.classList.add('state-bad');
    }
  }

  /**
   * Show a value briefly.
   *
   * Session-lifetime entries cost a passphrase, which is the whole point of that
   * lifetime. The value is put back out of sight on a timer so it does not sit on
   * screen indefinitely.
   */
  private async reveal(entry: EntryView, button: HTMLButtonElement): Promise<void> {
    try {
      let passphrase: string | undefined;
      if (entry.gated) {
        passphrase = await this.deps.prompter.passphrase(
          `Reading "${entry.label}" needs your passphrase.`,
        );
        if (passphrase === undefined) return;
      }

      button.textContent = await vault.reveal(entry.slot, passphrase);
      button.classList.add('danger');

      window.setTimeout(() => {
        button.textContent = 'Show';
        button.classList.remove('danger');
      }, 8000);
    } catch (error) {
      this.deps.say(
        `Could not show that: ${error instanceof Error ? error.message : 'unknown error'}`,
        'bad',
      );
    }
  }

  private async remove(entry: EntryView): Promise<void> {
    const confirmed = await this.deps.prompter.confirm(
      `Delete "${entry.label}"? It will also stop being covered up automatically when it ` +
        `appears on a page.`,
      'Delete',
    );
    if (!confirmed) return;

    await vault.remove(entry.slot);
    await this.refresh();
    this.deps.onVaultChanged();
  }

  private async destroy(): Promise<void> {
    const confirmed = await this.deps.prompter.confirm(
      'Forget everything, including your provider key? There is no recovery.',
      'Forget everything',
    );
    if (!confirmed) return;

    await vault.destroy();
    await this.refresh();
    this.deps.onVaultChanged();
  }

  /** Re-read state, for callers that changed the vault from elsewhere. */
  reload(): Promise<void> {
    return this.refresh();
  }
}
