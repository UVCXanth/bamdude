// WS-13 E12 acceptance runner (spec §L.1), run by Playwright MCP's browser_run_code_unsafe:
//   filename: scripts/workshop_stand/e12_stock.js — while `e12_evidence.py serve` listens on 127.0.0.1:8197.
// The harness is E4's (e04_detail.js, via E7–E11), unchanged in what it guarantees: every scenario records WHAT was
// run (recipe + fixtures), WHERE (viewport, DPR, the actual <html> classes), WHAT was measured and whether it
// matched the spec — a failure is a failure, a surface it cannot reach is `pending`. Nothing reaches the stand but
// reads: every non-GET request of every context is answered here, and the states the baseline does not hold are
// rewritten GET answers in this runner's own context only. The oracles measure what a person reads and does — the
// labels in order, the sentence in a dialog's slot, where the focus is, which requests a press sent and with what
// body — never a class name, except where the spec names the geometry rule itself (the cards at 1100, the tiles at
// 1100 and 560) or the print rule (the table header, a row and a kept block on paper).
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
    // A locator that found several elements names the locator and the count — its own words, no request.
    /^(locator|page)\.\w+: Error: strict mode violation: .{1,200} resolved to \d+ elements:?$/,
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
  const HEIGHTS = { 2560: 1440, 1920: 1080, 1440: 900, 1280: 800, 1101: 800, 1100: 800, 1024: 768, 768: 1024, 761: 800, 760: 800, 390: 844 };
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
  // `delay`: [[regex, ms]]; `gets`: [[regex, (url) => null | {delay?, fail?} | {rewrite} | {json} | {file}]] — a GET
  // answered by its turn (the callback counts its own calls); `writes`: [[regex, json | (request) => json |
  // {__status, json}]] answers for non-GET, every other non-GET gets {}. `me`: fields merged into /auth/me.
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
      if (sessionStorage.getItem('e12-init')) return;
      sessionStorage.setItem('e12-init', '1');
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
        // The media token's mint writes a row: the page gets the one the job server minted before
        // the run (pictures need it).
        const fallback = /\/api\/v1\/auth\/media-token/.test(url) && job.media_token ? { token: job.media_token } : {};
        let answer = hit ? (typeof hit[1] === 'function' ? await hit[1](req) : hit[1]) : fallback;
        if (answer && answer.__status) return route.fulfill({ status: answer.__status, json: answer.json ?? {} });
        return route.fulfill({ status: 200, json: answer });
      }
      const turn = gets.find(([re]) => re.test(url));
      const step = turn ? await turn[1](url) : null;
      if (step && step.delay) await new Promise((r) => setTimeout(r, step.delay));
      if (step && step.fail) return route.fulfill({ status: step.fail, json: { detail: 'e12 runner' } });
      // A body of the runner's own — the stand is never asked.
      if (step && step.json) return route.fulfill({ status: 200, json: step.json });
      // A picture of the runner's own (the cover fixture, K11): a real PNG file.
      if (step && step.file) return route.fulfill({ status: 200, path: step.file, contentType: 'image/png' });
      const failing = fail.find(([re]) => re.test(url));
      if (failing) return route.fulfill({ status: failing[1], json: { detail: 'e12 runner' } });
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
  // The mockup entities (spec §L.1, T0): position 1 — SK-0005, 6 on hand, 4 held by hand, 2 available,
  // minimum 10, two kits on the shelf, a sibling configuration; product 16 — a variant group «Хвіст»
  // (прямий — the standard — 4 kits, кутовий 0); note 90000 — DN-0001; customer 1 — the issue's.
  const P = job.positions ?? {};
  const PR = job.products ?? {};
  const P1 = P['1'] ?? 1;
  const P2 = P['2'] ?? 2;
  // Position 4 (SK-0001) is held by an order line — the F6 D2 reservation row.
  const P4 = P['4'] ?? 0;
  const PR1 = PR['1'] ?? 1;
  const PR16 = PR['16'] ?? 16;
  const N1 = (job.notes ?? {})['90000'] ?? 1;
  const CU1 = (job.customers ?? {})['1'] ?? 1;
  // Every read is taken as it comes: a field the answer lacks is a scenario's failure, not the preparation's.
  const list = (v) => (Array.isArray(v) ? v : []);
  const item1 = await read(`/stock/items/${P1}`);
  const item4 = await read(`/stock/items/${P4}`);
  const notesCount = (await read('/stock-issues/?page=1&per_page=1')).meta?.total ?? 0;
  const note1 = await read(`/stock-issues/${N1}`);
  const notesPage = await read('/stock-issues/?sort_by=created-desc&page=1&per_page=24');
  const product1 = await read(`/products/${item1.product?.id ?? PR1}`);
  const product16 = await read(`/products/${PR16}`);
  const parts1 = await read('/stock?page=1&per_page=200&sort_by=kits-desc');
  const st2Finished = list(await read('/stock/journal/products?book=finished'));
  const st2Parts = list(await read('/stock/journal/products?book=parts'));
  const groups = await read('/groups/');
  const groupList = Array.isArray(groups) ? groups : list(groups.items);
  const adminPerms = groupList.find((g) => g.name === 'Administrators')?.permissions ?? [];
  const without = (...drop) => adminPerms.filter((perm) => !drop.includes(perm));
  const READER = { is_admin: false, role: 'user', permissions: without('projects:update', 'projects:create', 'projects:delete') };
  const NAME1 = item1.product?.name ?? '';
  const CODE1 = item1.code ?? '';
  const MANUAL1 = list(item1.reservations).filter((r) => r.project_line_id == null).reduce((s, r) => s + r.qty, 0);
  const tail = list(product16.variant_groups)[0] ?? { id: 0, name: '', default_option_id: 0, options: [] };
  const STANDARD16 = tail.default_option_id;
  const OTHER16 = tail.options.find((o) => o.id !== STANDARD16)?.id ?? 0;
  const parts16 = list(parts1.items).find((r) => r.id === PR16) ?? { kits_by_option: [] };
  const reservedRow = list(parts1.items).find((r) => list(r.reservations).length > 0);
  // A product the finished book moved and the parts book did not (ST2, R05).
  const finishedOnly = st2Finished.find((x) => !st2Parts.some((y) => y.id === x.id)) ?? { id: 0, name: '' };
  const firstNoteRow = list(notesPage.items)[0] ?? {};

  // --- doors and oracles ---
  const ITEMS = /\/api\/v1\/stock\/items\/?\?/;
  const ITEM = (id) => new RegExp(`/api/v1/stock/items/${id}/?(\\?.*)?$`);
  const LOOKUP = /\/api\/v1\/stock\/items\/lookup/;
  const STOCK = /\/api\/v1\/stock\/?\?/;
  const JOURNAL = /\/api\/v1\/stock\/journal\/?\?/;
  const ST2 = /\/api\/v1\/stock\/journal\/products/;
  const NOTES = /\/api\/v1\/stock-issues\/?\?/;
  const NOTE = (id) => new RegExp(`/api/v1/stock-issues/${id}/?(\\?.*)?$`);
  const MOVES = /\/api\/v1\/stock\/moves/;
  const ASSEMBLE = /\/api\/v1\/stock\/assemble/;
  const COUNT = (url) => /[?&]per_page=1(&|$)/.test(url);
  const goto = async (p, path) => {
    await p.goto(`${job.ui}${path}`, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(600);
  };
  const dialogOf = (p, name) => p.getByRole('dialog', { name, exact: true });
  const textOf = (locator) => locator.evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim());
  const described = (locator) => locator.evaluate((el) => (el.getAttribute('aria-describedby') || '')
    .split(/\s+/).map((id) => document.getElementById(id)?.textContent.trim()).filter(Boolean).join(' '));
  const recorder = (store, re, answerOf) => [re, async (req) => {
    let body = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    const entry = { method: req.method(), path: new URL(req.url()).pathname + new URL(req.url()).search, body };
    store.push(entry);
    return answerOf ? answerOf(entry, store.length) : {};
  }];
  const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) }; });
  const urlOf = (p) => p.evaluate(() => location.pathname + location.search);
  const toastText = (p, re, ms = 6000) => within(p.waitForFunction((src) => {
    const rx = new RegExp(src);
    return [...document.querySelectorAll('body *')].some((el) => el.children.length === 0 && rx.test(el.textContent ?? ''));
  }, re.source), ms, 'no_toast');
  const focusAt = (p) => p.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'BODY';
    if (a.tagName === 'H1') return 'H1';
    const label = a.id ? document.querySelector(`label[for="${CSS.escape(a.id)}"]`) : null;
    return (label?.textContent || a.getAttribute('aria-label') || a.textContent || a.tagName).replace(/\s+/g, ' ').trim().slice(0, 80);
  });
  const docOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const hits = (p, locator) => locator.evaluate((el) => {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inView: r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.left >= 0 && r.right <= innerWidth + 0.5, hits: !!hit && (hit === el || el.contains(hit)) };
  });
  // A table's headers as a person reads them: the text, or the name of an icon-only header; an
  // aria-hidden decoration (the expander) is not read.
  const headers = (locator) => locator.locator('th').evaluateAll((ths) => ths
    .filter((th) => th.getAttribute('aria-hidden') !== 'true')
    .map((th) => (th.textContent.replace(/[▲▼]/g, '').replace(/\s+/g, ' ').trim() || th.getAttribute('aria-label') || '')));
  const perRow = (ts) => ts.filter((t) => t === ts[0]).length;
  // The panel is drawn hidden until it is measured: its items are read once the first one shows.
  const menuItems = async (panel) => (await panel.getByRole('menuitem').first().waitFor({ timeout: 5000 }), panel.getByRole('menuitem')).evaluateAll((ms) => ms.map((m) => ({ text: m.textContent.trim(), disabled: m.disabled, title: m.getAttribute('title') })));
  const refetchLater = async (p) => {
    await p.clock.fastForward('01:30');
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await p.waitForTimeout(1500);
  };
  // A rewritten first row of the finished goods / the free parts / the notes.
  const firstItem = (fn) => [ITEMS, (b) => ({ ...b, items: b.items.map((it, i) => (i === 0 ? fn(it) : it)) })];
  const firstNote = (fn) => [NOTES, (b, url) => (COUNT(url) ? b : { ...b, items: b.items.map((n, i) => (i === 0 ? fn(n) : n)) })];
  const longNote = (b) => ({
    ...b,
    lines_count: 40,
    units: 40 * 3,
    lines: Array.from({ length: 40 }, (_, i) => ({ ...b.lines[0], position: i + 1, quantity: 3, product_name: `${b.lines[0].product_name} ${i + 1}` })),
  });
  const MOVED = { ...item1, moved: true };

  // ---------------------------------------------------------------- the page (B)
  await scenario('page@1440', ['E12-B01', 'E12-B02', 'E12-B03', 'E12-B04'], async () => {
    const out = {};
    const files = [];
    {
      const { ctx, p, errors } = await open(1440);
      await goto(p, '/stock');
      out.h1 = await p.getByRole('heading', { level: 1 }).evaluate((h) => ({ text: h.textContent.trim(), tab: h.getAttribute('tabindex') }));
      out.tiles = await p.locator('[data-testid^="finished-tile-"]').evaluateAll((ts) => ts.map((t) => t.textContent.replace(/\s+/g, ' ').trim()));
      out.tabs = await p.getByRole('tablist', { name: 'Розділи складу' }).getByRole('tab').evaluateAll((ts) => ts.map((t) => t.textContent.trim()));
      files.push(await shoot(p, 'page'));
      await p.getByRole('tab', { name: 'Вільні деталі' }).click();
      await p.getByTestId('stock-tile-kits').waitFor();
      out.partsUrl = await urlOf(p);
      out.order = await p.evaluate(() => {
        const farm = document.querySelector('[data-testid="finished-tile-on-hand"]');
        const strip = document.querySelector('[role="tablist"]');
        const shelf = document.querySelector('[data-testid="stock-tile-kits"]');
        return !!farm && !!strip && !!shelf &&
          !!(farm.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          !!(strip.compareDocumentPosition(shelf) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      out.errors = errors;
      await ctx.close();
    }
    // A count that could not be read is no count — never «(0)».
    {
      const { ctx, p } = await open(1440, { gets: [[NOTES, (url) => (COUNT(url) ? { fail: 500 } : null)]] });
      await goto(p, '/stock');
      await p.waitForTimeout(1500);
      out.failedTab = await p.getByRole('tab', { name: /^Накладні/ }).textContent();
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock', actions: ['the «Вільні деталі» tab'], fixture: ['GET /stock-issues/?…per_page=1 500 (the count)'] },
      measured: out,
      pass: out.h1.text === 'Склад' && out.h1.tab === '-1' && out.tiles.length === 4 &&
        out.tiles[0].includes('Готових на складі') && out.tiles[0].includes('(виріб × конфігурація)') &&
        out.tiles[1].includes('під замовлення й видачі') && out.tiles[2].includes('залишок мінус резерв') &&
        out.tabs.join('|') === `Готові вироби|Вільні деталі|Журнал руху|Накладні (${notesCount})` &&
        out.partsUrl === '/stock?tab=parts' && out.order && out.failedTab.trim() === 'Накладні' && out.errors.length === 0,
      screenshots: files,
    };
  });

  // ---------------------------------------------------------------- the finished goods (C)
  await scenario('finished-states@1440', ['E12-B04', 'E12-C06'], async () => {
    const out = {};
    const files = [];
    {
      const { ctx, p } = await open(1440, { delay: [[ITEMS, 4000]] });
      await p.goto(`${job.ui}/stock`, { waitUntil: 'domcontentloaded' });
      await p.getByTestId('stock-skeleton').waitFor({ timeout: 6000 });
      out.skeleton = await p.getByTestId('stock-skeleton').getAttribute('data-tab');
      files.push(await shoot(p, 'finished-skeleton'));
      await ctx.close();
    }
    {
      let n = 0;
      const { ctx, p } = await open(1440, { gets: [[ITEMS, () => { n += 1; return n <= 1 ? { fail: 500 } : null; }]] });
      await goto(p, '/stock');
      await p.getByRole('alert').waitFor({ timeout: 8000 });
      out.failed = await textOf(p.getByRole('alert'));
      out.failedEmpty = await p.getByText('На обліку ще немає готових виробів.').count();
      files.push(await shoot(p, 'finished-failed'));
      await p.getByRole('alert').getByRole('button', { name: 'Спробувати знову' }).click();
      await p.getByTestId(`finished-row-${P1}`).waitFor({ timeout: 8000 });
      out.retried = true;
      await ctx.close();
    }
    {
      let n = 0;
      const { ctx, p } = await open(1440, { gets: [[ITEMS, () => { n += 1; return n <= 1 ? null : { fail: 500 }; }]] });
      await p.clock.install();
      await goto(p, '/stock');
      await p.getByTestId(`finished-row-${P1}`).waitFor();
      await refetchLater(p);
      await p.getByText('Не вдалося оновити').first().waitFor({ timeout: 8000 });
      out.refresh = { note: await p.getByText('Не вдалося оновити').count(), rows: await p.getByTestId(`finished-row-${P1}`).count() };
      await ctx.close();
    }
    {
      const { ctx, p } = await open(1440);
      await goto(p, '/stock?q=zzzz-none');
      out.noMatch = await p.getByText('Позицій не знайдено').count();
      await p.getByRole('button', { name: 'Скинути фільтри' }).click();
      await p.getByTestId(`finished-row-${P1}`).waitFor({ timeout: 8000 });
      out.afterReset = await urlOf(p);
      await ctx.close();
    }
    {
      const { ctx, p } = await open(1440, { rewrite: [[ITEMS, (b) => ({ ...b, items: [], meta: { ...b.meta, total: 0, last_page: 1 } })]] });
      await goto(p, '/stock');
      out.empty = await p.getByText('На обліку ще немає готових виробів.').count();
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock', fixture: ['GET /stock/items held 4 s', 'GET /stock/items 500, then the stand', 'a re-read 500', 'q=zzzz-none', 'GET /stock/items empty'] },
      measured: out,
      pass: out.skeleton === 'finished' && out.failed.includes('Не вдалося завантажити готові вироби') && out.failedEmpty === 0 &&
        out.retried && out.refresh.note >= 1 && out.refresh.rows === 1 && out.noMatch === 1 &&
        !out.afterReset.includes('q=') && out.empty === 1,
      screenshots: files,
    };
  });

  await scenario('finished@1440', ['E12-C01', 'E12-C02', 'E12-C03', 'E12-C04', 'E12-C05'], async () => {
    const out = {};
    const files = [];
    {
      const { ctx, p, errors } = await open(1440);
      await goto(p, '/stock');
      out.modes = await p.getByRole('tablist', { name: 'Які позиції' }).getByRole('tab').evaluateAll((ts) => ts.map((t) => ({ name: t.textContent.trim(), on: t.getAttribute('aria-selected') })));
      out.search = await p.getByRole('searchbox').getAttribute('placeholder');
      const region = p.getByRole('region', { name: 'Готові вироби' });
      out.cols = await headers(region.locator('table').first().locator('thead'));
      const row = p.getByTestId(`finished-row-${P1}`);
      out.row = {
        badge: await p.getByTestId(`finished-available-${P1}`).getAttribute('data-tone'),
        short: await row.getByText(/^бракує \d+$/).count(),
        kits: await row.getByText(/^\d+ з деталей$/).count(),
        chip: await textOf(p.getByTestId(`finished-location-${P1}`)),
        link: await row.getByRole('link', { name: NAME1 }).getAttribute('href'),
      };
      await p.getByTestId(`finished-${P1}-menu`).click();
      const panel = p.getByTestId(`finished-${P1}-menu-panel`);
      out.menu = (await menuItems(panel)).map((m) => m.text);
      out.separators = await panel.getByRole('separator').count();
      files.push(await shoot(p, 'finished-menu'));
      await p.keyboard.press('Escape');
      await p.getByRole('tab', { name: 'Нижче мінімуму' }).click();
      await p.waitForTimeout(800);
      out.lowUrl = await urlOf(p);
      await goto(p, '/stock?mode=bogus');
      out.bogus = { on: await p.getByRole('tab', { name: 'На обліку' }).getAttribute('aria-selected'), url: await urlOf(p) };
      await goto(p, '/stock?sort=code-desc');
      out.chip = await textOf(p.getByTestId('finished-sort-chip'));
      await p.getByTestId('finished-sort-chip').getByRole('button', { name: 'Прибрати сортування' }).click();
      await p.waitForTimeout(700);
      out.afterChip = await urlOf(p);
      out.errors = errors;
      files.push(await shoot(p, 'finished'));
      await ctx.close();
    }
    // A row with nothing on hand: the moves it cannot take are greyed with their reasons.
    {
      const { ctx, p } = await open(1440, { rewrite: [firstItem((it) => ({ ...it, on_hand: 0, reserved: 0, available: 0, can_assemble: 0, below_min: false, short_by: 0 }))] });
      await goto(p, '/stock');
      const first = (await p.locator('[data-testid^="finished-row-"]').first().getAttribute('data-testid')).replace('finished-row-', '');
      await p.getByTestId(`finished-${first}-menu`).click();
      out.empty = await menuItems(p.getByTestId(`finished-${first}-menu-panel`));
      await ctx.close();
    }
    // A reader: only «Відкрити позицію».
    {
      const { ctx, p } = await open(1440, { me: READER });
      await goto(p, '/stock');
      await p.getByTestId(`finished-${P1}-menu`).click();
      out.reader = (await menuItems(p.getByTestId(`finished-${P1}-menu-panel`))).map((m) => m.text);
      out.readerHeader = await p.getByRole('button', { name: 'Надходження' }).count();
      await ctx.close();
    }
    const reason = (name) => out.empty.find((m) => m.text === name) ?? {};
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock', actions: ['the row menu', '«Нижче мінімуму»', '?mode=bogus', '?sort=code-desc → remove'], fixture: ['the first row with nothing on hand', 'a reader'] },
      measured: out,
      pass: out.modes.map((m) => m.name).join('|') === 'На обліку|Нижче мінімуму|У резерві|Усі позиції' && out.modes[0].on === 'true' &&
        out.search === 'Виріб, артикул, код, конфігурація, комірка…' &&
        out.cols.join('|') === 'Виріб / конфігурація|Комірка|Залишок|Резерв|Доступно|Мінімум|Можна зібрати|Дії' &&
        out.row.badge === 'low' && out.row.short === 1 && out.row.kits === 1 && out.row.chip === item1.location && out.row.link === `/stock/${P1}` &&
        out.menu.join('|') === 'Надходження|Зібрати з деталей|Резервувати|Зняти резерв|Видати|Комірка й мінімум|Інвентаризація|Відкрити позицію' &&
        out.separators === 1 && out.lowUrl.includes('mode=low') && out.bogus.on === 'true' && out.bogus.url.includes('mode=bogus') &&
        out.chip === 'Сортування: Код ↓' && !out.afterChip.includes('sort=') &&
        !out.empty.some((m) => m.text === 'Зібрати з деталей') &&
        reason('Резервувати').disabled && reason('Резервувати').title === 'Немає доступного для резерву' &&
        reason('Зняти резерв').title === 'Нічого не зарезервовано' && reason('Видати').title === 'На складі нічого немає' &&
        out.reader.join('|') === 'Відкрити позицію' && out.readerHeader === 0 && out.errors.length === 0,
      screenshots: files,
    };
  });

  // ---------------------------------------------------------------- the free parts (D)
  await scenario('parts@1440', ['E12-D01', 'E12-D02', 'E12-D03', 'E12-D04'], async () => {
    const out = {};
    const files = [];
    {
      const { ctx, p, errors } = await open(1440, { storage: { 'bamdude-stock-perPage': '-1' } });
      await goto(p, '/stock?tab=parts');
      out.search = await p.getByRole('searchbox').getAttribute('placeholder');
      out.toggle = await p.getByRole('checkbox', { name: 'Лише з залишком' }).isChecked();
      out.hint = await p.getByText(/^Надлишок замовлень \(кнопкою\)/).count();
      out.cols = await headers(p.getByRole('region', { name: 'Вільні деталі' }).locator('table').first().locator('thead'));
      const kits16 = p.getByTestId(`stock-kits-${PR16}`);
      out.kits16 = (await kits16.count()) ? await kits16.locator('small').evaluateAll((ls) => ls.map((l) => l.textContent.trim())) : null;
      out.kitsNote = await p.getByText('Кожен рядок — одна опція, інші групи стандартні; числа не додаються.').count();
      if (reservedRow) {
        const link = p.getByTestId(`stock-reserved-${reservedRow.id}`).getByRole('link').first();
        out.reservation = { text: await link.textContent(), href: await link.getAttribute('href') };
      }
      const firstRow = p.locator('[data-testid^="stock-row-"]').first();
      out.assembleEnabled = await firstRow.getByRole('button', { name: 'Зібрати' }).isEnabled();
      await firstRow.getByRole('button', { name: /^Показати деталі/ }).click();
      const details = p.locator('[data-testid^="stock-details-"]').first();
      await details.waitFor();
      out.details = await details.locator('tbody tr').evaluateAll((rs) => rs.map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent.trim())));
      files.push(await shoot(p, 'parts'));
      await firstRow.getByRole('button', { name: 'Зібрати' }).click();
      const d = dialogOf(p, 'Зібрати готові вироби з деталей');
      await d.waitFor();
      out.dialogLocked = await d.getByTestId('stock-locked-product').count();
      out.errors = errors;
      await ctx.close();
    }
    // A one-off product: «Зібрати» greyed, the reason on screen.
    {
      const { ctx, p } = await open(1440, { rewrite: [[STOCK, (b) => ({ ...b, items: b.items.map((r, i) => (i === 0 ? { ...r, origin: 'order', is_active: false } : r)) })]] });
      await goto(p, '/stock?tab=parts');
      const firstRow = p.locator('[data-testid^="stock-row-"]').first();
      const btn = firstRow.getByRole('button', { name: 'Зібрати' });
      out.oneOff = { disabled: await btn.isDisabled(), reason: await described(btn), mark: await firstRow.getByText('разовий', { exact: true }).count() };
      files.push(await shoot(p, 'parts-one-off'));
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock?tab=parts', actions: ['expand the first row', '«Зібрати»'], fixture: ['the first row a one-off product'] },
      measured: out,
      pass: out.search === 'Виріб, артикул…' && out.toggle === true && out.hint === 1 &&
        out.cols.join('|') === 'Виріб|Комплектів за конфігурацією|Деталей на полиці|Резерв замовлень|Дії' &&
        Array.isArray(out.kits16) && out.kits16.length === parts16.kits_by_option.length && out.kitsNote === 1 &&
        (!reservedRow || (/^OR-\d+$/.test(out.reservation.text) && /^\/projects\/\d+$/.test(out.reservation.href))) &&
        out.assembleEnabled && out.details.length > 0 && out.details.every((r) => /^× \d+$|Поза комплектом/.test(r[1])) &&
        out.dialogLocked === 1 && out.oneOff.disabled && out.oneOff.reason === 'Разовий виріб не тримається на складі готових' &&
        out.oneOff.mark === 1 && out.errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('parts-states@1440', ['E12-B04', 'E12-D05'], async () => {
    const out = {};
    {
      const { ctx, p } = await open(1440, { delay: [[STOCK, 4000]] });
      await p.goto(`${job.ui}/stock?tab=parts`, { waitUntil: 'domcontentloaded' });
      await p.getByTestId('stock-skeleton').waitFor({ timeout: 6000 });
      out.skeleton = await p.getByTestId('stock-skeleton').getAttribute('data-tab');
      await ctx.close();
    }
    {
      let n = 0;
      const { ctx, p } = await open(1440, { gets: [[STOCK, () => { n += 1; return n <= 1 ? { fail: 500 } : null; }]] });
      await goto(p, '/stock?tab=parts');
      await p.getByRole('alert').waitFor({ timeout: 8000 });
      out.failed = await textOf(p.getByRole('alert'));
      await p.getByRole('alert').getByRole('button', { name: 'Спробувати знову' }).click();
      await p.locator('[data-testid^="stock-row-"]').first().waitFor({ timeout: 8000 });
      out.retried = true;
      await ctx.close();
    }
    {
      const { ctx, p } = await open(1440);
      await goto(p, '/stock?tab=parts&q=zzzz-none');
      out.noMatch = await p.getByText('Жоден виріб не підходить.').count();
      await p.getByRole('button', { name: 'Скинути фільтри' }).click();
      await p.waitForTimeout(800);
      out.afterReset = await urlOf(p);
      await ctx.close();
    }
    {
      const { ctx, p } = await open(1440, { rewrite: [[STOCK, (b) => ({ ...b, items: [], meta: { ...b.meta, total: 0, last_page: 1 } })]] });
      await goto(p, '/stock?tab=parts');
      out.empty = await p.getByText('Вільних деталей немає.').count();
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock?tab=parts', fixture: ['GET /stock held 4 s', 'GET /stock 500, then the stand', 'q=zzzz-none', 'GET /stock empty'] },
      measured: out,
      pass: out.skeleton === 'parts' && out.failed.includes('Не вдалося завантажити вільні деталі') && out.retried &&
        out.noMatch === 1 && out.afterReset === '/stock?tab=parts' && out.empty === 1,
    };
  });

  await scenario('parts-assemble-other-option', ['E12-D03', 'E12-H02', 'E12-H04', 'E12-R01'], async () => {
    // The standard makes nothing, the other option three: «Зібрати» opens the choice (R01).
    const kitsOf = (url) => ((new URL(url).searchParams.get('options') || '').split(',').includes(String(OTHER16)) ? 3 : 0);
    const { ctx, p, errors } = await open(1440, {
      rewrite: [
        [STOCK, (b) => ({ ...b, items: b.items.map((r) => (r.id === PR16 ? { ...r, kits_available: 0, kits_by_option: r.kits_by_option.map((k) => ({ ...k, kits: k.option_id === OTHER16 ? 3 : 0 })) } : r)) })],
        [LOOKUP, (b, url) => ({ ...b, can_assemble: kitsOf(url) })],
      ],
    });
    await goto(p, '/stock?tab=parts&q=' + encodeURIComponent(product16.name));
    const row = p.getByTestId(`stock-row-${PR16}`);
    await row.waitFor();
    const enabled = await row.getByRole('button', { name: 'Зібрати' }).isEnabled();
    await row.getByRole('button', { name: 'Зібрати' }).click();
    const d = dialogOf(p, 'Зібрати готові вироби з деталей');
    await d.waitFor();
    await p.waitForTimeout(1200);
    const before = { why: await described(d.getByTestId('assemble-submit')), disabled: await d.getByTestId('assemble-submit').isDisabled(), selectOpen: await d.getByLabel(tail.name).isEnabled() };
    await d.getByLabel(tail.name).selectOption(String(OTHER16));
    await d.getByText('можна до 3').waitFor({ timeout: 6000 });
    const after = { enabled: await d.getByTestId('assemble-submit').isEnabled() };
    const file = await shoot(p, 'parts-assemble-other-option');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock?tab=parts → product 16 «Зібрати» → the other option', fixture: ['GET /stock: product 16 standard 0, the other 3', 'GET /stock/items/lookup: the other option 3, else 0'] },
      measured: { enabled, before, after, errors },
      pass: enabled && before.disabled && before.why === 'З вільних деталей цієї конфігурації зараз нічого не зібрати' && before.selectOpen &&
        after.enabled && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('parts-out-of-kit', ['E12-D04', 'E12-R02'], async () => {
    const extra = { part_id: 990001, name: 'Запасна кліпса', qty_per_unit: 0, balance: 3, variant: null };
    const { ctx, p, errors } = await open(1440, { rewrite: [[STOCK, (b) => ({ ...b, items: b.items.map((r, i) => (i === 0 ? { ...r, parts: [...r.parts, extra] } : r)) })]] });
    await goto(p, '/stock?tab=parts');
    const firstRow = p.locator('[data-testid^="stock-row-"]').first();
    await firstRow.getByRole('button', { name: /^Показати деталі/ }).click();
    const details = p.locator('[data-testid^="stock-details-"]').first();
    await details.waitFor();
    const zero = details.locator('tbody tr').filter({ hasText: 'Запасна кліпса' });
    const cells = await zero.locator('td').evaluateAll((tds) => tds.map((td) => td.textContent.trim()));
    const file = await shoot(p, 'parts-out-of-kit');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock?tab=parts → expand the first row', fixture: ['GET /stock: a counted part with 0 per unit and 3 on the shelf'] },
      measured: { cells, errors },
      pass: cells[0] === 'Запасна кліпса' && cells[1] === 'Поза комплектом' && cells[2] === '3' && errors.length === 0,
      screenshots: [file],
    };
  });

  // ---------------------------------------------------------------- the journal (E)
  await scenario('journal@1440', ['E12-E01', 'E12-E02', 'E12-E03', 'E12-E04'], async () => {
    const { ctx, p, errors, requests } = await open(1440);
    await goto(p, '/stock?tab=journal');
    const region = p.getByRole('region', { name: 'Журнал руху' });
    const cols = await headers(region.locator('table').first().locator('thead'));
    const footer = await textOf(p.locator('[data-pagination]').first());
    const older = await p.getByRole('button', { name: /старіші/i }).count();
    const dateCell = await region.locator('tbody tr').first().locator('td').first().textContent();
    const firstFinished = region.locator('[data-testid^="journal-row-finished-"]').first();
    const finishedLink = (await firstFinished.count()) ? await firstFinished.locator('td').nth(1).getByRole('link').getAttribute('href') : null;
    const firstParts = region.locator('[data-testid^="journal-row-parts-"]').first();
    const partsLink = (await firstParts.count()) ? await firstParts.locator('td').nth(1).getByRole('link').getAttribute('href') : null;
    const file = await shoot(p, 'journal');
    await p.getByLabel('Книга').selectOption('finished');
    await p.waitForTimeout(900);
    const bookUrl = await urlOf(p);
    const askedFinished = requests.some((r) => /\/stock\/journal\/products\?book=finished/.test(r));
    const options = await p.getByLabel('Виріб').locator('option').count();
    await p.getByLabel('Операція').selectOption({ index: 1 });
    await p.waitForTimeout(700);
    const kindUrl = await urlOf(p);
    await p.getByLabel('Книга').selectOption('parts');
    await p.waitForTimeout(900);
    const afterBook = await urlOf(p);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock?tab=journal', actions: ['book «Готові вироби»', 'an operation', 'book «Вільні деталі»'] },
      measured: { cols, footer, older, dateCell, finishedLink, partsLink, bookUrl, askedFinished, options, kindUrl, afterBook, errors },
      pass: cols.join('|') === 'Дата|Виріб|Що|Операція|Зміна|Замовлення / накладна / примітка|Хто' &&
        /503/.test(footer) && older === 0 && /\d{1,2}:\d{2}/.test(dateCell) &&
        (finishedLink == null || /^\/stock\/\d+$/.test(finishedLink)) && (partsLink == null || /^\/products\/\d+$/.test(partsLink)) &&
        bookUrl.includes('book=finished') && askedFinished && options === st2Finished.length + 1 &&
        kindUrl.includes('kind=') && afterBook.includes('book=parts') && !afterBook.includes('kind=') && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('journal-states@1440', ['E12-B04', 'E12-E05'], async () => {
    const out = {};
    {
      const { ctx, p } = await open(1440, { delay: [[JOURNAL, 4000]] });
      await p.goto(`${job.ui}/stock?tab=journal`, { waitUntil: 'domcontentloaded' });
      await p.getByTestId('stock-skeleton').waitFor({ timeout: 6000 });
      out.skeleton = await p.getByTestId('stock-skeleton').getAttribute('data-tab');
      await ctx.close();
    }
    {
      const empty = (b) => ({ ...b, items: [], meta: { ...b.meta, total: 0, last_page: 1 } });
      const { ctx, p } = await open(1440, { rewrite: [[JOURNAL, empty]] });
      await goto(p, '/stock?tab=journal');
      out.empty = await p.getByText('Рухів ще немає').count();
      await goto(p, '/stock?tab=journal&book=parts&kind=manual');
      out.noMatch = await p.getByText('Жоден рух не підходить під ці фільтри.').count();
      await p.getByRole('button', { name: 'Скинути фільтри' }).click();
      await p.waitForTimeout(800);
      out.afterReset = await urlOf(p);
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock?tab=journal', fixture: ['GET /stock/journal held 4 s', 'GET /stock/journal empty'] },
      measured: out,
      pass: out.skeleton === 'journal' && out.empty === 1 && out.noMatch === 1 && out.afterReset === '/stock?tab=journal',
    };
  });

  await scenario('journal-page-fail', ['E12-E01', 'E12-E02'], async () => {
    const { ctx, p, errors } = await open(1440, { gets: [[JOURNAL, (url) => (/[?&]page=2(&|$)/.test(url) ? { fail: 500 } : null)]] });
    await goto(p, '/stock?tab=journal&page=2');
    await p.getByRole('alert').waitFor({ timeout: 8000 });
    const alert = await textOf(p.getByRole('alert'));
    const retry = await p.getByRole('alert').getByRole('button', { name: 'Спробувати знову' }).count();
    const url = await urlOf(p);
    const file = await shoot(p, 'journal-page-fail');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock?tab=journal&page=2', fixture: ['GET /stock/journal page 2 → 500'] },
      measured: { alert, retry, url, errors },
      pass: alert.includes('Не вдалося завантажити рухи') && retry === 1 && url.includes('page=2') && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('journal-back', ['E12-E02', 'E12-R05'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, '/stock?tab=journal&book=finished&page=2');
    const before = await urlOf(p);
    const row = p.locator('[data-testid^="journal-row-finished-"]').first();
    await row.locator('td').nth(1).getByRole('link').click();
    await p.waitForURL(/\/stock\/\d+$/);
    await p.goBack();
    await p.waitForTimeout(1200);
    const after = await urlOf(p);
    const book = await p.getByLabel('Книга').inputValue();
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock?tab=journal&book=finished&page=2 → a position → Back' },
      measured: { before, after, book, errors },
      pass: after === before && book === 'finished' && errors.length === 0,
    };
  });

  await scenario('journal-st2-pending', ['E12-E02', 'E12-R05'], async () => {
    // A product the finished book moved and the parts book did not: it stays while the parts list
    // is read, and goes only when that list answers without it.
    let hold = true;
    const { ctx, p, errors } = await open(1440, { gets: [[ST2, async (url) => {
      if (/book=parts/.test(url)) {
        while (hold) await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    }]] });
    await goto(p, `/stock?tab=journal&book=finished&product=${finishedOnly.id}`);
    const chosen = await p.getByLabel('Виріб').inputValue();
    await p.getByLabel('Книга').selectOption('parts');
    await p.waitForTimeout(1200);
    const held = {
      value: await p.getByLabel('Виріб').inputValue(),
      name: await p.getByLabel('Виріб').evaluate((s) => s.selectedOptions[0]?.textContent.trim()),
      url: await urlOf(p),
      reading: await p.getByText('Читаємо вироби…').count(),
    };
    const file = await shoot(p, 'journal-st2-pending');
    hold = false;
    await p.waitForTimeout(1500);
    const after = { value: await p.getByLabel('Виріб').inputValue(), url: await urlOf(p) };
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: `/stock?tab=journal&book=finished&product=${finishedOnly.id} → book «Вільні деталі»`, fixture: ['GET /stock/journal/products?book=parts held, then the stand'] },
      measured: { chosen, held, after, errors },
      pass: chosen === String(finishedOnly.id) && held.value === String(finishedOnly.id) && held.name === finishedOnly.name &&
        held.url.includes(`product=${finishedOnly.id}`) && held.reading === 1 &&
        after.value === '' && !after.url.includes('product=') && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('journal-st2-cached', ['E12-E02', 'E12-R05'], async () => {
    // Codex E12-V03: a book visited before keeps its product list in the cache. Back on that
    // book the cached list names the options, but the product goes only on the answer read now.
    let hold = false;
    const { ctx, p, errors } = await open(1440, { gets: [[ST2, async (url) => {
      if (/book=parts/.test(url)) {
        while (hold) await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    }]] });
    await goto(p, '/stock?tab=journal&book=parts');
    await p.getByLabel('Книга').selectOption('finished');
    await p.waitForTimeout(1200);
    await p.getByLabel('Виріб').selectOption(String(finishedOnly.id));
    await p.waitForTimeout(800);
    const chosen = await urlOf(p);
    hold = true;
    await p.getByLabel('Книга').selectOption('parts');
    await p.waitForTimeout(1500);
    const held = {
      value: await p.getByLabel('Виріб').inputValue(),
      name: await p.getByLabel('Виріб').evaluate((s) => s.selectedOptions[0]?.textContent.trim()),
      url: await urlOf(p),
    };
    const file = await shoot(p, 'journal-st2-cached');
    hold = false;
    await p.waitForTimeout(1500);
    const after = { value: await p.getByLabel('Виріб').inputValue(), url: await urlOf(p) };
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: `/stock?tab=journal&book=parts → «Готові вироби» → product ${finishedOnly.id} → «Вільні деталі»`, fixture: ['GET /stock/journal/products?book=parts held on the second visit, then the stand'] },
      measured: { chosen, held, after, errors },
      pass: chosen.includes(`product=${finishedOnly.id}`) && held.value === String(finishedOnly.id) && held.name === finishedOnly.name &&
        held.url.includes(`product=${finishedOnly.id}`) && after.value === '' && !after.url.includes('product=') && errors.length === 0,
      screenshots: [file],
    };
  });

  // ---------------------------------------------------------------- the position (F)
  await scenario('position@1440', ['E12-F01', 'E12-F02', 'E12-F03', 'E12-F04', 'E12-F05'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, `/stock/${P1}`);
    const h1 = await p.getByRole('heading', { level: 1 }).evaluate((h) => ({ text: h.textContent.trim(), tab: h.getAttribute('tabindex') }));
    const crumbs = await p.getByRole('link', { name: 'Склад', exact: true }).first().getAttribute('href');
    const facts = await textOf(p.getByTestId('item-facts'));
    const primary = await p.getByRole('button', { name: 'Надходження' }).count();
    await p.getByTestId('item-menu').click();
    const menu = (await menuItems(p.getByTestId('item-menu-panel'))).map((m) => m.text);
    await p.keyboard.press('Escape');
    const tiles = await p.locator('[data-testid^="item-tile-"]').evaluateAll((ts) => ts.map((t) => t.textContent.replace(/\s+/g, ' ').trim()));
    const panel = p.getByTestId('item-actions');
    const head = await panel.getByRole('heading', { level: 3 }).textContent();
    const panelText = await textOf(panel);
    const actions = await panel.getByRole('button').evaluateAll((bs) => bs.map((b) => b.textContent.trim()));
    const cards = await p.getByTestId('item-cards').evaluate((g) => [...g.children].map((c) => { const r = c.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }; }));
    const reservations = await textOf(p.getByTestId('item-reservations'));
    const partsCard = await textOf(p.getByTestId('item-parts'));
    const journalHead = await p.getByRole('heading', { level: 2, name: 'Журнал руху' }).count();
    const file = await shoot(p, 'position', { fullPage: true });
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: `/stock/{fin:1}`, actions: ['the menu'] },
      measured: { h1, crumbs, facts, primary, menu, tiles, head, panelText, actions, cards, reservations, partsCard, journalHead, errors },
      pass: h1.text === NAME1 && h1.tab === '-1' && crumbs === '/stock' &&
        facts.includes(CODE1) && facts.includes('стандартна') && facts.includes(`комірка ${item1.location}`) && primary === 1 &&
        menu.join('|') === 'Інвентаризація|Відкрити виріб' &&
        tiles[0].includes('Фактичний залишок') && tiles[0].includes('готових виробів цієї конфігурації') &&
        tiles[1].includes('недоступні для вільної видачі') && tiles[3].includes(`бракує ${item1.short_by}`) &&
        head === 'Потрібне поповнення' && panelText.includes(`До мінімуму не вистачає ${item1.short_by} шт. З деталей можна зібрати ${item1.can_assemble}, решту — поставити в друк.`) &&
        actions.join('|') === 'Зібрати з деталей|Резервувати|Зняти резерв|Видати|Комірка й мінімум' &&
        cards.length === 2 && cards[1].l >= cards[0].r && reservations.includes(`Без замовлення — ${MANUAL1} шт.`) &&
        reservations.includes('Інші конфігурації цього виробу') && partsCard.includes(`Можна зібрати: ${item1.can_assemble}`) &&
        journalHead === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('position-panel-states@1440', ['E12-F02', 'E12-F03'], async () => {
    const out = {};
    for (const [key, patch] of [
      ['within', { below_min: false, short_by: 0, min_qty: 1 }],
      ['noMin', { below_min: false, short_by: 0, min_qty: 0 }],
      ['empty', { on_hand: 0, reserved: 0, available: 0, can_assemble: 0, below_min: false, short_by: 0, min_qty: 0, reservations: [] }],
    ]) {
      const { ctx, p } = await open(1440, { rewrite: [[ITEM(P1), (b) => ({ ...b, ...patch })]] });
      await goto(p, `/stock/${P1}`);
      const panel = p.getByTestId('item-actions');
      out[key] = {
        head: await panel.getByRole('heading', { level: 3 }).textContent(),
        min: await textOf(p.getByTestId('item-tile-min')),
      };
      if (key === 'empty') {
        out.reasons = {};
        for (const name of ['Зібрати з деталей', 'Резервувати', 'Зняти резерв', 'Видати']) {
          const btn = panel.getByRole('button', { name });
          out.reasons[name] = { disabled: await btn.isDisabled(), why: await described(btn) };
        }
        out.visible = await panel.getByText('На складі нічого немає').isVisible();
      }
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: `/stock/{fin:1}`, fixture: ['GET /stock/items/{id}: within the minimum / no minimum / nothing on hand'] },
      measured: out,
      pass: out.within.head === 'Запас у межах норми' && out.within.min.includes('у межах норми') &&
        out.noMin.head === 'Мінімум не задано' && out.noMin.min.includes('не задано') &&
        out.reasons['Зібрати з деталей'].why === 'З вільних деталей цієї конфігурації зараз нічого не зібрати' &&
        out.reasons['Резервувати'].why === 'Немає доступного для резерву' && out.reasons['Зняти резерв'].why === 'Нічого не зарезервовано' &&
        out.reasons['Видати'].why === 'На складі нічого немає' && Object.values(out.reasons).every((r) => r.disabled) && out.visible,
    };
  });

  await scenario('position-states@1440', ['E12-F06'], async () => {
    const out = {};
    {
      const { ctx, p } = await open(1440, { delay: [[ITEM(P1), 4000]] });
      await p.goto(`${job.ui}/stock/${P1}`, { waitUntil: 'domcontentloaded' });
      await p.getByTestId('item-skeleton').waitFor({ timeout: 6000 });
      out.skeleton = await p.getByTestId('item-skeleton').getAttribute('role');
      await ctx.close();
    }
    {
      let n = 0;
      const { ctx, p } = await open(1440, { gets: [[ITEM(P1), () => { n += 1; return n <= 1 ? { fail: 500 } : null; }]] });
      await goto(p, `/stock/${P1}`);
      await p.getByRole('alert').waitFor({ timeout: 8000 });
      out.failed = await textOf(p.getByRole('alert'));
      await p.getByRole('alert').getByRole('button', { name: 'Спробувати знову' }).click();
      await p.getByRole('heading', { level: 1, name: NAME1 }).waitFor({ timeout: 8000 });
      out.retried = true;
      await ctx.close();
    }
    {
      const { ctx, p } = await open(1440);
      await goto(p, '/stock/999999');
      out.missing = await p.getByText('Позицію не знайдено').count();
      out.back = await p.getByRole('link', { name: 'До складу' }).getAttribute('href');
      await ctx.close();
    }
    {
      let n = 0;
      const { ctx, p } = await open(1440, { gets: [[ITEM(P1), () => { n += 1; return n <= 1 ? null : { fail: 500 }; }]] });
      await p.clock.install();
      await goto(p, `/stock/${P1}`);
      await refetchLater(p);
      await p.getByText('Не вдалося оновити').first().waitFor({ timeout: 8000 });
      out.refresh = { note: await p.getByText('Не вдалося оновити').count(), h1: await p.getByRole('heading', { level: 1, name: NAME1 }).count() };
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: `/stock/{fin:1}`, fixture: ['GET held 4 s', 'GET 500, then the stand', '/stock/999999', 'a re-read 500'] },
      measured: out,
      pass: out.skeleton === 'status' && out.failed.includes('Не вдалося завантажити позицію') && out.retried &&
        out.missing === 1 && out.back === '/stock' && out.refresh.note >= 1 && out.refresh.h1 === 1,
    };
  });

  await scenario('position-journal-filters', ['E12-E06', 'E12-F05', 'E12-R05'], async () => {
    const { ctx, p, errors, requests } = await open(1440);
    await goto(p, `/stock/${P1}`);
    const product = await p.getByLabel('Виріб').count();
    await p.getByLabel('Книга').selectOption('finished');
    await p.waitForTimeout(900);
    await p.getByLabel('Операція').selectOption({ index: 1 });
    await p.waitForTimeout(900);
    const asked = requests.filter((r) => /\/stock\/journal\?/.test(r)).pop() ?? '';
    const url = await urlOf(p);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: `/stock/{fin:1}`, actions: ['book «Готові вироби»', 'an operation'] },
      measured: { product, asked, url, errors },
      pass: product === 0 && asked.includes(`item_id=${P1}`) && asked.includes('book=finished') && asked.includes('kind=') &&
        asked.includes('page=1') && url === `/stock/${P1}` && errors.length === 0,
    };
  });

  // ---------------------------------------------------------------- the moves (G)
  await scenario('position-order-reservation', ['E12-F04'], async () => {
    // F6 D2 (owner, 2026-10-04): an order's reservation names its order — «OR-… · name — N шт.».
    const held = list(item4.reservations).find((r) => r.project_id != null) ?? {};
    const expected = `${held.project_code} · ${held.project_name} — ${held.qty} шт.`;
    const { ctx, p, errors } = await open(1440);
    await goto(p, `/stock/${P4}`);
    const card = p.getByTestId('item-reservations');
    const text = await textOf(card);
    const link = await card.getByRole('link', { name: held.project_code ?? '' }).count();
    await card.scrollIntoViewIfNeeded();
    const file = await shoot(p, 'position-order-reservation');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock/{fin:4}', fixture: ['the stand: SK-0001 held by an order line'] },
      measured: { expected, text, link, errors },
      pass: !!held.project_name && text.includes(expected) && link === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('move-receipt@1440', ['E12-G01', 'E12-G02', 'E12-G06', 'E12-G07'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, { writes: [recorder(writes, MOVES, () => MOVED)] });
    await goto(p, '/stock');
    await p.getByRole('button', { name: 'Надходження' }).click();
    const d = dialogOf(p, 'Надходження');
    await d.waitFor();
    await p.waitForTimeout(500);
    const subtitle = await described(d);
    const focus = await focusAt(p);
    await d.getByRole('textbox', { name: 'Виріб' }).fill(product1.name.slice(0, 6));
    await d.getByRole('button', { name: `${product1.code} · ${product1.name}`, exact: true }).click();
    await d.getByTestId('stock-lookup').filter({ hasText: 'Позиція' }).waitFor({ timeout: 8000 });
    const lookup = await textOf(d.getByTestId('stock-lookup'));
    const hint = await d.getByText('Збільшує залишок позиції.').count();
    const placeholder = await d.getByLabel('Підстава / примітка').getAttribute('placeholder');
    await d.getByLabel('Кількість, шт.').fill('3');
    await d.getByLabel('Підстава / примітка').fill('e12');
    const primary = await d.getByTestId('stock-move-submit').textContent();
    const file = await shoot(p, 'move-receipt');
    await d.getByTestId('stock-move-submit').click();
    await toastText(p, /Склад оновлено/);
    const closed = await dialogOf(p, 'Надходження').count();
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock → «Надходження» → a product', fixture: ['POST /stock/moves answered here'] },
      measured: { subtitle, focus, lookup, hint, placeholder, primary, writes, closed, errors },
      pass: subtitle === 'Облік готових виробів у штуках — окремо для кожної конфігурації' && focus === 'Виріб' &&
        lookup.includes(`Позиція ${CODE1}: залишок ${item1.on_hand}, резерв ${item1.reserved}, доступно ${item1.available}.`) &&
        hint === 1 && placeholder === 'Прийнято від партнера…' && primary.trim() === 'Оприбуткувати' &&
        writes.length === 1 && writes[0].body.kind === 'receipt' && writes[0].body.qty === 3 && writes[0].body.note === 'e12' &&
        writes[0].body.product_id === item1.product.id && closed === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('move-stocktake@1440', ['E12-G01', 'E12-G04'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, { writes: [recorder(writes, MOVES, () => ({ ...item1, moved: false }))] });
    await goto(p, `/stock/${P1}`);
    await p.getByTestId('item-menu').click();
    await p.getByRole('menuitem', { name: 'Інвентаризація' }).click();
    const d = dialogOf(p, 'Інвентаризація');
    await d.waitFor();
    await d.getByText(`Зараз: залишок ${item1.on_hand}, резерв ${item1.reserved}`).waitFor({ timeout: 8000 });
    const focus = await focusAt(p);
    const counted = d.getByLabel('Фактично на полиці');
    await counted.fill(String(item1.on_hand - 1));
    const lower = { disabled: await d.getByTestId('stock-move-submit').isDisabled(), why: await described(d.getByTestId('stock-move-submit')) };
    await counted.fill(String(item1.reserved - 1));
    await d.getByLabel('Підстава / примітка').fill('lost');
    const below = { disabled: await d.getByTestId('stock-move-submit').isDisabled(), text: await d.getByText(/^Не менше за резерв/).textContent() };
    await d.getByLabel('Підстава / примітка').fill('');
    await counted.fill(String(item1.on_hand));
    const same = await d.getByText('без змін').count();
    const file = await shoot(p, 'move-stocktake');
    await d.getByTestId('stock-move-submit').click();
    await toastText(p, /Без змін — кількість збігається з полицею/);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock/{fin:1} → «Інвентаризація»', fixture: ['POST /stock/moves answered here (moved: false)'] },
      measured: { focus, lower, below, same, writes, errors },
      pass: focus === 'Фактично на полиці' && lower.disabled && lower.why === 'Менша кількість потребує примітки' &&
        below.disabled && below.text === `Не менше за резерв ${item1.reserved} — спершу зніміть резерв` && same === 1 &&
        writes.length === 1 && writes[0].body.counted === item1.on_hand && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('move-issue@1440', ['E12-G01', 'E12-G03', 'E12-G05'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, { writes: [recorder(writes, MOVES, () => ({ ...MOVED, issue_id: N1, issue_code: note1.code }))] });
    await goto(p, `/stock/${P1}`);
    await p.getByTestId('item-actions').getByRole('button', { name: 'Видати' }).click();
    const d = dialogOf(p, 'Видача');
    await d.waitFor();
    await p.waitForTimeout(800);
    const noCustomer = { disabled: await d.getByTestId('stock-move-submit').isDisabled(), why: await described(d.getByTestId('stock-move-submit')) };
    await d.getByLabel('Замовник').selectOption(String(CU1));
    await p.waitForTimeout(1500);
    const recipient = await d.getByLabel('Ім’я одержувача').inputValue().catch(() => null);
    const waybillMax = await d.getByLabel('Номер ТТН').getAttribute('maxLength');
    const limitPlain = await d.getByTestId('stock-move-limit').textContent();
    await d.getByLabel('З ручного резерву').check();
    const limitManual = await d.getByTestId('stock-move-limit').textContent();
    await d.getByLabel('Номер ТТН').fill('59000123456789');
    const file = await shoot(p, 'move-issue');
    await d.getByTestId('stock-move-submit').click();
    await dialogOf(p, 'Накладну оформлено').waitFor({ timeout: 8000 });
    const created = await textOf(dialogOf(p, 'Накладну оформлено'));
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock/{fin:1} → «Видати»', fixture: ['POST /stock/moves answered here (a dispatch note)'] },
      measured: { noCustomer, recipient, waybillMax, limitPlain, limitManual, writes, created, errors },
      pass: noCustomer.disabled && noCustomer.why === 'Видача називає замовника.' && waybillMax === '24' &&
        limitPlain.trim() === `можна видати ${item1.available} (доступно)` && limitManual.trim() === `можна видати ${MANUAL1} (з ручного резерву)` &&
        writes.length === 1 && writes[0].body.customer_id === CU1 && writes[0].body.from_reserve === true &&
        writes[0].body.waybill === '59000123456789' && created.includes(note1.code) && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('issue-manual-reserve', ['E12-G03', 'E12-R03'], async () => {
    // 12 on hand: 4 held by hand, 2 by an order — 6 available.
    const r03 = (b) => ({
      ...b, on_hand: 12, reserved: 6, available: 6,
      reservations: [{ project_line_id: null, project_id: null, project_code: null, qty: 4 }, { project_line_id: 990, project_id: 990, project_code: 'OR-0990', qty: 2 }],
    });
    const { ctx, p, errors } = await open(1440, { rewrite: [[ITEM(P1), r03]] });
    await goto(p, `/stock/${P1}`);
    await p.getByTestId('item-actions').getByRole('button', { name: 'Видати' }).click();
    const d = dialogOf(p, 'Видача');
    await d.waitFor();
    await d.getByLabel('Замовник').selectOption(String(CU1));
    await p.waitForTimeout(1200);
    const at = async (n) => {
      await d.getByLabel('Кількість, шт.').fill(String(n));
      return { limit: (await d.getByTestId('stock-move-limit').textContent()).trim(), enabled: await d.getByTestId('stock-move-submit').isEnabled() };
    };
    const plain6 = await at(6);
    const plain7 = await at(7);
    await d.getByLabel('З ручного резерву').check();
    const manual4 = await at(4);
    const manual5 = await at(5);
    const file = await shoot(p, 'issue-manual-reserve');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock/{fin:1} → «Видати»', fixture: ['GET /stock/items/{id}: 12 on hand, 4 by hand, 2 by an order, 6 available'] },
      measured: { plain6, plain7, manual4, manual5, errors },
      pass: plain6.enabled && plain6.limit === 'можна видати 6 (доступно)' && !plain7.enabled && plain7.limit === 'Не більше 6' &&
        manual4.enabled && manual4.limit === 'можна видати 4 (з ручного резерву)' && !manual5.enabled && manual5.limit === 'Не більше 4' &&
        errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('dialog-config-switch', ['E12-G08', 'E12-R04'], async () => {
    let hold = true;
    const { ctx, p, errors } = await open(1440, { gets: [[LOOKUP, async (url) => {
      const options = new URL(url).searchParams.get('options') || '';
      if (options && options !== String(STANDARD16)) while (hold) await new Promise((r) => setTimeout(r, 100));
      return null;
    }]] });
    await goto(p, '/stock');
    await p.getByRole('button', { name: 'Надходження' }).click();
    const d = dialogOf(p, 'Надходження');
    await d.waitFor();
    await d.getByRole('textbox', { name: 'Виріб' }).fill(product16.name.slice(0, 8));
    await d.getByRole('button', { name: `${product16.code} · ${product16.name}`, exact: true }).click();
    await d.getByTestId('stock-lookup').filter({ hasText: /Позиція|Буде створено/ }).waitFor({ timeout: 8000 });
    const ready = await d.getByTestId('stock-move-submit').isEnabled();
    await d.getByLabel(tail.name).selectOption(String(OTHER16));
    await p.waitForTimeout(1000);
    const held = { note: (await textOf(d.getByTestId('stock-lookup'))), disabled: await d.getByTestId('stock-move-submit').isDisabled() };
    const file = await shoot(p, 'dialog-config-switch');
    hold = false;
    await d.getByTestId('stock-lookup').filter({ hasText: /Позиція|Буде створено/ }).waitFor({ timeout: 8000 });
    const after = await d.getByTestId('stock-move-submit').isEnabled();
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock → «Надходження» → product 16 → the other option', fixture: ['GET /stock/items/lookup for the other option held'] },
      measured: { ready, held, after, errors },
      pass: ready && held.note === 'читаємо…' && held.disabled && after && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('dialog-refusal-reread', ['E12-G07', 'E12-G08', 'E12-R04'], async () => {
    // 0 — the stand; 1 — after the first refusal, one available; 2 — after the second, one failed
    // read and then one available.
    let phase = 0;
    let failedOnce = false;
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      gets: [[ITEM(P1), () => {
        if (phase === 0) return null;
        if (phase === 2 && !failedOnce) { failedOnce = true; return { fail: 500 }; }
        return { rewrite: (b) => ({ ...b, available: 1, reserved: b.on_hand - 1 }) };
      }]],
      writes: [recorder(writes, MOVES, (entry, count) => { phase = count; return { __status: 409, json: { detail: 'Доступно лише 1' } }; })],
    });
    await goto(p, `/stock/${P1}`);
    await p.getByTestId('item-actions').getByRole('button', { name: 'Резервувати' }).click();
    const d = dialogOf(p, 'Резервування');
    await d.waitFor();
    await d.getByTestId('stock-move-limit').filter({ hasText: /можна зарезервувати/ }).waitFor({ timeout: 8000 });
    await d.getByLabel('Кількість, шт.').fill(String(item1.available));
    await d.getByLabel('Підстава / примітка').fill('hold');
    await d.getByTestId('stock-move-submit').click();
    await d.getByRole('alert').waitFor({ timeout: 8000 });
    const slot = await textOf(d.getByRole('alert'));
    await p.waitForTimeout(1500);
    const focus = await focusAt(p);
    const after = { limit: (await d.getByTestId('stock-move-limit').textContent()).trim(), qty: await d.getByLabel('Кількість, шт.').inputValue(), note: await d.getByLabel('Підстава / примітка').inputValue() };
    const file = await shoot(p, 'dialog-refusal-reread');
    // A second refusal; its re-read fails — the old numbers stay with a retry, and the retry reads anew.
    await d.getByLabel('Кількість, шт.').fill('1');
    await d.getByTestId('stock-move-submit').click();
    await d.getByText('Не вдалося оновити').waitFor({ timeout: 8000 });
    const failedReread = await d.getByTestId('stock-move-submit').isDisabled();
    await d.getByTestId('stock-move-position').getByRole('button', { name: 'Спробувати знову' }).click();
    await d.getByTestId('stock-move-limit').filter({ hasText: /можна зарезервувати 1/ }).waitFor({ timeout: 8000 });
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock/{fin:1} → «Резервувати»', fixture: ['POST /stock/moves 409 «Доступно лише 1»', 'the re-read: 1 available; then 500; then 1 available'] },
      measured: { slot, focus, after, failedReread, writes: writes.length, errors },
      // The re-read left the draft (2) over the new limit (1): the primary waits, the cursor is in the quantity.
      pass: slot.includes('Доступно лише 1') && focus === 'Кількість, шт.' && after.limit === 'Не більше 1' &&
        after.qty === String(item1.available) && after.note === 'hold' && failedReread && writes.length === 2 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('dialog-reread-dimmed', ['E12-G08', 'E12-R04'], async () => {
    // F6 D1 (owner, 2026-10-04): while the same position is read again after a refusal, its last
    // numbers stay on screen dimmed — the header and the limit — and the primary waits; the
    // answer lifts the dimming.
    let hold = false;
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      gets: [[ITEM(P1), async () => {
        while (hold) await new Promise((r) => setTimeout(r, 100));
        return null;
      }]],
      writes: [recorder(writes, MOVES, () => ({ __status: 409, json: { detail: 'Доступно лише 1' } }))],
    });
    await goto(p, `/stock/${P1}`);
    await p.getByTestId('item-actions').getByRole('button', { name: 'Резервувати' }).click();
    const d = dialogOf(p, 'Резервування');
    await d.getByTestId('stock-move-limit').filter({ hasText: /можна зарезервувати/ }).waitFor({ timeout: 8000 });
    const before = (await d.getByTestId('stock-move-limit').textContent()).trim();
    hold = true;
    await d.getByTestId('stock-move-submit').click();
    await d.getByRole('alert').waitFor({ timeout: 8000 });
    await p.waitForTimeout(800);
    const limit = d.getByTestId('stock-move-limit');
    const header = d.getByTestId('stock-position-header');
    const held = {
      limit: (await limit.textContent()).trim(),
      limitStale: await limit.getAttribute('data-stale'),
      limitOpacity: await limit.evaluate((el) => getComputedStyle(el).opacity),
      header: await textOf(header),
      headerStale: await header.getAttribute('data-stale'),
      reading: await d.getByText('читаємо…').count(),
      disabled: await d.getByTestId('stock-move-submit').isDisabled(),
    };
    const file = await shoot(p, 'dialog-reread-dimmed');
    hold = false;
    await p.waitForTimeout(1500);
    const after = { limitStale: await limit.getAttribute('data-stale'), headerStale: await header.getAttribute('data-stale') };
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock/{fin:1} → «Резервувати» → a refusal', fixture: ['POST /stock/moves 409', 'GET /stock/items/{fin:1} held after the refusal, then the stand'] },
      measured: { before, held, after, writes: writes.length, errors },
      pass: /можна зарезервувати/.test(before) && held.limit === before && held.limitStale === 'true' && held.limitOpacity === '0.6' &&
        held.headerStale === 'true' && held.header.includes(`Залишок ${item1.on_hand}`) && held.reading === 0 && held.disabled &&
        after.limitStale === null && after.headerStale === null && writes.length === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('move-sync@1440', ['E12-G07'], async () => {
    let release = () => {};
    const gate = new Promise((r) => { release = r; });
    const writes = [];
    const { ctx, p, errors } = await open(1440, { writes: [recorder(writes, MOVES, async () => { await gate; return MOVED; })] });
    await goto(p, `/stock/${P1}`);
    await p.getByRole('button', { name: 'Надходження' }).click();
    const d = dialogOf(p, 'Надходження');
    await d.waitFor();
    await d.getByTestId('stock-move-submit').click();
    await d.getByTestId('stock-move-submit').click({ force: true }).catch(() => {});
    await p.waitForTimeout(400);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    const stays = await dialogOf(p, 'Надходження').count();
    release();
    await toastText(p, /Склад оновлено/);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock/{fin:1} → «Надходження» → two presses, Escape under the request' },
      measured: { writes: writes.length, stays, errors },
      pass: writes.length === 1 && stays === 1 && errors.length === 0,
    };
  });

  // ---------------------------------------------------------------- parameters and assembly (H)
  await scenario('params@1440', ['E12-H01'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, { writes: [recorder(writes, ITEM(P1), () => item1)] });
    await goto(p, `/stock/${P1}`);
    await p.getByTestId('item-actions').getByRole('button', { name: 'Комірка й мінімум' }).click();
    const d = dialogOf(p, 'Параметри зберігання');
    await d.waitFor();
    const width = (await box(d)).w;
    const subtitle = await described(d);
    const focus = await focusAt(p);
    const placeholder = await d.getByLabel('Комірка').getAttribute('placeholder');
    await d.getByLabel('Мінімальний запас, шт.').fill('-1');
    const invalid = await d.getByTestId('stock-params-submit').isDisabled();
    await d.getByLabel('Мінімальний запас, шт.').fill('12');
    await d.getByLabel('Комірка').fill('C-07');
    const file = await shoot(p, 'params');
    await d.getByTestId('stock-params-submit').click();
    await toastText(p, /Позицію оновлено/);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock/{fin:1} → «Комірка й мінімум»', fixture: ['PATCH /stock/items/{id} answered here'] },
      measured: { width, subtitle, focus, placeholder, invalid, writes, errors },
      pass: width === 448 && subtitle.startsWith(`${NAME1} · ${CODE1}`) && focus === 'Комірка' && placeholder === 'A-01' && invalid &&
        writes.length === 1 && writes[0].body.location === 'C-07' && writes[0].body.min_qty === 12 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('assemble@1440', ['E12-H02', 'E12-H03', 'E12-H04'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, { writes: [recorder(writes, ASSEMBLE, () => item1)] });
    await goto(p, `/stock/${P1}`);
    await p.getByTestId('item-actions').getByRole('button', { name: 'Зібрати з деталей' }).click();
    const d = dialogOf(p, 'Зібрати готові вироби з деталей');
    await d.waitFor();
    await d.getByText(`можна до ${item1.can_assemble}`).waitFor({ timeout: 8000 });
    const subtitle = await described(d);
    const position = await textOf(d.getByTestId('assemble-position'));
    const cols = await headers(d.locator('table thead'));
    await d.getByLabel('Скільки зібрати').fill(String(item1.can_assemble + 1));
    const over = { limit: await textOf(d.getByTestId('assemble-limit')), disabled: await d.getByTestId('assemble-submit').isDisabled(), short: await d.getByText(/^бракує \d+$/).count() };
    await d.getByLabel('Скільки зібрати').fill('1');
    const file = await shoot(p, 'assemble');
    await d.getByTestId('assemble-submit').click();
    await toastText(p, /Зібрано/);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock/{fin:1} → «Зібрати з деталей»', fixture: ['POST /stock/assemble answered here'] },
      measured: { subtitle, position, cols, over, writes, errors },
      pass: subtitle === 'Деталі списуються з вільного залишку, готові вироби надходять у позицію своєї конфігурації' &&
        position === `Позиція складу: ${CODE1} · стандартна · зараз ${item1.on_hand} шт.` &&
        cols.join('|') === 'Деталь|На виріб|На полиці|Спишеться' && over.disabled && over.limit === `Не більше ${item1.can_assemble}` &&
        over.short >= 1 && writes.length === 1 && writes[0].body.item_id === P1 && writes[0].body.qty === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ---------------------------------------------------------------- the dispatch notes (J)
  await scenario('notes@1440', ['E12-J01', 'E12-J02', 'E12-A01'], async () => {
    const summaryLines = [
      { product_name: product16.name, part_name: null, quantity: 2, configuration: { choices: [{ group_id: tail.id, group_name: tail.name, option_id: OTHER16, option_name: tail.options.find((o) => o.id === OTHER16).name, is_default: false }], changed_parts: [] } },
      { product_name: NAME1, part_name: null, quantity: 1, configuration: { choices: [{ group_id: tail.id, group_name: tail.name, option_id: STANDARD16, option_name: 'прямий', is_default: true }], changed_parts: [] } },
      { product_name: NAME1, part_name: 'Кришка', quantity: 4, configuration: null },
    ];
    const { ctx, p, errors } = await open(1440, { rewrite: [firstNote((n) => ({ ...n, lines_count: 5, summary: summaryLines }))] });
    await goto(p, '/stock?tab=notes');
    const search = await p.getByRole('searchbox').getAttribute('placeholder');
    const hint = await p.getByText('Кожна видача — за замовленням чи без — має свою видаткову накладну.').count();
    const cols = await headers(p.getByRole('region', { name: 'Накладні' }).locator('table').first().locator('thead'));
    const row = p.locator('[data-testid^="note-"]:not([data-testid$="-lines"])').first();
    const id = (await row.getAttribute('data-testid')).replace('note-', '');
    const lines = await p.getByTestId(`note-${id}-lines`).locator('[data-line]').evaluateAll((ls) => ls.map((l) => l.textContent.replace(/\s+/g, ' ').trim()));
    const more = await p.getByTestId(`note-${id}-lines`).getByText('ще 2').count();
    const accent = await p.getByTestId(`note-${id}-lines`).locator('[data-config-accent]').count();
    const open1 = await row.getByRole('link', { name: 'Відкрити' }).getAttribute('href');
    const waybill = await row.getByText(/^(ТТН .+|ТТН не вказано)$/).count();
    const file = await shoot(p, 'notes');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock?tab=notes', fixture: ['GET /stock-issues: the first note with three summary lines of five'] },
      measured: { search, hint, cols, lines, more, accent, open1, waybill, errors },
      pass: search === 'Накладна, замовлення, замовник, виріб, артикул, ТТН…' && hint === 1 &&
        cols.join('|') === 'Накладна|Дата|Одержувач|Замовлення|Що видано|К-сть|Видав|Дії' &&
        lines.length === 3 && lines[0].includes(tail.name) && !lines[1].includes('стандартна') && lines[2].includes('— до виробу') &&
        more === 1 && accent === 1 && open1 === `/stock/dispatch-notes/${id}` && waybill === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('notes-states@1440', ['E12-J02'], async () => {
    const out = {};
    const emptyNotes = (b, url) => (COUNT(url) ? b : { ...b, items: [], meta: { ...b.meta, total: 0, last_page: 1 } });
    {
      const { ctx, p } = await open(1440, { rewrite: [[NOTES, emptyNotes]] });
      await goto(p, '/stock?tab=notes');
      out.empty = { title: await p.getByText('Накладних ще немає').count(), text: await p.getByText('Вони з’являються з кожною видачею.').count() };
      await goto(p, '/stock?tab=notes&q=zzzz');
      out.noMatch = await p.getByText('Нічого не знайдено').count();
      await p.getByRole('button', { name: 'Скинути фільтри' }).click();
      await p.waitForTimeout(800);
      out.afterReset = await urlOf(p);
      await ctx.close();
    }
    {
      let n = 0;
      const { ctx, p } = await open(1440, { gets: [[NOTES, (url) => { if (COUNT(url)) return null; n += 1; return n <= 2 ? { fail: 500 } : null; }]] });
      await goto(p, '/stock?tab=notes');
      await p.getByRole('alert').waitFor({ timeout: 8000 });
      out.failed = await textOf(p.getByRole('alert'));
      await p.getByRole('alert').getByRole('button', { name: 'Спробувати знову' }).click();
      await p.locator('[data-testid^="note-"]').first().waitFor({ timeout: 8000 });
      out.retried = true;
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock?tab=notes', fixture: ['GET /stock-issues empty', 'q=zzzz', 'GET /stock-issues 500 ×2, then the stand'] },
      measured: out,
      pass: out.empty.title === 1 && out.empty.text === 1 && out.noMatch === 1 && out.afterReset === '/stock?tab=notes' &&
        out.failed.includes('Не вдалося завантажити накладні') && out.retried,
    };
  });

  await scenario('notes-count-failed', ['E12-B03'], async () => {
    // Codex E12-V04: a count that answered, then failed to re-read, is unknown — the tab shows no
    // number until a read answers again. A waybill save is what reads the notes' key again.
    let fail = false;
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      gets: [[NOTES, (url) => (COUNT(url) && fail ? { fail: 500 } : null)]],
      writes: [recorder(writes, /\/api\/v1\/stock-issues\/\d+$/)],
    });
    await goto(p, '/stock?tab=notes');
    const tab = p.getByRole('tab', { name: /^Накладні/ });
    const save = async (value) => {
      const row = p.locator('[data-testid^="note-"]:not([data-testid$="-lines"])').first();
      await row.getByRole('button', { name: 'Змінити ТТН' }).click();
      await row.getByLabel('ТТН', { exact: true }).fill(value);
      await row.getByLabel('ТТН', { exact: true }).press('Enter');
      await p.waitForTimeout(3000);
    };
    const before = await textOf(tab);
    fail = true;
    await save('C1');
    const failed = await textOf(tab);
    const file = await shoot(p, 'notes-count-failed');
    fail = false;
    await save('C2');
    const after = await textOf(tab);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock?tab=notes → a waybill saved twice', fixture: ['GET /stock-issues?per_page=1 500 after the first answer, then the stand', 'PATCH answered by the runner'] },
      measured: { before, failed, after, writes: writes.length, errors: errors.filter((e) => !/500/.test(e)) },
      pass: before === `Накладні (${notesCount})` && failed === 'Накладні' && after === `Накладні (${notesCount})` && writes.length === 2,
      screenshots: [file],
    };
  });

  await scenario('waybill-cycle', ['E12-J03', 'E12-R08'], async () => {
    const out = {};
    // Enter and a click under one request — one PATCH; Escape under it does nothing.
    {
      let release = () => {};
      const gate = new Promise((r) => { release = r; });
      const writes = [];
      const { ctx, p, errors } = await open(1440, { writes: [recorder(writes, /\/api\/v1\/stock-issues\/\d+$/, async () => { await gate; return {}; })] });
      await goto(p, '/stock?tab=notes');
      const row = p.locator('[data-testid^="note-"]:not([data-testid$="-lines"])').first();
      await row.getByRole('button', { name: 'Змінити ТТН' }).click();
      const field = row.getByLabel('ТТН', { exact: true });
      out.focusOpen = await focusAt(p);
      await field.fill('20450001');
      await field.press('Enter');
      await row.getByRole('button', { name: 'Зберегти' }).click({ force: true }).catch(() => {});
      await p.waitForTimeout(300);
      out.readOnly = await field.getAttribute('readonly');
      await field.press('Escape');
      out.stillOpen = await row.getByLabel('ТТН', { exact: true }).count();
      release();
      await p.waitForTimeout(1200);
      out.writes = writes.map((w) => w.body);
      out.focusAfter = await focusAt(p);
      out.errors = errors;
      await ctx.close();
    }
    // A refusal: said under the field, the text kept, the cursor in it; a retry succeeds.
    {
      let n = 0;
      const { ctx, p } = await open(1440, { writes: [[/\/api\/v1\/stock-issues\/\d+$/, () => { n += 1; return n === 1 ? { __status: 422, json: { detail: 'Номер ТТН — не довше 24 символів' } } : {}; }]] });
      await goto(p, '/stock?tab=notes');
      const row = p.locator('[data-testid^="note-"]:not([data-testid$="-lines"])').first();
      await row.getByRole('button', { name: 'Змінити ТТН' }).click();
      await row.getByLabel('ТТН', { exact: true }).fill('X1');
      await row.getByLabel('ТТН', { exact: true }).press('Enter');
      await row.getByRole('alert').waitFor({ timeout: 6000 });
      out.refusal = { text: await textOf(row.getByRole('alert')), kept: await row.getByLabel('ТТН', { exact: true }).inputValue(), focus: await focusAt(p) };
      const file = await shoot(p, 'waybill-refusal');
      out.file = file;
      await row.getByRole('button', { name: 'Зберегти' }).click();
      await p.waitForTimeout(1200);
      out.retryClosed = await row.getByLabel('ТТН', { exact: true }).count();
      await ctx.close();
    }
    // The row leaves the search after its waybill changed: the focus goes to the heading.
    {
      let reads = 0;
      const { ctx, p } = await open(1440, {
        gets: [[NOTES, (url) => {
          if (COUNT(url) || !/[?&]q=/.test(url)) return null;
          reads += 1;
          return reads === 1
            ? { json: { items: [{ ...firstNoteRow, waybill: 'OLD777' }], meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 } } }
            : { json: { items: [], meta: { total: 0, current_page: 1, per_page: 24, last_page: 1 } } };
        }]],
        writes: [[/\/api\/v1\/stock-issues\/\d+$/, {}]],
      });
      await goto(p, '/stock?tab=notes&q=OLD777');
      const row = p.locator('[data-testid^="note-"]:not([data-testid$="-lines"])').first();
      await row.getByRole('button', { name: 'Змінити ТТН' }).click();
      await row.getByLabel('ТТН', { exact: true }).fill('NEW888');
      await row.getByLabel('ТТН', { exact: true }).press('Enter');
      await p.waitForTimeout(2500);
      out.left = { rows: await p.locator('[data-testid^="note-"]:not([data-testid$="-lines"])').count(), focus: await focusAt(p) };
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock?tab=notes → the first row\'s pencil', fixture: ['PATCH held', 'PATCH 422 then {}', 'GET /stock-issues?q=OLD777: the row, then none'] },
      measured: { ...out, file: undefined },
      pass: out.focusOpen === 'ТТН' && out.writes.length === 1 && out.writes[0].waybill === '20450001' && out.readOnly !== null &&
        out.stillOpen === 1 && out.focusAfter === 'Змінити ТТН' && out.refusal.text === 'Номер ТТН — не довше 24 символів' &&
        out.refusal.kept === 'X1' && out.refusal.focus === 'ТТН' && out.retryClosed === 0 &&
        out.left.rows === 0 && out.left.focus === 'H1' && out.errors.length === 0,
      screenshots: [out.file],
    };
  });

  await scenario('waybill-note-switch', ['E12-J03', 'E12-R08'], async () => {
    // Codex E12-V01: the note page stays mounted from one note to the next. A draft typed on the
    // first is not carried to the second, and a save still on its way for the first changes
    // nothing there when it answers. The second note is read FIRST, so the move back to it
    // finds it in the cache and draws no skeleton — the editor would stay mounted (a cold move
    // unmounts it by itself and proves nothing).
    const out = {};
    const other = list(notesPage.items).find((n) => n.id !== N1) ?? { id: 0, code: '', waybill: null };
    // A mark on the window proves the moves kept the document (and so the page) mounted — a
    // reload would pass the oracles below for the wrong reason.
    const toNote = (p, id) => p.evaluate((target) => {
      window.__e12Mounted = true;
      history.pushState({}, '', `/stock/dispatch-notes/${target}`);
      dispatchEvent(new PopStateEvent('popstate'));
    }, id);
    const stayed = (p) => p.evaluate(() => window.__e12Mounted === true);
    const at = (p, code) => p.getByRole('heading', { level: 1, name: new RegExp(code) }).waitFor({ timeout: 8000 });
    const firstThenBack = async (p) => {
      await goto(p, `/stock/dispatch-notes/${other.id}`);
      await toNote(p, N1);
      await at(p, note1.code ?? 'DN-0001');
    };
    const toOther = async (p) => {
      await toNote(p, other.id);
      await at(p, other.code);
    };
    {
      const writes = [];
      const { ctx, p, errors } = await open(1440, { writes: [recorder(writes, /\/api\/v1\/stock-issues\/\d+$/)] });
      await firstThenBack(p);
      const controls = p.getByTestId('dispatch-note-controls');
      await controls.getByRole('button', { name: 'Змінити ТТН' }).click();
      await controls.getByLabel('ТТН', { exact: true }).fill('FOR-NOTE-ONE');
      await toOther(p);
      await p.waitForTimeout(600);
      out.draft = {
        stayed: await stayed(p),
        open: await controls.getByLabel('ТТН', { exact: true }).count(),
        carried: (await textOf(controls)).includes('FOR-NOTE-ONE'),
      };
      out.file = await shoot(p, 'waybill-note-switch');
      // An editor still open here is the defect itself: its value is recorded, not clicked past.
      if (out.draft.open === 0) await controls.getByRole('button', { name: 'Змінити ТТН' }).click();
      out.draft.opened = await controls.getByLabel('ТТН', { exact: true }).inputValue();
      out.draft.writes = writes.length;
      out.draft.errors = errors;
      await ctx.close();
    }
    {
      let release = () => {};
      const gate = new Promise((r) => { release = r; });
      const writes = [];
      const { ctx, p, errors } = await open(1440, { writes: [recorder(writes, /\/api\/v1\/stock-issues\/\d+$/, async () => {
        await gate;
        return { __status: 422, json: { detail: 'Номер ТТН — не довше 24 символів' } };
      })] });
      await firstThenBack(p);
      const controls = p.getByTestId('dispatch-note-controls');
      await controls.getByRole('button', { name: 'Змінити ТТН' }).click();
      await controls.getByLabel('ТТН', { exact: true }).fill('LATE-ONE');
      await controls.getByLabel('ТТН', { exact: true }).press('Enter');
      await p.waitForTimeout(300);
      await toOther(p);
      release();
      await p.waitForTimeout(1500);
      out.late = {
        stayed: await stayed(p),
        writes: writes.map((w) => w.path),
        alert: await controls.getByRole('alert').count(),
        open: await controls.getByLabel('ТТН', { exact: true }).count(),
        carried: (await textOf(controls)).includes('LATE-ONE'),
        errors,
      };
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: `/stock/dispatch-notes/${other.id} → in-app to ${N1} → edit → in-app back to ${other.code} (cached, the page stays mounted)`, fixture: ['PATCH answered by the runner', 'PATCH held, then 422'] },
      measured: { other: other.code, ...out, file: undefined },
      pass: other.id > 0 && out.draft.stayed && out.late.stayed && out.draft.open === 0 && !out.draft.carried && out.draft.opened === (other.waybill ?? '') &&
        out.draft.writes === 0 && out.draft.errors.length === 0 &&
        out.late.writes.length === 1 && out.late.writes[0].endsWith(`/stock-issues/${N1}`) && out.late.alert === 0 &&
        out.late.open === 0 && !out.late.carried,
      screenshots: [out.file],
    };
  });

  await scenario('note-page@1440', ['E12-J04', 'E12-J05'], async () => {
    const out = {};
    const files = [];
    {
      const { ctx, p, errors } = await open(1440);
      await goto(p, `/stock/dispatch-notes/${N1}`);
      const controls = p.getByTestId('dispatch-note-controls');
      out.h1 = await controls.getByRole('heading', { level: 1 }).textContent();
      out.workshop = await controls.evaluate((el) => !!el.closest('.workshop'));
      out.subtitle = await textOf(p.getByTestId('dispatch-note-subtitle'));
      out.waybill = await controls.getByText(/^(ТТН .+|ТТН не вказано)$/).count();
      out.pencil = await controls.getByRole('button', { name: 'Змінити ТТН' }).count();
      out.print = await controls.getByRole('button', { name: 'Друкувати' }).count();
      out.sheetBg = await p.getByTestId('dispatch-note-sheet').evaluate((el) => getComputedStyle(el).backgroundColor);
      files.push(await shoot(p, 'note-page', { fullPage: true }));
      out.errors = errors;
      await ctx.close();
    }
    {
      let n = 0;
      const { ctx, p } = await open(1440, { gets: [[NOTE(N1), () => { n += 1; return n <= 2 ? { fail: 500 } : null; }]] });
      await goto(p, `/stock/dispatch-notes/${N1}`);
      await p.getByRole('alert').waitFor({ timeout: 8000 });
      out.failed = await textOf(p.getByRole('alert'));
      await p.getByRole('alert').getByRole('button', { name: 'Спробувати знову' }).click();
      await p.getByTestId('dispatch-note-sheet').waitFor({ timeout: 8000 });
      out.retried = true;
      await ctx.close();
    }
    {
      const { ctx, p } = await open(1440);
      await goto(p, '/stock/dispatch-notes/999999');
      out.missing = await p.getByText('Накладну не знайдено.').count();
      out.back = await p.getByRole('link', { name: 'До накладних' }).getAttribute('href');
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock/dispatch-notes/{doc:90000}', fixture: ['GET 500 ×2, then the stand', '/stock/dispatch-notes/999999'] },
      measured: out,
      pass: out.h1.trim() === `Видаткова накладна ${note1.code}` && out.workshop && out.subtitle.includes(' · ') &&
        out.waybill === 1 && out.pencil === 1 && out.print === 1 && out.sheetBg === 'rgb(255, 255, 255)' &&
        out.failed.includes('Не вдалося завантажити накладну') && out.retried && out.missing === 1 &&
        out.back === '/stock?tab=notes' && out.errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('note-40-lines', ['E12-J05', 'E12-J06'], async () => {
    const { ctx, p, errors } = await open(1440, { rewrite: [[NOTE(N1), longNote]] });
    await goto(p, `/stock/dispatch-notes/${N1}`);
    const sheet = p.getByTestId('dispatch-note-sheet');
    const rows = await sheet.locator('tbody tr').count();
    const geometry = await sheet.evaluate((el) => {
      const table = el.querySelector('table').getBoundingClientRect();
      const keeps = [...el.querySelectorAll('[data-print-keep]')].map((k) => k.getBoundingClientRect());
      const signatures = keeps[keeps.length - 1];
      return { position: getComputedStyle(el).position, tableBottom: Math.round(table.bottom), signaturesTop: Math.round(signatures.top), keeps: keeps.length };
    });
    const file = await shoot(p, 'note-40-lines', { fullPage: true });
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock/dispatch-notes/{doc:90000}', fixture: ['GET /stock-issues/{id}: 40 lines'] },
      measured: { rows, geometry, errors },
      pass: rows === 40 && geometry.position === 'static' && geometry.signaturesTop > geometry.tableBottom && geometry.keeps >= 3 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('note-print-pdf', ['E12-J06', 'E12-R09'], async () => {
    const { ctx, p, errors, route } = await open(1440, { rewrite: [[NOTE(N1), longNote]] });
    await goto(p, `/stock/dispatch-notes/${N1}`);
    const bytes = await p.pdf({ path: job.pdf, format: 'A4', printBackground: true });
    const text = bytes.toString('latin1');
    const pages = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
    // The app's own errors end here: on the viewer's page the harness's init script has no
    // sessionStorage to read, and that is the harness, not the app.
    const appErrors = errors.slice();
    // The PDF in the browser's own viewer, page by page — served here, never by the stand.
    await route(/^http:\/\/e12-pdf\.local\//, (r) => r.fulfill({ status: 200, path: job.pdf, contentType: 'application/pdf' }));
    const shots = [];
    for (let i = 1; i <= Math.min(pages, 4); i += 1) {
      // A fresh load for every page: a change of the fragment alone leaves the viewer where it was.
      await p.goto('about:blank').catch(() => {});
      await p.goto(`http://e12-pdf.local/note-40-lines.pdf#page=${i}`, { waitUntil: 'load' }).catch(() => {});
      await p.waitForTimeout(2500);
      shots.push(await shoot(p, `note-pdf-page-${i}`));
    }
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock/dispatch-notes/{doc:90000} → page.pdf A4', fixture: ['GET /stock-issues/{id}: 40 lines'], artifact: 'note-40-lines.pdf' },
      measured: { pages, size: bytes.length, errors: appErrors, viewer_errors: errors.length - appErrors.length },
      pass: pages >= 2 && appErrors.length === 0,
      screenshots: shots,
    };
  });

  await scenario('print-emulation@1440', ['E12-J06'], async () => {
    const { ctx, p, errors } = await open(1440, { rewrite: [[NOTE(N1), longNote]] });
    await goto(p, `/stock/dispatch-notes/${N1}`);
    await p.emulateMedia({ media: 'print' });
    await p.waitForTimeout(500);
    const printed = await p.evaluate(() => {
      const sheet = document.querySelector('[data-print-sheet]');
      const controls = document.querySelector('[data-testid="dispatch-note-controls"]');
      const visible = (el) => !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
      const others = [...document.body.querySelectorAll('nav, aside, header')].filter((el) => !sheet.contains(el) && visible(el));
      return {
        sheet: visible(sheet),
        controls: visible(controls),
        others: others.length,
        thead: getComputedStyle(sheet.querySelector('thead')).display,
        row: getComputedStyle(sheet.querySelector('tbody tr')).breakInside,
        keep: [...sheet.querySelectorAll('[data-print-keep]')].map((k) => getComputedStyle(k).breakInside),
        // White paper under the sheet in the dark theme: a light scheme on the root, no ground on the body.
        scheme: getComputedStyle(document.documentElement).colorScheme,
        ground: getComputedStyle(document.body).backgroundColor,
      };
    });
    const file = await shoot(p, 'print-emulation', { fullPage: true });
    await ctx.close();
    return {
      env: { viewport: [1440, 900], media: 'print' },
      recipe: { url: '/stock/dispatch-notes/{doc:90000}', fixture: ['40 lines'], media: 'print' },
      measured: { printed, errors },
      pass: printed.sheet && !printed.controls && printed.others === 0 && printed.thead === 'table-header-group' &&
        printed.row === 'avoid' && printed.keep.length >= 3 && printed.keep.every((k) => k === 'avoid') &&
        printed.scheme === 'light' && printed.ground === 'rgba(0, 0, 0, 0)' && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('supplier-general@1440', ['E12-J07'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, '/settings');
    const general = await p.getByRole('heading', { name: 'Реквізити для документів' }).count();
    const file = await shoot(p, 'supplier-general');
    await goto(p, '/settings?tab=printing');
    const printing = await p.getByRole('heading', { name: 'Реквізити для документів' }).count();
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/settings; /settings?tab=printing' },
      measured: { general, printing, errors },
      pass: general === 1 && printing === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ---------------------------------------------------------------- the keyboard
  await scenario('keyboard@1440', ['E2-C02', 'E12-B03', 'E12-C01', 'E12-C05', 'E12-J03'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, '/stock');
    await p.getByRole('tab', { name: 'Готові вироби' }).focus();
    await p.keyboard.press('ArrowRight');
    const arrow = { focus: await focusAt(p), url: await urlOf(p) };
    await p.keyboard.press('Enter');
    await p.waitForTimeout(800);
    const entered = await urlOf(p);
    await goto(p, '/stock');
    await p.getByTestId(`finished-${P1}-menu`).focus();
    await p.keyboard.press('Enter');
    await p.waitForTimeout(300);
    const menuFirst = await focusAt(p);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    const menuBack = await focusAt(p);
    await goto(p, '/stock?tab=notes');
    const pencil = p.getByRole('button', { name: 'Змінити ТТН' }).first();
    await pencil.focus();
    await p.keyboard.press('Enter');
    await p.waitForTimeout(300);
    const editor = await focusAt(p);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    const editorBack = await focusAt(p);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock', actions: ['ArrowRight + Enter on the tabs', 'Enter / Escape on a row menu', 'Enter / Escape on a waybill pencil'] },
      measured: { arrow, entered, menuFirst, menuBack, editor, editorBack, errors },
      pass: arrow.focus === 'Вільні деталі' && arrow.url === '/stock' && entered === '/stock?tab=parts' &&
        menuFirst === 'Надходження' && menuBack === 'Дії' && editor === 'ТТН' && editorBack === 'Змінити ТТН' && errors.length === 0,
    };
  });

  // ---------------------------------------------------------------- boundaries
  for (const w of [1101, 1100, 561, 560]) {
    await scenario(`stats-${w}`, ['E12-B02', 'E12-L1'], async () => {
      const { ctx, p, errors } = await open(w);
      await goto(p, '/stock');
      const tops = await p.locator('[data-testid^="finished-tile-"]').evaluateAll((ts) => ts.map((t) => Math.round(t.getBoundingClientRect().top)));
      const overflow = await docOverflow(p);
      await ctx.close();
      const expect = w > 1100 ? 4 : w > 560 ? 2 : 1;
      return {
        env: { viewport: [w, HEIGHTS[w] ?? 800] },
        recipe: { url: '/stock' },
        measured: { tops, overflow, errors },
        pass: perRow(tops) === expect && overflow <= 0 && errors.length === 0,
      };
    });
  }

  for (const w of [1101, 1100, 761, 760]) {
    await scenario(`position-${w}`, ['E12-F04', 'E12-L1'], async () => {
      const { ctx, p, errors } = await open(w);
      await goto(p, `/stock/${P1}`);
      const cards = await p.getByTestId('item-cards').evaluate((g) => [...g.children].map((c) => { const r = c.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }; }));
      const overflow = await docOverflow(p);
      const file = await shoot(p, `position-${w}`);
      await ctx.close();
      const two = w > 1100;
      return {
        env: { viewport: [w, HEIGHTS[w] ?? 800] },
        recipe: { url: '/stock/{fin:1}' },
        measured: { cards, overflow, errors },
        pass: cards.length === 2 && overflow <= 0 && (two ? cards[1].l >= cards[0].r : cards[1].t >= cards[0].b) && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('finished-long', ['E12-C03', 'E12-L1'], async () => {
    const long = 'Дифузор для декоративної настільної лампи з подвійною стінкою і розсіювачем — версія для подарункової коробки';
    const { ctx, p, errors } = await open(1440, { rewrite: [firstItem((it) => ({ ...it, product: { ...it.product, name: long }, configuration: { choices: [{ group_id: 1, group_name: 'Колір корпусу й абажура', option_id: 2, option_name: 'Графітовий матовий з бронзовою окантовкою', is_default: false }], changed_parts: [{ part_id: 3, name: 'Кришка', qty: 2, standard_qty: 1 }] } }))] });
    await goto(p, '/stock');
    const overflow = await docOverflow(p);
    const first = p.locator('[data-testid^="finished-row-"]').first();
    const accent = await first.locator('[data-config-accent]').count();
    const file = await shoot(p, 'finished-long');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock', fixture: ['the first row: a long name and a long configuration'] },
      measured: { overflow, accent, errors },
      pass: overflow <= 0 && accent === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('notes-long', ['E12-J01', 'E12-L1'], async () => {
    const { ctx, p, errors } = await open(1440, { rewrite: [firstNote((n) => ({ ...n, waybill: '590001234567890123456789', summary: n.summary.map((l) => ({ ...l, product_name: `${l.product_name} — подарунковий набір з трьох предметів у коробці` })) }))] });
    await goto(p, '/stock?tab=notes');
    const overflow = await docOverflow(p);
    const file = await shoot(p, 'notes-long');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/stock?tab=notes', fixture: ['the first note: a 24-character waybill and long names'] },
      measured: { overflow, errors },
      pass: overflow <= 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  for (const [w, h] of [[390, 600], [1024, 600]]) {
    await scenario(`issue-short@${w}x${h}`, ['E12-G05', 'E12-L1'], async () => {
      const { ctx, p, errors } = await open(w, { h });
      await goto(p, `/stock/${P1}`);
      await p.getByTestId('item-actions').getByRole('button', { name: 'Видати' }).click();
      const d = dialogOf(p, 'Видача');
      await d.waitFor();
      await d.getByLabel('Замовник').selectOption(String(CU1));
      await p.waitForTimeout(1200);
      const primary = await hits(p, d.getByTestId('stock-move-submit'));
      const scrolls = await d.evaluate((el) => [...el.querySelectorAll('*')].some((n) => n.scrollHeight > n.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)));
      const panel = await box(d);
      const file = await shoot(p, `issue-short-${w}x${h}`);
      await ctx.close();
      return {
        env: { viewport: [w, h] },
        recipe: { url: '/stock/{fin:1} → «Видати» → a customer' },
        measured: { primary, scrolls, panel, errors },
        pass: primary.hits && scrolls && panel.l >= 0 && panel.r <= w && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('narrow@390', ['E12-L1'], async () => {
    const { ctx, p, errors } = await open(390);
    const out = {};
    const files = [];
    for (const [key, path] of [['stock', '/stock'], ['parts', '/stock?tab=parts'], ['position', `/stock/${P1}`], ['note', `/stock/dispatch-notes/${N1}`]]) {
      await goto(p, path);
      out[key] = await docOverflow(p);
      files.push(await shoot(p, `narrow-${key}`));
    }
    await ctx.close();
    return {
      env: { viewport: [390, 844] },
      recipe: { url: '/stock; /stock?tab=parts; /stock/{fin:1}; /stock/dispatch-notes/{doc:90000}' },
      measured: { ...out, errors },
      pass: Object.values(out).every((o) => o <= 0) && errors.length === 0,
      screenshots: files,
    };
  });

  for (const [id, opts, test] of [
    ['theme-light@1440', { storage: { 'theme-mode': 'light' } }, (e) => !/\bdark\b/.test(e.theme)],
    ['theme-oled@1440', { settings: { dark_background: 'oled' } }, (e) => /bg-oled/.test(e.theme)],
  ]) {
    await scenario(id, ['E2-B01', 'E12-F01', 'E12-J05'], async () => {
      const { ctx, p, errors } = await open(1440, opts);
      await goto(p, `/stock/${P1}`);
      const e = await env(p);
      const files = [await shoot(p, `${id}-position`)];
      await goto(p, `/stock/dispatch-notes/${N1}`);
      const sheetBg = await p.getByTestId('dispatch-note-sheet').evaluate((el) => getComputedStyle(el).backgroundColor);
      files.push(await shoot(p, `${id}-note`));
      await ctx.close();
      return {
        env: e,
        recipe: { url: '/stock/{fin:1}; /stock/dispatch-notes/{doc:90000}' },
        measured: { sheetBg, errors },
        pass: test(e) && sheetBg === 'rgb(255, 255, 255)' && errors.length === 0,
        screenshots: files,
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
