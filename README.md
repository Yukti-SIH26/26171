# Yukti — Privacy-Preserving On-Device Vision Browser Agent

**SIH26171** · Indian Space Research Organisation (ISRO) / Space Applications Centre · Theme: Smart Automation

A Chrome and Firefox extension that reads the page locally with vision models running on
your own GPU, redacts sensitive data before anything leaves the browser, sends only
sanitized context to a cloud-hosted open-weight VLM, and executes the returned actions
locally behind safety validation.

Your passwords, Aadhaar, and PAN never leave your machine. The server reasons over
placeholders like `AADHAAR_1` and never learns the value behind them.

---

## Why this architecture

The problem statement weights its five criteria as follows:

| Criterion                              | Weight | Where it lives |
| -------------------------------------- | -----: | -------------- |
| Accuracy of visual context from screen |    25% | client         |
| PII detection precision and recall     |    20% | client         |
| Precision of redaction                 |    20% | client         |
| Client-side resource utilization       |    20% | client         |
| End-to-end latency                     |    15% | both           |

Four of five are client-side, and 65% is perception plus privacy quality. Nothing scores
task breadth or the number of supported sites. So this is built narrow and deep, with the
server kept deliberately thin.

Three of those criteria are measured numbers, which makes labelled ground-truth pages a
hard dependency: you cannot compute recall on a page you do not control.

### Two perception channels, not a primary and a fallback

| Channel       | Source                                   | Strength                                          | Blind spot                       |
| ------------- | ---------------------------------------- | ------------------------------------------------- | -------------------------------- |
| **Structure** | DOM walk, ARIA roles, accessible names   | Exact where markup is good; it reads, not guesses | Canvas, div soup, text in images |
| **Pixel**     | Vision models over a screenshot (WebGPU) | Markup-independent; sees what your eyes see       | No semantics, detector-limited   |

They run as peers and are fused by spatial overlap. The pixel channel is what lets the
agent work on badly built pages, which is most of the web.

### Four PII detectors, all always running

1. **Known-value** — matches the user's own vault entries. Exact string comparison, so
   site-agnostic and near-certain.
2. **Structural** — `input[type=password]`, `autocomplete=cc-number`, ARIA labels. Web
   standard, so not per-site rules.
3. **Pattern + checksum** — Aadhaar Verhoeff, PAN, IFSC, card Luhn. The checksum is what
   kills false positives on random 12-digit order numbers.
4. **Semantic** — in-browser NER reading context. Catches formats nobody wrote a rule for.
   This is the layer that generalizes to sites we have never seen.

Confidences are fused by maximum, then compared against a per-type threshold. The
thresholds run in opposite directions on purpose: `0.2` for a password (act on almost any
hint, because a leak is unrecoverable) versus `0.75` for a person's name (demand real
evidence, because blacking out every capitalised word destroys the page for the model).
That tension is exactly why redaction precision is scored separately from detection recall.

### Redaction is per-type, never one-size-fits-all

| Data               | Method                     | Why                                               |
| ------------------ | -------------------------- | ------------------------------------------------- |
| Password, OTP, CVV | Solid black                | Blur is partially reversible on structured text   |
| Aadhaar, PAN, card | Placeholder token          | Model still knows the field's purpose             |
| Name, address      | Synthetic same-shape value | Form logic still works                            |
| Face               | Blur                       | Goal is unrecognisability, not cryptographic loss |

`resolveRedactionMode()` refuses to blur anything flagged `neverBlur`, so a future change
cannot quietly weaken a password field.

---

## Stack

| Layer               | Choice                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| Extension framework | WXT 0.21 (one codebase, Chrome MV3 + Firefox MV3)                       |
| Language            | TypeScript 5.9, strict, `exactOptionalPropertyTypes`                    |
| Local inference     | ONNX Runtime Web + Transformers.js, WebGPU with WASM fallback           |
| Local vision        | OWLv2 (zero-shot detection), Florence-2-base (OCR/grounding), BlazeFace |
| Vault               | WebCrypto AES-GCM, PBKDF2, key in memory only                           |
| Server              | FastAPI + OpenRouter                                                    |
| Remote planner      | `qwen/qwen3-vl-8b-instruct` (strict JSON action schema)                 |
| Remote grounder     | `bytedance/ui-tars-1.5-7b` (coordinates for no-semantics layouts)       |
| Tests               | Vitest, Playwright for the eval harness                                 |

Both remote models are Apache-2.0 and self-hostable. The provider adapter refuses at
runtime to call any model whose OpenRouter entry has no `hugging_face_id`, which turns the
PS's open-weights requirement into a code-level gate rather than a promise.

