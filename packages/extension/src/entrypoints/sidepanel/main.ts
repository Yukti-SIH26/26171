import { browser } from 'wxt/browser';
import {
  checkSettings,
  type ElementGraph,
  type ElementNode,
  type PlatformAdapters,
  type ProviderSettings,
} from '@sih/core';
import { initPlatform } from '../../platform/index.ts';
import {
  ContentScriptUnreachableError,
  observeWithMetrics,
  setOverlay,
} from '../../platform/observe-via-content.ts';
import type { ObserveMetrics } from '../../messaging/protocol.ts';
import * as vault from '../../vault/index.ts';
import { loadSettings } from '../../llm/index.ts';
import { runLoop, type LoopPhase } from '../../agent/index.ts';
import { AuditTab } from './audit-tab.ts';
import { Chat, type Tone } from './chat.ts';
import { DetectorCard } from './detector-card.ts';
import { ProfileTab } from './profile-tab.ts';
import { Prompter } from './prompt.ts';
import { SystemSheet } from './system-sheet.ts';
import './style.css';

/**
 * Side panel: the operator surface.
 *
 * Three tabs, because a person has three questions: tell it what to do, check what
 * it sent, and see what it remembers. Everything else — capability probes, model
 * loading, element dumps, provider configuration — is settings or diagnostics and
 * lives behind the ⋯ button, where it cannot compete with the task.
 *
 * The chat is the primary surface and everything the agent says goes through it.
 * There is no separate log: two places to look meant neither was complete.
 */

type State = 'ok' | 'warn' | 'bad';

let platform: PlatformAdapters | undefined;
let lastGraph: ElementGraph | undefined;
let overlayVisible = false;
let chat: Chat | undefined;
let auditTab: AuditTab | undefined;
let detectorCard: DetectorCard | undefined;
let profileTab: ProfileTab | undefined;
let systemSheet: SystemSheet | undefined;
let prompter: Prompter | undefined;

/** Provider configuration, kept current by the settings sheet. */
let settings: ProviderSettings | undefined;

/** Non-null only while a task is running; aborting it is how Stop works. */
let running: AbortController | undefined;

/** Bytes actually transmitted this session. */
let sentBytes = 0;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node as T;
}

function row(term: string, value: string, state?: State, note?: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  dd.textContent = value;
  if (state !== undefined) dd.classList.add(`state-${state}`);
  if (note !== undefined) {
    const small = document.createElement('small');
    small.className = 'note';
    small.textContent = note;
    dd.appendChild(small);
  }
  frag.append(dt, dd);
  return frag;
}

/** Map the old three-state vocabulary onto the chat's tones. */
const TONE_FOR: Record<State, Tone> = { ok: 'note', warn: 'warn', bad: 'bad' };

/**
 * Everything anybody wants to tell the user goes here.
 *
 * Passed to every tab so a message raised from the settings sheet or the vault ends
 * up in the same transcript as the agent's own lines, in the order it happened.
 */
function say(message: string, state?: State): void {
  chat?.say(message, state === undefined ? 'step' : TONE_FOR[state]);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TABS = ['agent', 'audit', 'vault'] as const;

function selectTab(name: (typeof TABS)[number]): void {
  for (const tab of TABS) {
    const button = el<HTMLButtonElement>(`tab-${tab}`);
    const panel = el<HTMLElement>(`panel-${tab}`);
    const selected = tab === name;
    button.setAttribute('aria-selected', String(selected));
    panel.hidden = !selected;
  }
}

function wireTabs(): void {
  for (const tab of TABS) {
    el<HTMLButtonElement>(`tab-${tab}`).addEventListener('click', () => {
      selectTab(tab);
    });
  }
}

// ---------------------------------------------------------------------------
// Page reading — a diagnostic, inside the settings sheet
// ---------------------------------------------------------------------------

/**
 * The tab the user is looking at. Only ever that tab.
 *
 * There was briefly a fallback here: when the active tab was not an http(s) page — a
 * new tab, a browser settings page — this picked the most recently used real page
 * instead, on the theory that the user probably meant that one. It was a bad theory and
 * a genuinely harmful bug. On a new tab the agent silently adopted some older
 * background tab and typed, pressed Enter and clicked in it, invisibly, while the
 * window the user was watching never changed. It looked like the agent was reading
 * stale pages and ignoring the current one, because it was.
 *
 * A new tab is not a dead end either: it has a tab id, so `goto_url` navigates it like
 * any other. Reading it simply fails, the model is told the tab has nothing on it, and
 * it opens something there — which is exactly the desired behaviour, in the tab the
 * user can see.
 */
async function activeTabId(): Promise<number> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  if (tab?.id === undefined) throw new Error('no active tab');
  return tab.id;
}

