// Drives scripts/workshop_stand/e04_detail.js with a fake Playwright page, API and contexts, so the runner's
// error boundary and cleanup (WS-13 E4 T7-R01/R02) are proven without a browser or a stand.
//   node e04_detail_harness.mjs <runner.js> <case>
// Prints one JSON object: what the runner posted to its job server, what it returned, and the order in which
// the fake contexts were routed, unrouted and closed. The fake token is a marker that must appear nowhere in it.
import { readFileSync } from 'node:fs';

const MARKER = 'zq9-plural-alpha-4417-fake'; // the Python side names the same marker

const [runnerPath, name] = process.argv.slice(2);
// The repo's own runner file — the same source Playwright MCP evaluates.
const runner = new Function(`return (${readFileSync(runnerPath, 'utf8')}\n)`)();

const log = [];
const posts = [];
// What Playwright appends to an error: the call log, the request's headers among them.
const leaky = (first) => new Error(`${first}\nCall log:\n  - → GET http://stand/api/v1/projects/1\n    - authorization: Bearer ${MARKER}`);
const response = (status, body) => ({ ok: () => status >= 200 && status < 300, status: () => status, json: async () => body });
const FIX = {
  '/projects/1': { id: 1, lines: [{ id: 11, mode: 'product', product_id: 5, product_name: 'Lamp' }] },
  '/projects/2': { id: 2, lines: [{ id: 21, mode: 'parts' }] },
  '/groups/': [{ name: 'Administrators', permissions: ['queue:create'] }, { name: 'Viewers', permissions: [] }],
  '/auth/me': { id: 1 },
};

// A route the page is answering: `continue` fails as a disposed request context does.
const fire = async (handlers) => {
  const route = {
    request: () => ({ method: () => 'GET', url: () => 'http://stand/api/v1/projects/1' }),
    continue: async () => { throw leaky('route.continue: Request context disposed.'); },
  };
  for (const h of [...handlers]) await h(route);
};

const page = (c) => {
  let n = 0;
  const browser = {
    newContext: async () => {
      const id = `ctx${++n}`;
      const handlers = [];
      log.push(`${id}.new`);
      return {
        routeWebSocket: async () => {},
        addInitScript: async () => { if (c.initFails) throw leaky('browserContext.addInitScript: Target closed'); },
        newPage: async () => ({
          on: () => {},
          route: async (_re, h) => { handlers.push(h); log.push(`${id}.route`); },
          unrouteAll: async () => {
            log.push(`${id}.unrouteAll`);
            if (c.routeFailsOnClose) await fire(handlers);
            handlers.length = 0;
          },
          goto: async () => {
            if (c.gotoFails) throw leaky('page.goto: net::ERR_CONNECTION_REFUSED at http://ui/projects/1');
            if (c.routeFailsLive) await fire(handlers);
          },
        }),
        // A context-level unroute would leave the page's routes in place — logged apart so a test sees which ran.
        unrouteAll: async () => { log.push(`${id}.contextUnrouteAll`); },
        close: async () => { log.push(`${id}.close`); if (handlers.length) log.push(`${id}.closedWithRoutes`); },
      };
    },
  };
  const job = { token: MARKER, api: 'http://stand', ui: 'http://ui', out: 'out', orders: { 241: 1, 244: 2 }, only: c.only ?? '' };
  return {
    context: () => ({ browser: () => browser }),
    request: {
      get: async (url) => {
        if (url.endsWith('/job.json')) return response(200, job);
        const path = url.replace('http://stand/api/v1', '');
        if (c.readFails && c.readFails.test(path)) {
          if (c.readFailsWith === 'throw') throw leaky('apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:8198');
          return response(c.readFailsWith, { detail: `Bearer ${MARKER}` });
        }
        return response(200, FIX[path.split('?')[0]] ?? {});
      },
      post: async (url, { data }) => {
        posts.push({ path: new URL(url).pathname, data: JSON.parse(JSON.stringify(data)) });
        return response(200, {});
      },
    },
  };
};

const CASES = {
  // T7-R01: an authenticated read that fails — by the network or by its status — before any scenario.
  prep_read_throws: [{ readFails: /^\/projects\/1$/, readFailsWith: 'throw' }],
  prep_read_refused: [{ readFails: /^\/groups\/$/, readFailsWith: 401 }],
  // …and one of the reads taken between scenarios.
  late_prep_read_fails: [{ only: 'nothing-matches', readFails: /\/plan$/, readFailsWith: 500 }],
  // T7-R02 through a real scenario: navigation fails with the headers in its message.
  real_scenario_throws: [{ only: 'geometry@2560', gotoFails: true }],
  // T7-R02 through the harness's own scenarios.
  route_fails_live: [{ routeFailsLive: true }, async ({ scenario, open }) => {
    await scenario('live', [], async () => { const { p } = await open(1440); await p.goto('http://ui/'); return { pass: true }; });
  }],
  route_fails_while_closing: [{ routeFailsOnClose: true }, async ({ scenario, open }) => {
    await scenario('closing', [], async () => { const { p } = await open(1440); await p.goto('http://ui/'); return { pass: true }; });
  }],
  scenario_closes_its_own: [{ routeFailsOnClose: true }, async ({ scenario, open }) => {
    await scenario('own-close', [], async () => { const { ctx, p } = await open(1440); await p.goto('http://ui/'); await ctx.close(); return { pass: true }; });
  }],
  open_fails: [{ initFails: true }, async ({ scenario, open }) => {
    await scenario('open', [], async () => { await open(1440); return { pass: true }; });
  }],
  scenario_throws_after_open: [{}, async ({ scenario, open }) => {
    await scenario('throws', [], async () => { await open(1440); await open(390); throw leaky('locator.click: Target closed'); });
  }],
  scenario_reports_the_token: [{}, async ({ scenario }) => {
    await scenario('echo', [], async () => ({ pass: true, measured: { text: `Bearer ${MARKER}` } }));
  }],
  harmless_hint_is_kept: [{}, async ({ scenario }) => {
    await scenario('timeout', [], async () => { throw new Error('locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole(\'button\')'); });
  }],
  open_outside_a_scenario: [{}, async ({ open }) => { await open(1440); throw leaky('page.evaluate: boom'); }],
};

const [c, selftest] = CASES[name];
const returned = await runner(page(c), selftest ?? null);
process.stdout.write(JSON.stringify({ posts, returned, log }));
