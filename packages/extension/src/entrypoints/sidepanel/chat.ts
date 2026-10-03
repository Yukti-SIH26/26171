/**
 * The chat view.
 *
 * Everything the agent has to say goes here, one short line per step, in order.
 * What it replaced was a monospace log with a timestamp on every row and refusal
 * codes inline — accurate, and unreadable. The person watching wants to know what
 * their browser is doing right now, not to parse it.
 *
 * Three rules hold the surface together:
 *
 *  - **One line, present tense, no jargon.** "Opening digilocker.gov.in", not
 *    "goto_url https://www.digilocker.gov.in/ ok 412ms".
 *  - **Quiet things stay quiet.** What was hidden before sending is real and worth
 *    recording, but it is not the story of the step, so it renders small and grey.
 *  - **Asking happens in place.** When the agent needs something it does not have,
 *    the question appears as the next bubble in the conversation with a field in it.
 *    A modal for this was wrong: it covered the transcript that gave the question
 *    its context, and it made a normal part of the flow feel like an error.
 */

/** How a line reads. Mirrors the loop's tones. */
export type Tone = 'step' | 'note' | 'warn' | 'bad';

/**
 * Categories where the answer is hidden as it is typed.
 *
 * Deliberately short. It used to include `missing_profile_field` and `other`, which is
 * almost everything — so being asked for a first name gave a password box. That is wrong
 * twice over: masking exists to stop someone reading a credential over your shoulder, and
 * a name is not one; and a value you cannot read back is a value you cannot check, which
 * on a roll number or a pincode means a typo submitted to a real form.
 *
 * An OTP stays visible for the same reason — six digits that have to be right, used once.
 */
const SECRET_CATEGORIES = new Set(['password', 'cvv', 'security_answer']);

/**
 * Wording for each thing the agent might ask for.
 *
 * The label is what goes above the field. The model's own `reason` is shown too, but
 * separately and length-capped — it is influenced by page content, so it is never
 * the only thing the user reads before typing a secret.
 */
const ASK_LABELS: Record<string, { label: string; hint: string }> = {
  otp: {
    label: 'One-time code',
    hint: 'Used once and wiped. Never written to disk, never sent to the model.',
  },
  captcha: {
    label: 'What the CAPTCHA says',
    hint: 'Read it from the page yourself — Yukti will not try to solve it.',
  },
  password: {
    label: 'Password',
    hint: 'Kept locally for this browser session and restricted to this site.',
  },
  security_answer: {
    label: 'Answer to the security question',
    hint: 'Kept locally for this browser session and restricted to this site.',
  },
  missing_profile_field: {
    label: 'Your answer',
    hint: 'Kept on this machine so you are not asked again.',
  },
};

/**
 * What to call the thing being asked for, in the words a person uses.
 *
 * The category alone was too coarse: almost everything the agent needs is a
 * `missing_profile_field`, so the field label read "Missing detail" whether it wanted a
 * first name or a bank account. The loop now passes the actual type, and this turns it
 * into something readable.
 */
const TYPE_LABELS: Record<string, string> = {
  given_name: 'First name',
  family_name: 'Last name',
  person_name: 'Full name',
  email: 'Email address',
  phone: 'Phone number',
  date_of_birth: 'Date of birth',
  address: 'Address',
  roll_number: 'Roll number',
  registration_number: 'Registration number',
  aadhaar: 'Aadhaar number',
  pan: 'PAN',
  passport: 'Passport number',
  voter_id: 'Voter ID',
  driving_licence: 'Driving licence number',
  vehicle_number: 'Vehicle number',
  gstin: 'GSTIN',
  bank_account: 'Bank account number',
  ifsc: 'IFSC code',
  upi_id: 'UPI ID',
  credit_card: 'Card number',
  cvv: 'CVV',
  otp: 'One-time code',
  password: 'Password',
  secret_token: 'Answer to the security question',
};

/** The model's reason is untrusted text. A sentence, not a payload. */
const MAX_REASON_LENGTH = 180;

export class Chat {
  /** The bubble currently collecting step lines, so they group under one turn. */
  private current: HTMLElement | undefined;

