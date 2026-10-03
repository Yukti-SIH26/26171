/**
 * Route memory: what the agent keeps about how a site works, and what it refuses to keep.
 *
 * The privacy assertions here matter more than the convenience ones. A route is replayed
 * into an outbound prompt, so anything stored in one is effectively something the agent
 * has decided it is willing to transmit — which is why what goes in is labels and roles
 * and nothing else.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  describeRoute,
  forgetRoutes,
  recallRoute,
  rememberRoute,
  type RouteStep,
} from '../src/agent/routes.ts';

const PORTAL = 'https://portal.example.edu';
const OTHER = 'https://bank.example.com';

/**
 * Stand-in for `storage.local`, installed on `globalThis` because the module resolves the
 * area at call time — which is what makes it importable outside an extension at all.
 */
function installFakeStorage(): { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: (key: string): Promise<Record<string, unknown>> =>
          Promise.resolve(key in data ? { [key]: data[key] } : {}),
        set: (items: Record<string, unknown>): Promise<void> => {
          Object.assign(data, items);
          return Promise.resolve();
        },
      },
    },
  };
  return { data };
}

const LOGIN_ROUTE: readonly RouteStep[] = [
  { action: 'open the site' },
  { action: 'click', role: 'link', label: 'Student Login' },
  { action: 'type', role: 'textbox', label: 'Roll Number' },
  { action: 'click', role: 'button', label: 'Sign In' },
  { action: 'click', role: 'link', label: 'Admit Card' },
];

let store: { data: Record<string, unknown> };

beforeEach(async () => {
  store = installFakeStorage();
  await forgetRoutes();
});

describe('remembering a route', () => {
  it('recalls what it stored for the same site and a similar goal', async () => {
    await rememberRoute({
      origin: PORTAL,
      goal: 'download the admit card from the college portal',
      steps: LOGIN_ROUTE,
    });

    const found = await recallRoute(PORTAL, 'downlaod my admit card');
    expect(found).toBeDefined();
    expect(found?.steps).toHaveLength(5);
    expect(found?.steps[1]?.label).toBe('Student Login');
  });

  /**
   * A confident wrong suggestion is worse than silence: it sends the agent down a menu
   * tree that has nothing to do with what was asked.
   */
  it('does not offer a route for a different job on the same site', async () => {
    await rememberRoute({ origin: PORTAL, goal: 'pay the hostel fees', steps: LOGIN_ROUTE });
    expect(await recallRoute(PORTAL, 'check my attendance percentage')).toBeUndefined();
  });

  it('does not offer one site’s route on another site', async () => {
    await rememberRoute({
      origin: PORTAL,
      goal: 'download the admit card',
      steps: LOGIN_ROUTE,
    });
    expect(await recallRoute(OTHER, 'download the admit card')).toBeUndefined();
  });

  it('replaces the earlier route for the same goal instead of collecting variants', async () => {
    await rememberRoute({
      origin: PORTAL,
      goal: 'download the admit card',
      steps: LOGIN_ROUTE,
    });
    await rememberRoute({
      origin: PORTAL,
      goal: 'download the admit card',
      steps: [{ action: 'click', role: 'button', label: 'Hall Ticket' }],
    });

    const found = await recallRoute(PORTAL, 'download the admit card');
    expect(found?.steps).toHaveLength(1);
    expect(found?.steps[0]?.label).toBe('Hall Ticket');

    const stored = store.data['yukti.routes.v1'] as { routes: unknown[] };
    expect(stored.routes).toHaveLength(1);
  });

  it('keeps routes for two different goals on one site', async () => {
    await rememberRoute({
      origin: PORTAL,
      goal: 'download the admit card',
      steps: LOGIN_ROUTE,
    });
    await rememberRoute({
      origin: PORTAL,
      goal: 'check my attendance percentage',
      steps: [{ action: 'click', role: 'link', label: 'Attendance' }],
    });

    expect((await recallRoute(PORTAL, 'download admit card'))?.steps).toHaveLength(5);
    expect((await recallRoute(PORTAL, 'check attendance percentage'))?.steps[0]?.label).toBe(
      'Attendance',
    );
  });

  it('stores nothing for an empty route', async () => {
    await rememberRoute({ origin: PORTAL, goal: 'do nothing', steps: [] });
    expect(await recallRoute(PORTAL, 'do nothing')).toBeUndefined();
  });

  it('caps a very long route', async () => {
    const long = Array.from({ length: 80 }, (_, i) => ({
      action: 'click',
      label: `step ${String(i)}`,
    }));
    await rememberRoute({ origin: PORTAL, goal: 'a very long errand', steps: long });
    const found = await recallRoute(PORTAL, 'a very long errand');
    expect(found?.steps.length).toBeLessThanOrEqual(24);
  });

  it('survives having no storage at all', async () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    await expect(
      rememberRoute({ origin: PORTAL, goal: 'x', steps: LOGIN_ROUTE }),
    ).resolves.toBeUndefined();
    await expect(recallRoute(PORTAL, 'x')).resolves.toBeUndefined();
  });

  it('ignores a malformed stored entry rather than throwing', async () => {
    store.data['yukti.routes.v1'] = { routes: [{ nonsense: true }, null, 7] };
    await expect(recallRoute(PORTAL, 'anything')).resolves.toBeUndefined();
  });

  it('forgets everything on request', async () => {
    await rememberRoute({
      origin: PORTAL,
      goal: 'download the admit card',
      steps: LOGIN_ROUTE,
    });
    await forgetRoutes();
    expect(await recallRoute(PORTAL, 'download the admit card')).toBeUndefined();
  });
});

