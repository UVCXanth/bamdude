// WS-13 E7 acceptance runner (spec §I1/I2), run by Playwright MCP's browser_run_code_unsafe:
//   filename: scripts/workshop_stand/e07_detail.js — while `e07_evidence.py serve` listens on 127.0.0.1:8197.
// The harness is E4's (e04_detail.js), unchanged in what it guarantees: every scenario records WHAT was run
// (recipe + fixtures), WHERE (viewport, DPR, the actual <html> classes), WHAT was measured and whether it matched
// the spec — a failure is a failure, a surface it cannot reach is `pending`. Nothing reaches the stand but reads:
// every non-GET request of every context is answered here (the stage writes among them), and the states the
// baseline does not hold are rewritten GET answers in this runner's own context only. The oracles measure what a
// person reads (widths, columns, text, where a control sits, whether a click lands), never a class name — except
// where the spec names the geometry rule itself (a 7×2 grid, four columns of 240 px).
// A second argument, a function, is the local self-test's door (backend/tests/unit/test_workshop_stand.py): it runs
// its own scenarios through this harness instead of the real ones. Playwright MCP passes the page alone.
async (page, selftest = null) => {
  const base = 'http://127.0.0.1:8197';
  const summary = [];
  const opened = []; // the state of every context opened, in order — a scenario reads its own slice
  // Every context this runner opens, until it is closed — the outer `finally` closes what is left.
  const live = new Map(); // ctx → { routeErrors, closing, pages }
  let job = null;
  let stage = 'job';
  let incomplete = false;
  let sent = 0; // records the job server accepted — the count `/done` reports
  const declared = []; // every scenario this runner has, run or filtered out

  // ⚠️ **No raw error leaves this runner.** A Playwright error's text can carry its call log —
  // the request headers, the app token among them — so a failure is reported as a code, the
  // stage it happened in, the error's class, and a first line only when it matches a known
  // harmless shape (a locator timeout, a script TypeError). Cutting to the first line is not
  // redaction; the whitelist is.
  const HARMLESS = [
    /^(locator|page|frame|elementHandle|keyboard|mouse)\.\w+: Timeout \d+ms exceeded\.$/,
    /^Cannot read properties of (undefined|null) \(reading '[\w$]+'\)$/,
    /^[\w$.]+ is not a function$/,
    /^[\w$]+ is not defined$/,
  ];
  const safeError = (e, where) => {
    const code = e && typeof e.code === 'string' && /^[\w.-]{1,60}$/.test(e.code) ? e.code : 'error';
    const out = { code, stage: where, name: e && typeof e.name === 'string' && /^\w{1,40}$/.test(e.name) ? e.name : 'Error' };
    // `where` of a runner failure is the stand path it read — ours, and free of secrets.
    if (e && e.name === 'RunnerFailure' && typeof e.where === 'string') out.at = e.where;
    const first = String((e && e.message) || '').split('\n')[0].trim();
    const secretFree = !/authori[sz]ation|bearer|cookie|token|eyJ[\w-]{10,}/i.test(first) &&
      !(job && [job.token, job.media_token].some((s) => s && first.includes(s)));
    if (secretFree && HARMLESS.some((re) => re.test(first))) out.hint = first;
    return out;
  };
  const failure = (code, where) => Object.assign(new Error(code), { name: 'RunnerFailure', code, where });
  // A post the job server did not accept — no answer or not 2xx — makes the run incomplete;
  // the server compares the count of accepted records with what it holds.
  const post = async (path, data) => {
    let res = null;
    try {
      res = await page.request.post(`${base}${path}`, { data });
    } catch { /* below */ }
    if (res && res.ok()) return true;
    incomplete = true;
    return false;
  };
  // The last guard: a record that carries the token, whatever put it there, is replaced by a
  // failure that says so — and never sent.
  const scrub = (r) => {
    let text = null;
    try { text = JSON.stringify(r); } catch { /* below */ }
    if (text == null) return { id: r.id, ids: r.ids, source: r.source, pass: false, error: { code: 'record_unserializable', stage: r.id } };
    if (job && [job.token, job.media_token].some((s) => s && text.includes(s))) return { id: r.id, ids: r.ids, source: r.source, pass: false, error: { code: 'secret_in_record', stage: r.id } };
    return r;
  };
  const record = async (raw) => {
    const r = scrub(raw);
    summary.push(`${r.pass ? 'ok  ' : r.pass === null ? 'PEND' : 'FAIL'} ${r.id}`);
    if (await post('/record', r)) sent += 1;
  };
  // A wait with a deadline, failing by a code — a fixed pause proves nothing about an order of events.
  const within = (promise, ms, code) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure(code, 'wait')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
  // The routes are the PAGE's (the runner's own and a scenario's fixtures), so each page lets go
  // of them before the context closes; an error from here on is the closing's, not a scenario's.
  const closeContext = async (ctx) => {
    const state = live.get(ctx);
    if (!state) return;
    state.closing = true;
    live.delete(ctx);
    // ⚠️ Nothing reaches the stand while a context closes (WS-13 E13): a page can still be
    // mid-sequence, and with its own routes taken off its next write went to the stand
    // unanswered. A context-level route that aborts every request goes in FIRST.
    try { await ctx.route(/.*/, (route) => route.abort().catch(() => {})); } catch { /* already gone */ }
    for (const p of state.pages) {
      try { await p.unrouteAll({ behavior: 'ignoreErrors' }); } catch { /* already gone */ }
    }
    try { await ctx.close(); } catch { /* already gone */ }
  };

  try {
  try {
    job = await (await page.request.get(`${base}/job.json`)).json();
  } catch {
    throw failure('job_unreadable', 'job');
  }
  const browser = page.context().browser();
  const O = job.orders;
  const A = O['241'];
  const B = O['244'];
  const HEIGHTS = { 2560: 1440, 1920: 1080, 1440: 900, 1280: 800, 1101: 800, 1100: 800, 1024: 768, 768: 1024, 761: 800, 760: 800, 561: 800, 560: 800, 390: 844 };
  const ONLY = (job.only ?? '').split(',').filter(Boolean);
  const auth = { Authorization: `Bearer ${job.token}` };

  const env = async (p) => p.evaluate(() => ({ viewport: [innerWidth, innerHeight], dpr: window.devicePixelRatio, theme: document.documentElement.className }));
  const shoot = async (p, name, opts = {}) => {
    const file = `${job.out}/${name}.png`;
    await p.screenshot({ path: file, fullPage: false, ...opts });
    return file;
  };
  // An authenticated read of the stand. Its failure is a code and the path, never Playwright's
  // message: that one carries the request's headers.
  const read = async (path) => {
    let res;
    try {
      res = await page.request.get(`${job.api}/api/v1${path}`, { headers: auth });
    } catch {
      throw failure('read_network', path);
    }
    if (!res.ok()) throw failure(`read_http_${res.status()}`, path);
    try {
      return await res.json();
    } catch {
      throw failure('read_json', path);
    }
  };

  // A context of our own. `rewrite`: [[pathRegex, (json, url) => json]] for GET answers; `fail`: [[regex, status]];
  // `delay`: [[regex, ms]]; `gets`: [[regex, (url) => null | {delay?, fail?} | {rewrite}]] — a GET answered by its
  // turn (the callback counts its own calls: fail once, then slow, then a narrower state); `writes`: [[regex,
  // json | (request) => json | {__status, json}]] answers for non-GET, every other non-GET gets {}. `me`: fields
  // merged into /auth/me.
  const open = async (w, { h, storage = {}, me = null, rewrite = [], fail = [], delay = [], gets = [], writes = [], settings = null } = {}) => {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h || HEIGHTS[w] || 900 }, deviceScaleFactor: 1, locale: 'uk-UA',
      timezoneId: 'Europe/Kyiv', serviceWorkers: 'block',
    });
    // Tracked before anything else can throw, so a failure half-way through opening still closes it.
    const state = { routeErrors: [], closing: false, pages: [] };
    live.set(ctx, state);
    opened.push(state);
    // A scenario closing its own context goes through the same door as the cleanup.
    ctx.close = ((close) => async () => (live.has(ctx) ? closeContext(ctx) : close()))(ctx.close.bind(ctx));
    // The socket's token is minted by a POST (it writes a row), which this runner answers itself — a silent
    // socket of our own instead: nothing reaches the stand, and no event is invented.
    if (typeof ctx.routeWebSocket === 'function') await ctx.routeWebSocket(/\/api\/v1\/ws/, () => {});
    await ctx.addInitScript(({ token, storage }) => {
      if (sessionStorage.getItem('e07-init')) return;
      sessionStorage.setItem('e07-init', '1');
      localStorage.clear();
      localStorage.setItem('auth_token', token);
      for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    }, { token: job.token, storage });
    const p = await ctx.newPage();
    state.pages.push(p);
    const errors = [];
    p.on('pageerror', (e) => errors.push(safeError(e, 'page')));
    const requests = [];
    // A picture's URL carries a media token in `?token=` — logged as the path with that value masked.
    p.on('request', (r) => {
      if (!r.url().includes('/api/v1/')) return;
      const u = new URL(r.url());
      if (u.searchParams.has('token')) u.searchParams.set('token', 'masked');
      requests.push(`${r.method()} ${u.pathname}${u.search}`);
    });
    // A route callback that fails while its scenario is alive — a fixture or the network — FAILS
    // that scenario (recorded safely); only a failure caused by the context closing is expected.
    const answer = async (route) => {
      const req = route.request();
      const url = req.url();
      if (req.method() !== 'GET') {
        const hit = writes.find(([re]) => re.test(url));
        // The stock proposal only READS — answered here with the shape it has (empty), never
        // with `{}`, which the dialog cannot read. The media token's mint writes a row: the
        // page gets the one the job server minted before the run (pictures need it).
        const fallback = /\/stock\/suggest/.test(url) ? { items: [] }
          : /\/api\/v1\/auth\/media-token/.test(url) && job.media_token ? { token: job.media_token } : {};
        let answer = hit ? (typeof hit[1] === 'function' ? await hit[1](req) : hit[1]) : fallback;
        if (answer && answer.__status) return route.fulfill({ status: answer.__status, json: answer.json ?? {} });
        return route.fulfill({ status: 200, json: answer });
      }
      const turn = gets.find(([re]) => re.test(url));
      const step = turn ? await turn[1](url) : null;
      if (step && step.delay) await new Promise((r) => setTimeout(r, step.delay));
      if (step && step.fail) return route.fulfill({ status: step.fail, json: { detail: 'e07 runner' } });
      // A body of the runner's own (Codex r1 V05: the 201-order forecast batches) — the stand is never asked.
      if (step && step.json) return route.fulfill({ status: 200, json: step.json });
      const failing = fail.find(([re]) => re.test(url));
      if (failing) return route.fulfill({ status: failing[1], json: { detail: 'e07 runner' } });
      const waiting = delay.find(([re]) => re.test(url));
      if (waiting) await new Promise((r) => setTimeout(r, waiting[1]));
      const rw = step && step.rewrite ? [null, step.rewrite] : rewrite.find(([re]) => re.test(url));
      const isMe = me && /\/api\/v1\/auth\/me\/?(\?.*)?$/.test(url);
      const isSettings = settings && /\/api\/v1\/settings\/?(\?.*)?$/.test(url);
      if (!rw && !isMe && !isSettings) return route.continue();
      const response = await route.fetch();
      const ct = response.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return route.fulfill({ response });
      let body = await response.json();
      if (rw) body = await rw[1](body, url);
      if (isMe) body = { ...body, ...me };
      if (isSettings) body = { ...body, ...settings };
      return route.fulfill({ response, json: body });
    };
    const route = (re, handler) => p.route(re, async (r) => {
      try {
        await handler(r);
      } catch (e) {
        if (!state.closing) state.routeErrors.push(safeError(e, 'route'));
      }
    });
    await route(/\/api\/v1\//, answer);
    return { ctx, p, errors, requests, route };
  };
  // Every context a scenario opened is closed whatever the scenario did; a route failure during
  // it makes it a FAIL whatever it measured.
  const scenario = async (id, ids, fn) => {
    declared.push(id);
    if (ONLY.length && !ONLY.some((o) => id.startsWith(o))) return;
    stage = id;
    const before = new Set(live.keys());
    const mark = opened.length;
    let result;
    try {
      result = await fn();
    } catch (e) {
      result = { pass: false, error: safeError(e, id) };
    } finally {
      for (const ctx of [...live.keys()]) if (!before.has(ctx)) await closeContext(ctx);
    }
    const routeErrors = opened.slice(mark).flatMap((s) => s.routeErrors);
    if (routeErrors.length) result = { ...result, pass: false, route_errors: routeErrors.slice(0, 5) };
    await record({ id, ids, source: 'app', ...result });
  };
  const detail = (id, q = '') => `${job.ui}/projects/${id}${q}`;
  const ready = async (p) => {
    await p.waitForSelector('[data-testid="order-grid"]', { timeout: 20000 });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(400);
  };
  // Every query of the app is fresh for a minute and retried ONCE (appQueryClient), so a background
  // re-read is a minute passing and the page coming back to the front, and a read the page shows as
  // failed is two failed answers in a row — a `gets` turn counts both.
  const refetchLater = async (p) => {
    await p.clock.fastForward('01:30');
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await p.waitForTimeout(1500);
  };

  const realScenarios = async () => {
  stage = 'prepare';
  // The mockup entities (spec §I1): 241 active «printing», 243 «prep», 244 «qc», 245 completed,
  // 250 cancelled, 251 without a customer — and a reader's permissions off the Administrators group.
  const orderA = await read(`/projects/${A}`);
  const groups = await read('/groups/');
  const groupList = Array.isArray(groups) ? groups : (groups.items ?? []);
  const adminPerms = (groupList.find((g) => g.name === 'Administrators') ?? { permissions: [] }).permissions;
  const READER = { is_admin: false, role: 'user', permissions: adminPerms.filter((perm) => perm === 'projects:read' || !perm.startsWith('projects:')) };
  const PREP = O['243'];
  const DONE = O['245'];
  const CUSTOMER = (job.customers ?? {})['1'];
  const codeA = orderA.code ?? 'OR-0031';

  // --- doors and oracles ---
  const LIST = /\/api\/v1\/projects\/\?/;
  const listPage = async (p, query = '') => {
    await p.goto(`${job.ui}/projects${query}`, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(700);
  };
  const view = (v, extra = {}) => ({ storage: { 'projects.view': v, ...extra } });
  const docOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  // What sticks out past the right edge of the viewport, outside any scroll box of its own — named, so a
  // failed overflow says WHO, not only how much.
  const offenders = (p) => p.evaluate(() => {
    const scrolls = (el) => { for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return a !== document.documentElement && a !== document.body && a.tagName !== 'MAIN'; } return false; };
    return [...document.querySelectorAll('body *')].filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > innerWidth + 1 && !scrolls(el))
      .slice(0, 6).map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')}:${Math.round(el.getBoundingClientRect().right)}`);
  });
  const hitTest = (p, selector) => p.evaluate((sel) => [...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0).map((el) => {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      what: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40) || el.tagName,
      inView: r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.width > 0,
      hits: !!hit && (hit === el || el.contains(hit)),
    };
  }), selector);
  // The column count of a grid as it is LAID OUT: the distinct left edges of its visible children.
  const columnsOf = (locator) => locator.evaluate((el) => new Set([...el.children].filter((c) => c.getClientRects().length).map((c) => Math.round(c.getBoundingClientRect().left))).size);
  const tilesGrid = (p) => p.getByTestId('orders-tile-active').locator('xpath=..');
  const toastText = (p, re, ms = 6000) => within(p.waitForFunction((src) => {
    const rx = new RegExp(src);
    return [...document.querySelectorAll('body *')].some((el) => el.children.length === 0 && rx.test(el.textContent ?? ''));
  }, re.source), ms, 'no_toast');
  const textOf = (locator) => locator.evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim());
  const recorder = (store, re, answerOf) => [re, async (req) => {
    let body = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    const entry = { method: req.method(), path: new URL(req.url()).pathname, body };
    store.push(entry);
    return answerOf ? answerOf(entry, store.length) : {};
  }];
  const rowOf = (p, id) => p.getByTestId(`order-row-${id}`);
  const HEADERS = ['Замовлення / замовник', 'Етап', 'Забезпечено', 'Друк / черга', 'Дедлайн', 'Готово ≈', 'Матеріал', 'Відповідальний', 'Дії'];
  const headersOf = (p) => p.locator('table thead th').evaluateAll((ths) => ths.map((th) => (th.textContent.replace(/[▲▼]/g, '').trim() || th.getAttribute('aria-label') || '').trim()));
  // A list answer with some rows changed — `(row) => row` per id.
  const listWith = (changes) => (body) => ({ ...body, items: (body.items ?? []).map((r) => (changes[r.id] ? changes[r.id](r) : r)) });

  // ======================= 1. tiles (C02) =======================
  await scenario('tiles@1440', ['E7-C02', 'O02'], async () => {
    const { ctx, p, errors } = await open(1440, {
      ...view('table'),
      rewrite: [[/\/api\/v1\/projects\/summary/, (b) => ({ ...b, qc: 7, all_covered: 3 })]],
    });
    await listPage(p);
    const qc = await textOf(p.getByTestId('orders-tile-qc'));
    const active = await textOf(p.getByTestId('orders-tile-active'));
    const printing = await textOf(p.getByTestId('orders-tile-printing'));
    const cols = await columnsOf(tilesGrid(p));
    const file = await shoot(p, 'tiles@1440', { clip: { x: 0, y: 0, width: 1440, height: 420 } });
    await ctx.close();
    return {
      recipe: { url: '/projects', fixture: ['GET /projects/summary: qc 7, all_covered 3 (rewritten)'] },
      measured: { qc, active, printing, cols, errors },
      pass: qc.startsWith('На контролі якості') && /\b7\b/.test(qc) && !/\b3\b/.test(qc) && /прострочено · \d+ термінових/.test(active) &&
        /\d+ \/ \d+/.test(printing) && cols === 4 && errors.length === 0,
      screenshots: [file],
    };
  });

  for (const w of [1101, 1100, 561, 560]) {
    await scenario(`tiles-grid@${w}`, ['E7-C02', 'R06', 'S02'], async () => {
      const want4 = w > 1100 ? 4 : w > 560 ? 2 : 1;
      const want3 = w > 1100 ? 3 : w > 560 ? 2 : 1;
      const out = {};
      const { ctx, p, errors } = await open(w, { h: 800, ...view('table') });
      await listPage(p);
      out.orders = { cols: await columnsOf(tilesGrid(p)), overflow: await docOverflow(p) };
      await p.goto(`${job.ui}/customers`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(700);
      const customerTiles = p.locator('section.grid').first();
      out.customers = { cols: (await customerTiles.count()) ? await columnsOf(customerTiles) : null, overflow: await docOverflow(p) };
      if (CUSTOMER) {
        await p.goto(`${job.ui}/customers/${CUSTOMER}`, { waitUntil: 'networkidle' });
        await p.waitForTimeout(700);
        const pageTiles = p.locator('section.grid').first();
        out.customer = { cols: (await pageTiles.count()) ? await columnsOf(pageTiles) : null, overflow: await docOverflow(p) };
      }
      // The values must stay readable: no tile's figure clipped by its own box.
      const clipped = await p.evaluate(() => [...document.querySelectorAll('section.grid > div p.text-2xl')].filter((v) => v.scrollWidth > v.clientWidth + 1).length);
      const file = await shoot(p, `tiles-grid@${w}`);
      await ctx.close();
      return {
        recipe: { url: ['/projects', '/customers', '/customers/{customer:1}'], viewport: w },
        env: { viewport: [w, 800] },
        measured: { ...out, want4, want3, clipped, errors },
        pass: out.orders.cols === want4 && out.customers.cols === want4 && (!out.customer || out.customer.cols === want3) &&
          [out.orders, out.customers, out.customer].filter(Boolean).every((x) => x.overflow <= 0) && clipped === 0 && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('tiles-error@1440', ['E7-C02', 'E7-C05'], async () => {
    let failing = true;
    const { ctx, p, errors } = await open(1440, {
      ...view('table'),
      gets: [[/\/api\/v1\/projects\/summary/, () => (failing ? { fail: 500 } : null)]],
    });
    await listPage(p);
    await p.waitForTimeout(1500);
    // The tile's FIGURE, not its whole text: the line under it carries a dash of its own.
    const figure = () => textOf(p.getByTestId('orders-tile-qc').locator('p.text-2xl'));
    const qc = await figure();
    const retry = p.getByRole('button', { name: 'Спробувати знову' });
    const offered = (await retry.count()) > 0;
    failing = false;
    if (offered) await retry.first().click();
    await p.waitForTimeout(1500);
    const after = await figure();
    await ctx.close();
    return {
      recipe: { url: '/projects', fixture: ['GET /projects/summary → 500 (twice), then the stand'] },
      measured: { qc, offered, after, errors },
      pass: qc === '—' && offered && /^\d+$/.test(after),
    };
  });

  // ======================= 2. filament (C03) =======================
  await scenario('filament@1440', ['E7-C03', 'O03'], async () => {
    const { ctx, p, errors } = await open(1440, view('table'));
    await listPage(p);
    const panel = p.getByTestId('filament-strip');
    if (!(await panel.count())) {
      await ctx.close();
      return { pass: null, pending: 'the stand has no filament need' };
    }
    const heading = await textOf(panel.getByRole('heading'));
    const chips = await panel.locator('[data-testid^="filament-chip-"]').allTextContents();
    const file = await shoot(p, 'filament@1440', { clip: { x: 0, y: 0, width: 1440, height: 560 } });
    await ctx.close();
    return {
      recipe: { url: '/projects' },
      measured: { heading, chips: chips.slice(0, 8), errors },
      pass: heading.startsWith('Філамент (оцінка слайсера, не факт витрати)') && chips.length > 0 && chips.length <= 7 &&
        chips.every((c) => /треба .+ \/ є /.test(c)) && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('filament-states@1440', ['E7-C03', 'R02'], async () => {
    const row = (over) => ({ material: 'PLA', colour: 'білий', need_g: 300, have_g: 1000, have_type_g: 2500, short_g: 0, unknown_prints: 0, orders_count: 2, ...over });
    const farm = (over) => ({ rows: [row()], orders_count: 2, unknown_prints: 0, stock_unavailable: false, assumptions: ['slicer_estimate'], ...over });
    const cases = [
      ['unknown-weight', farm({ rows: [row({ need_g: 0, unknown_prints: 2 })] }), false],
      ['partial-weight', farm({ rows: [row({ unknown_prints: 1 })] }), false],
      ['rowless-prints', farm({ unknown_prints: 3 }), false],
      ['shelf-unreadable', farm({ stock_unavailable: true, rows: [row({ have_g: null, short_g: null })] }), false],
      ['all-known', farm(), true],
    ];
    const seen = [];
    for (const [name, answer, green] of cases) {
      const { ctx, p } = await open(1440, { ...view('table'), rewrite: [[/\/api\/v1\/projects\/filament/, () => answer]] });
      await listPage(p);
      const says = await p.getByText('усе є на полиці', { exact: true }).count();
      seen.push({ name, green: says > 0, want: green });
      await ctx.close();
    }
    // Seven chips, the rest unfolded in place.
    const many = Array.from({ length: 10 }, (_, i) => row({ material: `M${i}`, colour: null }));
    const { ctx, p, errors } = await open(1440, { ...view('table'), rewrite: [[/\/api\/v1\/projects\/filament/, () => farm({ rows: many })]] });
    await listPage(p);
    const panel = p.getByTestId('filament-strip');
    const before = await panel.locator('[data-testid^="filament-chip-"]').count();
    const more = panel.getByRole('button', { name: 'ще 3' });
    const expandedBefore = (await more.count()) ? await more.getAttribute('aria-expanded') : null;
    if (await more.count()) await more.click();
    const after = await panel.locator('[data-testid^="filament-chip-"]').count();
    await ctx.close();
    // A failed read keeps the panel's place, with a retry.
    const failed = await open(1440, { ...view('table'), fail: [[/\/api\/v1\/projects\/filament/, 500]] });
    await listPage(failed.p);
    await failed.p.waitForTimeout(1500);
    const failText = await textOf(failed.p.getByTestId('filament-strip'));
    await failed.ctx.close();
    // No need at all: no panel.
    const none = await open(1440, { ...view('table'), rewrite: [[/\/api\/v1\/projects\/filament/, () => farm({ rows: [], orders_count: 0 })]] });
    await listPage(none.p);
    const absent = (await none.p.getByTestId('filament-strip').count()) === 0;
    await none.ctx.close();
    return {
      recipe: { url: '/projects', fixture: ['GET /projects/filament rewritten per case (R02 five cases, 10 rows, 500, empty)'] },
      measured: { seen, before, expandedBefore, after, failText, absent, errors },
      pass: seen.every((s) => s.green === s.want) && before === 7 && expandedBefore === 'false' && after === 10 &&
        /Не вдалося прочитати оцінку філаменту/.test(failText) && /Спробувати знову/.test(failText) && absent && errors.length === 0,
    };
  });

  // V03 (Codex r1): a cached answer whose re-read fails is not current — a note with a retry, the
  // last chips kept, never the green «everything is on the shelf»; an empty cached answer too.
  const FARM = /\/api\/v1\/projects\/filament(\?|$)/;
  const enough = (b) => {
    const rows = (b.rows ?? []).length ? b.rows : [{ material: 'PLA', colour: null, need_g: 100, have_g: 1000, have_type_g: 1000, short_g: 0, unknown_prints: 0, orders_count: 1 }];
    return { ...b, stock_unavailable: false, unknown_prints: 0, rows: rows.map((r) => ({ ...r, have_g: Math.max(r.need_g, 1000), have_type_g: Math.max(r.need_g, 1000), short_g: 0, unknown_prints: 0 })) };
  };
  const nothing = (b) => ({ ...b, rows: [], unknown_prints: 0, orders_count: 0 });
  for (const [id, cached] of [['filament-refresh@1440', enough], ['filament-refresh-empty@1440', nothing]]) {
    await scenario(id, ['E7-C03', 'R02', 'V03'], async () => {
      let calls = 0;
      const { ctx, p, errors } = await open(1440, {
        ...view('table'),
        gets: [[FARM, () => { calls += 1; if (calls === 1) return { rewrite: cached }; if (calls <= 3) return { fail: 500 }; return { rewrite: cached }; }]],
      });
      await p.clock.install();
      await listPage(p);
      const read = () => p.evaluate(() => {
        const panel = document.querySelector('[data-testid="filament-strip"]');
        return panel ? { panel: true, green: /усе є на полиці/.test(panel.textContent ?? ''), stale: /Не вдалося оновити/.test(panel.textContent ?? ''), chips: panel.querySelectorAll('[data-testid^="filament-chip-"]').length } : { panel: false };
      });
      const first = await read();
      await refetchLater(p);
      await p.waitForTimeout(1500);
      const failed = await read();
      const file = await shoot(p, id);
      const retry = p.getByTestId('filament-strip').getByRole('button', { name: 'Спробувати знову' });
      const offered = (await retry.count()) > 0;
      if (offered) await retry.click();
      await p.waitForTimeout(1500);
      const retried = await read();
      await ctx.close();
      const isEmpty = cached === nothing;
      return {
        recipe: { url: '/projects', fixture: [`GET /projects/filament: 1st ${isEmpty ? 'no needs' : 'enough on the shelf'} (rewritten), 2nd+3rd → 500, 4th as the 1st`], actions: ['re-read (clock +90 s, visibilitychange)', '«Спробувати знову»'] },
        measured: { calls, first, failed, offered, retried, errors },
        pass: (isEmpty ? !first.panel : first.green) && failed.panel && failed.stale && !failed.green && (isEmpty || failed.chips > 0) && offered &&
          (isEmpty ? !retried.panel : retried.green && !retried.stale) && calls >= 4 && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  // ======================= 3. toolbar (C04) =======================
  await scenario('toolbar@1440', ['E7-C04', 'O04', 'S03', 'S04'], async () => {
    const out = {};
    for (const v of ['table', 'cards', 'workspace', 'kanban', 'deadlines']) {
      const { ctx, p } = await open(1440, view(v));
      await listPage(p);
      out[v] = {
        tabs: await p.getByRole('tablist', { name: 'Статус замовлення' }).count(),
        hint: (await p.getByTestId('orders-statusless-hint').count()) ? await textOf(p.getByTestId('orders-statusless-hint')) : null,
        customer: await p.getByRole('combobox', { name: 'Замовник' }).count(),
        responsible: await p.getByRole('combobox', { name: 'Відповідальний' }).count(),
        placeholder: await p.getByRole('searchbox').getAttribute('placeholder'),
        group: await p.getByLabel('Групувати за замовником').count(),
        sort: await p.getByLabel('Сортувати').count(),
      };
      if (v === 'table') out.file = await shoot(p, 'toolbar@1440', { clip: { x: 0, y: 0, width: 1440, height: 560 } });
      await ctx.close();
    }
    const paged = ['table', 'cards', 'workspace'].every((v) => out[v].tabs === 1 && out[v].hint === null);
    const statusless = out.kanban.tabs === 0 && out.deadlines.tabs === 0 &&
      out.kanban.hint === 'Канбан: активні замовлення за етапами й останні виконані' &&
      out.deadlines.hint === 'Терміни: активні й виконані замовлення за дедлайном';
    const named = Object.keys(out).filter((k) => k !== 'file').every((v) => out[v].customer === 1 && out[v].responsible === 1 && out[v].placeholder === 'Пошук: назва, код, замовник, тег…');
    const grouping = out.table.group === 1 && out.cards.group === 1 && out.workspace.group === 0 && out.kanban.group === 0;
    return {
      recipe: { url: '/projects', views: ['table', 'cards', 'workspace', 'kanban', 'deadlines'] },
      measured: { ...out, file: undefined },
      pass: paged && statusless && named && grouping,
      screenshots: [out.file],
    };
  });

  await scenario('toolbar-reset@1440', ['E7-C04', 'S05'], async () => {
    const { ctx, p, errors } = await open(1440, view('table'));
    await listPage(p, '?tab=completed');
    const before = await p.getByRole('button', { name: 'Скинути', exact: true }).count();
    await p.getByRole('searchbox').fill('корпус');
    await p.waitForTimeout(900);
    const shown = await p.getByRole('button', { name: 'Скинути', exact: true }).count();
    const urlWith = new URL(p.url()).search;
    // Writes replace the URL (the list's contract), so Back would leave the page: not measured here.
    await p.getByRole('button', { name: 'Скинути', exact: true }).first().click();
    await p.waitForTimeout(700);
    const urlAfter = new URL(p.url()).search;
    const focus = await p.evaluate(() => document.activeElement?.getAttribute('type'));
    const gone = await p.getByRole('button', { name: 'Скинути', exact: true }).count();
    await ctx.close();
    return {
      recipe: { url: '/projects?tab=completed', actions: ['type «корпус»', '«Скинути»'] },
      measured: { before, shown, urlWith, urlAfter, focus, gone, errors },
      pass: before === 0 && shown === 1 && /q=/.test(urlWith) && !/q=/.test(urlAfter) && /tab=completed/.test(urlAfter) &&
        focus === 'search' && gone === 0 && errors.length === 0,
    };
  });

  // ======================= 4. table (D) =======================
  for (const w of [2560, 1920, 1440, 1280, 1024, 768, 390]) {
    await scenario(`table@${w}`, ['E7-D01', 'E7-D02', 'E7-D03', 'O05', 'S06'], async () => {
      const { ctx, p, errors } = await open(w, view('table'));
      await listPage(p);
      const headers = await headersOf(p);
      const first = rowOf(p, A);
      const present = (await first.count()) > 0;
      const cell0 = present ? await textOf(first.locator('td').nth(0)) : null;
      const menu = present ? await first.getByRole('button', { name: `Дії замовлення ${codeA}` }).count() : 0;
      const region = p.getByRole('region', { name: 'Замовлення' }).first();
      const scroll = await region.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
      const barInPanel = await p.evaluate(() => {
        const bar = document.querySelector('[data-pagination]');
        const table = document.querySelector('table');
        return !!bar && !!table && bar.closest('.rounded-xl') === table.closest('.rounded-xl');
      });
      const overflow = await docOverflow(p);
      const file = await shoot(p, `table@${w}`);
      await ctx.close();
      return {
        recipe: { url: '/projects', storage: { 'projects.view': 'table' } },
        env: { viewport: [w, HEIGHTS[w]] },
        measured: { headers, present, cell0, menu, scroll, barInPanel, overflow, errors },
        pass: HEADERS.every((h, i) => headers[i] === h) && headers.length === 9 && present && cell0.startsWith(codeA) &&
          cell0.includes(orderA.name) && / · \d+ позиці/.test(cell0) && menu === 1 && barInPanel && overflow <= 0 &&
          (w > 1024 || scroll.sw > scroll.cw) && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('table-ready@1440', ['E7-B03', 'E7-B04', 'R01', 'R07'], async () => {
    const asked = [];
    const ids = [A, PREP, B, O['251']];
    const at = (days) => new Date(Date.now() + days * 864e5).toISOString();
    const fc = (id, over) => ({ project_id: id, now_eta: at(3), now_seconds: 3600, after_eta: null, after_seconds: null, machine_seconds: 3600, unknown_prints: 0, unroutable_prints: 0, eta_complete: true, ahead_count: 0, assumptions: [], incomplete_reasons: [], late: false, ...over });
    const forecast = {
      [ids[0]]: fc(ids[0], { late: true, after_eta: at(5), ahead_count: 2 }),
      [ids[1]]: fc(ids[1], { eta_complete: false, incomplete_reasons: [{ code: 'unknown_time', count: 2 }] }),
      [ids[2]]: fc(ids[2], { incomplete_reasons: [{ code: 'no_plate', count: 6 }] }),
      [ids[3]]: fc(ids[3], { now_eta: null }),
    };
    const { ctx, p, errors } = await open(1440, {
      ...view('table'),
      rewrite: [
        [LIST, listWith(Object.fromEntries(ids.map((id) => [id, (r) => ({ ...r, ordered: Math.max(r.ordered, 5), remaining: Math.max(r.remaining, 3) })])))],
        [/\/api\/v1\/projects\/forecast/, (b, url) => {
          const want = (new URL(url).searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number);
          asked.push(want.length);
          return { ...b, orders: want.map((id) => forecast[id] ?? (b.orders ?? []).find((o) => o.project_id === id)).filter(Boolean) };
        }],
      ],
    });
    await listPage(p);
    await p.waitForTimeout(800);
    const cell = (id) => textOf(p.getByTestId(`order-${id}-ready`));
    const late = await p.getByTestId(`order-${ids[0]}-ready`).locator('[data-late="true"]').count();
    const texts = { late: await cell(ids[0]), partial: await cell(ids[1]), withReasons: await cell(ids[2]), none: await cell(ids[3]) };
    const triangle = await p.getByTestId(`order-${ids[2]}-ready`).getByRole('img', { name: /Неповна оцінка: .*6/ }).count();
    const file = await shoot(p, 'table-ready@1440');
    await ctx.close();
    // A failed forecast: one note with a retry, the cells a dash — never «немає оцінки».
    const failed = await open(1440, {
      ...view('table'),
      fail: [[/\/api\/v1\/projects\/forecast/, 500]],
      rewrite: [[LIST, listWith({ [A]: (r) => ({ ...r, ordered: Math.max(r.ordered, 5), remaining: Math.max(r.remaining, 3) }) })]],
    });
    await listPage(failed.p);
    await failed.p.waitForTimeout(1500);
    const note = (await failed.p.getByText('Прогноз не вдалося прочитати').count()) > 0;
    const dash = await textOf(failed.p.getByTestId(`order-${A}-ready`));
    await failed.ctx.close();
    return {
      recipe: { url: '/projects', fixture: ['GET /projects/ (four rows with something to cover)', 'GET /projects/forecast rewritten per row', 'then GET /projects/forecast → 500'] },
      measured: { texts, late, triangle, asked, note, dash, errors },
      pass: late === 1 && /після 2 терміновіших/.test(texts.late) && texts.partial.includes('неповна оцінка') && !/\d+ (вер|жовт|лист)/.test(texts.partial) &&
        triangle === 1 && texts.none.includes('немає оцінки') && asked.length >= 1 && asked.every((n) => n <= 200) && note && dash === '—' && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('table-sort@1440', ['E7-D01', 'R05'], async () => {
    const { ctx, p, errors, requests } = await open(1440, view('table'));
    await listPage(p);
    await p.getByRole('button', { name: 'Готово ≈', exact: true }).click();
    await p.waitForTimeout(800);
    const urlReady = new URL(p.url()).search;
    const askedReady = requests.some((r) => /sort_by=ready-asc/.test(r));
    await p.goto(`${job.ui}/projects?sort=hours-desc`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(700);
    const chip = p.getByTestId('orders-sort-chip');
    const chipText = (await chip.count()) ? await textOf(chip) : null;
    const marked = await p.locator('th[aria-sort]').count();
    if (await chip.count()) await chip.getByRole('button').click();
    await p.waitForTimeout(800);
    const urlAfter = new URL(p.url()).search;
    const dueSort = await p.locator('th[aria-sort]').evaluateAll((ths) => ths.map((th) => [th.textContent.replace(/[▲▼]/g, '').trim(), th.getAttribute('aria-sort')]));
    await ctx.close();
    return {
      recipe: { url: '/projects', actions: ['«Готово ≈» header', '?sort=hours-desc', 'remove the chip'] },
      measured: { urlReady, askedReady, chipText, marked, urlAfter, dueSort, errors },
      pass: /sort=ready-asc/.test(urlReady) && askedReady && chipText === 'Сортування: Маш.-год ↓' && marked === 0 &&
        !/sort=/.test(urlAfter) && dueSort.length === 1 && dueSort[0][0] === 'Дедлайн' && dueSort[0][1] === 'ascending' && errors.length === 0,
    };
  });

  await scenario('table-menu@1440', ['E7-B07', 'O10', 'S08'], async () => {
    const { ctx, p, errors } = await open(1440, view('table'));
    await listPage(p);
    const before = p.url();
    const trigger = rowOf(p, A).getByRole('button', { name: `Дії замовлення ${codeA}` });
    await trigger.click();
    await p.getByRole('menu').waitFor({ timeout: 5000 });
    const items = (await p.getByRole('menu').getByRole('menuitem').allTextContents()).map((x) => x.trim());
    const file = await shoot(p, 'table-menu@1440');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    const back = await trigger.evaluate((el) => el === document.activeElement);
    const stayed = p.url() === before;
    await ctx.close();
    return {
      recipe: { url: '/projects', actions: [`«Дії замовлення ${codeA}»`, 'Escape'] },
      measured: { items, back, stayed, errors },
      pass: items[0] === 'Відкрити' && items.includes('Редагувати') && items.includes('Склад і видача…') && back && stayed && errors.length === 0,
      screenshots: [file],
    };
  });

  // V05.4 (Codex r1, I1 / R07): «All» with 201 orders that need a forecast asks exactly two batches —
  // 200 + 1 — and never for a completed, an empty or a covered order.
  await scenario('forecast-201@1440', ['E7-B04', 'R07', 'V05'], async () => {
    const NEED = Array.from({ length: 201 }, (_, i) => 60001 + i);
    const SKIP = { completed: [61001, 61002, 61003], empty: [61101, 61102, 61103], covered: [61201, 61202, 61203] };
    const synth = (b) => {
      const tpl = { ...(b.items?.[0] ?? {}), products: [], cover_image_filename: null, prints_in_progress: 0, prints_queued: 0, due_date: null };
      const mk = (id, over = {}) => ({ ...tpl, id, code: `OR-${id}`, name: `Synthetic ${id}`, status: 'active', stage: 'printing', ordered: 10, remaining: 5, covered_units: 5, printed: 5, progress: 0.5, ...over });
      const items = [
        ...NEED.map((id) => mk(id)),
        ...SKIP.completed.map((id) => mk(id, { status: 'completed', stage: 'done', remaining: 0, covered_units: 10, progress: 1 })),
        ...SKIP.empty.map((id) => mk(id, { ordered: 0, remaining: 0, covered_units: 0, printed: 0, progress: 0 })),
        ...SKIP.covered.map((id) => mk(id, { remaining: 0, covered_units: 10, progress: 1 })),
      ];
      return { ...b, items, meta: { ...b.meta, total: items.length, current_page: 1, last_page: 1, per_page: items.length } };
    };
    const asks = [];
    const forecastOf = (id) => ({ project_id: id, now_eta: null, now_seconds: null, after_eta: null, after_seconds: null, machine_seconds: null, unknown_prints: 0, unroutable_prints: 0, eta_complete: true, ahead_count: 0, assumptions: [], incomplete_reasons: [], late: false });
    const { ctx, p, errors } = await open(1440, {
      ...view('table', { 'projects.perPage': '-1' }),
      rewrite: [[LIST, synth]],
      gets: [[/\/api\/v1\/projects\/forecast\?/, (url) => {
        const ids = (new URL(url).searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number);
        asks.push(ids);
        return { json: { farm: { free_at: null, free_seconds: 0, unknown_prints: 0, printers: [] }, orders: ids.map(forecastOf) } };
      }]],
    });
    await listPage(p, '?tab=all');
    await p.waitForTimeout(1500);
    const rows = await p.locator('tbody tr[data-testid^="order-row-"]').count();
    await ctx.close();
    const asked = asks.flat();
    const skipped = [...SKIP.completed, ...SKIP.empty, ...SKIP.covered];
    return {
      recipe: { url: '/projects?tab=all', storage: { 'projects.perPage': '-1' }, fixture: ['GET /projects/: 201 active orders needing a forecast + 3 completed + 3 with nothing ordered + 3 covered (synthetic, rewritten)', 'GET /projects/forecast: answered by the runner'] },
      measured: { rows, requests: asks.length, sizes: asks.map((x) => x.length), skippedAsked: asked.filter((id) => skipped.includes(id)), errors },
      pass: rows === 210 && asks.length === 2 && JSON.stringify(asks.map((x) => x.length).sort((a, b) => a - b)) === '[1,200]' &&
        new Set(asked).size === 201 && NEED.every((id) => asked.includes(id)) && !asked.some((id) => skipped.includes(id)) && errors.length === 0,
    };
  });

  for (const w of [1440, 390]) {
    await scenario(`table-grouped@${w}`, ['E7-D04', 'S06'], async () => {
      const { ctx, p, errors } = await open(w, view('table', { 'projects.groupByCustomer': '1' }));
      await listPage(p, '?tab=all');
      // The count is read with the heading as TEXT (final review): a screen-reader-only phrase, not a label.
      const heads = await p.locator('h3').evaluateAll((hs) => hs.map((h) => ({ text: h.textContent.trim(), count: h.querySelector('.sr-only')?.textContent ?? null })));
      const tables = await p.locator('table').count();
      const bars = await p.locator('[data-pagination]').count();
      const overflow = await docOverflow(p);
      const file = await shoot(p, `table-grouped@${w}`);
      await ctx.close();
      const groups = heads.filter((h) => h.count && /на сторінці/.test(h.count));
      return {
        recipe: { url: '/projects?tab=all', storage: { 'projects.groupByCustomer': '1' } },
        measured: { heads: groups, tables, bars, overflow, errors },
        pass: groups.length >= 2 && tables === groups.length && bars === 1 && overflow <= 0 && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  // ======================= 5. list states (C05, R03) =======================
  await scenario('list-states@1440', ['E7-C05', 'R03'], async () => {
    const out = {};
    // (a) the first answer is slow: a table-shaped skeleton.
    {
      const { ctx, p } = await open(1440, { ...view('table'), delay: [[LIST, 3000]] });
      await p.goto(`${job.ui}/projects`);
      await p.getByTestId('orders-skeleton').waitFor({ timeout: 8000 }).catch(() => {});
      out.skeleton = (await p.getByTestId('orders-skeleton').count()) ? await p.getByTestId('orders-skeleton').getAttribute('data-shape') : null;
      await ctx.close();
    }
    // (b) every answer fails: an alert with a retry, never «no orders».
    {
      const { ctx, p } = await open(1440, { ...view('table'), fail: [[LIST, 500]] });
      await listPage(p, '?page=4');
      await p.waitForTimeout(1500);
      out.alert = (await p.getByRole('alert').count()) ? await textOf(p.getByRole('alert').first()) : null;
      out.empty = await p.getByText(/Немає активних замовлень|Нічого не знайдено/).count();
      out.url = new URL(p.url()).search;
      await ctx.close();
    }
    // (c) a new key fails after a good page: the old rows go, the URL stays, the retry asks the same key.
    {
      let failNew = true;
      const { ctx, p, requests } = await open(1440, { ...view('table'), gets: [[LIST, (url) => (/q=zzz/.test(url) && failNew ? { fail: 500 } : null)]] });
      await listPage(p);
      const rowsBefore = await p.locator('tbody tr').count();
      await p.getByRole('searchbox').fill('zzz');
      await within(p.waitForFunction(() => !!document.querySelector('[role="alert"]')), 8000, 'no_alert').catch(() => {});
      out.newKey = {
        rowsBefore,
        alert: await p.getByRole('alert').count(),
        rows: await p.locator('tbody tr').count(),
        url: new URL(p.url()).search,
      };
      failNew = false;
      const asked = requests.length;
      if (out.newKey.alert) await p.getByRole('alert').getByRole('button', { name: 'Спробувати знову' }).click();
      await p.waitForTimeout(1200);
      out.newKey.retried = requests.slice(asked).some((r) => /q=zzz/.test(r));
      await ctx.close();
    }
    // (d) a background re-read of the same key fails: the rows stay under a note.
    {
      let failing = false;
      const { ctx, p } = await open(1440, { ...view('table'), gets: [[LIST, () => (failing ? { fail: 500 } : null)]] });
      await p.clock.install();
      await listPage(p);
      failing = true;
      await refetchLater(p);
      await p.waitForTimeout(1500);
      out.refresh = { note: await p.getByText('Не вдалося оновити').count(), rows: await p.locator('tbody tr').count() };
      await ctx.close();
    }
    return {
      recipe: { url: '/projects', fixture: ['GET /projects/ slow (a)', '→ 500 always (b)', '→ 500 for q=zzz, then the stand (c)', '→ 500 after the first answer (d)'] },
      measured: out,
      pass: out.skeleton === 'table' && /Не вдалося завантажити замовлення/.test(out.alert ?? '') && out.empty === 0 && /page=4/.test(out.url) &&
        out.newKey.rowsBefore > 0 && out.newKey.alert === 1 && out.newKey.rows === 0 && /q=zzz/.test(out.newKey.url) && out.newKey.retried &&
        out.refresh.note >= 1 && out.refresh.rows > 0,
    };
  });

  await scenario('customer-states@1440', ['E7-C05', 'R03'], async () => {
    if (!CUSTOMER) return { pass: null, pending: 'the job names no customer' };
    const { ctx, p, errors } = await open(1440, { fail: [[LIST, 500]] });
    await p.goto(`${job.ui}/customers/${CUSTOMER}`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(1800);
    const alert = (await p.getByRole('alert').count()) ? await textOf(p.getByRole('alert').first()) : null;
    const empty = await p.getByText(/Немає активних замовлень/).count();
    await ctx.close();
    return {
      recipe: { url: '/customers/{customer:1}', fixture: ['GET /projects/?customer_id=… → 500'] },
      measured: { alert, empty, errors },
      pass: /Не вдалося завантажити замовлення/.test(alert ?? '') && empty === 0,
    };
  });

  // V05.3 (Codex r1): from a good page 1 (last_page 1) history goes to page 4, which fails. The URL
  // keeps page 4 — the previous answer's last page never clamps a page it is not about — and the
  // retry asks page 4 again.
  await scenario('list-page-fail@1440', ['E7-C05', 'R03', 'V05'], async () => {
    const { ctx, p, errors, requests } = await open(1440, { ...view('table'), gets: [[/\/api\/v1\/projects\/\?.*\bpage=4\b/, () => ({ fail: 500 })]] });
    await listPage(p);
    const goodRows = await p.locator('tbody tr[data-testid^="order-row-"]').count();
    const mark = requests.length;
    await p.evaluate(() => { history.pushState({}, '', '/projects?page=4'); dispatchEvent(new PopStateEvent('popstate')); });
    await p.waitForTimeout(3500);
    const lists = () => requests.slice(mark).filter((r) => /^GET \/api\/v1\/projects\/\?/.test(r));
    const failedAsks = lists().length;
    const alert = (await p.getByRole('alert').count()) ? await textOf(p.getByRole('alert').first()) : null;
    const urlAfter = new URL(p.url()).search;
    const rowsShown = await p.locator('tbody tr[data-testid^="order-row-"]').count();
    const file = await shoot(p, 'list-page-fail@1440');
    const retry = p.getByRole('alert').getByRole('button', { name: 'Спробувати знову' });
    if (await retry.count()) await retry.click();
    await p.waitForTimeout(2500);
    const all = lists();
    await ctx.close();
    return {
      recipe: { url: '/projects → history /projects?page=4', fixture: ['GET /projects/?…page=4 → 500 (runner)'], actions: ['history.pushState + popstate', '«Спробувати знову»'] },
      measured: { goodRows, failedAsks, alert, urlAfter, rowsShown, asks: all.length, errors },
      pass: goodRows > 0 && /Не вдалося завантажити замовлення/.test(alert ?? '') && urlAfter === '?page=4' && rowsShown === 0 &&
        all.length > failedAsks && all.every((r) => /\bpage=4\b/.test(r)) && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 6. cards (E) =======================
  const PARTS = ['rail', 'top', 'name', 'customer', 'coverage', 'meta', 'footer'];
  for (const w of [1920, 1440, 1024, 390]) {
    await scenario(`cards@${w}`, ['E7-E01', 'E7-E02', 'E7-E04', 'O06'], async () => {
      const { ctx, p, errors } = await open(w, view('cards'));
      await listPage(p);
      const card = p.getByTestId(`order-${A}-card`);
      const parts = await card.locator('[data-part]').evaluateAll((els) => els.map((el) => el.getAttribute('data-part')));
      const geometry = await p.evaluate(() => {
        const cards = [...document.querySelectorAll('[data-testid$="-card"]')].filter((c) => /^order-\d+-card$/.test(c.dataset.testid));
        const rects = cards.map((c) => c.getBoundingClientRect());
        const top = rects.length ? Math.min(...rects.map((r) => r.top)) : 0;
        const row = cards.filter((c, i) => Math.abs(rects[i].top - top) < 2);
        const footers = row.map((c) => Math.round(c.querySelector('[data-part="footer"]').getBoundingClientRect().bottom));
        return { perRow: row.length, width: rects.length ? Math.round(rects[0].width) : 0, footers };
      });
      const meta = await card.locator('[data-part="meta"] dt').allTextContents();
      const overflow = await docOverflow(p);
      const file = await shoot(p, `cards@${w}`);
      await ctx.close();
      const aligned = geometry.footers.every((b) => Math.abs(b - geometry.footers[0]) <= 1);
      return {
        recipe: { url: '/projects', storage: { 'projects.view': 'cards' } },
        env: { viewport: [w, HEIGHTS[w]] },
        measured: { parts, geometry, meta, overflow, errors },
        pass: PARTS.every((x, i) => parts[i] === x) && meta.join('|') === 'Дедлайн|Готово ≈|Друк / черга|Лишилось' &&
          (w <= 390 ? geometry.perRow === 1 : geometry.width >= 300) && aligned && overflow <= 0 && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('cards-thumbs@1440', ['E7-B06', 'O06'], async () => {
    const products = Array.from({ length: 5 }, (_, i) => ({ product_id: 900 + i, has_cover: false }));
    const { ctx, p, errors } = await open(1440, { ...view('cards'), rewrite: [[LIST, listWith({ [A]: (r) => ({ ...r, products }) })]] });
    await listPage(p);
    const strip = p.getByTestId(`order-${A}-thumbs`);
    const tiles = await strip.locator('[data-thumb]').count();
    const more = await strip.getByRole('img', { name: 'ще 2 вироби' }).count();
    const file = await shoot(p, 'cards-thumbs@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects', fixture: ['GET /projects/: 241 with five products (rewritten)'] },
      measured: { tiles, more, errors },
      pass: tiles === 3 && more === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  // E (final review): the card's overlay link lies over the whole card, so a tooltip in it — the
  // full forecast date, the reasons of an incomplete estimate — was never reached by the mouse.
  await scenario('cards-titles@1440', ['E7-B03', 'E7-E03'], async () => {
    const { ctx, p, errors } = await open(1440, view('cards'));
    await listPage(p);
    await p.getByTestId('order-actions').first().waitFor({ timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(600);
    const titles = await p.evaluate(() => [...document.querySelectorAll('[data-part="meta"] [title]')].filter((el) => el.getClientRects().length).map((el) => {
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { title: (el.getAttribute('title') ?? '').slice(0, 40), hits: !!hit && (hit === el || el.contains(hit)) };
    }));
    await ctx.close();
    return {
      recipe: { url: '/projects', storage: { 'projects.view': 'cards' }, actions: ['hit-test every [title] in a card\'s meta cells'] },
      measured: { total: titles.length, covered: titles.filter((x) => !x.hits), errors },
      pass: titles.length > 0 && titles.every((x) => x.hits) && errors.length === 0,
    };
  });

  // ======================= 7. kanban (F) =======================
  for (const w of [1920, 1440, 1024, 390]) {
    await scenario(`kanban@${w}`, ['E7-F01', 'E7-F02', 'E7-F03', 'O07', 'R08'], async () => {
      const board = await read('/projects/board');
      const { ctx, p, errors } = await open(w, view('kanban'));
      await listPage(p);
      const region = p.getByRole('region', { name: 'Канбан' });
      const geo = await region.evaluate((el) => ({
        sw: el.scrollWidth,
        cw: el.clientWidth,
        columns: [...el.querySelectorAll('[data-board-column]')].map((c) => ({ w: Math.round(c.getBoundingClientRect().width), oy: getComputedStyle(c).overflowY })),
      }));
      const totals = {};
      for (const key of ['prep', 'printing', 'qc', 'done']) totals[key] = (await textOf(p.getByTestId(`board-total-${key}`))).trim();
      const doneCards = await p.locator('[data-board-column="done"] [data-testid^="board-card-"]').count();
      // Every card's code is read whole, however wide its stage badge (a 240 px column).
      const cutCodes = await region.evaluate((el) => [...el.querySelectorAll('[data-part="top"] [data-code]')].filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.textContent));
      const card = p.getByTestId(`board-card-${A}`);
      const parts = (await card.count()) ? await card.locator('[data-part]').evaluateAll((els) => els.map((el) => el.getAttribute('data-part'))) : [];
      const hint = await textOf(p.getByTestId('orders-board-hint'));
      const overflow = await docOverflow(p);
      const file = await shoot(p, `kanban@${w}`);
      await ctx.close();
      const want = { prep: String(board.prep?.total), printing: String(board.printing?.total), qc: String(board.qc?.total), done: String(board.done?.total) };
      return {
        recipe: { url: '/projects', storage: { 'projects.view': 'kanban' } },
        env: { viewport: [w, HEIGHTS[w]] },
        measured: { geo, totals, want, doneCards, cutCodes, parts, hint, overflow, errors },
        pass: geo.columns.length === 4 && geo.columns.every((c) => c.w >= 240 && c.oy === 'visible') && (w > 1100 || geo.sw > geo.cw) &&
          JSON.stringify(totals) === JSON.stringify(want) && doneCards <= 6 && cutCodes.length === 0 &&
          ['rail', 'top', 'name', 'customer', 'coverage', 'line', 'footer'].every((x, i) => parts[i] === x) &&
          /Етап ставиться вручну/.test(hint) && overflow <= 0 && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('kanban-more@1440', ['E7-F02'], async () => {
    const { ctx, p, errors } = await open(1440, { ...view('kanban'), rewrite: [[/\/api\/v1\/projects\/board/, (b) => ({ ...b, printing: { ...b.printing, total: (b.printing?.items?.length ?? 0) + 55 }, done: { ...b.done, total: (b.done?.items?.length ?? 0) + 20 } })]] });
    await listPage(p);
    const printing = p.locator('[data-board-column="printing"]').getByRole('link', { name: /і ще \d+ — у списку/ });
    const printingHref = (await printing.count()) ? await printing.getAttribute('href') : null;
    const done = p.locator('[data-board-column="done"]').getByRole('link', { name: /…і ще \d+ виконаних — у списку/ });
    const doneText = (await done.count()) ? await textOf(done) : null;
    if (await done.count()) await done.click();
    await p.waitForTimeout(900);
    const landed = { url: new URL(p.url()).search, table: await p.locator('table').count() };
    await ctx.close();
    return {
      recipe: { url: '/projects', fixture: ['GET /projects/board: printing total +55, done total +20 (rewritten)'], actions: ['«…і ще N виконаних»'] },
      measured: { printingHref, doneText, landed, errors },
      pass: /tab=active/.test(printingHref ?? '') && /stage=printing/.test(printingHref ?? '') && !!doneText && /tab=completed/.test(landed.url) && landed.table === 1 && errors.length === 0,
    };
  });

  const stageTrigger = (p, code, stageName) => p.getByRole('button', { name: `Етап ${code}: ${stageName} — змінити` });
  const handleOf = (p, id, code) => p.getByTestId(`board-card-${id}`).getByRole('button', { name: `Перемістити ${code}` });
  const columnOf = (p, id) => p.getByTestId(`board-card-${id}`).evaluate((el) => el.closest('[data-board-column]')?.getAttribute('data-board-column') ?? null);
  // A pointer drag the way a person makes one: press, pass dnd-kit's 6 px threshold, travel, drop.
  const dragTo = async (p, handle, target) => {
    const a = await handle.boundingBox();
    await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await p.mouse.down();
    await p.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 4, { steps: 3 });
    const b = await target.boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + Math.min(80, b.height / 2), { steps: 12 });
    await p.waitForTimeout(200);
    await p.mouse.up();
  };
  await scenario('kanban-stage@1440', ['E7-F07', 'R04'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, { ...view('kanban'), writes: [recorder(writes, /\/stage$/)] });
    await listPage(p);
    const before = p.url();
    const trigger = stageTrigger(p, codeA, 'Друкується');
    if (!(await trigger.count())) {
      await ctx.close();
      return { pass: null, pending: `${codeA} is not «printing» on the stand` };
    }
    // Keyboard only: focus, Enter opens, the arrows move, Enter chooses.
    await trigger.focus();
    await p.keyboard.press('Enter');
    await p.getByRole('menu').waitFor({ timeout: 5000 });
    const radios = await p.getByRole('menuitemradio').evaluateAll((els) => els.map((el) => [el.textContent.trim(), el.getAttribute('aria-checked')]));
    const command = (await p.getByRole('menu').getByRole('menuitem').allTextContents()).map((x) => x.trim());
    for (let i = 0; i < 4; i += 1) {
      const name = await p.evaluate(() => document.activeElement?.textContent?.trim());
      if (name === 'Контроль якості') break;
      await p.keyboard.press('ArrowDown');
    }
    await p.keyboard.press('Enter');
    await p.waitForTimeout(900);
    const afterQc = writes.map((x) => x.body);
    // F07 (final review): through the write and the board's re-read the focus stays with the
    // card — on its stage — never falling to the page.
    const focusAfter = await p.evaluate((code) => {
      const a = document.activeElement;
      // The CARD — the trigger itself carries `board-card-<id>-stage`, so the walk wants the bare id.
      let card = a;
      while (card && !/^board-card-\d+$/.test(card.getAttribute?.('data-testid') ?? '')) card = card.parentElement;
      return { tag: a?.tagName ?? null, label: a?.getAttribute('aria-label') ?? null, inCard: !!card && card.textContent.includes(code) };
    }, codeA);
    // The current stage writes nothing (the board re-read answers the stand's own stage again).
    const again = stageTrigger(p, codeA, 'Друкується');
    if (await again.count()) {
      await again.click();
      await p.getByRole('menuitemradio', { name: 'Друкується' }).click();
      await p.waitForTimeout(600);
    }
    const stayed = p.url() === before;
    await ctx.close();
    return {
      recipe: { url: '/projects', storage: { 'projects.view': 'kanban' }, actions: ['stage badge → Enter', 'ArrowDown to «Контроль якості»', 'Enter', 'the current stage'] },
      measured: { radios, command, afterQc, focusAfter, total: writes.length, stayed, errors },
      pass: radios.map((r) => r[0]).join('|') === 'Підготовка|Друкується|Контроль якості' && radios[1][1] === 'true' &&
        command.includes('Готово — склад і видача…') && afterQc.length === 1 && afterQc[0]?.stage === 'qc' && writes.length === 1 && stayed &&
        focusAfter.inCard && /^Етап /.test(focusAfter.label ?? '') && errors.length === 0,
    };
  });

  await scenario('kanban-pending@1440', ['E7-F05', 'R04'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      ...view('kanban'),
      writes: [recorder(writes, /\/stage$/, async () => { await new Promise((r) => setTimeout(r, 3500)); return { __status: 409, json: { detail: 'Це замовлення не активне' } }; })],
    });
    await listPage(p);
    const trigger = stageTrigger(p, codeA, 'Друкується');
    if (!(await trigger.count())) {
      await ctx.close();
      return { pass: null, pending: `${codeA} is not «printing» on the stand` };
    }
    await trigger.click();
    await p.getByRole('menuitemradio', { name: 'Підготовка' }).click();
    await p.waitForTimeout(500);
    const card = p.getByTestId(`board-card-${A}`);
    // Held, the card keeps both doors (final review, F07): the stage trigger stays enabled and
    // keeps the focus, its rows are unavailable; the handle stays, inert.
    const focusHeld = await p.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
    const handle = card.getByRole('button', { name: `Перемістити ${codeA}` });
    const held = {
      busy: await card.getAttribute('aria-busy'),
      moving: (await card.getByText('Переносимо…').count()) > 0,
      disabled: await stageTrigger(p, codeA, 'Друкується').isDisabled(),
      handle: await handle.count(),
      handleInert: (await handle.count()) ? await handle.getAttribute('aria-disabled') : null,
      focus: focusHeld,
    };
    const file = await shoot(p, 'kanban-pending@1440');
    await stageTrigger(p, codeA, 'Друкується').click();
    held.rowsDisabled = await p.getByRole('menuitemradio', { name: 'Контроль якості' }).isDisabled();
    await p.keyboard.press('Escape');
    const refused = await toastText(p, /Це замовлення не активне/, 8000).then(() => true, () => false);
    await p.waitForTimeout(500);
    const after = {
      busy: await card.getAttribute('aria-busy'),
      inPrinting: await p.locator('[data-board-column="printing"]').getByTestId(`board-card-${A}`).count(),
    };
    await ctx.close();
    return {
      recipe: { url: '/projects', fixture: ['PUT …/stage → 409 after 3.5 s (runner)'], actions: ['stage badge → «Підготовка»'] },
      measured: { held, refused, after, writes: writes.length, errors },
      pass: held.busy === 'true' && held.moving && !held.disabled && held.handle === 1 && held.handleInert === 'true' && held.rowsDisabled &&
        /^Етап /.test(held.focus ?? '') && refused && after.busy === null && after.inPrinting === 1 && writes.length === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  // V05.1 (Codex r1): a pointer drop the server refuses — one write, the card back in its column,
  // held until the answer and free after it, the handle there to try again, focus with the card.
  await scenario('kanban-drop-409@1440', ['E7-F05', 'R04', 'V05'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      ...view('kanban'),
      writes: [recorder(writes, /\/stage$/, async () => { await new Promise((r) => setTimeout(r, 1500)); return { __status: 409, json: { detail: 'Це замовлення не активне' } }; })],
    });
    await listPage(p);
    const handle = handleOf(p, A, codeA);
    if (!(await handle.count())) {
      await ctx.close();
      return { pass: null, pending: `${codeA} has no drag handle on the stand` };
    }
    const from = await columnOf(p, A);
    await dragTo(p, handle, p.locator('[data-board-column="qc"]'));
    await p.waitForTimeout(300);
    const held = await p.getByTestId(`board-card-${A}`).getAttribute('aria-busy');
    const refused = await toastText(p, /Це замовлення не активне/, 8000).then(() => true, () => false);
    await p.waitForTimeout(600);
    const after = {
      column: await columnOf(p, A),
      busy: await p.getByTestId(`board-card-${A}`).getAttribute('aria-busy'),
      inert: await handleOf(p, A, codeA).getAttribute('aria-disabled'),
      focusInCard: await p.evaluate((a) => !!document.activeElement?.closest(`[data-testid="board-card-${a}"]`), A),
    };
    const file = await shoot(p, 'kanban-drop-409@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects', storage: { 'projects.view': 'kanban' }, fixture: ['PUT …/stage → 409 after 1.5 s (runner)'], actions: [`drag ${codeA} by its handle into «Контроль якості»`] },
      measured: { from, writes: writes.map((x) => x.body), held, refused, after, errors },
      pass: from === 'printing' && writes.length === 1 && writes[0].body?.stage === 'qc' && held === 'true' && refused &&
        after.column === from && after.busy === null && after.inert !== 'true' && after.focusInCard && errors.length === 0,
      screenshots: [file],
    };
  });

  // V05.1: the keyboard's drag — Space, an arrow, Space — writes once and keeps the focus on the handle.
  await scenario('kanban-keyboard@1440', ['E7-F07', 'R04', 'V05'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, { ...view('kanban'), writes: [recorder(writes, /\/stage$/)] });
    await listPage(p);
    const handle = handleOf(p, A, codeA);
    if (!(await handle.count())) {
      await ctx.close();
      return { pass: null, pending: `${codeA} has no drag handle on the stand` };
    }
    await handle.focus();
    await p.keyboard.press('Space');
    await p.waitForTimeout(200);
    await p.keyboard.press('ArrowRight');
    await p.waitForTimeout(200);
    await p.keyboard.press('Space');
    await p.waitForTimeout(1200);
    const focus = await p.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? null);
    await ctx.close();
    return {
      recipe: { url: '/projects', storage: { 'projects.view': 'kanban' }, actions: [`focus ${codeA}'s handle`, 'Space', 'ArrowRight', 'Space'] },
      measured: { writes: writes.map((x) => x.body), focus, errors },
      pass: writes.length === 1 && writes[0].body?.stage === 'qc' && focus === `Перемістити ${codeA}` && errors.length === 0,
    };
  });

  await scenario('kanban-done@1440', ['E7-F07', 'E6-B04'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, { ...view('kanban'), writes: [recorder(writes, /\/projects\/\d+(\/stage)?$/)] });
    await listPage(p);
    const trigger = stageTrigger(p, codeA, 'Друкується');
    if (!(await trigger.count())) {
      await ctx.close();
      return { pass: null, pending: `${codeA} is not «printing» on the stand` };
    }
    await trigger.click();
    await p.getByRole('menuitem', { name: 'Готово — склад і видача…' }).click();
    const dlg = p.locator('[role="dialog"]').last();
    await dlg.waitFor({ timeout: 10000 });
    await p.waitForTimeout(800);
    const title = await dlg.evaluate((d) => d.querySelector('h2, h3')?.textContent?.trim() ?? null);
    await dlg.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await within(p.waitForFunction(() => !document.querySelector('[role="dialog"]')), 8000, 'dialog_stayed').catch(() => {});
    const closed = (await p.locator('[role="dialog"]').count()) === 0;
    await ctx.close();
    return {
      recipe: { url: '/projects', actions: ['stage badge → «Готово — склад і видача…»', '«Скасувати»'] },
      measured: { title, closed, writes, errors },
      pass: title === 'Склад і видача' && closed && writes.length === 0 && errors.length === 0,
    };
  });

  // V05.1: a drop into «Done» on a board wider than the screen — the board scrolls itself while the
  // card is held at its edge, the column is reached, and the drop opens Stock & issue once, writing nothing.
  await scenario('kanban-drop-done@768', ['E7-F01', 'E7-F07', 'E6-B04', 'R08', 'V05'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(768, { ...view('kanban'), writes: [recorder(writes, /\/projects\/\d+(\/stage)?$/)] });
    await listPage(p);
    const handle = handleOf(p, A, codeA);
    if (!(await handle.count())) {
      await ctx.close();
      return { pass: null, pending: `${codeA} has no drag handle on the stand` };
    }
    const region = p.getByRole('region', { name: 'Канбан' });
    await handle.scrollIntoViewIfNeeded();
    const before = await region.evaluate((el) => ({ left: el.scrollLeft, max: el.scrollWidth - el.clientWidth }));
    const rb = await region.boundingBox();
    const offscreen = (await p.locator('[data-board-column="done"]').boundingBox()).x > rb.x + rb.width - 1;
    const hb = await handle.boundingBox();
    await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await p.mouse.down();
    await p.mouse.move(hb.x + hb.width / 2 + 12, hb.y + hb.height / 2 + 4, { steps: 3 });
    // To the board's right edge, and held there: the board scrolls itself toward «Done».
    await p.mouse.move(rb.x + rb.width - 6, hb.y + hb.height / 2 + 4, { steps: 10 });
    await p.waitForTimeout(2000);
    const scrolled = await region.evaluate((el) => el.scrollLeft);
    const db = await p.locator('[data-board-column="done"]').boundingBox();
    await p.mouse.move(Math.min(db.x + db.width / 2, rb.x + rb.width - 20), db.y + 60, { steps: 8 });
    await p.waitForTimeout(250);
    await p.mouse.up();
    const dlg = p.locator('[role="dialog"]').last();
    const opened = await dlg.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await p.waitForTimeout(600);
    const title = opened ? await dlg.evaluate((d) => d.querySelector('h2, h3')?.textContent?.trim() ?? null) : null;
    const dialogs = await p.locator('[role="dialog"]').count();
    const file = await shoot(p, 'kanban-drop-done@768');
    if (opened) await dlg.getByRole('button', { name: 'Скасувати', exact: true }).click().catch(() => {});
    await ctx.close();
    return {
      recipe: { url: '/projects', storage: { 'projects.view': 'kanban' }, actions: [`drag ${codeA} to the board's right edge, hold 2 s, drop on «Готово»`, '«Скасувати»'] },
      env: { viewport: [768, HEIGHTS[768]] },
      measured: { before, offscreen, scrolled, title, dialogs, writes, errors },
      pass: before.max > 0 && offscreen && scrolled > before.left && title === 'Склад і видача' && dialogs === 1 && writes.length === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('kanban-reader@1440', ['E7-F04', 'E7-F06', 'E7-F07'], async () => {
    const { ctx, p, errors } = await open(1440, { ...view('kanban'), me: READER });
    await listPage(p);
    const card = p.getByTestId(`board-card-${A}`);
    const out = {
      handle: await card.getByRole('button', { name: /^Перемістити / }).count(),
      stage: await card.getByRole('button', { name: /^Етап / }).count(),
      menu: await card.getByRole('button', { name: /^Дії замовлення/ }).count(),
      hint: await textOf(p.getByTestId('orders-board-hint')),
      empty: await p.getByText('Перетягніть сюди').count(),
    };
    await ctx.close();
    return {
      recipe: { url: '/projects', fixture: ['GET /auth/me: a reader (projects:read only)'] },
      measured: { ...out, errors },
      pass: out.handle === 0 && out.stage === 0 && out.menu === 0 && out.hint === 'Етап ставиться вручну.' && out.empty === 0 && errors.length === 0,
    };
  });

  // ======================= 8. workspace (G) =======================
  for (const w of [2560, 1920, 1440, 1024, 768, 761, 760, 390]) {
    await scenario(`workspace@${w}`, ['E7-G01', 'E7-G03', 'E7-G04', 'E7-G06', 'O08'], async () => {
      const { ctx, p, errors } = await open(w, view('workspace'));
      await listPage(p);
      await p.getByTestId('order-actions').first().waitFor({ timeout: 15000 }).catch(() => {});
      await p.waitForTimeout(800);
      const geo = await p.evaluate(() => {
        const list = document.querySelector('[data-testid="workspace-list"]');
        const pane = list?.parentElement?.children[1]?.querySelector('h2') ?? null;
        const l = list?.getBoundingClientRect();
        const r = pane?.getBoundingClientRect();
        return {
          list: l ? { left: Math.round(l.left), top: Math.round(l.top), width: Math.round(l.width), bottom: Math.round(l.bottom) } : null,
          pane: r ? { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), clipped: pane.scrollWidth > pane.clientWidth + 1 } : null,
          vw: innerWidth,
          rowsAreButtons: [...(list?.querySelectorAll('li > *') ?? [])].every((el) => el.tagName === 'BUTTON'),
          // The row's first line — code · deadline — read whole, its stage badge on ONE line.
          cutRows: [...(list?.querySelectorAll('li > button') ?? [])].filter((b) => {
            const head = b.firstElementChild;
            const lead = head?.firstElementChild;
            const badge = head?.lastElementChild;
            return (lead && lead.scrollWidth > lead.clientWidth + 1) || (badge && badge.getBoundingClientRect().height > 26);
          }).length,
        };
      });
      const actions = await hitTest(p, '[data-testid="order-actions"] button');
      const overflow = await docOverflow(p);
      const file = await shoot(p, `workspace@${w}`);
      await ctx.close();
      const split = w >= 761;
      const want = Math.min(400, Math.max(280, 0.2 * geo.vw));
      return {
        recipe: { url: '/projects', storage: { 'projects.view': 'workspace' } },
        env: { viewport: [w, HEIGHTS[w]] },
        measured: { geo, want: Math.round(want), actions: actions.filter((a) => !a.inView || !a.hits), overflow, errors },
        pass: !!geo.list && !!geo.pane && geo.rowsAreButtons && geo.cutRows === 0 &&
          (split ? Math.abs(geo.list.width - want) <= 3 && geo.pane.left > geo.list.left + geo.list.width - 1 : geo.pane.top > geo.list.bottom - 1) &&
          !geo.pane.clipped && actions.length > 0 && actions.every((a) => a.inView && a.hits) && overflow <= 0 && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('workspace-sticky@1440', ['E7-G02'], async () => {
    const { ctx, p, errors } = await open(1440, view('workspace'));
    await listPage(p);
    await p.getByTestId('order-actions').first().waitFor({ timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(800);
    // Whoever scrolls the page — the window or the app's main — is scrolled by 700 px.
    const scrolled = await p.evaluate(async () => {
      const main = document.querySelector('main');
      const before = { win: scrollY, main: main?.scrollTop ?? 0 };
      if (document.documentElement.scrollHeight > innerHeight + 10) window.scrollBy(0, 700);
      if (main && main.scrollHeight > main.clientHeight + 10) main.scrollTop += 700;
      await new Promise((r) => setTimeout(r, 400));
      return { scroller: scrollY !== before.win ? 'window' : (main?.scrollTop ?? 0) !== before.main ? 'main' : 'none', win: scrollY, main: main?.scrollTop ?? 0 };
    });
    const geo = await p.evaluate(() => {
      const list = document.querySelector('[data-testid="workspace-list"]').getBoundingClientRect();
      const bar = document.querySelector('[data-testid="workspace-pager"]').getBoundingClientRect();
      return { listTop: Math.round(list.top), barBottom: Math.round(bar.bottom), barTop: Math.round(bar.top), vh: innerHeight };
    });
    const file = await shoot(p, 'workspace-sticky@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects', storage: { 'projects.view': 'workspace' }, actions: ['scroll the page by 700 px'] },
      measured: { scrolled, geo, errors },
      pass: scrolled.scroller !== 'none' && Math.abs(geo.listTop - 12) <= 3 && geo.barBottom <= geo.vh && geo.barTop > 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('workspace-fallback@1440', ['E7-G05'], async () => {
    const { ctx, p, errors } = await open(1440, view('workspace'));
    await listPage(p, `?order=${DONE}`);
    await p.waitForTimeout(1200);
    const note = p.getByTestId('workspace-fallback');
    const text = (await note.count()) ? await textOf(note) : null;
    const link = (await note.count()) ? await note.getByRole('link').getAttribute('href') : null;
    const role = (await note.count()) ? await note.getAttribute('role') : null;
    const file = await shoot(p, 'workspace-fallback@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects?order={order:245}', note: 'the completed order is not on the «active» page' },
      measured: { text, link, role, errors },
      pass: /^Вибраного замовлення немає на цій сторінці — показано OR-\d+/.test(text ?? '') && link === `/projects/${DONE}` && role === 'status' && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('workspace-states@1440', ['E7-G07', 'R03'], async () => {
    const { ctx, p, errors, requests } = await open(1440, { ...view('workspace'), fail: [[LIST, 500]] });
    await listPage(p);
    await p.waitForTimeout(1500);
    const alert = (await p.getByRole('alert').count()) ? await textOf(p.getByRole('alert').first()) : null;
    const list = await p.getByTestId('workspace-list').count();
    const detailAsked = requests.some((r) => /^GET \/api\/v1\/projects\/\d+(\?|$)/.test(r));
    await ctx.close();
    return {
      recipe: { url: '/projects', fixture: ['GET /projects/ → 500'] },
      measured: { alert, list, detailAsked, errors },
      pass: /Не вдалося завантажити замовлення/.test(alert ?? '') && list === 0 && !detailAsked,
    };
  });

  // G06 (final review): stacked, a pick scrolls to the order — below the fixed compact header, not under it.
  await scenario('workspace-pick@390', ['E7-G06'], async () => {
    const { ctx, p, errors } = await open(390, view('workspace'));
    await listPage(p);
    await p.getByTestId('order-actions').first().waitFor({ timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(600);
    const rows = p.getByTestId('workspace-list').locator('li > button');
    const n = await rows.count();
    // Room below the page, so the pick CAN bring the order to the top: a short order cannot be
    // scrolled up to the header, and the probe would measure the document's end instead.
    await p.evaluate(() => { document.body.style.paddingBottom = '3000px'; });
    if (n > 2) await rows.nth(2).click();
    await p.waitForTimeout(1500);
    const geo = await p.evaluate(() => {
      const header = document.querySelector('header.fixed');
      const list = document.querySelector('[data-testid="workspace-list"]');
      const pane = list?.parentElement?.children[1] ?? null;
      return {
        headerBottom: header ? Math.round(header.getBoundingClientRect().bottom) : 0,
        paneTop: pane ? Math.round(pane.getBoundingClientRect().top) : null,
        scrolled: Math.round(scrollY),
      };
    });
    const file = await shoot(p, 'workspace-pick@390');
    await ctx.close();
    return {
      recipe: { url: '/projects', storage: { 'projects.view': 'workspace' }, actions: ['click the third row'] },
      env: { viewport: [390, HEIGHTS[390]] },
      measured: { rows: n, geo, errors },
      pass: n > 2 && geo.scrolled > 0 && geo.paneTop !== null && geo.paneTop >= geo.headerBottom - 1 && geo.paneTop <= geo.headerBottom + 40 && errors.length === 0,
      screenshots: [file],
    };
  });

  // G02 (final review): a long list — the keyboard reaches its last row, and the page bar is never over it.
  await scenario('workspace-focus@1440', ['E7-G02'], async () => {
    const { ctx, p, errors } = await open(1440, view('workspace', { 'projects.perPage': '50' }));
    await listPage(p, '?tab=all');
    await p.getByTestId('order-actions').first().waitFor({ timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(800);
    const rows = p.getByTestId('workspace-list').locator('li > button');
    const n = await rows.count();
    if (n > 1) {
      await rows.nth(n - 2).focus();
      await p.keyboard.press('Tab');
    }
    await p.waitForTimeout(500);
    const geo = await p.evaluate(() => {
      const a = document.activeElement;
      const row = a?.getBoundingClientRect();
      const bar = document.querySelector('[data-testid="workspace-pager"]')?.getBoundingClientRect();
      return row && bar
        ? { isRow: !!a.closest('[data-testid="workspace-list"] li'), rowTop: Math.round(row.top), rowBottom: Math.round(row.bottom), barTop: Math.round(bar.top), vh: innerHeight }
        : null;
    });
    const file = await shoot(p, 'workspace-focus@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects?tab=all', storage: { 'projects.view': 'workspace', 'projects.perPage': '50' }, actions: ['focus the row before the last', 'Tab'] },
      measured: { rows: n, geo, errors },
      pass: n > 20 && !!geo && geo.isRow && geo.rowTop >= 0 && geo.rowBottom <= geo.barTop + 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  const paneTitle = (p) => p.evaluate(() => document.querySelector('[data-testid="workspace-list"]')?.parentElement?.children[1]?.querySelector('h2')?.textContent?.trim() ?? null);

  // V05.2 (Codex r1): deleting the order the workspace shows, from the pane's own menu. The action
  // host outlives the row; the URL forgets the order, the pane moves to an order of the page, no
  // «not on this page» note and no error.
  await scenario('workspace-delete@1440', ['E7-G05', 'E6-B08', 'V05'], async () => {
    let deleted = false;
    const sent = [];
    const { ctx, p, errors } = await open(1440, {
      ...view('workspace'),
      rewrite: [[LIST, (b) => (deleted && b && Array.isArray(b.items) ? { ...b, items: b.items.filter((o) => o.id !== A), meta: { ...b.meta, total: Math.max(0, b.meta.total - 1) } } : b)]],
      gets: [[new RegExp(`/api/v1/projects/${A}(\\?|$)`), () => (deleted ? { fail: 404 } : null)]],
      writes: [[new RegExp(`/api/v1/projects/${A}$`), (req) => { sent.push(req.method()); deleted = true; return {}; }]],
    });
    await listPage(p, `?order=${A}`);
    await p.getByTestId('order-actions').first().waitFor({ timeout: 15000 });
    await p.waitForTimeout(600);
    const before = await paneTitle(p);
    await p.getByTestId('order-actions').getByRole('button', { name: /^Дії замовлення/ }).first().click();
    await p.getByRole('menu').waitFor({ timeout: 5000 });
    await p.getByRole('menu').getByRole('menuitem', { name: 'Видалити', exact: true }).click();
    const dlg = p.locator('[role="dialog"]').last();
    await dlg.waitFor({ timeout: 5000 });
    const title = await dlg.evaluate((d) => d.querySelector('h2, h3')?.textContent?.trim() ?? null);
    await dlg.locator('[data-workshop-dialog-footer]').getByRole('button', { name: 'Видалити', exact: true }).click();
    await within(p.waitForFunction(() => !document.querySelector('[role="dialog"]')), 8000, 'dialog_stayed').catch(() => {});
    await p.waitForTimeout(1800);
    const after = {
      search: new URL(p.url()).search,
      pane: await paneTitle(p),
      fallback: await p.getByTestId('workspace-fallback').count(),
      alerts: await p.getByRole('alert').allTextContents(),
      rowGone: (await p.getByTestId('workspace-list').getByRole('button', { name: new RegExp(codeA) }).count()) === 0,
    };
    const file = await shoot(p, 'workspace-delete@1440');
    await ctx.close();
    return {
      recipe: { url: `/projects?order={order:241}`, storage: { 'projects.view': 'workspace' }, fixture: ['DELETE /projects/{241} answered by the runner; afterwards the list without it and its detail 404'], actions: ['pane menu «Видалити»', '«Видалити»'] },
      measured: { before, title, sent, after, errors },
      pass: before === orderA.name && title === 'Видалити замовлення?' && sent.length === 1 && sent[0] === 'DELETE' && !new RegExp(`order=${A}\\b`).test(after.search) &&
        !!after.pane && after.pane !== orderA.name && after.fallback === 0 && after.alerts.length === 0 && after.rowGone && errors.length === 0,
      screenshots: [file],
    };
  });

  // V02 (Codex r1): history moves the workspace to a page still being read. The detail shown stays
  // (none of the stand-in rows opens), the URL is left as history set it; the answer then decides;
  // Back and Forward return each page with its own order.
  await scenario('workspace-history@1440', ['E7-G04', 'E7-G05', 'R03', 'V02'], async () => {
    let completedAsks = 0;
    const { ctx, p, errors, requests } = await open(1440, {
      ...view('workspace'),
      gets: [[/\/api\/v1\/projects\/\?.*status=completed/, () => { completedAsks += 1; return completedAsks === 1 ? { delay: 3000 } : null; }]],
    });
    await listPage(p);
    const rows = p.getByTestId('workspace-list').locator('li > button');
    await rows.nth(1).click();
    await p.waitForTimeout(1500);
    const shownA = await paneTitle(p);
    const searchA = new URL(p.url()).search;
    const done = await read(`/projects/${DONE}`);
    // Searched by its code, so the order IS on the page history goes to (a page without it is G05's case).
    const target = `?tab=completed&q=${encodeURIComponent(done.code)}&order=${DONE}`;
    const mark = requests.length;
    await p.evaluate((search) => { history.pushState({}, '', `/projects${search}`); dispatchEvent(new PopStateEvent('popstate')); }, target);
    const during = [];
    for (let i = 0; i < 4; i += 1) {
      await p.waitForTimeout(500);
      during.push(await paneTitle(p));
    }
    const detailsAsked = requests.slice(mark).filter((r) => /^GET \/api\/v1\/projects\/\d+$/.test(r));
    const searchDuring = new URL(p.url()).search;
    await p.waitForTimeout(2500);
    const shownB = await paneTitle(p);
    await p.goBack();
    await p.waitForTimeout(1500);
    const back = { pane: await paneTitle(p), search: new URL(p.url()).search };
    await p.goForward();
    await p.waitForTimeout(1500);
    const forward = { pane: await paneTitle(p), search: new URL(p.url()).search };
    await ctx.close();
    return {
      recipe: { url: '/projects (second row picked) → history /projects?tab=completed&q={code of 245}&order={order:245}', storage: { 'projects.view': 'workspace' }, fixture: ['GET /projects/?…status=completed: the first answer held 3 s (runner)'], actions: ['click the second row', 'history.pushState + popstate', 'Back', 'Forward'] },
      measured: { shownA, searchA, target, during, detailsAsked, searchDuring, shownB, doneName: done.name, back, forward, errors },
      pass: !!shownA && during.every((x) => x === shownA) && detailsAsked.length === 0 && new URLSearchParams(searchDuring).get('order') === String(DONE) &&
        shownB === done.name && back.pane === shownA && back.search === searchA && forward.pane === done.name && errors.length === 0,
    };
  });

  // V01 (Codex r1): rows, then an empty answer, then a re-read that fails — the empty explanation
  // stays and the failure is said with its retry; the retry's answer takes the note away.
  await scenario('workspace-empty-refresh@1440', ['E7-C05', 'E7-G07', 'R03', 'V01'], async () => {
    let calls = 0;
    const emptied = (b) => ({ ...b, items: [], meta: { ...b.meta, total: 0, last_page: 1, current_page: 1 } });
    const { ctx, p, errors } = await open(1440, {
      ...view('workspace'),
      gets: [[LIST, () => { calls += 1; if (calls === 1) return null; if (calls === 2) return { rewrite: emptied }; if (calls <= 4) return { fail: 500 }; return { rewrite: emptied }; }]],
    });
    await p.clock.install();
    await listPage(p);
    const state = () => p.evaluate(() => ({
      rows: document.querySelectorAll('[data-testid="workspace-list"] li').length,
      empty: /Немає активних замовлень/.test(document.querySelector('main')?.textContent ?? ''),
      stale: /Не вдалося оновити/.test(document.querySelector('main')?.textContent ?? ''),
    }));
    const first = await state();
    await refetchLater(p);
    const empty = await state();
    await refetchLater(p);
    await p.waitForTimeout(1500);
    const failed = await state();
    const file = await shoot(p, 'workspace-empty-refresh@1440');
    const retry = p.locator('main').getByRole('button', { name: 'Спробувати знову' });
    const offered = (await retry.count()) > 0;
    if (offered) await retry.first().click();
    await p.waitForTimeout(1500);
    const retried = await state();
    await ctx.close();
    return {
      recipe: { url: '/projects', storage: { 'projects.view': 'workspace' }, fixture: ['GET /projects/: 1st real, 2nd empty (rewritten), 3rd+4th → 500, 5th empty'], actions: ['re-read ×2 (clock +90 s, visibilitychange)', '«Спробувати знову»'] },
      measured: { calls, first, empty, failed, offered, retried, errors },
      pass: first.rows > 0 && empty.empty && !empty.stale && failed.empty && failed.stale && offered && retried.empty && !retried.stale && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 9. deadlines (H) =======================
  for (const w of [1920, 1440, 1024, 390]) {
    await scenario(`deadlines@${w}`, ['E7-H04', 'E7-H05', 'E7-H06', 'E7-H07', 'O09'], async () => {
      const { ctx, p, errors } = await open(w, view('deadlines'));
      await listPage(p);
      const region = p.getByRole('region', { name: 'Календар термінів' });
      const geo = await region.evaluate((el) => ({
        sw: el.scrollWidth,
        cw: el.clientWidth,
        rows: [...el.querySelectorAll('[data-week-row]')].map((r) => r.querySelectorAll('[data-testid^="deadline-day-"]').length),
        widths: [...el.querySelectorAll('[data-testid^="deadline-day-"]')].slice(0, 7).map((d) => Math.round(d.getBoundingClientRect().width)),
        heights: [...el.querySelectorAll('[data-testid^="deadline-day-"]')].map((d) => Math.round(d.getBoundingClientRect().height)),
      }));
      const legend = await textOf(p.getByTestId('deadlines-legend'));
      const range = await textOf(p.getByTestId('deadlines-range'));
      const today = await p.locator('[aria-current="date"]').count();
      const overflow = await docOverflow(p);
      const sticking = overflow > 0 ? await offenders(p) : [];
      const widths = overflow > 0 ? await p.evaluate(() => {
        const box = (el) => el && { sw: el.scrollWidth, cw: el.clientWidth, w: Math.round(el.getBoundingClientRect().width) };
        const cal = document.querySelector('[aria-label="Календар термінів"]');
        const right = [...document.querySelectorAll('body *')].filter((el) => el.getClientRects().length && !(cal && cal.contains(el)))
          .map((el) => [Math.round(el.getBoundingClientRect().right), `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 4).join('.')}`])
          .sort((a, b) => b[0] - a[0]).slice(0, 8);
        return { html: box(document.documentElement), body: box(document.body), main: box(document.querySelector('main')), right };
      }) : null;
      const file = await shoot(p, `deadlines@${w}`, { fullPage: w <= 390 });
      await ctx.close();
      return {
        recipe: { url: '/projects', storage: { 'projects.view': 'deadlines' } },
        env: { viewport: [w, HEIGHTS[w]] },
        measured: { geo: { ...geo, heights: Math.min(...geo.heights) }, legend, range, today, overflow, sticking, widths, errors },
        pass: geo.rows.join(',') === '7,7' && geo.widths.every((x) => x >= 140) && Math.min(...geo.heights) >= 180 && (w > 760 || geo.sw > geo.cw) &&
          /Картка — дедлайн;/.test(legend) && /червона рамка — прогноз пізніший за дедлайн/.test(legend) && / — /.test(range) && today === 1 && overflow <= 0 && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('deadlines-risk@1440', ['E7-H01', 'E7-H06', 'R01'], async () => {
    let ids = [];
    const { ctx, p, errors } = await open(1440, {
      ...view('deadlines'),
      rewrite: [[/\/api\/v1\/projects\/deadlines/, (b) => {
        const due = (b.due ?? []).filter((d) => d.order.status === 'active').slice(0, 3);
        ids = due.map((d) => d.order.id);
        const dayOf = (d, shift) => { const t = new Date(`${d.order.due_date.slice(0, 10)}T09:00:00Z`); t.setUTCDate(t.getUTCDate() + shift); return t.toISOString().replace(/\.\d+Z$/, ''); };
        const changed = due.map((d, i) =>
          i === 0 ? { ...d, eta: dayOf(d, 2), late: false, estimate_reasons: [] } // after the deadline, the server says on time
            : i === 1 ? { ...d, eta: dayOf(d, -2), late: true, estimate_reasons: [] } // before it, the server says late
              : { ...d, eta: null, late: false, estimate_reasons: [{ code: 'no_plate', count: 2 }] });
        return { ...b, due: [...changed, ...(b.due ?? []).filter((d) => !ids.includes(d.order.id))] };
      }]],
    });
    await listPage(p);
    await p.waitForTimeout(800);
    if (ids.length < 3) {
      await ctx.close();
      return { pass: null, pending: 'the window holds fewer than three active deadlines' };
    }
    const card = (id) => p.locator(`a[href="/projects/${id}"]`).filter({ has: p.getByTestId(`deadline-eta-${id}`) }).first();
    const risk = [];
    for (const id of ids) risk.push((await card(id).count()) ? await card(id).getAttribute('data-risk') : 'missing');
    const partial = (await card(ids[2]).count()) ? await textOf(p.getByTestId(`deadline-eta-${ids[2]}`)) : null;
    const file = await shoot(p, 'deadlines-risk@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects', fixture: ['GET /projects/deadlines: three active cards rewritten — after-but-on-time, before-but-late, partial without a date'] },
      measured: { ids, risk, partial, errors },
      pass: risk[0] === null && risk[1] === 'true' && risk[2] === null && /неповна оцінка/.test(partial ?? '') && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('deadlines-attention@1440', ['E7-H02', 'E7-H08'], async () => {
    const pick = (b) => [...(b.due ?? []).map((d) => d.order), ...(b.attention ?? []).map((a) => a.order)].filter((o, i, all) => all.findIndex((x) => x.id === o.id) === i);
    const { ctx, p, errors } = await open(1440, {
      ...view('deadlines'),
      rewrite: [[/\/api\/v1\/projects\/deadlines/, (b) => {
        const os = pick(b);
        const reasons = ['overdue', 'late_eta', 'partial', 'no_due'];
        return { ...b, attention: os.slice(0, 4).map((o, i) => ({ order: o, reason: reasons[i], eta: reasons[i] === 'late_eta' ? new Date(Date.now() + 5 * 864e5).toISOString().replace(/\.\d+Z$/, '') : null, estimate_reasons: reasons[i] === 'partial' ? [{ code: 'needs_slicing', count: 1 }] : [] })) };
      }]],
    });
    await listPage(p);
    const rows = await p.getByRole('list', { name: 'Потребує уваги' }).getByRole('listitem').allTextContents();
    const file = await shoot(p, 'deadlines-attention@1440', { fullPage: true });
    await ctx.close();
    const empty = await open(1440, { ...view('deadlines'), rewrite: [[/\/api\/v1\/projects\/deadlines/, (b) => ({ ...b, attention: [] })]] });
    await listPage(empty.p);
    const noRisks = (await empty.p.getByText('Ризиків немає').count()) > 0 && (await empty.p.getByText('Усі активні замовлення встигають до дедлайну.').count()) > 0;
    await empty.ctx.close();
    return {
      recipe: { url: '/projects', fixture: ['GET /projects/deadlines: attention with the four reasons (rewritten)', 'then attention []'] },
      measured: { rows: rows.map((r) => r.replace(/\s+/g, ' ').trim()), noRisks, errors },
      pass: rows.length === 4 && /прострочено/.test(rows[0]) && /готово ≈ .+ при дедлайні /.test(rows[1]) && /неповна оцінка · дедлайн /.test(rows[2]) &&
        /без дедлайну/.test(rows[3]) && noRisks && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('deadlines-error@1440', ['E7-H09', 'E7-C05'], async () => {
    let failing = true;
    const { ctx, p } = await open(1440, { ...view('deadlines'), gets: [[/\/api\/v1\/projects\/deadlines/, () => (failing ? { fail: 500 } : null)]] });
    await listPage(p);
    await p.waitForTimeout(1500);
    const alert = (await p.getByRole('alert').count()) ? await textOf(p.getByRole('alert').first()) : null;
    failing = false;
    if (alert) await p.getByRole('alert').getByRole('button', { name: 'Спробувати знову' }).click();
    await p.waitForTimeout(1500);
    const back = await p.getByRole('heading', { name: 'Потребує уваги' }).count();
    await ctx.close();
    return {
      recipe: { url: '/projects', fixture: ['GET /projects/deadlines → 500 (twice), then the stand'] },
      measured: { alert, back },
      pass: /Не вдалося завантажити терміни/.test(alert ?? '') && back === 1,
    };
  });

  // ======================= 10. hit tests at 390, themes =======================
  await scenario('hits@390', ['E7-C04', 'E7-B07', 'E7-F07', 'E7-G06', 'E7-H04'], async () => {
    const all = [];
    const counts = {};
    {
      const { ctx, p } = await open(390, view('table'));
      await listPage(p, '?q=%D0%BA');
      counts.table = {
        toggle: (await hitTest(p, '[data-testid="list-page-header"] [aria-pressed]')),
        filters: (await hitTest(p, 'select, input[type="search"]')),
        reset: (await hitTest(p, 'button')).filter((h) => h.what === 'Скинути'),
        menu: (await hitTest(p, 'button[aria-label^="Дії замовлення"]')).slice(0, 3),
      };
      await ctx.close();
    }
    {
      const { ctx, p } = await open(390, view('cards'));
      await listPage(p);
      counts.cards = (await hitTest(p, 'button[aria-label^="Дії замовлення"]')).slice(0, 2);
      await ctx.close();
    }
    {
      const { ctx, p } = await open(390, view('kanban'));
      await listPage(p);
      counts.kanban = [...(await hitTest(p, 'button[aria-label^="Етап "]')).slice(0, 2), ...(await hitTest(p, 'button[aria-label^="Перемістити "]')).slice(0, 2)];
      await ctx.close();
    }
    {
      const { ctx, p } = await open(390, view('workspace'));
      await listPage(p);
      counts.workspace = (await hitTest(p, '[data-testid="workspace-list"] li > button')).slice(0, 3);
      await ctx.close();
    }
    {
      const { ctx, p } = await open(390, view('deadlines'));
      await listPage(p);
      counts.deadlines = await hitTest(p, 'button[aria-label="Назад"], button[aria-label="Вперед"]');
      await ctx.close();
    }
    for (const v of Object.values(counts)) all.push(...(Array.isArray(v) ? v : Object.values(v).flat()));
    const misses = all.filter((h) => !h.inView || !h.hits);
    return {
      recipe: { viewport: 390, views: ['table (with q)', 'cards', 'kanban', 'workspace', 'deadlines'] },
      measured: { sizes: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Array.isArray(v) ? v.length : Object.fromEntries(Object.entries(v).map(([a, b]) => [a, b.length]))])), misses },
      pass: counts.table.toggle.length === 5 && counts.table.filters.length >= 3 && counts.table.reset.length === 1 && counts.table.menu.length > 0 &&
        counts.cards.length > 0 && counts.kanban.length >= 2 && counts.workspace.length > 0 && counts.deadlines.length === 2 && misses.length === 0,
    };
  });

  // A text's contrast against the ground it is read on — translucent grounds blended over the
  // first opaque one beneath (WCAG's 4.5:1 for text).
  const textContrast = (locator) => locator.evaluate((el) => {
    // Colours come as oklch(...) from Tailwind 4: a canvas pixel turns any CSS colour into sRGB.
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const cx = canvas.getContext('2d', { willReadFrequently: true });
    const parse = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const [r, g, b, a] = cx.getImageData(0, 0, 1, 1).data; return { r, g, b, a: a / 255 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const layers = [];
    for (let a = el; a; a = a.parentElement) { const c = parse(getComputedStyle(a).backgroundColor); if (c.a > 0) { layers.push(c); if (c.a >= 1) break; } }
    let ground = layers.length && layers[layers.length - 1].a >= 1 ? layers.pop() : { r: 255, g: 255, b: 255, a: 1 };
    for (const c of layers.reverse()) ground = { r: c.r * c.a + ground.r * (1 - c.a), g: c.g * c.a + ground.g * (1 - c.a), b: c.b * c.a + ground.b * (1 - c.a), a: 1 };
    const a = lum(parse(getComputedStyle(el).color));
    const b = lum(ground);
    return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
  });
  for (const [id, opts, test] of [
    ['theme-light@1440', { storage: { 'theme-mode': 'light' } }, (e) => !/\bdark\b/.test(e.theme)],
    ['theme-oled@1440', { settings: { dark_background: 'oled' } }, (e) => /bg-oled/.test(e.theme)],
  ]) {
    await scenario(id, ['E2-B01', 'E7-D01', 'E7-F01', 'E7-H05'], async () => {
      const files = [];
      let e = null;
      let shortChip = null;
      for (const v of ['table', 'kanban', 'deadlines']) {
        const { ctx, p } = await open(1440, { ...opts, storage: { ...(opts.storage ?? {}), 'projects.view': v } });
        await listPage(p);
        e = await env(p);
        const chip = p.locator('[data-testid^="filament-chip-"][data-short="true"]').first();
        if (v === 'table' && (await chip.count())) shortChip = await textContrast(chip);
        files.push(await shoot(p, `${id}-${v}`));
        await ctx.close();
      }
      return {
        env: e,
        measured: { views: ['table', 'kanban', 'deadlines'], shortChip },
        pass: test(e) && (shortChip === null || shortChip >= 4.5),
        screenshots: files,
      };
    });
  }

  // ======================= 11. the layout change (G02) across the app =======================
  // <main> lost its `overflow` so that `sticky` works (owner, 2026-10-01): a page wider than the
  // screen now widens the document instead of hiding inside <main>'s own scroll — every page of the
  // app is walked for it, and nothing it shows may throw.
  const PAGES = ['/', '/queue', '/archives', '/files', '/inventory', '/stats', '/maintenance', '/profiles', '/settings',
    '/groups/new', '/users', '/notifications', '/system', '/products', '/customers', '/stock', '/projects'];
  for (const w of [1440, 1024, 390]) {
    await scenario(`layout-pages@${w}`, ['E7-G02', 'S02'], async () => {
      const { ctx, p, errors } = await open(w);
      const rows = [];
      for (const path of PAGES) {
        await p.goto(`${job.ui}${path}`, { waitUntil: 'networkidle' }).catch(() => {});
        await p.waitForTimeout(700);
        const overflow = await docOverflow(p);
        const shot = overflow > 0 ? await shoot(p, `layout-pages@${w}${path.replace(/\//g, '_')}`, { fullPage: true }) : null;
        const sticking = overflow > 0 ? await offenders(p) : [];
        // The same page under the OLD rule (<main> with `overflow: auto`): did it overflow then too —
        // inside <main>'s own sideways scroll — or is the width new?
        const before = await p.evaluate(() => {
          const style = document.createElement('style');
          style.textContent = 'main { overflow: auto !important; }';
          document.head.appendChild(style);
          const main = document.querySelector('main');
          const wide = main ? main.scrollWidth - main.clientWidth : 0;
          style.remove();
          return wide;
        });
        rows.push({ path, overflow, before, sticking, shot });
      }
      const file = await shoot(p, `layout-pages@${w}-last`);
      await ctx.close();
      const wide = rows.filter((r) => r.overflow > 0);
      // A regression is a page wide NOW that was not wide under the old rule. One that was already
      // too wide (it scrolled sideways inside <main>) pans the whole page now — the final review's
      // ruling: it fails too, so the pages are fixed rather than named.
      const regressions = wide.filter((r) => r.before <= 0);
      return {
        recipe: { pages: PAGES, viewport: w },
        env: { viewport: [w, HEIGHTS[w]] },
        measured: { wide, regressions, preexisting: wide.filter((r) => r.before > 0).map((r) => r.path), pages: rows.length, errors },
        pass: wide.length === 0 && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  // ======================= 12. sticky bars below the fixed header (final review) =======================
  // With <main> no scroll box, every page-level `sticky` sticks to the WINDOW — under the fixed
  // compact header (below 1144 px) unless its offset is the header's height. Each page is scrolled
  // and every STUCK sticky (not one inside a scroll box of its own) must sit below the header.
  const STICKY_PAGES = [
    { label: 'files', path: '/files' },
    { label: 'group', path: '/groups/new' },
    { label: 'inventory', path: '/inventory', select: 'tbody input[type="checkbox"]' },
    { label: 'workspace', path: '/projects', storage: { 'projects.view': 'workspace' } },
  ];
  for (const w of [1024, 768]) {
    await scenario(`sticky-header@${w}`, ['E7-G02'], async () => {
      const pages = [];
      for (const pg of STICKY_PAGES) {
        const { ctx, p, errors } = await open(w, { storage: pg.storage ?? {} });
        await p.goto(`${job.ui}${pg.path}`, { waitUntil: 'networkidle' }).catch(() => {});
        await p.waitForTimeout(800);
        let selected = null;
        if (pg.select) {
          const box = p.locator(pg.select).first();
          selected = (await box.count()) > 0;
          if (selected) await box.check({ timeout: 5000 }).catch(() => { selected = false; });
          await p.waitForTimeout(300);
        }
        const geo = await p.evaluate(async () => {
          window.scrollTo(0, Math.max(0, Math.min(800, document.documentElement.scrollHeight - innerHeight)));
          await new Promise((r) => setTimeout(r, 400));
          const header = document.querySelector('header.fixed');
          const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
          const ownBox = (el) => {
            for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
              const s = getComputedStyle(a);
              if (/(auto|scroll|hidden|clip)/.test(`${s.overflowY} ${s.overflowX}`)) return true;
            }
            return false;
          };
          const rows = [...document.querySelectorAll('body *')]
            .filter((el) => getComputedStyle(el).position === 'sticky' && el.getClientRects().length && !ownBox(el))
            .map((el) => {
              const r = el.getBoundingClientRect();
              const top = parseFloat(getComputedStyle(el).top);
              const stuck = scrollY > 0 && Number.isFinite(top) && Math.abs(r.top - top) < 2;
              return { what: `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 3).join('.')}`, top: Math.round(r.top), stuck, under: stuck && r.top < headerBottom - 1 };
            });
          return { scrolled: Math.round(scrollY), headerBottom: Math.round(headerBottom), rows };
        });
        pages.push({ page: pg.label, selected, ...geo, errors });
        await ctx.close();
      }
      const under = pages.flatMap((pg) => pg.rows.filter((x) => x.under).map((x) => `${pg.page}: ${x.what} @${x.top}`));
      const stuck = pages.reduce((n, pg) => n + pg.rows.filter((x) => x.stuck).length, 0);
      return {
        recipe: { pages: STICKY_PAGES.map((pg) => pg.path), viewport: w, actions: ['inventory: tick the first row', 'scroll the window by up to 800 px'] },
        env: { viewport: [w, HEIGHTS[w]] },
        measured: { pages, under, stuck },
        pass: under.length === 0 && stuck > 0 && pages.every((pg) => pg.errors.length === 0),
      };
    });
  }
  };
  await (typeof selftest === 'function' ? selftest({ scenario, open, read }) : realScenarios());
  } catch (e) {
    // A failure outside any scenario — the job, a preparation read — ends the run as INCOMPLETE,
    // recorded like a scenario and safely.
    incomplete = true;
    await record({ id: 'runner', ids: [], source: 'runner', pass: false, error: safeError(e, stage) });
  } finally {
    for (const ctx of [...live.keys()]) await closeContext(ctx);
    await post('/done', { count: sent, incomplete, declared });
  }
  return { records: summary.length, sent, incomplete, summary };
}