function renderMetrics(metrics: ObserveMetrics, graph: ElementGraph): void {
  const target = el<HTMLDListElement>('observe-metrics');
  target.textContent = '';

  target.append(row('Page', graph.title === '' ? '(untitled)' : graph.title));
  target.append(
    row(
      'Read time',
      `${metrics.durationMs.toFixed(1)} ms`,
      metrics.durationMs < 250 ? 'ok' : 'warn',
      `walked ${String(metrics.elementsVisited)} elements`,
    ),
  );
  target.append(row('Elements kept', String(metrics.nodesEmitted)));
  target.append(row('Clickable', String(metrics.interactiveCount), 'ok'));
  target.append(row('Text entry', String(metrics.editableCount), 'ok'));
  target.append(
    row(
      'Password fields',
      String(metrics.passwordFieldCount),
      metrics.passwordFieldCount > 0 ? 'bad' : 'ok',
      metrics.passwordFieldCount > 0
        ? 'values were never read into memory'
        : 'none found on this page',
    ),
  );
  target.append(
    row(
      'Hidden',
      String(metrics.hiddenCount),
      undefined,
      'still scanned for sensitive data, never used as action targets',
    ),
  );
  target.append(row('Stable ids', String(metrics.registrySize)));
}

function pillsFor(node: ElementNode): DocumentFragment {
  const frag = document.createDocumentFragment();
  const add = (text: string, cls: string): void => {
    const span = document.createElement('span');
    span.className = `pill ${cls}`;
    span.textContent = text;
    frag.appendChild(span);
  };
  if (node.inputType === 'password') add('password', 'pill-pw');
  else if (node.flags.editable) add('input', 'pill-edit');
  else if (node.flags.interactive) add('click', 'pill-int');
  if (node.flags.hidden) add('hidden', 'pill-hidden');
  if (node.flags.disabled) add('disabled', 'pill-hidden');
  return frag;
}

function renderElements(graph: ElementGraph, filter: string): void {
  const list = el<HTMLDivElement>('element-list');
  list.textContent = '';

  const needle = filter.trim().toLowerCase();
  const shown = graph.nodes.filter((node) => {
    if (!node.flags.interactive && node.role !== 'heading') return false;
    if (needle === '') return true;
    return (
      node.name.toLowerCase().includes(needle) ||
      node.role.toLowerCase().includes(needle) ||
      node.id.toLowerCase().includes(needle)
    );
  });

  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      needle === ''
        ? 'Nothing interactive found on this page.'
        : 'No elements match that filter.';
    list.appendChild(empty);
    return;
  }

  for (const node of shown.slice(0, 300)) {
    const rowEl = document.createElement('div');
    rowEl.className = 'el-row';

    const idCell = document.createElement('div');
    idCell.className = 'el-id';
    idCell.textContent = node.id;

    const body = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'el-name';
    name.textContent = node.name === '' ? '(no accessible name)' : node.name;
    if (node.name === '') name.classList.add('state-warn');

    const meta = document.createElement('div');
    meta.className = 'el-meta';
    meta.append(pillsFor(node));
    const desc = `${node.role}${node.tag === undefined ? '' : ` · <${node.tag}>`} · ${String(
      Math.round(node.rect.width),
    )}×${String(Math.round(node.rect.height))}`;
    meta.append(document.createTextNode(desc));

    body.append(name, meta);
    rowEl.append(idCell, body);
    list.appendChild(rowEl);
  }
}

