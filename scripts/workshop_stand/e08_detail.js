// WS-13 E8 acceptance runner (spec §I1/I2), run by Playwright MCP's browser_run_code_unsafe:
//   filename: scripts/workshop_stand/e08_detail.js — while `e08_evidence.py serve` listens on 127.0.0.1:8197.
// The harness is E4's (e04_detail.js, via E7), unchanged in what it guarantees: every scenario records WHAT was
// run (recipe + fixtures), WHERE (viewport, DPR, the actual <html> classes), WHAT was measured and whether it
// matched the spec — a failure is a failure, a surface it cannot reach is `pending`. Nothing reaches the stand but
// reads: every non-GET request of every context is answered here (the stage writes among them), and the states the
// baseline does not hold are rewritten GET answers in this runner's own context only. The oracles measure what a
// person reads (widths, columns, text, where a control sits, whether a click lands), never a class name — except
// where the spec names the geometry rule itself (clamp(180px, 11vw, 240px), 36 %).
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
      if (sessionStorage.getItem('e08-init')) return;
      sessionStorage.setItem('e08-init', '1');
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
      if (step && step.fail) return route.fulfill({ status: step.fail, json: { detail: 'e08 runner' } });
      // A body of the runner's own — the stand is never asked.
      if (step && step.json) return route.fulfill({ status: 200, json: step.json });
      // A picture of the runner's own (the cover fixture, K11): a real PNG file.
      if (step && step.file) return route.fulfill({ status: 200, path: step.file, contentType: 'image/png' });
      const failing = fail.find(([re]) => re.test(url));
      if (failing) return route.fulfill({ status: failing[1], json: { detail: 'e08 runner' } });
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
  // The mockup products (spec §I1, T0): 1 — variants, bought parts, an active order, two
  // configurations, below its minimum; 5 — two configurations; 8 — two active orders; 11 — hidden;
  // 104 — a draft below its minimum; 900 — the one-off. And a reader off the Administrators group.
  const P = job.products ?? {};
  const P1 = P['1'] ?? 1;
  const detail1 = await read(`/products/${P1}`);
  const groups = await read('/groups/');
  const groupList = Array.isArray(groups) ? groups : (groups.items ?? []);
  const adminPerms = (groupList.find((g) => g.name === 'Administrators') ?? { permissions: [] }).permissions;
  const READER = { is_admin: false, role: 'user', permissions: adminPerms.filter((perm) => perm === 'projects:read' || !perm.startsWith('projects:')) };
  // Every row as the server sends it (the hidden and the one-off included) — the cell scenarios
  // show exactly these rows, chosen, never made up.
  const all = await read('/products/?page=1&all=true&include_adhoc=true&sort_by=name-asc');
  const ROWS = Array.isArray(all.items) ? all.items : [];
  const rowOf = (n) => ROWS.find((r) => r.id === P[n]) ?? null;
  const directory = await read('/product-categories');
  const DIRECTORY = Array.isArray(directory) ? directory : [];

  // --- doors and oracles ---
  const SEARCH = 'Назва, артикул, матеріал, колір, деталь або файл…';
  const SUBTITLE_TAIL = 'у каталозі · шукайте за назвою, артикулом, деталлю, файлом чи параметрами';
  const HEADERS = ['Виріб / артикул', 'Склад виробу', 'Принтери', 'Матеріал / колір', 'Склад', 'Дії'];
  const SELECTS = ['Матеріал', 'Колір', 'Модель принтера', 'Готовність', 'Наявність'];
  const LIST = /\/api\/v1\/products\/\?/;
  const CATEGORIES = /\/api\/v1\/product-categories\/?(\?.*)?$/;
  const FACETS = /\/api\/v1\/products\/facets/;
  const catalog = async (p, query = '') => {
    await p.goto(`${job.ui}/products${query}`, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(700);
  };
  const view = (v, extra = {}) => ({ storage: { 'bamdude-products-view': v, ...extra } });
  const docOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  // What sticks out past the right edge of the viewport, outside any scroll box of its own — named.
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
  // The list requests as their parameters, in order; the last one; and a wait for one that matches.
  const listParams = (requests) => requests.filter((r) => /^GET \/api\/v1\/products\/\?/.test(r))
    .map((r) => Object.fromEntries(new URL(`http://x${r.slice(4)}`).searchParams));
  const lastParams = (requests) => listParams(requests).at(-1) ?? null;
  const waitParams = async (requests, pred, code = 'params_wait') => {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const q = lastParams(requests);
      if (q && pred(q)) return q;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw failure(code, 'params');
  };
  const urlOf = (p) => p.evaluate(() => location.pathname + location.search);
  // The catalog's checkboxes are the URL's: React Router writes the URL in a transition, so the box
  // shows its new state a moment after the click — a click, then a wait for the state (never check()).
  const setSelect = async (p, label, value) => {
    const el = p.getByLabel(label, { exact: true });
    await el.selectOption(value);
    const t0 = Date.now();
    while ((await el.inputValue()) !== value) {
      if (Date.now() - t0 > 5000) throw failure('select_state', label);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  // A key TanStack still holds fresh sends no request: «was it ever asked with these parameters».
  const sawParams = (requests, pred) => listParams(requests).some(pred);
  const setBox = async (p, label, on) => {
    const el = p.getByLabel(label);
    if ((await el.isChecked()) === on) return;
    await el.click();
    const t0 = Date.now();
    while ((await el.isChecked()) !== on) {
      if (Date.now() - t0 > 5000) throw failure('checkbox_state', label);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) }; });
  const nav = (p) => p.getByRole('navigation', { name: 'Категорії' });
  const entries = (p) => nav(p).locator('li > button').evaluateAll((bs) => bs.map((b) => ({
    name: b.querySelector('span')?.textContent.trim() ?? '', count: b.querySelector('small')?.textContent.trim() ?? '', pressed: b.getAttribute('aria-pressed') === 'true',
  })));
  const pill = (p) => textOf(p.getByTestId('results-count'));
  const headersOf = (p) => p.locator('table thead th').evaluateAll((ths) => ths.map((th) => (th.textContent.replace(/[▲▼]/g, '').trim() || th.getAttribute('aria-label') || '').trim()));
  const rowIds = (p) => p.locator('[data-testid^="product-row-"]').evaluateAll((rs) => rs.map((r) => Number(r.dataset.testid.replace('product-row-', ''))));
  const cardIds = (p) => p.locator('[data-testid$="-card"][data-testid^="product-"]').evaluateAll((cs) => cs.map((c) => Number(c.dataset.testid.replace('product-', '').replace('-card', ''))));
  // A list answer narrowed to the named rows, in that order — the server's own rows, chosen.
  const onlyRows = (rows, extra = {}) => (b) => ({ ...b, ...extra, items: rows, meta: { ...(b.meta ?? {}), total: rows.length, current_page: 1, last_page: 1 } });
  const menuItems = (p) => p.getByRole('menuitem').evaluateAll((ms) => ms.map((m) => ({ text: m.textContent.trim(), disabled: m.disabled })));
  const subtitleOf = (p) => textOf(p.getByTestId('list-page-header').locator('p').first());
  // The list's «could not refresh» note: its own text is the sentence, the retry button sits inside.
  const refreshNote = (p) => p.evaluate(() => [...document.querySelectorAll('p')].filter((el) => el.firstChild && el.firstChild.nodeType === 3 && el.firstChild.textContent.trim() === 'Не вдалося оновити').length);
  // A text's contrast against the ground it is read on — translucent grounds blended over the first
  // opaque one beneath (WCAG's 4.5:1 for text).
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

  // ======================= 1. heading and search (C01, C02) =======================
  await scenario('header@1440', ['E8-C01', 'E8-C02', 'P01'], async () => {
    const { ctx, p, errors } = await open(1440, { ...view('table'), rewrite: [[LIST, (b) => ({ ...b, catalog_total: 777 })]] });
    await catalog(p);
    const subtitle = await subtitleOf(p);
    const buttons = await p.getByTestId('list-page-header').getByRole('button').evaluateAll((bs) => bs.map((b) => (b.textContent.trim() || b.getAttribute('aria-label') || '').trim()));
    const geo = await p.evaluate(() => {
      const r = (el) => { const x = el.getBoundingClientRect(); return { l: Math.round(x.left), t: Math.round(x.top), w: Math.round(x.width), h: Math.round(x.height), b: Math.round(x.bottom), r: Math.round(x.right) }; };
      const wide = document.querySelector('[data-layout="wide"]');
      const input = wide.querySelector('input');
      const kbd = wide.querySelector('kbd');
      const material = document.querySelector('select[aria-label="Матеріал"]');
      const navEl = document.querySelector('nav[aria-label="Категорії"]');
      return { wide: r(wide), input: r(input), font: getComputedStyle(input).fontSize, kbd: kbd ? { ...r(kbd), shown: getComputedStyle(kbd).display !== 'none' } : null, material: r(material), nav: r(navEl), grid: r(navEl.parentElement) };
    });
    const total = await pill(p);
    const file = await shoot(p, 'header@1440');
    await ctx.close();
    const tail = buttons.slice(-3);
    return {
      recipe: { url: '/products', fixture: ['GET /products?page=…: catalog_total 777 (rewritten; meta.total kept)'] },
      measured: { subtitle, buttons, geo, total, errors },
      pass: subtitle === `777 виробів ${SUBTITLE_TAIL}` && total !== '777' &&
        JSON.stringify(tail) === JSON.stringify(['З файлу…', 'Імпорт…', 'Новий виріб']) && buttons.length === 5 &&
        geo.input.h === 44 && geo.font === '15px' && geo.kbd && geo.kbd.shown && Math.abs(geo.wide.w - geo.grid.w) <= 2 &&
        geo.wide.b < geo.material.t && geo.material.b < geo.nav.t && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('header@390', ['E8-C01', 'E8-C02'], async () => {
    const { ctx, p, errors } = await open(390, view('table'));
    await catalog(p);
    const geo = await p.evaluate(() => {
      const wide = document.querySelector('[data-layout="wide"]');
      const kbd = wide.querySelector('kbd');
      const toggle = [...document.querySelectorAll('[data-testid="list-page-header"] [aria-pressed]')].map((b) => Math.round(b.getBoundingClientRect().width));
      const header = document.querySelector('[data-testid="list-page-header"]');
      return { wide: Math.round(wide.getBoundingClientRect().width), row: Math.round(header.getBoundingClientRect().width), vw: innerWidth, kbdShown: kbd ? getComputedStyle(kbd).display !== 'none' : false, toggle };
    });
    const overflow = await docOverflow(p);
    const file = await shoot(p, 'header@390');
    await ctx.close();
    return {
      recipe: { url: '/products', viewport: 390 },
      measured: { geo, overflow, errors },
      pass: !geo.kbdShown && Math.abs(geo.wide - geo.row) <= 1 && geo.toggle.length === 2 && geo.toggle.every((w) => w <= 48) && overflow <= 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('header-reader@1440', ['E8-C01', 'E8-C06', 'E8-F02'], async () => {
    const { ctx, p, errors } = await open(1440, { ...view('table'), me: READER });
    await catalog(p);
    const buttons = await p.getByTestId('list-page-header').getByRole('button').evaluateAll((bs) => bs.map((b) => (b.textContent.trim() || b.getAttribute('aria-label') || '').trim()));
    const manage = await nav(p).getByRole('button', { name: 'Керувати категоріями' }).count();
    await p.locator('[data-testid$="-row-menu"]').first().click();
    await p.getByRole('menuitem').first().waitFor({ timeout: 5000 });
    const items = await menuItems(p);
    const file = await shoot(p, 'header-reader@1440');
    await ctx.close();
    return {
      recipe: { url: '/products', fixture: ['GET /auth/me: a reader — projects:read only (merged)'], actions: ['open the first row menu'] },
      measured: { buttons, manage, items, errors },
      pass: buttons.length === 2 && manage === 0 && items.length === 1 && items[0].text === 'Експорт ZIP' && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('search@1440', ['E8-C02'], async () => {
    const { ctx, p, errors, requests } = await open(1440, view('table'));
    await catalog(p, '?page=2');
    const input = p.getByRole('searchbox', { name: SEARCH });
    await p.locator('body').click({ position: { x: 5, y: 5 } });
    await p.keyboard.press('/');
    const focused = await input.evaluate((el) => document.activeElement === el);
    await p.keyboard.type('Кронштейн');
    const sentQ = await waitParams(requests, (q) => q.q === 'Кронштейн');
    const url = await urlOf(p);
    await p.getByRole('button', { name: 'Очистити пошук' }).click();
    const cleared = await waitParams(requests, (q) => !('q' in q), 'clear_wait');
    const refocused = await input.evaluate((el) => document.activeElement === el);
    await ctx.close();
    return {
      recipe: { url: '/products?page=2', actions: ['«/»', 'type «Кронштейн»', 'clear'] },
      measured: { focused, sentQ, url, cleared, refocused, errors },
      pass: focused && sentQ.page === '1' && /[?&]q=/.test(url) && !/page=/.test(url) && refocused && errors.length === 0,
    };
  });

  // ======================= 2. filters (C03, C04, C05, C09) =======================
  await scenario('filters@1440', ['E8-C03', 'E8-C04', 'P02'], async () => {
    const { ctx, p, errors, requests } = await open(1440, view('table'));
    await catalog(p, '?page=2');
    const names = [];
    for (const label of SELECTS) names.push(await p.getByLabel(label, { exact: true }).count());
    const steps = [];
    const pick = async (label, value, pred, urlPart) => {
      await setSelect(p, label, value);
      const q = await waitParams(requests, pred, `wait_${urlPart}`);
      steps.push({ label, value, params: q, url: await urlOf(p) });
    };
    const material = await p.getByLabel('Матеріал', { exact: true }).locator('option').nth(1).getAttribute('value');
    await pick('Матеріал', material, (q) => q.material === material && q.page === '1', 'material');
    const colour = await p.getByLabel('Колір', { exact: true }).locator('option').nth(1).getAttribute('value');
    await pick('Колір', colour, (q) => q.color === colour, 'color');
    await pick('Модель принтера', 'none', (q) => q.sliced === 'false' && !('model' in q), 'model');
    await pick('Готовність', 'ready', (q) => q.status === 'ready', 'status');
    await pick('Наявність', 'finished', (q) => q.stock === 'finished', 'finished');
    await pick('Наявність', 'kits', (q) => q.stock === 'kits', 'kits');
    await pick('Наявність', 'low', (q) => q.stock === 'below_min', 'low');
    await setBox(p, 'приховані', true);
    const hidden = await waitParams(requests, (q) => !('active' in q), 'hidden');
    await setBox(p, 'разові', true);
    const adhoc = await waitParams(requests, (q) => q.include_adhoc === 'true', 'adhoc');
    const url = await urlOf(p);
    const file = await shoot(p, 'filters@1440');
    await ctx.close();
    return {
      recipe: { url: '/products?page=2', actions: ['each select in turn', 'stock: finished → kits → low', '«приховані»', '«разові»'] },
      measured: { names, steps, hidden, adhoc, url, errors },
      pass: names.every((n) => n === 1) && steps.length === 7 && /model=none/.test(steps[2].url) && /stock=low/.test(steps[6].url) &&
        /catalog=0/.test(url) && /adhoc=1/.test(url) && hidden.include_adhoc === undefined && adhoc.active === undefined && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('filters-links@1440', ['E8-C04', 'R01'], async () => {
    const { ctx, p, errors, requests } = await open(1440, view('table'));
    const link = '/products?catalog=0&adhoc=1&stock=1&status=zzz&model=ZZZ-9&material=PLA';
    const fields = async () => ({
      hidden: await p.getByLabel('приховані').isChecked(),
      adhoc: await p.getByLabel('разові').isChecked(),
      stock: await p.getByLabel('Наявність', { exact: true }).inputValue(),
      status: await p.getByLabel('Готовність', { exact: true }).inputValue(),
      model: await p.getByLabel('Модель принтера', { exact: true }).inputValue(),
      material: await p.getByLabel('Матеріал', { exact: true }).inputValue(),
    });
    await catalog(p, link.slice('/products'.length));
    const direct = { fields: await fields(), params: lastParams(requests), url: await urlOf(p) };
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(700);
    const reloaded = { fields: await fields(), params: lastParams(requests), url: await urlOf(p) };
    await setBox(p, 'приховані', false);
    const off = { params: await waitParams(requests, (q) => q.active === 'true'), url: await urlOf(p) };
    await setBox(p, 'приховані', true);
    const on = { asked: sawParams(requests, (q) => !('active' in q) && q.include_adhoc === 'true' && q.stock === 'kits'), url: await urlOf(p) };
    await catalog(p, '?stock=zzz&status=zzz');
    const unknown = { params: lastParams(requests), url: await urlOf(p), fields: await fields() };
    await ctx.close();
    const sameAsLink = (s) => s.fields.hidden && s.fields.adhoc && s.fields.stock === 'kits' && s.fields.status === '' && s.fields.model === 'ZZZ-9' &&
      s.fields.material === 'PLA' && !('active' in s.params) && s.params.include_adhoc === 'true' && s.params.stock === 'kits' && !('status' in s.params) &&
      !('in_stock' in s.params) && s.params.model === 'ZZZ-9' && s.params.material === 'PLA' && s.url === link;
    return {
      recipe: { urls: [link, '/products?stock=zzz&status=zzz'], actions: ['open the link', 'F5', '«приховані» off, on'] },
      measured: { direct, reloaded, off, on, unknown, errors },
      pass: sameAsLink(direct) && sameAsLink(reloaded) && !/catalog=/.test(off.url) && /catalog=0/.test(on.url) && on.asked &&
        !('stock' in unknown.params) && !('status' in unknown.params) && !('in_stock' in unknown.params) && unknown.url === '/products?stock=zzz&status=zzz' &&
        unknown.fields.stock === '' && unknown.fields.status === '' && errors.length === 0,
    };
  });

  await scenario('filters-reset@1440', ['E8-C05'], async () => {
    const { ctx, p, errors, requests } = await open(1440, view('table'));
    await catalog(p, '?sort=updated-desc');
    const resetButton = () => p.getByRole('button', { name: 'Скинути', exact: true });
    const before = await resetButton().count();
    // Conditions that keep rows: an empty answer under a condition carries its own Reset instead (C05).
    await setBox(p, 'разові', true);
    await nav(p).locator('li > button').nth(2).click();
    await waitParams(requests, (q) => 'category' in q && q.include_adhoc === 'true');
    const rows = (await rowIds(p)).length;
    const during = await resetButton().count();
    const file = await shoot(p, 'filters-reset@1440');
    await resetButton().click();
    await p.waitForTimeout(800);
    // The reset lands on the page's first key, still fresh in the cache: no new request — the URL, the
    // rows and the request that key was asked with say it.
    const after = { asked: sawParams(requests, (q) => !('category' in q) && !('include_adhoc' in q) && q.active === 'true' && q.sort_by === 'updated-desc'), rows: (await rowIds(p)).length };
    const url = await urlOf(p);
    const focused = await p.getByRole('searchbox', { name: SEARCH }).evaluate((el) => document.activeElement === el);
    const gone = await resetButton().count();
    await ctx.close();
    return {
      recipe: { url: '/products?sort=updated-desc', actions: ['«разові»', 'the first category', '«Скинути»'] },
      measured: { before, rows, during, after, url, focused, gone, errors },
      pass: before === 0 && rows > 0 && during === 1 && after.asked && after.rows > 0 && url === '/products?sort=updated-desc' &&
        focused && gone === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('filters-history@1440', ['E8-C05', 'R07'], async () => {
    const { ctx, p, errors, requests } = await open(1440, view('table'));
    await catalog(p);
    const start = await p.evaluate(() => history.length);
    const material = await p.getByLabel('Матеріал', { exact: true }).locator('option').nth(1).getAttribute('value');
    await setSelect(p, 'Матеріал', material);
    await setBox(p, 'разові', true);
    await waitParams(requests, (q) => q.material === material && q.include_adhoc === 'true');
    const afterFilters = await p.evaluate(() => history.length);
    const filtered = await urlOf(p);
    // To a product and Back: the catalog's state as it was.
    await p.locator('[data-testid^="product-row-"] a').first().click();
    await p.waitForURL(/\/products\/\d+/, { timeout: 10000 });
    await p.goBack({ waitUntil: 'networkidle' });
    await p.waitForTimeout(600);
    const back = { url: await urlOf(p), material: await p.getByLabel('Матеріал', { exact: true }).inputValue(), adhoc: await p.getByLabel('разові').isChecked() };
    const beforeReset = await p.evaluate(() => history.length);
    await p.getByRole('button', { name: 'Скинути', exact: true }).click();
    await p.waitForTimeout(500);
    const afterReset = await p.evaluate(() => history.length);
    const reset = await urlOf(p);
    await p.locator('[data-testid^="product-row-"] a').first().click();
    await p.waitForURL(/\/products\/\d+/, { timeout: 10000 });
    await p.goBack({ waitUntil: 'networkidle' });
    await p.waitForTimeout(600);
    const back2 = { url: await urlOf(p), material: await p.getByLabel('Матеріал', { exact: true }).inputValue() };
    await ctx.close();
    return {
      recipe: { url: '/products', actions: ['a material + «разові»', 'a product, Back', '«Скинути»', 'a product, Back'] },
      measured: { start, afterFilters, filtered, back, beforeReset, afterReset, reset, back2, errors },
      pass: afterFilters === start && afterReset === beforeReset && back.url === filtered && back.material === material && back.adhoc &&
        reset === '/products' && back2.url === '/products' && back2.material === '' && errors.length === 0,
    };
  });

  await scenario('filters-facets-fail@1440', ['E8-C09'], async () => {
    let calls = 0;
    const { ctx, p, errors } = await open(1440, { ...view('table'), gets: [[FACETS, () => { calls += 1; return calls <= 2 ? { fail: 500 } : null; }]] });
    await catalog(p);
    await p.waitForTimeout(1500);
    const note = p.getByRole('status').filter({ hasText: 'Не вдалося завантажити значення фільтрів' });
    const shown = await note.count();
    const usable = await p.getByLabel('Матеріал', { exact: true }).isEnabled();
    const optionsBefore = await p.getByLabel('Матеріал', { exact: true }).locator('option').count();
    const file = await shoot(p, 'filters-facets-fail@1440');
    if (shown) await note.getByRole('button', { name: 'Спробувати знову' }).click();
    await p.waitForTimeout(1500);
    const optionsAfter = await p.getByLabel('Матеріал', { exact: true }).locator('option').count();
    const gone = await note.count();
    await ctx.close();
    return {
      recipe: { url: '/products', fixture: ['GET /products/facets: 1st + 2nd → 500 (the app retries once), then the stand'] , actions: ['«Спробувати знову»'] },
      measured: { calls, shown, usable, optionsBefore, optionsAfter, gone, errors },
      pass: shown === 1 && usable && optionsBefore === 1 && optionsAfter > 1 && gone === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 3. categories (C06, C11) =======================
  const navWidth = (w) => (w <= 1100 ? 180 : Math.max(180, Math.min(240, w * 0.11)));
  for (const w of [2560, 1440, 1101, 1100, 761]) {
    await scenario(`categories@${w}`, ['E8-C06', 'P02'], async () => {
      const { ctx, p, errors } = await open(w, view('table'));
      await catalog(p);
      const geo = await p.evaluate(() => {
        const n = document.querySelector('nav[aria-label="Категорії"]');
        const res = n.nextElementSibling;
        const a = n.getBoundingClientRect();
        const b = res.getBoundingClientRect();
        return { nav: Math.round(a.width * 10) / 10, gap: Math.round(b.left - a.right), top: [Math.round(a.top), Math.round(b.top)] };
      });
      const hint = await textOf(nav(p).locator('p').last());
      const file = await shoot(p, `categories@${w}`);
      await ctx.close();
      return {
        recipe: { url: '/products', viewport: w },
        env: { viewport: [w, HEIGHTS[w]] },
        measured: { geo, expected: navWidth(w), hint, errors },
        pass: Math.abs(geo.nav - navWidth(w)) <= 1 && geo.gap === 20 && Math.abs(geo.top[0] - geo.top[1]) <= 2 &&
          hint === 'Слова шукаються разом, у будь-якому порядку. Наприклад: PLA чорний або кронштейн 20.' && errors.length === 0,
        screenshots: [file],
      };
    });
  }
  for (const w of [760, 390]) {
    await scenario(`categories@${w}`, ['E8-C06'], async () => {
      const { ctx, p, errors } = await open(w, view('table'));
      await catalog(p);
      const geo = await p.evaluate(() => {
        const n = document.querySelector('nav[aria-label="Категорії"]');
        const res = n.nextElementSibling;
        const a = n.getBoundingClientRect();
        const b = res.getBoundingClientRect();
        return { nav: [Math.round(a.left), Math.round(a.width), Math.round(a.bottom)], results: [Math.round(b.left), Math.round(b.width), Math.round(b.top)], position: getComputedStyle(n).position, selects: n.querySelectorAll('select').length };
      });
      const count = (await entries(p)).length;
      const overflow = await docOverflow(p);
      const file = await shoot(p, `categories@${w}`, { fullPage: true });
      await ctx.close();
      return {
        recipe: { url: '/products', viewport: w },
        env: { viewport: [w, HEIGHTS[w]] },
        measured: { geo, count, overflow, errors },
        pass: geo.nav[0] === geo.results[0] && Math.abs(geo.nav[1] - geo.results[1]) <= 1 && geo.nav[2] <= geo.results[2] && geo.position === 'static' &&
          geo.selects === 0 && count >= 3 && overflow <= 0 && errors.length === 0,
        screenshots: [file],
      };
    });
  }
  for (const w of [1440, 1024]) {
    await scenario(`categories-sticky@${w}`, ['E8-C06', 'E7-G02'], async () => {
      const { ctx, p, errors } = await open(w, view('table'));
      await catalog(p);
      const geo = await p.evaluate(async () => {
        window.scrollTo(0, 700);
        await new Promise((r) => setTimeout(r, 400));
        const header = document.querySelector('header.fixed');
        const headerBottom = header ? Math.round(header.getBoundingClientRect().bottom) : 0;
        const n = document.querySelector('nav[aria-label="Категорії"]');
        const r = n.getBoundingClientRect();
        return { scrolled: Math.round(scrollY), headerBottom, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight };
      });
      const file = await shoot(p, `categories-sticky@${w}`);
      await ctx.close();
      return {
        recipe: { url: '/products', viewport: w, actions: ['scroll the window by 700 px'] },
        env: { viewport: [w, HEIGHTS[w]] },
        measured: { geo, errors },
        pass: geo.scrolled > 100 && geo.top === geo.headerBottom + 12 && geo.bottom <= geo.vh && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('categories-numbers@1440', ['E8-C06', 'E8-G01', 'E8-C11'], async () => {
    let dropped = null;
    const { ctx, p, errors, requests } = await open(1440, {
      ...view('table'),
      rewrite: [[LIST, (b) => {
        const cats = (b.categories ?? []).map((c, i) => ({ ...c, count: 3 * i + 2 }));
        dropped = cats.length ? cats[cats.length - 1].name : null;
        return { ...b, categories: cats.slice(0, -1), uncategorized: 5, all_categories: 42 };
      }]],
    });
    await catalog(p);
    const list = await entries(p);
    const manage = await nav(p).getByRole('button', { name: 'Керувати категоріями' }).count();
    const file = await shoot(p, 'categories-numbers@1440');
    const target = list[2];
    await nav(p).locator('li > button').nth(2).click();
    const params = await waitParams(requests, (q) => 'category' in q);
    const url = await urlOf(p);
    const heading = await textOf(p.getByRole('heading', { level: 3 }).first());
    await ctx.close();
    const byName = Object.fromEntries(list.map((e) => [e.name, e.count]));
    return {
      recipe: { url: '/products', fixture: ['GET /products?page=…: category counts 2, 5, 8…, the last category dropped from the envelope, uncategorized 5, all_categories 42 (rewritten)'], actions: ['the first category'] },
      measured: { list, dropped, manage, params, url, heading, errors },
      pass: byName['Усі вироби'] === '42' && byName['Без категорії'] === '5' && target.count === '2' && dropped && byName[dropped] === '0' &&
        manage === 1 && /category=\d+/.test(url) && params.category === url.match(/category=(\d+)/)[1] && heading.startsWith(target.name) && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('categories-directory@1440', ['E8-C11', 'R03'], async () => {
    let calls = 0;
    let phase = 'fail';
    const { ctx, p, errors, requests } = await open(1440, {
      ...view('table'),
      gets: [[CATEGORIES, () => { calls += 1; return phase === 'fail' ? { fail: 500 } : null; }]],
    });
    await p.clock.install();
    await catalog(p);
    await p.waitForTimeout(1500);
    const noteOf = (re) => nav(p).getByRole('status').filter({ hasText: re });
    const failed = { note: await noteOf(/Не вдалося завантажити категорії/).count(), list: await entries(p) };
    const fileFailed = await shoot(p, 'categories-directory-failed@1440');
    phase = 'ok';
    await noteOf(/Не вдалося завантажити категорії/).getByRole('button', { name: 'Спробувати знову' }).click();
    await p.waitForTimeout(1500);
    const restored = { note: await noteOf(/Не вдалося/).count(), list: await entries(p) };
    // The cached directory, then a refresh that fails: the names stay, the note says so.
    phase = 'fail';
    await refetchLater(p);
    await p.waitForTimeout(1500);
    const stale = { note: await noteOf(/Не вдалося оновити категорії/).count(), list: await entries(p) };
    const fileStale = await shoot(p, 'categories-directory-stale@1440');
    // A category the URL names that nobody has named yet.
    phase = 'ok';
    await catalog(p, '?category=999999');
    const unknown = { list: await entries(p), params: lastParams(requests) };
    await ctx.close();
    const named = (l) => l.filter((e) => e.name !== 'Усі вироби' && e.name !== 'Без категорії').length;
    const ghost = unknown.list.find((e) => e.name === 'Категорія #999999');
    return {
      recipe: { url: '/products', fixture: ['GET /product-categories: 500 until «Спробувати знову»; 500 again on the re-read'], actions: ['«Спробувати знову»', 're-read (clock +90 s)', '/products?category=999999'] },
      measured: { calls, failed, restored, stale, unknown, errors },
      pass: failed.note === 1 && named(failed.list) >= 1 && failed.list[0].count !== '…' && restored.note === 0 && named(restored.list) === DIRECTORY.length &&
        stale.note === 1 && named(stale.list) === DIRECTORY.length && ghost && ghost.pressed && unknown.params.category === '999999' && errors.length === 0,
      screenshots: [fileFailed, fileStale],
    };
  });

  await scenario('categories-list-states@1440', ['E8-C11', 'R03'], async () => {
    const out = {};
    const files = [];
    {
      // The first read delayed: «…», never 0.
      const { ctx, p } = await open(1440, { ...view('table'), delay: [[LIST, 4000]] });
      await p.goto(`${job.ui}/products`, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(1500);
      out.loading = { list: await entries(p), pill: await pill(p) };
      files.push(await shoot(p, 'categories-loading@1440'));
      await ctx.close();
    }
    {
      // The first read failed: «—».
      const { ctx, p } = await open(1440, { ...view('table'), fail: [[LIST, 500]] });
      await catalog(p);
      await p.waitForTimeout(1500);
      out.failed = { list: await entries(p), pill: await pill(p) };
      files.push(await shoot(p, 'categories-failed@1440'));
      await ctx.close();
    }
    {
      // A filter change whose answer fails: the old key's figures are not the new filter's.
      let fails = false;
      const { ctx, p } = await open(1440, { ...view('table'), gets: [[LIST, () => (fails ? { fail: 500 } : null)]] });
      await catalog(p);
      fails = true;
      await p.getByLabel('Наявність', { exact: true }).selectOption('finished');
      await p.waitForTimeout(2500);
      out.changed = { list: await entries(p), pill: await pill(p), alert: await p.getByRole('alert').count() };
      await ctx.close();
    }
    {
      // An empty answer under a condition, kept, then its re-read failing: the same key's figures stay.
      let calls = 0;
      const { ctx, p } = await open(1440, { ...view('table'), gets: [[LIST, () => { calls += 1; return calls === 1 ? { rewrite: onlyRows([], { categories: [], uncategorized: 0, all_categories: 0 }) } : { fail: 500 }; }]] });
      await p.clock.install();
      await catalog(p, '?q=zzzz');
      await refetchLater(p);
      await p.waitForTimeout(1500);
      out.staleEmpty = { list: await entries(p), pill: await pill(p), note: await refreshNote(p), empty: await p.getByText('Нічого не знайдено').count() };
      files.push(await shoot(p, 'categories-stale-empty@1440'));
      await ctx.close();
    }
    const counts = (s) => s.list.map((e) => e.count);
    return {
      recipe: {
        url: '/products',
        fixture: ['GET /products?page=…: delayed 4 s', '…: 500', '…: 500 after a filter change', '?q=zzzz: an empty answer, then 500 on the re-read'],
      },
      measured: out,
      pass: counts(out.loading).every((c) => c === '…') && out.loading.pill === '…' && counts(out.failed).every((c) => c === '—') && out.failed.pill === '—' &&
        counts(out.changed).every((c) => c === '—') && out.changed.pill === '—' && out.changed.alert === 1 &&
        out.staleEmpty.pill === '0' && out.staleEmpty.note === 1 && out.staleEmpty.empty === 1,
      screenshots: files,
    };
  });

  // ======================= 4. the read's states (C07, C08) =======================
  await scenario('states@1440', ['E8-C07', 'E8-C08', 'R03'], async () => {
    const out = {};
    const files = [];
    {
      const { ctx, p } = await open(1440, { ...view('table'), delay: [[LIST, 4000]] });
      await p.goto(`${job.ui}/products`, { waitUntil: 'domcontentloaded' });
      const sk = p.getByTestId('products-skeleton');
      await sk.waitFor({ timeout: 3500 }).catch(() => {});
      out.skeleton = { shown: await sk.count(), shape: (await sk.count()) ? await sk.getAttribute('data-shape') : null, empty: await p.getByText('Виробів ще немає').count() };
      files.push(await shoot(p, 'states-skeleton@1440'));
      await ctx.close();
    }
    {
      let calls = 0;
      const { ctx, p } = await open(1440, { ...view('table'), gets: [[LIST, () => { calls += 1; return calls <= 2 ? { fail: 500 } : null; }]] });
      await catalog(p);
      await p.waitForTimeout(1500);
      const alert = p.getByRole('alert');
      out.failed = { alert: (await alert.count()) ? await textOf(alert.first()) : null, empty: await p.getByText('Нічого не знайдено').count() };
      files.push(await shoot(p, 'states-failed@1440'));
      if (await alert.count()) await alert.getByRole('button', { name: 'Спробувати знову' }).click();
      await p.waitForTimeout(1500);
      out.retried = { rows: (await rowIds(p)).length, alert: await p.getByRole('alert').count() };
      await ctx.close();
    }
    {
      let calls = 0;
      const { ctx, p } = await open(1440, { ...view('table'), gets: [[LIST, () => { calls += 1; return calls === 1 ? null : { fail: 500 }; }]] });
      await p.clock.install();
      await catalog(p);
      await refetchLater(p);
      await p.waitForTimeout(1500);
      out.refresh = { rows: (await rowIds(p)).length, note: await refreshNote(p) };
      files.push(await shoot(p, 'states-refresh-failed@1440'));
      await ctx.close();
    }
    {
      let calls = 0;
      const empty = onlyRows([], { categories: [], uncategorized: 0, all_categories: 0, catalog_total: 0 });
      const { ctx, p } = await open(1440, { ...view('table'), gets: [[LIST, () => { calls += 1; return calls === 1 || calls >= 4 ? { rewrite: empty } : { fail: 500 }; }]] });
      await p.clock.install();
      await catalog(p);
      const first = await p.getByText('Виробів ще немає').count();
      await refetchLater(p);
      await p.waitForTimeout(1500);
      out.emptyThenFail = { first, kept: await p.getByText('Виробів ще немає').count(), note: await refreshNote(p) };
      files.push(await shoot(p, 'states-empty-refresh-failed@1440'));
      const retry = p.getByRole('button', { name: 'Спробувати знову' });
      if (await retry.count()) await retry.first().click();
      await p.waitForTimeout(1500);
      out.emptyRetried = { kept: await p.getByText('Виробів ще немає').count(), note: await refreshNote(p) };
      await ctx.close();
    }
    {
      const { ctx, p } = await open(1440, view('table'));
      await catalog(p, '?q=%D0%B6%D0%B6%D0%B6%D0%B6%D0%B6');
      out.noMatch = {
        title: await p.getByText('Нічого не знайдено').count(), hint: await p.getByText('Спробуйте коротший запит або приберіть фільтри.').count(),
        own: await p.getByRole('button', { name: 'Скинути фільтри' }).count(), toolbar: await p.getByRole('button', { name: 'Скинути', exact: true }).count(),
        zero: await p.getByText('0 результатів').count(),
      };
      files.push(await shoot(p, 'states-no-match@1440'));
      await ctx.close();
    }
    return {
      recipe: {
        url: '/products',
        fixture: ['GET /products?page=…: delayed 4 s', '1st + 2nd → 500, then the stand', '2nd+ → 500 on the re-read', 'empty, then 500 ×2 on the re-read, then empty', '?q=жжжжж (the stand: no match)'],
      },
      measured: out,
      pass: out.skeleton.shown === 1 && out.skeleton.shape === 'table' && out.skeleton.empty === 0 &&
        /Не вдалося завантажити вироби/.test(out.failed.alert ?? '') && out.failed.empty === 0 && out.retried.rows > 0 && out.retried.alert === 0 &&
        out.refresh.rows > 0 && out.refresh.note === 1 &&
        out.emptyThenFail.first === 1 && out.emptyThenFail.kept === 1 && out.emptyThenFail.note === 1 && out.emptyRetried.kept === 1 && out.emptyRetried.note === 0 &&
        out.noMatch.title === 1 && out.noMatch.hint === 1 && out.noMatch.own === 1 && out.noMatch.toolbar === 0 && out.noMatch.zero === 1,
      screenshots: files,
    };
  });

  await scenario('states-page@1440', ['E8-C08', 'E8-C10', 'R08'], async () => {
    let failing = false;
    const { ctx, p, requests } = await open(1440, { ...view('table'), gets: [[LIST, (url) => (failing && /page=4/.test(url) ? { fail: 500 } : null)]] });
    await catalog(p);
    failing = true;
    await p.goto(`${job.ui}/products?page=4`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(1500);
    const failedUrl = await urlOf(p);
    const alert = await p.getByRole('alert').count();
    const file = await shoot(p, 'states-page4-failed@1440');
    failing = false;
    await p.getByRole('alert').getByRole('button', { name: 'Спробувати знову' }).click();
    const params = await waitParams(requests, (q) => q.page === '4');
    await p.waitForTimeout(1000);
    const rows = (await rowIds(p)).length;
    const url = await urlOf(p);
    await ctx.close();
    return {
      recipe: { url: '/products → /products?page=4', fixture: ['GET /products?page=4: 500 until «Спробувати знову»'] },
      measured: { failedUrl, alert, params, rows, url },
      pass: failedUrl === '/products?page=4' && alert === 1 && rows > 0 && url === '/products?page=4',
      screenshots: [file],
    };
  });

  // ======================= 5. the table (D01–D04) =======================
  for (const w of [2560, 1920, 1440, 1280, 1024, 768, 390]) {
    await scenario(`table@${w}`, ['E8-D01', 'E8-D04', 'P03'], async () => {
      const { ctx, p, errors } = await open(w, view('table'));
      await catalog(p);
      const headers = await headersOf(p);
      const geo = await p.evaluate(() => {
        const table = document.querySelector('table');
        const region = table.closest('[role="region"]');
        const first = table.querySelector('thead th');
        return {
          share: Math.round((first.getBoundingClientRect().width / table.getBoundingClientRect().width) * 1000) / 10,
          region: region ? { label: region.getAttribute('aria-label'), tab: region.tabIndex, scroll: region.scrollWidth - region.clientWidth } : null,
        };
      });
      const overflow = await docOverflow(p);
      const sticking = overflow > 0 ? await offenders(p) : [];
      const file = await shoot(p, `table@${w}`);
      await ctx.close();
      // D04 (ruling, ledger T7): the six columns fit from 1024 up — the mockup's own table overflows its
      // panel at 768 too; from 1023 down the table scrolls inside its region, never the page.
      const narrow = w < 1024;
      return {
        recipe: { url: '/products', viewport: w },
        env: { viewport: [w, HEIGHTS[w]] },
        measured: { headers, geo, overflow, sticking, errors },
        pass: JSON.stringify(headers) === JSON.stringify(HEADERS) && geo.region && geo.region.label === 'Каталог виробів' && geo.region.tab === 0 &&
          (narrow ? geo.region.scroll > 0 : geo.region.scroll <= 0 && Math.abs(geo.share - 36) <= 1.5) && overflow <= 0 && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('table-cells@1440', ['E8-D01', 'E8-B01', 'E8-B02', 'E8-B03', 'E8-B04', 'E8-B05', 'E8-B06', 'P03'], async () => {
    const r1 = rowOf('1');
    const r8 = rowOf('8');
    const r11 = rowOf('11');
    const r900 = rowOf('900');
    const r5 = rowOf('5');
    if (![r1, r8, r11, r900, r5].every(Boolean)) return { pass: null, measured: { missing: true } };
    const unsliced = { ...r5, sliced: false, models: [] };
    const { ctx, p, errors } = await open(1440, { ...view('table'), rewrite: [[LIST, onlyRows([r1, r8, r11, r900, unsliced])]] });
    await catalog(p, '?catalog=0&adhoc=1');
    const cell = (id, i) => textOf(p.getByTestId(`product-row-${id}`).locator('td').nth(i));
    const out = {
      p1: { name: await cell(r1.id, 0), comp: await cell(r1.id, 1), models: await cell(r1.id, 2), materials: await cell(r1.id, 3), stock: await cell(r1.id, 4) },
      p8: { comp: await cell(r8.id, 1) },
      p11: { name: await cell(r11.id, 0) },
      p900: { name: await cell(r900.id, 0) },
      p5: { models: await cell(r5.id, 2) },
      swatches: await p.getByTestId(`product-row-${r1.id}`).locator('[data-swatch]').count(),
    };
    const file = await shoot(p, 'table-cells@1440');
    await ctx.close();
    return {
      recipe: { url: '/products?catalog=0&adhoc=1', fixture: ['GET /products?page=…: the stand rows of products 1, 8, 11, 900 and 5 — 5 shown unsliced (sliced false, no models: the stand has none)'] },
      measured: { out, errors },
      pass: out.p1.name.includes(r1.code) && /4 дет\. \+ 2 куп\. · \d+ плит/.test(out.p1.comp) && /варіанти:/.test(out.p1.comp) && /в 1 активному замовленні/.test(out.p1.comp) &&
        /у 2 конфіг\./.test(out.p1.stock) && /нижче мінімуму/.test(out.p1.stock) && /комплект/.test(out.p1.stock) && out.swatches > 0 &&
        /в 2 активних замовленнях/.test(out.p8.comp) && /не в каталозі/.test(out.p11.name) && /разовий/.test(out.p900.name) && /Чернетка/.test(out.p900.name) &&
        /не нарізано/.test(out.p5.models) && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('table-sort@1440', ['E8-D02', 'E8-D03', 'R05'], async () => {
    const { ctx, p, errors, requests } = await open(1440, view('table'));
    await catalog(p, '?sort=updated-desc');
    const steps = [];
    const click = async (name, pred) => {
      await p.locator('table thead').getByRole('button', { name, exact: true }).click();
      steps.push({ name, params: await waitParams(requests, pred), url: await urlOf(p) });
    };
    await click('Склад виробу', (q) => q.sort_by === 'printed_parts-desc');
    await click('Склад', (q) => q.sort_by === 'finished-desc');
    await click('Виріб / артикул', (q) => q.sort_by === 'name-asc');
    await click('Виріб / артикул', (q) => q.sort_by === 'name-desc');
    const unsortable = await p.locator('table thead').getByRole('button', { name: /Принтери|Матеріал/ }).count();
    // A key only the cards offer: back in the table it is named, and taken off.
    await p.getByRole('button', { name: 'Картки' }).click();
    await setSelect(p, 'Сортування', 'plates');
    await waitParams(requests, (q) => q.sort_by === 'plates-desc');
    await p.getByRole('button', { name: 'Таблиця' }).click();
    await p.waitForTimeout(600);
    const chip = await textOf(p.getByTestId('products-sort-chip'));
    const file = await shoot(p, 'table-sort-chip@1440');
    await p.getByRole('button', { name: 'Повернути типове сортування таблиці' }).click();
    await p.waitForTimeout(800);
    // name-asc page 1 was asked by the header clicks above and is still fresh — no new request.
    const back = { asked: sawParams(requests, (q) => q.sort_by === 'name-asc' && q.page === '1'), rows: (await rowIds(p)).length };
    const url = await urlOf(p);
    const chipGone = await p.getByTestId('products-sort-chip').count();
    await ctx.close();
    return {
      recipe: { url: '/products?sort=updated-desc', actions: ['«Склад виробу»', '«Склад»', '«Виріб / артикул» ×2', 'cards: sort by «Плит»', 'table: take the chip off'] },
      measured: { steps, unsortable, chip, back, url, chipGone, errors },
      pass: steps.length === 4 && unsortable === 0 && chip === 'Сортування: Плит ↓' && back.asked && back.rows > 0 && url === '/products' && chipGone === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('table-sort-keys@1440', ['E8-D03', 'R05', 'E8-C10'], async () => {
    const out = {};
    {
      const { ctx, p, requests } = await open(1440, view('table'));
      await catalog(p, '?sort=parts-desc');
      out.partsTable = { chip: await textOf(p.getByTestId('products-sort-chip')), sent: lastParams(requests).sort_by, ids: await rowIds(p) };
      await catalog(p, '?sort=plates-asc');
      out.platesTable = { chip: await textOf(p.getByTestId('products-sort-chip')), sent: lastParams(requests).sort_by };
      await catalog(p, '?sort=parts-desc&page=2');
      out.parts2 = await rowIds(p);
      await catalog(p, '?sort=printed_parts-desc&page=2');
      out.printed2 = await rowIds(p);
      await ctx.close();
    }
    {
      const { ctx, p } = await open(1440, view('cards'));
      await catalog(p, '?sort=parts-desc');
      out.partsCards = {
        option: await p.getByLabel('Сортування').inputValue(), label: await p.getByLabel('Сортування').evaluate((s) => s.selectedOptions[0]?.textContent),
        desc: await p.getByRole('button', { name: 'За спаданням' }).count(), ids: await cardIds(p), chip: await p.getByTestId('products-sort-chip').count(),
      };
      await catalog(p, '?sort=plates-asc');
      out.platesCards = { option: await p.getByLabel('Сортування').inputValue(), asc: await p.getByRole('button', { name: 'За зростанням' }).count() };
      await ctx.close();
    }
    return {
      recipe: { urls: ['/products?sort=parts-desc', '?sort=plates-asc', '?sort=parts-desc&page=2', '?sort=printed_parts-desc&page=2'], views: ['table', 'cards'] },
      measured: out,
      pass: out.partsTable.chip === 'Сортування: Усіх деталей ↓' && out.partsTable.sent === 'parts-desc' && out.platesTable.chip === 'Сортування: Плит ↑' &&
        out.platesTable.sent === 'plates-asc' && out.partsCards.option === 'parts' && out.partsCards.label === 'Усіх деталей' && out.partsCards.chip === 0 &&
        JSON.stringify(out.partsCards.ids) === JSON.stringify(out.partsTable.ids) && out.platesCards.option === 'plates' &&
        out.parts2.length > 0 && JSON.stringify(out.parts2) !== JSON.stringify(out.printed2),
    };
  });

  await scenario('covers@1440', ['E8-B07', 'K11'], async () => {
    const r1 = rowOf('1');
    const r8 = rowOf('8');
    const r5 = rowOf('5');
    if (![r1, r8, r5].every(Boolean) || !job.cover_png) return { pass: null, measured: { missing: true } };
    const coverOf = (id) => new RegExp(`/api/v1/products/${id}/cover-image`);
    let second = false;
    const { ctx, p, errors, requests } = await open(1440, {
      ...view('table'),
      rewrite: [[LIST, (b) => onlyRows(second ? [{ ...r5, has_cover: true }] : [{ ...r1, has_cover: true }, { ...r8, has_cover: true }])(b)]],
      gets: [[coverOf(r1.id), () => ({ file: job.cover_png })], [coverOf(r8.id), () => ({ fail: 404 })], [coverOf(r5.id), () => ({ file: job.cover_png })]],
    });
    await catalog(p);
    await p.waitForTimeout(1000);
    const picture = (id) => p.getByTestId(`product-row-${id}`).locator('td').first().evaluate(async (td) => {
      const img = td.querySelector('[data-testid="product-cover"]');
      const ph = td.querySelector('[data-testid="product-cover-placeholder"]');
      const el = img ?? ph;
      const r = el.getBoundingClientRect();
      let decoded = false;
      if (img) { try { await img.decode(); decoded = true; } catch { decoded = false; } }
      return { img: !!img, placeholder: !!ph, box: [Math.round(r.width), Math.round(r.height)], naturalWidth: img ? img.naturalWidth : 0, decoded };
    });
    const a = await picture(r1.id);
    const b = await picture(r8.id);
    const file = await shoot(p, 'covers@1440', { clip: { x: 0, y: 0, width: 1440, height: 600 } });
    // Another product in the same place: its own picture, not the failure of the last.
    second = true;
    await p.getByLabel('Наявність', { exact: true }).selectOption('kits');
    await p.waitForTimeout(1500);
    const c = await picture(r5.id);
    const tokened = requests.filter((r) => /\/cover-image\?token=masked/.test(r)).length;
    await ctx.close();
    return {
      recipe: { url: '/products', fixture: ['GET /products?page=…: the stand rows of 1 and 8 with has_cover, then of 5 (rewritten)', `GET …/products/{1,5}/cover-image → a real ${(job.cover_size ?? []).join('×')} PNG; {8} → 404`] },
      measured: { a, b, c, tokened, errors },
      pass: a.img && a.decoded && a.naturalWidth === (job.cover_size ?? [96])[0] && a.box[0] === 40 && a.box[1] === 40 &&
        !b.img && b.placeholder && b.box[0] === 40 && b.box[1] === 40 && c.img && c.decoded && tokened >= 2 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 6. the cards (E01–E04) =======================
  for (const w of [1920, 1440, 1024, 390]) {
    await scenario(`cards@${w}`, ['E8-E01', 'E8-E02', 'E8-E04', 'P04'], async () => {
      const { ctx, p, errors } = await open(w, view('cards'));
      await catalog(p);
      const geo = await p.evaluate(() => {
        const first = document.querySelector('[data-testid$="-card"][data-testid^="product-"]');
        const grid = first.parentElement;
        const cards = [...grid.children].filter((c) => c.getClientRects().length);
        const cols = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left))).size;
        const rowTop = Math.round(cards[0].getBoundingClientRect().top);
        const row = cards.filter((c) => Math.round(c.getBoundingClientRect().top) === rowTop);
        const footers = row.map((c) => Math.round(c.querySelector('[data-part="footer"]').getBoundingClientRect().bottom));
        const top = (sel) => { const el = first.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().top) : null; };
        const order = [
          top('[data-testid="product-cover"], [data-testid="product-cover-placeholder"]'),
          top('[data-testid="product-identity"]'),
          top('[data-testid="product-name"]'),
          top('[data-testid="product-composition"]'),
          top('[data-testid="product-models"]'),
          top('[data-testid="product-stock"]'),
        ];
        const visual = first.querySelector('[data-testid="product-cover"], [data-testid="product-cover-placeholder"]').getBoundingClientRect();
        return { cols, cardW: Math.round(cards[0].getBoundingClientRect().width), footers, order, visual: [Math.round(visual.width), Math.round(visual.height)], inner: Math.round(first.getBoundingClientRect().width - 32) };
      });
      const overflow = await docOverflow(p);
      const file = await shoot(p, `cards@${w}`);
      await ctx.close();
      const sorted = geo.order.every((t, i) => t !== null && (i === 0 || t >= geo.order[i - 1]));
      return {
        recipe: { url: '/products', viewport: w },
        env: { viewport: [w, HEIGHTS[w]] },
        measured: { geo, sorted, overflow, errors },
        pass: geo.cols >= (w <= 390 ? 1 : 2) && geo.cardW >= Math.min(260, w - 40) && sorted && new Set(geo.footers).size === 1 &&
          geo.visual[1] === 120 && Math.abs(geo.visual[0] - geo.inner) <= 1 && overflow <= 0 && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('cards-overlay@1440', ['E8-E02', 'E8-E03'], async () => {
    const { ctx, p, errors } = await open(1440, view('cards'));
    await catalog(p);
    const card = p.locator('[data-testid$="-card"][data-testid^="product-"]').first();
    const link = await card.getByRole('link').first().getAttribute('aria-label');
    await card.getByTestId('product-menu').click();
    const menu = await p.getByRole('menu').count();
    const url = await urlOf(p);
    await p.keyboard.press('Escape');
    // A swatch's title is reachable by the mouse — the overlay does not cover it.
    const swatch = await p.evaluate(() => {
      const el = document.querySelector('[data-testid$="-card"] [data-testid="product-materials"] [data-swatch]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { title: el.getAttribute('title'), hits: hit === el };
    });
    const orders = await card.evaluate((c) => /активн\w* замовлен/.test(c.textContent));
    const kitsPill = await p.getByTestId('product-kits-badge').count();
    const name = await card.getByTestId('product-name').textContent();
    const at = await card.getByTestId('product-name').boundingBox();
    await p.mouse.click(at.x + 4, at.y + at.height / 2);
    await p.waitForURL(/\/products\/\d+/, { timeout: 10000 });
    const went = await urlOf(p);
    await ctx.close();
    return {
      recipe: { url: '/products', actions: ['the first card’s menu', 'Escape', 'hover point of a swatch', 'click the name'] },
      measured: { link, menu, url, swatch, orders, kitsPill, name, went, errors },
      pass: link === name && menu === 1 && url === '/products' && swatch && swatch.title && swatch.hits && !orders && kitsPill === 0 && /\/products\/\d+$/.test(went) && errors.length === 0,
    };
  });

  await scenario('cards-long@390', ['E8-E04', 'E8-B02'], async () => {
    const r1 = rowOf('1');
    if (!r1) return { pass: null, measured: { missing: true } };
    const long = { ...r1, name: `${'Дуже-довга-назва-виробу-'.repeat(5)}кінець`, sku: 'SKU-'.repeat(20) };
    const { ctx, p, errors } = await open(390, { ...view('cards'), rewrite: [[LIST, onlyRows([long])]] });
    await catalog(p);
    const geo = await p.evaluate(() => {
      const card = document.querySelector('[data-testid$="-card"][data-testid^="product-"]');
      const c = card.getBoundingClientRect();
      const inside = [...card.querySelectorAll('*')].filter((el) => el.getClientRects().length).every((el) => el.getBoundingClientRect().right <= c.right + 0.5);
      return { card: Math.round(c.width), vw: innerWidth, inside };
    });
    const overflow = await docOverflow(p);
    const file = await shoot(p, 'cards-long@390', { fullPage: true });
    await ctx.close();
    return {
      recipe: { url: '/products', viewport: 390, fixture: ['GET /products?page=…: product 1 with a 125-letter name and an 80-letter SKU (rewritten)'] },
      measured: { geo, overflow, errors },
      pass: geo.inside && geo.card <= geo.vw - 32 && overflow <= 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 7. the menu and its actions (F01–F09) =======================
  const firstMenuOf = (p, id) => p.getByTestId(`product-${id}-row-menu`);
  await scenario('menu-items@1440', ['E8-F02', 'P11'], async () => {
    const r1 = rowOf('1');
    const r11 = rowOf('11');
    const r900 = rowOf('900');
    if (![r1, r11, r900].every(Boolean)) return { pass: null, measured: { missing: true } };
    const hiddenOneOff = { ...r900, is_active: false };
    const out = {};
    {
      const { ctx, p } = await open(1440, { ...view('table'), rewrite: [[LIST, onlyRows([r1, r11, r900])]] });
      await catalog(p, '?catalog=0&adhoc=1');
      for (const [k, r] of [['catalog', r1], ['hidden', r11], ['oneOff', r900]]) {
        await firstMenuOf(p, r.id).click();
        await p.getByRole('menuitem').first().waitFor({ timeout: 5000 });
        out[k] = (await menuItems(p)).map((m) => m.text);
        await p.keyboard.press('Escape');
        await p.getByRole('menu').waitFor({ state: 'detached', timeout: 5000 });
      }
      await ctx.close();
    }
    {
      const { ctx, p } = await open(1440, { ...view('table'), rewrite: [[LIST, onlyRows([hiddenOneOff])]] });
      await catalog(p, '?catalog=0&adhoc=1');
      await firstMenuOf(p, r900.id).click();
      await p.getByRole('menuitem').first().waitFor({ timeout: 5000 });
      out.hiddenOneOff = (await menuItems(p)).map((m) => m.text);
      await ctx.close();
    }
    {
      const { ctx, p } = await open(1440, { ...view('table'), me: READER, rewrite: [[LIST, onlyRows([r1])]] });
      await catalog(p);
      await firstMenuOf(p, r1.id).click();
      await p.getByRole('menuitem').first().waitFor({ timeout: 5000 });
      out.reader = (await menuItems(p)).map((m) => m.text);
      await ctx.close();
    }
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    return {
      recipe: { url: '/products?catalog=0&adhoc=1', fixture: ['GET /products?page=…: the stand rows of 1, 11 and 900; 900 also shown hidden (rewritten)', 'a reader (GET /auth/me merged)'] },
      measured: out,
      pass: eq(out.catalog, ['Редагувати', 'До замовлення…', 'Дублювати', 'Експорт ZIP', 'Прибрати з каталогу', 'Видалити']) &&
        eq(out.hidden, ['Редагувати', 'Дублювати', 'Експорт ZIP', 'Повернути до каталогу', 'Видалити']) &&
        eq(out.oneOff, ['Редагувати', 'Дублювати', 'Експорт ZIP', 'Додати в каталог…', 'Видалити']) &&
        eq(out.hiddenOneOff, ['Редагувати', 'Дублювати', 'Експорт ZIP', 'Додати в каталог…', 'Видалити']) && eq(out.reader, ['Експорт ZIP']),
    };
  });

  await scenario('menu-duplicate@1440', ['E8-F03', 'R02'], async () => {
    const r1 = rowOf('1');
    if (!r1) return { pass: null, measured: { missing: true } };
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      ...view('table'),
      rewrite: [[LIST, onlyRows([r1])]],
      writes: [recorder(writes, /\/products\/\d+\/duplicate/, () => ({ ...detail1, id: r1.id }))],
    });
    await catalog(p);
    await firstMenuOf(p, r1.id).click();
    await p.getByRole('menuitem', { name: 'Дублювати' }).click();
    await toastText(p, /Копію створено — склад, варіанти й файли скопійовано, залишки ні/);
    const url = await urlOf(p);
    await ctx.close();
    return {
      recipe: { url: '/products', fixture: ['GET /products?page=…: product 1 alone', 'POST …/duplicate answered by the runner with product 1 itself (the stand is not written)'] },
      measured: { writes, url, errors },
      pass: writes.length === 1 && writes[0].body && writes[0].body.name === `${r1.name} (копія)` && url === `/products/${r1.id}` && errors.length === 0,
    };
  });

  await scenario('menu-duplicate-long@1440', ['E8-F03', 'R02'], async () => {
    const r1 = rowOf('1');
    if (!r1) return { pass: null, measured: { missing: true } };
    const names = { cyrillic: 'Ж'.repeat(255), astral: '😀'.repeat(250) };
    const out = {};
    for (const [k, name] of Object.entries(names)) {
      const writes = [];
      const { ctx, p } = await open(1440, {
        ...view('table'),
        rewrite: [[LIST, onlyRows([{ ...r1, name }])]],
        writes: [recorder(writes, /\/products\/\d+\/duplicate/, () => ({ ...detail1, id: r1.id }))],
      });
      await catalog(p);
      await firstMenuOf(p, r1.id).click();
      await p.getByRole('menuitem', { name: 'Дублювати' }).click();
      await p.waitForTimeout(1500);
      const sentName = writes[0]?.body?.name ?? '';
      out[k] = { requests: writes.length, points: Array.from(sentName).length, suffix: sentName.endsWith(' (копія)'), loneSurrogate: /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(sentName) };
      await ctx.close();
    }
    return {
      recipe: { url: '/products', fixture: ['GET /products?page=…: product 1 named 255 «Ж» / 250 «😀» (rewritten)', 'POST …/duplicate answered by the runner'] },
      measured: out,
      pass: Object.values(out).every((o) => o.requests === 1 && o.points <= 255 && o.suffix && !o.loneSurrogate),
    };
  });

  await scenario('menu-export@1440', ['E8-F04'], async () => {
    const r1 = rowOf('1');
    if (!r1) return { pass: null, measured: { missing: true } };
    const { ctx, p, errors } = await open(1440, { ...view('table'), rewrite: [[LIST, onlyRows([r1])]] });
    await catalog(p);
    await firstMenuOf(p, r1.id).click();
    const download = p.waitForEvent('download', { timeout: 15000 });
    await p.getByRole('menuitem', { name: 'Експорт ZIP' }).click();
    const d = await download;
    const name = d.suggestedFilename();
    await ctx.close();
    return {
      recipe: { url: '/products', fixture: ['GET /products?page=…: product 1 alone'], actions: ['«Експорт ZIP» (a read of the stand: the export is a GET)'] },
      measured: { name, errors },
      pass: /\.zip$/i.test(name) && errors.length === 0,
    };
  });

  await scenario('menu-hide@1440', ['E8-F05'], async () => {
    const r1 = rowOf('1');
    const r11 = rowOf('11');
    if (![r1, r11].every(Boolean)) return { pass: null, measured: { missing: true } };
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      ...view('table'),
      rewrite: [[LIST, onlyRows([r1, r11])]],
      writes: [recorder(writes, /\/api\/v1\/products\/\d+$/, (e) => ({ ...detail1, id: Number(e.path.split('/').pop()), is_active: e.body.is_active }))],
    });
    await catalog(p, '?catalog=0');
    await firstMenuOf(p, r1.id).click();
    await p.getByRole('menuitem', { name: 'Прибрати з каталогу' }).click();
    await toastText(p, /Виріб прибрано з каталогу/);
    await firstMenuOf(p, r11.id).click();
    await p.getByRole('menuitem', { name: 'Повернути до каталогу' }).click();
    await toastText(p, /Виріб повернуто до каталогу/);
    const url = await urlOf(p);
    await ctx.close();
    return {
      recipe: { url: '/products?catalog=0', fixture: ['GET /products?page=…: products 1 and 11', 'PATCH /products/{id} answered by the runner'] },
      measured: { writes, url, errors },
      pass: writes.length === 2 && writes[0].method === 'PATCH' && JSON.stringify(writes[0].body) === '{"is_active":false}' && JSON.stringify(writes[1].body) === '{"is_active":true}' &&
        url === '/products?catalog=0' && errors.length === 0,
    };
  });

  await scenario('menu-hide-last@1440', ['E8-F05', 'R08'], async () => {
    const out = {};
    for (const reread of ['ok', 'fails']) {
      let hidden = false;
      const writes = [];
      const { ctx, p } = await open(1440, {
        ...view('table'),
        gets: [[LIST, (url) => {
          if (!hidden || !/page=5/.test(url)) return null;
          if (reread === 'fails') return { fail: 500 };
          // The last page's last product is gone: the server's answer for page 5 is past the end.
          return { rewrite: (b) => ({ ...b, items: [], meta: { ...b.meta, total: 96, last_page: 4, current_page: 5 } }) };
        }]],
        writes: [recorder(writes, /\/api\/v1\/products\/\d+$/, (e) => { hidden = true; return { ...detail1, id: Number(e.path.split('/').pop()), is_active: false }; })],
      });
      await catalog(p, '?page=5');
      const before = await rowIds(p);
      const last = before[before.length - 1];
      await firstMenuOf(p, last).click();
      await p.getByRole('menuitem', { name: 'Прибрати з каталогу' }).click();
      await p.waitForTimeout(3000);
      out[reread] = { before: before.length, url: await urlOf(p), writes: writes.length, alert: await p.getByRole('alert').count() };
      await ctx.close();
    }
    return {
      recipe: { url: '/products?page=5', fixture: ['after the PATCH (answered by the runner) page 5 is answered as past the end (last_page 4) — or 500'] },
      measured: out,
      pass: out.ok.writes === 1 && out.ok.url === '/products?page=4' && out.fails.writes === 1 && out.fails.url === '/products?page=5',
    };
  });

  await scenario('menu-promote@1440', ['E8-F06', 'R04'], async () => {
    const r900 = rowOf('900');
    if (!r900) return { pass: null, measured: { missing: true } };
    const out = {};
    for (const [k, row] of [['active', r900], ['hidden', { ...r900, is_active: false }]]) {
      const writes = [];
      const { ctx, p } = await open(1440, {
        ...view('table'),
        rewrite: [[LIST, onlyRows([row])]],
        writes: [recorder(writes, /\/api\/v1\/products\/\d+$/, () => ({ ...detail1, id: r900.id, origin: 'catalog', is_active: row.is_active }))],
      });
      await catalog(p, '?adhoc=1&catalog=0');
      await firstMenuOf(p, r900.id).click();
      await p.getByRole('menuitem', { name: 'Додати в каталог…' }).click();
      const dialog = p.getByRole('dialog', { name: 'Додати виріб до каталогу?' });
      const text = await textOf(dialog);
      const file = await shoot(p, `menu-promote-${k}@1440`);
      await dialog.getByRole('button', { name: 'Додати до каталогу' }).click();
      await toastText(p, /Додано до каталогу/);
      out[k] = { text, writes, file };
      await ctx.close();
    }
    return {
      recipe: { url: '/products?adhoc=1&catalog=0', fixture: ['GET /products?page=…: the one-off 900, active / hidden', 'PATCH answered by the runner'] },
      measured: out,
      pass: ['active', 'hidden'].every((k) => out[k].writes.length === 1 && JSON.stringify(out[k].writes[0].body) === '{"origin":"catalog"}' &&
        out[k].text.includes(`${r900.code} · ${r900.name}`) && /Повернути його в разові не можна/.test(out[k].text)) &&
        /Його побачать каталог і пікери/.test(out.active.text) && /Він лишиться прихованим/.test(out.hidden.text),
      screenshots: [out.active.file, out.hidden.file],
    };
  });

  await scenario('menu-delete@1440', ['E8-F07', 'E8-F09'], async () => {
    const r1 = rowOf('1');
    if (!r1) return { pass: null, measured: { missing: true } };
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      ...view('table'),
      rewrite: [[LIST, onlyRows([r1])]],
      writes: [recorder(writes, /\/api\/v1\/products\/\d+$/, (e, n) => (n === 1 ? { __status: 409, json: { detail: 'The product has finished goods in stock' } } : { message: 'ok' }))],
    });
    await catalog(p);
    await firstMenuOf(p, r1.id).click();
    await p.getByRole('menuitem', { name: 'Видалити' }).click();
    const dialog = p.getByRole('dialog', { name: 'Видалити виріб?' });
    const text = await textOf(dialog);
    await dialog.getByRole('button', { name: 'Видалити' }).click();
    await dialog.getByRole('alert').waitFor({ timeout: 8000 });
    const refusal = await textOf(dialog.getByRole('alert'));
    const focus = await p.evaluate(() => document.activeElement?.textContent?.trim());
    const inDialog = await p.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
    const file = await shoot(p, 'menu-delete-409@1440');
    await dialog.getByRole('button', { name: 'Видалити' }).click();
    await toastText(p, /Виріб видалено/);
    const closed = await p.getByRole('dialog').count();
    await p.waitForTimeout(400);
    const focusAfter = await p.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName);
    await ctx.close();
    return {
      recipe: { url: '/products', fixture: ['GET /products?page=…: product 1 alone', 'DELETE: 1st → 409 «The product has finished goods in stock», 2nd → 200 (answered by the runner)'] },
      measured: { text, refusal, focus, inDialog, writes: writes.map((w) => w.method), closed, focusAfter, errors },
      pass: text.includes(`${r1.code} · ${r1.name}`) && /Файли в бібліотеці лишаться/.test(text) && refusal === 'The product has finished goods in stock' && inDialog &&
        writes.length === 2 && writes.every((w) => w.method === 'DELETE') && closed === 0 && /row-menu|H1/.test(focusAfter ?? '') && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('menu-delete-ghost@1440', ['E8-F07', 'R06'], async () => {
    const r1 = rowOf('1');
    if (!r1) return { pass: null, measured: { missing: true } };
    let deleted = false;
    const { ctx, p, errors, requests } = await open(1440, {
      ...view('table'),
      rewrite: [[LIST, (b) => onlyRows(deleted ? [] : [r1])(b)]],
      gets: [[new RegExp(`/api/v1/products/${r1.id}(\\?.*)?$`), () => (deleted ? { fail: 404 } : null)]],
      writes: [[/\/api\/v1\/products\/\d+$/, () => { deleted = true; return { message: 'ok' }; }]],
    });
    // The product page first — its entry lands in the cache.
    await p.goto(`${job.ui}/products/${r1.id}`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(800);
    await p.getByRole('link', { name: 'Вироби' }).first().click();
    await p.waitForURL(/\/products$/, { timeout: 10000 });
    await p.waitForTimeout(800);
    await firstMenuOf(p, r1.id).click();
    await p.getByRole('menuitem', { name: 'Видалити' }).click();
    await p.getByRole('dialog').getByRole('button', { name: 'Видалити' }).click();
    await toastText(p, /Виріб видалено/);
    await p.goBack({ waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
    const backShows = await p.getByRole('heading', { level: 1, name: r1.name }).count();
    const file = await shoot(p, 'menu-delete-ghost-back@1440');
    await ctx.close();
    return {
      recipe: { url: '/products/{product:1} → /products', fixture: ['DELETE answered by the runner; after it GET /products/{id} → 404 and the list without it'], actions: ['delete from the catalog', 'Back to the product page'] },
      measured: { backShows, requests: requests.filter((r) => r.includes(`/products/${r1.id}`)).slice(-4), errors },
      pass: backShows === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('menu-to-order@1440', ['E8-F02', 'E5-G01'], async () => {
    const r1 = rowOf('1');
    if (!r1) return { pass: null, measured: { missing: true } };
    const { ctx, p, errors, requests } = await open(1440, { ...view('table'), rewrite: [[LIST, (b, url) => (/q=PR-/.test(url) ? b : onlyRows([r1])(b))]] });
    await catalog(p);
    await firstMenuOf(p, r1.id).click();
    await p.getByRole('menuitem', { name: 'До замовлення…' }).click();
    const dialog = p.getByRole('dialog').first();
    await dialog.waitFor({ timeout: 10000 });
    await p.waitForTimeout(1500);
    const asked = listParams(requests).some((q) => q.q === r1.code);
    const file = await shoot(p, 'menu-to-order@1440');
    await ctx.close();
    return {
      recipe: { url: '/products', fixture: ['GET /products?page=…: product 1 alone (the dialog’s own search answered by the stand)'], actions: ['«До замовлення…»'] },
      measured: { asked, errors },
      pass: asked && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('menu-survives@1440', ['E8-F08', 'E8-F09'], async () => {
    const r1 = rowOf('1');
    const r8 = rowOf('8');
    if (![r1, r8].every(Boolean)) return { pass: null, measured: { missing: true } };
    let gone = false;
    const { ctx, p, errors } = await open(1440, { ...view('table'), rewrite: [[LIST, (b) => onlyRows(gone ? [r8] : [r1, r8])(b)]] });
    await p.clock.install();
    await catalog(p);
    await firstMenuOf(p, r1.id).click();
    await p.getByRole('menuitem', { name: 'Видалити' }).click();
    const dialog = p.getByRole('dialog', { name: 'Видалити виріб?' });
    gone = true;
    await refetchLater(p);
    const rowGone = (await p.getByTestId(`product-row-${r1.id}`).count()) === 0;
    const stays = await dialog.count();
    await dialog.getByRole('button', { name: 'Скасувати' }).click();
    await p.waitForTimeout(500);
    const focus = await p.evaluate(() => document.activeElement?.tagName);
    await ctx.close();
    return {
      recipe: { url: '/products', fixture: ['GET /products?page=…: 1 and 8; after the re-read 8 alone (rewritten)'], actions: ['«Видалити» on 1', 're-read drops the row', '«Скасувати»'] },
      measured: { rowGone, stays, focus, errors },
      pass: rowGone && stays === 1 && focus === 'H1' && errors.length === 0,
    };
  });

  // ======================= 8. the product page through the same host (F01, R04, R06) =======================
  await scenario('detail-actions@1440', ['E8-F01', 'E8-F03', 'E8-F07', 'R06'], async () => {
    const r1 = rowOf('1');
    if (!r1) return { pass: null, measured: { missing: true } };
    const out = {};
    {
      const writes = [];
      const { ctx, p } = await open(1440, { writes: [recorder(writes, /\/products\/\d+\/duplicate/, () => ({ ...detail1 }))] });
      await p.goto(`${job.ui}/products/${r1.id}`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(800);
      await p.getByRole('button', { name: 'Дублювати' }).click();
      await toastText(p, /Копію створено/);
      out.duplicate = writes.map((w) => w.body?.name);
      await ctx.close();
    }
    {
      let n = 0;
      let deleted = false;
      const { ctx, p, requests } = await open(1440, {
        gets: [[new RegExp(`/api/v1/products/${r1.id}(\\?.*)?$`), () => (deleted ? { fail: 404 } : null)]],
        writes: [[/\/api\/v1\/products\/\d+$/, () => { n += 1; if (n === 1) return { __status: 409, json: { detail: 'Product is used by an order line; remove the lines first' } }; deleted = true; return { message: 'ok' }; }]],
      });
      await p.goto(`${job.ui}/products/${r1.id}`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(800);
      await p.getByRole('button', { name: 'Видалити' }).first().click();
      const dialog = p.getByRole('dialog', { name: 'Видалити виріб?' });
      await dialog.getByRole('button', { name: 'Видалити' }).click();
      await dialog.getByRole('alert').waitFor({ timeout: 8000 });
      out.refusal = await textOf(dialog.getByRole('alert'));
      const file = await shoot(p, 'detail-delete-409@1440');
      const mark = requests.length;
      await dialog.getByRole('button', { name: 'Видалити' }).click();
      await p.waitForURL(/\/products$/, { timeout: 10000 });
      await p.waitForTimeout(1000);
      out.reread = requests.slice(mark).filter((r) => new RegExp(`^GET /api/v1/products/${r1.id}(\\?|$)`).test(r)).length;
      out.file = file;
      await ctx.close();
    }
    return {
      recipe: { url: '/products/{product:1}', fixture: ['POST …/duplicate, DELETE (1st 409, then 200) answered by the runner; after it GET /products/{id} → 404'] },
      measured: out,
      pass: out.duplicate.length === 1 && out.duplicate[0] === `${r1.name} (копія)` && out.refusal === 'Product is used by an order line; remove the lines first' && out.reread === 0,
      screenshots: [out.file],
    };
  });

  await scenario('detail-promote@1440', ['E8-F06', 'R04'], async () => {
    const id = P['900'];
    if (!id) return { pass: null, measured: { missing: true } };
    const out = {};
    for (const [k, hidden] of [['active', false], ['hidden', true]]) {
      let n = 0;
      const writes = [];
      const { ctx, p } = await open(1440, {
        rewrite: [[new RegExp(`/api/v1/products/${id}(\\?.*)?$`), (b) => (hidden ? { ...b, is_active: false } : b)]],
        // The server's own shape: HTTPException(409, detail={error, message}).
        writes: [recorder(writes, /\/api\/v1\/products\/\d+$/, () => { n += 1; return n === 1 ? { __status: 409, json: { detail: { error: 'product_busy', message: 'Product is busy' } } } : { ...detail1, id, origin: 'catalog', is_active: !hidden }; })],
      });
      await p.goto(`${job.ui}/products/${id}`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(800);
      await p.getByTestId('product-adhoc-banner').getByRole('button', { name: 'У каталог' }).click();
      const dialog = p.getByRole('dialog', { name: 'Додати виріб до каталогу?' });
      const text = await textOf(dialog);
      await dialog.getByRole('button', { name: 'Додати до каталогу' }).click();
      await dialog.getByRole('alert').waitFor({ timeout: 8000 });
      const refusal = await textOf(dialog.getByRole('alert'));
      const file = await shoot(p, `detail-promote-${k}@1440`);
      await dialog.getByRole('button', { name: 'Додати до каталогу' }).click();
      await toastText(p, /Додано до каталогу/);
      out[k] = { text, refusal, bodies: writes.map((w) => JSON.stringify(w.body)), file };
      await ctx.close();
    }
    return {
      recipe: { url: '/products/{product:900}', fixture: ['PATCH: 1st → 409 product_busy, 2nd → 200 (answered by the runner)', 'hidden: GET /products/{900} with is_active false (rewritten)'] },
      measured: out,
      pass: ['active', 'hidden'].every((k) => out[k].bodies.length === 2 && out[k].bodies.every((b) => b === '{"origin":"catalog"}') && out[k].refusal === 'Product is busy') &&
        /Його побачать каталог і пікери/.test(out.active.text) && /Він лишиться прихованим/.test(out.hidden.text),
      screenshots: [out.active.file, out.hidden.file],
    };
  });

  // ======================= 9. pages and equivalence (C10, PC9) =======================
  await scenario('pages@1440', ['E8-C10', 'PC9'], async () => {
    const { ctx, p, requests } = await open(1440, view('table'));
    await catalog(p, '?page=2');
    const table = await rowIds(p);
    const bar = await p.getByText(/^\d+-\d+ з \d+/).count();
    await p.getByRole('button', { name: 'Картки' }).click();
    await p.waitForTimeout(800);
    const cards = await cardIds(p);
    // A word only a product past this page carries: the search answers it.
    const last = ROWS.filter((r) => r.is_active && r.origin === 'catalog').at(-1);
    let found = null;
    if (last) {
      await catalog(p, `?q=${encodeURIComponent(last.code)}`);
      found = await cardIds(p);
    }
    const sent = lastParams(requests);
    await ctx.close();
    return {
      recipe: { urls: ['/products?page=2', `?q=<code of the last catalog product>`] },
      measured: { table, cards, bar, found, sent },
      pass: table.length > 0 && JSON.stringify(table) === JSON.stringify(cards) && bar >= 1 && !!last && found.length === 1 && found[0] === last.id && sent.page === '1',
    };
  });

  // ======================= 10. hit tests at 390, themes =======================
  await scenario('hits@390', ['E8-C02', 'E8-C03', 'E8-C06', 'E8-F02'], async () => {
    const all = [];
    const counts = {};
    {
      const { ctx, p } = await open(390, view('table'));
      await catalog(p, '?adhoc=1');
      counts.table = {
        toggle: await hitTest(p, '[data-testid="list-page-header"] [aria-pressed]'),
        search: await hitTest(p, 'input[type="search"]'),
        selects: (await hitTest(p, 'select')).filter((h) => SELECTS.includes(h.what)),
        checks: await hitTest(p, 'input[type="checkbox"]'),
        reset: (await hitTest(p, 'button')).filter((h) => h.what === 'Скинути'),
        categories: (await hitTest(p, 'nav[aria-label="Категорії"] li > button')).slice(0, 3),
        menu: (await hitTest(p, '[data-testid$="-row-menu"]')).slice(0, 2),
      };
      await ctx.close();
    }
    {
      const { ctx, p } = await open(390, view('cards'));
      await catalog(p);
      counts.cards = (await hitTest(p, '[data-testid="product-menu"]')).slice(0, 2);
      await ctx.close();
    }
    for (const v of Object.values(counts)) all.push(...(Array.isArray(v) ? v : Object.values(v).flat()));
    const misses = all.filter((h) => !h.inView || !h.hits);
    return {
      recipe: { viewport: 390, views: ['table (with «разові»)', 'cards'] },
      measured: { sizes: Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Array.isArray(v) ? v.length : Object.fromEntries(Object.entries(v).map(([a, b]) => [a, b.length]))])), misses },
      pass: counts.table.toggle.length === 2 && counts.table.search.length === 1 && counts.table.selects.length === 5 && counts.table.checks.length === 2 &&
        counts.table.reset.length === 1 && counts.table.categories.length === 3 && counts.table.menu.length > 0 && counts.cards.length > 0 && misses.length === 0,
    };
  });

  for (const [id, opts, test] of [
    ['theme-light@1440', { storage: { 'theme-mode': 'light' } }, (e) => !/\bdark\b/.test(e.theme)],
    ['theme-oled@1440', { settings: { dark_background: 'oled' } }, (e) => /bg-oled/.test(e.theme)],
  ]) {
    await scenario(id, ['E2-B01', 'E8-B04', 'E8-B06', 'P03', 'P04'], async () => {
      const files = [];
      let e = null;
      const contrast = {};
      const r1 = rowOf('1');
      const r5 = rowOf('5');
      const rows = r1 && r5 ? [r1, { ...r5, sliced: false, models: [] }] : null;
      for (const v of ['table', 'cards']) {
        const { ctx, p } = await open(1440, { ...opts, storage: { ...(opts.storage ?? {}), 'bamdude-products-view': v }, ...(rows ? { rewrite: [[LIST, onlyRows(rows)]] } : {}) });
        await catalog(p);
        e = await env(p);
        if (v === 'table') {
          // In the cells — the filter's options «Не нарізано» / «Готових нижче мінімуму» carry the same words.
          const unsliced = p.getByTestId('product-models').getByText('не нарізано', { exact: true }).first();
          const below = p.getByTestId('product-stock').getByText('нижче мінімуму', { exact: true }).first();
          contrast.unsliced = (await unsliced.count()) ? await textContrast(unsliced) : null;
          contrast.below = (await below.count()) ? await textContrast(below) : null;
        }
        files.push(await shoot(p, `${id}-${v}`));
        await ctx.close();
      }
      return {
        env: e,
        recipe: { url: '/products', fixture: rows ? ['GET /products?page=…: products 1 and 5 — 5 shown unsliced (rewritten)'] : [] },
        measured: { views: ['table', 'cards'], contrast },
        pass: test(e) && contrast.unsliced !== null && contrast.unsliced >= 4.5 && contrast.below !== null && contrast.below >= 4.5,
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
