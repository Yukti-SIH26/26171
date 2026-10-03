/**
 * Modal prompts, for the two cases that genuinely interrupt.
 *
 * Confirming a deletion, and proving it is you before a protected value is read.
 * Both are moments where continuing without a definite answer would be wrong, which
 * is what earns a modal.
 *
 * Asking the agent's own questions used to happen here too. It was the wrong place:
 * a dialog covered the transcript that gave the question its context, and it made an
 * ordinary part of the flow feel like an error. Those now appear inline in the chat.
 *
 * Built on the native `<dialog>` because focus trapping, Escape handling, and
 * stacking are things browsers already do correctly and hand-rolled modals reliably
 * get wrong.
 */

/** Cap on the reason text. A prompt is a sentence, not a payload. */
const MAX_REASON_LENGTH = 220;

export type PromptKind = 'text' | 'secret' | 'confirm' | 'passphrase';

export interface PromptRequest {
  readonly title: string;
  readonly message: string;
  readonly kind: PromptKind;
  readonly hint?: string;
  readonly okLabel?: string;
}

interface Elements {
  readonly dialog: HTMLDialogElement;
  readonly form: HTMLFormElement;
  readonly title: HTMLHeadingElement;
  readonly message: HTMLParagraphElement;
  readonly input: HTMLInputElement;
  readonly hint: HTMLParagraphElement;
  readonly ok: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
}

/**
 * Serialises prompts.
 *
 * A `<dialog>` can only be open once, and the agent loop can plausibly produce two
 * requests in quick succession. Queueing avoids the second call silently failing
 * to show, which would look like the agent hanging.
 */
export class Prompter {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly el: Elements) {}

  static fromDom(lookup: <T extends HTMLElement>(id: string) => T): Prompter {
    return new Prompter({
      dialog: lookup<HTMLDialogElement>('prompt-dialog'),
      form: lookup<HTMLFormElement>('prompt-form'),
      title: lookup<HTMLHeadingElement>('prompt-title'),
      message: lookup<HTMLParagraphElement>('prompt-message'),
      input: lookup<HTMLInputElement>('prompt-input'),
      hint: lookup<HTMLParagraphElement>('prompt-hint'),
      ok: lookup<HTMLButtonElement>('prompt-ok'),
      cancel: lookup<HTMLButtonElement>('prompt-cancel'),
    });
  }

  /** Run prompts one at a time, in request order. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    // Swallow rejections on the chain itself so one failed prompt does not poison
    // every later one; the caller still sees its own result.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Ask for a value. Resolves to `undefined` if the user cancels.
   */
  ask(request: PromptRequest): Promise<string | undefined> {
    return this.enqueue(() => this.show(request));
  }

  /** Ask a yes/no question. */
  async confirm(message: string, title = 'Confirm'): Promise<boolean> {
    const answer = await this.ask({
      title,
      message,
      kind: 'confirm',
      okLabel: 'Allow',
    });
    return answer !== undefined;
  }

  /** Ask for the vault passphrase, for a session-gated value. */
  async passphrase(reason: string): Promise<string | undefined> {
    return this.ask({
      title: 'Passphrase needed',
      message: reason,
      kind: 'passphrase',
      hint: 'This value is protected — confirm it is you before it is used.',
      okLabel: 'Unlock',
    });
  }

  private show(request: PromptRequest): Promise<string | undefined> {
    const { dialog, form, title, message, input, hint, ok, cancel } = this.el;

    title.textContent = request.title;
    // textContent, never innerHTML: this string originates from the planner, which
    // can be influenced by page content.
    message.textContent =
      request.message.length > MAX_REASON_LENGTH
        ? `${request.message.slice(0, MAX_REASON_LENGTH)}…`
        : request.message;

    hint.textContent = request.hint ?? '';
    ok.textContent = request.okLabel ?? 'Send';

    const isConfirm = request.kind === 'confirm';
    input.hidden = isConfirm;
    input.type =
      request.kind === 'secret' || request.kind === 'passphrase' ? 'password' : 'text';
    input.value = '';
    input.required = !isConfirm;

    return new Promise<string | undefined>((resolve) => {
      let settled = false;

      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;

        form.removeEventListener('submit', onSubmit);
        cancel.removeEventListener('click', onCancel);
        dialog.removeEventListener('close', onClose);

        // Clear before resolving: the field must not keep a secret on screen or in
        // the DOM once the answer has been handed over.
        input.value = '';
        if (dialog.open) dialog.close();
        resolve(value);
      };

      const onSubmit = (event: Event): void => {
        event.preventDefault();
        finish(isConfirm ? 'confirmed' : input.value);
      };
      const onCancel = (): void => {
        finish(undefined);
      };
      // Covers Escape, which closes a <dialog> without firing submit or click.
      const onClose = (): void => {
        finish(undefined);
      };

      form.addEventListener('submit', onSubmit);
      cancel.addEventListener('click', onCancel);
      dialog.addEventListener('close', onClose);

      dialog.showModal();
      if (!isConfirm) input.focus();
      else ok.focus();
    });
  }
}