async function readPage(): Promise<void> {
  const button = el<HTMLButtonElement>('observe');
  button.disabled = true;
  try {
    const tabId = await activeTabId();
    const { graph, metrics } = await observeWithMetrics(tabId, { drawOverlay: overlayVisible });
    lastGraph = graph;
    renderMetrics(metrics, graph);
    renderElements(graph, el<HTMLInputElement>('element-filter').value);
    el<HTMLDivElement>('legend').hidden = !overlayVisible;
  } catch (error) {
    const message =
      error instanceof ContentScriptUnreachableError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'unknown error';
    const target = el<HTMLDListElement>('observe-metrics');
    target.textContent = '';
    target.append(row('Error', message, 'bad'));
  } finally {
    button.disabled = false;
  }
}

async function toggleOverlay(): Promise<void> {
  const button = el<HTMLButtonElement>('toggle-overlay');
  button.disabled = true;
  try {
    const tabId = await activeTabId();
    await setOverlay(tabId, !overlayVisible);
    overlayVisible = !overlayVisible;
    button.textContent = overlayVisible ? 'Hide boxes' : 'Show boxes';
    el<HTMLDivElement>('legend').hidden = !overlayVisible;
  } catch (error) {
    say(`Overlay failed: ${error instanceof Error ? error.message : 'unknown'}`, 'bad');
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// The agent
// ---------------------------------------------------------------------------

/** Reflect run state in the composer, so Stop only exists while there is something to stop. */
function setRunning(active: boolean): void {
  el<HTMLButtonElement>('run-task').hidden = active;
  el<HTMLButtonElement>('stop-task').hidden = !active;
  el<HTMLTextAreaElement>('task-input').readOnly = active;
}

/** What the working indicator says during each phase. */
function phaseLabel(phase: LoopPhase): string | undefined {
  switch (phase) {
    case 'looking':
      return 'Reading the page';
    case 'hiding':
      return 'Covering up your data';
    case 'thinking':
      return 'Thinking';
    case 'acting':
      return 'Working';
    default:
      // idle, asking, done, stopped, failed: nothing is in flight, so no indicator.
      return undefined;
  }
}

function wireComposer(): void {
  const input = el<HTMLTextAreaElement>('task-input');

  el<HTMLButtonElement>('run-task').addEventListener('click', () => {
    void startTask();
  });

  el<HTMLButtonElement>('stop-task').addEventListener('click', () => {
    running?.abort();
  });

  // Enter sends, Shift+Enter makes a new line. Standard for a chat box, and the
  // alternative — having to reach for a button every time — gets old immediately.
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (running === undefined) void startTask();
  });

  // Grow with the content up to the CSS max, then scroll.
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${String(input.scrollHeight)}px`;
  });
}

async function startTask(): Promise<void> {
  const input = el<HTMLTextAreaElement>('task-input');
  const task = input.value.trim();

  if (task === '') return;
  if (running !== undefined) return;

  const active = platform;
  if (active === undefined) {
    say('This computer was not set up correctly — open ⋯ for details.', 'bad');
    return;
  }

  const current = settings ?? (await loadSettings());
  settings = current;

  const check = checkSettings(current);
  if (!check.ok) {
    say(`Set the model up first, under ⋯. ${check.messages.join(' ')}`, 'warn');
    return;
  }

  let tabId: number;
  try {
    tabId = await activeTabId();
  } catch {
    say('Could not find a tab to work in.', 'bad');
    return;
  }

  const controller = new AbortController();
  running = controller;
  setRunning(true);

  input.value = '';
  input.style.height = 'auto';

  chat?.reset();
  chat?.user(task);
  auditTab?.reset();

  try {
    const result = await runLoop({
      task,
      tabId,
      platform: active,
      settings: current,
      signal: controller.signal,
      callbacks: {
        onPhase: (phase) => {
          chat?.working(phaseLabel(phase));
        },
        onSay: (line, tone) => {
          chat?.say(line, tone ?? 'step');
        },
        onAudit: (snapshot) => {
          auditTab?.addSnapshot(snapshot);
        },
        // Inline in the chat, not a modal. The question belongs in the conversation
        // that gives it its context.
        requestInput: async (category, reason, placeholderId, details) =>
          (await chat?.ask({
            category,
            reason,
            placeholderId,
            ...(details?.piiType === undefined ? {} : { piiType: details.piiType }),
            ...(details?.fieldName === undefined ? {} : { fieldName: details.fieldName }),
            ...(details?.site === undefined ? {} : { site: details.site }),
          })) ?? undefined,
        requestPassphrase: async () =>
          (await prompter?.passphrase('This value is protected.')) ?? undefined,
      },
    });

    sentBytes += result.bytesSent;
    chat?.working(undefined);

    if (!result.finished && !result.reasonAlreadyLogged) {
      chat?.end(result.reason, 'warn');
    }

    // Refresh local metadata in case Profile changed while the task was running.
    void profileTab?.reload();
  } catch (error) {
    chat?.working(undefined);
    say(error instanceof Error ? error.message : 'Something went wrong.', 'bad');
  } finally {
    running = undefined;
    setRunning(false);
  }
}

function vaultCount(): number {
  return vault.asRedactionDictionary().length;
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  wireTabs();
  wireComposer();

  chat = new Chat(el<HTMLDivElement>('chat'));
  prompter = Prompter.fromDom(el);

  el<HTMLButtonElement>('observe').addEventListener('click', () => {
    void readPage();
  });
  el<HTMLButtonElement>('toggle-overlay').addEventListener('click', () => {
    void toggleOverlay();
  });
  el<HTMLInputElement>('element-filter').addEventListener('input', () => {
    if (lastGraph !== undefined) {
      renderElements(lastGraph, el<HTMLInputElement>('element-filter').value);
    }
  });

  // Open the vault before anything else reads from it. No passphrase: the key is
  // generated and kept by the extension, so the vault is usable the moment the
  // panel opens. A vault that demands setup stays empty, and an empty vault means
  // the redactor cannot recognise the user's own name — friction here costs privacy
  // elsewhere.
  const opened = await vault.openAutomatically();
  if (!opened) {
    say('Your saved values are behind a passphrase. Open Profile to unlock them.', 'warn');
  }

  // Wired before the capability probe on purpose: the vault needs no platform at
  // all, so a machine where WebGPU detection fails can still manage its own data.
  profileTab = new ProfileTab({
    el,
    say,
    prompter,
    onVaultChanged: () => undefined,
  });
  await profileTab.init();

  systemSheet = new SystemSheet({
    el,
    row,
    say,
    platform: () => platform,
    sentBytes: () => sentBytes,
    vaultCount,
    onSettingsChanged: (updated) => {
      settings = updated;
    },
  });
  await systemSheet.init();
  settings = systemSheet.currentSettings();

  try {
    platform = await initPlatform();

    // The model host must be prepared before any weights load: it is what points
    // the inference runtime at the bundled files rather than the network.
    await platform.modelHost.ensureReady();

    detectorCard = new DetectorCard({ el, row, say });
    detectorCard.init(platform.capabilities);

    auditTab = new AuditTab({
      el,
      say,
      activeTabId,
      platform: () => platform,
      // A getter, not a captured value: unlocking the vault mid-session must
      // immediately improve detection without the tab being rebuilt.
      vault: () => vault.asRedactionDictionary(),
    });
    auditTab.init(platform.capabilities);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'setup failed';
    say(
      `Could not check this computer: ${message}. Reading pages and the vision model will ` +
        'not work. Open ⋯ for details.',
      'bad',
    );
  }
}

void main();