describe('what a stored route contains', () => {
  /**
   * Element ids are minted per observation, so a stored one is meaningless by construction
   * — and following one would aim at whatever happens to hold that id next time.
   */
  it('holds no element ids', async () => {
    await rememberRoute({
      origin: PORTAL,
      goal: 'download the admit card',
      steps: LOGIN_ROUTE,
    });
    const serialized = JSON.stringify(store.data);
    expect(serialized).not.toMatch(/\bel_\d+\b/);
    expect(serialized).not.toMatch(/\bpx_\d+\b/);
  });

  /** The origin, never the path: a portal path routinely carries a roll number. */
  it('holds no path or query from the site', async () => {
    await rememberRoute({
      origin: PORTAL,
      goal: 'download the admit card',
      steps: LOGIN_ROUTE,
    });
    const serialized = JSON.stringify(store.data);
    expect(serialized).toContain(PORTAL);
    expect(serialized).not.toContain('/student/21CS042');
    expect(serialized).not.toContain('sessionid');
  });

  /**
   * A `type` step records that a field was filled, never with what. The caller never passes
   * a value in, and there is nowhere for one to go if it tried.
   */
  it('records that a field was filled without recording the value', async () => {
    await rememberRoute({
      origin: PORTAL,
      goal: 'log in',
      steps: [{ action: 'type', role: 'textbox', label: 'Roll Number' }],
    });
    const serialized = JSON.stringify(store.data);
    expect(serialized).toContain('Roll Number');
    expect(serialized).not.toContain('21CS042');
  });
});

describe('describing a route to the model', () => {
  it('frames it as history and warns that the page may have moved', () => {
    const lines = describeRoute({
      origin: PORTAL,
      goal: 'download the admit card',
      steps: LOGIN_ROUTE,
      savedAt: 0,
    });
    const text = lines.join('\n');
    expect(text).toMatch(/LAST TIME ON THIS SITE/);
    expect(text).toMatch(/may have\s+changed/);
    expect(text).toMatch(/1\. open the site/);
    expect(text).toMatch(/2\. click "Student Login"/);
  });

  it('falls back to the role when a control had no label', () => {
    const lines = describeRoute({
      origin: PORTAL,
      goal: 'x',
      steps: [{ action: 'click', role: 'button' }],
      savedAt: 0,
    });
    expect(lines.join('\n')).toMatch(/click the button/);
  });
});
