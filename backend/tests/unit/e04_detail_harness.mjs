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

// A route the page is answering: `continue` fails as a disposed request context does; `fulfill` is logged
// (status, and the JSON it answered with), `fetch` returns a plain JSON answer for a rewrite to change.
const fire = async (handlers) => {
  const route = {
    request: () => ({ method: () => 'GET', url: () => 'http://stand/api/v1/projects/1' }),
    continue: async () => { throw leaky('route.continue: Request context disposed.'); },
    fetch: async () => ({ headers: () => ({ 'content-type': 'application/json' }), json: async () => ({ n: 1 }) }),
    fulfill: async (o) => { log.push(`fulfill.${o.status ?? 200}.${JSON.stringify(o.json ?? null)}`); },
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
            for (let k = 0; k < (c.fires ?? 0); k += 1) await fire(handlers);
          },
        }),
        // A context-level unroute would leave the page's routes in place — logged apart so a test sees which ran.
        unrouteAll: async () => { log.push(`${id}.contextUnrouteAll`); },
        close: async () => { log.push(`${id}.close`); if (handlers.length) log.push(`${id}.closedWithRoutes`); },
      };
    },
  };
  const job = { token: MARKER, api: 'http://stand', ui: 'http://ui', out: 'out', orders: { 241: 1, 244: 2 }, only: c.only ?? '', ...(c.media ? { media_token: c.media } : {}), ...(c.mode ? { mode: c.mode } : {}) };
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
      // `refuse`: { path: status } — the job server answering that post with an error.
      post: async (url, { data }) => {
        const path = new URL(url).pathname;
        const status = (c.refuse ?? {})[path] ?? 200;
        posts.push({ path, status, data: JSON.parse(JSON.stringify(data)) });
        return response(status, {});
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
  // …and through E5's runner (e05_detail.js), whose scenarios have their own names.
  e05_real_scenario_throws: [{ only: 'add-geometry@2560', gotoFails: true }],
  // …and through E6's runner (e06_detail.js).
  e06_real_scenario_throws: [{ only: 'form-geometry@1920', gotoFails: true }],
  // …and through E7's runner (e07_detail.js).
  e07_real_scenario_throws: [{ only: 'tiles@1440', gotoFails: true }],
  // …and through E8's runner (e08_detail.js), whose first read is product 1.
  e08_real_scenario_throws: [{ only: 'header@1440', gotoFails: true }],
  e08_prep_read_throws: [{ readFails: /^\/products\/1$/, readFailsWith: 'throw' }],
  // …and through E9's runner (e09_detail.js), whose first read is product 1 too.
  e09_real_scenario_throws: [{ only: 'header@1440', gotoFails: true }],
  e09_prep_read_throws: [{ readFails: /^\/products\/1$/, readFailsWith: 'throw' }],
  // …and through E10's runner (e10_editors.js), whose first read is product 1 as well.
  e10_real_scenario_throws: [{ only: 'form@1440', gotoFails: true }],
  e10_prep_read_throws: [{ readFails: /^\/products\/1$/, readFailsWith: 'throw' }],
  // …and through E11's runner (e11_customers.js), whose first read is customer 1.
  e11_real_scenario_throws: [{ only: 'list@1440', gotoFails: true }],
  e11_prep_read_throws: [{ readFails: /^\/customers\/1$/, readFailsWith: 'throw' }],
  // …and through E12's runner (e12_stock.js), whose first read is position 1.
  e12_real_scenario_throws: [{ only: 'page@1440', gotoFails: true }],
  e12_prep_read_throws: [{ readFails: /^\/stock\/items\/1$/, readFailsWith: 'throw' }],
  // E6: a GET answered by its turn — failed the first time, rewritten the second.
  gets_by_turn: [{ fires: 2 }, async ({ scenario, open }) => {
    let n = 0;
    await scenario('turns', [], async () => {
      const { p } = await open(1440, { gets: [[/\/projects\/1$/, () => { n += 1; return n === 1 ? { fail: 500 } : { rewrite: (b) => ({ ...b, seen: n }) }; }]] });
      await p.goto('http://ui/');
      return { pass: true };
    });
  }],
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
  // E5: the media token the job hands the runner is guarded like the app token.
  scenario_reports_the_media_token: [{ media: 'mq7-media-marker-fake' }, async ({ scenario }) => {
    await scenario('echo', [], async () => ({ pass: true, measured: { src: '/api/v1/x.png?token=mq7-media-marker-fake' } }));
  }],
  harmless_hint_is_kept: [{}, async ({ scenario }) => {
    await scenario('timeout', [], async () => { throw new Error('locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByRole(\'button\')'); });
  }],
  open_outside_a_scenario: [{}, async ({ open }) => { await open(1440); throw leaky('page.evaluate: boom'); }],
  // T7-R03: the job server refusing a record, or the end of the run.
  record_refused: [{ refuse: { '/record': 500 } }, async ({ scenario }) => { await scenario('one', [], async () => ({ pass: true })); }],
  done_refused: [{ refuse: { '/done': 500 } }, async ({ scenario }) => { await scenario('one', [], async () => ({ pass: true })); }],
  // Every scenario the real runner declares, none of them run.
  declared: [{ only: 'nothing-matches' }],
  // …and the E5 runner's `edges` set (a job with mode «edges»).
  declared_edges: [{ only: 'nothing-matches', mode: 'edges' }],
};

const [c, selftest] = CASES[name];
const returned = await runner(page(c), selftest ?? null);
process.stdout.write(JSON.stringify({ posts, returned, log }));