### Cross-browser is a real constraint, not a flag

Firefox lacks four things Chrome extensions routinely assume, and all four shaped the design:

| Capability                    | Chrome               | Firefox                       |
| ----------------------------- | -------------------- | ----------------------------- |
| CDP / `chrome.debugger`       | yes → trusted events | **absent** → synthetic events |
| `Accessibility.getFullAXTree` | yes                  | **absent** → DOM walk only    |
| `chrome.offscreen`            | yes                  | **absent** → hidden page      |
| Persistent background         | service worker       | non-persistent event page     |

So the portable content-script path is primary and CDP is a Chrome-only accelerator that
is never load-bearing. Synthetic events carry `isTrusted: false`, and hardened sites may
legitimately ignore them; that difference gets measured and reported, not hidden.

---

## Getting started

Requires Node 22.6+ (Node 24 recommended).

```bash
npm install

npm run dev            # Chrome, live reload
npm run dev:firefox    # Firefox, live reload

npm run verify         # typecheck + lint + test + build both browsers
```

Built output lands in `packages/extension/.output/chrome-mv3` and `.../firefox-mv3`. Load
it unpacked via `chrome://extensions` or `about:debugging`.

### Layout

```
packages/
  core/        shared contracts: element graph, PII taxonomy + policy, action schema, PAL
  extension/   Chrome + Firefox extension
  server/      FastAPI reasoning server            (task 10)
  eval/        Playwright metrics harness          (task 4)
  testbench/   labelled replica pages              (task 3)
```

`@sih/core` is dependency-free and side-effect-free, so it imports cleanly into a content
script, a service worker, an offscreen document, or a Node test.

---

## Progress

- [x] **1** Monorepo, cross-browser skeleton, capability probe, CI
- [ ] **2** Structure channel: DOM/ARIA extractor and Element Graph
- [ ] **3** Testbench with ground-truth PII labels
- [ ] **4** PII detectors 2+3 and the metrics harness
- [ ] **5** Profile Vault and known-value matching
- [ ] **6** Pixel channel: WebGPU vision models and channel fusion
- [ ] **7** Semantic NER detector
- [ ] **8** Redaction engine and budget guard
- [ ] **9** Privacy firewall and leak-canary suite
- [ ] **10** Server, OpenRouter adapter, open-weights gate, planner
- [ ] **11** Action validator and executor
- [ ] **12** Agent loop, local-first escalation gate, perception cache
- [ ] **13** Ask-don't-stop channel and secret substitution policy
- [ ] **14** Auto-labelling harness for self-generated training data
- [ ] **15** Grounder stage for legacy layouts
- [ ] **16** Metrics dashboard and prompt-injection defense
- [ ] **17** College portal hardening, docs, packaging
- [ ] **18** Fine-tuned UI element detector

---

## Testing targets

The real target is the user's own college portal, logging in as themselves to retrieve
their own marksheet or attendance. Banking was considered and dropped: banks actively
block automation, and the failure mode is a locked account rather than a failed test. A
college ERP is also a better test subject, since a student dashboard typically exposes more
distinct PII types on one screen than a bank does.

CAPTCHAs are never auto-solved. The agent stops and asks the user, which is the
ask-don't-stop channel doing its job.

Controlled replica pages are not a substitute for real sites; they are the measuring
instrument. Three of the five scoring criteria need per-region ground truth, which only
exists on pages we author.

---

## Known issues

**Dev-only dependency advisories.** `npm audit` reports advisories in the `web-ext`
toolchain (`addons-linter`, `fx-runner`, `shell-quote`, `adm-zip`, `tmp`). These are
development tools for launching and packaging the Firefox build. They are not bundled into
the extension. `npm audit --omit=dev` reports zero vulnerabilities, and CI enforces that.
`npm audit fix --force` would break `web-ext`, so they are tracked rather than forced.

**Firefox for Android is not a target.** WebGPU support there is patchy and memory limits
are much tighter. A version floor is declared only because Android 142 is where the
`data_collection_permissions` manifest key landed.

---

## Data collection

The Firefox manifest declares `data_collection_permissions.required: ["websiteContent"]`,
because redacted page structure and a redacted screenshot are sent to the reasoning server
when the user gives the agent a task.

Deliberately **not** declared, each enforced in code rather than merely promised:

- `personallyIdentifyingInfo` — detected and redacted before egress
- `authenticationInfo` — vault-only, never transmitted
- `financialAndPaymentInfo` — redacted before egress
- `browsingActivity` — nothing is read unless a task is given

## License

Apache-2.0. Local and remote models retain their own licenses; all selected models are
Apache-2.0 or MIT.
