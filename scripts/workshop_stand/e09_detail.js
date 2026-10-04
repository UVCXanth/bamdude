// WS-13 E9 acceptance runner (spec §I1/I2), run by Playwright MCP's browser_run_code_unsafe:
//   filename: scripts/workshop_stand/e09_detail.js — while `e09_evidence.py serve` listens on 127.0.0.1:8197.
// The harness is E4's (e04_detail.js, via E7 and E8), unchanged in what it guarantees: every scenario records WHAT was
// run (recipe + fixtures), WHERE (viewport, DPR, the actual <html> classes), WHAT was measured and whether it
// matched the spec — a failure is a failure, a surface it cannot reach is `pending`. Nothing reaches the stand but
// reads: every non-GET request of every context is answered here, and the states the baseline does not hold are
// rewritten GET answers in this runner's own context only. The oracles measure what a person reads (widths, the
// order of facts, text, where a control sits, whether a click lands, scrollY), never a class name — except where
// the spec names the geometry rule itself (clamp(260px, 17vw, 360px), 240 px, one column below 761).
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
      if (sessionStorage.getItem('e09-init')) return;
      sessionStorage.setItem('e09-init', '1');
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
      if (step && step.fail) return route.fulfill({ status: step.fail, json: { detail: 'e09 runner' } });
      // A body of the runner's own — the stand is never asked.
      if (step && step.json) return route.fulfill({ status: 200, json: step.json });
      // A picture of the runner's own (the cover fixture, K11): a real PNG file.
      if (step && step.file) return route.fulfill({ status: 200, path: step.file, contentType: 'image/png' });
      const failing = fail.find(([re]) => re.test(url));
      if (failing) return route.fulfill({ status: failing[1], json: { detail: 'e09 runner' } });
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
  // The mockup products (spec §I1, T0): 1 — variants, bought parts, 52 linked files through one
  // folder, two positions, documents, eight orders; 8 — no variants, one position; 900 — the one-off.
  const P = job.products ?? {};
  const P1 = P['1'] ?? 1;
  const P8 = P['8'] ?? 8;
  const P900 = P['900'] ?? 900;
  const detail1 = await read(`/products/${P1}`);
  const detail8 = await read(`/products/${P8}`);
  const files1 = await read(`/products/${P1}/files`);
  const groups = await read('/groups/');
  const groupList = Array.isArray(groups) ? groups : (groups.items ?? []);
  const adminPerms = (groupList.find((g) => g.name === 'Administrators') ?? { permissions: [] }).permissions;
  const READER = { is_admin: false, role: 'user', permissions: adminPerms.filter((perm) => perm.endsWith(':read') || !/^(orders|products|customers|stock):/.test(perm)) };
  // An editor without the library (R02, K9): every projects permission, no library read.
  const NO_LIBRARY = { is_admin: false, role: 'user', permissions: adminPerms.filter((perm) => !perm.startsWith('library:')) };

  // --- doors and oracles ---
  const DETAIL = (id) => new RegExp(`/api/v1/products/${id}/?(\\?.*)?$`);
  const ESTIMATE = (id) => new RegExp(`/api/v1/products/${id}/estimate`);
  const SOURCES = (id) => new RegExp(`/api/v1/products/${id}/sources`);
  const FILES = (id) => new RegExp(`/api/v1/products/${id}/files/?(\\?.*)?$`);
  const SHELF = (id) => new RegExp(`/api/v1/products/${id}/stock`);
  const POSITIONS = /\/api\/v1\/stock\/items\?/;
  const JOURNAL = /\/api\/v1\/stock\/journal\?/;
  const ORDERS = /\/api\/v1\/projects\/\?/;
  const TABS = ['Склад виробу', 'Плити й файли', 'Залишки', 'Документи', 'Замовлення'];
  const FACTS = ['Готовність', 'Нарізано під', 'Матеріал / колір (з плит)', 'Оцінка на 1 виріб (стандартна конфігурація)', 'Склад'];
  const goto = async (p, id, query = '') => {
    await p.goto(`${job.ui}/products/${id}${query}`, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(700);
  };
  const tab = (p, name) => p.getByRole('tab', { name: new RegExp(`^${name}`) });
  const openTab = async (p, name) => {
    await tab(p, name).click();
    await p.waitForLoadState('networkidle');
    await p.waitForTimeout(500);
  };
  const docOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
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
  const toastText = (p, re, ms = 6000) => within(p.waitForFunction((src) => {
    const rx = new RegExp(src);
    return [...document.querySelectorAll('body *')].some((el) => el.children.length === 0 && rx.test(el.textContent ?? ''));
  }, re.source), ms, 'no_toast');
  const textOf = (locator) => locator.evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim());
  const recorder = (store, re, answerOf) => [re, async (req) => {
    let body = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    const entry = { method: req.method(), path: new URL(req.url()).pathname + new URL(req.url()).search, body };
    store.push(entry);
    return answerOf ? answerOf(entry, store.length) : {};
  }];
  const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) }; });
  const menuItems = (p) => p.getByRole('menuitem').evaluateAll((ms) => ms.map((m) => m.textContent.trim()));
  const urlOf = (p) => p.evaluate(() => location.pathname + location.search);
  const count = (requests, re) => requests.filter((r) => re.test(r)).length;
  // Words of the parts' names that a line break cut in two — each word a Range, a word on two
  // lines has rects on two tops (E8's rule, the owner's F6: words stay whole).
  const splitNames = (p) => p.evaluate(() => {
    const split = [];
    for (const el of document.querySelectorAll('[data-testid^="part-"][data-testid$="-row"] td:first-child')) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const re = /[^\s\-‐–—]+/g;
        let m;
        while ((m = re.exec(node.textContent))) {
          const r = document.createRange();
          r.setStart(node, m.index);
          r.setEnd(node, m.index + m[0].length);
          const tops = new Set([...r.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top)));
          if (tops.size > 1) split.push(m[0]);
        }
      }
    }
    return split;
  });
  // Where the focus is after a row left with a re-read (B11-4): «H1», or the tag and its name.
  const focusAt = (p) => p.evaluate(() => {
    const a = document.activeElement;
    if (!a) return '';
    return a.tagName === 'H1' ? 'H1' : `${a.tagName}:${(a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 30)}`;
  });
  // Menu items whose text the menu cuts (a fixed width, a scrolling panel).
  const clippedItems = (p) => p.getByRole('menuitem').evaluateAll((ms) => ms.filter((m) => m.scrollWidth > m.clientWidth + 1).map((m) => m.textContent.trim()));
  const textContrast = (locator) => locator.evaluate((el) => {
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
  // A file group of the files answer, made from a real one and changed only where the fixture says.
  const fileOf = (over) => ({ ...(files1.files?.[0] ?? {}), plates: [], ...over });
  const estimate = (over) => ({ prints: 2, print_time_seconds: 11100, filament_grams: 233, filament_cost: null, surplus: [], purchased_cost: null, purchased_known_cost: 0, purchased_partial: false, complete: true, reasons: [], ...over });
  const journalRow = (book, id, extra = {}) => ({
    book, id, created_at: '2026-09-20T10:00:00', product_id: P1, product_name: detail1.name, item: null, kind: book === 'finished' ? 'receipt' : 'manual',
    note: null, project: null, issue: null, customer: null, user: null,
    ...(book === 'finished' ? { delta_on_hand: 1, delta_reserved: 0 } : { delta: 1, part_name: `Деталь ${id}` }), ...extra,
  });
  const journalPage = (items, page, last, total) => ({ items, next_cursor: null, meta: { total, current_page: page, per_page: 24, last_page: last } });

  // ======================= 1. the header and its menu (B01–B02) =======================
  await scenario('header@1440', ['E9-B01', 'E9-B02', 'P05'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, P1);
    const crumbs = await textOf(p.getByRole('navigation', { name: 'Навігація' }));
    const h1 = await textOf(p.locator('h1'));
    const identity = await textOf(p.getByTestId('product-identity').first());
    const buttons = await p.locator('header').getByRole('button').evaluateAll((bs) => bs.map((b) => (b.textContent.trim() || b.getAttribute('aria-label') || '').trim()));
    await p.getByTestId('product-page-menu').click();
    await p.getByRole('menuitem').first().waitFor({ timeout: 5000 });
    const items = await menuItems(p);
    const clipped = await clippedItems(p);
    const file = await shoot(p, 'header@1440');
    await ctx.close();
    return {
      recipe: { url: `/products/{product:1}`, actions: ['open «⋮»'] },
      measured: { crumbs, h1, identity, buttons, items, clipped, errors },
      pass: crumbs.startsWith('Вироби') && crumbs.includes(detail1.name) && h1.startsWith(detail1.name) && identity.startsWith(detail1.code) &&
        buttons.includes('До замовлення') && buttons.includes('Редагувати') &&
        JSON.stringify(items) === JSON.stringify(['Дублювати', 'Експорт ZIP', 'Перечитати картку з файлу…', 'Прибрати з каталогу', 'Видалити']) &&
        clipped.length === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('header-reader@1440', ['E9-B01', 'E9-B02'], async () => {
    const { ctx, p, errors } = await open(1440, { me: READER });
    await goto(p, P1);
    const buttons = await p.locator('header').getByRole('button').evaluateAll((bs) => bs.map((b) => (b.textContent.trim() || b.getAttribute('aria-label') || '').trim()));
    await p.getByTestId('product-page-menu').click();
    await p.getByRole('menuitem').first().waitFor({ timeout: 5000 });
    const items = await menuItems(p);
    const box1 = await p.getByRole('checkbox', { name: 'У каталозі' }).isDisabled();
    const file = await shoot(p, 'header-reader@1440');
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}', fixture: ['GET /auth/me: a reader — the Workshop’s reads only (merged)'] },
      measured: { buttons, items, catalogBoxDisabled: box1, errors },
      pass: !buttons.includes('Редагувати') && !buttons.includes('До замовлення') && JSON.stringify(items) === JSON.stringify(['Експорт ZIP']) && box1 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('header-adhoc@1440', ['E9-B02', 'E9-B04', 'E9-B10', 'R09'], async () => {
    const out = {};
    const files = [];
    for (const active of [true, false]) {
      const { ctx, p } = await open(1440, { rewrite: [[DETAIL(P900), (b) => ({ ...b, is_active: active })]] });
      await goto(p, P900);
      const boxEl = p.getByRole('checkbox', { name: 'У каталозі' });
      await p.getByTestId('product-page-menu').click();
      await p.getByRole('menuitem').first().waitFor({ timeout: 5000 });
      out[active ? 'visible' : 'hidden'] = {
        banner: await p.getByTestId('product-adhoc-banner').count(),
        toOrder: await p.getByRole('button', { name: 'До замовлення' }).count(),
        items: await menuItems(p),
        checked: await boxEl.isChecked(),
        disabled: await boxEl.isDisabled(),
        hint: await boxEl.evaluate((el) => document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent ?? ''),
      };
      files.push(await shoot(p, `header-adhoc-${active ? 'visible' : 'hidden'}@1440`));
      await ctx.close();
    }
    const ok = (s, checked) => s.banner === 1 && s.toOrder === 0 && s.items.includes('Додати в каталог…') && s.checked === checked && s.disabled && /Додати в каталог/.test(s.hint);
    return {
      recipe: { url: '/products/{product:900}', fixture: ['GET /products/{900}: is_active true, then false (rewritten)'] },
      measured: out,
      pass: ok(out.visible, true) && ok(out.hidden, false),
      screenshots: files,
    };
  });

  // ======================= 2. re-read (B03, B11, R02, R08) =======================
  const rereadFiles = () => ({
    ...files1,
    files: [
      fileOf({ library_file_id: 9001, filename: 'body-x1c.gcode.3mf', hidden: false, sliced_any: true, printer_model: 'X1C', is_3mf: true, in_linked_folder: false }),
      fileOf({ library_file_id: 9002, filename: 'body-raw.3mf', hidden: false, sliced_any: false, printer_model: null, is_3mf: true, in_linked_folder: false }),
      fileOf({ library_file_id: 9003, filename: 'body.gcode', hidden: false, sliced_any: true, printer_model: 'P1S', is_3mf: false, in_linked_folder: false }),
      fileOf({ library_file_id: 9004, filename: 'body.stl', hidden: false, sliced_any: false, printer_model: null, is_3mf: false, in_linked_folder: false }),
      fileOf({ library_file_id: 9005, filename: null, hidden: true, folder_name: null, sliced_any: true, printer_model: 'X1C', is_3mf: true, in_linked_folder: false }),
    ],
  });
  await scenario('reread@1440', ['E9-B03', 'E9-B11', 'R02', 'R08'], async () => {
    const posts = [];
    const { ctx, p, errors } = await open(1440, {
      rewrite: [[FILES(P1), rereadFiles]],
      writes: [recorder(posts, /\/card\/reread/, () => new Promise((r) => setTimeout(() => r({ notes: [{ code: 'nothing_to_fill' }], product: detail1 }), 1200)))],
    });
    await goto(p, P1);
    await p.getByTestId('product-page-menu').click();
    await p.getByRole('menuitem', { name: 'Перечитати картку з файлу…' }).click();
    const dialog = p.getByRole('dialog', { name: 'Перечитати картку з файлу' });
    await dialog.getByRole('radio').first().waitFor({ timeout: 8000 });
    const radios = await dialog.getByRole('radio').evaluateAll((rs) => rs.map((r) => ({ checked: r.checked, name: r.closest('label').textContent.replace(/\s+/g, ' ').trim() })));
    const submit = dialog.getByRole('button', { name: /^Перечитати/ });
    const disabledBefore = await submit.isDisabled();
    await dialog.getByRole('radio').nth(1).check();
    await submit.dblclick();
    await p.waitForTimeout(200);
    await p.keyboard.press('Escape');
    const stillOpen = await dialog.count();
    const file = await shoot(p, 'reread@1440');
    await toastText(p, /Нічого заповнювати/);
    await p.waitForTimeout(500);
    const closed = (await dialog.count()) === 0;
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}', fixture: ['GET /products/{1}/files: sliced 3MF, unsliced 3MF, raw .gcode, STL, a hidden 3MF (rewritten)', 'POST …/card/reread: answered here after 1.2 s'] },
      measured: { radios, disabledBefore, posts: posts.length, stillOpenAfterEscape: stillOpen, closed, errors },
      pass: radios.length === 2 && radios.every((r) => !r.checked) && radios[0].name.includes('X1C') && radios[1].name.includes('не нарізано') &&
        disabledBefore && posts.length === 1 && /file_id=9002/.test(posts[0].path) && stillOpen === 1 && closed && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('reread-states@1440', ['E9-B03', 'R02', 'R08'], async () => {
    const phase = 'one';
    const one = () => ({ ...files1, files: [fileOf({ library_file_id: 9001, filename: 'only.3mf', hidden: false, sliced_any: true, printer_model: 'X1C', is_3mf: true })] });
    const { ctx, p, errors } = await open(1440, {
      gets: [[FILES(P1), () => (phase === 'fail' ? { fail: 500 } : phase === 'empty' ? { json: { ...files1, files: [] } } : { json: one() })]],
      writes: [[/\/card\/reread/, { notes: [{ code: 'file_missing' }], product: detail1 }]],
    });
    await goto(p, P1);
    const openReread = async () => {
      await p.getByTestId('product-page-menu').click();
      await p.getByRole('menuitem', { name: 'Перечитати картку з файлу…' }).click();
      await p.waitForTimeout(800);
    };
    await openReread();
    const dialog = p.getByRole('dialog', { name: 'Перечитати картку з файлу' });
    const chosen = await dialog.getByRole('radio').first().isChecked();
    await dialog.getByRole('button', { name: /^Перечитати/ }).click();
    await p.waitForTimeout(800);
    const missing = { open: await dialog.count(), alert: await dialog.getByRole('alert').count() };
    const fileMissing = await shoot(p, 'reread-file-missing@1440');
    await dialog.getByRole('button', { name: 'Скасувати' }).click();
    await ctx.close();
    const { ctx: c2, p: p2 } = await open(1440, { gets: [[FILES(P1), () => ({ json: { ...files1, files: [] } })]] });
    await goto(p2, P1, '?tab=composition');
    await p2.getByTestId('product-page-menu').click();
    await p2.getByRole('menuitem', { name: 'Перечитати картку з файлу…' }).click();
    await p2.waitForTimeout(800);
    const empty = await p2.getByText('Серед прив’язаних файлів немає 3MF, доступного вам.').count();
    await c2.close();
    const { ctx: c3, p: p3 } = await open(1440, { gets: [[FILES(P1), () => ({ fail: 500 })]] });
    await goto(p3, P1);
    await p3.getByTestId('product-page-menu').click();
    await p3.getByRole('menuitem', { name: 'Перечитати картку з файлу…' }).click();
    await p3.waitForTimeout(1500);
    const failed = await p3.getByText('Не вдалося завантажити прив’язані файли.').count();
    const fileFailed = await shoot(p3, 'reread-failed@1440');
    await c3.close();
    return {
      recipe: { url: '/products/{product:1}', fixture: ['GET …/files: one 3MF / none / 500 (answered here)', 'POST …/card/reread: notes file_missing'] },
      measured: { chosen, missing, empty, failed, errors },
      pass: chosen && missing.open === 1 && missing.alert === 1 && empty === 1 && failed === 1 && errors.length === 0,
      screenshots: [fileMissing, fileFailed],
    };
  });

  // ======================= 3. layout, scroll, route (B05, C03, C04, R05) =======================
  for (const [w, side] of [[2560, 360], [1440, 260], [1101, 260], [1100, 240], [761, 240], [760, null], [390, null]]) {
    await scenario(`layout@${w}`, ['E9-B05', 'K2', 'P05'], async () => {
      const { ctx, p, errors } = await open(w);
      await goto(p, P1);
      const sideBox = await box(p.getByTestId('product-side'));
      const mainBox = await box(p.getByTestId('product-main'));
      const overflow = await docOverflow(p);
      const strip = await p.getByRole('tablist').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, overflowX: getComputedStyle(el).overflowX }));
      const split = await splitNames(p);
      const file = await shoot(p, `layout@${w}`);
      await ctx.close();
      const oneColumn = side == null;
      return {
        recipe: { url: '/products/{product:1}', viewport: w },
        measured: { side: sideBox, main: mainBox, overflow, strip, split, errors },
        pass: overflow <= 0 && errors.length === 0 && split.length === 0 && (oneColumn ? sideBox.b <= mainBox.t + 1 && Math.abs(sideBox.w - mainBox.w) <= 1 : Math.abs(sideBox.w - side) <= 1 && Math.abs(mainBox.l - sideBox.r - 16) <= 1) &&
          (strip.scroll <= strip.client || strip.overflowX === 'auto'),
        screenshots: [file],
      };
    });
  }

  for (const w of [1440, 390]) {
    await scenario(`scroll@${w}`, ['E9-C03', 'R05'], async () => {
      // A long «Orders» tab — the stand's first order 24 times (rewritten) — so the document a first
      // visit lands on is not short enough to have put the strip back on screen by itself.
      const longOrders = (b) => ({
        ...b,
        items: Array.from({ length: 24 }, (_, i) => ({ ...(b.items?.[0] ?? {}), id: 990000 + i, code: `OR-9${String(i).padStart(3, '0')}` })),
        meta: { ...(b.meta ?? {}), total: 24, current_page: 1, last_page: 1 },
      });
      const { ctx, p, errors } = await open(w, { rewrite: [[ORDERS, longOrders]] });
      await goto(p, P1, '?tab=plates');
      await p.waitForTimeout(800);
      await p.evaluate(() => window.scrollTo(0, 1600));
      await p.waitForTimeout(300);
      const before = await p.evaluate(() => scrollY);
      const appTop = await p.evaluate(() => { const v = document.documentElement.style.getPropertyValue('--app-top').trim(); const n = parseFloat(v); return Number.isFinite(n) ? (v.endsWith('rem') ? n * 16 : n) : 0; });
      const stripTop = () => p.getByRole('tablist').evaluate((el) => Math.round(el.getBoundingClientRect().top));
      // A click that scrolls nothing: Playwright's own would bring the strip into view first.
      await p.evaluate(() => {
        window.__e09 = [];
        const note = (why) => window.__e09.push(`${why}:${Math.round(scrollY)}/${document.documentElement.scrollHeight}`);
        addEventListener('scroll', () => note('scroll'));
        window.__e09note = note;
        const where = () => (new Error().stack ?? '').split('\n').slice(2, 4).map((l) => l.trim().replace(/https?:\/\/[^/]+/, '').slice(0, 90)).join(' < ');
        const st = window.scrollTo.bind(window);
        window.scrollTo = (...a) => { window.__e09.push(`scrollTo(${JSON.stringify(a)}) ${where()}`); return st(...a); };
        const siv = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (...a) { window.__e09.push(`scrollIntoView ${this.tagName} ${where()}`); return siv.apply(this, a); };
        const fo = HTMLElement.prototype.focus;
        HTMLElement.prototype.focus = function (...a) { window.__e09.push(`focus ${this.tagName}${a[0]?.preventScroll ? ':noscroll' : ''} ${where()}`); return fo.apply(this, a); };
      });
      await tab(p, 'Замовлення').evaluate((el) => { window.__e09note('before'); el.click(); window.__e09note('after-click'); });
      await p.waitForLoadState('networkidle');
      await p.waitForTimeout(800);
      const longFirst = await stripTop();
      const trace = await p.evaluate(() => window.__e09.slice(0, 40));
      // A short tab, first visit, strip already on screen: the page does not move.
      const yBeforeShort = await p.evaluate(() => scrollY);
      await tab(p, 'Документи').evaluate((el) => el.click());
      await p.waitForTimeout(600);
      const shortFirst = { strip: await stripTop(), y: await p.evaluate(() => scrollY) };
      await tab(p, 'Плити й файли').evaluate((el) => el.click());
      await p.waitForTimeout(600);
      const back = await p.evaluate(() => scrollY);
      const file = await shoot(p, `scroll@${w}`);
      await ctx.close();
      return {
        recipe: { url: '/products/{product:1}?tab=plates', viewport: w, fixture: ['GET /projects/?product_id: 24 orders (rewritten)'], actions: ['scroll to 1600', '«Замовлення» (first visit, long)', '«Документи» (first visit, short)', '«Плити й файли» (back)'] },
        measured: { before, appTop, longFirst, yBeforeShort, shortFirst, back, trace, errors },
        pass: before > 1000 && Math.abs(longFirst - appTop) <= 2 && shortFirst.strip >= appTop - 1 && shortFirst.y <= yBeforeShort &&
          Math.abs(back - before) <= 2 && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('route@1440', ['E9-C03', 'R05'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, P1, '?tab=orders');
    const direct = await tab(p, 'Замовлення').getAttribute('aria-selected');
    await p.reload({ waitUntil: 'networkidle' });
    const afterReload = await tab(p, 'Замовлення').getAttribute('aria-selected');
    const entries = await p.evaluate(() => history.length);
    await tab(p, 'Документи').click();
    await p.waitForTimeout(400);
    const docsUrl = await urlOf(p);
    await tab(p, 'Склад виробу').click();
    await p.waitForTimeout(400);
    const compUrl = await urlOf(p);
    const entriesAfter = await p.evaluate(() => history.length);
    await goto(p, P1, '?tab=nonsense');
    const unknown = { selected: await tab(p, 'Склад виробу').getAttribute('aria-selected'), url: await urlOf(p) };
    await goto(p, P8);
    const other = { selected: await tab(p, 'Склад виробу').getAttribute('aria-selected'), url: await urlOf(p) };
    await p.goBack({ waitUntil: 'networkidle' });
    const back = await urlOf(p);
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}?tab=orders', actions: ['F5', '«Документи»', '«Склад виробу»', '?tab=nonsense', 'another product', 'Back'] },
      measured: { direct, afterReload, entries, entriesAfter, docsUrl, compUrl, unknown, other, back, errors },
      pass: direct === 'true' && afterReload === 'true' && entries === entriesAfter && docsUrl.endsWith('?tab=docs') && !compUrl.includes('tab=') &&
        unknown.selected === 'true' && unknown.url.endsWith('?tab=nonsense') && other.selected === 'true' && !other.url.includes('tab=') &&
        back.endsWith('?tab=nonsense') && errors.length === 0,
      screenshots: [],
    };
  });

  await scenario('states@1440', ['E9-C04'], async () => {
    // The product's answer held back long enough for a dev server that is still bundling.
    const { ctx, p, errors } = await open(1440, { delay: [[DETAIL(P1), 8000]] });
    await p.goto(`${job.ui}/products/${P1}`);
    await p.getByTestId('product-page-skeleton').waitFor({ timeout: 7000 });
    const skeleton = await shoot(p, 'states-skeleton@1440');
    await ctx.close();
    const { ctx: c2, p: p2 } = await open(1440, { fail: [[DETAIL(P1), 500]] });
    await goto(p2, P1);
    await p2.waitForTimeout(1500);
    const failed = { alert: await p2.getByRole('alert').count(), retry: await p2.getByRole('button', { name: 'Спробувати знову' }).count() };
    const fileFailed = await shoot(p2, 'states-failed@1440');
    await c2.close();
    const { ctx: c3, p: p3 } = await open(1440);
    await goto(p3, 987654);
    await p3.waitForTimeout(800);
    const notFound = { text: await p3.getByText('Виріб не знайдено').count(), link: await p3.getByRole('link', { name: 'До каталогу' }).getAttribute('href') };
    const fileNotFound = await shoot(p3, 'states-404@1440');
    await c3.close();
    return {
      recipe: { url: '/products/{product:1}', fixture: ['GET /products/{1}: 8 s late / 500 (answered here)', 'GET /products/987654: the server’s 404'] },
      measured: { failed, notFound, errors },
      pass: failed.alert >= 1 && failed.retry === 1 && notFound.text === 1 && notFound.link === '/products' && errors.length === 0,
      screenshots: [skeleton, fileFailed, fileNotFound],
    };
  });

  // ======================= 4. the side panel (B06–B10, R06, R07, R11) =======================
  await scenario('facts@1440', ['E9-B07', 'E9-B08', 'E9-B09', 'P05'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, P1);
    const side = p.getByTestId('product-side');
    const labels = await side.locator('dt').evaluateAll((ds) => ds.map((d) => d.textContent.trim()));
    const estimateText = await textOf(p.getByTestId('product-estimate'));
    const stock = await textOf(p.getByTestId('product-stock-fact'));
    const source = await p.getByTestId('product-source').count();
    const box1 = { checked: await p.getByRole('checkbox', { name: 'У каталозі' }).isChecked(), disabled: await p.getByRole('checkbox', { name: 'У каталозі' }).isDisabled() };
    const file = await shoot(p, 'facts@1440');
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}' },
      measured: { labels, estimate: estimateText, stock, source, catalogBox: box1, errors },
      pass: JSON.stringify(labels.slice(0, 5)) === JSON.stringify(FACTS) && /·/.test(estimateText) && /готов/.test(stock) && /компл\./.test(stock) &&
        box1.checked && !box1.disabled && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('estimate@1440', ['E9-B08', 'R06', 'R11'], async () => {
    const cases = [
      ['no_plate', estimate({ prints: 0, print_time_seconds: null, filament_grams: 0, complete: false, reasons: [{ code: 'no_plate', count: 1 }] }), /^— · —/],
      ['needs_slicing', estimate({ prints: 0, print_time_seconds: null, filament_grams: 0, complete: false, reasons: [{ code: 'needs_slicing', count: 1 }] }), /^— · —/],
      ['gap', estimate({ complete: false, reasons: [{ code: 'no_plate', count: 1 }] }), /^щонайменше .* · щонайменше /],
      ['weight-zero', estimate({ filament_grams: 0, complete: false, reasons: [{ code: 'unknown_weight', count: 2 }] }), / · —/],
      ['weight-partial', estimate({ complete: false, reasons: [{ code: 'unknown_weight', count: 1 }] }), / · щонайменше /],
      ['purchased', estimate({ prints: 0, print_time_seconds: 0, filament_grams: 0 }), /^без друку/],
      ['price', estimate({ complete: false, reasons: [{ code: 'unknown_purchase_price', count: 1 }] }), /^\S.* · \d/],
      ['empty', estimate({ prints: 0, print_time_seconds: 0, filament_grams: 0, complete: false, reasons: [{ code: 'empty_composition', count: null }] }), /^—/],
      ['failed', null, /^—.*Оцінку не вдалося завантажити/],
    ];
    let current = cases[0];
    const { ctx, p, errors } = await open(1440, { gets: [[ESTIMATE(P1), () => (current[1] ? { json: current[1] } : { fail: 500 })]] });
    const seen = {};
    const files = [];
    for (const c of cases) {
      current = c;
      await goto(p, P1);
      await p.waitForTimeout(400);
      seen[c[0]] = await textOf(p.getByTestId('product-estimate'));
      if (['no_plate', 'gap', 'purchased', 'failed'].includes(c[0])) files.push(await shoot(p.getByTestId('product-side'), `estimate-${c[0]}@1440`));
    }
    await ctx.close();
    const ok = cases.every(([name, , re]) => re.test(seen[name] ?? '')) && !/Куповані деталі без ціни/.test(seen.price ?? '') && /Деталі без платформи: 1/.test(seen.no_plate ?? '');
    return {
      recipe: { url: '/products/{product:1}', fixture: cases.map(([name]) => `GET …/estimate: ${name} (answered here)`) },
      measured: { seen, errors },
      pass: ok && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('stock-fact@1440', ['E9-B09', 'R06'], async () => {
    let phase = 'ok';
    const { ctx, p, errors } = await open(1440, {
      rewrite: [[DETAIL(P1), (b) => ({ ...b, finished_positions: 2, finished_below_min: 1 })]],
      gets: [[POSITIONS, () => (phase === 'fail' ? { fail: 500 } : null)]],
    });
    await goto(p, P1);
    const ok = { text: await textOf(p.getByTestId('product-stock-fact')), breakdown: await textOf(p.getByTestId('product-stock-breakdown')) };
    const fileOk = await shoot(p.getByTestId('product-side'), 'stock-fact@1440');
    await ctx.close();
    const { ctx: c2, p: p2 } = await open(1440, { rewrite: [[DETAIL(P1), (b) => ({ ...b, finished_positions: 2 })]], fail: [[POSITIONS, 500]] });
    await goto(p2, P1);
    await p2.waitForTimeout(1000);
    const failed = { text: await textOf(p2.getByTestId('product-stock-fact')) };
    const fileFailed = await shoot(p2.getByTestId('product-side'), 'stock-fact-failed@1440');
    await c2.close();
    return {
      recipe: { url: '/products/{product:1}', fixture: ['GET /products/{1}: finished_positions 2, below_min 1 (rewritten)', 'GET /stock/items: 500 (second context)'] },
      measured: { ok, failed, errors },
      pass: /нижче мінімуму/.test(ok.text) && ok.breakdown.includes(':') && ok.breakdown.includes('·') &&
        /Розбивку за позиціями не вдалося завантажити/.test(failed.text) && /готов/.test(failed.text) && errors.length === 0,
      screenshots: [fileOk, fileFailed],
    };
  });

  await scenario('visual@1440', ['E9-B06', 'R07', 'K8'], async () => {
    const picture = { category: 'pictures', filename: 'e09-pic.png', original_name: 'e09-pic.png', size: 2048, sort_order: 0, source: 'manual', source_file_id: null, uploaded_at: null };
    const second = { ...picture, filename: 'e09-pic-2.png', original_name: 'e09-pic-2.png', sort_order: 99 };
    // The owner's F6 (2026-10-03): a cover set on the product page shows at once. After the
    // PUT (answered here) the product reads back with the cover named and a later
    // `updated_at`, as the server writes it.
    const covers = [];
    const { ctx, p, errors } = await open(1440, {
      rewrite: [[DETAIL(P1), (b) => ({
        ...b,
        has_cover: true,
        attachments: [...(b.attachments ?? []), picture, second],
        ...(covers.length ? { cover_image_filename: second.filename, updated_at: '2099-01-01T00:00:00' } : {}),
      })]],
      gets: [[/\/(cover-image|attachment-image\/)/, () => ({ file: job.cover_png })]],
      writes: [recorder(covers, /\/products\/\d+\/cover-image$/, () => ({ status: 'success', filename: second.filename }))],
    });
    await goto(p, P1);
    const cover = await p.getByTestId('product-visual').locator('img').evaluate((img) => ({ natural: img.naturalWidth, hidden: img.hidden }));
    const bodyGallery = await p.getByTestId('product-gallery').count();
    const opener = p.getByRole('button', { name: 'Зображення…' });
    await opener.click();
    const dialog = p.getByRole('dialog', { name: 'Зображення' });
    await dialog.waitFor({ timeout: 5000 });
    await dialog.getByTestId('gallery-picture-e09-pic.png').click();
    const viewer = p.getByRole('dialog', { name: 'Перегляд зображення' });
    await viewer.waitFor({ timeout: 5000 });
    const file = await shoot(p, 'visual-lightbox@1440');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
    const afterFirst = { viewer: await viewer.count(), dialog: await dialog.count() };
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
    const afterSecond = { dialog: await dialog.count(), focus: await p.evaluate(() => document.activeElement?.textContent?.trim() ?? '') };
    // F6: «Зробити обкладинкою» — the visual field's address moves at once, and the dialog's
    // cover tile moves with it.
    const sideSrc = () => p.getByTestId('product-visual').locator('img').getAttribute('src');
    const before = await sideSrc();
    await opener.click();
    await dialog.waitFor({ timeout: 5000 });
    await dialog.getByRole('button', { name: 'Зробити обкладинкою: e09-pic-2.png' }).click();
    await p.waitForFunction((old) => document.querySelector('[data-testid="product-visual"] img')?.getAttribute('src') !== old, before, { timeout: 5000 }).catch(() => {});
    const after = await sideSrc();
    const tile = await dialog.getByTestId('product-gallery-cover').getAttribute('src');
    const strip = (src) => (src ?? '').replace(/[?&]token=[^&]*/, '');
    const coverMoved = { put: covers.length, before: strip(before), after: strip(after), tile: strip(tile) };
    await ctx.close();
    return {
      recipe: {
        url: '/products/{product:1}',
        fixture: ['GET /products/{1}: has_cover, two pictures; after the PUT the second named as the cover and a later updated_at (rewritten)', 'GET cover-image / attachment-image: the fixture PNG', 'PUT …/cover-image: answered here'],
        actions: ['«Зображення…»', 'the picture', 'Escape', 'Escape', '«Зображення…»', '«Зробити обкладинкою: e09-pic-2.png»'],
      },
      measured: { cover, bodyGallery, afterFirst, afterSecond, coverMoved, errors },
      pass: cover.natural > 0 && !cover.hidden && bodyGallery === 0 && afterFirst.viewer === 0 && afterFirst.dialog === 1 && afterSecond.dialog === 0 && afterSecond.focus === 'Зображення…' &&
        coverMoved.put === 1 && /\/cover-image\?v=/.test(coverMoved.before) && coverMoved.after !== coverMoved.before && /\/cover-image\?v=/.test(coverMoved.after) &&
        coverMoved.tile === coverMoved.after && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 5. the tabs (C02, C03, C05) =======================
  await scenario('tabs@1440', ['E9-C02', 'E9-C03', 'A01'], async () => {
    const { ctx, p, errors, requests } = await open(1440, {
      rewrite: [[DETAIL(P1), (b) => ({ ...b, parts_count: 9, plates_count: 77, documents_count: 5, orders_count: 12 })]],
      writes: [[/\/card\/reread/, { notes: [{ code: 'nothing_to_fill' }], product: detail1 }]],
    });
    await goto(p, P1);
    const labels = await p.getByRole('tab').evaluateAll((ts) => ts.map((t) => t.textContent.trim()));
    await openTab(p, 'Плити й файли');
    const first = count(requests, /^GET \/api\/v1\/products\/\d+\/files/);
    await openTab(p, 'Склад виробу');
    await openTab(p, 'Плити й файли');
    const back = count(requests, /^GET \/api\/v1\/products\/\d+\/files/);
    await openTab(p, 'Склад виробу');
    // A mutation re-reads the hidden visited tab: a re-read refreshes the files.
    await p.getByTestId('product-page-menu').click();
    await p.getByRole('menuitem', { name: 'Перечитати картку з файлу…' }).click();
    const dialog = p.getByRole('dialog', { name: 'Перечитати картку з файлу' });
    await dialog.getByRole('radio').first().waitFor({ timeout: 8000 });
    await dialog.getByRole('radio').first().check();
    await dialog.getByRole('button', { name: /^Перечитати/ }).click();
    await p.waitForTimeout(1500);
    const after = count(requests, /^GET \/api\/v1\/products\/\d+\/files/);
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}', fixture: ['GET /products/{1}: parts 9, plates 77, documents 5, orders 12 (rewritten)', 'POST …/card/reread: answered here'] },
      measured: { labels, first, back, after, errors },
      pass: JSON.stringify(labels) === JSON.stringify(['Склад виробу (9)', 'Плити й файли (77)', 'Залишки', 'Документи (5)', 'Замовлення (12)']) && back === first && after > back && errors.length === 0,
      screenshots: [],
    };
  });

  await scenario('tabs-independent@1440', ['E9-C05', 'P09.7'], async () => {
    const { ctx, p, errors } = await open(1440, { fail: [[SOURCES(P1), 500], [FILES(P1), 500], [POSITIONS, 500], [JOURNAL, 500], [ORDERS, 500]] });
    await goto(p, P1);
    await p.waitForTimeout(1500);
    const seen = {};
    seen.composition = { note: await p.getByText('Не вдалося завантажити плити деталей').count(), table: await p.locator('[data-testid^="part-"][data-testid$="-row"]').count() };
    await openTab(p, 'Плити й файли');
    await p.waitForTimeout(800);
    seen.plates = await p.getByText('Не вдалося завантажити файли виробу').count();
    await openTab(p, 'Залишки');
    await p.waitForTimeout(1200);
    seen.stock = { positions: await p.getByText('Не вдалося завантажити позиції').count(), journal: await p.getByText('Не вдалося завантажити рухи').count(), shelf: await p.getByTestId('product-stock').count() };
    await openTab(p, 'Замовлення');
    await p.waitForTimeout(1200);
    seen.orders = await p.getByText('Не вдалося завантажити замовлення').count();
    const intact = { h1: await p.locator('h1').count(), estimate: await textOf(p.getByTestId('product-estimate')) };
    const file = await shoot(p, 'tabs-independent@1440');
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}', fixture: ['GET …/sources, …/files, /stock/items, /stock/journal, /projects/?product_id: 500 (answered here)'] },
      measured: { seen, intact, errors },
      pass: seen.composition.note === 1 && seen.composition.table > 0 && seen.plates === 1 && seen.stock.positions === 1 && seen.stock.journal === 1 && seen.stock.shelf === 1 &&
        seen.orders === 1 && intact.h1 === 1 && /·/.test(intact.estimate) && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 6. composition (D01–D05, R08) =======================
  await scenario('composition@1440', ['E9-D01', 'E9-D02', 'E9-D03', 'P06'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, P1);
    const chips = await p.getByTestId('composition-variants').locator('[data-testid^="variant-chip-"]').evaluateAll((cs) => cs.map((c) => ({ text: c.textContent.replace(/\s+/g, ' ').trim(), standard: c.dataset.standard === 'true' })));
    const inputs = await p.getByTestId('product-main').locator('table input').count();
    const sources = await p.getByTestId('part-source').evaluateAll((ss) => ss.slice(0, 3).map((s) => s.textContent.trim()));
    // No part repeats a chip that reads the same: alike sources are one chip with a file count.
    const repeats = await p.locator('[data-testid="part-sources"]').evaluateAll((cells) => cells.map((c) => {
      const texts = [...c.querySelectorAll('[data-testid="part-source"]')].map((s) => s.textContent.trim());
      return texts.length - new Set(texts).size;
    }).reduce((a, b) => a + b, 0));
    const split = await splitNames(p);
    const tables = await p.getByTestId('product-main').locator('table').count();
    const file = await shoot(p, 'composition@1440', { fullPage: true });
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}' },
      measured: { chips, inputs, sources, tables, repeats, split, errors },
      pass: chips.length >= 2 && chips.filter((c) => c.standard).length === 1 && /стандарт/.test(chips.find((c) => c.standard)?.text ?? '') &&
        inputs === 0 && tables === 2 && sources.length > 0 && sources.every((s) => /пл\. \d+ · ×\d+/.test(s)) && repeats === 0 && split.length === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('composition-sources@1440', ['E9-D02', 'R10'], async () => {
    const printed = (detail1.parts ?? []).filter((x) => x.kind === 'printed');
    const ids = printed.slice(0, 3).map((x) => x.id);
    const src = (over) => ({ plate_id: 1, library_file_id: 1, filename: 'a.3mf', folder_id: null, folder_name: null, hidden: false, plate_index: 1, printer_model: 'X1C', sliced: true, yield: 1, print_time_seconds: 60, filament_used_grams: 1, recommended: true, ...over });
    const answer = { parts: [
      { part_id: ids[0], has_sliced_source: false, yield_min: null, yield_max: null, hidden_sources: 0, sources: [src({ plate_id: 11, sliced: false, printer_model: null })] },
      { part_id: ids[1], has_sliced_source: false, yield_min: null, yield_max: null, hidden_sources: 0, sources: [] },
      { part_id: ids[2], has_sliced_source: true, yield_min: 2, yield_max: 2, hidden_sources: 1, sources: [src({ plate_id: 13, filename: null, hidden: true, plate_index: 4, yield: 2 })] },
    ] };
    const { ctx, p, errors } = await open(1440, { gets: [[SOURCES(P1), () => ({ json: answer })]] });
    await goto(p, P1);
    const cell = (id) => textOf(p.getByTestId(`part-${id}-row`).getByTestId('part-sources'));
    const seen = { unsliced: await cell(ids[0]), none: await cell(ids[1]), hidden: await cell(ids[2]),
      hiddenTitle: await p.getByTestId(`part-${ids[2]}-row`).getByTestId('part-source').getAttribute('title') };
    const file = await shoot(p, 'composition-sources@1440');
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}', fixture: ['GET …/sources: an unsliced source, none, a source in a hidden file (answered here)'] },
      measured: { seen, errors },
      pass: /не нарізано/.test(seen.unsliced) && /немає плити/.test(seen.none) && /пл\. 4 · ×2/.test(seen.hidden) && seen.hiddenTitle === 'у файлі без доступу' && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('composition-edit@1440', ['E9-D05', 'R08'], async () => {
    const writes = [];
    const printed = (detail1.parts ?? []).filter((x) => x.kind === 'printed');
    const first = printed[0];
    const { ctx, p, errors } = await open(1440, {
      writes: [recorder(writes, /\/parts\/\d+$/, (entry) => new Promise((r) => setTimeout(() => r({ ...first, name: entry.body?.name ?? first.name }), 1500)))],
    });
    await goto(p, P1);
    await p.getByRole('button', { name: 'Редагувати склад' }).click();
    const row = p.getByTestId(`part-${first.id}-row`);
    const nameField = row.getByRole('textbox', { name: 'Деталь' });
    await nameField.fill(`${first.name} e09`);
    await p.getByRole('button', { name: 'Готово' }).click();
    await p.waitForTimeout(300);
    const saving = { visible: await p.getByRole('button', { name: 'Зберігається…' }).count(), disabled: await p.getByRole('button', { name: 'Зберігається…' }).isDisabled().catch(() => null) };
    const fileSaving = await shoot(p, 'composition-edit-saving@1440');
    await p.getByRole('button', { name: 'Редагувати склад' }).waitFor({ timeout: 6000 });
    await p.waitForTimeout(300);
    const after = { inputs: await p.getByTestId('product-main').locator('table input').count(), focus: await p.evaluate(() => document.activeElement?.textContent?.trim() ?? '') };
    // A row's «Edit»: the editor opens on that row, the focus in its name.
    const second = printed[1] ?? first;
    await p.getByTestId(`part-${second.id}-row`).getByRole('button', { name: 'Дії' }).click();
    await p.getByRole('menuitem', { name: 'Редагувати' }).click();
    await p.waitForTimeout(500);
    const focused = await p.evaluate(() => document.activeElement?.closest('[data-testid$="-row"]')?.dataset.testid ?? null);
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}', fixture: ['PATCH …/parts/{id}: answered here after 1.5 s'], actions: ['«Редагувати склад»', 'type a name', '«Готово»', 'row «Дії» → «Редагувати»'] },
      measured: { writes: writes.map((w) => `${w.method} ${w.path}`), saving, after, focused, errors },
      pass: writes.length === 1 && writes[0].method === 'PATCH' && saving.visible === 1 && saving.disabled === true && after.inputs === 0 &&
        after.focus === 'Редагувати склад' && focused === `part-${second.id}-row` && errors.length === 0,
      screenshots: [fileSaving],
    };
  });

  await scenario('composition-dialogs@1440', ['E9-D05', 'E9-B11', 'R08'], async () => {
    const posts = [];
    const deletes = [];
    const bought = (detail1.parts ?? []).find((x) => x.kind === 'purchased');
    const { ctx, p, errors } = await open(1440, {
      rewrite: [[DETAIL(P1), (b) => (deletes.length ? { ...b, parts: (b.parts ?? []).filter((x) => x.id !== bought.id) } : b)]],
      writes: [
        recorder(posts, /\/products\/\d+\/parts$/, (_e, n) => (n === 1 ? { id: 99901, name: 'e09' } : { __status: 409, json: { detail: 'Назва вже належить іншій деталі' } })),
        recorder(deletes, /\/parts\/\d+$/, () => ({ message: 'ok' })),
      ],
    });
    await goto(p, P1);
    await p.getByRole('button', { name: 'Додати деталь' }).click();
    const add = p.getByRole('dialog', { name: 'Додати деталь' });
    await add.getByLabel('Деталь').fill('Петля');
    await add.getByRole('button', { name: 'Додати' }).click();
    await p.waitForTimeout(800);
    const afterFirst = { open: await add.count(), value: await add.getByLabel('Деталь').inputValue(), focus: await p.evaluate(() => document.activeElement?.id ?? '') };
    await add.getByLabel('Деталь').fill('Кришка');
    await add.getByRole('button', { name: 'Додати' }).click();
    await p.waitForTimeout(800);
    const refused = { alert: await textOf(add.getByRole('alert')).catch(() => ''), value: await add.getByLabel('Деталь').inputValue() };
    const fileAdd = await shoot(p, 'composition-add-refused@1440');
    await add.getByRole('button', { name: 'Готово' }).click();
    await p.getByRole('button', { name: 'Керувати варіантами…' }).click();
    const variants = await p.getByRole('dialog', { name: 'Варіанти виробу' }).getByRole('textbox').count();
    const fileVariants = await shoot(p, 'composition-variants@1440');
    await p.getByRole('dialog', { name: 'Варіанти виробу' }).getByRole('button', { name: 'Готово' }).click();
    await p.getByTestId(`part-${bought.id}-row`).getByRole('button', { name: 'Дії' }).click();
    await p.getByRole('menuitem', { name: 'Видалити' }).click();
    const confirm = p.getByRole('dialog', { name: 'Видалити деталь' });
    const words = await textOf(confirm);
    await confirm.getByRole('button', { name: 'Видалити' }).dblclick();
    await p.waitForTimeout(800);
    const afterDelete = { rowGone: (await p.getByTestId(`part-${bought.id}-row`).count()) === 0, focus: await focusAt(p) };
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}', fixture: ['POST …/parts: 200, then 409 (answered here)', 'DELETE …/parts/{id}: answered here', 'GET /products/{1} after the DELETE: without the part (rewritten)'] },
      measured: { posts: posts.length, afterFirst, refused, variants, words, deletes: deletes.length, afterDelete, errors },
      pass: posts.length === 2 && afterFirst.open === 1 && afterFirst.value === '' && afterFirst.focus === 'add-part-name' && /Назва вже належить/.test(refused.alert) &&
        refused.value === 'Кришка' && variants > 0 && /придбане/.test(words) && deletes.length === 1 && afterDelete.rowGone && afterDelete.focus === 'H1' && errors.length === 0,
      screenshots: [fileAdd, fileVariants],
    };
  });

  // ======================= 7. plates and files (E01–E05, R01, R10) =======================
  await scenario('plates@1440', ['E9-E02', 'E9-E03', 'E9-E04', 'P07'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, P1, '?tab=plates');
    const cards = await p.locator('[data-testid^="product-file-"]').count();
    const firstCard = await textOf(p.locator('[data-testid^="product-file-"]').first());
    const stlHint = await p.getByText('STL/STEP не має плит').count();
    const folders = await textOf(p.getByTestId('product-folders'));
    const file = await shoot(p, 'plates@1440');
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}?tab=plates' },
      measured: { cards, expected: (files1.files ?? []).length, firstCard: firstCard.slice(0, 120), stlHint, folders, errors },
      pass: cards === (files1.files ?? []).length && stlHint > 0 && /Прив’язані теки/.test(folders) && /через теку/.test(firstCard) && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('plates-unlink@1440', ['E9-E02', 'E9-E04', 'R01', 'R10'], async () => {
    const deletes = [];
    const answer = {
      ...files1,
      files: [
        fileOf({ library_file_id: 9101, filename: 'direct.3mf', hidden: false, folder_id: null, folder_name: null, in_linked_folder: false }),
        fileOf({ library_file_id: 9102, filename: 'other-folder.3mf', hidden: false, folder_name: 'Інша', in_linked_folder: false }),
        fileOf({ library_file_id: 9103, filename: 'in-folder.3mf', hidden: false, folder_name: 'Колба', in_linked_folder: true }),
        fileOf({ library_file_id: 9104, filename: null, hidden: true, folder_name: null, in_linked_folder: false }),
      ],
      folders: [{ folder_id: 16, name: 'Колба', hidden: false }, { folder_id: 77, name: null, hidden: true }],
    };
    const unlinked = (kind, id) => deletes.some((d) => d.path.endsWith(`/${kind}/${id}`));
    const now = () => ({
      ...answer,
      files: answer.files.filter((f) => !unlinked('files', f.library_file_id)),
      folders: answer.folders.filter((f) => !unlinked('folders', f.folder_id)),
    });
    const { ctx, p, errors } = await open(1440, { gets: [[FILES(P1), () => ({ json: now() })]], writes: [recorder(deletes, /\/(files|folders)\/\d+$/, () => detail1)] });
    await goto(p, P1, '?tab=plates');
    const has = async (id) => p.getByTestId(`product-file-${id}`).getByRole('button', { name: 'Відв’язати файл' }).count();
    const seen = { direct: await has(9101), other: await has(9102), folder: await has(9103), hidden: await has(9104),
      via: await p.getByTestId('product-file-9103').getByText('через теку «Колба»').count() };
    await p.getByTestId('product-file-9104').getByRole('button', { name: 'Відв’язати файл' }).click();
    const dialog = p.getByRole('dialog');
    const hiddenWords = await textOf(dialog);
    const beforeConfirm = deletes.length;
    await dialog.getByRole('button', { name: 'Відв’язати' }).click();
    await p.waitForTimeout(800);
    const afterFile = { cardGone: (await p.getByTestId('product-file-9104').count()) === 0, focus: await focusAt(p) };
    await p.getByTestId('product-folders').getByRole('button', { name: 'Відв’язати теку «Колба»' }).click();
    const folderWords = await textOf(p.getByRole('dialog'));
    const fileFolder = await shoot(p, 'plates-unlink-folder@1440');
    await p.getByRole('dialog').getByRole('button', { name: 'Відв’язати' }).click();
    await p.waitForTimeout(800);
    const afterFolder = { chipGone: (await p.getByRole('button', { name: 'Відв’язати теку «Колба»' }).count()) === 0, focus: await focusAt(p) };
    const hiddenFolder = await p.getByTestId('product-folders').getByText('Тека без доступу').count();
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}?tab=plates', fixture: ['GET …/files: a direct file, a file in an unlinked folder, a file in the linked folder, a hidden file; a named and a hidden folder — without what was unlinked since (answered here)', 'DELETE …/files|folders: answered here'] },
      measured: { seen, hiddenWords, beforeConfirm, folderWords: folderWords.slice(0, 200), deletes: deletes.map((d) => d.path), afterFile, afterFolder, hiddenFolder, errors },
      pass: seen.direct === 1 && seen.other === 1 && seen.folder === 0 && seen.hidden === 1 && seen.via === 1 && /без доступу №9104/.test(hiddenWords) && beforeConfirm === 0 &&
        /не розрізняє/.test(folderWords) && deletes.length === 2 && /\/files\/9104$/.test(deletes[0].path) && /\/folders\/16$/.test(deletes[1].path) && hiddenFolder === 1 &&
        afterFile.cardGone && afterFile.focus === 'H1' && afterFolder.chipGone && afterFolder.focus === 'H1' && errors.length === 0,
      screenshots: [fileFolder],
    };
  });

  await scenario('plates-library@1440', ['E9-E01', 'E9-E04', 'E9-E05', 'R02', 'K9'], async () => {
    const { ctx, p, errors, requests } = await open(1440, { me: NO_LIBRARY });
    await goto(p, P1, '?tab=plates');
    await p.getByTestId('product-page-menu').click();
    await p.getByRole('menuitem', { name: 'Перечитати картку з файлу…' }).click();
    await p.waitForTimeout(1000);
    await p.keyboard.press('Escape');
    const links = await p.getByTestId('product-main').locator('a[href^="/files"]').count();
    const library = requests.filter((r) => /\/api\/v1\/library\//.test(r));
    const unlink = await p.getByRole('button', { name: 'Перечитати картку з файлу…' }).count();
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}?tab=plates', fixture: ['GET /auth/me: every permission but library:* (merged)'] },
      measured: { links, library, reread: unlink, errors },
      pass: links === 0 && library.length === 0 && unlink === 1 && errors.length === 0,
      screenshots: [],
    };
  });

  // ======================= 8. stock (F01–F05, R03, R04, R12) =======================
  await scenario('stock@1440', ['E9-F01', 'E9-F02', 'E9-F05', 'P08'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, P1, '?tab=stock');
    await p.waitForTimeout(800);
    const links = await p.getByTestId('stock-positions').getByRole('link').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    const kits = await textOf(p.getByTestId('product-stock'));
    const assemble = await p.getByRole('button', { name: 'Зібрати готові вироби з деталей…' }).isEnabled();
    const cards = await p.getByTestId('stock-cards').evaluate((el) => [...el.children].map((c) => Math.round(c.getBoundingClientRect().top)));
    const file = await shoot(p, 'stock@1440', { fullPage: true });
    await p.getByRole('button', { name: 'Надходження' }).click();
    const receipt = await p.getByRole('dialog').count();
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}?tab=stock', actions: ['«Надходження»'] },
      measured: { links, kits: kits.slice(0, 200), assemble, cards, receipt, errors },
      pass: links.length >= 2 && links.every((h) => /^\/stock\/\d+$/.test(h)) && /Комплектів ·/.test(kits) && /не додаються/.test(kits) && assemble && receipt === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('stock-assemble@1440', ['E9-F02', 'R03'], async () => {
    const plain = (b) => ({ ...b, variant_groups: [] });
    const { ctx, p, errors } = await open(1440, { rewrite: [[DETAIL(P8), plain], [SHELF(P8), (b) => ({ ...b, kits_available: 0, kits_by_option: [] })]] });
    await goto(p, P8, '?tab=stock');
    await p.waitForTimeout(800);
    const zero = { disabled: await p.getByRole('button', { name: 'Зібрати готові вироби з деталей…' }).isDisabled(), title: await p.getByRole('button', { name: 'Зібрати готові вироби з деталей…' }).getAttribute('title') };
    await ctx.close();
    const { ctx: c2, p: p2 } = await open(1440, { rewrite: [[DETAIL(P8), plain]], fail: [[SHELF(P8), 500]] });
    await goto(p2, P8, '?tab=stock');
    await p2.waitForTimeout(1500);
    const failed = await p2.getByRole('button', { name: 'Зібрати готові вироби з деталей…' }).isEnabled();
    await c2.close();
    const { ctx: c3, p: p3 } = await open(1440, { rewrite: [[SHELF(P1), (b) => ({ ...b, kits_available: 0, kits_by_option: (b.kits_by_option ?? []).map((k, i) => ({ ...k, kits: i === 0 ? 0 : 1 })) })]] });
    await goto(p3, P1, '?tab=stock');
    await p3.waitForTimeout(800);
    const variants = await p3.getByRole('button', { name: 'Зібрати готові вироби з деталей…' }).isEnabled();
    await p3.getByRole('button', { name: 'Зібрати готові вироби з деталей…' }).click();
    const dialog = await p3.getByRole('dialog').count();
    await c3.close();
    // Codex review V01: a group without a standard reads «Без вибору», and what the dialog
    // shows is what it sends — the lookup and the assembly carry no option.
    const lookups = [];
    const assembles = [];
    const noStandard = (b) => ({ ...b, variant_groups: (b.variant_groups ?? []).map((g) => ({ ...g, default_option_id: null })) });
    const { ctx: c4, p: p4, errors: errors4 } = await open(1440, {
      rewrite: [[DETAIL(P1), noStandard]],
      gets: [[/\/stock\/items\/lookup/, (url) => {
        lookups.push(new URL(url).search);
        return { json: { item: null, configuration: { choices: [], changed_parts: [] }, can_assemble: 1, parts: [] } };
      }]],
      writes: [recorder(assembles, /\/stock\/assemble$/, () => ({ id: 99901, code: 'SK-99901', product_id: Number(P1), on_hand: 1, reserved: 0, available: 1 }))],
    });
    await goto(p4, P1, '?tab=stock');
    await p4.waitForTimeout(800);
    await p4.getByRole('button', { name: 'Зібрати готові вироби з деталей…' }).click();
    const assembleDialog = p4.getByRole('dialog');
    await assembleDialog.getByRole('combobox').first().waitFor({ timeout: 5000 });
    const shown = await assembleDialog.getByRole('combobox').evaluateAll((ss) => ss.map((s) => ({ value: s.value, text: (s.selectedOptions[0]?.textContent ?? '').trim() })));
    const fileNoChoice = await shoot(p4, 'stock-assemble-no-standard@1440');
    await p4.waitForFunction(() => !document.querySelector('[data-testid="assemble-submit"]')?.disabled, null, { timeout: 5000 }).catch(() => {});
    await p4.getByTestId('assemble-submit').click();
    await p4.waitForTimeout(800);
    await c4.close();
    const noChoice = { shown, lookups, sent: assembles.map((a) => a.body) };
    return {
      recipe: {
        url: '/products/{product:8|1}?tab=stock',
        fixture: ['product 8 without variants, 0 kits (rewritten)', 'its shelf 500', 'product 1: standard 0, an option 1 (rewritten)',
          'product 1 with no standard option in its groups (rewritten)', 'GET /stock/items/lookup: can assemble 1 (answered here)', 'POST /stock/assemble: answered here'],
      },
      measured: { zero, failed, variants, dialog, noChoice, errors: [...errors, ...errors4] },
      pass: zero.disabled && zero.title === 'Немає жодного повного комплекту' && failed && variants && dialog === 1 &&
        shown.length > 0 && shown.every((x) => x.value === '' && x.text === 'Без вибору') &&
        lookups.length > 0 && lookups.every((q) => !/options=/.test(q)) &&
        assembles.length === 1 && assembles[0].body?.product_id === Number(P1) && JSON.stringify(assembles[0].body?.options ?? null) === '[]' &&
        errors.length === 0 && errors4.length === 0,
      screenshots: [fileNoChoice],
    };
  });

  await scenario('journal@1440', ['E9-F03', 'R04', 'R12'], async () => {
    const asked = [];
    let plan = { p1: 'ok', p2: 'fail', parts: 'fail' };
    const { ctx, p, errors } = await open(1440, {
      gets: [[JOURNAL, (url) => {
        const q = new URL(url).searchParams;
        const pg = Number(q.get('page'));
        const book = q.get('book') ?? 'both';
        asked.push(`${book}:${pg}`);
        if (book === 'parts' && plan.parts === 'fail') return { fail: 500 };
        if (pg === 2 && plan.p2 === 'fail') return { fail: 500 };
        const rows = Array.from({ length: pg === 1 ? 24 : 6 }, (_, i) => journalRow(i % 2 ? 'parts' : 'finished', pg * 100 + i));
        return { json: journalPage(rows, pg, 2, 30) };
      }]],
    });
    await goto(p, P1, '?tab=stock');
    await p.waitForTimeout(1000);
    const page1 = await p.locator('[data-testid^="journal-row-"]').count();
    await p.getByTestId('product-journal').getByRole('button', { name: 'Наступна сторінка' }).click();
    await p.waitForTimeout(1200);
    const failedPage = { rows: await p.locator('[data-testid^="journal-row-"]').count(), alert: await p.getByTestId('product-journal').getByRole('alert').count(), bar: await p.getByTestId('product-journal').locator('[data-pagination]').count() };
    const fileFailed = await shoot(p.getByTestId('product-journal'), 'journal-page-failed@1440');
    plan.p2 = 'ok';
    await p.getByTestId('product-journal').getByRole('button', { name: 'Спробувати знову' }).click();
    await p.waitForTimeout(1200);
    const retried = { rows: await p.locator('[data-testid^="journal-row-"]').count(), last: asked.at(-1) };
    await p.getByTestId('product-journal').getByRole('button', { name: 'Деталі' }).click();
    await p.waitForTimeout(1200);
    const failedBook = { rows: await p.locator('[data-testid^="journal-row-"]').count(), alert: await p.getByTestId('product-journal').getByRole('alert').count(), last: asked.at(-1) };
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}?tab=stock', fixture: ['GET /stock/journal?page=: 24 + 6 rows; page 2 500 once; parts 500 (answered here)'] },
      measured: { asked, page1, failedPage, retried, failedBook, errors },
      pass: page1 === 24 && failedPage.rows === 0 && failedPage.alert === 1 && failedPage.bar === 0 && retried.rows === 6 && retried.last === 'both:2' &&
        failedBook.rows === 0 && failedBook.alert === 1 && failedBook.last === 'parts:1' && errors.length === 0,
      screenshots: [fileFailed],
    };
  });

  // ======================= 9. documents (G01–G04, R07) =======================
  await scenario('docs@1440', ['E9-G01', 'E9-G02', 'E9-G03', 'P09'], async () => {
    const posts = [];
    const deletes = [];
    const extra = [
      { category: 'bom_docs', filename: 'e09-bom.xlsx', original_name: 'e09-bom.xlsx', size: 30720, sort_order: 5, source: '3mf', source_file_id: 1, uploaded_at: null },
      { category: 'other', filename: 'e09-import.pdf', original_name: 'e09-import.pdf', size: 4096, sort_order: 0, source: 'import', source_file_id: null, uploaded_at: null },
    ];
    const { ctx, p, errors } = await open(1440, {
      rewrite: [[DETAIL(P1), (b) => ({ ...b, attachments: [...(b.attachments ?? []), ...extra].filter((a) => !deletes.some((d) => d.path.endsWith(`/attachments/${a.filename}`))) })]],
      writes: [
        recorder(posts, /\/products\/\d+\/attachments$/, () => ({ __status: 400, json: { detail: 'Розділ приймає .xls, .xlsx, .pdf або .csv' } })),
        recorder(deletes, /\/attachments\/[^/]+$/, () => []),
      ],
    });
    await goto(p, P1, '?tab=docs');
    const sections = await p.locator('[data-testid^="attachment-section-"] h3').evaluateAll((hs) => hs.map((h) => h.textContent.trim()));
    const labels = { threemf: await p.getByText(/КБ · з 3MF/).count(), imported: await p.getByText(/КБ · імпорт/).count() };
    await p.getByTestId('attachment-input-bom_docs').setInputFiles({ name: 'evil.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('x') });
    await p.waitForTimeout(800);
    const refused = await textOf(p.getByTestId('attachment-section-bom_docs').getByRole('alert')).catch(() => '');
    await p.getByRole('button', { name: 'Видалити «e09-import.pdf»' }).click();
    const words = await textOf(p.getByRole('dialog'));
    await p.getByRole('dialog').getByRole('button', { name: 'Видалити' }).click();
    await p.waitForTimeout(800);
    const afterDelete = { rowGone: (await p.getByRole('button', { name: 'Видалити «e09-import.pdf»' }).count()) === 0, focus: await focusAt(p) };
    const file = await shoot(p, 'docs@1440', { fullPage: true });
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}?tab=docs', fixture: ['GET /products/{1}: a 3MF document and an imported one, without what was deleted since (rewritten)', 'POST …/attachments: 400 (answered here)', 'DELETE …/attachments/{name}: answered here'] },
      measured: { sections, labels, posts: posts.length, refused, words, deletes: deletes.length, afterDelete, errors },
      pass: JSON.stringify(sections) === JSON.stringify(['Специфікація', 'Інструкція зі складання', 'Інше']) && labels.threemf >= 1 && labels.imported >= 1 &&
        posts.length === 1 && /Розділ приймає/.test(refused) && /файл бібліотеки — ні/.test(words) && deletes.length === 1 && afterDelete.rowGone && afterDelete.focus === 'H1' && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('docs-view@1440', ['E9-G02', 'R07'], async () => {
    const pics = ['e09-a.png', 'e09-b.png'].map((name, i) => ({ category: 'assembly', filename: name, original_name: name, size: 2048, sort_order: i, source: 'manual', source_file_id: null, uploaded_at: null }));
    let firstA = true;
    const { ctx, p, errors } = await open(1440, {
      rewrite: [[DETAIL(P1), (b) => ({ ...b, attachments: [...(b.attachments ?? []), ...pics] })]],
      gets: [[/\/attachments\/e09-/, (url) => {
        if (url.includes('e09-a.png') && firstA) { firstA = false; return { delay: 2500, file: job.cover_png }; }
        return { file: job.cover_png };
      }]],
    });
    await goto(p, P1, '?tab=docs');
    // A slow, then B: B is shown and stays.
    await p.getByRole('button', { name: 'Переглянути «e09-a.png»' }).click();
    await p.getByRole('dialog', { name: 'e09-a.png' }).waitFor({ timeout: 3000 });
    const loading = await textOf(p.getByRole('dialog', { name: 'e09-a.png' }));
    await p.keyboard.press('Escape');
    await p.getByRole('button', { name: 'Переглянути «e09-b.png»' }).click();
    const viewer = p.getByRole('dialog', { name: 'e09-b.png' });
    await viewer.locator('img').waitFor({ timeout: 5000 });
    await p.waitForTimeout(3000);
    const after = { b: await viewer.count(), a: await p.getByRole('dialog', { name: 'e09-a.png' }).count(), natural: await viewer.locator('img').evaluate((img) => img.naturalWidth) };
    const file = await shoot(p, 'docs-view@1440');
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}?tab=docs', fixture: ['GET /products/{1}: two assembly pictures (rewritten)', 'GET …/attachments/e09-a.png: 2.5 s late the first time; both answered with the fixture PNG'] },
      measured: { loading, after, errors },
      pass: loading.includes('…') && after.b === 1 && after.a === 0 && after.natural > 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 10. orders (H01–H02) =======================
  await scenario('orders@1440', ['E9-H01', 'E9-H02', 'A02', 'P10'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, P1, '?tab=orders');
    await p.waitForTimeout(800);
    const rows = await p.locator('[data-testid^="product-order-"]').count();
    const firstRow = await textOf(p.locator('[data-testid^="product-order-"]').first());
    const units = await textOf(p.getByTestId('product-units-printed-total'));
    const file = await shoot(p, 'orders@1440');
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1}?tab=orders' },
      measured: { rows, firstRow: firstRow.slice(0, 160), units, errors },
      pass: rows >= 1 && /×/.test(firstRow) && /OR-\d+ ·/.test(firstRow) && units.length > 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('orders-pages@1440', ['E9-H02'], async () => {
    const { ctx, p, errors } = await open(1440, { rewrite: [[ORDERS, (b) => ({ ...b, meta: { ...b.meta, total: 30, last_page: 2 } })]] });
    await goto(p, P1, '?tab=orders');
    await p.waitForTimeout(800);
    const bar = await p.locator('[data-pagination]').count();
    await ctx.close();
    const { ctx: c2, p: p2 } = await open(1440, { rewrite: [[ORDERS, (b) => ({ ...b, items: [], meta: { ...b.meta, total: 0, last_page: 1 } })]] });
    await goto(p2, P1, '?tab=orders');
    await p2.waitForTimeout(800);
    const empty = await p2.getByText('Жодне замовлення ще не потребує цього виробу').count();
    await c2.close();
    return {
      recipe: { url: '/products/{product:1}?tab=orders', fixture: ['GET /projects/?product_id: 30 orders in two pages / none (rewritten)'] },
      measured: { bar, empty, errors },
      pass: bar === 1 && empty === 1 && errors.length === 0,
      screenshots: [],
    };
  });

  // ======================= 11. reach at 390, themes =======================
  // The open «⋮»: its panel's box against the screen, and items the panel cuts.
  const menuFit = async (p, name) => {
    await p.getByTestId('product-page-menu').click();
    await p.getByRole('menuitem').first().waitFor({ timeout: 5000 });
    await p.waitForTimeout(150);
    const fit = await p.getByRole('menu').evaluate((m) => {
      const r = m.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), viewport: innerWidth };
    });
    const clipped = await clippedItems(p);
    const file = await shoot(p, name);
    await p.keyboard.press('Escape');
    return { ...fit, clipped, file, inside: fit.left >= 0 && fit.right <= fit.viewport && clipped.length === 0 };
  };

  await scenario('hits@390', ['E9-B01', 'E9-B02', 'E9-C02', 'E9-B06'], async () => {
    const { ctx: rc, p: rp } = await open(390, { me: READER });
    await goto(rp, P1);
    const readerMenu = await menuFit(rp, 'hits-reader-menu@390');
    await rc.close();
    const { ctx, p, errors } = await open(390);
    await goto(p, P1);
    const header = await hitTest(p, 'header button, [data-testid="product-page-menu"]');
    const menu = await menuFit(p, 'hits-menu@390');
    const tabs = await hitTest(p, '[role="tab"]');
    const pictures = await hitTest(p, '[data-testid="product-visual"] button');
    await p.getByRole('button', { name: 'Редагувати склад' }).click();
    await p.getByRole('button', { name: 'Готово' }).evaluate((el) => el.setAttribute('data-e09-done', ''));
    const done = await hitTest(p, '[data-e09-done]');
    const overflow = await docOverflow(p);
    const file = await shoot(p, 'hits@390');
    await ctx.close();
    const all = [...header, ...tabs, ...pictures, ...done];
    return {
      recipe: { url: '/products/{product:1}', viewport: 390, actions: ['«⋮» open and closed (an editor, a reader)', '«Редагувати склад»'], fixture: ['GET /auth/me: a reader — the Workshop’s reads only (merged), for the reader’s «⋮»'] },
      measured: { misses: all.filter((h) => !h.hits).map((h) => h.what), overflow, menu, readerMenu, errors },
      pass: all.length > 0 && all.every((h) => h.hits) && overflow <= 0 && menu.inside && readerMenu.inside && errors.length === 0,
      screenshots: [file, menu.file, readerMenu.file],
    };
  });

  for (const [id, opts, test] of [
    ['theme-light@1440', { storage: { 'theme-mode': 'light' } }, (e) => !/\bdark\b/.test(e.theme)],
    ['theme-oled@1440', { settings: { dark_background: 'oled' } }, (e) => /bg-oled/.test(e.theme)],
  ]) {
    await scenario(id, ['E2-B01', 'E9-B08', 'E9-D02'], async () => {
      const { ctx, p } = await open(1440, {
        ...opts,
        gets: [[ESTIMATE(P1), () => ({ json: estimate({ complete: false, reasons: [{ code: 'no_plate', count: 1 }] }) })]],
      });
      await goto(p, P1);
      const e = await env(p);
      const reason = p.getByTestId('product-estimate').locator('small').first();
      const contrast = { reason: (await reason.count()) ? await textContrast(reason) : null };
      const file = await shoot(p, id);
      await ctx.close();
      return {
        env: e,
        recipe: { url: '/products/{product:1}', fixture: ['GET …/estimate: a coverage gap (answered here)'] },
        measured: { contrast },
        pass: test(e) && contrast.reason !== null && contrast.reason >= 4.5,
        screenshots: [file],
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
