// WS-13 E13 acceptance runner (spec §L.1), run by Playwright MCP's browser_run_code_unsafe:
//   filename: scripts/workshop_stand/e13_acceptance.js — while `e13_evidence.py serve` listens on 127.0.0.1:8197.
// The harness is E4's (e04_detail.js, via E7–E12), unchanged in what it guarantees: every scenario records WHAT was
// run (recipe + fixtures), WHERE (viewport, DPR, the actual <html> classes), WHAT was measured and whether it
// matched the spec — a failure is a failure, a surface it cannot reach is `pending`. Nothing reaches the stand but
// reads: every non-GET request of every context is answered here — also while a context closes (E13: an abort
// route goes in before the page's routes come off) — and the states the baseline does not hold are rewritten GET
// answers in this runner's own context only. The oracles measure what a person reads and does — the labels in
// order, the sentence in a dialog's slot, which requests a press sent and with what body, the figures against the
// server's own answer — never a class name, except where the spec names the rule itself (the theme classes on
// <html>, the dispatch note's white sheet).
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
    // ⚠️ Nothing reaches the stand while a context closes. A page can still be mid-sequence — a
    // dialog sends one write per plate and the scenario has read the first — and with its own
    // routes taken off, the next write went to the stand unanswered (E13, five queue rows). A
    // context-level route that aborts every request goes in FIRST; the pages' routes come off
    // after it, so whatever the page sends from then on dies here.
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
      if (sessionStorage.getItem('e13-init')) return;
      sessionStorage.setItem('e13-init', '1');
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
      if (step && step.fail) return route.fulfill({ status: step.fail, json: { detail: 'e13 runner' } });
      // A body of the runner's own — the stand is never asked.
      if (step && step.json) return route.fulfill({ status: step.status ?? 200, json: step.json });
      // A picture of the runner's own (the cover fixture, K11): a real PNG file.
      if (step && step.file) return route.fulfill({ status: 200, path: step.file, contentType: 'image/png' });
      const failing = fail.find(([re]) => re.test(url));
      if (failing) return route.fulfill({ status: failing[1], json: { detail: 'e13 runner' } });
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
  // The mockup entities (spec §L.1, Task 0): order 244 — OR-0034, three lines of one product, one
  // «кутовий»; 245 — OR-0035, COMPLETED, with issues; 241 — OR-0031, an active order with prints and
  // a configured line; 229 — OR-0030, a COMPLETED order archive 3593 is filed under; 251 — OR-0041,
  // no customer. Product 1 — «Дифузор
  // «Колба»»; customer 1; position 1; note 90000; the four-plate file «clm01_lbl_p1s.gcode.3mf».
  // Every read is taken as it comes: a field the answer lacks is a scenario's failure, not the
  // preparation's.
  const list = (v) => (Array.isArray(v) ? v : []);
  const O = job.orders ?? {};
  const O244 = O['244'] ?? 244;
  const O245 = O['245'] ?? 245;
  const O241 = O['241'] ?? 241;
  const O229 = O['229'] ?? 229;
  const O251 = O['251'] ?? 251;
  const PR1 = (job.products ?? {})['1'] ?? 1;
  const CU1 = (job.customers ?? {})['1'] ?? 1;
  const POS1 = (job.positions ?? {})['1'] ?? 1;
  const N1 = (job.notes ?? {})['90000'] ?? 1;
  const F88 = (job.files ?? {})['clm01_lbl_p1s.gcode.3mf'] ?? 88;
  const A595 = (job.archives ?? {})['3593'] ?? 595;
  const order244 = await read(`/projects/${O244}`);
  const order241 = await read(`/projects/${O241}`);
  const order229 = await read(`/projects/${O229}`);
  const archive595 = await read(`/archives/${A595}`);
  const product1 = await read(`/products/${PR1}`);
  const file88 = await read(`/library/files/${F88}`);
  const groups = await read('/groups/');
  const groupList = Array.isArray(groups) ? groups : list(groups?.items);
  const adminPerms = groupList.find((g) => g.name === 'Administrators')?.permissions ?? [];
  const without = (...drop) => adminPerms.filter((perm) => !drop.includes(perm));
  // The Workshop's rights (WS-13 E13 §O, m194): each old `projects:*` right is the set of new ones
  // its gates became — the images T14 mapped by — so a role named by the old right keeps its doors.
  const IMG = {
    create: ['orders:create', 'products:create', 'customers:create'],
    update: ['orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust'],
    delete: ['orders:delete', 'products:delete', 'customers:delete'],
  };
  const WRITES = [...IMG.create, ...IMG.update, ...IMG.delete, 'orders:file_prints'];
  const READER = { is_admin: false, role: 'user', permissions: without(...WRITES) };
  // A user of the runner's own for the ownership cases — no stand row has this id.
  const ME_ID = 9001;
  const asUser = (permissions) => ({ id: ME_ID, is_admin: false, role: 'user', permissions });
  // O19: roles named by their own rights, never «the administrator minus one» — each carries the
  // non-Workshop reads its pages need to be reached at all, and no Workshop right it does not use.
  const ROLE = {
    // Files and unfiles any print (V03): no «change orders», no «update all» archives.
    clerk: ['archives:read_all', 'printers:read', 'orders:read', 'orders:file_prints'],
    // Moves goods, does not correct the books, never reads the catalog (R12).
    storekeeper: ['stock:read', 'stock:move'],
    ordersReader: ['orders:read'],
    customersReader: ['customers:read'],
    // Edits the catalog; no contacts, orders or stock (O19).
    catalogEditor: ['products:read', 'products:update', 'library:read_all'],
    // O05: orders, the catalog's and the customers' reads and customers:create — no stock at all.
    orderManager: ['orders:read', 'orders:create', 'orders:update', 'orders:delete', 'orders:file_prints', 'products:read', 'customers:read', 'customers:create'],
    // O19 / R11: answers a full plate; no orders' rights at all.
    plateOperator: ['printers:read', 'printers:clear_plate', 'queue:read'],
    // O19: an order for a new customer with its contact and delivery — no directory read.
    orderClerk: ['orders:read', 'orders:create', 'customers:create'],
    // O19: keeps the customers and their delivery directory.
    customersEditor: ['customers:read', 'customers:update'],
    // O19: makes customers and picks their delivery; never keeps the directory.
    customersCreator: ['customers:read', 'customers:create'],
  };
  // What the boundary answers in the system language (api_errors_uk.json) — the runner answers
  // writes itself, so it says a refusal the way the server would.
  const UK = {
    ownArchives: 'Оновлювати можна лише власні архіви',
    leave: 'Ці друки вже оприбутковані на склад під замовлення — прибрати їх із замовлення не можна',
    fileGone: 'Файл бібліотеки не знайдено',
    filingForbidden: 'Прив’язати роботу до замовлення можна з правом orders:update або orders:file_prints',
  };
  const linesOf = (order) => list(order?.lines);
  // An order's line as the picker names it: «product × quantity · configuration».
  const configured244 = linesOf(order244).find((l) => list(l.configuration?.choices).some((c) => !c.is_default));

  // --- doors and oracles ---
  const ORDERS_PAGE = /\/api\/v1\/projects\/?\?(.*&)?status=active/;
  const ORDER = (id) => new RegExp(`/api/v1/projects/${id}/?(\\?.*)?$`);
  const goto = async (p, path) => {
    await p.goto(`${job.ui}${path}`, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(600);
  };
  const dialogOf = (p, name) => p.getByRole('dialog', { name, exact: true });
  const textOf = (locator) => locator.evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim());
  const recorder = (store, re, answerOf) => [re, async (req) => {
    let body = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    const entry = { method: req.method(), path: new URL(req.url()).pathname + new URL(req.url()).search, body };
    store.push(entry);
    return answerOf ? answerOf(entry, store.length) : {};
  }];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const docOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const hits = (p, locator) => locator.evaluate((el) => {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inView: r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.left >= 0 && r.right <= innerWidth + 0.5, hits: !!hit && (hit === el || el.contains(hit)) };
  });
  // The labels of a select's options, in order, and the one shown.
  const optionsOf = (select) => select.evaluate((el) => [...el.options].map((o) => o.textContent.trim()));
  const shownOf = (select) => select.evaluate((el) => el.selectedOptions[0]?.textContent.trim() ?? null);
  const focusAt = (p) => p.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return 'BODY';
    const label = a.id ? document.querySelector(`label[for="${CSS.escape(a.id)}"]`) : null;
    return (label?.textContent || a.getAttribute('aria-label') || a.textContent || a.tagName).replace(/\s+/g, ' ').trim().slice(0, 80);
  });
  // The archives page as cards: a card by its archive, its menu, an entry of the menu.
  const GRID = { archiveViewMode: 'grid' };
  // The archives page's first card filed under the ACTIVE OR-0034, under no line: the stand's
  // newest print sits in the COMPLETED OR-0030, where the dialog rightly files nothing new —
  // and it says so only once it has read the order (T19).
  const FIRST_IN_ACTIVE = [/\/api\/v1\/archives\/?\?/, (json) => ({
    ...json,
    data: list(json.data).map((a, i) => (i === 0 ? { ...a, project_id: O244, project_name: order244.name, project_line_id: null, project_status: 'active' } : a)),
  })];
  const archiveCard = (p, id) => p.locator(`[data-archive-id="${id}"]`).first();
  const openArchiveMenu = async (p, id) => {
    await archiveCard(p, id).hover();
    await archiveCard(p, id).getByTitle('Натисніть правою кнопкою для додаткових параметрів').click();
    const menu = p.getByRole('button', { name: 'Додати до замовлення', exact: true }).locator('xpath=ancestor::div[contains(@class,"fixed")][1]');
    await menu.waitFor();
    return menu;
  };
  const firstArchiveId = async (p) => Number(await p.locator('[data-archive-id]').first().getAttribute('data-archive-id'));

  // ---------------------------------------------------------------- B / D: archives → order
  await scenario('archives-assign@1440', ['E13-D01', 'E13-D01a', 'E13-D02', 'E13-D03', 'E13-B06'], async () => {
    const writes = [];
    // The active orders' first page leaves the target out and says there is a second one: the
    // target is reached by the SERVER's search (D01) — the baseline holds fewer than a page.
    let target = O244;
    const trail = [];
    const { ctx, p, errors, requests } = await open(1440, {
      storage: GRID,
      rewrite: [[ORDERS_PAGE, (json, url) => (new URL(url).searchParams.get('q') ? json : {
        ...json, items: list(json.items).filter((o) => o.id !== target), meta: { ...(json.meta ?? {}), total: 21, last_page: 2 },
      })]],
      writes: [recorder(writes, /\/api\/v1\/projects\/\d+\/add-archives$/)],
    });
    try {
    await goto(p, '/archives');
    const id = await firstArchiveId(p);
    const filed = await read(`/archives/${id}`);
    if (filed.project_id === O244) target = O241;
    trail.push('page');
    const targetOrder = target === O244 ? order244 : order241;
    const menu = await openArchiveMenu(p, id);
    await menu.getByRole('button', { name: 'Додати до замовлення', exact: true }).click();
    const d = dialogOf(p, 'Додати до замовлення');
    await d.waitFor();
    const order = d.getByLabel('Замовлення', { exact: true });
    await p.waitForFunction(() => !document.querySelector('[role="dialog"] select:disabled#batch-assign-order'));
    const firstPage = await optionsOf(order);
    const pager = await d.getByText(/^Сторінка 1 з 2$/).count();
    trail.push('first page');
    await d.getByRole('searchbox', { name: 'Знайти замовлення…' }).fill(targetOrder.code ?? '');
    const targetOption = d.locator('#batch-assign-order option', { hasText: targetOrder.code ?? '—' });
    await targetOption.first().waitFor({ state: 'attached', timeout: 6000 });
    trail.push('found');
    await order.selectOption(String(target));
    const line = d.getByLabel('Позиція', { exact: true });
    await p.waitForFunction(() => {
      const s = document.querySelector('#batch-assign-line');
      return s && !s.disabled && s.options.length > 1;
    }, null, { timeout: 6000 });
    const lineOptions = await optionsOf(line);
    const lineShown = await shownOf(line);
    const files = [await shoot(p, 'archives-assign-dialog')];
    trail.push('lines');
    await d.getByRole('button', { name: 'Прив\'язати', exact: true }).click();
    await d.waitFor({ state: 'detached', timeout: 6000 });
    const searched = requests.filter((r) => /\/projects\/?\?/.test(r) && /[?&]q=/.test(r));
    await ctx.close();
    const configured = target === O244 ? configured244 : linesOf(order241).find((l) => list(l.configuration?.choices).some((c) => !c.is_default));
    const configName = list(configured?.configuration?.choices).filter((c) => !c.is_default).map((c) => `${c.group_name}: ${c.option_name}`).join(' · ');
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: '/archives → the first card’s menu → «Додати до замовлення»',
        fixture: ['GET /projects?status=active page 1 without the target, meta last_page 2', 'POST add-archives (answered here)'],
        actions: ['search the target’s code', 'choose it', 'leave «Без позиції»', '«Прив’язати»'],
      },
      measured: { archive: id, target, firstPage, pager, searched, lineOptions, lineShown, writes, errors },
      pass: !firstPage.some((o) => o.startsWith(`${targetOrder.code} `)) && pager === 1 && searched.length >= 1 &&
        lineOptions[0] === 'Без позиції' && lineShown === 'Без позиції' &&
        (!configured || lineOptions.some((o) => o === `${configured.product_name} × ${configured.quantity} · ${configName}`)) &&
        writes.length === 1 && writes[0].path === `/api/v1/projects/${target}/add-archives` &&
        same(writes[0].body, { archive_ids: [id], project_line_id: null }) && errors.length === 0,
      screenshots: files,
    };
    } catch (e) {
      return { pass: false, error: safeError(e, 'archives-assign@1440'), measured: { trail, requests: requests.filter((r) => /projects/.test(r)).slice(-6) } };
    }
  });

  await scenario('archives-assign-rights', ['E13-B06', 'E13-B03'], async () => {
    const out = {};
    // (a) `update_own` and an ownerless print: no way in, and the menu says why.
    {
      const { ctx, p } = await open(1440, { storage: GRID, me: asUser(without('archives:update_all', 'orders:file_prints')) });
      await goto(p, '/archives');
      const id = await firstArchiveId(p);
      const menu = await openArchiveMenu(p, id);
      const item = menu.getByRole('button', { name: 'Додати до замовлення', exact: true });
      out.own = { disabled: await item.isDisabled(), title: await item.getAttribute('title') };
      await ctx.close();
    }
    // (b) No right to change orders.
    {
      const { ctx, p } = await open(1440, { storage: GRID, me: asUser(without('orders:update', 'orders:file_prints')) });
      await goto(p, '/archives');
      const id = await firstArchiveId(p);
      const menu = await openArchiveMenu(p, id);
      const item = menu.getByRole('button', { name: 'Додати до замовлення', exact: true });
      out.orders = { disabled: await item.isDisabled(), title: await item.getAttribute('title') };
      await ctx.close();
    }
    // (c) Offered, and the server refuses another's print: its sentence in the dialog's slot.
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      storage: GRID,
      rewrite: [FIRST_IN_ACTIVE],
      writes: [recorder(writes, /\/add-archives$/, () => ({ __status: 403, json: { detail: UK.ownArchives } }))],
    });
    await goto(p, '/archives');
    const id = await firstArchiveId(p);
    const menu = await openArchiveMenu(p, id);
    await menu.getByRole('button', { name: 'Додати до замовлення', exact: true }).click();
    const d = dialogOf(p, 'Додати до замовлення');
    await d.waitFor();
    await d.getByRole('button', { name: 'Прив\'язати', exact: true }).click();
    const alert = d.getByRole('alert');
    await alert.waitFor({ timeout: 6000 });
    out.refused = { text: await textOf(alert), open: await d.isVisible() };
    const files = [await shoot(p, 'archives-assign-refused-403')];
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/archives → a card’s menu', fixture: ['/auth/me: update_own only, without orders:file_prints', '/auth/me: without orders:update and orders:file_prints', 'POST add-archives → 403'] },
      measured: { ...out, writes: writes.length, errors },
      pass: out.own.disabled && out.own.title === 'У вас немає дозволу оновлювати архіви' &&
        out.orders.disabled && out.orders.title === 'Щоб додати друк до замовлення, потрібне право змінювати замовлення або прив’язувати друки' &&
        out.refused.text === UK.ownArchives && out.refused.open && writes.length === 1 && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('archives-assign-leave-refused', ['E13-B05', 'E13-D03'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      storage: GRID,
      rewrite: [FIRST_IN_ACTIVE],
      writes: [recorder(writes, /\/add-archives$/, () => ({ __status: 409, json: { detail: UK.leave } }))],
    });
    await goto(p, '/archives');
    const id = await firstArchiveId(p);
    const menu = await openArchiveMenu(p, id);
    await menu.getByRole('button', { name: 'Додати до замовлення', exact: true }).click();
    const d = dialogOf(p, 'Додати до замовлення');
    await d.waitFor();
    await p.waitForFunction(() => !/Обране замовлення/.test(document.querySelector('#batch-assign-order')?.selectedOptions[0]?.textContent ?? 'Обране замовлення'), null, { timeout: 6000 });
    // «Прив'язати» waits until the order is read (T19) — and so its full label, the one kept.
    await p.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent.trim() === 'Прив\'язати' && !b.disabled), null, { timeout: 6000 });
    const chosen = await shownOf(d.getByLabel('Замовлення', { exact: true }));
    await d.getByRole('button', { name: 'Прив\'язати', exact: true }).click();
    const alert = d.getByRole('alert');
    await alert.waitFor({ timeout: 6000 });
    const refused = { text: await textOf(alert), open: await d.isVisible(), kept: await shownOf(d.getByLabel('Замовлення', { exact: true })) };
    // The refusal frees the button: a second press sends again.
    await d.getByRole('button', { name: 'Прив\'язати', exact: true }).click();
    await p.waitForTimeout(800);
    const files = [await shoot(p, 'archives-assign-refused-409')];
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/archives → a card’s menu → «Додати до замовлення»', fixture: ['POST add-archives → 409 (a print its order received)'] },
      measured: { chosen, refused, writes: writes.length, errors },
      pass: refused.text === UK.leave && refused.open && refused.kept === chosen && writes.length === 2 && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('archive-edit-order@1440', ['E13-D01', 'E13-D02', 'E13-B06'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      storage: GRID,
      writes: [recorder(writes, new RegExp(`/api/v1/archives/${A595}$`), () => archive595)],
    });
    await goto(p, '/archives');
    const card = archiveCard(p, A595);
    const present = await card.count();
    if (!present) {
      await ctx.close();
      return { pass: null, measured: { reason: `archive ${A595} is not on the first page` } };
    }
    const menu = await openArchiveMenu(p, A595);
    await menu.getByRole('button', { name: 'Редагувати', exact: true }).click();
    const d = dialogOf(p, 'Редагувати архів');
    await d.waitFor();
    const order = d.getByLabel('Замовлення', { exact: true });
    await p.waitForFunction(() => {
      const s = document.querySelector('#edit-archive-order');
      return s && s.selectedOptions[0] && !/Обране замовлення/.test(s.selectedOptions[0].textContent);
    }, null, { timeout: 6000 });
    const shown = await shownOf(order);
    await p.waitForFunction(() => {
      const s = document.querySelector('#edit-archive-line');
      return s && !/Читаємо/.test(s.selectedOptions[0]?.textContent ?? '');
    }, null, { timeout: 6000 });
    const lineShown = await shownOf(d.getByLabel('Позиція', { exact: true }));
    await d.getByPlaceholder('Додайте нотатки про цей друк...').fill('перевірено E13');
    const files = [await shoot(p, 'archive-edit-closed-order')];
    await d.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await d.waitFor({ state: 'detached', timeout: 6000 });
    await ctx.close();
    const body = writes[0]?.body ?? {};
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/archives → the card of archive 595 (filed under the COMPLETED OR-0030) → «Редагувати»', fixture: ['PATCH /archives/595 (answered here)'], actions: ['type a note', '«Зберегти»'] },
      measured: { shown, lineShown, body, errors },
      pass: shown === `${order229.code} · ${order229.name} · Виконане` && !!lineShown && !/Без позиції|Читаємо/.test(lineShown) &&
        writes.length === 1 && body.notes === 'перевірено E13' && !('project_id' in body) && !('project_line_id' in body) && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('archive-edit-lines-states', ['E13-D02'], async () => {
    const out = {};
    const files = [];
    // An archive of OR-0034, filed under a line.
    const prints244 = list(await read(`/projects/${O244}/archives?limit=5&offset=0`));
    const filed = prints244.find((a) => a.project_line_id != null) ?? prints244[0] ?? { id: 0 };
    // The archives page cannot be asked for one print by its URL: its list answer is that print alone.
    const filedRow = await read(`/archives/${filed.id}`);
    const ONE = [/\/api\/v1\/archives\/?\?/, (json) => ({ ...json, data: [filedRow], meta: { ...(json.meta ?? {}), total: 1, last_page: 1 } })];
    const openEditor = async (p) => {
      await goto(p, '/archives');
      const menu = await openArchiveMenu(p, filed.id);
      await menu.getByRole('button', { name: 'Редагувати', exact: true }).click();
      const d = dialogOf(p, 'Редагувати архів');
      await d.waitFor();
      return d;
    };
    // (a) The lines cannot be read: said with a retry; the bound line stays; the retry reads them.
    {
      let calls = 0;
      const { ctx, p } = await open(1440, {
        storage: GRID,
        rewrite: [ONE],
        gets: [[ORDER(O244), () => { calls += 1; return calls <= 2 ? { fail: 500 } : null; }]],
      });
      const d = await openEditor(p);
      const note = d.getByRole('alert').filter({ hasText: 'Не вдалося прочитати позиції замовлення' });
      await note.waitFor({ timeout: 8000 });
      out.failed = { line: await d.locator('#edit-archive-line').inputValue(), shown: await shownOf(d.locator('#edit-archive-line')) };
      files.push(await shoot(p, 'archive-edit-lines-failed'));
      await note.getByRole('button', { name: 'Спробувати знову' }).click();
      await p.waitForFunction(() => /×/.test(document.querySelector('#edit-archive-line')?.selectedOptions[0]?.textContent ?? ''), null, { timeout: 6000 });
      out.retried = { line: await d.locator('#edit-archive-line').inputValue(), shown: await shownOf(d.locator('#edit-archive-line')) };
      await ctx.close();
    }
    // (b) A → B: A's late answer never replaces B's lines.
    {
      let slow = 0;
      const { ctx, p } = await open(1440, {
        storage: GRID,
        rewrite: [ONE],
        gets: [[ORDER(O244), () => { slow += 1; return slow === 1 ? { delay: 3500 } : null; }]],
      });
      const d = await openEditor(p);
      await p.waitForFunction(() => !document.querySelector('#edit-archive-order')?.disabled, null, { timeout: 6000 });
      await d.getByLabel('Замовлення', { exact: true }).selectOption(String(O241));
      await p.waitForFunction(() => /×/.test([...(document.querySelector('#edit-archive-line')?.options ?? [])].map((o) => o.textContent).join('|')), null, { timeout: 6000 });
      out.b = await optionsOf(d.locator('#edit-archive-line'));
      await p.waitForTimeout(3800);
      out.afterLateA = await optionsOf(d.locator('#edit-archive-line'));
      await ctx.close();
    }
    // (c) A successful answer without lines: «Без позиції» alone.
    {
      const { ctx, p } = await open(1440, {
        storage: GRID,
        rewrite: [ONE, [ORDER(O241), (json) => ({ ...json, lines: [] })]],
      });
      const d = await openEditor(p);
      await p.waitForFunction(() => !document.querySelector('#edit-archive-order')?.disabled, null, { timeout: 6000 });
      await d.getByLabel('Замовлення', { exact: true }).selectOption(String(O241));
      await p.waitForFunction(() => !document.querySelector('#edit-archive-line')?.disabled, null, { timeout: 6000 });
      out.empty = await optionsOf(d.locator('#edit-archive-line'));
      files.push(await shoot(p, 'archive-edit-lines-empty'));
      await ctx.close();
    }
    const lines241 = linesOf(order241).map((l) => l.product_name);
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: '/archives → an OR-0034 print → «Редагувати»',
        fixture: ['GET /projects/{order:244} 500 twice', 'GET /projects/{order:244} first answer 3.5 s late', 'GET /projects/{order:241} without lines'],
      },
      measured: { archive: filed.id, ...out },
      pass: out.failed.line === String(filed.project_line_id) && out.failed.shown === 'Обрана позиція' &&
        out.retried.line === String(filed.project_line_id) && /×/.test(out.retried.shown ?? '') &&
        out.b.slice(1).every((o) => lines241.some((n) => o.startsWith(`${n} ×`))) && same(out.afterLateA, out.b) &&
        same(out.empty, ['Без позиції']),
      screenshots: files,
    };
  });

  await scenario('order-prints-unlink-rights', ['E13-B06', 'E13-B03'], async () => {
    // Three of OR-0031's prints: the user's own, another's, nobody's.
    const owners = [ME_ID, 7, null];
    const three = [];
    const { ctx, p, errors } = await open(1440, {
      me: asUser(without('archives:update_all', 'orders:file_prints')),
      rewrite: [[new RegExp(`/api/v1/projects/${O241}/archives`), (json) => list(json).map((a, i) => {
        if (i >= 3) return a;
        if (three.length < 3) three.push(a.id);
        return { ...a, created_by_id: owners[i] };
      })]],
    });
    await goto(p, `/projects/${O241}?section=prints`);
    await p.locator('[data-print-card]').first().waitFor({ timeout: 8000 });
    const menus = [];
    const files = [];
    for (let i = 0; i < 3; i += 1) {
      const trigger = p.getByTestId(`print-menu-${three[i]}`);
      if (!(await trigger.count())) {
        menus.push(null);
        continue;
      }
      await trigger.click();
      const items = await p.getByRole('menuitem').evaluateAll((ms) => ms.map((m) => m.textContent.trim()));
      menus.push(items);
      if (i === 0) files.push(await shoot(p, 'order-prints-own-menu'));
      await p.keyboard.press('Escape');
    }
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/projects/{order:241}?section=prints', fixture: ['/auth/me: archives:update_own without orders:file_prints, user 9001', 'the first three prints: own, another’s, nobody’s'] },
      measured: { menus, errors },
      pass: !!menus[0] && menus[0].includes('Прибрати із замовлення') && menus[0].includes('Призначити до позиції…') &&
        [menus[1], menus[2]].every((m) => m === null || (!m.includes('Прибрати із замовлення') && !m.includes('Призначити до позиції…'))) &&
        errors.length === 0,
      screenshots: files,
    };
  });

  // V03 / O19 — the filing clerk: «file prints» alone, no «change orders», no «update all», for
  // another's and an ownerless print, on every V01 door — each press checked by its method and
  // route, and no general PATCH of the archive.
  const NO_PATCH = (writes) => writes.every((w) => !(w.method === 'PATCH' && /\/api\/v1\/archives\/\d+$/.test(w.path)));

  await scenario('clerk-archives', ['E13-V03', 'E13-B06', 'E13-O19'], async () => {
    const writes = [];
    let two = [];
    const { ctx, p, errors } = await open(1440, {
      storage: GRID,
      me: asUser(ROLE.clerk),
      // The first two cards: another's print under no order, and an ownerless print of OR-0031.
      rewrite: [[/\/api\/v1\/archives\/?\?/, (json) => {
        const data = list(json.data).map((a, i) => {
          if (i === 0) return { ...a, created_by_id: 7, project_id: null, project_name: null, project_line_id: null };
          if (i === 1) return { ...a, created_by_id: null, project_id: O241, project_name: order241.name, project_line_id: null };
          return a;
        });
        two = data.slice(0, 2).map((a) => a.id);
        return { ...json, data };
      }]],
      writes: [recorder(writes, /\/api\/v1\/(projects\/\d+\/(add|remove)-archives|archives\/\d+)$/)],
    });
    await goto(p, '/archives');
    const entry = async (id) => {
      const menu = await openArchiveMenu(p, id);
      const item = menu.getByRole('button', { name: 'Додати до замовлення', exact: true });
      return { item, state: { disabled: await item.isDisabled(), title: await item.getAttribute('title') } };
    };
    // (a) Another's print: filed under OR-0034.
    const a = await entry(two[0]);
    await a.item.click();
    let d = dialogOf(p, 'Додати до замовлення');
    await d.waitFor();
    await p.waitForFunction((target) => {
      const s = document.querySelector('#batch-assign-order');
      return s && !s.disabled && [...s.options].some((o) => o.value === target);
    }, String(O244), { timeout: 8000 });
    await d.getByLabel('Замовлення', { exact: true }).selectOption(String(O244));
    const files = [await shoot(p, 'clerk-archives-assign')];
    await d.getByRole('button', { name: 'Прив\'язати', exact: true }).click();
    await d.waitFor({ state: 'detached', timeout: 6000 });
    // (b) The ownerless print of OR-0031: taken out of it.
    const b = await entry(two[1]);
    await b.item.click();
    d = dialogOf(p, 'Додати до замовлення');
    await d.waitFor();
    const remove = d.getByRole('button', { name: 'Прибрати із замовлення', exact: true });
    await remove.waitFor({ timeout: 6000 });
    await remove.click();
    await d.waitFor({ state: 'detached', timeout: 6000 });
    await ctx.close();
    const sent = writes.map((w) => ({ method: w.method, path: w.path, body: w.body }));
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: '/archives → the first card’s menu, then the second’s',
        fixture: ['/auth/me: ' + ROLE.clerk.join(', ') + ' (user 9001)', 'the first card another user’s print under no order, the second an ownerless print of OR-0031', 'every write answered here'],
        actions: ['«Додати до замовлення» → OR-0034 → «Прив’язати»', '«Додати до замовлення» → «Прибрати із замовлення»'],
      },
      measured: { archives: two, entries: [a.state, b.state], sent, errors },
      pass: [a.state, b.state].every((s) => !s.disabled && s.title === 'Додати до замовлення') && sent.length === 2 &&
        sent[0].method === 'POST' && sent[0].path === `/api/v1/projects/${O244}/add-archives` && same(sent[0].body, { archive_ids: [two[0]], project_line_id: null }) &&
        sent[1].method === 'POST' && sent[1].path === `/api/v1/projects/${O241}/remove-archives` && same(sent[1].body, { archive_ids: [two[1]] }) &&
        NO_PATCH(writes) && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('clerk-order-prints', ['E13-V03', 'E13-B06', 'E13-O19'], async () => {
    const writes = [];
    const two = [];
    const lineOf = {};
    const { ctx, p, errors } = await open(1440, {
      me: asUser(ROLE.clerk),
      // OR-0031's prints by id: an even one is another user's, an odd one nobody's — the two
      // pressed are the first of each on screen (the tab pages each line's prints).
      rewrite: [[new RegExp(`/api/v1/projects/${O241}/archives`), (json) => list(json).map((a) => {
        lineOf[a.id] = a.project_line_id ?? null;
        return { ...a, created_by_id: a.id % 2 === 0 ? 7 : null };
      })]],
      writes: [recorder(writes, /\/api\/v1\/(projects\/\d+\/(add|remove)-archives|archives\/\d+)$/)],
    });
    const trail = [];
    try {
    await goto(p, `/projects/${O241}?section=prints`);
    await p.locator('[data-print-card]').first().waitFor({ timeout: 8000 });
    const shown = (await p.locator('[data-testid^="print-menu-"]').evaluateAll((ts) => ts.map((t) => t.dataset.testid))).map((t) => Number(t.replace('print-menu-', '')));
    two.push(shown.find((id) => id % 2 === 0), shown.find((id) => id % 2 === 1));
    trail.push(`prints ${two.join(',')}; triggers ${shown.length}`);
    const menuOf = async (id) => {
      await p.getByTestId(`print-menu-${id}`).click();
      await p.getByRole('menuitem').first().waitFor({ timeout: 6000 });
      return p.getByRole('menuitem').evaluateAll((ms) => ms.map((m) => m.textContent.trim()));
    };
    // (a) Another's print moved to a line it is not under — or out of its line when the order
    // has no other (the dialog sends only a change).
    const other = linesOf(order241).find((l) => l.id !== lineOf[two[0]]);
    const line = other ?? { id: null };
    const menuA = await menuOf(two[0]);
    trail.push(`menu A ${menuA.join('|')}`);
    await p.getByRole('menuitem', { name: 'Призначити до позиції…' }).click();
    const d = dialogOf(p, 'Призначити до позиції');
    await d.waitFor();
    trail.push('assign dialog');
    await d.getByLabel('Позиція', { exact: true }).selectOption(line.id == null ? { label: 'Без позиції (інші друки)' } : String(line.id));
    const files = [await shoot(p, 'clerk-order-prints-assign')];
    await d.getByRole('button', { name: 'Призначити', exact: true }).click();
    await d.waitFor({ state: 'detached', timeout: 6000 });
    // (b) The ownerless print out of the order.
    trail.push('assigned');
    const menuB = await menuOf(two[1]);
    trail.push(`menu B ${menuB.join('|')}`);
    await p.getByRole('menuitem', { name: 'Прибрати із замовлення' }).click();
    const confirm = p.getByRole('dialog').filter({ hasText: 'із замовлення?' }).last();
    await confirm.waitFor();
    await confirm.getByRole('button', { name: 'Прибрати', exact: true }).click();
    await confirm.waitFor({ state: 'detached', timeout: 6000 });
    await ctx.close();
    const sent = writes.map((w) => ({ method: w.method, path: w.path, body: w.body }));
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: `/projects/{order:241}?section=prints`,
        fixture: ['/auth/me: ' + ROLE.clerk.join(', ') + ' (user 9001)', 'OR-0031’s prints: an even id another user’s, an odd one nobody’s', 'every write answered here'],
        actions: ['the first another’s print on screen: «Призначити до позиції…» → a line it is not under → «Призначити»', 'the first nobody’s: «Прибрати із замовлення» → «Прибрати»'],
      },
      measured: { prints: two, from: lineOf[two[0]] ?? null, line: line.id, menus: [menuA, menuB], sent, trail, errors },
      pass: [menuA, menuB].every((m) => m.includes('Призначити до позиції…') && m.includes('Прибрати із замовлення')) && sent.length === 2 &&
        sent[0].method === 'POST' && sent[0].path === `/api/v1/projects/${O241}/add-archives` && same(sent[0].body, { archive_ids: [two[0]], project_line_id: line.id }) &&
        sent[1].method === 'POST' && sent[1].path === `/api/v1/projects/${O241}/remove-archives` && same(sent[1].body, { archive_ids: [two[1]] }) &&
        NO_PATCH(writes) && errors.length === 0,
      screenshots: files,
    };
    } catch (e) {
      const file = await shoot(p, 'clerk-order-prints-failed').catch(() => null);
      return { pass: false, error: safeError(e, 'clerk-order-prints'), measured: { trail }, screenshots: file ? [file] : [] };
    }
  });

  await scenario('reprint-inherits-order', ['E13-O10', 'E13-V03', 'E13-O19'], async () => {
    // Q3 / ARC-08: a reprint of an order's print keeps the order only for whoever may file
    // future work — the filing clerk, by «file prints» alone; a printer operator without it is
    // told so before sending, «without order» ticked and fixed. The body is pinned by
    // PrintModalOrderFiling / repeatAndCloneWithoutOrder, the server by the filing doors' tests.
    const out = {};
    const files = [];
    for (const [who, permissions] of [['clerk', [...ROLE.clerk, 'archives:reprint_all', 'printers:control']], ['operator', ['archives:read_all', 'printers:read', 'archives:reprint_all', 'printers:control']]]) {
      let first = null;
      const { ctx, p } = await open(1440, {
        storage: GRID,
        me: asUser(permissions),
        rewrite: [
          [/\/api\/v1\/archives\/?\?/, (json) => {
            // The stand keeps no 3MF: the first card is told it has a sliced one — the dialog is
            // opened and read, nothing is sent.
            const data = list(json.data).map((a, i) => (i === 0 ? {
              ...a, created_by_id: null, project_id: O241, project_name: order241.name,
              file_path: a.file_path || 'archive/e13/fixture.gcode.3mf', filename: /\.gcode\.3mf$/i.test(a.filename ?? '') ? a.filename : 'fixture.gcode.3mf',
            } : a));
            first = data[0]?.id ?? null;
            return { ...json, data };
          }],
          [/\/api\/v1\/archives\/\d+\/?(\?.*)?$/, (json) => (json && json.id === first ? {
            ...json, created_by_id: null, project_id: O241, project_name: order241.name, project_status: 'active',
            file_path: json.file_path || 'archive/e13/fixture.gcode.3mf', filename: /\.gcode\.3mf$/i.test(json.filename ?? '') ? json.filename : 'fixture.gcode.3mf',
          } : json)],
        ],
      });
      await goto(p, '/archives');
      const button = archiveCard(p, first).getByRole('button', { name: 'Передрукувати' });
      out[`${who}Trail`] = { first, buttons: await button.count(), enabled: (await button.count()) ? await button.first().isEnabled() : null, title: (await button.count()) ? await button.first().getAttribute('title') : null };
      if (!out[`${who}Trail`].enabled) {
        files.push(await shoot(p, `reprint-inherits-order-${who}-failed`));
        await ctx.close();
        continue;
      }
      await button.click();
      const block = p.getByTestId('inherited-order');
      await block.waitFor({ timeout: 10000 });
      const box = block.getByRole('checkbox', { name: 'Друкувати без замовлення' });
      out[who] = {
        text: await textOf(block),
        withoutOrder: await box.isChecked(),
        fixed: await box.isDisabled(),
      };
      files.push(await shoot(p, `reprint-inherits-order-${who}`));
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: '/archives → the first card’s «Передрукувати»',
        fixture: ['the first card an ownerless print of OR-0031 (active) with a sliced 3MF (the stand keeps none; the dialog is read, nothing sent)', '/auth/me clerk: ' + ROLE.clerk.join(', ') + ', archives:reprint_all, printers:control', '/auth/me operator: archives:read_all, printers:read, archives:reprint_all, printers:control'],
      },
      measured: out,
      pass: !!out.clerk && !!out.operator && out.clerk.text.startsWith(`Замовлення: ${order241.name}`) && out.clerk.withoutOrder === false && out.clerk.fixed === false &&
        out.operator.withoutOrder === true && out.operator.fixed === true &&
        out.operator.text.includes('потрібне право змінювати замовлення або прив’язувати друки'),
      screenshots: files,
    };
  });

  // The library's links to products (B01 / B06): a file linked to a product, in its folder.
  const linkedFiles = list((await read('/library/files?include_root=false&page=1&per_page=200')).items).filter((f) => list(f.product_ids).length > 0 && f.folder_id != null);
  const linkedFile = linkedFiles[0] ?? { id: 0, folder_id: 0, filename: '' };

  await scenario('link-products-rights', ['E13-B06', 'E13-B01'], async () => {
    const out = {};
    for (const [who, me] of [['library', asUser(without('products:update'))], ['both', null]]) {
      const { ctx, p } = await open(1440, { me, storage: { 'library-view-mode': 'grid' } });
      await goto(p, `/files?folder=${linkedFile.folder_id}`);
      await p.getByText(linkedFile.filename, { exact: true }).first().waitFor({ timeout: 8000 });
      out[who] = {
        linkButtons: await p.getByTitle('Прив\'язати до виробів', { exact: true }).count(),
        badgeIsButton: await p.locator('[title^="Прив\'язано до"]').first().evaluate((el) => el.tagName === 'BUTTON').catch(() => null),
      };
      if (who === 'library') out.files = [await shoot(p, 'link-products-without-orders')];
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/files?folder={a folder with a linked file}', fixture: ['/auth/me: the library right without products:update', 'the stand’s administrator'] },
      measured: { file: linkedFile.id, library: out.library, both: out.both },
      pass: out.library.linkButtons === 0 && out.library.badgeIsButton === false && out.both.badgeIsButton === true,
      screenshots: out.files ?? [],
    };
  });

  await scenario('file-move-links', ['E13-B01', 'E13-B06'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      me: asUser(without('products:update')),
      storage: { 'library-view-mode': 'grid' },
      writes: [recorder(writes, /\/api\/v1\/library\/files\/move$/)],
    });
    await goto(p, `/files?folder=${linkedFile.folder_id}`);
    const card = p.getByText(linkedFile.filename, { exact: true }).first().locator('xpath=ancestor::*[contains(@class,"group")][1]');
    await card.getByLabel('Вибрати файл').click();
    await p.getByRole('button', { name: 'Перемістити', exact: true }).click();
    const d = p.getByRole('dialog').filter({ hasText: 'Перемістити' });
    await d.waitFor();
    const locked = await d.getByText('(змінює вироби)').count();
    const hint = await d.getByText('Тека з позначкою «змінює вироби»', { exact: false }).count();
    const moveDisabled = await d.getByRole('button', { name: 'Перемістити', exact: true }).isDisabled();
    const files = [await shoot(p, 'file-move-links-locked')];
    await d.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/files?folder={the linked file’s folder}', fixture: ['/auth/me: the library right without products:update'], actions: ['select the linked file', '«Перемістити»'] },
      measured: { file: linkedFile.id, locked, hint, moveDisabled, writes: writes.length, errors },
      pass: locked >= 1 && hint === 1 && writes.length === 0 && errors.length === 0,
      screenshots: files,
    };
  });

  // ---------------------------------------------------------------- C: «Add to order…» from the file manager
  const FILES_GRID = { 'library-view-mode': 'grid' };
  // The stand's library rows were seeded directly and carry no `file_tags` — a cache only the tag
  // writer (`compute_file_tags`) fills, at upload and by migration, on every real install (E5's
  // fixture): the list answer gets the format tags that writer computes from a row's name and
  // type, and the four-plate file its `multiplate` (its metadata holds four plates).
  const tagsFor = (f) => [
    ...(f.file_type === 'gcode' ? (f.filename.toLowerCase().endsWith('.3mf') ? ['gcode', '3mf'] : ['gcode'])
      : f.file_type === '3mf' ? ['3mf', 'project'] : f.file_type === 'stl' ? ['stl', 'geometry'] : []),
    ...(f.id === F88 ? ['multiplate'] : []),
  ];
  // The file manager reads a page ({ items, … }); the queue's library picker reads the whole
  // list (an array) — both get the tags.
  const tagged = (f) => (list(f.file_tags).length ? f : { ...f, file_tags: tagsFor(f) });
  const TAGGED = [/\/api\/v1\/library\/files\?/, (pg) => (Array.isArray(pg) ? pg.map(tagged) : { ...pg, items: list(pg.items).map(tagged) })];
  const TAGGED_NOTE = 'GET /library/files → file_tags as the tag writer computes them (the stand seeded none)';
  // The stand's seed stores a plate as { index, printable_objects, filaments: [{ type, color }], … }
  // — without the `objects` list, name, thumbnail flag and the filament's slot and grams that the
  // one writer of the plates cache (threemf_parser_core.parse_plates_from_3mf: upload, scan, m023,
  // the objects backfill) always writes, and the gallery, the plate tab and the print dialog read.
  // Completed here to the parser's shape (E4's fixture): the app is not at fault. Every seeded
  // plate holds one filament, so its grams are the plate's.
  const parserPlate = (pl) => {
    const names = Object.values(pl.printable_objects ?? {});
    const filaments = list(pl.filaments);
    return {
      name: null, has_thumbnail: false, thumbnail_url: null, object_count: names.length, ...pl,
      objects: pl.objects ?? [...new Set(names)],
      filaments: filaments.map((f, i) => ({
        slot_id: i + 1, used_meters: null, ...f,
        used_grams: f.used_grams ?? (filaments.length === 1 ? pl.filament_used_grams ?? 0 : 0),
      })),
    };
  };
  const PLATES = [/\/api\/v1\/library\/files\/\d+\/plates\/?(\?.*)?$/, (b) => ({ ...b, plates: list(b.plates).map(parserPlate) })];
  const PLATES_NOTE = 'GET /library/files/{id}/plates → the seed’s plates completed to the parser’s shape (objects, slot, grams)';
  const file88Name = file88.print_name || file88.filename || '';
  const fileCard = (p) => p.locator('[data-file-card]', { hasText: file88Name }).first();
  const openFileMenu = async (p) => {
    await fileCard(p).hover();
    await fileCard(p).getByRole('button', { name: 'Дії з файлом' }).click();
  };
  const openFromCard = async (p) => {
    await openFileMenu(p);
    await p.getByRole('button', { name: 'Додати в замовлення…', exact: true }).click();
    const d = dialogOf(p, 'Додати в замовлення');
    await d.waitFor();
    return d;
  };
  const filesOf88 = `/files?folder=${file88.folder_id ?? ''}`;
  // What the dialog adds a one-off plate with: the order, the plate, the copies.
  const BATCH = new RegExp('/api/v1/projects/\\d+/lines/batch$');
  const batchAnswer = (orderId) => ({ order: { id: orderId }, results: [{ line_id: 99001, asked_finished: 0, got_finished: 0, asked_kits: 0, got_kits: 0 }] });

  await scenario('fm-add-to-order-file@1440', ['E13-C01', 'E13-C02'], async () => {
    const { ctx, p, errors } = await open(1440, { storage: FILES_GRID, rewrite: [TAGGED, PLATES] });
    await goto(p, filesOf88);
    const d = await openFromCard(p);
    const tab = d.getByRole('tab', { name: 'Разовий з файлу' });
    const selected = await tab.getAttribute('aria-selected');
    const plates = d.getByRole('radiogroup', { name: 'Плити' });
    await plates.waitFor({ timeout: 8000 });
    const radios = await plates.getByRole('radio').count();
    const orderAsked = await d.getByLabel('Замовлення', { exact: true }).count();
    const subtitle = await d.evaluate((el) => (el.getAttribute('aria-describedby') || '').split(/\s+/).map((id) => document.getElementById(id)?.textContent.trim()).filter(Boolean).join(' '));
    const files = [await shoot(p, 'fm-add-to-order-file')];
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/files?folder={the four-plate file’s folder}', fixture: [TAGGED_NOTE, PLATES_NOTE], actions: ['the file card’s «Дії з файлом» → «Додати в замовлення…»'] },
      measured: { file: F88, selected, radios, orderAsked, subtitle, errors },
      pass: selected === 'true' && radios === 4 && orderAsked === 1 && /Оберіть замовлення/.test(subtitle) && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('fm-add-to-order-plate@1440', ['E13-C01', 'E13-C02'], async () => {
    const { ctx, p, errors } = await open(1440, { storage: FILES_GRID, rewrite: [TAGGED, PLATES] });
    await goto(p, filesOf88);
    await fileCard(p).hover();
    await fileCard(p).getByTitle('Галерея плит').click();
    const gallery = p.getByRole('dialog').filter({ hasText: 'Галерея плит' });
    await gallery.waitFor();
    await gallery.getByRole('button', { name: '3', exact: true }).click();
    await gallery.getByRole('button', { name: 'Додати в замовлення…', exact: true }).click();
    const d = dialogOf(p, 'Додати в замовлення');
    await d.waitFor();
    const plates = d.getByRole('radiogroup', { name: 'Плити' });
    await plates.waitFor({ timeout: 8000 });
    const checked = await plates.getByRole('radio').evaluateAll((rs) => rs.map((r) => r.checked));
    const copies = await d.getByLabel('Копій плити').inputValue();
    const summary = await d.getByText(/Разовий виріб з плити/).first().textContent().catch(() => null);
    const files = [await shoot(p, 'fm-add-to-order-plate')];
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/files?folder={the four-plate file’s folder}', fixture: [TAGGED_NOTE, PLATES_NOTE], actions: ['«Галерея плит» → plate 3 → «Додати в замовлення…»'] },
      measured: { checked, copies, summary, errors },
      pass: same(checked, [false, false, true, false]) && copies === '1' && /плити 3 × 1/.test(summary ?? '') && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('fm-add-to-order-back', ['E13-C03'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      storage: FILES_GRID, rewrite: [TAGGED, PLATES],
      writes: [recorder(writes, BATCH, () => batchAnswer(O244))],
    });
    await goto(p, filesOf88);
    await fileCard(p).getByLabel('Вибрати файл').click();
    const before = await p.getByText(/^1 вибрано$/).count();
    const d = await openFromCard(p);
    const place = await p.evaluate(() => location.pathname + location.search);
    await p.waitForFunction(() => !document.querySelector('[role="dialog"] select[aria-label="Замовлення"]')?.disabled, null, { timeout: 8000 });
    await d.getByRole('searchbox', { name: 'Знайти замовлення…' }).fill(order244.code ?? '');
    await d.locator('select[aria-label="Замовлення"] option', { hasText: order244.code ?? '—' }).first().waitFor({ state: 'attached', timeout: 6000 });
    await d.getByLabel('Замовлення', { exact: true }).selectOption(String(O244));
    const plates = d.getByRole('radiogroup', { name: 'Плити' });
    await plates.waitFor({ timeout: 8000 });
    await plates.getByRole('radio').first().check();
    await d.getByRole('button', { name: 'Створити й додати', exact: true }).click();
    await p.waitForURL(new RegExp(`/projects/${O244}`), { timeout: 8000 });
    const landed = await p.evaluate(() => location.pathname);
    await p.goBack({ waitUntil: 'networkidle' });
    await p.waitForTimeout(800);
    const back = await p.evaluate(() => location.pathname + location.search);
    const after = await p.getByText(/^1 вибрано$/).count();
    const files = [await shoot(p, 'fm-add-to-order-back')];
    await ctx.close();
    const params = new URLSearchParams(back.split('?')[1] ?? '');
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: '/files?folder={the four-plate file’s folder}',
        fixture: [TAGGED_NOTE, PLATES_NOTE, 'POST /projects/{order:244}/lines/batch (answered here)'],
        actions: ['select the file', '«Додати в замовлення…»', 'OR-0034, plate 1', '«Створити й додати»', 'Back'],
      },
      measured: { place, landed, back, before, after, batch: writes.map((w) => ({ path: w.path, body: w.body })), errors },
      pass: before === 1 && writes.length === 1 && writes[0].path === `/api/v1/projects/${O244}/lines/batch` &&
        landed === `/projects/${O244}` && back.startsWith('/files') && params.get('folder') === String(file88.folder_id) &&
        params.get('page') === '1' && params.get('selected') === String(F88) && after === 1 && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('fm-add-to-order-gone', ['E13-C04'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      storage: FILES_GRID, rewrite: [TAGGED, PLATES],
      writes: [recorder(writes, BATCH, () => ({ __status: 404, json: { detail: UK.fileGone } }))],
    });
    await goto(p, filesOf88);
    const d = await openFromCard(p);
    await p.waitForFunction(() => !document.querySelector('[role="dialog"] select[aria-label="Замовлення"]')?.disabled, null, { timeout: 8000 });
    await d.getByRole('searchbox', { name: 'Знайти замовлення…' }).fill(order244.code ?? '');
    await d.locator('select[aria-label="Замовлення"] option', { hasText: order244.code ?? '—' }).first().waitFor({ state: 'attached', timeout: 6000 });
    await d.getByLabel('Замовлення', { exact: true }).selectOption(String(O244));
    const plates = d.getByRole('radiogroup', { name: 'Плити' });
    await plates.waitFor({ timeout: 8000 });
    await plates.getByRole('radio').nth(1).check();
    await d.getByRole('button', { name: 'Створити й додати', exact: true }).click();
    const alert = d.getByRole('alert');
    await alert.waitFor({ timeout: 6000 });
    const refused = { text: await textOf(alert), open: await d.isVisible(), plate: await plates.getByRole('radio').nth(1).isChecked() };
    const files = [await shoot(p, 'fm-add-to-order-gone')];
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/files?folder={the four-plate file’s folder}', fixture: [TAGGED_NOTE, PLATES_NOTE, 'POST lines/batch → 404 «Файл бібліотеки не знайдено» (the file went to the trash)'] },
      measured: { refused, writes: writes.length, errors },
      pass: refused.text === UK.fileGone && refused.open && refused.plate && writes.length === 1 && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('fm-add-to-order-reader', ['E13-C01', 'E13-G02'], async () => {
    const { ctx, p, errors } = await open(1440, { storage: FILES_GRID, rewrite: [TAGGED, PLATES], me: READER });
    await goto(p, filesOf88);
    await openFileMenu(p);
    await p.getByRole('button', { name: /Завантажити/ }).first().waitFor({ timeout: 6000 });
    const entry = await p.getByRole('button', { name: 'Додати в замовлення…', exact: true }).count();
    // The card's menu closes on a click outside it.
    await p.mouse.click(5, 5);
    await fileCard(p).hover();
    await fileCard(p).getByTitle('Галерея плит').click();
    const gallery = p.getByRole('dialog').filter({ hasText: 'Галерея плит' });
    await gallery.waitFor();
    await gallery.getByRole('button', { name: '1', exact: true }).waitFor({ timeout: 6000 });
    const galleryEntry = await gallery.getByRole('button', { name: 'Додати в замовлення…', exact: true }).count();
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/files?folder={the four-plate file’s folder}', fixture: [TAGGED_NOTE, PLATES_NOTE, '/auth/me: without the Workshop’s writes'] },
      measured: { entry, galleryEntry, errors },
      pass: entry === 0 && galleryEntry === 0 && errors.length === 0,
      screenshots: [],
    };
  });

  // ---------------------------------------------------------------- E: confirmations and files
  // The stand holds no order cover, no gallery and no attachment: the order's and the product's
  // GET answers name them, and the runner serves a real PNG for every picture (E8's fixture).
  const PICTURE_STEP = () => ({ file: job.picture });
  const COVERED_241 = [ORDER(O241), (json) => ({ ...json, cover_image_filename: 'cover.png' })];
  const ORDER_COVER = new RegExp(`/api/v1/projects/${O241}/cover-image`);
  const pictures = (filenames) => filenames.map(([filename, original], i) => ({
    category: 'pictures', filename, original_name: original, size: 48213, sort_order: i, source: 'manual', source_file_id: null, uploaded_at: '2026-09-28T09:40:00Z',
  }));
  const GALLERY_1 = [new RegExp(`/api/v1/products/${PR1}/?(\\?.*)?$`), (json) => ({
    ...json, has_cover: true, cover_image_filename: 'b.png',
    attachments: [...list(json.attachments).filter((a) => a.category !== 'pictures'), ...pictures([['a.png', 'front.png'], ['b.png', 'back.png']])],
  })];
  const PRODUCT_PICTURES = new RegExp(`/api/v1/products/${PR1}/(cover-image|attachment-image/)`);
  const ATTACHED_244 = [ORDER(O244), (json) => ({
    ...json,
    attachments: [
      { filename: 'parcel.png', original_name: 'Пакування.png', size: 48213, uploaded_at: '2026-09-28T09:40:00Z' },
      { filename: 'spec.pdf', original_name: 'Специфікація замовника.pdf', size: 204800, uploaded_at: '2026-09-27T15:10:00Z' },
    ],
  })];
  // What a confirmation is made of: its title, its body, its two buttons, and whether it is the
  // Workshop's one (ActionConfirm draws the WorkshopDialog footer) with a danger primary.
  const confirmOf = async (dialog) => dialog.evaluate((el) => {
    const footer = el.querySelector('[data-workshop-dialog-footer]');
    const buttons = footer ? [...footer.querySelectorAll('button')] : [];
    const primary = buttons[buttons.length - 1];
    // The colour as the screen paints it: Tailwind 4 writes `oklch(…)`, so the computed value is
    // painted onto a pixel and read back as RGB.
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const paint = canvas.getContext('2d');
    paint.fillStyle = primary ? getComputedStyle(primary).backgroundColor : 'transparent';
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b] = paint.getImageData(0, 0, 1, 1).data;
    const labelId = el.getAttribute('aria-labelledby');
    return {
      title: labelId ? document.getElementById(labelId)?.textContent.trim() : null,
      text: el.textContent.replace(/\s+/g, ' ').trim(),
      workshop: !!footer,
      buttons: buttons.map((x) => x.textContent.trim()),
      danger: r > 150 && r > g + 60 && r > b + 60,
    };
  });

  await scenario('confirm-cover-order', ['E13-E01', 'E13-E02'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      rewrite: [COVERED_241],
      gets: [[ORDER_COVER, PICTURE_STEP]],
      writes: [recorder(writes, /\/cover-image$/)],
    });
    await goto(p, `/projects/${O241}`);
    await p.getByRole('button', { name: 'Змінити обкладинку' }).click();
    const cover = dialogOf(p, 'Обкладинка');
    await cover.waitFor();
    await cover.getByRole('button', { name: 'Прибрати', exact: true }).click();
    const ask = dialogOf(p, `Прибрати обкладинку замовлення «${order241.name}»?`);
    await ask.waitFor();
    const asked = await confirmOf(ask);
    const files = [await shoot(p, 'confirm-cover-order')];
    await ask.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await ask.waitFor({ state: 'detached', timeout: 6000 });
    const coverOpen = await cover.isVisible();
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/projects/{order:241} → «Змінити обкладинку» → «Прибрати»', fixture: ['GET /projects/{order:241} with a cover', 'the cover picture (a fixture PNG)'], actions: ['«Скасувати»'] },
      measured: { asked, coverOpen, writes: writes.length, errors },
      pass: asked.workshop && asked.danger && same(asked.buttons, ['Скасувати', 'Прибрати обкладинку']) &&
        asked.text.includes('Завантажене зображення обкладинки буде видалено. Вкладення замовлення й файли бібліотеки лишаються.') &&
        coverOpen && writes.length === 0 && errors.length === 0,
      screenshots: files,
    };
  });

  const openGallery = async (p) => {
    await goto(p, `/products/${PR1}`);
    await p.getByRole('button', { name: 'Зображення…', exact: true }).click();
    const gallery = dialogOf(p, 'Зображення');
    await gallery.waitFor();
    return gallery;
  };

  await scenario('confirm-cover-product', ['E13-E01'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      rewrite: [GALLERY_1],
      gets: [[PRODUCT_PICTURES, PICTURE_STEP]],
      writes: [recorder(writes, /\/api\/v1\/products\//)],
    });
    const gallery = await openGallery(p);
    await gallery.getByRole('button', { name: 'Прибрати обкладинку', exact: true }).click();
    const ask = dialogOf(p, `Прибрати обкладинку виробу «${product1.name}»?`);
    await ask.waitFor();
    const asked = await confirmOf(ask);
    const files = [await shoot(p, 'confirm-cover-product')];
    await ask.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await ask.waitFor({ state: 'detached', timeout: 6000 });
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products/{product:1} → «Зображення…» → «Прибрати обкладинку»', fixture: ['GET /products/{product:1}: two pictures, the second the cover', 'pictures served as a fixture PNG'], actions: ['«Скасувати»'] },
      measured: { asked, writes: writes.length, errors },
      pass: asked.workshop && asked.danger && same(asked.buttons, ['Скасувати', 'Прибрати обкладинку']) &&
        asked.text.includes('Обкладинкою знову стане перше фото галереї, фото лишаються.') && writes.length === 0 && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('confirm-gallery-delete', ['E13-E01'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      rewrite: [GALLERY_1],
      gets: [[PRODUCT_PICTURES, PICTURE_STEP]],
      writes: [recorder(writes, /\/api\/v1\/products\//)],
    });
    const gallery = await openGallery(p);
    await gallery.getByRole('button', { name: 'Видалити зображення: back.png', exact: true }).click();
    const ask = dialogOf(p, 'Видалити фото «back.png»?');
    await ask.waitFor();
    const asked = await confirmOf(ask);
    const files = [await shoot(p, 'confirm-gallery-delete')];
    await ask.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await ask.waitFor({ state: 'detached', timeout: 6000 });
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products/{product:1} → «Зображення…» → delete «back.png»', fixture: ['GET /products/{product:1}: two pictures', 'pictures served as a fixture PNG'], actions: ['«Скасувати»'] },
      measured: { asked, writes: writes.length, errors },
      pass: asked.workshop && asked.danger && same(asked.buttons, ['Скасувати', 'Видалити']) &&
        asked.text.includes(`Фото буде видалено з виробу «${product1.name}». Інші фото лишаються`) && writes.length === 0 && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('confirm-order-surfaces', ['E13-E02'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      rewrite: [ATTACHED_244],
      writes: [recorder(writes, /\/api\/v1\/(projects|archives)\//)],
    });
    const out = {};
    const files = [];
    const lineName = linesOf(order244)[0]?.product_name ?? '';
    const menus = () => p.getByRole('button', { name: `Дії позиції: ${lineName}`, exact: true });
    await goto(p, `/projects/${O244}`);
    // (a) Deleting a line.
    await menus().first().click();
    await p.getByRole('menuitem', { name: 'Видалити позицію' }).click();
    let ask = dialogOf(p, `Видалити позицію «${lineName}»?`);
    await ask.waitFor();
    out.line = await confirmOf(ask);
    files.push(await shoot(p, 'confirm-line-delete'));
    await ask.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await ask.waitFor({ state: 'detached', timeout: 6000 });
    // (b) Discarding a parts line's unsaved edits — the third line is made of parts.
    await menus().nth(2).click();
    await p.getByRole('menuitem', { name: 'Редагувати позицію…' }).click();
    const edit = dialogOf(p, 'Редагувати позицію');
    await edit.waitFor();
    await edit.getByLabel('Нотатка').fill('E13 — не зберігати');
    await edit.getByRole('button', { name: 'Змінити кількості деталей…' }).click();
    ask = dialogOf(p, 'Відкинути незбережені зміни позиції?');
    await ask.waitFor();
    out.discard = await confirmOf(ask);
    files.push(await shoot(p, 'confirm-line-discard'));
    await ask.getByRole('button', { name: 'Лишитися', exact: true }).click();
    await ask.waitFor({ state: 'detached', timeout: 6000 });
    out.kept = await edit.getByLabel('Нотатка').inputValue();
    await edit.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await edit.waitFor({ state: 'detached', timeout: 6000 });
    // (c) Taking a print out of the order.
    await goto(p, `/projects/${O244}?section=prints`);
    await p.getByRole('button', { name: 'Дії з друком' }).first().click();
    await p.getByRole('menuitem', { name: 'Прибрати із замовлення' }).click();
    ask = p.getByRole('dialog').filter({ hasText: 'із замовлення?' });
    await ask.waitFor();
    out.print = await confirmOf(ask);
    files.push(await shoot(p, 'confirm-print-remove'));
    await ask.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await ask.waitFor({ state: 'detached', timeout: 6000 });
    // (d) Deleting an attachment.
    await goto(p, `/projects/${O244}?section=files`);
    await p.getByRole('button', { name: 'Видалити вкладення «Пакування.png»' }).click();
    ask = dialogOf(p, 'Видалити вкладення «Пакування.png»?');
    await ask.waitFor();
    out.attachment = await confirmOf(ask);
    files.push(await shoot(p, 'confirm-attachment-delete'));
    await ask.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await ask.waitFor({ state: 'detached', timeout: 6000 });
    await ctx.close();
    const ok = (c, buttons, sentence) => c.workshop && c.danger && same(c.buttons, buttons) && c.text.includes(sentence);
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: '/projects/{order:244} (lines, ?section=prints, ?section=files)',
        fixture: ['GET /projects/{order:244} with two attachments', 'every write answered here'],
        actions: ['delete a line', 'edit the parts line’s note → «Змінити кількості деталей…»', 'remove a print', 'delete an attachment', '«Скасувати» / «Лишитися» each time'],
      },
      measured: { ...out, writes: writes.map((w) => `${w.method} ${w.path}`), errors },
      pass: ok(out.line, ['Скасувати', 'Видалити'], 'Друки цієї позиції лишаться в замовленні без прив’язки') &&
        ok(out.discard, ['Лишитися', 'Відкинути й перейти'], 'Кількості деталей змінюються в окремому діалозі') && out.kept === 'E13 — не зберігати' &&
        ok(out.print, ['Скасувати', 'Прибрати'], 'Друк лишається в архіві.') &&
        ok(out.attachment, ['Скасувати', 'Видалити'], 'Файл буде видалено із замовлення назавжди.') &&
        writes.length === 0 && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('attachments-download', ['E13-E03'], async () => {
    const { ctx, p, errors, requests } = await open(1440, {
      rewrite: [ATTACHED_244],
      gets: [[new RegExp(`/api/v1/projects/${O244}/attachments/parcel\\.png`), PICTURE_STEP]],
    });
    await goto(p, `/projects/${O244}?section=files`);
    const row = p.locator('li, tr, div').filter({ hasText: 'Пакування.png' }).filter({ has: p.getByRole('button', { name: 'Завантажити' }) }).last();
    const [download] = await Promise.all([
      p.waitForEvent('download', { timeout: 8000 }),
      row.getByRole('button', { name: 'Завантажити' }).click(),
    ]);
    const name = download.suggestedFilename();
    const fetched = requests.filter((r) => /\/attachments\/parcel\.png/.test(r));
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/projects/{order:244}?section=files', fixture: ['GET /projects/{order:244} with two attachments', 'the file served as a fixture PNG'], actions: ['«Завантажити» on «Пакування.png»'] },
      measured: { name, fetched, errors },
      // An authorised fetch: the request goes out without the token in its address, and the
      // browser saves the file under its own name.
      pass: name === 'Пакування.png' && fetched.length >= 1 && fetched.every((r) => !/token=/.test(r)) && errors.length === 0,
      screenshots: [],
    };
  });

  await scenario('gallery-order-keeps-ids', ['E13-E03'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      rewrite: [GALLERY_1],
      gets: [[PRODUCT_PICTURES, PICTURE_STEP]],
      writes: [recorder(writes, /\/attachments\/order$/, () => pictures([['b.png', 'back.png'], ['a.png', 'front.png']]))],
    });
    const gallery = await openGallery(p);
    await gallery.getByRole('button', { name: 'Нижче: front.png', exact: true }).click();
    await p.waitForTimeout(800);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products/{product:1} → «Зображення…»', fixture: ['GET /products/{product:1}: two pictures', 'PATCH attachments/order (answered here)'], actions: ['«Нижче» on «front.png»'] },
      measured: { writes, errors },
      pass: writes.length === 1 && writes[0].method === 'PATCH' && same(writes[0].body, { category: 'pictures', filenames: ['b.png', 'a.png'] }) && errors.length === 0,
      screenshots: [],
    };
  });

  await scenario('hits-cards@390', ['E13-E04'], async () => {
    const out = {};
    const files = [];
    for (const [key, path] of [['orders', '/projects'], ['products', '/products'], ['customers', '/customers']]) {
      const { ctx, p } = await open(390);
      await goto(p, path);
      const trigger = p.locator('[data-testid$="-menu"]').first();
      await trigger.waitFor({ timeout: 8000 });
      const before = await p.evaluate(() => location.pathname);
      out[key] = await hits(p, trigger);
      await trigger.click();
      await p.waitForTimeout(300);
      out[key].stayed = (await p.evaluate(() => location.pathname)) === before;
      out[key].menu = await p.getByRole('menu').count();
      files.push(await shoot(p, `hits-${key}@390`));
      await ctx.close();
    }
    // A dialog's X at the narrow width has its own target.
    const { ctx, p } = await open(390);
    await goto(p, `/projects/${O241}`);
    await p.getByRole('button', { name: 'Змінити обкладинку' }).count();
    await p.getByRole('button', { name: /^Редагувати$/ }).first().click();
    const x = p.getByRole('dialog').getByRole('button', { name: 'Закрити', exact: true }).first();
    await x.waitFor({ timeout: 6000 });
    out.dialogX = await hits(p, x);
    await ctx.close();
    return {
      env: { viewport: [390, 844] },
      recipe: { url: '/projects, /products, /customers at 390; /projects/{order:241} → «Редагувати»', actions: ['the first card’s menu', 'the dialog’s X'] },
      measured: out,
      pass: ['orders', 'products', 'customers'].every((k) => out[k].hits && out[k].stayed && out[k].menu === 1) && out.dialogX.hits,
      screenshots: files,
    };
  });

  // ---------------------------------------------------------------- F: caches
  const item1 = await read(`/stock/items/${POS1}`);
  const countOf = (requests, re) => requests.filter((r) => re.test(r)).length;
  const waitForCount = async (requests, re, n, ms = 6000) => {
    const end = Date.now() + ms;
    while (countOf(requests, re) < n && Date.now() < end) await new Promise((r) => setTimeout(r, 150));
    return countOf(requests, re);
  };

  await scenario('cache-order-delete', ['E13-F01', 'E13-F04'], async () => {
    const writes = [];
    const FARM = /^GET \/api\/v1\/projects\/filament$/;
    const { ctx, p, errors, requests } = await open(1440, {
      writes: [recorder(writes, new RegExp(`/api/v1/projects/${O251}$`))],
    });
    await goto(p, '/projects');
    await p.getByTestId(`order-${O251}-menu`).click();
    await p.getByRole('menuitem', { name: 'Видалити' }).click();
    const ask = dialogOf(p, 'Видалити замовлення?');
    await ask.waitFor();
    const before = countOf(requests, FARM);
    await ask.getByRole('button', { name: 'Видалити', exact: true }).click();
    await ask.waitFor({ state: 'detached', timeout: 6000 });
    const after = await waitForCount(requests, FARM, before + 1);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/projects → OR-0041’s menu → «Видалити»', fixture: ['DELETE /projects/{order:251} (answered here)'] },
      measured: { before, after, deleted: writes.map((w) => `${w.method} ${w.path}`), errors },
      // The farm's filament strip is read again without a reload: the order's need left it.
      pass: writes.length === 1 && writes[0].method === 'DELETE' && after > before && errors.length === 0,
      screenshots: [],
    };
  });

  await scenario('cache-stock-move', ['E13-F02', 'E13-F04'], async () => {
    const writes = [];
    const OFFERS = new RegExp(`^GET /api/v1/projects/${O244}/stock-offers$`);
    const { ctx, p, errors, requests } = await open(1440, {
      writes: [recorder(writes, /\/api\/v1\/stock\/moves/, () => item1)],
    });
    await goto(p, `/projects/${O244}`);
    await waitForCount(requests, OFFERS, 1);
    const first = countOf(requests, OFFERS);
    // In the app, not by a reload: the offers stay in the cache, fresh for a minute.
    await p.getByRole('link', { name: 'Склад' }).first().click();
    await p.waitForURL(/\/stock/, { timeout: 6000 });
    await p.getByRole('button', { name: 'Надходження' }).click();
    const d = dialogOf(p, 'Надходження');
    await d.waitFor();
    await d.getByRole('textbox', { name: 'Виріб' }).fill(product1.name.slice(0, 6));
    await d.getByRole('button', { name: `${product1.code} · ${product1.name}`, exact: true }).click();
    await d.getByTestId('stock-lookup').filter({ hasText: 'Позиція' }).waitFor({ timeout: 8000 });
    await d.getByLabel('Кількість, шт.').fill('1');
    await d.getByTestId('stock-move-submit').click();
    await d.waitFor({ state: 'detached', timeout: 6000 });
    await p.goBack();
    await p.waitForURL(new RegExp(`/projects/${O244}`), { timeout: 6000 });
    const again = await waitForCount(requests, OFFERS, first + 1);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: '/projects/{order:244} → «Склад» (in the app) → «Надходження» → Back',
        fixture: ['POST /stock/moves (answered here)'],
      },
      measured: { first, again, moved: writes.length, errors },
      // Without the stock keys' new member the order page would have taken the cached offers.
      pass: first >= 1 && writes.length === 1 && again > first && errors.length === 0,
      screenshots: [],
    };
  });

  await scenario('cache-delivery-method', ['E13-F03'], async () => ({
    pass: null,
    recipe: { url: '—' },
    measured: {
      reason: 'The stock issue dialog is the only reader of ["customer-recipient", id] and reads it again on every customer pick (G08); no screen holds the delivery methods and the recipient at once, so the browser cannot tell the invalidation from that re-read. Proven by DeliveryMethodsModal.test «a renamed method moves the stock dialog’s recipient too».',
    },
  }));

  // ---------------------------------------------------------------- G: rights and refusals
  const editOrder = async (p) => {
    await p.getByTestId('order-actions').getByRole('button', { name: 'Редагувати', exact: true }).click();
    const d = dialogOf(p, 'Редагувати замовлення');
    await d.waitFor({ timeout: 10000 });
    return d;
  };

  await scenario('rights-matrix', ['E13-G02', 'E13-B06', 'E13-C01'], async () => {
    // Who sees which door: the Workshop's writes by right, the file manager's entry by both rights.
    const LIBRARY_READS = ['library:read_all', 'library:read_own', 'library:read'];
    const SETS = {
      reader: without(...WRITES),
      create: without(...IMG.update, ...IMG.delete, 'orders:file_prints'),
      update: without(...IMG.create, ...IMG.delete),
      delete: without(...IMG.create, ...IMG.update, 'orders:file_prints'),
      noLibrary: without(...LIBRARY_READS),
    };
    const EXPECTED = {
      reader: { newOrder: 0, newProduct: 0, newCustomer: 0, receipt: 0, addLines: 0, deleteOrder: 0, fileEntry: 0 },
      create: { newOrder: 1, newProduct: 1, newCustomer: 1, receipt: 0, addLines: 0, deleteOrder: 0, fileEntry: 0 },
      update: { newOrder: 0, newProduct: 0, newCustomer: 0, receipt: 1, addLines: 1, deleteOrder: 0, fileEntry: 1 },
      delete: { newOrder: 0, newProduct: 0, newCustomer: 0, receipt: 0, addLines: 0, deleteOrder: 1, fileEntry: 0 },
      noLibrary: { newOrder: 1, newProduct: 1, newCustomer: 1, receipt: 1, addLines: 1, deleteOrder: 1, fileEntry: 0 },
    };
    const seen = {};
    for (const [who, permissions] of Object.entries(SETS)) {
      // Without a library read right the server lists no file: the runner answers the list
      // itself, as the server would (the stand's token is the administrator's).
      const refuse = who === 'noLibrary' ? [[/\/api\/v1\/library\/files\?/, 403]] : [];
      const { ctx, p } = await open(1440, { me: asUser(permissions), storage: FILES_GRID, rewrite: [TAGGED, PLATES], fail: refuse });
      const row = {};
      await goto(p, '/projects');
      row.newOrder = await p.getByRole('button', { name: 'Нове замовлення', exact: true }).count();
      const menu = p.getByTestId(`order-${O244}-menu`);
      if (await menu.count()) {
        await menu.click();
        await p.getByRole('menuitem').first().waitFor({ timeout: 4000 }).catch(() => {});
        row.deleteOrder = await p.getByRole('menuitem', { name: 'Видалити' }).count();
        await p.keyboard.press('Escape');
      } else {
        row.deleteOrder = 0;
      }
      await goto(p, '/products');
      row.newProduct = await p.getByRole('button', { name: 'Новий виріб', exact: true }).count();
      await goto(p, '/customers');
      row.newCustomer = await p.getByRole('button', { name: 'Новий замовник', exact: true }).count();
      await goto(p, '/stock');
      row.receipt = await p.getByRole('button', { name: 'Надходження', exact: true }).count();
      await goto(p, `/projects/${O244}`);
      row.addLines = await p.getByRole('button', { name: 'Додати в замовлення', exact: true }).count();
      await goto(p, filesOf88);
      if (await fileCard(p).count()) {
        await openFileMenu(p);
        await p.waitForTimeout(300);
        row.fileEntry = await p.getByRole('button', { name: 'Додати в замовлення…', exact: true }).count();
      } else {
        row.fileEntry = 0;
      }
      seen[who] = row;
      await ctx.close();
    }
    const mismatches = Object.entries(EXPECTED).flatMap(([who, want]) =>
      Object.entries(want).filter(([door, n]) => (seen[who]?.[door] ?? -1) !== n).map(([door]) => `${who}.${door}`));
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: '/projects, /products, /customers, /stock, /projects/{order:244}, /files',
        fixture: ['/auth/me: the Administrators’ permissions without the named ones', TAGGED_NOTE, PLATES_NOTE, 'without a library read right: GET /library/files → 403, as the server answers'],
      },
      measured: { seen, expected: EXPECTED, mismatches },
      pass: mismatches.length === 0,
      screenshots: [],
    };
  });

  await scenario('customer-create-gate', ['E13-G01'], async () => {
    const out = {};
    for (const [who, permissions] of [['editor', without(...IMG.create)], ['creator', adminPerms]]) {
      const { ctx, p } = await open(1440, { me: asUser(permissions) });
      await goto(p, `/projects/${O244}`);
      const d = await editOrder(p);
      const customer = d.getByLabel('Замовник', { exact: true });
      await p.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] select')].some((s) => s.options.length > 2), null, { timeout: 8000 });
      out[who] = (await optionsOf(customer)).includes('Новий замовник…');
      if (who === 'editor') out.files = [await shoot(p, 'customer-create-gate-editor')];
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/projects/{order:244} → «Редагувати»', fixture: ['/auth/me without orders:create / products:create / customers:create', '/auth/me with them'] },
      measured: { editor: out.editor, creator: out.creator },
      pass: out.editor === false && out.creator === true,
      screenshots: out.files ?? [],
    };
  });

  await scenario('errors-sample', ['E13-G04', 'E13-G03'], async () => {
    // One writer dialog of each section; each answer is the boundary's sentence in the system
    // language, and every status the spec names appears: 403, 404, 409, 422.
    const SAYS = {
      order: { status: 403, detail: 'Немає потрібних дозволів: orders:update' },
      product: { status: 409, detail: 'Інший виріб уже має цей артикул' },
      customer: { status: 404, detail: 'Клієнта не знайдено' },
      stock: { status: 422, detail: 'Вкажіть позицію складу або виріб' },
      archives: { status: 403, detail: UK.ownArchives },
      library: { status: 403, detail: 'Немає потрібних дозволів: products:update' },
    };
    const out = {};
    const files = [];
    const refusalOf = async (key, p, d, press) => {
      await press();
      trail.push(`${key}: pressed`);
      const alert = d.getByRole('alert');
      await alert.waitFor({ timeout: 8000 });
      const first = { text: await textOf(alert), open: await d.isVisible() };
      files.push(await shoot(p, `errors-${key}`));
      trail.push(`${key}: refused`);
      // The refusal frees the button: a second press sends again.
      await press();
      await p.waitForTimeout(700);
      return first;
    };
    const trail = [];
    const answering = (key, store) => () => ({ __status: SAYS[key].status, json: { detail: SAYS[key].detail } });
    try {
    // Orders.
    trail.push('order');
    {
      const writes = [];
      const { ctx, p } = await open(1440, { writes: [recorder(writes, ORDER(O244), answering('order'))] });
      await goto(p, `/projects/${O244}`);
      const d = await editOrder(p);
      await d.getByLabel('Назва').fill(`${order244.name} E13`);
      out.order = { ...(await refusalOf('order', p, d, () => d.locator('[data-workshop-dialog-footer]').getByRole('button', { name: 'Зберегти', exact: true }).click())), sent: writes.length, kept: await d.getByLabel('Назва').inputValue() };
      await ctx.close();
    }
    // Products.
    trail.push('product');
    {
      const writes = [];
      const { ctx, p } = await open(1440, { writes: [recorder(writes, new RegExp(`/api/v1/products/${PR1}$`), answering('product'))] });
      await goto(p, `/products/${PR1}`);
      await p.getByRole('button', { name: /^Редагувати$/ }).click();
      const d = dialogOf(p, 'Редагувати виріб');
      await d.waitFor();
      await d.getByLabel('Назва', { exact: true }).fill(`${product1.name} E13`);
      out.product = { ...(await refusalOf('product', p, d, () => d.getByRole('button', { name: /^Зберегти виріб$/ }).click())), sent: writes.length, kept: await d.getByLabel('Назва', { exact: true }).inputValue() };
      await ctx.close();
    }
    // Customers.
    trail.push('customer');
    {
      const writes = [];
      const { ctx, p } = await open(1440, { writes: [recorder(writes, new RegExp(`/api/v1/customers/${CU1}$`), answering('customer'))] });
      await goto(p, `/customers/${CU1}`);
      await p.getByTestId('customer-header').getByRole('button', { name: 'Редагувати' }).click();
      const d = dialogOf(p, 'Редагувати замовника');
      await d.waitFor();
      const name = d.getByLabel('Назва', { exact: true });
      await name.fill(`${await name.inputValue()} E13`);
      out.customer = { ...(await refusalOf('customer', p, d, () => d.getByRole('button', { name: 'Зберегти замовника' }).click())), sent: writes.length, kept: await name.inputValue() };
      await ctx.close();
    }
    // Stock.
    trail.push('stock');
    {
      const writes = [];
      const { ctx, p } = await open(1440, { writes: [recorder(writes, /\/api\/v1\/stock\/moves/, answering('stock'))] });
      await goto(p, '/stock');
      await p.getByRole('button', { name: 'Надходження' }).click();
      const d = dialogOf(p, 'Надходження');
      await d.waitFor();
      await d.getByRole('textbox', { name: 'Виріб' }).fill(product1.name.slice(0, 6));
      await d.getByRole('button', { name: `${product1.code} · ${product1.name}`, exact: true }).click();
      await d.getByTestId('stock-lookup').filter({ hasText: 'Позиція' }).waitFor({ timeout: 8000 });
      await d.getByLabel('Кількість, шт.').fill('2');
      out.stock = { ...(await refusalOf('stock', p, d, () => d.getByTestId('stock-move-submit').click())), sent: writes.length, kept: await d.getByLabel('Кількість, шт.').inputValue() };
      await ctx.close();
    }
    // Archives → order.
    trail.push('archives');
    {
      const writes = [];
      const { ctx, p } = await open(1440, { storage: GRID, rewrite: [FIRST_IN_ACTIVE], writes: [recorder(writes, /\/add-archives$/, answering('archives'))] });
      await goto(p, '/archives');
      const id = await firstArchiveId(p);
      const menu = await openArchiveMenu(p, id);
      await menu.getByRole('button', { name: 'Додати до замовлення', exact: true }).click();
      const d = dialogOf(p, 'Додати до замовлення');
      await d.waitFor();
      out.archives = { ...(await refusalOf('archives', p, d, () => d.getByRole('button', { name: 'Прив\'язати', exact: true }).click())), sent: writes.length };
      await ctx.close();
    }
    // The library's links to products.
    trail.push('library');
    {
      const writes = [];
      const { ctx, p } = await open(1440, { storage: FILES_GRID, rewrite: [TAGGED, PLATES], writes: [recorder(writes, /\/api\/v1\/library\/files\/\d+$/, answering('library'))] });
      await goto(p, `/files?folder=${linkedFile.folder_id}`);
      await p.locator('[title^="Прив\'язано до"]').first().click();
      const d = dialogOf(p, 'Прив\'язати файл');
      await d.waitFor();
      out.library = { ...(await refusalOf('library', p, d, () => d.getByRole('button', { name: 'Зберегти', exact: true }).click())), sent: writes.length };
      await ctx.close();
    }
    } catch (e) {
      return { pass: false, error: safeError(e, 'errors-sample'), measured: { trail, ...out } };
    }
    const failing = Object.entries(SAYS).filter(([key, say]) => !(out[key] && out[key].text === say.detail && out[key].open && out[key].sent === 2)).map(([key]) => key);
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: 'the order, product and customer editors; a stock receipt; archives → order; links to products',
        fixture: ['each write answered with the boundary’s sentence: 403 / 409 / 404 / 422 / 403 / 403', TAGGED_NOTE, PLATES_NOTE],
      },
      measured: { ...out, failing },
      pass: failing.length === 0 && out.order.kept.endsWith(' E13') && out.product.kept.endsWith(' E13') && out.customer.kept.endsWith(' E13') && out.stock.kept === '2',
      screenshots: files,
    };
  });

  // ---------------------------------------------------------------- O19: roles by their own rights
  // Each role is named by its rights, never «the administrator minus one»; reads go to the stand
  // with its token, so what is measured is what the UI OFFERS and ASKS — a role's page that asks
  // another domain is recorded as `foreign` (the server would answer it 403).
  const foreignOf = (requests, domains) => requests.filter((r) => {
    const m = /^GET \/api\/v1\/(projects|products|customers|stock)(\/[^?]*)?(\?.*)?$/.exec(r);
    if (!m) return false;
    if (m[1] === 'customers' && /^\/options\/?$/.test(m[2] ?? '')) return !domains.includes('orders') && !domains.includes('customers');
    if (m[1] === 'stock' && /^\/catalog\/?$/.test(m[2] ?? '')) return !domains.includes('stock');
    if (m[1] === 'projects' && /^\/nav-badges\/?$/.test(m[2] ?? '')) return !['orders', 'products', 'stock'].some((d) => domains.includes(d));
    return !domains.includes(m[1] === 'projects' ? 'orders' : m[1]);
  });

  await scenario('storekeeper', ['E13-O19', 'E13-O06', 'E13-R12'], async () => {
    // Moves goods, does not correct them, never reads the catalog: «Надходження» from the
    // header, «Зібрати» from the free parts' row; no stocktake, location, minimum or «Коригувати».
    const writes = [];
    const { ctx, p, errors, requests } = await open(1440, {
      me: asUser(ROLE.storekeeper),
      writes: [recorder(writes, /\/api\/v1\/stock\/moves/, () => item1)],
    });
    await goto(p, '/stock');
    await p.getByRole('button', { name: 'Надходження' }).click();
    const d = dialogOf(p, 'Надходження');
    await d.waitFor();
    await d.getByRole('textbox', { name: 'Виріб' }).fill(product1.name.slice(0, 6));
    await d.getByRole('button', { name: `${product1.code} · ${product1.name}`, exact: true }).click();
    await d.getByTestId('stock-lookup').filter({ hasText: 'Позиція' }).waitFor({ timeout: 8000 });
    await d.getByLabel('Кількість, шт.').fill('1');
    await d.getByTestId('stock-move-submit').click();
    await d.waitFor({ state: 'detached', timeout: 6000 });
    const rowMenu = p.locator('[data-testid^="finished-"][data-testid$="-menu"]').first();
    await rowMenu.click();
    const menu = await p.locator('[data-testid^="finished-"][data-testid$="-menu-panel"]').getByRole('menuitem').evaluateAll((ms) => ms.map((m) => m.textContent.trim()));
    await p.keyboard.press('Escape');
    await goto(p, '/stock?tab=parts');
    const firstRow = p.locator('[data-testid^="stock-row-"]').first();
    await firstRow.waitFor({ timeout: 8000 });
    const adjust = await p.getByRole('button', { name: 'Коригувати', exact: true }).count();
    await firstRow.getByRole('button', { name: 'Зібрати' }).click();
    const asm = dialogOf(p, 'Зібрати готові вироби з деталей');
    await asm.waitFor({ timeout: 6000 });
    const files = [await shoot(p, 'storekeeper-assemble')];
    await p.keyboard.press('Escape');
    await goto(p, `/stock/${POS1}`);
    await p.getByRole('heading', { level: 1 }).waitFor({ timeout: 8000 });
    const item = {
      productLinks: await p.locator('a[href^="/products/"]').count(),
      // An action without the read is not shown — not a dead phrase (T19).
      deadActions: await p.getByText(/^(Відкрити виріб|картка виробу)$/).count(),
      params: await p.getByTestId('item-actions').getByRole('button', { name: 'Комірка й мінімум' }).count(),
      menu: await p.getByTestId('item-menu').count(),
    };
    files.push(await shoot(p, 'storekeeper-position'));
    await ctx.close();
    const foreign = foreignOf(requests, ['stock']);
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: '/stock → «Надходження»; /stock?tab=parts → «Зібрати»; /stock/{position:1}',
        fixture: ['/auth/me: ' + ROLE.storekeeper.join(', ') + ' (user 9001)', 'POST /stock/moves answered here'],
      },
      measured: { sent: writes.map((w) => `${w.method} ${w.path}`), body: writes[0]?.body ?? null, menu, adjust, item, foreign: foreign.slice(0, 8), errors },
      pass: writes.length === 1 && writes[0].method === 'POST' && writes[0].body?.kind === 'receipt' && writes[0].body?.product_id === PR1 &&
        menu.includes('Надходження') && !menu.includes('Інвентаризація') && !menu.includes('Комірка й мінімум') &&
        adjust === 0 && item.productLinks === 0 && item.deadActions === 0 && item.params === 0 && item.menu === 0 && foreign.length === 0 && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('orders-reader-customer-filter', ['E13-O19', 'E13-R12'], async () => {
    // `orders:read` alone filters its orders by customer from the option list, never the directory.
    const target = (list(await read('/customers/options')))[0] ?? { id: CU1, name: '' };
    const { ctx, p, errors, requests } = await open(1440, { me: asUser(ROLE.ordersReader) });
    await goto(p, '/projects?tab=all');
    const filter = p.locator('select').filter({ has: p.locator('option', { hasText: 'Усі замовники' }) }).first();
    await filter.waitFor({ timeout: 8000 });
    const options = await optionsOf(filter);
    await filter.selectOption(String(target.id));
    await p.waitForURL(new RegExp(`customer=${target.id}`), { timeout: 6000 });
    await p.waitForTimeout(800);
    const asked = requests.filter((r) => /^GET \/api\/v1\/projects\/?\?/.test(r) && new RegExp(`[?&]customer_id=${target.id}(&|$)`).test(r)).length;
    const file = await shoot(p, 'orders-reader-customer-filter');
    await ctx.close();
    const foreign = foreignOf(requests, ['orders']);
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/projects?tab=all → the customer filter → the first option', fixture: ['/auth/me: ' + ROLE.ordersReader.join(', ') + ' (user 9001)'] },
      measured: { options: options.slice(0, 6), target: target.id, asked, optionsRead: requests.filter((r) => /\/customers\/options/.test(r)).length, foreign: foreign.slice(0, 8), errors },
      pass: options[0] === 'Усі замовники' && options.includes(target.name) && asked >= 1 &&
        requests.some((r) => /^GET \/api\/v1\/customers\/options/.test(r)) && foreign.length === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('dispatch-note-readers', ['E13-O19', 'E13-O25'], async () => {
    // An order's reader sees its notes as minimal rows that say why they do not open, and a
    // note opened by its address explains itself and goes back, never into the stock; a
    // customer's reader opens the note — and the note offers no way into the stock or the order.
    const note = await read(`/stock-issues/${N1}`);
    const SENSITIVE = ['recipient_name', 'recipient_phone', 'delivery_method', 'delivery_details', 'note'];
    const RESTRICTED = 'Щоб відкрити накладну, потрібне право читати замовників або переміщувати склад — у ній контакти одержувача.';
    const out = {};
    const files = [];
    if (note.project_id != null) {
      const { ctx, p, errors } = await open(1440, {
        me: asUser(ROLE.ordersReader),
        // What the server answers an order's reader (O25): the rows without the recipient.
        rewrite: [[/\/api\/v1\/stock-issues\/?\?/, (json) => ({ ...json, items: list(json.items).map((r) => ({ ...r, ...Object.fromEntries(SENSITIVE.map((k) => [k, null])), restricted: true })) })]],
        gets: [[new RegExp(`/api/v1/stock-issues/${N1}/?(\\?.*)?$`), () => ({ status: 403, json: { detail: { error: 'dispatch_note_restricted', message: RESTRICTED } } })]],
      });
      await goto(p, `/projects/${note.project_id}?section=issues`);
      const row = p.getByTestId(`note-${N1}`);
      await row.waitFor({ timeout: 8000 });
      const code = row.getByText(note.code, { exact: true }).first();
      out.order = {
        codeIsLink: await code.evaluate((el) => el.tagName === 'A'),
        title: await code.getAttribute('title'),
        open: await row.getByRole('link', { name: /Відкрити/ }).count(),
      };
      files.push(await shoot(p, 'dispatch-note-orders-reader-row'));
      await p.goto(`${job.ui}/stock/dispatch-notes/${N1}`, { waitUntil: 'networkidle' });
      await p.getByText(RESTRICTED).first().waitFor({ timeout: 8000 });
      out.direct = {
        back: await p.getByRole('button', { name: 'Назад', exact: true }).count(),
        intoStock: await p.locator('a[href^="/stock"]').count(),
      };
      files.push(await shoot(p, 'dispatch-note-orders-reader-direct'));
      out.errors = errors;
      await ctx.close();
    }
    if (note.customer_id != null) {
      const { ctx, p, errors, requests } = await open(1440, { me: asUser(ROLE.customersReader) });
      await goto(p, `/customers/${note.customer_id}`);
      const link = p.getByTestId(`note-${N1}`).getByRole('link', { name: note.code, exact: true });
      await link.waitFor({ timeout: 8000 });
      await link.click();
      await p.getByTestId('dispatch-note-sheet').waitFor({ timeout: 8000 });
      out.customer = {
        intoStock: await p.locator('a[href^="/stock"]').count(),
        intoOrder: await p.locator('a[href^="/projects/"]').count(),
        customerLink: await p.locator(`a[href="/customers/${note.customer_id}"]`).count(),
        foreign: foreignOf(requests, ['customers']).slice(0, 8),
        errors,
      };
      files.push(await shoot(p, 'dispatch-note-customers-reader'));
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: `/projects/{order of note 90000}?section=issues → /stock/dispatch-notes/{note:90000}; /customers/{its customer} → the note`,
        fixture: [
          '/auth/me orders reader: ' + ROLE.ordersReader.join(', '),
          '/auth/me customers reader: ' + ROLE.customersReader.join(', '),
          'GET /stock-issues/ for the orders reader: the server’s restricted rows',
          'GET /stock-issues/{note} for the orders reader: 403 dispatch_note_restricted',
        ],
      },
      measured: { note: note.code, ...out },
      pass: (note.project_id == null || (out.order.codeIsLink === false && out.order.title === RESTRICTED && out.order.open === 0 &&
        out.direct.back === 1 && out.direct.intoStock === 0 && out.errors.length === 0)) &&
        (note.customer_id == null || (out.customer.intoStock === 0 && out.customer.intoOrder === 0 && out.customer.customerLink >= 1 &&
        out.customer.foreign.length === 0 && out.customer.errors.length === 0)) &&
        (note.project_id != null || note.customer_id != null),
      screenshots: files,
    };
  });

  await scenario('catalog-editor', ['E13-O19'], async () => {
    // Edits the catalog and reads nothing else of the Workshop — no contacts, no orders, no
    // stock: its pages ask no other domain and offer no way into one.
    // What the server answers this role (products.py `_masked`): the stock's and the orders'
    // figures null — the stand's token is the administrator's, so the runner masks them.
    const MASKED = ['kits_available', 'finished_available', 'finished_positions', 'finished_below_min', 'lines_count', 'active_orders_count', 'orders_count', 'units_printed_total'];
    const mask = (row) => (row && typeof row === 'object' ? { ...row, ...Object.fromEntries(MASKED.filter((k) => k in row).map((k) => [k, null])) } : row);
    const { ctx, p, errors, requests } = await open(1440, {
      me: asUser(ROLE.catalogEditor),
      rewrite: [
        [/\/api\/v1\/products\/?\?/, (json) => ({ ...json, items: list(json.items).map(mask) })],
        [new RegExp(`/api/v1/products/${PR1}/?(\\?.*)?$`), mask],
      ],
    });
    const seen = {};
    for (const path of ['/products', `/products/${PR1}?tab=stock`]) {
      await goto(p, path);
      await p.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 8000 });
      seen[path] = {
        intoOthers: await p.locator('main a[href^="/projects"], main a[href^="/customers"], main a[href^="/stock"]').count(),
        tabs: await p.getByRole('tab').evaluateAll((ts) => ts.map((t) => t.textContent.replace(/\s+/g, ' ').trim())),
      };
    }
    const file = await shoot(p, 'catalog-editor-product');
    await ctx.close();
    const foreign = foreignOf(requests, ['products']);
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: '/products, /products/{product:1}?tab=stock',
        fixture: ['/auth/me: ' + ROLE.catalogEditor.join(', ') + ' (user 9001)', 'GET /products/ and /products/{id}: the stock’s and the orders’ figures null, as the server masks them for this role'],
      },
      measured: { seen, foreign: foreign.slice(0, 8), errors },
      pass: Object.values(seen).every((s) => s.intoOthers === 0) && (() => {
        const tabs = seen[`/products/${PR1}?tab=stock`].tabs;
        return tabs.length > 0 && !tabs.some((t) => /^(Залишки|Замовлення)/.test(t)); // «Склад виробу» is the composition
      })() && foreign.length === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('order-manager', ['E13-O19', 'E13-O06', 'E13-O05'], async () => {
    // The O05 order manager: orders, the catalog's and the customers' reads, no stock. The order
    // page offers it no issue, no bank, no «take from stock»; a line it adds takes nothing from
    // the shelf; it asks no shelf figure (final review #1).
    const writes = [];
    const { ctx, p, errors, requests } = await open(1440, {
      me: asUser(ROLE.orderManager),
      writes: [recorder(writes, new RegExp(`/api/v1/projects/${O244}/lines/batch$`), () => ({ order: order244, results: [{ line_id: 0, asked_finished: 0, got_finished: 0, asked_kits: 0, got_kits: 0 }] }))],
    });
    await goto(p, `/projects/${O244}`);
    await p.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 8000 });
    await p.waitForTimeout(800);
    const page = {
      issue: await p.getByTestId('order-fulfilment').count(),
      bank: await p.getByTestId('order-bank-surplus').count(),
      take: await p.getByTestId('take-stock').count(),
    };
    await p.getByRole('button', { name: 'Додати в замовлення', exact: true }).click();
    const row = p.getByTestId(`add-product-${PR1}`);
    await row.waitFor({ timeout: 8000 });
    await row.getByRole('checkbox').click();
    await p.getByRole('button', { name: 'Додати позиції (1)', exact: true }).click();
    await p.waitForTimeout(1200);
    const file = await shoot(p, 'order-manager-order');
    await ctx.close();
    const shelfReads = requests.filter((r) => /\/stock-offers|\/stock\/suggest|\/products\/\d+\/stock\b|\/stock\/items/.test(r));
    const foreign = foreignOf(requests, ['orders', 'products', 'customers']);
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: `/projects/{order:244} → «Додати в замовлення» → product 1 → «Додати позиції (1)»`,
        fixture: ['/auth/me: ' + ROLE.orderManager.join(', ') + ' (user 9001)', 'POST lines/batch answered here'],
      },
      measured: { page, sent: writes.map((w) => ({ method: w.method, path: w.path, body: w.body })), shelfReads: shelfReads.slice(0, 6), foreign: foreign.slice(0, 6), errors },
      pass: page.issue === 0 && page.bank === 0 && page.take === 0 && writes.length === 1 &&
        same(writes[0].body?.lines?.[0]?.stock, { from_finished: 0, from_kits: 0 }) &&
        shelfReads.length === 0 && foreign.length === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  // O19 / R11 — the plate operator without the orders' rights. The stand has no MQTT: the card's
  // state, the plate gate and the print waiting on it are fixtures, and every write is answered
  // here as the server answers it — the server's refusal, the unfiled repeat and the duplicate
  // are proven by test_plate_repeat_filing.py.
  const plateP = list(await read('/printers/')).find((x) => x.is_active && !x.archived) ?? null;
  const asIdle = (s) => ({ ...s, connected: true, state: 'IDLE' });
  const atGate = (s) => ({ ...s, connected: true, state: 'FINISH', awaiting_plate_clear: true, repeat_available: true });
  // `gate.open` — the plate gate as the server holds it: an accepted answer releases it.
  const plateRewrites = (pid, gate) => [
    [/\/api\/v1\/printers\/?(\?.*)?$/, (b) => list(b).map((x) => (x.id === pid ? { ...x, require_plate_clear: true } : x))],
    [/\/api\/v1\/printers\/(\d+\/status|status\/batch)\/?(\?.*)?$/, (b, url) => {
      const ours = (st) => (gate.open ? atGate(st) : asIdle(st));
      if (/status\/batch/.test(url)) return Object.fromEntries(Object.entries(b ?? {}).map(([k, st]) => [k, Number(k) === pid ? ours(st) : asIdle(st)]));
      return new RegExp(`/printers/${pid}/status`).test(url) ? ours(b) : asIdle(b);
    }],
    // No queue behind the gate: the card draws its own pair, not the queue widget's.
    [/\/api\/v1\/queue\/?\?/, () => []],
  ];
  // The run on the plate, filed under an OPEN order (OR-0031): a repeat would be new work under it.
  const WAITING = {
    archive_id: A595, print_name: archive595?.print_name ?? 'E13', status: 'completed', quantity: 1, defective_count: 0,
    gate_token: 'e13-gate', parts: [], repeat_order_code: order241?.code ?? 'OR-0031', repeat_order_open: true,
  };
  const PLATE_REPEAT = (pid) => new RegExp(`/api/v1/printers/${pid}/repeat-print$`);
  const PLATE_CLEAR = (pid) => new RegExp(`/api/v1/printers/${pid}/clear-plate$`);

  await scenario('plate-operator', ['E13-O19', 'E13-R11'], async () => {
    if (!plateP) return { pass: false, measured: { reason: 'the stand has no active printer' } };
    // Where a wait ran out, and what the card had asked by then (a failure names its step).
    const trail = [];
    let asked = [];
    try {
      const files = [];
      const waitingRead = new RegExp(`/api/v1/printers/${plateP.id}/waiting-print`);
      // 1 · The run is read: the card offers only «Повторити без замовлення»; a double press sends
      //     ONE answer, with the run's receipt key and `without_order`, and the pair goes.
      const sent = [];
      const cleared = [];
      const gate = { open: true };
      const one = await open(1440, {
        me: asUser(ROLE.plateOperator),
        rewrite: plateRewrites(plateP.id, gate),
        gets: [[waitingRead, () => ({ json: WAITING })]],
        writes: [
          recorder(sent, PLATE_REPEAT(plateP.id), () => { gate.open = false; return { success: true, item_id: 99020, ledger_refused_parts: 0 }; }),
          recorder(cleared, PLATE_CLEAR(plateP.id), () => ({ success: true, ledger_refused_parts: 0 })),
        ],
      });
      asked = one.requests;
      await goto(one.p, '/');
      trail.push('1: page');
      const unfiled = one.p.getByRole('button', { name: 'Повторити без замовлення', exact: true });
      await unfiled.waitFor({ timeout: 20000 });
      trail.push('1: pair');
      await one.p.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Повторити без замовлення' && !b.disabled), null, { timeout: 8000 });
      const offered = {
        withoutOrder: await unfiled.count(),
        filed: await one.p.getByRole('button', { name: 'Повторити друк', exact: true }).count(),
        title: await unfiled.first().getAttribute('title'),
      };
      trail.push('1: enabled');
      files.push(await shoot(one.p, 'plate-operator-card'));
      await unfiled.first().dblclick();
      await one.p.waitForTimeout(1500);
      const after = {
        pair: await one.p.getByRole('button', { name: 'Повторити без замовлення', exact: true }).count(),
        toast: await one.p.getByText('Друкуємо ще раз', { exact: true }).count(),
      };
      files.push(await shoot(one.p, 'plate-operator-repeated'));
      const firstForeign = foreignOf(one.requests, []);
      const firstErrors = one.errors;
      await one.ctx.close();

      // 2 · The run could not be read: the card cannot tell the row is filed and offers the plain
      //     repeat; the server refuses new work under the order — said on the card, nothing else sent.
      const refusedSent = [];
      const two = await open(1440, {
        me: asUser(ROLE.plateOperator),
        rewrite: plateRewrites(plateP.id, { open: true }),
        gets: [[waitingRead, () => ({ fail: 500 })]],
        writes: [recorder(refusedSent, PLATE_REPEAT(plateP.id), () => ({ __status: 403, json: { detail: { error: 'filing_forbidden', message: UK.filingForbidden } } }))],
      });
      asked = two.requests;
      await goto(two.p, '/');
      trail.push('2: page');
      const plain = two.p.getByRole('button', { name: 'Повторити друк', exact: true });
      await plain.waitFor({ timeout: 20000 });
      trail.push('2: pair');
      await two.p.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Повторити друк' && !b.disabled), null, { timeout: 8000 });
      await plain.first().click();
      await two.p.getByText(UK.filingForbidden, { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => {});
      // The toast slides in: the frame waits for it to settle.
      await two.p.waitForTimeout(800);
      const refused = {
        toast: await two.p.getByText(UK.filingForbidden, { exact: true }).count(),
        pairStays: await two.p.getByRole('button', { name: 'Повторити друк', exact: true }).count(),
      };
      files.push(await shoot(two.p, 'plate-operator-refused'));
      const secondForeign = foreignOf(two.requests, []);
      const secondErrors = two.errors;
      await two.ctx.close();

      const body = sent[0]?.body ?? {};
      return {
        env: { viewport: [1440, 900] },
        recipe: {
          url: '/ (printers) → the gated card → «Повторити без замовлення» ×2; then the card whose run was not read → «Повторити друк»',
          fixture: [
            '/auth/me: ' + ROLE.plateOperator.join(', ') + ' (user 9001)',
            `GET /printers/ → printer ${plateP.id} require_plate_clear; its status FINISH + awaiting_plate_clear; queue empty (the stand has no MQTT)`,
            `GET /printers/${plateP.id}/waiting-print → archive ${A595} filed under ${WAITING.repeat_order_code} (open), gate e13-gate; then 500`,
            'POST repeat-print answered here: 200 with one row; then 403 filing_forbidden in the boundary\'s words',
            'server proof: test_plate_repeat_filing.py (refusal, without_order, duplicate → one receipt)',
          ],
        },
        measured: {
          offered, after,
          sent: sent.map((w) => ({ method: w.method, path: w.path, body: w.body })),
          cleared: cleared.length,
          refused, refusedSent: refusedSent.map((w) => ({ method: w.method, path: w.path, body: w.body })),
          foreign: [...firstForeign, ...secondForeign].slice(0, 6), errors: [...firstErrors, ...secondErrors],
        },
        pass: offered.withoutOrder === 1 && offered.filed === 0 && offered.title === 'Повторити без замовлення' &&
          sent.length === 1 && sent[0].method === 'POST' &&
          body.without_order === true && body.expected_archive_id === A595 && body.expected_gate_token === 'e13-gate' &&
          cleared.length === 0 && after.pair === 0 && after.toast === 1 &&
          refusedSent.length === 1 && refusedSent[0].body?.without_order === undefined &&
          refusedSent[0].body?.expected_archive_id === undefined && refused.toast >= 1 && refused.pairStays === 1 &&
          firstForeign.length === 0 && secondForeign.length === 0 && firstErrors.length === 0 && secondErrors.length === 0,
        screenshots: files,
      };

    } catch (e) {
      return { pass: false, error: safeError(e, 'plate-operator'), measured: { trail, asked: asked.filter((r) => /printers|queue/.test(r)).slice(-8) } };
    }
  });

  await scenario('order-clerk-new-customer', ['E13-O19', 'E13-R12'], async () => {
    // orders:read + orders:create + customers:create, no customers:read: a new order for a new
    // customer with a contact and its delivery method — from the orders list to the saved order,
    // reading no directory. The server half: test_workshop_rights_customers.py.
    const methods = list(await read('/delivery-methods/'));
    const method = methods[0] ?? { id: 99030, name: 'E13 Курʼєр', position: 0, contacts_count: 0 };
    const MADE = { id: 99001, code: 'CU-99001', name: 'E13 Клерк' };
    const CONTACT = { id: 99002, code: 'CT-99002', name: 'Богдан', role: null };
    let made = false;
    const writes = [];
    const files = [];
    const { ctx, p, errors, requests } = await open(1440, {
      me: asUser(ROLE.orderClerk),
      gets: [
        // The server's lists once the customer exists: in the options, with its one contact.
        [/\/api\/v1\/customers\/options\/?(\?.*)?$/, () => (made ? { rewrite: (b) => [...list(b), { ...MADE }] } : null)],
        [new RegExp(`/api/v1/customers/${MADE.id}/contact-options`), () => ({ json: made ? [CONTACT] : [] })],
        ...(methods.length ? [] : [[/\/api\/v1\/delivery-methods\/?(\?.*)?$/, () => ({ json: [method] })]]),
      ],
      writes: [
        recorder(writes, /\/api\/v1\/customers\/?(\?.*)?$/, (entry) => {
          made = true;
          const c = entry.body?.contacts?.[0] ?? {};
          return {
            ...MADE, kind: entry.body?.kind ?? 'company', notes: null, created_at: '', updated_at: '', figures: {},
            contacts: [{ ...CONTACT, phone: c.phone ?? null, email: null, city: null, delivery_method_id: c.delivery_method_id ?? null, delivery_method_name: method.name, delivery_details: c.delivery_details ?? null, note: null, orders_count: 0 }],
          };
        }),
        recorder(writes, /\/api\/v1\/projects\/?(\?.*)?$/, () => order244),
      ],
    });
    await goto(p, '/projects');
    await p.getByRole('button', { name: 'Нове замовлення', exact: true }).first().click();
    const d = dialogOf(p, 'Нове замовлення');
    await d.waitFor({ timeout: 8000 });
    // The order is named first: saving the customer must not send the order under it.
    await d.getByLabel('Назва', { exact: true }).fill('E13 Замовлення клерка');
    await p.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] select option')].some((o) => o.value === '__new__'), null, { timeout: 8000 });
    await d.getByLabel('Замовник', { exact: true }).selectOption('__new__');
    await d.getByPlaceholder("Ім'я замовника", { exact: true }).fill(MADE.name);
    await d.getByRole('button', { name: 'Додати контакт і доставку…', exact: true }).click();
    const c = dialogOf(p, 'Новий замовник');
    await c.waitFor({ timeout: 8000 });
    const prefilled = await c.getByLabel('Назва', { exact: true }).inputValue();
    await c.getByLabel('Ім’я контакта', { exact: true }).fill(CONTACT.name);
    await c.getByLabel('Телефон', { exact: true }).fill('+380501234567');
    await p.waitForFunction((name) => [...document.querySelectorAll('[role="dialog"] select option')].some((o) => o.textContent.trim() === name), method.name, { timeout: 8000 });
    await c.getByLabel('Спосіб доставки', { exact: true }).selectOption({ label: method.name });
    await c.getByLabel('Деталі доставки', { exact: true }).fill('Київ, відділення 1');
    const manage = await c.getByRole('button', { name: 'Керувати способами…', exact: true }).count();
    files.push(await shoot(p, 'order-clerk-customer-form'));
    await c.getByRole('button', { name: 'Зберегти замовника', exact: true }).click();
    await c.waitFor({ state: 'detached', timeout: 8000 });
    const contactField = d.getByLabel('Контактна особа', { exact: true });
    await contactField.waitFor({ timeout: 8000 });
    await p.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] select')].some((s) => s.selectedOptions[0]?.textContent.trim() === 'Богдан'), null, { timeout: 8000 }).catch(() => {});
    const shown = { customer: await shownOf(d.getByLabel('Замовник', { exact: true })), contact: await shownOf(contactField) };
    const ordersBefore = writes.filter((w) => /\/projects/.test(w.path)).length;
    files.push(await shoot(p, 'order-clerk-order-form'));
    const pathReads = requests.length;
    await d.getByRole('button', { name: 'Створити', exact: true }).click();
    await p.waitForURL(new RegExp(`/projects/${O244}$`), { timeout: 8000 }).catch(() => {});
    // The saved order's page, read through — not its loading line.
    const title = p.getByRole('heading', { level: 1 }).first();
    await title.waitFor({ timeout: 15000 }).catch(() => {});
    const heading = (await title.textContent().catch(() => null))?.trim() ?? null;
    await p.waitForTimeout(600);
    files.push(await shoot(p, 'order-clerk-saved'));
    const landed = new URL(p.url()).pathname;
    await ctx.close();
    // The form's contacts come by name and role (R12); the directory itself is never read.
    const onPath = requests.slice(0, pathReads);
    const directory = requests.filter((r) => /^GET \/api\/v1\/customers\/?(\?.*)?$|^GET \/api\/v1\/customers\/\d+\/?(\?.*)?$/.test(r));
    const foreign = foreignOf(onPath, ['orders']).filter((r) => !/\/customers\/\d+\/contact-options/.test(r));
    const [customerWrite, orderWrite] = writes;
    const contact = customerWrite?.body?.contacts?.[0] ?? {};
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: '/projects → «Нове замовлення» → name → «Новий замовник…» → «Додати контакт і доставку…» → contact + method → «Зберегти замовника» → «Створити»',
        fixture: [
          '/auth/me: ' + ROLE.orderClerk.join(', ') + ' (user 9001)',
          `POST /customers answered here as customer ${MADE.code}; GET /customers/options then lists it, /customers/${MADE.id}/contact-options its contact`,
          `POST /projects answered here with order ${O244}`,
          methods.length ? `delivery method «${method.name}» read from the stand` : 'GET /delivery-methods answered here (the stand has none)',
          'server proof: test_workshop_rights_customers.py (the clerk\'s whole path; directory and method writes closed)',
          'reads go with the stand administrator\'s token, so the saved order\'s page shows its contact\'s phone: the O12 mask is the server\'s (test_workshop_read_masks.py: an order\'s contact phone only for customers:read)',
        ],
      },
      measured: {
        prefilled, manage, shown, ordersBefore, landed, heading,
        sent: writes.map((w) => ({ method: w.method, path: w.path, body: w.body })),
        directory: directory.slice(0, 6), foreign: foreign.slice(0, 6), errors,
      },
      pass: prefilled === MADE.name && manage === 0 && writes.length === 2 &&
        customerWrite.method === 'POST' && customerWrite.body?.name === MADE.name &&
        contact.name === CONTACT.name && contact.phone === '+380501234567' && contact.delivery_method_id === method.id &&
        contact.delivery_details === 'Київ, відділення 1' && ordersBefore === 0 &&
        shown.customer === `${MADE.code} · ${MADE.name}` && shown.contact === CONTACT.name &&
        orderWrite.method === 'POST' && orderWrite.body?.name === 'E13 Замовлення клерка' &&
        orderWrite.body?.customer_id === MADE.id && orderWrite.body?.contact_id === CONTACT.id &&
        landed === `/projects/${O244}` && !!heading && heading.includes(order244.name) &&
        directory.length === 0 && foreign.length === 0 && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('delivery-directory', ['E13-O19', 'E13-R12'], async () => {
    // customers:update keeps the delivery directory — opened from a customer's form; one who may
    // only create customers picks from it and is offered no «Керувати способами…». The server
    // half: test_workshop_rights_customers.py.
    const standMethods = list(await read('/delivery-methods/'));
    const NEW = { id: 99040, name: 'E13 Самовивіз', position: 99, contacts_count: 0 };
    const RENAMED = 'E13 Самовивіз (центр)';
    const files = [];
    let stored = null; // the method as the server would list it now
    const writes = [];
    const ed = await open(1440, {
      me: asUser(ROLE.customersEditor),
      gets: [[/\/api\/v1\/delivery-methods\/?(\?.*)?$/, () => (stored ? { rewrite: (b) => [...list(b).filter((m) => m.id !== stored.id), stored] } : null)]],
      writes: [
        recorder(writes, /\/api\/v1\/delivery-methods\/?(\?.*)?$/, (entry) => { stored = { ...NEW, name: entry.body?.name ?? NEW.name }; return stored; }),
        recorder(writes, new RegExp(`/api/v1/delivery-methods/${NEW.id}$`), (entry) => { stored = { ...NEW, name: entry.body?.name ?? NEW.name }; return stored; }),
      ],
    });
    await goto(ed.p, `/customers/${CU1}`);
    await ed.p.getByTestId('customer-header').getByRole('button', { name: 'Редагувати', exact: true }).click();
    const c = dialogOf(ed.p, 'Редагувати замовника');
    await c.waitFor({ timeout: 8000 });
    // A customer without a contact has no method field: the editor adds a row first.
    if (!(await c.getByRole('button', { name: 'Керувати способами…', exact: true }).count())) {
      await c.getByRole('button', { name: 'Додати контакт', exact: true }).click();
    }
    await c.getByRole('button', { name: 'Керувати способами…', exact: true }).first().click();
    const m = dialogOf(ed.p, 'Способи доставки');
    await m.waitFor({ timeout: 8000 });
    await m.getByLabel('Новий спосіб доставки', { exact: true }).fill(NEW.name);
    await m.getByRole('button', { name: 'Додати', exact: true }).click();
    await m.getByRole('button', { name: `Перейменувати «${NEW.name}»`, exact: true }).waitFor({ timeout: 8000 });
    files.push(await shoot(ed.p, 'delivery-directory-added'));
    await m.getByRole('button', { name: `Перейменувати «${NEW.name}»`, exact: true }).click();
    await m.getByLabel('Назва способу доставки', { exact: true }).fill(RENAMED);
    await m.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await m.getByRole('button', { name: `Перейменувати «${RENAMED}»`, exact: true }).waitFor({ timeout: 8000 });
    files.push(await shoot(ed.p, 'delivery-directory-renamed'));
    await m.getByRole('button', { name: 'Готово', exact: true }).click();
    await m.waitFor({ state: 'detached', timeout: 8000 });
    const picks = await optionsOf(c.getByLabel('Спосіб доставки', { exact: true }).first());
    const editorForeign = foreignOf(ed.requests, ['customers']);
    const editorErrors = ed.errors;
    await ed.ctx.close();

    // One who may only create customers: the same form, its methods listed, the directory closed.
    const cr = await open(1440, { me: asUser(ROLE.customersCreator) });
    await goto(cr.p, '/customers');
    await cr.p.getByRole('button', { name: 'Новий замовник', exact: true }).first().click();
    const n = dialogOf(cr.p, 'Новий замовник');
    await n.waitFor({ timeout: 8000 });
    await cr.p.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] select')].some((s) => s.options.length > 1), null, { timeout: 8000 }).catch(() => {});
    const creator = {
      manage: await n.getByRole('button', { name: 'Керувати способами…', exact: true }).count(),
      methods: (await optionsOf(n.getByLabel('Спосіб доставки', { exact: true }).first())).length - 1,
    };
    files.push(await shoot(cr.p, 'delivery-directory-creator'));
    const creatorForeign = foreignOf(cr.requests, ['customers']);
    const creatorErrors = cr.errors;
    await cr.ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: `/customers/{customer:1} → «Редагувати» → «Керувати способами…» → add, rename → «Готово»; /customers → «Новий замовник»`,
        fixture: [
          '/auth/me: ' + ROLE.customersEditor.join(', ') + '; then ' + ROLE.customersCreator.join(', ') + ' (user 9001)',
          'POST / PATCH /delivery-methods answered here; GET /delivery-methods then lists the method as written',
          'server proof: test_workshop_rights_customers.py (customers:update writes the directory, customers:create only reads it)',
        ],
      },
      measured: {
        sent: writes.map((w) => ({ method: w.method, path: w.path, body: w.body })), picks, creator,
        foreign: [...editorForeign, ...creatorForeign].slice(0, 6), errors: [...editorErrors, ...creatorErrors],
      },
      pass: writes.length === 2 &&
        writes[0].method === 'POST' && /\/delivery-methods\/?$/.test(writes[0].path) && writes[0].body?.name === NEW.name &&
        writes[1].method === 'PATCH' && writes[1].path === `/api/v1/delivery-methods/${NEW.id}` && writes[1].body?.name === RENAMED &&
        picks.includes(RENAMED) && creator.manage === 0 && creator.methods === standMethods.length &&
        editorForeign.length === 0 && creatorForeign.length === 0 && editorErrors.length === 0 && creatorErrors.length === 0,
      screenshots: files,
    };
  });

  // ---------------------------------------------------------------- H: the outer doors
  // The file the order question is about: «dif01_p1s.gcode.3mf», whose plate 1 every line of
  // OR-0034 can take — so the server offers ONE order twice or more (one option per line).
  const DIF = (job.files ?? {})['dif01_p1s.gcode.3mf'] ?? 1;
  const dif = await read(`/library/files/${DIF}`);
  const difName = dif.print_name || dif.filename || '';
  const candidates = list(await read(`/library/files/${DIF}/order-candidates?plate_index=1`));
  const printers = list(await read('/printers/'));
  const difModel = dif.metadata?.sliced_for_model ?? 'P1S';
  const sameModel = printers.filter((x) => x.model === difModel && x.is_active && !x.archived);
  // What the field calls a candidate (OrderFilingField): the order, the product, the line's
  // material when it has one, and what it still needs — in Ukrainian plural forms.
  const STILL = { one: 'потрібен ще {n} друк', few: 'потрібно ще {n} друки', many: 'потрібно ще {n} друків', other: 'потрібно ще {n} друку' };
  const plural = new Intl.PluralRules('uk');
  // The line's kit as lineConfigLabel captions it: the options that differ, the changed
  // parts, «стандартна» for a configurable product left standard, «лише деталі» for a parts line.
  const kitOf = (c) => {
    if (c.line_mode === 'parts') return 'лише деталі';
    const cfg = c.line_configuration ?? {};
    const bits = list(cfg.choices).filter((x) => !x.is_default).map((x) => `${x.group_name}: ${x.option_name}`);
    if (list(cfg.changed_parts).length) bits.push(`змінено деталей: ${list(cfg.changed_parts).length}`);
    if (bits.length) return bits.join(' · ');
    return list(cfg.choices).length ? 'стандартна' : '';
  };
  const candidateLabel = (c) => `${c.project_code} · ${c.project_name} — ${c.product_name}${kitOf(c) ? ` · ${kitOf(c)}` : ''}${c.line_material ? ` · ${c.line_material}` : ''} · ${
    c.outstanding_prints > 0 ? STILL[plural.select(c.outstanding_prints)].replace('{n}', c.outstanding_prints) : 'вже покрито'}`;
  const candidateValue = (c) => `${c.project_id}:${c.project_line_id}`;
  const NEW_ORDER = 'Нове замовлення на цей тираж';
  // One order offered twice: the line the runner files under is that order's SECOND option.
  const byOrder = {};
  for (const c of candidates) (byOrder[c.project_id] ??= []).push(c);
  const twice = Object.values(byOrder).find((cs) => cs.length >= 2) ?? [];
  const pick = twice[1] ?? candidates[0] ?? null;
  // The stand's printers have no MQTT: their status says offline, and the dialog (rightly) will
  // not send to an offline printer. The answer is the idle printer a farm would report.
  const idle = (s) => ({ ...s, connected: true, state: 'IDLE' });
  const IDLE = [/\/api\/v1\/printers\/(\d+\/status|status\/batch)\/?(\?.*)?$/, (b, url) => (
    /status\/batch/.test(url) ? Object.fromEntries(Object.entries(b ?? {}).map(([k, st]) => [k, idle(st)])) : idle(b))];
  const IDLE_NOTE = 'GET /printers/{id}/status and /printers/status/batch → connected, IDLE (the stand has no MQTT)';
  // The routing previews are POSTs: answered here as a farm whose printers take the plate.
  const PREVIEWS = [
    [/\/auto-queue\/printer-routing-preview$/, (req) => {
      const body = req.postDataJSON() ?? {};
      return { targets: list(body.targets).map((t) => ({ printer_id: t.printer_id, plate_id: t.plate_id, status: 'compatible', mapping: t.ams_mapping ?? null, reason: null })) };
    }],
    [/\/auto-queue\/routing-preview$/, (req) => {
      const body = req.postDataJSON() ?? {};
      const model = body.target_model ?? difModel;
      return {
        plates: list(body.plate_ids).map((id) => ({
          requested_plate_id: id, plate_id: id, status: 'ok', reason: null, model, target_model: model, filaments: [],
          groups: [{ key: model, model, nozzles: 1, ams: 'present', total: sameModel.length, compatible: sameModel.length, unknown: 0, incompatible: 0, ready: sameModel.length, reasons: [] }],
        })),
      };
    }],
  ];
  const PREVIEWS_NOTE = 'POST /auto-queue/(printer-)routing-preview → every target compatible (answered here)';
  const PRINT_WRITE = /\/api\/v1\/library\/files\/\d+\/print(\?.*)?$/;
  const QUEUE_WRITE = /\/api\/v1\/queue\/?(\?.*)?$/;
  const AUTO_WRITE = /\/api\/v1\/auto-queue\/?(\?.*)?$/;
  let nextRow = 99100;
  const queued = () => { nextRow += 1; return { id: nextRow, created_item_ids: [nextRow] }; };
  const filedUnder = (w, c) => w.body?.project_id === c?.project_id && w.body?.project_line_id === c?.project_line_id;
  const dialogOfPrint = (p) => p.getByRole('dialog').filter({ has: p.getByLabel('Замовлення', { exact: true }) }).last();
  const waitForWrites = async (writes, n, ms = 8000) => {
    const end = Date.now() + ms;
    while (writes.length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 150));
    return writes.length;
  };
  const difCard = (p) => p.locator('[data-file-card]', { hasText: difName }).first();
  const difMenu = async (p, entry) => {
    await difCard(p).hover();
    await difCard(p).getByRole('button', { name: 'Дії з файлом' }).click();
    await p.getByRole('button', { name: entry, exact: true }).click();
  };
  const filesOfDif = `/files?folder=${dif.folder_id ?? ''}`;
  // The plate strip only shows a plate; its card toggles it (PlateSelector). The plates a dialog
  // holds selected carry a dot on their strip button. Exactly plate 1: every other selected plate
  // shown and toggled off, then plate 1 toggled on if it is not.
  const selectedPlates = (d) => d.locator('button[title^="Платформа"]')
    .evaluateAll((bs) => bs.filter((b) => b.querySelector('span[aria-hidden="true"]')).map((b) => b.textContent.trim()));
  const togglePlate = async (d, n) => {
    await d.locator(`button[title="Платформа ${n}"]`).click();
    await d.getByRole('button', { name: new RegExp(`^Платформа ${n}\\b`) }).last().click();
  };
  const onlyPlateOne = async (p, d) => {
    // The plates arrive after the dialog, and the dialog ticks its default selection after them.
    await d.locator('button[title="Платформа 1"]').waitFor({ timeout: 10000 });
    await p.waitForTimeout(800);
    for (const n of await selectedPlates(d)) if (n !== '1') await togglePlate(d, n);
    if (!(await selectedPlates(d)).includes('1')) await togglePlate(d, '1');
    // Plate 1 shown — the one the order question is about.
    await d.locator('button[title="Платформа 1"]').click();
    await p.waitForTimeout(300);
    return selectedPlates(d);
  };

  await scenario('print-modal-library', ['E13-H01'], async () => {
    const out = { files: [] };
    // 1. «Друк» from the library: the question, two lines of one order, a batch offers a new order.
    {
      const writes = [];
      const { ctx, p, errors } = await open(1440, {
        storage: FILES_GRID, rewrite: [TAGGED, PLATES, IDLE],
        writes: [...PREVIEWS, recorder(writes, PRINT_WRITE, () => ({ status: 'printing' }))],
      });
      await goto(p, filesOfDif);
      await difMenu(p, 'Друк');
      const d = p.getByRole('dialog', { name: 'Друкувати' });
      await d.waitFor({ timeout: 10000 });
      const field = d.getByLabel('Замовлення', { exact: true });
      await field.waitFor({ timeout: 10000 });
      out.single = await optionsOf(field);
      for (const pr of sameModel.slice(0, 2)) await d.getByRole('button', { name: new RegExp(pr.name) }).first().click();
      await p.waitForTimeout(800);
      out.batch = await optionsOf(field);
      if (pick) await field.selectOption(candidateValue(pick));
      out.shown = await shownOf(field);
      out.files.push(await shoot(p, 'print-modal-library'));
      const submit = d.locator('button[type="submit"]');
      out.submitLabel = (await submit.textContent())?.trim();
      out.submitEnabled = await submit.isEnabled();
      if (out.submitEnabled) await submit.click();
      await waitForWrites(writes, 2);
      out.sent = writes.map((w) => ({ path: w.path, project_id: w.body?.project_id, project_line_id: w.body?.project_line_id }));
      out.errors = errors;
      await ctx.close();
    }
    // 2. Without orders:create the batch is offered no new order.
    {
      const { ctx, p } = await open(1440, { storage: FILES_GRID, rewrite: [TAGGED, PLATES, IDLE], me: asUser(without('orders:create')), writes: [...PREVIEWS] });
      await goto(p, filesOfDif);
      await difMenu(p, 'Друк');
      const d = p.getByRole('dialog', { name: 'Друкувати' });
      await d.waitFor({ timeout: 10000 });
      const field = d.getByLabel('Замовлення', { exact: true });
      await field.waitFor({ timeout: 10000 });
      for (const pr of sameModel.slice(0, 2)) await d.getByRole('button', { name: new RegExp(pr.name) }).first().click();
      await p.waitForTimeout(800);
      out.batchNoCreate = await optionsOf(field);
      await ctx.close();
    }
    // 3. «Запланувати» → auto distribution: the model route carries the line.
    {
      const writes = [];
      const { ctx, p, errors } = await open(1440, {
        storage: FILES_GRID, rewrite: [TAGGED, PLATES, IDLE],
        writes: [...PREVIEWS, recorder(writes, AUTO_WRITE, queued)],
      });
      await goto(p, filesOfDif);
      await difMenu(p, 'Запланувати');
      const d = p.getByRole('dialog', { name: 'Запланувати друк' });
      await d.waitFor({ timeout: 10000 });
      await d.getByRole('radio', { name: 'Авто-розподіл' }).click();
      // The dialog ticks every plate; the line is an answer about ONE plate, so the run
      // queues plate 1 alone (several plates carry the order and leave the line out, by design).
      out.autoPlates = await onlyPlateOne(p, d);
      const field = d.getByLabel('Замовлення', { exact: true });
      await field.waitFor({ timeout: 10000 });
      await p.waitForTimeout(600);
      out.auto = await optionsOf(field);
      if (pick) await field.selectOption(candidateValue(pick));
      // The model the route asks for, named explicitly (the select's label is not tied to it).
      const model = d.locator('select').filter({ has: p.locator('option', { hasText: 'Авто-визначення' }) });
      out.models = await optionsOf(model);
      await model.selectOption({ label: difModel });
      out.files.push(await shoot(p, 'print-modal-library-auto'));
      const submit = d.locator('button[type="submit"]');
      out.autoSubmitEnabled = await submit.isEnabled();
      if (out.autoSubmitEnabled) await submit.click();
      await waitForWrites(writes, 1);
      out.autoSent = writes.map((w) => ({ path: w.path, project_id: w.body?.project_id, project_line_id: w.body?.project_line_id, target_model: w.body?.target_model, feed_policy: w.body?.feed_policy }));
      out.autoErrors = errors;
      await ctx.close();
    }
    const expected = ['Без замовлення', ...candidates.map(candidateLabel)];
    // The same order offered for several lines reads as several DIFFERENT options.
    const apart = new Set(out.single ?? []).size === (out.single ?? []).length;
    const sentOk = out.sent.length === 2 && out.sent.every((w) => w.project_id === pick?.project_id && w.project_line_id === pick?.project_line_id);
    const autoOk = out.autoSent.length === 1 && out.autoSent[0].project_id === pick?.project_id && out.autoSent[0].project_line_id === pick?.project_line_id && out.autoSent[0].target_model === difModel;
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: '/files?folder={dif01_p1s} → the card’s «Друк» / «Запланувати»',
        actions: ['two printers ticked (a batch)', `the order field: ${pick ? candidateLabel(pick) : '—'}`, 'submit', '«Запланувати» → «Авто-розподіл», plate 1 alone, model ' + difModel],
        fixture: [TAGGED_NOTE, PLATES_NOTE, IDLE_NOTE, PREVIEWS_NOTE, 'POST /library/files/{id}/print and POST /auto-queue/ answered here', '/auth/me without orders:create (the second run)'],
      },
      measured: { expected, apart, single: out.single, batch: out.batch, batchNoCreate: out.batchNoCreate, auto: out.auto, autoPlates: out.autoPlates, models: out.models, shown: out.shown, twice: twice.length, submitLabel: out.submitLabel, sent: out.sent, autoSent: out.autoSent, errors: [...(out.errors ?? []), ...(out.autoErrors ?? [])] },
      pass: twice.length >= 2 && apart && same(out.single, expected) && same(out.batch, ['Без замовлення', NEW_ORDER, ...expected.slice(1)])
        && same(out.batchNoCreate, expected) && same(out.auto, expected) && same(out.autoPlates, ['1']) && out.shown === candidateLabel(pick) && sentOk && autoOk
        && (out.errors ?? []).length === 0 && (out.autoErrors ?? []).length === 0,
      screenshots: out.files,
    };
  });

  // The library picker every queue door opens: the file searched, ticked, confirmed — then the
  // sequencer's print dialog asks about the order. Plate 1 alone (the line is an answer about
  // ONE plate), the second line of OR-0034, submitted; the write is answered here.
  const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pickDif = async (p, open) => {
    await open();
    const picker = dialogOf(p, 'Нагрузити чергу');
    await picker.waitFor({ timeout: 10000 });
    await picker.getByPlaceholder('Пошук по всій бібліотеці').fill(difName.replace(/\.gcode\.3mf$/, ''));
    await picker.getByRole('button', { name: new RegExp(`^${escapeRe(difName)}`) }).first().click();
    await picker.getByRole('button', { name: 'Поставити в чергу', exact: true }).click();
    const d = p.getByRole('dialog', { name: 'Запланувати друк' });
    await d.waitFor({ timeout: 10000 });
    return d;
  };
  const fileOnPlateOne = async (p, d) => {
    const plates = await onlyPlateOne(p, d);
    const field = d.getByLabel('Замовлення', { exact: true });
    await field.waitFor({ timeout: 10000 });
    await p.waitForTimeout(600);
    const options = await optionsOf(field);
    if (pick) await field.selectOption(candidateValue(pick));
    return { plates, options, shown: await shownOf(field) };
  };
  const submitAndRecord = async (p, d, writes) => {
    const submit = d.locator('button[type="submit"]');
    const enabled = await submit.isEnabled();
    if (enabled) await submit.click();
    await waitForWrites(writes, 1);
    return {
      enabled,
      sent: writes.map((w) => ({
        path: w.path, queue_id: w.body?.queue_id, project_id: w.body?.project_id, project_line_id: w.body?.project_line_id,
        target_model: w.body?.target_model, plate_id: w.body?.plate_id,
      })),
    };
  };
  const filedOnce = (sent, extra = () => true) => sent.length === 1 && sent[0].project_id === pick?.project_id
    && sent[0].project_line_id === pick?.project_line_id && extra(sent[0]);

  await scenario('print-modal-printer', ['E13-H01'], async () => {
    const writes = [];
    const target = sameModel[0];
    const { ctx, p, errors } = await open(1440, {
      rewrite: [TAGGED, PLATES, IDLE],
      writes: [...PREVIEWS, recorder(writes, QUEUE_WRITE, queued)],
    });
    await goto(p, '/');
    const card = p.locator('div')
      .filter({ has: p.getByText(target.name, { exact: true }) })
      .filter({ has: p.getByRole('button', { name: 'Завантажити з бібліотеки' }) })
      .last();
    const d = await pickDif(p, () => card.getByRole('button', { name: 'Завантажити з бібліотеки' }).click());
    // The card IS the printer: the dialog is pinned to it and offers no other mode.
    const modes = await d.getByRole('radio', { name: 'Авто-розподіл' }).count();
    const asked = await fileOnPlateOne(p, d);
    const file = await shoot(p, 'print-modal-printer');
    const done = await submitAndRecord(p, d, writes);
    await ctx.close();
    const expected = ['Без замовлення', ...candidates.map(candidateLabel)];
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: `/ (printers) → ${target.name}’s «Завантажити з бібліотеки»`,
        actions: [`the picker: ${difName}`, '«Поставити в чергу»', 'plate 1 alone', `the order field: ${pick ? candidateLabel(pick) : '—'}`, 'submit'],
        fixture: [TAGGED_NOTE, PLATES_NOTE, IDLE_NOTE, PREVIEWS_NOTE, 'POST /queue/ answered here'],
      },
      measured: { target: target.name, modes, plates: asked.plates, options: asked.options, shown: asked.shown, ...done, errors },
      pass: modes === 0 && same(asked.plates, ['1']) && same(asked.options, expected) && filedOnce(done.sent, (w) => w.queue_id === target.id && w.plate_id === 1)
        && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('print-modal-queue', ['E13-H01'], async () => {
    const out = { files: [] };
    const target = sameModel[1] ?? sameModel[0];
    const expected = ['Без замовлення', ...candidates.map(candidateLabel)];
    // 1. A printer's queue card.
    {
      const writes = [];
      const { ctx, p, errors } = await open(1440, {
        rewrite: [TAGGED, PLATES, IDLE],
        writes: [...PREVIEWS, recorder(writes, QUEUE_WRITE, queued)],
      });
      await goto(p, '/queue');
      const card = p.locator('div')
        .filter({ has: p.getByText(target.name, { exact: true }) })
        .filter({ has: p.getByRole('button', { name: 'Завантажити з бібліотеки' }) })
        .last();
      const d = await pickDif(p, () => card.getByRole('button', { name: 'Завантажити з бібліотеки' }).click());
      out.cardAsked = await fileOnPlateOne(p, d);
      out.files.push(await shoot(p, 'print-modal-queue-card'));
      out.card = await submitAndRecord(p, d, writes);
      out.cardErrors = errors;
      await ctx.close();
    }
    // 2. The auto-queue panel: the route is the file's own model.
    {
      const writes = [];
      const { ctx, p, errors } = await open(1440, {
        rewrite: [TAGGED, PLATES, IDLE],
        writes: [...PREVIEWS, recorder(writes, AUTO_WRITE, queued)],
      });
      await goto(p, '/queue');
      const panel = p.locator('div')
        .filter({ has: p.getByRole('heading', { name: 'Авто-черга', exact: true }) })
        .filter({ has: p.getByRole('button', { name: 'Завантажити з бібліотеки' }) })
        .last();
      const d = await pickDif(p, () => panel.getByRole('button', { name: 'Завантажити з бібліотеки' }).click());
      out.autoAsked = await fileOnPlateOne(p, d);
      out.files.push(await shoot(p, 'print-modal-queue-auto'));
      out.auto = await submitAndRecord(p, d, writes);
      out.autoErrors = errors;
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: `/queue → ${target.name}’s card and the «Авто-черга» panel, each «Завантажити з бібліотеки»`,
        actions: [`the picker: ${difName}`, 'plate 1 alone', `the order field: ${pick ? candidateLabel(pick) : '—'}`, 'submit'],
        fixture: [TAGGED_NOTE, PLATES_NOTE, IDLE_NOTE, PREVIEWS_NOTE, 'POST /queue/ and POST /auto-queue/ answered here'],
      },
      measured: { target: target.name, ...out, files: undefined },
      pass: same(out.cardAsked.plates, ['1']) && same(out.autoAsked.plates, ['1'])
        && same(out.cardAsked.options, expected) && same(out.autoAsked.options, expected)
        && filedOnce(out.card.sent, (w) => w.queue_id === target.id)
        && filedOnce(out.auto.sent, (w) => (w.target_model ?? difModel) === difModel)
        && out.cardErrors.length === 0 && out.autoErrors.length === 0,
      screenshots: out.files,
    };
  });

  await scenario('plan-from-files-create', ['E13-H02'], async () => {
    // The real path (N3): the file ticked in the manager itself, «Розрахувати», the dialog's own
    // «Розрахувати», «Відкрити замовлення». The order is not created on the stand: the runner
    // answers POST /projects/from-files with OR-0034 as the stand holds it, so the browser proves
    // the way from the dialog to the order and its lines; the creation itself — and the library
    // gate (B07) — is the backend's tests' (test_order_from_files_api, test_workshop_library_rights).
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      storage: FILES_GRID, rewrite: [TAGGED, PLATES],
      writes: [
        [/\/api\/v1\/library\/files\/parts-preview$/, job.parts_preview ?? {}],
        recorder(writes, /\/api\/v1\/projects\/from-files$/, () => order244),
      ],
    });
    await goto(p, filesOfDif);
    await difCard(p).hover();
    await difCard(p).getByRole('button', { name: 'Вибрати файл' }).click();
    await p.getByRole('button', { name: 'Розрахувати', exact: true }).click();
    const d = p.getByRole('dialog').filter({ hasText: 'План із файлів' });
    await d.waitFor({ timeout: 10000 });
    await d.getByText('Назва замовлення').waitFor({ timeout: 10000 });
    const nameInput = d.locator('label', { hasText: 'Назва замовлення' }).locator('input');
    await nameInput.fill('E13 · план з файлів');
    const units = d.locator('label', { hasText: 'Одиниць' }).locator('input');
    const catalog = await units.count();
    if (catalog) await units.fill('2');
    else await d.locator('table input').first().fill('2');
    const first = await shoot(p, 'plan-from-files-create');
    await d.getByRole('button', { name: 'Розрахувати', exact: true }).click();
    await waitForWrites(writes, 1);
    const open244 = d.getByRole('link', { name: 'Відкрити замовлення' });
    await open244.waitFor({ timeout: 10000 });
    await open244.click();
    await p.waitForURL(new RegExp(`/projects/${O244}(\\?.*)?$`), { timeout: 10000 });
    await p.waitForTimeout(1200);
    const rows = await p.locator('[data-testid^="line-"][data-testid$="-quantity"]').count();
    // The header names the order by its code («OR-0034 · створено …»).
    const code = await p.getByText(new RegExp(`^${order244.code ?? 'OR-0034'} ·`)).count();
    const second = await shoot(p, 'plan-from-files-order');
    await ctx.close();
    const body = writes[0]?.body ?? {};
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: `/files?folder={dif01_p1s} → tick «${difName}» → «Розрахувати» → «Розрахувати» → «Відкрити замовлення»`,
        fixture: [TAGGED_NOTE, PLATES_NOTE, 'POST /library/files/parts-preview → the stand’s own answer, read by the job server', 'POST /projects/from-files → OR-0034 as the stand holds it (answered here)'],
      },
      measured: {
        mode: catalog ? 'catalog' : 'job', sent: writes.map((w) => w.path), body: { kind: body.kind, file_ids: body.file_ids, quantity: body.quantity, product_id: body.product_id, name: body.name },
        url: new URL(p.url()).pathname, rows, lines: linesOf(order244).length, code, errors,
      },
      pass: writes.length === 1 && same(body.file_ids, [DIF]) && body.name === 'E13 · план з файлів'
        && rows === linesOf(order244).length && rows > 0 && code >= 1 && errors.length === 0,
      screenshots: [first, second],
    };
  });

  // A queued row of the stand that is filed under an order's line — the copy and edit source.
  const pendingRows = list(await read('/queue/?status=pending'));
  const filedRow = pendingRows.find((row) => row.project_line_id != null) ?? null;
  const filedPrinter = printers.find((x) => x.id === filedRow?.queue_id) ?? null;
  const queueCard = (p, name) => p.locator('div')
    .filter({ has: p.getByText(name, { exact: true }) })
    .filter({ has: p.getByRole('button', { name: 'Завантажити з бібліотеки' }) })
    .last();
  const QUEUE_OF = (id) => new RegExp(`^GET /api/v1/projects/${id}/queue$`);

  await scenario('queue-refresh-after-enqueue', ['E13-H03'], async () => {
    const out = { files: [] };
    let step = 'plan';
    try {
    // 1. From the order's own plan: its queue tiers are read again, no reload.
    {
      const writes = [];
      const { ctx, p, errors, requests } = await open(1440, {
        rewrite: [PLATES, IDLE], writes: [...PREVIEWS, recorder(writes, QUEUE_WRITE, queued)],
      });
      await goto(p, `/projects/${O241}`);
      await waitForCount(requests, QUEUE_OF(O241), 1);
      const before = countOf(requests, QUEUE_OF(O241));
      const button = p.locator('[data-testid^="plan-row-"][data-testid$="-printer"]').first();
      const lineId = Number((await button.getAttribute('data-testid')).split('-')[2]);
      await button.click();
      const pd = dialogOf(p, 'На принтер');
      await pd.waitFor({ timeout: 8000 });
      await pd.getByRole('button', { name: 'Далі — діалог друку' }).click();
      const d = p.getByRole('dialog', { name: 'Запланувати друк' });
      await d.waitFor({ timeout: 10000 });
      await d.locator('button[type="submit"]').waitFor();
      await p.waitForTimeout(800);
      const done = await submitAndRecord(p, d, writes);
      const after = await waitForCount(requests, QUEUE_OF(O241), before + 1);
      out.plan = { lineId, before, after, sent: done.sent, errors };
      await ctx.close();
    }
    step = 'queue';
    // 2. From the queue page, in the app: back on the order, its tiers are read again (they
    //    would otherwise come from the cache, fresh for a minute).
    {
      const writes = [];
      const { ctx, p, errors, requests } = await open(1440, {
        rewrite: [TAGGED, PLATES, IDLE], writes: [...PREVIEWS, recorder(writes, QUEUE_WRITE, queued)],
      });
      await goto(p, `/projects/${O244}`);
      await waitForCount(requests, QUEUE_OF(O244), 1);
      const first = countOf(requests, QUEUE_OF(O244));
      // The sidebar's «Черга» (its badge is part of the link's name).
      await p.locator('a[href="/queue"]').first().click();
      await p.waitForURL(/\/queue/, { timeout: 8000 });
      const target = sameModel[1] ?? sameModel[0];
      const d = await pickDif(p, () => queueCard(p, target.name).getByRole('button', { name: 'Завантажити з бібліотеки' }).click());
      await fileOnPlateOne(p, d);
      const done = await submitAndRecord(p, d, writes);
      await p.goBack();
      await p.waitForURL(new RegExp(`/projects/${O244}(\\?.*)?$`), { timeout: 8000 });
      const again = await waitForCount(requests, QUEUE_OF(O244), first + 1);
      out.queue = { first, again, sent: done.sent, errors };
      await ctx.close();
    }
    step = 'copy';
    // 3. A copy of a filed row to another printer carries the row's line (the sequencer files it
    //    as the source was filed, and does not ask again).
    {
      const writes = [];
      const { ctx, p, errors } = await open(1440, {
        rewrite: [PLATES, IDLE], writes: [...PREVIEWS, recorder(writes, QUEUE_WRITE, queued)],
      });
      await goto(p, '/queue');
      const other = printers.find((x) => x.model === filedPrinter?.model && x.id !== filedPrinter?.id && x.is_active && !x.archived);
      await queueCard(p, filedPrinter?.name ?? '').getByRole('button', { name: 'Скопіювати чергу на інші принтери' }).click();
      const cd = dialogOf(p, 'Копіювання черги');
      await cd.waitFor({ timeout: 8000 });
      await cd.getByRole('button', { name: new RegExp(escapeRe(other?.name ?? '—')) }).first().click();
      await cd.getByRole('button', { name: 'Копіювати', exact: true }).click();
      const d = p.getByRole('dialog', { name: 'Запланувати друк' });
      await d.waitFor({ timeout: 10000 });
      await d.locator('button[type="submit"]').waitFor();
      await p.waitForTimeout(1000);
      const asks = await d.getByLabel('Замовлення', { exact: true }).count();
      out.files.push(await shoot(p, 'queue-copy-keeps-line'));
      const done = await submitAndRecord(p, d, writes);
      out.copy = { to: other?.name, asks, sent: done.sent, errors };
      await ctx.close();
    }
    step = 'edit';
    // 4. An edit of the filed row names no line — the server keeps the stored one.
    {
      const writes = [];
      const { ctx, p, errors } = await open(1440, {
        rewrite: [PLATES, IDLE],
        writes: [...PREVIEWS, recorder(writes, new RegExp(`/api/v1/queue/${filedRow?.id}$`), () => filedRow)],
      });
      await goto(p, '/queue');
      // The card's header holds its name; its rows sit in the nearest block around it that has them.
      const rowsOf = queueCard(p, filedPrinter?.name ?? '').locator('xpath=ancestor::div[.//button[@title="Редагувати елемент"]][1]');
      await rowsOf.getByRole('button', { name: 'Редагувати елемент' }).first().click();
      const d = p.getByRole('dialog', { name: 'Редагувати елемент черги' });
      await d.waitFor({ timeout: 10000 });
      await d.locator('button[type="submit"]').waitFor();
      await p.waitForTimeout(1000);
      const submit = d.locator('button[type="submit"]');
      const enabled = await submit.isEnabled();
      if (enabled) await submit.click();
      await waitForWrites(writes, 1);
      out.edit = {
        enabled,
        sent: writes.map((w) => ({ method: w.method, path: w.path, names: Object.keys(w.body ?? {}).filter((k) => k.startsWith('project')) })),
        errors,
      };
      await ctx.close();
    }
    } catch (e) {
      // Which part stopped, and the error's class only (never its text).
      return { pass: false, error: { code: 'error', stage: `queue-refresh:${step}`, name: e?.name ?? 'Error' }, measured: { step, ...out, files: undefined }, screenshots: out.files };
    }
    const planOk = out.plan.after > out.plan.before && out.plan.sent.length === 1
      && out.plan.sent[0].project_id === O241 && out.plan.sent[0].project_line_id === out.plan.lineId;
    const queueOk = out.queue.again > out.queue.first && out.queue.sent.length === 1
      && out.queue.sent[0].project_line_id === pick?.project_line_id;
    const copyOk = out.copy.asks === 0 && out.copy.sent.length >= 1
      && out.copy.sent.every((w) => w.project_id === filedRow?.project_id && w.project_line_id === filedRow?.project_line_id);
    const editOk = out.edit.sent.length === 1 && out.edit.sent[0].method === 'PATCH' && out.edit.sent[0].names.length === 0;
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: `/projects/{order:241} → «На принтер…»; /projects/{order:244} → «Черга» → a card’s «Завантажити з бібліотеки» → Back; /queue → ${filedPrinter?.name}: «Скопіювати чергу…», «Редагувати елемент»`,
        fixture: [TAGGED_NOTE, PLATES_NOTE, IDLE_NOTE, PREVIEWS_NOTE, 'POST /queue/ and PATCH /queue/{id} answered here'],
        note: 'A reorder sends POST /queue/{id}/reorder?direction=… with no body — nothing to carry or drop; the server keeping the line through it, an edit and a clone is pinned by test_project_line_passthrough (…survives_a_reorder / _an_edit_that_does_not_name_it / _a_clone).',
      },
      measured: { filedRow: filedRow && { id: filedRow.id, project_id: filedRow.project_id, project_line_id: filedRow.project_line_id }, ...out, files: undefined },
      pass: Boolean(filedRow) && planOk && queueOk && copyOk && editOk
        && [out.plan, out.queue, out.copy, out.edit].every((x) => x.errors.length === 0),
      screenshots: out.files,
    };
  });

  await scenario('filament-vs-inventory', ['E13-H04'], async () => {
    // «є» against the inventory (the stand's internal backend): the inventory's own per-material
    // total (GET /inventory/stats, the Filament page's bar) is what a material's type figure must
    // be, and the screen shows the server's figure as it came. Unknown is «—», never zero.
    const fmtW = (g) => (g >= 1000 ? `${(g / 1000) % 1 === 0 ? (g / 1000).toFixed(0) : (g / 1000).toFixed(1)}kg` : `${Math.round(g)}g`);
    const stats = await read('/inventory/stats');
    const inventory = {};
    for (const m of list(stats.by_material)) inventory[m.material.trim().toUpperCase()] = (inventory[m.material.trim().toUpperCase()] ?? 0) + m.remaining_g;
    const needs = await read(`/projects/${O241}/filament`);
    const farm = await read('/projects/filament');
    const typeMismatch = [...list(needs.rows), ...list(farm.rows)]
      .filter((r) => r.have_type_g == null || Math.abs(r.have_type_g - (inventory[r.material] ?? 0)) >= 1)
      .map((r) => ({ material: r.material, colour: r.colour, have_type_g: r.have_type_g, inventory: inventory[r.material] ?? 0 }));
    const testId = (prefix, r) => (r.colour ? `${prefix}${r.material}-${r.colour}` : `${prefix}${r.material}`);
    const out = { files: [] };
    // 1. The order's panel and the orders list's strip, as the server answered.
    {
      const { ctx, p, errors } = await open(1440);
      await goto(p, `/projects/${O241}`);
      await p.getByTestId('order-filament-panel').waitFor({ timeout: 8000 });
      out.panel = [];
      for (const r of list(needs.rows)) {
        const text = await textOf(p.getByTestId(testId('filament-need-', r)));
        out.panel.push({ key: testId('', r), text, shows: text.includes(`на полиці ${fmtW(r.have_g)}`) });
      }
      await p.getByTestId('order-filament-panel').scrollIntoViewIfNeeded();
      await p.waitForTimeout(300);
      out.files.push(await shoot(p, 'filament-panel'));
      await goto(p, '/projects');
      out.strip = [];
      for (const r of list(farm.rows).slice(0, 7)) {
        const chip = p.getByTestId(testId('filament-chip-', r));
        const text = (await chip.count()) ? await textOf(chip) : null;
        out.strip.push({ key: testId('', r), text, shows: text != null && text.includes(`є ${fmtW(r.have_g)}`) });
      }
      out.knownErrors = errors;
      await ctx.close();
    }
    // 2. A shelf the server cannot read (Spoolman down): «—», not «0g».
    {
      const unknown = (b) => ({
        ...b, stock_unavailable: true,
        rows: list(b.rows).map((r) => ({ ...r, have_g: null, have_type_g: null, short_g: null })),
      });
      const { ctx, p, errors } = await open(1440, {
        rewrite: [[new RegExp(`/api/v1/projects/(${O241}/)?filament/?(\\?.*)?$`), unknown]],
      });
      await goto(p, `/projects/${O241}`);
      await p.getByTestId('order-filament-panel').waitFor({ timeout: 8000 });
      const first = list(needs.rows)[0];
      out.unknownPanel = first ? await textOf(p.getByTestId(testId('filament-need-', first))) : null;
      await p.getByTestId('order-filament-panel').scrollIntoViewIfNeeded();
      await p.waitForTimeout(300);
      out.files.push(await shoot(p, 'filament-panel-unknown'));
      await goto(p, '/projects');
      const chip = list(farm.rows)[0];
      out.unknownChip = chip ? await textOf(p.getByTestId(testId('filament-chip-', chip))) : null;
      out.unknownErrors = errors;
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: '/projects/{order:241} (the filament panel) and /projects (the strip)',
        fixture: ['the second run: GET /projects/{id}/filament and /projects/filament → have_g / have_type_g / short_g null, stock_unavailable (a shelf that cannot be read)'],
        note: 'The stand holds no spools: a known-empty shelf reads «0g» against an empty inventory, an unreadable one «—». The two readers agreeing over real spools (live, archived, used past the label) is pinned by test_filament_needs_api::test_the_shelf_of_a_material_is_the_inventorys_own_figure.',
      },
      measured: { inventory, typeMismatch, ...out, files: undefined },
      pass: list(needs.rows).length > 0 && list(farm.rows).length > 0 && typeMismatch.length === 0
        && out.panel.every((x) => x.shows) && out.strip.every((x) => x.shows)
        && /на полиці —/.test(out.unknownPanel ?? '') && !/на полиці 0g/.test(out.unknownPanel ?? '')
        && /є —/.test(out.unknownChip ?? '') && !/є 0g/.test(out.unknownChip ?? '')
        && out.knownErrors.length === 0 && out.unknownErrors.length === 0,
      screenshots: out.files,
    };
  });

  await scenario('deep-links', ['E13-H05'], async () => {
    // Every Workshop route opened cold (a full load of the document, as a bookmark or a pasted
    // link does): the page it names, the section / tab its query names; an id that does not
    // exist says «… не знайдено» and offers the way back to its list; /orders is no page.
    const customer1 = await read(`/customers/${CU1}`);
    const note1 = await read(`/stock-issues/${N1}`);
    const MISSING = 999999;
    const FOUND = [
      { path: '/projects', heading: 'Замовлення' },
      { path: `/projects/${O244}?section=prints`, tab: 'Друки' },
      { path: `/products/${PR1}?tab=plates`, tab: 'Плити й файли' },
      { path: `/customers/${CU1}`, heading: customer1.name },
      { path: '/stock?tab=journal', tab: 'Журнал руху' },
      { path: `/stock/${POS1}`, text: item1.code },
      { path: `/stock/dispatch-notes/${N1}`, text: note1.code },
    ];
    const GONE = [
      { path: `/projects/${MISSING}`, says: 'Замовлення не знайдено', back: '/projects' },
      { path: `/products/${MISSING}`, says: 'Виріб не знайдено', back: '/products' },
      { path: `/customers/${MISSING}`, says: 'Замовника не знайдено', back: '/customers' },
      { path: `/stock/${MISSING}`, says: 'Позицію не знайдено', back: '/stock' },
      { path: `/stock/dispatch-notes/${MISSING}`, says: 'Накладну не знайдено', back: '/stock?tab=notes' },
    ];
    const { ctx, p, errors } = await open(1440);
    const files = [];
    const found = [];
    for (const f of FOUND) {
      await goto(p, f.path);
      await p.waitForTimeout(600);
      const row = { path: f.path, at: new URL(p.url()).pathname + new URL(p.url()).search };
      if (f.heading) row.heading = (await p.getByRole('heading', { level: 1 }).first().textContent().catch(() => null))?.trim() ?? null;
      if (f.tab) row.tab = (await p.getByRole('tab', { selected: true }).filter({ hasText: f.tab }).count()) > 0;
      if (f.text) row.text = (await p.getByText(f.text, { exact: false }).count()) > 0;
      row.crashed = await p.evaluate(() => document.body.innerText.includes('Something went wrong'));
      row.ok = !row.crashed && (f.heading ? row.heading === f.heading : true) && (f.tab ? row.tab : true) && (f.text ? row.text : true);
      found.push(row);
    }
    const gone = [];
    for (const g of GONE) {
      await goto(p, g.path);
      // A missing row is a 404 the page reads once more before it says so.
      await p.getByText(g.says, { exact: false }).first().waitFor({ timeout: 10000 }).catch(() => {});
      const main = p.locator('main');
      const says = (await main.getByText(g.says, { exact: false }).count()) > 0;
      const back = (await main.locator(`a[href="${g.back}"]`).count()) > 0;
      // A 404 is «not found», never the red «could not load» with the server's sentence in it.
      const failed = (await main.getByText('Не вдалося завантажити', { exact: false }).count()) > 0;
      files.push(await shoot(p, `deep-links-gone-${g.back.replace(/[^a-z]/g, '')}`));
      gone.push({ path: g.path, says, back, failed, text: (await main.first().textContent({ timeout: 3000 }).catch(() => null))?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? null });
    }
    await goto(p, '/orders');
    // No route answers /orders: nothing of the app's own renders there.
    const orders = {
      at: new URL(p.url()).pathname,
      main: await p.locator('main').count(),
      text: (await p.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').trim().slice(0, 120),
      newOrder: await p.getByRole('button', { name: 'Нове замовлення', exact: true }).count(),
    };
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: [...FOUND, ...GONE].map((x) => x.path).concat('/orders').join(', '), fixture: [] },
      measured: { found, gone, orders, errors },
      pass: found.every((x) => x.ok) && gone.every((x) => x.says && x.back && !x.failed)
        && orders.at === '/orders' && orders.newOrder === 0 && errors.length === 0,
      screenshots: files,
    };
  });

  // ---------------------------------------------------------------- J: the sweeps (spec J02–J04)
  // The representative set: the orders list (its default view, the table), an order, a product,
  // a customer, the stock and a dispatch note.
  const REP = [
    ['orders', '/projects'],
    ['order', `/projects/${O244}`],
    ['product', `/products/${PR1}`],
    ['customer', `/customers/${CU1}`],
    ['stock', '/stock'],
    ['note', `/stock/dispatch-notes/${N1}`],
  ];
  const REP_URL = REP.map(([, path]) => path).join(', ');
  const crashedOn = (p) => p.evaluate(() => document.body.innerText.includes('Something went wrong'));
  const sheetGround = (p) => p.getByTestId('dispatch-note-sheet').evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => null);
  // One visit of the set: per page the document's horizontal overflow, a crash, a frame — and
  // on the note the sheet's ground, which stays white whatever the theme.
  const sweep = async (p, tag, extra = null) => {
    const rows = [];
    const files = [];
    for (const [name, path] of REP) {
      await goto(p, path);
      await p.waitForTimeout(400);
      const row = { name, overflow: await docOverflow(p), crashed: await crashedOn(p) };
      if (name === 'note') row.sheet = await sheetGround(p);
      if (extra) Object.assign(row, await extra(p, name));
      files.push(await shoot(p, `${tag}-${name}`));
      rows.push(row);
    }
    return { rows, files };
  };
  const sweepOk = (rows) => rows.every((r) => r.overflow <= 0 && !r.crashed && (r.name !== 'note' || r.sheet === 'rgb(255, 255, 255)'));

  for (const w of [2560, 1920, 1440, 1280, 1024, 768, 390]) {
    await scenario(`sweep-widths@${w}`, ['E13-J02'], async () => {
      const { ctx, p, errors } = await open(w);
      const { rows, files } = await sweep(p, `sweep-${w}`);
      const e = await env(p);
      await ctx.close();
      return { env: e, recipe: { url: REP_URL }, measured: { rows, errors }, pass: sweepOk(rows) && errors.length === 0, screenshots: files };
    });
  }

  await scenario('sweep-sidebar', ['E13-J02'], async () => {
    const out = {};
    const files = [];
    const navWidth = (p) => p.evaluate(() => {
      const nav = document.querySelector('aside') ?? document.querySelector('nav');
      return nav ? Math.round(nav.getBoundingClientRect().width) : null;
    });
    for (const [state, w, expanded] of [['collapsed', 1440, 'false'], ['expanded', 1280, 'true']]) {
      const { ctx, p, errors } = await open(w, { storage: { sidebarExpanded: expanded } });
      const run = await sweep(p, `sweep-sidebar-${state}`);
      out[state] = { width: w, nav: await navWidth(p), rows: run.rows, errors };
      files.push(...run.files);
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: REP_URL, storage: ['sidebarExpanded=false at 1440', 'sidebarExpanded=true at 1280'] },
      measured: out,
      pass: sweepOk(out.collapsed.rows) && sweepOk(out.expanded.rows) && out.collapsed.nav < out.expanded.nav
        && out.collapsed.errors.length === 0 && out.expanded.errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('sweep-themes', ['E13-J02'], async () => {
    const out = {};
    const files = [];
    const THEMES = [
      ['light', { storage: { 'theme-mode': 'light' } }, (theme) => !/\bdark\b/.test(theme)],
      ['oled', { settings: { dark_background: 'oled' } }, (theme) => /bg-oled/.test(theme)],
      ['accent', { settings: { dark_accent: 'blue' } }, (theme) => /accent-blue/.test(theme)],
    ];
    for (const [name, opts, test] of THEMES) {
      const { ctx, p, errors } = await open(1440, opts);
      const run = await sweep(p, `sweep-theme-${name}`);
      const e = await env(p);
      out[name] = { theme: e.theme, applied: test(e.theme), rows: run.rows, errors };
      files.push(...run.files);
      await ctx.close();
    }
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: REP_URL, fixture: ['light: theme-mode=light (storage)', 'OLED: GET /settings → dark_background=oled', 'accent: GET /settings → dark_accent=blue (no write)'] },
      measured: out,
      pass: Object.values(out).every((o) => o.applied && sweepOk(o.rows) && o.errors.length === 0),
      screenshots: files,
    };
  });

  await scenario('sweep-en', ['E13-J02'], async () => {
    // English, as the server's language makes it (LanguageSync): every page in English and no
    // raw key on any — a key a locale lacks prints itself.
    const RAW_KEY = /\b(orders|products|customers|stock|common|workshop|pickers|archives|fileManager)\.[a-z][A-Za-z]*(\.[a-zA-Z]+)+\b/;
    const { ctx, p, errors } = await open(1440, { settings: { language: 'en' } });
    const { rows, files } = await sweep(p, 'sweep-en', async (pg) => {
      const text = await pg.evaluate(() => document.body.innerText);
      return { rawKey: text.match(RAW_KEY)?.[0] ?? null, nav: (await pg.locator('a[href="/projects"]').first().textContent())?.trim() ?? null };
    });
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: REP_URL, fixture: ['GET /settings → language=en (no write)'] },
      measured: { rows, errors },
      pass: sweepOk(rows) && rows.every((r) => r.rawKey === null && /^Orders/.test(r.nav ?? '')) && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('sweep-reader', ['E13-J02', 'E13-G02'], async () => {
    // Without the Workshop's write rights the pages hold their shape (the doors are gone, the
    // layout is not broken by their absence).
    const { ctx, p, errors } = await open(1440, { me: READER });
    const { rows, files } = await sweep(p, 'sweep-reader');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: REP_URL, fixture: ['/auth/me: the Administrators’ permissions without the Workshop’s writes'] },
      measured: { rows, errors },
      pass: sweepOk(rows) && errors.length === 0,
      screenshots: files,
    };
  });

  await scenario('nav-active-detail', ['E13-J03'], async () => {
    // S01: a detail page marks its section's item in the sidebar.
    const ROUTES = [
      [`/projects/${O244}`, 'Замовлення'],
      [`/products/${PR1}`, 'Вироби'],
      [`/customers/${CU1}`, 'Замовники'],
      [`/stock/${POS1}`, 'Склад'],
      [`/stock/dispatch-notes/${N1}`, 'Склад'],
    ];
    const { ctx, p, errors } = await open(1440);
    const seen = [];
    for (const [path, item] of ROUTES) {
      await goto(p, path);
      const active = await p.locator('a[aria-current="page"]').evaluateAll((as) => as.map((a) => a.textContent.replace(/\d+/g, '').trim()));
      seen.push({ path, item, active });
    }
    const file = await shoot(p, 'nav-active-detail');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: ROUTES.map(([path]) => path).join(', ') },
      measured: { seen, errors },
      pass: seen.every((s) => s.active.length === 1 && s.active[0] === s.item) && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('nav-badges-server', ['E13-J03'], async () => {
    // S01: the sidebar's figures are the server's (GET /projects/nav-badges), not a list's length
    // — answered here with numbers no list on the stand has.
    const BADGES = { active_orders: 77, draft_products: 13, stock_below_min: 5 };
    const { ctx, p, errors } = await open(1440, { rewrite: [[/\/api\/v1\/projects\/nav-badges\/?(\?.*)?$/, (b) => ({ ...b, ...BADGES })]] });
    await goto(p, '/projects');
    const text = async (href) => (await p.locator(`a[href="${href}"]`).first().textContent())?.replace(/\s+/g, ' ').trim() ?? null;
    const shown = { orders: await text('/projects'), products: await text('/products'), stock: await text('/stock') };
    const rows = await p.locator('[data-order-row], tbody tr').count();
    const file = await shoot(p, 'nav-badges-server');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/projects', fixture: ['GET /projects/nav-badges → active_orders 77, draft_products 13, stock_below_min 5'] },
      measured: { shown, rows, errors },
      pass: /77$/.test(shown.orders ?? '') && /13$/.test(shown.products ?? '') && /5$/.test(shown.stock ?? '') && rows !== 77 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('order-stats-row', ['E13-J04'], async () => {
    // D04: eight tiles in order — ordered / printed / from stock / remaining / printing+queued /
    // ready ≈ / cost / defective — the server's figures; the stock tile shown at 0 too; under
    // them the coverage bar and the secondary stats.
    const f = order244.figures ?? {};
    const ORDER = ['ordered', 'printed', 'from-stock', 'remaining', 'printing', 'ready', 'cost', 'defects'];
    const { ctx, p, errors } = await open(1440);
    await goto(p, `/projects/${O244}`);
    const tiles = await p.locator('[data-testid^="order-tile-"]').evaluateAll((ts) => ts.map((t) => ({
      name: t.dataset.testid.replace('order-tile-', ''), text: t.textContent.replace(/\s+/g, ' ').trim(),
    })));
    const value = (name) => tiles.find((t) => t.name === name)?.text ?? '';
    const expected = {
      ordered: `Замовлено${f.ordered}`, printed: `Надруковано${f.printed}`, 'from-stock': `Зі складу${f.from_stock_units}`,
      remaining: `Лишилось${f.remaining}`, printing: `Друкується / черга${f.prints_in_progress} / ${f.prints_queued}`, defects: `Брак${f.defective}`,
    };
    const mismatches = Object.entries(expected).filter(([name, text]) => value(name) !== text).map(([name]) => name);
    const bar = await p.getByTestId('order-progress-area').count();
    const stats = await p.getByTestId('order-stats').count();
    await p.locator('[data-testid^="order-tile-"]').first().scrollIntoViewIfNeeded();
    const file = await shoot(p, 'order-stats-row');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/projects/{order:244}' },
      measured: { order: tiles.map((t) => t.name), tiles, expected, mismatches, bar, stats, errors },
      pass: same(tiles.map((t) => t.name), ORDER) && mismatches.length === 0 && f.from_stock_units === 0
        && bar === 1 && stats === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('order-activity', ['E13-J04'], async () => {
    // D10: «Активність» — newest first as the server sends it, the sentence, the time and who;
    // ten rows until asked, then all of them.
    const timeline = list(await read(`/projects/${O244}/timeline`));
    const { ctx, p, errors } = await open(1440);
    await goto(p, `/projects/${O244}`);
    const panel = p.getByTestId('order-activity-panel');
    await panel.scrollIntoViewIfNeeded();
    const rows = () => panel.locator('li').evaluateAll((ls) => ls.map((l) => ({
      text: l.querySelector('p')?.textContent.trim() ?? '', meta: l.querySelector('small')?.textContent.trim() ?? '',
    })));
    const first = await rows();
    const file = await shoot(p, 'order-activity');
    const more = panel.getByRole('button', { name: new RegExp(`${Math.max(0, timeline.length - 10)}`) });
    const hasMore = (await more.count()) > 0;
    if (hasMore) await more.click();
    const all = await rows();
    await ctx.close();
    const actors = timeline.map((ev, i) => (typeof ev.metadata?.user_name === 'string' ? i : null)).filter((i) => i != null && i < all.length);
    const newestFirst = timeline.every((ev, i) => i === 0 || ev.timestamp <= timeline[i - 1].timestamp);
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/projects/{order:244} → «Активність»', actions: ['«Показати ще»'] },
      measured: { events: timeline.length, shown: first.length, hasMore, all: all.length, sample: all.slice(0, 3), newestFirst, actors: actors.length, errors },
      pass: timeline.length > 0 && first.length === Math.min(10, timeline.length) && hasMore === timeline.length > 10
        && all.length === timeline.length && newestFirst && all.every((r) => r.text && r.meta)
        && actors.every((i) => all[i].meta.includes(timeline[i].metadata.user_name)) && errors.length === 0,
      screenshots: [file],
    };
  });

  // ---------------------------------------------------------------- K03: the built UI
  await scenario('built-smoke', ['E13-K03'], async () => {
    // The bundle `npm run build` wrote to static/, as the stand's own server hands it out — not
    // Vite: the Workshop's main routes open where they were asked, render their heading, throw
    // nothing and ask nothing the server refuses. The bundle's name carries its content hash.
    const ROUTES = [
      '/projects', `/projects/${O244}`, `/projects/${O241}?section=prints`, '/products', `/products/${PR1}`,
      '/customers', `/customers/${CU1}`, '/stock', '/stock?tab=parts', '/stock?tab=notes', `/stock/${POS1}`,
      `/stock/dispatch-notes/${N1}`, '/archives',
    ];
    const { ctx, p, errors } = await open(1440);
    const consoleErrors = [];
    p.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(String(m.text()).split('\n')[0].slice(0, 160));
    });
    const refused = [];
    p.on('response', (r) => {
      if (r.url().includes('/api/v1/') && r.status() >= 400) refused.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`);
    });
    const seen = [];
    for (const path of ROUTES) {
      await p.goto(`${job.api}${path}`, { waitUntil: 'networkidle' });
      await p.waitForTimeout(500);
      const heading = await p.locator('h1').first().textContent({ timeout: 4000 }).catch(() => null);
      const at = new URL(p.url());
      seen.push({ path, at: at.pathname + at.search, heading: heading ? heading.replace(/\s+/g, ' ').trim().slice(0, 60) : null });
    }
    const built = await p.evaluate(() => ({
      bundle: [...document.querySelectorAll('script[src]')].map((s) => new URL(s.src).pathname).filter((s) => /^\/assets\/index-[\w-]+\.js$/.test(s)),
      vite: performance.getEntriesByType('resource').some((e) => /\/@vite\/client|\/src\/main\.tsx/.test(e.name)),
    }));
    const file = await shoot(p, 'built-smoke-last-route');
    await ctx.close();
    const bounced = seen.filter((s) => s.at.split('?')[0] !== s.path.split('?')[0]);
    return {
      env: { viewport: [1440, 900], origin: 'the stand backend (static/), not Vite' },
      recipe: { url: ROUTES.join(', '), fixture: ['the stand administrator; every write answered here'] },
      measured: { built, seen, bounced, refused: refused.slice(0, 10), consoleErrors: consoleErrors.slice(0, 10), errors },
      pass: built.bundle.length === 1 && built.vite === false && bounced.length === 0 && seen.every((s) => !!s.heading) &&
        refused.length === 0 && consoleErrors.length === 0 && errors.length === 0,
      screenshots: [file],
    };
  });
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
