/**
 * Remembering the way through a site.
 *
 * The agent solved "download my admit card" on a college portal once, in eleven steps,
 * most of which were spent working out that the link lives behind a menu called
 * "Examination" and then behind a tab called "Hall Ticket". Next session it started from
 * nothing and paid for that discovery again.
 *
 * So a completed run leaves behind the route it took, and the next run on the same site
 * is shown it as a hint. Not as a script: the page may have changed, the labels may have
 * moved, and a stale route followed blindly is worse than no route. It is advice in the
 * prompt, and the model is told to verify each step against what it can actually see.
 *
 * What is stored, and why it is only this:
 *
 *   - The origin. No path, no query. Both routinely carry a session id or a roll number,
 *     and neither is needed to recognise "this is the same site as last time".
 *   - Each step's action, the target's role, and the target's *label* — the page's own
 *     word for the control, which is what survives a re-render. Never an element id:
 *     ids are minted per observation and a stored one is meaningless by definition.
 *   - Nothing the user typed. A `type` step records that a field called "Roll Number"
 *     was filled, never with what.
 *
 * Labels are page content, so they are sanitized by the caller before they arrive here.
 * A button reading "Marksheet for 21CS042" is stored with the number already replaced,
 * which is what makes replaying a route into an outbound prompt safe.
 */

const STORAGE_KEY = 'yukti.routes.v1';

/**
 * Most routes kept. Beyond this the oldest go.
 *
 * Small on purpose. This is a convenience cache, and an unbounded local history of every
 * site the user has ever automated is a liability that grows on its own.
 */
const MAX_ROUTES = 40;

/** Longest route worth keeping. A run that took more turns than this was flailing. */
const MAX_STEPS = 24;

export interface RouteStep {
  readonly action: string;
  /** ARIA role of the target, when there was one. */
  readonly role?: string;
  /** The page's own label for the target, already sanitized. */
  readonly label?: string;
}

export interface Route {
  readonly origin: string;
  /** The interpreted goal, in the user's own words, sanitized. */
  readonly goal: string;
  readonly steps: readonly RouteStep[];
  readonly savedAt: number;
}

interface StoredRoutes {
  readonly routes: readonly Route[];
}

type LocalArea = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
};

/**
 * Resolve the storage area at call time, from whichever global the browser provides.
 *
 * The same shape the vault uses, and for the same reason: reading it lazily is what keeps
 * this module importable outside an extension context. It returns `undefined` rather than
 * throwing, because unlike the vault nothing here is load-bearing — a route that cannot be
 * saved costs the next run some exploring.
 */
function area(): LocalArea | undefined {
  const globals = globalThis as {
    chrome?: { storage?: { local?: LocalArea } };
    browser?: { storage?: { local?: LocalArea } };
  };
  return globals.chrome?.storage?.local ?? globals.browser?.storage?.local;
}

function isRoute(value: unknown): value is Route {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Route>;
  return (
    typeof candidate.origin === 'string' &&
    typeof candidate.goal === 'string' &&
    typeof candidate.savedAt === 'number' &&
    Array.isArray(candidate.steps)
  );
}

async function readAll(): Promise<Route[]> {
  const store = area();
  if (store === undefined) return [];
  try {
    const raw = await store.get(STORAGE_KEY);
    const parsed = raw[STORAGE_KEY] as StoredRoutes | undefined;
    const routes = parsed?.routes;
    return Array.isArray(routes) ? routes.filter(isRoute) : [];
  } catch {
    return [];
  }
}

/**
 * Overlap between two goal descriptions, as a share of the shorter one.
 *
 * Word-set overlap rather than a string distance, because the two sentences being
 * compared are a user's typed request and an earlier interpreted goal — they agree on
 * content words and disagree on everything else. "downlaod my admit card" against
 * "Download the user's admit card from the college portal" shares `download`, `admit`,
 * `card`, which is the whole signal.
 */
function goalOverlap(a: string, b: string): number {
  const words = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2),
    );

  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.min(left.size, right.size);
}

/** Below this the remembered route is about a different job on the same site. */
const MIN_GOAL_OVERLAP = 0.5;

/**
 * The route this site last took for something like this goal.
 *
 * Matched on origin first and goal second. Origin alone would offer the route to "pay my
 * fees" when the user asked to check their attendance, which is worse than silence: a
 * confident wrong suggestion is exactly the thing that sends an agent off down a menu
 * tree that has nothing to do with the request.
 */
export async function recallRoute(origin: string, goal: string): Promise<Route | undefined> {
  const routes = await readAll();
  let best: Route | undefined;
  let bestScore = MIN_GOAL_OVERLAP;

  for (const route of routes) {
    if (route.origin !== origin) continue;
    const score = goalOverlap(goal, route.goal);
    if (score >= bestScore) {
      best = route;
      bestScore = score;
    }
  }

  return best;
}

/**
 * Store the route a completed run took.
 *
 * Replaces any earlier route for the same origin and a closely matching goal rather than
 * accumulating variants: the newest working route is the one that reflects the site as it
 * is now, and keeping three near-identical ones only makes the recall ambiguous.
 */
export async function rememberRoute(route: Omit<Route, 'savedAt'>): Promise<void> {
  const store = area();
  if (store === undefined) return;
  if (route.steps.length === 0) return;

  const existing = await readAll();
  const kept = existing.filter(
    (candidate) =>
      candidate.origin !== route.origin ||
      goalOverlap(candidate.goal, route.goal) < MIN_GOAL_OVERLAP,
  );

  const entry: Route = {
    origin: route.origin,
    goal: route.goal,
    steps: route.steps.slice(0, MAX_STEPS),
    savedAt: Date.now(),
  };

  const next = [entry, ...kept].sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_ROUTES);

  try {
    await store.set({ [STORAGE_KEY]: { routes: next } satisfies StoredRoutes });
  } catch {
    // Storage full or unavailable. A lost convenience, not a failure worth reporting.
  }
}

/**
 * Render a route as one prompt line per step.
 *
 * Phrased as history rather than instruction — "last time, this worked" — because the
 * page may have changed. A route written as a list of commands gets followed even when
 * the first label is nowhere on screen, and then every later step is aimed at a page the
 * agent never reached.
 */
export function describeRoute(route: Route): string[] {
  const out = [
    `LAST TIME ON THIS SITE, this sequence completed "${route.goal}". The page may have ` +
      'changed since, so check each step against what you can actually see and skip or ' +
      'adapt anything that no longer matches:',
  ];

  route.steps.forEach((step, index) => {
    const what = step.action.replace(/_/g, ' ');
    const target =
      step.label !== undefined && step.label !== ''
        ? ` "${step.label}"`
        : step.role !== undefined
          ? ` the ${step.role}`
          : '';
    out.push(`  ${String(index + 1)}. ${what}${target}`);
  });

  return out;
}

/** Forget everything. Exposed so the user has a way to clear it. */
export async function forgetRoutes(): Promise<void> {
  const store = area();
  if (store === undefined) return;
  try {
    await store.set({ [STORAGE_KEY]: { routes: [] } satisfies StoredRoutes });
  } catch {
    // Nothing to do; the caller cannot act on this either.
  }
}
