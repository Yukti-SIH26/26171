/**
 * The planning call.
 *
 * One request, before any page is touched: read the user's request — misspelled, run
 * together, part-way into another language, whatever it actually looks like — and come
 * back with the ultimate goal and the ordered steps that satisfy it.
 *
 * This exists because a per-turn action request is the wrong place to work out intent.
 * Asked to decide one action, a model re-reads the raw sentence every turn and drifts:
 * it treats a typo as a site name, forgets the second half of the request, or decides a
 * search page was the destination. Interpreting once and keeping the result locally is
 * what makes the rest of the run coherent.
 *
 * The request text is sanitized by the caller. Nothing from any page reaches this call,
 * because no page has been read yet.
 */

import type { ProviderSettings } from '@sih/core';
import { chat, type ChatMessage } from './client.ts';

export interface TaskPlan {
  /** The outcome in one sentence, in correct words. */
  readonly goal: string;
  /** Ordered milestones. Empty when the model gave nothing usable. */
  readonly steps: readonly string[];
  /** True when a question about the current screen answers the whole request. */
  readonly answersFromScreen: boolean;
  /** Site or portal the user named, as plain words rather than a guessed address. */
  readonly site?: string;
}

const PLANNER_SYSTEM = `You turn a browser user's request into a goal and an ordered plan.

The request was typed quickly. Expect misspellings, missing punctuation, words run
together, shorthand, and words from another language. Read through all of that to the
intent; a misspelt word is the word it was meant to be, never a new site or search term.
The request may be unclear or incomplete — infer the most reasonable reading rather than
refusing, and keep the plan to what was actually asked.

Reply with one JSON object and nothing else:
{
  "goal": "the complete outcome in one clear sentence",
  "steps": ["ordered milestone", "ordered milestone"],
  "answers_from_screen": false,
  "site": "the site or portal the user named, in plain words, or null"
}

Rules:
- Cover every part of the request, in order. Two joined instructions are two milestones.
- Use the user's own words for names, queries and values. NEVER write a placeholder or a
  description of a value: no "your account name", no "<site>", no "the relevant page".
  If you would have to invent the value, the milestone is to ask the user for it.
- Never invent a web address or hostname. Reaching a named site is always two milestones:
  search for it by name, then open the official result. Only skip the search when the
  user gave the address themselves.
- Steps are outcomes, not clicks: "reach the login page", not "click the third link".
- Set "answers_from_screen" to true only when the request is a question about what is
  already displayed and needs no navigation.
- "site" is whatever the user called the site, copied from their words, or null.
- Works for anything a browser can do: accounts, dashboards, developer consoles, forms,
  banking, shopping, downloads, reading a page. Assume nothing about the domain.
- 2 to 6 steps. No commentary outside the JSON.`;

function extractJson(raw: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw.trim());
  const text = fenced?.[1]?.trim() ?? raw.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start < 0 || end <= start ? undefined : text.slice(start, end + 1);
}

function asCleanString(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, limit);
}

/**
 * Ask for a goal and a plan.
 *
 * Returns `undefined` rather than throwing: a failed plan is a degraded run, not a
 * failed task, and the loop continues with the request itself as the goal.
 */
export async function planTask(options: {
  readonly task: string;
  readonly settings: ProviderSettings;
  readonly apiKey?: string;
  readonly signal: AbortSignal;
}): Promise<TaskPlan | undefined> {
  const messages: ChatMessage[] = [
    { role: 'system', content: PLANNER_SYSTEM },
    { role: 'user', content: `REQUEST: ${options.task}` },
  ];

  let reply: string;
  try {
    const result = await chat({
      settings: options.settings,
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      messages,
      signal: options.signal,
    });
    reply = result.text;
  } catch {
    return undefined;
  }

  const json = extractJson(reply);
  if (json === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;

  const record = parsed as Record<string, unknown>;
  const goal = asCleanString(record.goal, 300);
  if (goal === undefined) return undefined;

  const rawSteps = Array.isArray(record.steps) ? record.steps : [];
  const steps = rawSteps
    .map((item) => asCleanString(item, 180))
    .filter((item): item is string => item !== undefined)
    .slice(0, 6);

  const site = asCleanString(record.site, 120);

  return {
    goal,
    steps,
    answersFromScreen: record.answers_from_screen === true || record.answersFromScreen === true,
    ...(site === undefined || site.toLowerCase() === 'null' ? {} : { site }),
  };
}