  constructor(private readonly host: HTMLElement) {
    this.renderEmpty();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private renderEmpty(): void {
    this.host.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'chat-empty';

    const title = document.createElement('p');
    title.className = 'chat-empty-title';
    title.textContent = 'What would you like me to do?';

    const body = document.createElement('p');
    body.textContent =
      'I read your screen here on your machine, cover up anything of yours, and only then ' +
      'ask for the next step.';

    const examples = document.createElement('ul');
    examples.className = 'chat-examples';
    for (const line of [
      'search for the IPL schedule',
      'open digilocker',
      'log in to my college portal',
    ]) {
      const item = document.createElement('li');
      item.textContent = line;
      examples.appendChild(item);
    }

    empty.append(title, body, examples);
    this.host.appendChild(empty);
  }

  private clearEmpty(): void {
    const empty = this.host.querySelector('.chat-empty');
    if (empty !== null) empty.remove();
  }

  private scroll(): void {
    this.host.scrollTop = this.host.scrollHeight;
  }

  /** Reset for a new task. */
  reset(): void {
    this.current = undefined;
    this.renderEmpty();
  }

  /** What the user asked for, on the right. */
  user(text: string): void {
    this.clearEmpty();
    this.current = undefined;

    const bubble = document.createElement('div');
    bubble.className = 'msg msg-user';
    bubble.textContent = text;
    this.host.appendChild(bubble);
    this.scroll();
  }

  /**
   * One line from the agent, on the left.
   *
   * Consecutive lines join the same bubble, so a multi-step turn reads as one
   * paragraph of activity rather than a stack of separate cards.
   */
  say(text: string, tone: Tone = 'step'): void {
    this.clearEmpty();

    if (this.current === undefined) {
      const bubble = document.createElement('div');
      bubble.className = 'msg msg-agent';
      this.host.appendChild(bubble);
      this.current = bubble;
    }

    const line = document.createElement('div');
    line.className = `line line-${tone}`;
    line.textContent = text;
    this.current.appendChild(line);
    this.scroll();
  }

  /** Break the grouping, so the next `say` starts a fresh bubble. */
  private break(): void {
    this.current = undefined;
  }

  /** A live "working" indicator, replaced as the phase changes. */
  working(text: string | undefined): void {
    const existing = this.host.querySelector('.msg-working');
    if (text === undefined) {
      existing?.remove();
      return;
    }

    this.clearEmpty();
    const bubble = existing instanceof HTMLElement ? existing : document.createElement('div');

    if (!(existing instanceof HTMLElement)) {
      bubble.className = 'msg msg-agent msg-working';
      const dots = document.createElement('span');
      dots.className = 'dots';
      dots.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 3; i++) dots.appendChild(document.createElement('i'));
      const label = document.createElement('span');
      label.className = 'working-label';
      bubble.append(dots, label);
      this.host.appendChild(bubble);
    }

    const label = bubble.querySelector('.working-label');
    if (label !== null) label.textContent = text;

    // Always last, so it sits below whatever has been said since.
    this.host.appendChild(bubble);
    this.scroll();
  }

  /**
   * Ask the user for one value, inline.
   *
   * Resolves to `undefined` if they skip it. The bubble collapses to a plain line
   * afterwards so the transcript stays readable and no field is left focusable with
   * a secret in it.
   */
  ask(options: {
    readonly category: string;
    readonly reason: string;
    readonly placeholderId: string;
    /** The kind of value, when the loop could work it out. Drives the field label. */
    readonly piiType?: string;
    /** The page's own label for the box this is going into, e.g. `First Name`. */
    readonly fieldName?: string;
    /** Host the value will be used on, so the user can see where it is going. */
    readonly site?: string;
  }): Promise<string | undefined> {
    this.clearEmpty();
    this.working(undefined);
    this.break();

    const spec = ASK_LABELS[options.category] ?? {
      label: 'Your answer',
      hint: 'Stays on this device.',
    };
    // Most specific name available: the type the loop worked out, then the page's own
    // label, then the category's generic wording.
    const labelText =
      (options.piiType === undefined ? undefined : TYPE_LABELS[options.piiType]) ??
      options.fieldName ??
      spec.label;
    const secret =
      SECRET_CATEGORIES.has(options.category) ||
      (options.piiType !== undefined && SECRET_CATEGORIES.has(options.piiType));

    const bubble = document.createElement('div');
    bubble.className = 'msg msg-agent msg-ask';

    const title = document.createElement('div');
    title.className = 'ask-title';
    // Says what is wanted and where it goes. "Could you fill this in for me?" above a box
    // labelled "Missing detail" told the user nothing about either.
    title.textContent =
      options.fieldName === undefined
        ? `I need your ${labelText.toLowerCase()} to carry on.`
        : `What should I put in “${options.fieldName}”?`;

    const label = document.createElement('label');
    label.className = 'field-label';
    label.textContent = labelText;
    const inputId = `ask-${options.placeholderId.toLowerCase()}-${String(Date.now())}`;
    label.htmlFor = inputId;

    // textContent, never innerHTML: this string comes from the model, which can be
    // influenced by text on the page.
    const reason = document.createElement('p');
    reason.className = 'ask-reason';
    reason.textContent =
      options.reason.length > MAX_REASON_LENGTH
        ? `${options.reason.slice(0, MAX_REASON_LENGTH)}…`
        : options.reason;

    const form = document.createElement('form');
    form.className = 'ask-form';

    const input = document.createElement('input');
    input.id = inputId;
    input.className = 'text-input';
    input.type = secret ? 'password' : 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'btn btn-primary';
    send.textContent = 'Continue';

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn-quiet';
    skip.textContent = 'Skip';

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      options.site === undefined ? spec.hint : `${spec.hint} Used only on ${options.site}.`;

    form.append(input, send);
    bubble.append(title, reason, label, form, hint, skip);
    this.host.appendChild(bubble);
    this.scroll();
    input.focus();

    return new Promise<string | undefined>((resolve) => {
      let settled = false;

      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;

        // Collapse to a transcript line. Clearing the field first so no secret is
        // left in the DOM even for the moment before the node is replaced.
        input.value = '';
        bubble.textContent = '';
        bubble.className = 'msg msg-agent';

        const line = document.createElement('div');
        line.className = value === undefined ? 'line line-warn' : 'line line-note';
        line.textContent =
          value === undefined
            ? 'You skipped that, so I stopped there.'
            : 'Thanks — I have that, and it stays on your machine.';
        bubble.appendChild(line);

        this.break();
        this.scroll();
        resolve(value);
      };

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (input.value === '') {
          input.focus();
          return;
        }
        finish(input.value);
      });
      skip.addEventListener('click', () => {
        finish(undefined);
      });
    });
  }

  /** Close the turn, so the summary line is not glued to the last step. */
  end(text: string, tone: Tone = 'note'): void {
    this.working(undefined);
    this.break();
    this.say(text, tone);
    this.break();
  }
}
