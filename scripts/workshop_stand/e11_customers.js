// WS-13 E11 acceptance runner (spec §K.1), run by Playwright MCP's browser_run_code_unsafe:
//   filename: scripts/workshop_stand/e11_customers.js — while `e11_evidence.py serve` listens on 127.0.0.1:8197.
// The harness is E4's (e04_detail.js, via E7–E10), unchanged in what it guarantees: every scenario records WHAT was
// run (recipe + fixtures), WHERE (viewport, DPR, the actual <html> classes), WHAT was measured and whether it
// matched the spec — a failure is a failure, a surface it cannot reach is `pending`. Nothing reaches the stand but
// reads: every non-GET request of every context is answered here, and the states the baseline does not hold are
// rewritten GET answers in this runner's own context only. The oracles measure what a person reads and does — the
// labels in order, the sentence in a dialog's slot, where the focus is, which requests a press sent and with what
// body — never a class name, except where the spec names the geometry rule itself (the columns at 1100 and 760).
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
      if (sessionStorage.getItem('e11-init')) return;
      sessionStorage.setItem('e11-init', '1');
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
      if (step && step.fail) return route.fulfill({ status: step.fail, json: { detail: 'e11 runner' } });
      // A body of the runner's own — the stand is never asked.
      if (step && step.json) return route.fulfill({ status: 200, json: step.json });
      // A picture of the runner's own (the cover fixture, K11): a real PNG file.
      if (step && step.file) return route.fulfill({ status: 200, path: step.file, contentType: 'image/png' });
      const failing = fail.find(([re]) => re.test(url));
      if (failing) return route.fulfill({ status: failing[1], json: { detail: 'e11 runner' } });
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
  // The mockup customers (spec §K.1, T0): 1 — «ТехноЛаб», regular, one contact, a team note,
  // 4 orders (1 active), 3 dispatch notes; 2 — another, for the owner switch of the issues.
  const C = job.customers ?? {};
  const C1 = C['1'] ?? 1;
  const C2 = C['2'] ?? 2;
  const detail1 = await read(`/customers/${C1}`);
  const page1 = await read('/customers/?page=1&per_page=100');
  const methods = await read('/delivery-methods/');
  const notes1 = await read(`/stock-issues/?customer_id=${C1}&sort_by=created-desc&page=1&per_page=24`);
  const groups = await read('/groups/');
  const groupList = Array.isArray(groups) ? groups : groups.items;
  const adminPerms = groupList.find((g) => g.name === 'Administrators').permissions;
  const without = (...drop) => adminPerms.filter((perm) => !drop.includes(perm));
  const NAME1 = detail1.name;
  // What the boundary answers in the system language (api_errors_uk.json) — the runner answers
  // writes itself, so it says the refusal the way the server would.
  const NAMESAKE = { error: 'name_taken', message: `Замовник з такою назвою вже є: ${detail1.code}`, customer: C1 };

  // --- doors and oracles ---
  const LIST = /\/api\/v1\/customers\/?\?/;
  const DETAIL = (id) => new RegExp(`/api/v1/customers/${id}/?(\\?.*)?$`);
  const METHODS = /\/api\/v1\/delivery-methods\/?(\?.*)?$/;
  const NOTES = /\/api\/v1\/stock-issues\/?\?/;
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
  const headers = (locator) => locator.getByRole('columnheader').evaluateAll((ths) => ths.map((th) => th.textContent.replace(/[▲▼]/g, '').replace(/\s+/g, ' ').trim()));
  // The mockup's own extra contacts of customer 1 (`DEMO_CONTACTS`), given to the app through a
  // rewritten GET: the baseline holds one contact per customer.
  const EXTRA = [
    { id: 9001, code: 'CT-9001', name: 'Олена Бондар', role: 'Бухгалтерія', phone: '+380 67 120 44 11', email: 'buh@technolab.ua', city: null, delivery_method_id: null, delivery_method_name: null, delivery_details: null, note: null, orders_count: 0 },
    { id: 9002, code: 'CT-9002', name: 'Сергій Коваль', role: 'Склад · приймання', phone: '+380 50 331 20 07', email: null, city: 'Бровари', delivery_method_id: null, delivery_method_name: 'Кур’єр до дверей', delivery_details: null, note: 'дзвонити\nзаздалегідь', orders_count: 0 },
  ];
  const withContacts = (c) => (c.id === C1 ? { ...c, contacts: [...c.contacts, ...EXTRA] } : c);
  const multiList = [LIST, (b) => ({ ...b, items: b.items.map(withContacts) })];
  const multiDetail = [DETAIL(C1), (b) => withContacts(b)];
  const rowOf = (p, id) => p.getByTestId(`customer-${id}-row`);
  // The tops of the second row's labels of a contact — one line, whatever is under the method.
  const contactLabelTops = (d) => d.getByTestId('contact-row').first().evaluate((row) => ['Email', 'Місто', 'Спосіб доставки']
    .map((name) => [...row.querySelectorAll('label')].find((l) => l.textContent.trim() === name))
    .map((l) => (l ? Math.round(l.getBoundingClientRect().top) : null)));
  const sameLine = (tops) => tops.every((t) => t !== null && t === tops[0]);
  const menuOf = (p, name) => p.getByRole('button', { name: `Дії: ${name}`, exact: true });
  const methodsFor = (id) => methods.find((m) => m.id === id);

  // ---------------------------------------------------------------- the list (B, C01)
  await scenario('list@1440', ['E11-B01', 'E11-B02', 'E11-B03', 'E11-B04', 'E11-B06'], async () => {
    const { ctx, p, errors, requests } = await open(1440);
    await goto(p, '/customers');
    const h1 = await p.getByRole('heading', { level: 1 }).evaluate((h) => ({ text: h.textContent.trim(), tab: h.getAttribute('tabindex') }));
    const tabs = await p.getByRole('tablist', { name: 'Показати' }).getByRole('tab').evaluateAll((ts) => ts.map((t) => ({ name: t.textContent.trim(), on: t.getAttribute('aria-selected') })));
    const tile = await textOf(p.getByTestId('customers-tile-customers'));
    const search = await p.getByRole('searchbox').getAttribute('placeholder');
    await p.getByRole('tab', { name: 'Постійні' }).click();
    await p.waitForTimeout(700);
    const afterTab = await urlOf(p);
    await p.getByRole('searchbox').fill('50%');
    await p.waitForTimeout(1200);
    const percentAsked = requests.some((r) => /\/customers\/?\?.*q=50%25/.test(r));
    await goto(p, '/customers?sort=created-desc');
    const chip = await textOf(p.getByTestId('customers-sort-chip'));
    await p.getByTestId('customers-sort-chip').getByRole('button', { name: 'Прибрати сортування' }).click();
    await p.waitForTimeout(700);
    const afterChip = await urlOf(p);
    const file = await shoot(p, 'list');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers', actions: ['«Постійні»', 'search «50%»', '/customers?sort=created-desc → remove the chip'] },
      measured: { h1, tabs, tile, search, afterTab, percentAsked, chip, afterChip, errors },
      pass: h1.text === 'Замовники' && h1.tab === '-1' &&
        tabs.map((t) => t.name).join('|') === 'Усі|З активними|Постійні' && tabs[0].on === 'true' &&
        tile.includes('Усього замовників') && /\d+ постійн/.test(tile) &&
        search === 'Назва, код, контакт, телефон, місто…' && afterTab.includes('show=regular') && percentAsked &&
        chip === 'Сортування: Дата створення ↓' && !afterChip.includes('sort=') && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('list-states@1440', ['E11-B05'], async () => {
    const out = {};
    const files = [];
    // The first read — a skeleton of the view.
    {
      const { ctx, p } = await open(1440, { delay: [[LIST, 4000]] });
      await p.goto(`${job.ui}/customers`, { waitUntil: 'domcontentloaded' });
      await p.getByTestId('customers-skeleton').waitFor({ timeout: 6000 });
      out.skeleton = await p.getByTestId('customers-skeleton').getAttribute('data-shape');
      files.push(await shoot(p, 'list-skeleton'));
      await ctx.close();
    }
    // A failed read — an alert with its retry, never «no customers» (the app retries once).
    {
      let n = 0;
      const { ctx, p } = await open(1440, { gets: [[LIST, () => { n += 1; return n <= 2 ? { fail: 500 } : null; }]] });
      await goto(p, '/customers');
      await p.getByRole('alert').waitFor({ timeout: 8000 });
      out.failed = await textOf(p.getByRole('alert'));
      out.failedEmpty = await p.getByText('Замовників ще немає').count();
      files.push(await shoot(p, 'list-failed'));
      await p.getByRole('alert').getByRole('button', { name: 'Спробувати знову' }).click();
      await rowOf(p, C1).waitFor({ timeout: 8000 });
      out.retried = true;
      await ctx.close();
    }
    // Nothing under a search — «not found» with its reset; an empty farm — said plainly.
    {
      const { ctx, p } = await open(1440);
      await goto(p, '/customers?q=zzzz-none');
      out.noMatch = await textOf(p.getByText('Замовників не знайдено'));
      await p.getByRole('button', { name: 'Скинути фільтри' }).click();
      await rowOf(p, C1).waitFor({ timeout: 8000 });
      out.afterReset = await urlOf(p);
      await ctx.close();
    }
    {
      const { ctx, p } = await open(1440, { rewrite: [[LIST, (b) => ({ ...b, items: [], meta: { ...b.meta, total: 0, last_page: 1 } })]] });
      await goto(p, '/customers');
      out.empty = await p.getByText('Замовників ще немає').count();
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers', fixture: ['GET /customers held 4 s', 'GET /customers 500 ×2, then the stand', 'q=zzzz-none', 'GET /customers rewritten empty'] },
      measured: out,
      pass: out.skeleton === 'table' && out.failed.includes('Не вдалося завантажити замовників') && out.failedEmpty === 0 &&
        out.retried && out.noMatch === 'Замовників не знайдено' && !out.afterReset.includes('q=') && out.empty === 1,
      screenshots: files,
    };
  });

  // ---------------------------------------------------------------- the table (C)
  await scenario('table@1440', ['E11-C01', 'E11-C02', 'E11-C03', 'E11-C04', 'E11-C05', 'E11-C06', 'E11-C07', 'E11-C08', 'E11-C09'], async () => {
    const { ctx, p, errors } = await open(1440, { rewrite: [multiList] });
    await goto(p, '/customers');
    const region = p.getByRole('region', { name: 'Замовники' });
    const cols = await headers(region.locator('table').first().locator('thead'));
    const row = rowOf(p, C1);
    const kindCode = await textOf(row.getByText(/· CU-/));
    const avatar = await row.locator('td').nth(1).locator('[aria-hidden="true"]').first().textContent();
    const orders = await textOf(p.getByTestId(`customer-${C1}-orders`));
    const more = row.getByRole('button', { name: '+ 2 контакти' });
    const chevron = row.getByRole('button', { name: `Усі контакти: ${NAME1}` });
    const before = await more.getAttribute('aria-expanded');
    await more.click();
    const all = p.getByTestId(`customer-${C1}-contacts`);
    await all.waitFor();
    const opened = { more: await more.getAttribute('aria-expanded'), chevron: await chevron.getAttribute('aria-expanded') };
    const mini = await headers(all);
    const mainBadges = await all.getByText('основний', { exact: true }).count();
    const note = await all.getByText(/дзвонити/).evaluate((el) => getComputedStyle(el).whiteSpace);
    await all.evaluate((el) => el.scrollIntoView({ block: 'end' }));
    const file = await shoot(p, 'table-open');
    await chevron.click();
    const closed = await all.count();
    const overflow = await docOverflow(p);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers', fixture: ['GET /customers: customer 1 with the mockup\'s two extra contacts'], actions: ['«+ 2 контакти»', 'the chevron'] },
      measured: { cols, kindCode, avatar, orders, before, opened, mini, mainBadges, note, closed, overflow, errors },
      pass: cols.join('|') === 'Замовник|Контакти|Місто · доставка|Замовлення|Сума|Дії' && kindCode.startsWith('Постійний · CU-') &&
        avatar === 'Т' && /4 усього/.test(orders) && /1 активне/.test(orders) && /3 виконано · 0 скасовано/.test(orders) &&
        before === 'false' && opened.more === 'true' && opened.chevron === 'true' &&
        mini.join('|') === 'Контакт|Роль|Email|Телефон|Місто · доставка|Нотатка' && mainBadges === 1 && note === 'pre-line' &&
        closed === 0 && overflow <= 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ---------------------------------------------------------------- the cards (D)
  await scenario('cards@1440', ['E11-D01', 'E11-D02', 'E11-D03'], async () => {
    const { ctx, p, errors } = await open(1440, { storage: { 'bamdude-customers-view': 'cards' } });
    await goto(p, '/customers');
    const card = p.getByTestId(`customer-${C1}-card`);
    const title = await textOf(card.getByRole('heading', { level: 3 }));
    const meta = await textOf(p.getByTestId(`customer-${C1}-meta`));
    const footer = p.getByTestId(`customer-${C1}-footer`);
    const phone = footer.getByRole('link').first();
    const phoneHits = await hits(p, phone);
    const menuHits = await hits(p, menuOf(p, NAME1));
    const overlay = await card.getByRole('link', { name: NAME1, exact: true }).evaluate((a) => ({ href: a.getAttribute('href'), cls: a.className }));
    const footTops = await p.locator('[data-testid$="-footer"]').evaluateAll((els) => els.slice(0, 3).map((e) => Math.round(e.getBoundingClientRect().top)));
    const file = await shoot(p, 'cards');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers', storage: { 'bamdude-customers-view': 'cards' } },
      measured: { title, meta, phoneHits, menuHits, overlay, footTops, errors },
      pass: title === NAME1 && /Замовлень/.test(meta) && /активних/.test(meta) && phoneHits.hits && menuHits.hits &&
        overlay.href === `/customers/${C1}` && /absolute/.test(overlay.cls) && new Set(footTops).size === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ---------------------------------------------------------------- actions and delete (H)
  await scenario('delete@1440', ['E11-H01', 'E11-H02', 'E11-H03', 'E11-H04', 'E11-H05', 'E11-R08'], async () => {
    const writes = [];
    const none = page1.items.find((c) => c.id !== C1) ?? { id: C2, name: '' };
    const { ctx, p, errors } = await open(1440, {
      rewrite: [[LIST, (b) => ({ ...b, items: b.items.map((c) => (c.id === none.id ? { ...c, figures: { ...c.figures, projects: 0, active: 0, completed: 0, cancelled: 0 } } : c)) })]],
      writes: [recorder(writes, /\/api\/v1\/customers\/\d+$/, () => ({ message: 'Customer deleted' }))],
    });
    await goto(p, '/customers');
    await menuOf(p, NAME1).click();
    const items = await p.getByRole('menuitem').evaluateAll((ms) => ms.map((m) => m.textContent.trim()));
    await p.getByRole('menuitem', { name: 'Видалити' }).click();
    let d = dialogOf(p, 'Видалити замовника?');
    await d.waitFor();
    const subtitle = await described(d);
    const body = await textOf(d);
    const file = await shoot(p, 'delete');
    await d.getByRole('button', { name: 'Скасувати' }).click();
    await menuOf(p, none.name).click();
    await p.getByRole('menuitem', { name: 'Видалити' }).click();
    d = dialogOf(p, 'Видалити замовника?');
    await d.waitFor();
    const bodyNone = await textOf(d);
    await d.getByRole('button', { name: 'Скасувати' }).click();
    await menuOf(p, NAME1).click();
    await p.getByRole('menuitem', { name: 'Видалити' }).click();
    d = dialogOf(p, 'Видалити замовника?');
    await d.getByRole('button', { name: 'Видалити' }).click();
    await toastText(p, /Замовника видалено/);
    await p.waitForTimeout(400);
    const focus = await focusAt(p);
    // From the customer's page: the delete goes back to the list.
    await goto(p, `/customers/${C1}`);
    await menuOf(p, NAME1).click();
    await p.getByRole('menuitem', { name: 'Видалити' }).click();
    await dialogOf(p, 'Видалити замовника?').getByRole('button', { name: 'Видалити' }).click();
    await p.waitForURL(/\/customers$/, { timeout: 6000 });
    const after = await urlOf(p);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers', fixture: [`GET /customers: «${none.name}» with no orders`, 'DELETE /customers/{id}: answered here'] },
      measured: { items, subtitle, body, bodyNone, writes, focus, after, errors },
      pass: items.join('|') === 'Редагувати|Нове замовлення|Видалити' && subtitle === `${detail1.code} · ${NAME1}` &&
        body.includes('Його замовлення (4) лишаться, але без замовника.') &&
        body.includes('Активні (1) після цього закриватимуться на склад, а не видаватимуться.') &&
        body.includes('Видані накладні збережуть назву одержувача.') &&
        !bodyNone.includes('лишаться, але без замовника') && bodyNone.includes('Видані накладні збережуть назву одержувача.') &&
        writes.length === 2 && writes.every((w) => w.method === 'DELETE') && focus === 'H1' && after === '/customers' && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('new-order@1440', ['E11-H02', 'E11-E01'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, '/customers');
    await menuOf(p, NAME1).click();
    await p.getByRole('menuitem', { name: 'Нове замовлення' }).click();
    let d = dialogOf(p, 'Нове замовлення');
    await d.waitFor();
    await p.waitForTimeout(600);
    const fromMenu = await d.getByLabel('Замовник', { exact: true }).inputValue();
    await d.getByRole('button', { name: 'Скасувати' }).click();
    await goto(p, `/customers/${C1}`);
    await p.getByTestId('customer-header').getByRole('button', { name: 'Нове замовлення' }).click();
    d = dialogOf(p, 'Нове замовлення');
    await d.waitFor();
    await p.waitForTimeout(600);
    const fromHeader = await d.getByLabel('Замовник', { exact: true }).inputValue();
    const file = await shoot(p, 'new-order');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers → «Дії» → «Нове замовлення»; /customers/{customer:1} → «Нове замовлення»' },
      measured: { fromMenu, fromHeader, errors },
      pass: fromMenu === String(C1) && fromHeader === String(C1) && errors.length === 0,
      screenshots: [file],
    };
  });

  // ---------------------------------------------------------------- the customer page (E)
  await scenario('detail@1440', ['E11-E01', 'E11-E02', 'E11-E03', 'E11-E04', 'E11-E05', 'E11-E06'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, `/customers/${C1}`);
    const header = p.getByTestId('customer-header');
    const buttons = await header.getByRole('button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label') || b.textContent.trim()));
    const headerText = await textOf(header);
    const side = await box(p.getByTestId('customer-side'));
    const main = await box(p.getByTestId('customer-main'));
    const sideHeads = await p.getByTestId('customer-side').getByRole('heading', { level: 3 }).evaluateAll((hs) => hs.map((h) => h.textContent.trim()));
    const covered = await textOf(p.getByTestId('customer-tile-covered'));
    const head = p.getByTestId('customer-orders-head');
    const headParts = { tablist: await head.getByRole('tablist').count(), view: await head.getByRole('group', { name: 'Вигляд' }).count() };
    const issues = await textOf(p.getByTestId('dispatch-notes-section').locator('div').first());
    const file = await shoot(p, 'detail');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers/{customer:1}' },
      measured: { buttons, side, main, sideHeads, covered, headParts, issues, errors },
      pass: buttons.join('|') === `Редагувати|Нове замовлення|Дії: ${NAME1}` && !headerText.includes(detail1.notes ?? '\u0000') &&
        side.w === 260 && main.l >= side.r && sideHeads.join('|') === 'Контакти|Нотатка для команди' &&
        covered.includes(`${detail1.figures.covered_units} / ${detail1.figures.ordered}`) &&
        headParts.tablist === 1 && headParts.view === 1 &&
        issues.includes('Видачі зі складу') && issues.includes('усі накладні — за замовленнями й без') && errors.length === 0,
      screenshots: [file],
    };
  });

  const notePage = (n, items) => ({ items, meta: { total: 30, current_page: n, per_page: 24, last_page: 2 } });
  const fakeNote = (id, code) => ({ ...notes1.items[0], id, code });
  await scenario('issues-page-fail@1440', ['E11-E08', 'E11-R02'], async () => {
    let second = 0;
    const { ctx, p, errors } = await open(1440, {
      gets: [[NOTES, (url) => {
        const pg = Number(new URL(url).searchParams.get('page'));
        if (pg !== 2) return { json: notePage(1, [fakeNote(901, 'DN-0901')]) };
        second += 1;
        return second <= 2 ? { fail: 500 } : { json: notePage(2, [fakeNote(902, 'DN-0902')]) };
      }]],
    });
    await goto(p, `/customers/${C1}`);
    const section = p.getByTestId('dispatch-notes-section');
    await section.getByTestId('note-901').waitFor();
    await section.getByRole('button', { name: /наступн/i }).click();
    await section.getByRole('alert').waitFor({ timeout: 8000 });
    const alert = await textOf(section.getByRole('alert'));
    const leftover = await section.getByTestId('note-901').count();
    const pager = await section.getByRole('button', { name: /наступн/i }).count();
    const file = await shoot(p, 'issues-page-fail');
    await section.getByRole('alert').getByRole('button', { name: 'Спробувати знову' }).click();
    await section.getByTestId('note-902').waitFor({ timeout: 8000 });
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers/{customer:1}', fixture: ['GET /stock-issues page 1: one note; page 2: 500 ×2, then one note'] },
      measured: { alert, leftover, pager, errors },
      pass: alert.includes('Не вдалося завантажити накладні.') && leftover === 0 && pager === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('issues-switch@1440', ['E11-E09', 'E11-R02'], async () => {
    const { ctx, p, errors } = await open(1440, {
      gets: [[NOTES, (url) => {
        const u = new URL(url);
        const owner = Number(u.searchParams.get('customer_id'));
        if (owner === C1) return { json: notePage(Number(u.searchParams.get('page')), [fakeNote(901, 'DN-0901')]) };
        return { delay: 3000 };
      }]],
    });
    await goto(p, `/customers/${C1}`);
    const section = p.getByTestId('dispatch-notes-section');
    await section.getByTestId('note-901').waitFor();
    await section.getByRole('button', { name: /наступн/i }).click();
    await p.waitForTimeout(600);
    await p.evaluate((to) => { history.pushState({}, '', to); dispatchEvent(new PopStateEvent('popstate')); }, `/customers/${C2}`);
    await p.waitForTimeout(800);
    const foreign = await p.getByTestId('note-901').count();
    const loading = await p.getByTestId('dispatch-notes-section').getByText('Завантаження...').count();
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers/{customer:1} → page 2 → /customers/{customer:2}', fixture: ['GET /stock-issues: customer 1 answered here; customer 2 held'] },
      measured: { foreign, loading, errors },
      pass: foreign === 0 && loading >= 1 && errors.length === 0,
    };
  });

  // ---------------------------------------------------------------- the form (F) and the picker (F12)
  await scenario('form@1440', ['E11-F01', 'E11-F02', 'E11-F03', 'E11-F04', 'E11-F05', 'E11-F08', 'E11-F09', 'E11-F10', 'E11-F11', 'E11-R01'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      writes: [recorder(writes, /\/api\/v1\/customers\/?(\d+)?$/, (e, n) => (e.method === 'POST' && n === 1
        ? { __status: 409, json: { detail: NAMESAKE } }
        : { ...detail1 }))],
    });
    await goto(p, '/customers');
    await p.getByRole('button', { name: 'Новий замовник' }).click();
    let d = dialogOf(p, 'Новий замовник');
    await d.waitFor();
    await p.waitForTimeout(300);
    const opened = await focusAt(p);
    const labelTops = await contactLabelTops(d);
    const labels = await d.locator('label').evaluateAll((ls) => ls.map((l) => l.textContent.trim()));
    await d.getByRole('button', { name: 'Зберегти замовника' }).click();
    const empty = await textOf(d.getByRole('alert'));
    const emptyFocus = await focusAt(p);
    await d.getByRole('button', { name: '+ Нотатка' }).first().click();
    const noteFocus = await focusAt(p);
    await d.getByRole('button', { name: 'Додати контакт' }).click();
    await p.waitForTimeout(200);
    const addFocus = await focusAt(p);
    await d.getByLabel('Назва', { exact: true }).fill(NAME1);
    await d.getByLabel('Ім’я контакта').first().fill('Олена');
    await d.getByRole('button', { name: 'Зберегти замовника' }).click();
    await d.getByRole('alert').waitFor();
    const warning = await textOf(d.getByRole('alert'));
    const primary = await d.getByRole('button', { name: 'Все одно зберегти' }).count();
    const file = await shoot(p, 'form-namesake');
    await d.getByLabel('Місто').first().fill('Київ');
    await d.getByRole('button', { name: 'Все одно зберегти' }).click();
    await p.waitForURL(new RegExp(`/customers/${C1}$`), { timeout: 6000 });
    // An edit sends only what changed.
    await p.getByTestId('customer-header').getByRole('button', { name: 'Редагувати' }).click();
    d = dialogOf(p, 'Редагувати замовника');
    await d.waitFor();
    const editSubtitle = await described(d);
    await d.getByLabel('Назва', { exact: true }).fill(`${NAME1} ТОВ`);
    await d.getByRole('button', { name: 'Зберегти замовника' }).click();
    await toastText(p, /Замовника збережено/);
    await ctx.close();
    const [refused, agreed, patch] = writes;
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers → «Новий замовник»; /customers/{customer:1} → «Редагувати»', fixture: ['POST /customers: 409 name_taken, then accepted', 'PATCH answered here'] },
      measured: { opened, labelTops, labels, empty, emptyFocus, noteFocus, addFocus, warning, primary, refused, agreed, patch, editSubtitle, errors },
      pass: opened === 'Назва' && sameLine(labelTops) && labels.slice(0, 2).join('|') === 'Назва|Тип' && labels.includes('Нотатка для команди') &&
        empty === 'Вкажіть назву замовника.' && emptyFocus === 'Назва' && noteFocus === 'Нотатка' && addFocus === 'Ім’я контакта' &&
        warning.includes(NAMESAKE.message) && /з такою назвою\?/.test(warning) && primary === 1 &&
        refused?.method === 'POST' && refused.body?.allow_duplicate_name === undefined &&
        agreed?.method === 'POST' && agreed.body?.allow_duplicate_name === true && agreed.body?.contacts?.[0]?.city === 'Київ' &&
        patch?.method === 'PATCH' && JSON.stringify(patch.body) === JSON.stringify({ name: `${NAME1} ТОВ` }) &&
        editSubtitle === detail1.code && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('form-methods@1440', ['E11-F07', 'E11-F13', 'E11-R03', 'E11-R04'], async () => {
    const out = {};
    const files = [];
    const methodId = detail1.contacts[0]?.delivery_method_id;
    const methodName = detail1.contacts[0]?.delivery_method_name;
    // A current answer without the chosen method: «no longer there», a save with contacts held, a name-only save goes.
    {
      const writes = [];
      const { ctx, p } = await open(1440, {
        rewrite: [[METHODS, (b) => b.filter((m) => m.id !== methodId)]],
        writes: [recorder(writes, /\/api\/v1\/customers\/\d+$/, () => ({ ...detail1 }))],
      });
      await goto(p, `/customers/${C1}`);
      await p.getByTestId('customer-header').getByRole('button', { name: 'Редагувати' }).click();
      const d = dialogOf(p, 'Редагувати замовника');
      await d.waitFor();
      await p.waitForTimeout(500);
      out.gone = await d.getByLabel('Спосіб доставки').first().evaluate((s) => s.selectedOptions[0]?.textContent);
      out.hint = await d.getByText('Оберіть інший спосіб або приберіть його').count();
      out.labelTops = await contactLabelTops(d);
      await d.getByLabel('Місто').first().fill('Львів');
      out.heldWithContacts = await d.getByRole('button', { name: 'Зберегти замовника' }).isDisabled();
      files.push(await shoot(p, 'form-method-gone'));
      await d.getByLabel('Місто').first().fill(detail1.contacts[0]?.city ?? '');
      await d.getByLabel('Назва', { exact: true }).fill(`${NAME1} 2`);
      await d.getByRole('button', { name: 'Зберегти замовника' }).click();
      await p.waitForTimeout(800);
      out.nameOnly = writes[0]?.body;
      await ctx.close();
    }
    // A reference that cannot be read: the chosen method by its name, a retry, no «gone».
    {
      const { ctx, p } = await open(1440, { fail: [[METHODS, 500]] });
      await goto(p, `/customers/${C1}`);
      await p.getByTestId('customer-header').getByRole('button', { name: 'Редагувати' }).click();
      const d = dialogOf(p, 'Редагувати замовника');
      await d.waitFor();
      await d.getByRole('status').filter({ hasText: 'Не вдалося прочитати способи доставки' }).first().waitFor({ timeout: 8000 });
      out.failedLabel = await d.getByLabel('Спосіб доставки').first().evaluate((s) => s.selectedOptions[0]?.textContent);
      out.failedGone = await d.getByText('(більше немає)').count();
      await ctx.close();
    }
    // Somebody without projects:update is not offered to manage the reference.
    {
      const { ctx, p } = await open(1440, { me: { is_admin: false, role: 'user', permissions: without('projects:update') } });
      await goto(p, '/customers');
      await p.getByRole('button', { name: 'Новий замовник' }).click();
      const d = dialogOf(p, 'Новий замовник');
      await d.waitFor();
      out.manageWithoutUpdate = await d.getByRole('button', { name: 'Керувати способами…' }).count();
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers/{customer:1} → «Редагувати»', fixture: ['GET /delivery-methods without the chosen one', 'GET /delivery-methods 500', '/auth/me without projects:update'] },
      measured: out,
      pass: out.gone === `${methodName} (більше немає)` && out.hint === 1 && sameLine(out.labelTops) && out.heldWithContacts === true &&
        JSON.stringify(out.nameOnly) === JSON.stringify({ name: `${NAME1} 2` }) &&
        out.failedLabel === methodName && out.failedGone === 0 && out.manageWithoutUpdate === 0,
      screenshots: files,
    };
  });

  await scenario('reference@1440', ['E11-G01', 'E11-G02', 'E11-G03', 'E11-G04', 'E11-G05', 'E11-G06'], async () => {
    const writes = [];
    const busy = methods.find((m) => m.contacts_count > 0) ?? methods[0];
    const free = methods.find((m) => m.contacts_count === 0) ?? methods[0];
    const { ctx, p, errors } = await open(1440, {
      writes: [recorder(writes, /\/api\/v1\/delivery-methods/, (e) => (e.method === 'PATCH' && writes.filter((w) => w.method === 'PATCH').length === 1
        ? { __status: 409, json: { detail: 'Спосіб доставки з такою назвою вже є' } }
        : e.method === 'POST' ? { id: 777, name: e.body?.name, position: 99, contacts_count: 0 } : { message: 'ok' }))],
    });
    await goto(p, `/customers/${C1}`);
    await p.getByTestId('customer-header').getByRole('button', { name: 'Редагувати' }).click();
    const form = dialogOf(p, 'Редагувати замовника');
    await form.waitFor();
    await form.getByRole('button', { name: 'Керувати способами…' }).first().click();
    const ref = dialogOf(p, 'Способи доставки');
    await ref.waitFor();
    const subtitle = await described(ref);
    const reason = await ref.getByTestId(`method-row-${busy.name}`).getByText(/спершу замініть там/).count();
    const busyDelete = await ref.getByRole('button', { name: `Видалити «${busy.name}»` }).isDisabled();
    await ref.getByRole('button', { name: `Перейменувати «${free.name}»` }).click();
    const field = ref.getByTestId(`method-row-${free.name}`).getByLabel('Назва способу доставки');
    const fieldFocus = await focusAt(p);
    await field.fill('Самовивіз');
    await field.press('Enter');
    await ref.getByTestId(`method-row-${free.name}`).getByText('Спосіб доставки з такою назвою вже є').waitFor();
    const refusalFocus = await focusAt(p);
    await field.press('Escape');
    const rowBack = await ref.getByTestId(`method-row-${free.name}`).getByLabel('Назва способу доставки').count();
    const stillOpen = await ref.count();
    await ref.getByRole('button', { name: `Видалити «${free.name}»` }).click();
    const confirm = dialogOf(p, `Видалити спосіб «${free.name}»?`);
    await confirm.waitFor();
    const confirmText = await textOf(confirm);
    const file = await shoot(p, 'reference-delete');
    await confirm.getByRole('button', { name: 'Видалити' }).click();
    // The confirmation stays until the list is read again; the reference under it is inert.
    await confirm.waitFor({ state: 'detached' });
    await ref.getByLabel('Новий спосіб доставки').fill('Meest');
    await ref.getByRole('button', { name: 'Додати' }).click();
    await p.waitForTimeout(600);
    const formAlive = await form.count();
    await ctx.close();
    const methodsOf = writes.map((w) => `${w.method} ${w.path.replace(/\?.*/, '')}`);
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers/{customer:1} → «Редагувати» → «Керувати способами…»', fixture: ['PATCH: 409 the first time', 'DELETE / POST answered here'] },
      measured: { subtitle, reason, busyDelete, fieldFocus, refusalFocus, rowBack, stillOpen, confirmText, methodsOf, formAlive, errors },
      pass: subtitle === 'Ними користуються контакти замовників і видачі' && reason === 1 && busyDelete === true &&
        fieldFocus === 'Назва способу доставки' && refusalFocus === 'Назва способу доставки' && rowBack === 0 && stillOpen === 1 &&
        confirmText.includes('Спосіб зникне з довідника.') &&
        methodsOf.filter((m) => m.startsWith('PATCH')).length === 1 && methodsOf.some((m) => m.startsWith('DELETE')) &&
        methodsOf.some((m) => m.startsWith('POST')) && formAlive === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('picker@1440', ['E11-F12', 'E11-R01'], async () => {
    const writes = [];
    const { ctx, p, errors, requests } = await open(1440, {
      writes: [recorder(writes, /\/api\/v1\/customers\/?$/, (e, n) => (n === 1
        ? { __status: 409, json: { detail: NAMESAKE } }
        : { ...detail1, id: 991, code: 'CU-0991' }))],
    });
    await goto(p, '/projects');
    await p.getByRole('button', { name: /^Нове замовлення$/ }).first().click();
    const d = dialogOf(p, 'Нове замовлення');
    await d.waitFor();
    await d.getByLabel('Замовник', { exact: true }).selectOption({ label: 'Новий замовник…' });
    const field = d.getByPlaceholder("Ім'я замовника");
    await field.fill(NAME1);
    const readsBefore = requests.filter((r) => /GET \/api\/v1\/customers\/?$/.test(r)).length;
    // The picker's own «Create» — the order form has a «Create» of its own.
    await field.locator('xpath=..').getByRole('button', { name: 'Створити', exact: true }).click();
    await d.getByRole('button', { name: 'Обрати його' }).waitFor();
    const file = await shoot(p, 'picker-namesake');
    await d.getByRole('button', { name: 'Обрати його' }).click();
    await p.waitForTimeout(800);
    const chosen = await d.getByLabel('Замовник', { exact: true }).inputValue();
    const freshRead = requests.filter((r) => /GET \/api\/v1\/customers\/?$/.test(r)).length > readsBefore;
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/projects → «Нове замовлення» → «Новий замовник…»', fixture: ['POST /customers: 409 name_taken'] },
      measured: { chosen, freshRead, writes: writes.length, errors },
      pass: chosen === String(C1) && freshRead && writes.length === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ---------------------------------------------------------------- keyboard, short windows, themes
  await scenario('keyboard@1440', ['E11-C02', 'E11-G02'], async () => {
    const { ctx, p, errors } = await open(1440, { rewrite: [multiList] });
    await goto(p, '/customers');
    const row = rowOf(p, C1);
    await row.getByRole('button', { name: `Усі контакти: ${NAME1}` }).focus();
    const order = [];
    for (let i = 0; i < 6; i += 1) {
      order.push(await focusAt(p));
      await p.keyboard.press('Tab');
    }
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers', fixture: ['customer 1 with three contacts'], actions: ['Tab through the row from its chevron'] },
      measured: { order, errors },
      pass: order[0] === `Усі контакти: ${NAME1}` && order[1] === NAME1 && order.includes('+ 2 контакти') &&
        order.includes(`Дії: ${NAME1}`) && order.indexOf('+ 2 контакти') < order.indexOf(`Дії: ${NAME1}`) && errors.length === 0,
    };
  });

  for (const [w, h] of [[390, 600], [1024, 600]]) {
    await scenario(`short@${w}x${h}`, ['E11-J', 'E11-K1'], async () => {
      const { ctx, p, errors } = await open(w, { h, rewrite: [multiDetail] });
      await goto(p, `/customers/${C1}`);
      await p.getByTestId('customer-header').getByRole('button', { name: 'Редагувати' }).click();
      const d = dialogOf(p, 'Редагувати замовника');
      await d.waitFor();
      const primary = await hits(p, d.getByRole('button', { name: 'Зберегти замовника' }));
      const scrolls = await d.evaluate((el) => [...el.querySelectorAll('*')].some((n) => n.scrollHeight > n.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowY)));
      const panel = await box(d);
      const file = await shoot(p, `short-${w}x${h}`);
      await ctx.close();
      return {
        env: { viewport: [w, h] },
        recipe: { url: '/customers/{customer:1} → «Редагувати»', fixture: ['three contacts'] },
        measured: { primary, scrolls, panel, errors },
        pass: primary.hits && scrolls && panel.l >= 0 && panel.r <= w && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  // ---------------------------------------------------------------- boundaries (R05)
  for (const w of [1101, 1100, 761, 760]) {
    await scenario(`detail-${w}`, ['E11-E02', 'E11-R05'], async () => {
      const { ctx, p, errors } = await open(w);
      await goto(p, `/customers/${C1}`);
      const side = await box(p.getByTestId('customer-side'));
      const main = await box(p.getByTestId('customer-main'));
      const overflow = await docOverflow(p);
      const menu = await hits(p, menuOf(p, NAME1));
      const file = await shoot(p, `detail-${w}`);
      await ctx.close();
      const oneColumn = w <= 760;
      return {
        env: { viewport: [w, HEIGHTS[w] ?? 800] },
        recipe: { url: '/customers/{customer:1}' },
        measured: { side, main, overflow, menu, errors },
        pass: overflow <= 0 && menu.hits && (oneColumn
          ? side.b <= main.t && Math.abs(side.w - main.w) <= 2
          : main.l >= side.r && side.w === (w <= 1100 ? 240 : 260)) && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  for (const w of [561, 560]) {
    await scenario(`tiles-${w}`, ['E11-B02', 'E11-E04', 'E11-R05'], async () => {
      const { ctx, p, errors } = await open(w);
      await goto(p, '/customers');
      const tops = await p.locator('[data-testid^="customers-tile-"]').evaluateAll((ts) => ts.map((t) => Math.round(t.getBoundingClientRect().top)));
      await goto(p, `/customers/${C1}`);
      const pageTops = await p.locator('[data-testid^="customer-tile-"]').evaluateAll((ts) => ts.map((t) => Math.round(t.getBoundingClientRect().top)));
      await ctx.close();
      const perRow = (ts) => ts.filter((t) => t === ts[0]).length;
      const expect = w <= 560 ? 1 : 2;
      return {
        env: { viewport: [w, HEIGHTS[w] ?? 800] },
        recipe: { url: '/customers; /customers/{customer:1}' },
        measured: { tops, pageTops, errors },
        pass: perRow(tops) === expect && perRow(pageTops) === expect && errors.length === 0,
      };
    });
  }

  for (const w of [1100, 760]) {
    await scenario(`product-detail-${w}`, ['E11-E02', 'E11-R05'], async () => {
      const { ctx, p, errors } = await open(w);
      const P1 = (job.products ?? {})['1'] ?? 1;
      await goto(p, `/products/${P1}`);
      const layout = p.getByTestId('product-layout');
      const cols = await layout.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
      const first = await layout.evaluate((el) => Math.round(el.firstElementChild.getBoundingClientRect().width));
      const overflow = await docOverflow(p);
      await ctx.close();
      return {
        env: { viewport: [w, HEIGHTS[w] ?? 800] },
        recipe: { url: '/products/{product:1}' },
        measured: { cols, first, overflow, errors },
        pass: overflow <= 0 && (w <= 760 ? cols === 1 : cols === 2 && first === 240) && errors.length === 0,
      };
    });
  }

  await scenario('cards-390', ['E11-D03', 'E11-R05'], async () => {
    const long = 'Товариство з обмеженою відповідальністю «Дуже довга назва замовника для перевірки переносу»';
    const { ctx, p, errors } = await open(390, {
      storage: { 'bamdude-customers-view': 'cards' },
      rewrite: [[LIST, (b) => ({ ...b, items: b.items.map((c) => (c.id === C1 ? { ...withContacts(c), name: long } : c)) })]],
    });
    await goto(p, '/customers');
    const card = await box(p.getByTestId(`customer-${C1}-card`));
    const overflow = await docOverflow(p);
    const menu = await hits(p, menuOf(p, long));
    const file = await shoot(p, 'cards-390');
    await ctx.close();
    return {
      env: { viewport: [390, 844] },
      recipe: { url: '/customers', storage: { 'bamdude-customers-view': 'cards' }, fixture: ['customer 1: a long name, three contacts'] },
      measured: { card, overflow, menu, errors },
      pass: card.l >= 0 && card.r <= 390 && overflow <= 0 && menu.hits && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('table-long', ['E11-C03', 'E11-C05', 'E11-R05'], async () => {
    const long = 'Товариство з обмеженою відповідальністю «Дуже довга назва замовника для перевірки переносу»';
    const { ctx, p, errors } = await open(1440, {
      rewrite: [[LIST, (b) => ({ ...b, items: b.items.map((c) => (c.id === C1 ? { ...withContacts(c), name: long, contacts: withContacts(c).contacts.map((x, i) => (i === 0 ? { ...x, delivery_details: 'Нова пошта, відділення 112, вулиця Велика Васильківська, будинок 72, вхід з двору' } : x)) } : c)) })]],
    });
    await goto(p, '/customers');
    await rowOf(p, C1).getByRole('button', { name: '+ 2 контакти' }).click();
    const orders = await p.getByTestId(`customer-${C1}-orders`).evaluate((td) => {
      const badge = td.querySelector('span.rounded');
      return { badgeLines: badge ? badge.getClientRects().length : null, doneHeight: Math.round(td.lastElementChild.getBoundingClientRect().height) };
    });
    const overflow = await docOverflow(p);
    const region = await p.getByRole('region', { name: 'Замовники' }).evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    const file = await shoot(p, 'table-long');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers', fixture: ['customer 1: a long name, a long delivery, three contacts, opened'] },
      measured: { orders, overflow, region, errors },
      pass: orders.badgeLines === 1 && orders.doneHeight <= 20 && overflow <= 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('list-page-fail', ['E11-B05', 'E11-B07', 'E11-R05'], async () => {
    let second = 0;
    const { ctx, p, errors } = await open(1440, {
      gets: [[LIST, (url) => {
        const pg = Number(new URL(url).searchParams.get('page') ?? '1');
        if (pg !== 2) return { rewrite: (b) => ({ ...b, meta: { ...b.meta, total: 30, last_page: 2 } }) };
        second += 1;
        return second <= 2 ? { fail: 500 } : { json: { items: page1.items.slice(0, 2), meta: { total: 30, current_page: 2, per_page: 24, last_page: 2 } } };
      }]],
    });
    await goto(p, '/customers');
    await p.getByRole('button', { name: /наступн/i }).first().click();
    await p.getByRole('alert').waitFor({ timeout: 8000 });
    const alert = await textOf(p.getByRole('alert'));
    const url = await urlOf(p);
    await p.getByRole('alert').getByRole('button', { name: 'Спробувати знову' }).click();
    await p.waitForTimeout(1200);
    const rows = await p.locator('[data-testid$="-row"]').count();
    const urlAfter = await urlOf(p);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers → next page', fixture: ['page 1 says 2 pages; page 2: 500 ×2, then two rows'] },
      measured: { alert, url, rows, urlAfter, errors },
      pass: alert.includes('Не вдалося завантажити замовників') && url.includes('page=2') && rows === 2 && urlAfter.includes('page=2') && errors.length === 0,
    };
  });

  await scenario('list-refresh-empty', ['E11-B05', 'E11-R05'], async () => {
    let n = 0;
    const { ctx, p, errors } = await open(1440, {
      gets: [[LIST, () => { n += 1; return n === 1 ? { json: { items: [], meta: { total: 0, current_page: 1, per_page: 24, last_page: 1 } } } : { fail: 500 }; }]],
    });
    await p.clock.install();
    await goto(p, '/customers');
    await p.getByText('Замовників ще немає').waitFor();
    await refetchLater(p);
    await p.getByText('Не вдалося оновити').first().waitFor({ timeout: 8000 });
    const both = { empty: await p.getByText('Замовників ще немає').count(), note: await p.getByText('Не вдалося оновити').count() };
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers', fixture: ['GET /customers: empty, then 500'] },
      measured: { both, errors },
      pass: both.empty === 1 && both.note >= 1 && errors.length === 0,
    };
  });

  await scenario('list-back', ['E11-B03', 'E11-B04', 'E11-R05'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, '/customers?q=%D0%A2%D0%B5%D1%85&show=regular&sort=orders-desc');
    const before = await urlOf(p);
    await p.getByRole('link', { name: NAME1, exact: true }).first().click();
    await p.waitForURL(new RegExp(`/customers/${C1}$`));
    await p.goBack();
    await p.waitForTimeout(1000);
    const after = await urlOf(p);
    const tab = await p.getByRole('tab', { name: 'Постійні' }).getAttribute('aria-selected');
    const search = await p.getByRole('searchbox').inputValue();
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/customers?q=Тех&show=regular&sort=orders-desc → a customer → Back' },
      measured: { before, after, tab, search, errors },
      pass: after === before && tab === 'true' && search === 'Тех' && errors.length === 0,
    };
  });

  await scenario('form-buttons-390', ['E11-F04', 'E11-R05'], async () => {
    const { ctx, p, errors } = await open(390, { rewrite: [multiDetail] });
    await goto(p, `/customers/${C1}`);
    await p.getByTestId('customer-header').getByRole('button', { name: 'Редагувати' }).click();
    const d = dialogOf(p, 'Редагувати замовника');
    await d.waitFor();
    const removes = d.getByRole('button', { name: 'Прибрати контакт' });
    const n = await removes.count();
    const reach = [];
    for (let i = 0; i < n; i += 1) reach.push((await hits(p, removes.nth(i))).hits);
    const primary = await hits(p, d.getByRole('button', { name: 'Зберегти замовника' }));
    const panel = await box(d);
    const file = await shoot(p, 'form-390');
    await ctx.close();
    return {
      env: { viewport: [390, 844] },
      recipe: { url: '/customers/{customer:1} → «Редагувати»', fixture: ['three contacts'] },
      measured: { n, reach, primary, panel, errors },
      pass: n === 3 && reach.every(Boolean) && primary.hits && panel.l >= 0 && panel.r <= 390 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('narrow@390', ['E11-E02', 'E11-K1'], async () => {
    const { ctx, p, errors } = await open(390);
    await goto(p, `/customers/${C1}`);
    const side = await box(p.getByTestId('customer-side'));
    const main = await box(p.getByTestId('customer-main'));
    const overflow = await docOverflow(p);
    const file = await shoot(p, 'narrow-detail');
    await goto(p, '/customers');
    const listOverflow = await docOverflow(p);
    await ctx.close();
    return {
      env: { viewport: [390, 844] },
      recipe: { url: '/customers/{customer:1}; /customers' },
      measured: { side, main, overflow, listOverflow, errors },
      pass: side.b <= main.t && overflow <= 0 && listOverflow <= 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  for (const [id, opts, test] of [
    ['theme-light@1440', { storage: { 'theme-mode': 'light' } }, (e) => !/\bdark\b/.test(e.theme)],
    ['theme-oled@1440', { settings: { dark_background: 'oled' } }, (e) => /bg-oled/.test(e.theme)],
  ]) {
    await scenario(id, ['E2-B01', 'E11-E01'], async () => {
      const { ctx, p, errors } = await open(1440, opts);
      await goto(p, `/customers/${C1}`);
      const e = await env(p);
      const file = await shoot(p, id);
      await ctx.close();
      return {
        env: e,
        recipe: { url: '/customers/{customer:1}' },
        measured: { errors },
        pass: test(e) && errors.length === 0,
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
