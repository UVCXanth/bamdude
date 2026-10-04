// WS-13 E6 acceptance runner (spec §I1/I2), run by Playwright MCP's browser_run_code_unsafe:
//   filename: scripts/workshop_stand/e06_detail.js — while `e06_evidence.py serve` listens on 127.0.0.1:8197.
// The harness is E4's (e04_detail.js), unchanged in what it guarantees: every scenario records WHAT was run
// (recipe + fixtures), WHERE (viewport, DPR, the actual <html> classes), WHAT was measured and whether it matched
// the spec — a failure is a failure, a surface it cannot reach is `pending`. Nothing reaches the stand but reads:
// every non-GET request of every context is answered here (the order's PATCH / POST / DELETE, the duplicate, the
// fulfilment batch, the surplus and the take-stock among them), and the states the baseline does not hold are
// rewritten GET answers in this runner's own context only. The oracles measure what a person reads (widths, text,
// where a control sits, whether a click lands), never a class name. The F26 pair is shot here too: the mockup's
// own `docCreated` window over its document, beside the app's window after an answered issue (spec R08).
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
  const HEIGHTS = { 1920: 1080, 1440: 900, 1024: 768, 768: 1024, 761: 800, 760: 800, 390: 844 };
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
      if (sessionStorage.getItem('e06-init')) return;
      sessionStorage.setItem('e06-init', '1');
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
      if (step && step.fail) return route.fulfill({ status: step.fail, json: { detail: 'e06 runner' } });
      const failing = fail.find(([re]) => re.test(url));
      if (failing) return route.fulfill({ status: failing[1], json: { detail: 'e06 runner' } });
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
  // The mockup entities (spec §I1): 241 active with one product line, 244 «qc» with two lines
  // of one product + a parts line and a bankable surplus, 245 completed, 246 a colour outside
  // the palette, 247 five units held, 250 cancelled, 251 without a customer.
  const orderA = await read(`/projects/${A}`);
  const orderB = await read(`/projects/${B}`);
  const groups = await read('/groups/');
  const groupList = Array.isArray(groups) ? groups : (groups.items ?? []);
  const adminPerms = (groupList.find((g) => g.name === 'Administrators') ?? { permissions: [] }).permissions;
  const READER = { is_admin: false, role: 'user', permissions: adminPerms.filter((perm) => perm.endsWith(':read') || !/^(orders|products|customers|stock):/.test(perm)) };
  const C = O['245'];
  const D = O['246'];
  const E = O['247'];
  const X = O['250'];
  const Z = O['251'];
  const DOC = (job.docs ?? {})['90000'];

  // --- doors ---
  const dialog = (p) => p.locator('[role="dialog"]').last();
  const footer = (p) => dialog(p).locator('[data-workshop-dialog-footer]');
  const subtitleOf = (p) => dialog(p).evaluate((d) => {
    const id = d.getAttribute('aria-describedby');
    return id ? (document.getElementById(id)?.textContent ?? null) : null;
  });
  const titleOf = (p) => dialog(p).evaluate((d) => d.querySelector('h2, h3')?.textContent?.trim() ?? null);
  const dialogGone = (p, ms = 8000) => within(p.waitForFunction(() => !document.querySelector('[role="dialog"]')), ms, 'dialog_stayed');
  const frameOf = (p) => dialog(p).evaluate((d) => ({
    width: Math.round(d.getBoundingClientRect().width),
    overlay: Math.round(d.parentElement.getBoundingClientRect().width),
    vw: innerWidth,
  }));
  const expectedWidth = (f, cap, share) => Math.min(cap, share * f.vw, f.overlay - 32);
  const docOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const hitTest = (p, selector) => p.evaluate((sel) => [...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0).map((el) => {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const label = el.closest('label');
    return {
      what: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 40) || el.type,
      inView: r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.width > 0,
      hits: !!hit && (hit === el || el.contains(hit) || (label != null && label.contains(hit))),
    };
  }), selector);
  // The form's labels with their place — the order a person reads, and which share a row.
  const labelsOf = (p) => dialog(p).evaluate((d) => [...d.querySelectorAll('form label')]
    .map((l) => { const r = l.getBoundingClientRect(); return { text: l.textContent.trim(), top: Math.round(r.top), left: Math.round(r.left) }; })
    .filter((l) => l.text));
  const sameRow = (labels, a, b) => {
    const x = labels.find((l) => l.text.startsWith(a));
    const y = labels.find((l) => l.text.startsWith(b));
    return !!x && !!y && Math.abs(x.top - y.top) <= 2 && x.left < y.left;
  };
  const stacked = (labels, a, b) => {
    const x = labels.find((l) => l.text.startsWith(a));
    const y = labels.find((l) => l.text.startsWith(b));
    return !!x && !!y && y.top > x.top + 10 && Math.abs(x.left - y.left) <= 2;
  };
  // The chosen swatch's frame against the dialog's ground — WCAG's 3:1 for a non-text mark
  // (a white frame vanished on the light theme's white panel).
  const chosenSwatchContrast = (p) => dialog(p).evaluate((d) => {
    const rgb = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const input = d.querySelector('[role="radiogroup"] input[type="radio"]:checked');
    const swatch = input && input.nextElementSibling;
    if (!swatch) return null;
    let ground = d;
    while (ground && getComputedStyle(ground).backgroundColor.replace(/\s/g, '') === 'rgba(0,0,0,0)') ground = ground.parentElement;
    const a = lum(rgb(getComputedStyle(swatch).borderTopColor));
    const b = lum(rgb(getComputedStyle(ground ?? document.body).backgroundColor));
    return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
  });
  // Whether the field a person types into first holds the cursor (the mockup's openDialog).
  const focused = (locator) => locator.evaluate((el) => el === document.activeElement);
  // A text's colour against the theme's secondary text colour — the mockup's `.m-confirm`.
  const isSecondaryText = (locator) => locator.evaluate((el) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--text-secondary)';
    document.body.appendChild(probe);
    const want = getComputedStyle(probe).color;
    probe.remove();
    return getComputedStyle(el).color === want;
  });
  const menuTrigger = (scope) => scope.getByRole('button', { name: /^Дії замовлення/ }).first();
  const openMenu = async (p, scope = p) => {
    await menuTrigger(scope).click();
    await p.getByRole('menu').waitFor({ timeout: 5000 });
  };
  const menuItems = (p) => p.getByRole('menu').getByRole('menuitem').allTextContents().then((xs) => xs.map((x) => x.trim()));
  const pick = async (p, name) => {
    await p.getByRole('menu').getByRole('menuitem', { name, exact: true }).click();
    await p.waitForTimeout(500);
  };
  const headerButton = (p, name) => p.getByTestId('order-actions').getByRole('button', { name, exact: true });
  const openEdit = async (p) => {
    await headerButton(p, 'Редагувати').click();
    await dialog(p).waitFor({ timeout: 10000 });
    await p.waitForTimeout(500);
  };
  const openFulfil = async (p) => {
    await p.getByTestId('order-fulfilment').click();
    await dialog(p).locator('table').first().waitFor({ timeout: 10000 });
    await p.waitForTimeout(500);
  };
  const listPage = async (p, view) => {
    await p.goto(`${job.ui}/projects`, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(600);
  };
  const cardOf = (p, id) => p.getByTestId(`order-${id}-card`);
  const toastText = (p, re, ms = 6000) => within(p.waitForFunction((src) => {
    const rx = new RegExp(src);
    return [...document.querySelectorAll('body *')].some((el) => el.children.length === 0 && rx.test(el.textContent ?? ''));
  }, re.source), ms, 'no_toast');
  const ref = (o) => ({ code: o.code, name: o.name });
  const nowIso = () => new Date().toISOString();
  // A write recorder: every non-GET the page sends to a matched path, with its body, answered as asked.
  const recorder = (store, re, answerOf) => [re, async (req) => {
    let body = null;
    try { body = req.postDataJSON(); } catch { body = null; }
    const entry = { method: req.method(), path: new URL(req.url()).pathname, body };
    store.push(entry);
    return answerOf ? answerOf(entry, store.length) : {};
  }];
  const orderAnswer = (o) => (entry) => ({ ...o, ...(entry.body ?? {}), updated_at: nowIso() });
  const FORM_CREATE = ['Назва', 'Замовник', 'Відповідальний', 'Дедлайн', 'Пріоритет', 'Ціна,', 'Теги', 'Колір картки', 'Опис', 'Посилання'];
  const startsInOrder = (labels, expected) => expected.every((e, i) => (labels[i]?.text ?? '').startsWith(e)) && labels.length === expected.length;
  const DETAIL_MENU_ACTIVE = ['Редагувати', 'Дублювати…', 'Склад і видача…', 'Позначити виконаним', 'Скасувати', 'Обкладинка…', 'Видалити'];

  // ======================= 1. the order form (C01–C10) =======================
  for (const w of [1920, 1440, 1024, 768, 761, 760, 390]) {
    await scenario(`form-geometry@${w}`, ['E6-C01', 'E6-C02', 'E6-C03'], async () => {
      const { ctx, p, errors } = await open(w);
      await listPage(p);
      await p.getByRole('button', { name: 'Нове замовлення', exact: true }).first().click();
      await dialog(p).waitFor({ timeout: 10000 });
      await p.waitForTimeout(600);
      const frame = await frameOf(p);
      const want = expectedWidth(frame, 1000, 0.94);
      const nameFocused = await focused(dialog(p).getByLabel('Назва'));
      const labels = await labelsOf(p);
      const radios = await dialog(p).getByRole('radiogroup', { name: 'Колір картки' }).getByRole('radio').evaluateAll((els) => els.map((el) => ({ name: el.getAttribute('aria-label'), checked: el.checked })));
      const overflow = await docOverflow(p);
      const title = await titleOf(p);
      const sub = await subtitleOf(p);
      const file = await shoot(p, `form-geometry@${w}`);
      await ctx.close();
      const wide = w > 760;
      const pairs = [['Замовник', 'Відповідальний'], ['Дедлайн', 'Пріоритет'], ['Ціна,', 'Теги']];
      const layoutOk = pairs.every(([a, b]) => (wide ? sameRow(labels, a, b) : stacked(labels, a, b)));
      return {
        recipe: { url: '/projects', actions: ['«Нове замовлення»'] },
        env: { viewport: [w, HEIGHTS[w]] },
        measured: { frame, want: Math.round(want), nameFocused, labels: labels.map((l) => l.text), layout: wide ? 'pairs' : 'stacked', layoutOk, radios, overflow, title, sub, errors },
        pass: Math.abs(frame.width - want) <= 2 && nameFocused && startsInOrder(labels, FORM_CREATE) && layoutOk && radios.length === 10 &&
          radios[0].name === 'Без кольору' && radios.every((r) => r.name && r.name.trim()) && new Set(radios.map((r) => r.name)).size === radios.length && radios[1].checked &&
          overflow <= 0 && title === 'Нове замовлення' && sub === 'Позиції додаються після створення' && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  for (const w of [1440, 390]) {
    await scenario(`form-edit@${w}`, ['E6-C01', 'E6-C02', 'E6-C06'], async () => {
      const { ctx, p, errors } = await open(w);
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await openEdit(p);
      const labels = await labelsOf(p);
      const title = await titleOf(p);
      const sub = await subtitleOf(p);
      const status = await dialog(p).getByLabel('Статус').evaluate((s) => ({ value: s.value, disabled: [...s.options].filter((o) => o.disabled).map((o) => o.value) }));
      const overflow = await docOverflow(p);
      const file = await shoot(p, `form-edit@${w}`);
      await ctx.close();
      const expected = ['Назва', 'Замовник', 'Відповідальний', 'Контактна особа', 'Дедлайн', 'Пріоритет', 'Ціна,', 'Теги', 'Колір картки', 'Опис', 'Посилання', 'Статус'];
      return {
        recipe: { url: '/projects/{order:241}', actions: ['header «Редагувати»'] },
        measured: { labels: labels.map((l) => l.text), title, sub, status, overflow, errors },
        pass: startsInOrder(labels, expected) && title === 'Редагувати замовлення' && sub === orderA.code &&
          status.value === 'active' && status.disabled.length === 0 && overflow <= 0 && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('form-palette@1440', ['E6-C03', 'K7'], async () => {
    const { ctx, p, errors } = await open(1440);
    await p.goto(detail(D), { waitUntil: 'networkidle' });
    await ready(p);
    await openEdit(p);
    const group = dialog(p).getByRole('radiogroup', { name: 'Колір картки' });
    const before = await group.getByRole('radio').evaluateAll((els) => els.map((el) => ({ name: el.getAttribute('aria-label'), checked: el.checked, value: el.value })));
    // Keyboard: the chosen swatch takes focus, an arrow moves the choice (a native group).
    await group.getByRole('radio', { checked: true }).focus();
    await p.keyboard.press('ArrowRight');
    await p.waitForTimeout(200);
    const after = await group.getByRole('radio').evaluateAll((els) => els.map((el) => el.checked));
    const swatchContrast = await chosenSwatchContrast(p);
    const ring = await p.evaluate(() => {
      const el = document.activeElement;
      const swatch = el && el.nextElementSibling;
      return swatch ? getComputedStyle(swatch).boxShadow : null;
    });
    const file = await shoot(p, 'form-palette@1440');
    await ctx.close();
    const lastChecked = before.length === 11 && before[10].checked;
    return {
      recipe: { url: '/projects/{order:246}', actions: ['header «Редагувати»', 'focus the chosen swatch', 'ArrowRight'] },
      measured: { before, after, ring, swatchContrast, errors },
      pass: lastChecked && before[10].value.toLowerCase() === '#6c6c6c' && after.indexOf(true) !== 10 && after.filter(Boolean).length === 1 &&
        !!ring && ring !== 'none' && swatchContrast != null && swatchContrast >= 3 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('form-responsible-inactive@1440', ['E6-C04'], async () => {
    const gone = orderA.responsible_id;
    const { ctx, p, errors } = await open(1440, {
      rewrite: [[/\/api\/v1\/projects\/assignees/, (b) => (Array.isArray(b) ? b.filter((u) => u.id !== gone) : b)]],
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openEdit(p);
    await p.waitForTimeout(500);
    const select = await dialog(p).getByLabel('Відповідальний').evaluate((s) => ({ value: s.value, text: s.options[s.selectedIndex]?.textContent ?? null }));
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['GET /projects/assignees → without the order\'s responsible (deactivated)'], actions: ['header «Редагувати»'] },
      measured: { gone, select, name: orderA.responsible_name, errors },
      pass: gone != null && select.value === String(gone) && select.text === orderA.responsible_name && errors.length === 0,
    };
  });

  // A refusal is answered as the stand's server would answer it in its system language (uk):
  // the routes' English sentences translated at the boundary (data/api_errors_uk.json).
  await scenario('form-refusals@1440', ['E6-C08', 'I4.4'], async () => {
    const sentPatches = [];
    const answers = [
      { __status: 409, json: { detail: 'Це замовлення саме зараз змінюють — спробуйте ще раз' } },
      { __status: 422, json: { detail: 'Контакт 3 не належить замовнику цього замовлення' } },
      { __status: 403, json: { detail: 'Немає дозволу: orders:update' } },
    ];
    const { ctx, p, errors } = await open(1440, { writes: [recorder(sentPatches, new RegExp(`/api/v1/projects/${A}$`), (_e, n) => answers[n - 1] ?? {})] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openEdit(p);
    const tries = [];
    for (let i = 0; i < 3; i += 1) {
      await dialog(p).getByLabel('Назва').fill(`${orderA.name} ${i + 1}`);
      await footer(p).getByRole('button', { name: 'Зберегти' }).click();
      await dialog(p).getByRole('alert').waitFor({ timeout: 8000 });
      await p.waitForTimeout(400);
      tries.push({
        alert: (await dialog(p).getByRole('alert').textContent())?.trim(),
        name: await dialog(p).getByLabel('Назва').inputValue(),
        focus: await p.evaluate(() => document.activeElement?.textContent?.trim() ?? document.activeElement?.tagName),
        patches: sentPatches.length,
      });
    }
    const file = await shoot(p, 'form-refusals@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['PATCH /projects/{id} → 409, then 422, then 403 (runner)'], actions: ['rename, «Зберегти» ×3'] },
      measured: { tries, errors },
      pass: tries.length === 3 && tries.every((t, i) => t.alert === answers[i].json.detail && t.name === `${orderA.name} ${i + 1}` && t.focus === 'Зберегти' && t.patches === i + 1) && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('form-pending@1440', ['E6-C08', 'I4.6'], async () => {
    let release = () => {};
    const held = new Promise((r) => { release = r; });
    const sentPatches = [];
    const [re, ans] = recorder(sentPatches, new RegExp(`/api/v1/projects/${A}$`), orderAnswer(orderA));
    const { ctx, p, errors } = await open(1440, { writes: [[re, async (req) => { const out = await ans(req); await held; return out; }]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openEdit(p);
    await dialog(p).getByLabel('Назва').fill(`${orderA.name} !`);
    await footer(p).getByRole('button', { name: 'Зберегти' }).click();
    await p.waitForTimeout(400);
    const frozen = {
      save: await footer(p).getByRole('button', { name: /Зберігаю/ }).isDisabled(),
      cancel: await footer(p).getByRole('button', { name: 'Скасувати' }).isDisabled(),
      close: await dialog(p).getByRole('button', { name: 'Закрити' }).isDisabled(),
    };
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    const afterEsc = await dialog(p).isVisible();
    await dialog(p).getByLabel('Назва').press('Enter').catch(() => {});
    await p.waitForTimeout(300);
    const patchesHeld = sentPatches.length;
    release();
    await dialogGone(p);
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['PATCH /projects/{id} → held, then answered'], actions: ['rename', '«Зберегти»', 'Escape', 'Enter'] },
      measured: { frozen, afterEsc, patchesHeld, patches: sentPatches.length, errors },
      pass: frozen.save && frozen.cancel && frozen.close && afterEsc && patchesHeld === 1 && sentPatches.length === 1 && errors.length === 0,
    };
  });

  await scenario('form-create@1440', ['E6-C09', 'K6'], async () => {
    const sent = [];
    const { ctx, p, errors } = await open(1440, { writes: [recorder(sent, /\/api\/v1\/projects\/?$/, () => ({ ...orderA }))] });
    await listPage(p);
    await p.getByRole('button', { name: 'Нове замовлення', exact: true }).first().click();
    await dialog(p).waitFor({ timeout: 10000 });
    await dialog(p).getByLabel('Назва').fill('Корпуси датчиків');
    await footer(p).getByRole('button', { name: 'Створити' }).click();
    await within(p.waitForURL(new RegExp(`/projects/${A}(\\?|$)`)), 10000, 'no_navigation');
    const toast = await toastText(p, /Замовлення створено — додайте позиції/).then(() => true, () => false);
    await ctx.close();
    return {
      recipe: { url: '/projects', fixture: ['POST /projects/ → order 241 (runner)'], actions: ['«Нове замовлення»', 'name', '«Створити»'] },
      measured: { posts: sent.map((s) => s.path), body: sent[0]?.body ?? null, toast, errors },
      pass: sent.length === 1 && sent[0].body?.name === 'Корпуси датчиків' && toast && errors.length === 0,
    };
  });

  await scenario('form-list-read@1440', ['E6-C07'], async () => {
    let seen = 0;
    const { ctx, p, errors } = await open(1440, {
      storage: { 'projects.view': 'cards' },
      gets: [[new RegExp(`/api/v1/projects/${A}$`), () => { seen += 1; return seen <= 2 ? { fail: 500 } : null; }]],
    });
    await listPage(p);
    await openMenu(p, cardOf(p, A));
    await pick(p, 'Редагувати');
    await dialog(p).getByRole('alert').waitFor({ timeout: 10000 });
    const errorText = (await dialog(p).getByRole('alert').textContent())?.trim();
    const saveDisabled = await footer(p).getByRole('button', { name: 'Зберегти' }).isDisabled();
    const fileError = await shoot(p, 'form-list-read-error@1440');
    await dialog(p).getByRole('button', { name: 'Спробувати знову' }).click();
    await dialog(p).getByLabel('Опис').waitFor({ timeout: 8000 });
    const description = await dialog(p).getByLabel('Опис').inputValue();
    const url = await dialog(p).getByLabel('Посилання').inputValue();
    await ctx.close();
    return {
      recipe: { url: '/projects (cards)', fixture: ['GET /projects/{order:241} → 500 twice (the read and the app\'s one retry)'], actions: ['card menu «Редагувати»', '«Спробувати знову»'] },
      measured: { errorText, saveDisabled, description, url, reads: seen, errors },
      pass: /Не вдалося прочитати замовлення/.test(errorText ?? '') && saveDisabled && description === (orderA.description ?? '') && url === (orderA.url ?? '') && seen >= 3 && errors.length === 0,
      screenshots: [fileError],
    };
  });

  await scenario('form-status@1440', ['E6-C06', 'R01', 'B04'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      writes: [recorder(writes, /\/api\/v1\/projects\/\d+$/, (e) => (e.method === 'PATCH' && e.body?.status === 'active'
        ? { __status: 409, json: { detail: 'Склад цього замовлення вже рухався — створіть його копію' } }
        : {}))],
    });
    // a) active → cancelled: no PATCH of a status, the cancel confirmation instead.
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openEdit(p);
    await dialog(p).getByLabel('Статус').selectOption('cancelled');
    const twoSteps = await dialog(p).getByText(/Спершу зберігаються поля/).isVisible();
    await footer(p).getByRole('button', { name: 'Зберегти' }).click();
    await p.waitForTimeout(600);
    const toCancel = await titleOf(p);
    await dialog(p).getByRole('button', { name: 'Не скасовувати' }).click();
    await dialogGone(p);
    // b) active → completed: «Склад і видача», never a PATCH.
    await openEdit(p);
    await dialog(p).getByLabel('Статус').selectOption('completed');
    await footer(p).getByRole('button', { name: 'Зберегти' }).click();
    await dialog(p).locator('table').first().waitFor({ timeout: 10000 });
    const toFulfil = await titleOf(p);
    const fileFulfil = await shoot(p, 'form-status-completed@1440');
    await p.keyboard.press('Escape');
    await dialogGone(p);
    // c) completed: only reopening is offered, and it says why.
    await p.goto(detail(C), { waitUntil: 'networkidle' });
    await ready(p);
    await openEdit(p);
    const completed = await dialog(p).getByLabel('Статус').evaluate((s) => [...s.options].filter((o) => o.disabled).map((o) => o.value));
    const locked = await dialog(p).getByText(/спершу відновіть замовлення/).isVisible();
    await p.keyboard.press('Escape');
    await dialogGone(p);
    // d) cancelled → active: the reopen confirmation; a 409 stays in it, nothing follows.
    await p.goto(detail(X), { waitUntil: 'networkidle' });
    await ready(p);
    await openEdit(p);
    const cancelled = await dialog(p).getByLabel('Статус').evaluate((s) => [...s.options].filter((o) => o.disabled).map((o) => o.value));
    await dialog(p).getByLabel('Статус').selectOption('active');
    await footer(p).getByRole('button', { name: 'Зберегти' }).click();
    await p.waitForTimeout(600);
    const toReopen = await titleOf(p);
    await footer(p).getByRole('button', { name: 'Відновити' }).click();
    await dialog(p).getByRole('alert').waitFor({ timeout: 8000 });
    const refusal = (await dialog(p).getByRole('alert').textContent())?.trim();
    const stillReopen = await titleOf(p);
    const fileRefusal = await shoot(p, 'form-status-reopen-409@1440');
    await ctx.close();
    const statusPatches = writes.filter((w) => w.method === 'PATCH' && w.body && 'status' in w.body);
    return {
      recipe: { url: '/projects/{order:241,245,250}', fixture: ['PATCH status=active → 409 (runner)'], actions: ['form: «Скасоване»', 'form: «Виконане»', 'completed: options', 'cancelled: «Активне» → «Відновити»'] },
      measured: { twoSteps, toCancel, toFulfil, completed, locked, cancelled, toReopen, refusal, stillReopen, statusPatches, errors },
      pass: twoSteps && toCancel === 'Скасувати замовлення?' && toFulfil === 'Склад і видача' && completed.join() === 'cancelled' && locked &&
        cancelled.join() === 'completed' && toReopen === 'Відновити замовлення?' && /Склад цього замовлення вже рухався/.test(refusal ?? '') && stillReopen === 'Відновити замовлення?' &&
        statusPatches.length === 1 && statusPatches[0].body.status === 'active' && errors.length === 0,
      screenshots: [fileFulfil, fileRefusal],
    };
  });

  await scenario('form-session@1440', ['E6-C07', 'R03'], async () => {
    let reads = 0;
    const sent = [];
    const { ctx, p, errors } = await open(1440, {
      storage: { 'projects.view': 'cards' },
      gets: [[new RegExp(`/api/v1/projects/${A}$`), () => { reads += 1; return reads > 1 ? { rewrite: (b) => ({ ...b, name: 'Перейменовано деінде', description: 'Інший опис' }) } : null; }]],
      writes: [recorder(sent, new RegExp(`/api/v1/projects/${A}$`), orderAnswer(orderA))],
    });
    await p.clock.install();
    await listPage(p);
    await openMenu(p, cardOf(p, A));
    await pick(p, 'Редагувати');
    await dialog(p).getByLabel('Опис').waitFor({ timeout: 8000 });
    await dialog(p).getByLabel('Теги').fill('нові, теги');
    await refetchLater(p);
    const after = { reads, name: await dialog(p).getByLabel('Назва').inputValue(), description: await dialog(p).getByLabel('Опис').inputValue(), tags: await dialog(p).getByLabel('Теги').inputValue() };
    await footer(p).getByRole('button', { name: 'Зберегти' }).click();
    await dialogGone(p);
    await ctx.close();
    return {
      recipe: { url: '/projects (cards)', fixture: ['GET /projects/{order:241} → renamed elsewhere from the 2nd read'], actions: ['card menu «Редагувати»', 'tags', 'a minute later', '«Зберегти»'] },
      measured: { after, body: sent[0]?.body ?? null, errors },
      pass: after.reads >= 2 && after.name === orderA.name && after.description === (orderA.description ?? '') && after.tags === 'нові, теги' &&
        sent.length === 1 && JSON.stringify(sent[0].body) === JSON.stringify({ tags: 'нові, теги' }) && errors.length === 0,
    };
  });

  // ======================= 2. duplicate (D01–D04) =======================
  for (const w of [1440, 390]) {
    await scenario(`dup@${w}`, ['E6-D01', 'E6-D02'], async () => {
      const { ctx, p, errors } = await open(w);
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await openMenu(p, p.getByTestId('order-actions'));
      await pick(p, 'Дублювати…');
      await dialog(p).waitFor({ timeout: 8000 });
      const frame = await frameOf(p);
      const want = expectedWidth(frame, 560, 1);
      const measured = {
        title: await titleOf(p),
        sub: await subtitleOf(p),
        nameFocused: await focused(dialog(p).getByLabel('Назва копії')),
        name: await dialog(p).getByLabel('Назва копії').inputValue(),
        text: (await dialog(p).textContent()) ?? '',
        frame,
        want: Math.round(want),
        overflow: await docOverflow(p),
      };
      const file = await shoot(p, `dup@${w}`);
      await ctx.close();
      return {
        recipe: { url: '/projects/{order:241}', actions: ['menu «Дублювати…»'] },
        measured: { ...measured, text: measured.text.slice(0, 400), errors },
        pass: measured.title === 'Дублювати замовлення' && measured.nameFocused && measured.sub === `${orderA.code} · ${orderA.name}` && measured.name === `${orderA.name} (копія)` &&
          /Копіюється: замовник і контакт, позиції з конфігурацією/.test(measured.text) && /Лишається в оригіналі/.test(measured.text) &&
          Math.abs(frame.width - want) <= 2 && measured.overflow <= 0 && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('dup-flow@1440', ['E6-D03', 'E6-D04', 'I4.6'], async () => {
    let release = () => {};
    const held = new Promise((r) => { release = r; });
    const sent = [];
    const [re, ans] = recorder(sent, /\/duplicate$/, () => ({ ...orderB }));
    const { ctx, p, errors } = await open(1440, { storage: { 'projects.view': 'cards' }, writes: [[re, async (req) => { const out = await ans(req); await held; return out; }]] });
    await listPage(p);
    await openMenu(p, cardOf(p, A));
    await pick(p, 'Дублювати…');
    const go = footer(p).getByRole('button', { name: 'Дублювати' });
    await go.click();
    await go.click({ force: true, timeout: 2000 }).catch(() => {});
    await p.waitForTimeout(300);
    const heldCount = sent.length;
    release();
    await within(p.waitForURL(new RegExp(`/projects/${B}(\\?|$)`)), 10000, 'no_navigation');
    await ctx.close();
    return {
      recipe: { url: '/projects (cards)', fixture: ['POST /projects/{id}/duplicate → held, then order 244 (runner)'], actions: ['card menu «Дублювати…»', '«Дублювати» ×2'] },
      measured: { heldCount, posts: sent.map((s) => s.path), body: sent[0]?.body ?? null, errors },
      pass: heldCount === 1 && sent.length === 1 && sent[0].path === `/api/v1/projects/${A}/duplicate` && sent[0].body?.name === `${orderA.name} (копія)` && errors.length === 0,
    };
  });

  await scenario('dup-long-past@1440', ['E6-D02', 'R05', 'R07'], async () => {
    const long = 'н'.repeat(255);
    const yesterday = new Date(Date.now() - 36 * 3600 * 1000).toISOString().slice(0, 10);
    const { ctx, p, errors } = await open(1440, {
      storage: { 'projects.view': 'cards' },
      rewrite: [[/\/api\/v1\/projects\/?\?/, (b) => (b && Array.isArray(b.items)
        ? { ...b, items: b.items.map((o) => (o.id === A ? { ...o, name: long, status: 'completed', stage: 'done', due_date: `${yesterday}T00:00:00` } : o)) }
        : b)]],
    });
    await listPage(p);
    await openMenu(p, cardOf(p, A));
    await pick(p, 'Дублювати…');
    const name = await dialog(p).getByLabel('Назва копії').inputValue();
    const warning = await dialog(p).getByText(/уже минув — змініть його в копії/).isVisible().catch(() => false);
    const enabled = await footer(p).getByRole('button', { name: 'Дублювати' }).isEnabled();
    // The subtitle carries the original's name: one long word wraps, it never scrolls sideways.
    const subtitleBox = await dialog(p).evaluate((d) => {
      const el = document.getElementById(d.getAttribute('aria-describedby') ?? '');
      return el ? { sw: el.scrollWidth, cw: el.clientWidth } : null;
    });
    const file = await shoot(p, 'dup-long-past@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects (cards)', fixture: ['GET /projects/ → order 241 named 255 «н», completed, deadline yesterday'], actions: ['card menu «Дублювати…»'] },
      measured: { length: name.length, tail: name.slice(-10), warning, enabled, subtitleBox, errors },
      pass: name.length <= 255 && name.endsWith(' (копія)') && warning && enabled &&
        !!subtitleBox && subtitleBox.sw <= subtitleBox.cw && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('dup-refusal@1440', ['E6-D03', 'I4.4'], async () => {
    const sent = [];
    const refusal = 'Це замовлення саме зараз змінюють — спробуйте ще раз';
    const { ctx, p, errors } = await open(1440, { writes: [recorder(sent, /\/duplicate$/, () => ({ __status: 409, json: { detail: refusal } }))] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openMenu(p, p.getByTestId('order-actions'));
    await pick(p, 'Дублювати…');
    const nameField = dialog(p).getByLabel('Назва копії');
    await nameField.fill('Друга партія');
    await footer(p).getByRole('button', { name: 'Дублювати' }).click();
    await dialog(p).getByRole('alert').waitFor({ timeout: 8000 });
    await p.waitForTimeout(300);
    const measured = {
      alert: ((await dialog(p).getByRole('alert').textContent()) ?? '').trim(),
      name: await nameField.inputValue(),
      focus: await p.evaluate(() => document.activeElement?.textContent?.trim() ?? null),
      posts: sent.length,
    };
    const file = await shoot(p, 'dup-refusal@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['POST …/duplicate → 409 (runner)'], actions: ['menu «Дублювати…»', 'name', '«Дублювати»'] },
      measured: { ...measured, errors },
      pass: measured.alert === refusal && measured.name === 'Друга партія' && measured.focus === 'Дублювати' && measured.posts === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 3. the action menu and its confirmations (B01–B09) =======================
  for (const w of [1440, 390]) {
    await scenario(`menu-detail@${w}`, ['E6-B02', 'E6-B03', 'O10'], async () => {
      const { ctx, p, errors } = await open(w);
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await openMenu(p, p.getByTestId('order-actions'));
      const items = await menuItems(p);
      const hits = await hitTest(p, '[role="menu"] [role="menuitem"]');
      const file = await shoot(p, `menu-detail@${w}`);
      await ctx.close();
      return {
        recipe: { url: '/projects/{order:241}', actions: ['header menu'] },
        measured: { items, misses: hits.filter((h) => !h.inView || !h.hits), errors },
        pass: JSON.stringify(items) === JSON.stringify(DETAIL_MENU_ACTIVE) && hits.length === items.length && hits.every((h) => h.inView && h.hits) && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('menu-states@1440', ['E6-B02', 'R06'], async () => {
    const { ctx, p, errors } = await open(1440);
    const seen = {};
    for (const [key, id] of [['completed', C], ['cancelled', X], ['noCustomer', Z], ['surplus', B]]) {
      await p.goto(detail(id), { waitUntil: 'networkidle' });
      await ready(p);
      await openMenu(p, p.getByTestId('order-actions'));
      seen[key] = await menuItems(p);
      await p.keyboard.press('Escape');
    }
    await ctx.close();
    const ctx2 = await open(1440, { storage: { 'projects.view': 'cards' } });
    await listPage(ctx2.p);
    await openMenu(ctx2.p, cardOf(ctx2.p, A));
    seen.card = await menuItems(ctx2.p);
    const file = await shoot(ctx2.p, 'menu-card@1440');
    await ctx2.ctx.close();
    const closed = (xs) => xs.includes('Відновити') && !xs.includes('Позначити виконаним') && !xs.includes('Скасувати') && !xs.includes('Склад і видача…');
    return {
      recipe: { url: '/projects/{order:245,250,251,244}, /projects (cards)', actions: ['header menu of each', 'card menu of 241'] },
      measured: { seen, bankable: orderB.figures?.bankable_surplus, errors: [...errors, ...ctx2.errors] },
      pass: closed(seen.completed) && closed(seen.cancelled) && seen.noCustomer.includes('Склад і видача…') &&
        ((orderB.figures?.bankable_surplus ?? 0) > 0 ? seen.surplus.includes('Надлишок у залишок…') : true) &&
        seen.card[0] === 'Відкрити' && !seen.card.includes('Обкладинка…') && errors.length === 0 && ctx2.errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('menu-reader@1440', ['E6-B03', 'R06'], async () => {
    const { ctx, p, errors } = await open(1440, { me: READER });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const detailTrigger = await menuTrigger(p).count();
    const editButton = await p.getByTestId('order-actions').getByRole('button', { name: 'Редагувати', exact: true }).count();
    await ctx.close();
    const ctx2 = await open(1440, { me: READER, storage: { 'projects.view': 'cards' } });
    await listPage(ctx2.p);
    const cardTrigger = await menuTrigger(cardOf(ctx2.p, A)).count();
    await ctx2.ctx.close();
    return {
      recipe: { me: 'projects:read only', url: '/projects/{order:241}, /projects (cards)' },
      measured: { detailTrigger, editButton, cardTrigger, errors: [...errors, ...ctx2.errors] },
      pass: detailTrigger === 0 && editButton === 0 && cardTrigger === 0 && errors.length === 0 && ctx2.errors.length === 0,
    };
  });

  await scenario('menu-workspace@1440', ['E6-B01', 'E6-B02'], async () => {
    const { ctx, p, errors } = await open(1440, { storage: { 'projects.view': 'workspace' } });
    await p.goto(`${job.ui}/projects?order=${A}`, { waitUntil: 'networkidle' });
    await p.waitForSelector('[data-testid="order-view"]', { timeout: 20000 });
    await p.waitForTimeout(600);
    await openMenu(p, p.getByTestId('order-actions'));
    const items = await menuItems(p);
    await ctx.close();
    return {
      recipe: { url: '/projects?order={order:241} (workspace)', actions: ['pane header menu'] },
      measured: { items, errors },
      pass: JSON.stringify(items) === JSON.stringify(DETAIL_MENU_ACTIVE) && errors.length === 0,
    };
  });

  await scenario('menu-lifetime@1440', ['E6-B01', 'E6-B07', 'R02', 'I4.2'], async () => {
    // a) a confirmation outlives its card: the row leaves the list while it is open.
    let drop = false;
    let release = () => {};
    const held = new Promise((r) => { release = r; });
    const sent = [];
    const listRewrite = [/\/api\/v1\/projects\/?\?/, (b) => (drop && b && Array.isArray(b.items) ? { ...b, items: b.items.filter((o) => o.id !== A) } : b)];
    const [re, ans] = recorder(sent, new RegExp(`/api/v1/projects/${A}$`), orderAnswer({ ...orderA, status: 'cancelled' }));
    const { ctx, p, errors } = await open(1440, { storage: { 'projects.view': 'cards' }, rewrite: [listRewrite], writes: [[re, async (req) => { const out = await ans(req); await held; return out; }]] });
    await p.clock.install();
    await listPage(p);
    await openMenu(p, cardOf(p, A));
    await pick(p, 'Скасувати');
    await footer(p).getByRole('button', { name: 'Скасувати замовлення' }).click();
    drop = true;
    await refetchLater(p);
    const rowGone = (await cardOf(p, A).count()) === 0;
    const confirmStays = (await titleOf(p)) === 'Скасувати замовлення?';
    release();
    await dialogGone(p);
    await p.waitForTimeout(400);
    const focus = await p.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.trim() }));
    await ctx.close();
    // b) the dispatch-note window outlives the workspace pane moving to another order.
    let dropB = false;
    const posts = [];
    const docCode = DOC ? (await read(`/stock-issues/${DOC}`)).code : null;
    const listRewriteB = [/\/api\/v1\/projects\/?\?/, (b) => (dropB && b && Array.isArray(b.items) ? { ...b, items: b.items.filter((o) => o.id !== A) } : b)];
    const ctxB = await open(1440, {
      storage: { 'projects.view': 'workspace' },
      rewrite: [listRewriteB],
      writes: [recorder(posts, /\/fulfilment$/, () => { dropB = true; return { order: orderA, issue_id: DOC, issue_code: docCode, issue_units: 3 }; })],
    });
    await ctxB.p.goto(`${job.ui}/projects?order=${A}`, { waitUntil: 'networkidle' });
    await ctxB.p.waitForSelector('[data-testid="order-view"]', { timeout: 20000 });
    await openMenu(ctxB.p, ctxB.p.getByTestId('order-actions'));
    await pick(ctxB.p, 'Склад і видача…');
    await dialog(ctxB.p).locator('table').first().waitFor({ timeout: 10000 });
    await footer(ctxB.p).getByRole('button', { name: 'Виконати' }).click();
    await within(ctxB.p.waitForFunction(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => /Накладну оформлено/.test(d.textContent ?? ''))), 10000, 'no_note_window');
    await ctxB.p.waitForTimeout(1200); // the lists are read again; the pane moves on
    // Recorded, not required: whether the pane already left the order is the list's business.
    const paneMoved = !((await ctxB.p.getByTestId('order-view').first().textContent().catch(() => '')) ?? '').includes(orderA.name);
    const noteStays = await ctxB.p.getByRole('button', { name: 'Відкрити й друкувати' }).isVisible();
    await ctxB.p.getByRole('button', { name: 'Відкрити й друкувати' }).click();
    await within(ctxB.p.waitForURL(new RegExp(`/stock/dispatch-notes/${DOC}(\\?|$)`)), 10000, 'no_note_page');
    await ctxB.ctx.close();
    return {
      recipe: { url: '/projects (cards), /projects?order={order:241} (workspace)', fixture: ['PATCH held; the list drops 241 meanwhile', 'POST …/fulfilment → note {doc:90000}; the list drops 241'], actions: ['card menu «Скасувати» → «Скасувати замовлення»', 'pane «Склад і видача…» → «Виконати» → «Відкрити й друкувати»'] },
      measured: { rowGone, confirmStays, focus, sent: sent.length, posts: posts.length, paneMoved, noteStays, errors: [...errors, ...ctxB.errors] },
      pass: !!DOC && rowGone && confirmStays && focus.tag === 'H1' && focus.text === 'Замовлення' && sent.length === 1 && posts.length === 1 && noteStays &&
        errors.length === 0 && ctxB.errors.length === 0,
    };
  });

  // B07 (final review I1): a dialog that swaps for another — the form after its reading shell,
  // «Stock & issue» after its own, a confirmation after the form — hands focus back to the card's trigger.
  await scenario('menu-focus-return@1440', ['E6-B07'], async () => {
    const { ctx, p, errors } = await open(1440, { storage: { 'projects.view': 'cards' } });
    await listPage(p);
    const card = cardOf(p, A);
    const focusedLabel = () => p.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? null);
    const back = {};
    await openMenu(p, card);
    await pick(p, 'Склад і видача…');
    await dialog(p).locator('table').first().waitFor({ timeout: 10000 });
    await footer(p).getByRole('button', { name: 'Скасувати' }).click();
    await dialogGone(p);
    await p.waitForTimeout(300);
    back.fulfil = await focusedLabel();
    await openMenu(p, card);
    await pick(p, 'Редагувати');
    await dialog(p).getByLabel('Опис').waitFor({ timeout: 10000 });
    await footer(p).getByRole('button', { name: 'Скасувати' }).click();
    await dialogGone(p);
    await p.waitForTimeout(300);
    back.edit = await focusedLabel();
    await openMenu(p, card);
    await pick(p, 'Редагувати');
    await dialog(p).getByLabel('Опис').waitFor({ timeout: 10000 });
    await dialog(p).getByLabel('Статус').selectOption('cancelled');
    await footer(p).getByRole('button', { name: 'Зберегти' }).click();
    await within(p.waitForFunction(() => /Скасувати замовлення\?/.test(document.querySelector('[role="dialog"]')?.textContent ?? '')), 8000, 'no_confirm');
    await footer(p).getByRole('button', { name: 'Не скасовувати' }).click();
    await dialogGone(p);
    await p.waitForTimeout(300);
    back.chain = await focusedLabel();
    await ctx.close();
    const want = `Дії замовлення ${orderA.code}`;
    return {
      recipe: { url: '/projects (cards)', actions: ['card menu «Склад і видача…» → «Скасувати»', 'card menu «Редагувати» → «Скасувати»', 'card menu «Редагувати» → «Скасоване» → «Зберегти» → «Не скасовувати»'] },
      measured: { back, want, errors },
      pass: back.fulfil === want && back.edit === want && back.chain === want && errors.length === 0,
    };
  });

  await scenario('menu-confirms@1440', ['E6-B05', 'F27'], async () => {
    const { ctx, p, errors } = await open(1440);
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const read3 = async () => ({
      title: await titleOf(p),
      sub: await subtitleOf(p),
      text: ((await dialog(p).textContent()) ?? '').slice(0, 300),
      buttons: await footer(p).getByRole('button').allTextContents(),
      secondary: await isSecondaryText(dialog(p).locator('p').last()),
    });
    await openMenu(p, p.getByTestId('order-actions'));
    await pick(p, 'Скасувати');
    const cancel = await read3();
    const fileCancel = await shoot(p, 'confirm-cancel@1440');
    await footer(p).getByRole('button', { name: 'Не скасовувати' }).click();
    await dialogGone(p);
    await openMenu(p, p.getByTestId('order-actions'));
    await pick(p, 'Видалити');
    const del = await read3();
    const fileDelete = await shoot(p, 'confirm-delete@1440');
    await footer(p).getByRole('button', { name: 'Скасувати' }).click();
    await dialogGone(p);
    await p.goto(detail(X), { waitUntil: 'networkidle' });
    await ready(p);
    await openMenu(p, p.getByTestId('order-actions'));
    await pick(p, 'Відновити');
    const reopen = await read3();
    await ctx.close();
    const subA = `${orderA.code} · ${orderA.name}`;
    return {
      recipe: { url: '/projects/{order:241,250}', actions: ['menu «Скасувати»', 'menu «Видалити»', 'menu «Відновити» (cancelled)'] },
      measured: { cancel, del, reopen, errors },
      pass: cancel.title === 'Скасувати замовлення?' && cancel.sub === subA && /видане лишається виданим/.test(cancel.text) &&
        JSON.stringify(cancel.buttons.map((b) => b.trim())) === JSON.stringify(['Не скасовувати', 'Скасувати замовлення']) &&
        del.title === 'Видалити замовлення?' && /видачі лишаться в замовника/.test(del.text) &&
        reopen.title === 'Відновити замовлення?' && /Резерви складу не повертаються/.test(reopen.text) &&
        cancel.secondary && del.secondary && reopen.secondary && errors.length === 0,
      screenshots: [fileCancel, fileDelete],
    };
  });

  await scenario('board-drop@1440', ['E6-B04'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, { storage: { 'projects.view': 'kanban' }, writes: [recorder(writes, /\/api\/v1\/projects\//)] });
    await listPage(p);
    const handle = p.getByRole('button', { name: `Перемістити ${orderA.code}` });
    await handle.waitFor({ timeout: 10000 });
    await handle.focus();
    await p.keyboard.press('Space');
    await p.waitForTimeout(250);
    await p.keyboard.press('ArrowRight');
    await p.waitForTimeout(250);
    await p.keyboard.press('ArrowRight');
    await p.waitForTimeout(250);
    await p.keyboard.press('Space');
    await dialog(p).locator('table').first().waitFor({ timeout: 10000 });
    const title = await titleOf(p);
    const close = await dialog(p).getByRole('checkbox', { name: 'Позначити замовлення виконаним' }).count();
    await ctx.close();
    return {
      recipe: { url: '/projects (kanban)', actions: [`keyboard: pick ${orderA.code}, → →, drop on «Готово»`] },
      measured: { title, close, writes: writes.map((w) => `${w.method} ${w.path}`), errors },
      pass: title === 'Склад і видача' && close === 1 && writes.length === 0 && errors.length === 0,
    };
  });

  // ======================= 4. Stock & issue (E01–E16) and the note window (E15) =======================
  for (const w of [1920, 1440, 1024, 390]) {
    await scenario(`f06-geometry@${w}`, ['E6-E01', 'E6-E04', 'E6-E05', 'E6-E16'], async () => {
      const { ctx, p, errors } = await open(w);
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await openFulfil(p);
      const frame = await frameOf(p);
      const want = expectedWidth(frame, 1560, 0.95);
      const heads = await dialog(p).locator('thead th').allTextContents();
      const row = dialog(p).locator('tbody tr').first();
      const rowText = (await row.textContent()) ?? '';
      const ofN = await row.getByText(/^з \d+$/).count();
      const accent = await row.locator('[data-config-accent]').allTextContents();
      const focus = await p.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
      const scroll = await dialog(p).locator('[role="region"]').first().evaluate((el) => ({ own: el.scrollWidth > el.clientWidth, sw: el.scrollWidth, cw: el.clientWidth }));
      const sub = await subtitleOf(p);
      const overflow = await docOverflow(p);
      const files = [await shoot(p, `f06-geometry@${w}`)];
      if (w === 390) {
        await dialog(p).locator('[role="region"]').first().evaluate((el) => { el.scrollLeft = el.scrollWidth; });
        files.push(await shoot(p, `f06-geometry@${w}-right`));
      }
      await ctx.close();
      return {
        recipe: { url: '/projects/{order:241}', actions: ['header «Склад і видача…»'] },
        measured: { frame, want: Math.round(want), heads: heads.map((h) => h.trim()), rowText: rowText.slice(0, 200), ofN, accent, focus, scroll, sub, overflow, errors },
        pass: Math.abs(frame.width - want) <= 2 && heads[0].trim() === 'Позиція / конфігурація' && heads.map((h) => h.trim()).includes('Видати зараз') &&
          ofN >= 1 && /стандартна|:/.test(rowText) && accent.length === 1 && /:/.test(accent[0]) && !!focus && /—/.test(focus) && sub === `${orderA.code} · ${orderA.name} · ${orderA.customer_name}` &&
          overflow <= 0 && errors.length === 0,
        screenshots: files,
      };
    });
  }

  await scenario('f06-244@1440', ['E6-E05', 'E6-E06', 'K8'], async () => {
    const { ctx, p, errors } = await open(1440);
    await p.goto(detail(B), { waitUntil: 'networkidle' });
    await ready(p);
    await openFulfil(p);
    const rows = await dialog(p).locator('tbody tr[data-testid^="fulfil-line-"]').evaluateAll((trs) => trs.map((tr) => ({ id: tr.dataset.testid, caption: tr.querySelector('td small')?.textContent?.trim() ?? null, text: tr.textContent.slice(0, 160) })));
    const productCaptions = rows.filter((r) => !/лише деталі/.test(r.text)).map((r) => r.caption);
    const partsRow = dialog(p).locator('tbody tr[data-testid^="fulfil-line-"]').filter({ hasText: 'лише деталі' }).first();
    const all = partsRow.getByRole('checkbox').first();
    const allCount = await partsRow.getByRole('checkbox').count();
    let states = [];
    if (allCount > 0) {
      const before = await all.isChecked();
      await all.click();
      const cleared = await all.isChecked();
      const firstPart = dialog(p).locator('input[type="number"][aria-label^="Оприбуткувати надруковане — "]').last();
      await firstPart.fill('1');
      await p.waitForTimeout(200);
      const mixed = await all.evaluate((el) => el.indeterminate);
      states = [before, cleared, mixed];
    }
    const file = await shoot(p, 'f06-244@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:244}', actions: ['header «Склад і видача…»', '«усі N дет.» off', 'one part 1'] },
      measured: { rows, productCaptions, allCount, states, errors },
      pass: productCaptions.length >= 2 && new Set(productCaptions).size === productCaptions.length && rows.some((r) => /лише деталі — через книгу деталей/.test(r.text)) &&
        (allCount === 0 || (states[0] === true && states[1] === false && states[2] === true)) && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('f06-251@1440', ['E6-E11', 'E04'], async () => {
    const { ctx, p, errors } = await open(1440);
    await p.goto(detail(Z), { waitUntil: 'networkidle' });
    await ready(p);
    await openMenu(p, p.getByTestId('order-actions'));
    await pick(p, 'Склад і видача…');
    await dialog(p).locator('table').first().waitFor({ timeout: 10000 });
    const heads = (await dialog(p).locator('thead th').allTextContents()).map((h) => h.trim());
    const text = (await dialog(p).textContent()) ?? '';
    const recipient = await dialog(p).getByLabel("Ім'я одержувача").count();
    const close = await dialog(p).getByRole('checkbox', { name: 'Закрити на склад' }).count();
    const sub = await subtitleOf(p);
    const file = await shoot(p, 'f06-251@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:251}', actions: ['menu «Склад і видача…»'] },
      measured: { heads, recipient, close, sub, errors },
      pass: !heads.includes('Видати зараз') && recipient === 0 && close === 1 && /Замовник не вказаний — нічого не видається/.test(text) && /без замовника$/.test(sub ?? '') && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('f06-writeoff@1440', ['E6-E03', 'E6-E07', 'E6-E12'], async () => {
    const { ctx, p, errors } = await open(1440);
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openFulfil(p);
    const toggle = dialog(p).getByRole('button', { name: 'Списати…' });
    const closed = await toggle.getAttribute('aria-expanded');
    await toggle.click();
    const opened = await toggle.getAttribute('aria-expanded');
    const controls = await toggle.getAttribute('aria-controls');
    // E03: the toggle controls the column (the table) and the reason — a list of ids.
    const controlled = await p.evaluate((ids) => (ids ?? '').split(' ').map((id) => document.getElementById(id)).filter(Boolean).map((el) => ({
      tag: el.tagName,
      reason: !!el.querySelector('input:not([type="number"])'),
      column: !!el.querySelector('input[aria-label^="Списати — "]'),
    })), controls);
    const reasonInside = controlled.some((c) => c.reason);
    const columnControlled = controlled.some((c) => c.tag === 'TABLE' && c.column);
    const wo = dialog(p).locator('input[aria-label^="Списати — "]').first();
    await wo.fill('1');
    const noReason = await footer(p).getByRole('button', { name: 'Виконати' }).isDisabled();
    await dialog(p).getByLabel('Причина списання').fill('впала з полиці');
    const withReason = await footer(p).getByRole('button', { name: 'Виконати' }).isEnabled();
    const summary = (await footer(p).textContent()) ?? '';
    const file = await shoot(p, 'f06-writeoff@1440');
    await toggle.click();
    const gone = (await dialog(p).locator('input[aria-label^="Списати — "]').count()) === 0 && (await dialog(p).getByLabel('Причина списання').count()) === 0;
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', actions: ['«Списати…»', 'write off 1', 'reason', '«Списати…» again'] },
      measured: { closed, opened, controlled, reasonInside, columnControlled, noReason, withReason, summary: summary.slice(0, 160), gone, errors },
      pass: closed === 'false' && opened === 'true' && reasonInside && columnControlled && noReason && withReason && /списати: 1/.test(summary) && gone && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('f06-close-mark@1440', ['E6-E09', 'R09'], async () => {
    const { ctx, p, errors } = await open(1440);
    await p.goto(detail(E), { waitUntil: 'networkidle' });
    await ready(p);
    await openMenu(p, p.getByTestId('order-actions'));
    await pick(p, 'Склад і видача…');
    await dialog(p).locator('table').first().waitFor({ timeout: 10000 });
    const box = dialog(p).getByRole('checkbox', { name: 'Позначити замовлення виконаним' });
    const partial = { disabled: await box.isDisabled(), checked: await box.isChecked(), suffix: ((await dialog(p).textContent()) ?? '').match(/після цієї видачі буде \d+ з \d+/)?.[0] ?? null };
    const performer = ((await dialog(p).getByTestId('fulfil-performer').textContent()) ?? '').trim();
    const filePartial = await shoot(p, 'f06-close-mark-partial@1440');
    await ctx.close();
    // A first full batch ticks closing once (the state answers as if everything is on the shelf).
    const full = await open(1440, {
      rewrite: [[new RegExp(`/api/v1/projects/${E}/fulfilment$`), (s) => ({ ...s, lines: s.lines.map((l) => ({ ...l, ordered: l.held + l.can_assemble + l.can_receive + l.issued })), ordered: s.lines.reduce((n, l) => n + l.held + l.can_assemble + l.can_receive + l.issued, 0) })]],
    });
    await full.p.goto(detail(E), { waitUntil: 'networkidle' });
    await ready(full.p);
    await openMenu(full.p, full.p.getByTestId('order-actions'));
    await pick(full.p, 'Склад і видача…');
    await dialog(full.p).locator('table').first().waitFor({ timeout: 10000 });
    const auto = await dialog(full.p).getByRole('checkbox', { name: 'Позначити замовлення виконаним' }).isChecked();
    await full.ctx.close();
    return {
      recipe: { url: '/projects/{order:247}', fixture: ['GET …/fulfilment → every line ordered = what is on the shelf or comes'], actions: ['menu «Склад і видача…»'] },
      measured: { partial, performer, auto, errors: [...errors, ...full.errors] },
      pass: partial.disabled && !partial.checked && !!partial.suffix && /^Виконує/.test(performer) && auto && errors.length === 0 && full.errors.length === 0,
      screenshots: [filePartial],
    };
  });

  await scenario('f06-read-error@1440', ['E6-E02'], async () => {
    let n = 0;
    const { ctx, p, errors } = await open(1440, {
      storage: { 'projects.view': 'cards' },
      gets: [[new RegExp(`/api/v1/projects/${A}/fulfilment$`), () => { n += 1; return n <= 2 ? { fail: 500 } : null; }]],
    });
    // From a list nothing has read the state yet (the order page's header does, and the dialog
    // there opens on its cache): the dialog's read and the app's one retry both fail.
    await listPage(p);
    await openMenu(p, cardOf(p, A));
    await pick(p, 'Склад і видача…');
    await dialog(p).getByRole('button', { name: 'Спробувати знову' }).waitFor({ timeout: 10000 });
    const failed = {
      text: ((await dialog(p).getByRole('alert').textContent()) ?? '').trim(),
      submit: await footer(p).getByRole('button', { name: 'Виконати' }).isDisabled(),
    };
    const fileError = await shoot(p, 'f06-read-error@1440');
    await dialog(p).getByRole('button', { name: 'Спробувати знову' }).click();
    await dialog(p).locator('table').first().waitFor({ timeout: 10000 });
    await ctx.close();
    return {
      recipe: { url: '/projects (cards)', fixture: ['GET /projects/{order:241}/fulfilment → 500 twice (the read and the app\'s one retry)'], actions: ['card menu «Склад і видача…»', '«Спробувати знову»'] },
      measured: { reads: n, failed, errors },
      pass: /Не вдалося прочитати склад замовлення/.test(failed.text) && failed.submit && n >= 3 && errors.length === 0,
      screenshots: [fileError],
    };
  });

  await scenario('f06-refusal@1440', ['E6-E13', 'R04', 'I4.4'], async () => {
    let n = 0;
    const posts = [];
    const narrow = (s) => ({ ...s, lines: s.lines.map((l, i) => (i === 0 ? { ...l, can_receive: Math.min(1, l.can_receive), can_assemble: 0 } : l)) });
    const { ctx, p, errors } = await open(1440, {
      gets: [[new RegExp(`/api/v1/projects/${A}/fulfilment$`), () => {
        n += 1;
        if (n === 1) return null; // the dialog's read
        if (n <= 3) return { delay: 1500, fail: 500 }; // the re-read after the refusal and its retry: slow, failing
        return { rewrite: narrow };
      }]],
      writes: [recorder(posts, /\/fulfilment$/, () => ({ __status: 409, json: { detail: '«Корпус датчика клімату»: оприбуткувати можна лише 1' } }))],
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openFulfil(p);
    await footer(p).getByRole('button', { name: 'Виконати' }).click();
    await dialog(p).getByRole('alert').waitFor({ timeout: 8000 });
    const reading = await dialog(p).getByText('Перечитую стан…').isVisible().catch(() => false);
    const lockedWhileReading = await footer(p).getByRole('button', { name: 'Виконати' }).isDisabled();
    await footer(p).getByRole('button', { name: 'Виконати' }).click({ force: true, timeout: 1000 }).catch(() => {});
    await dialog(p).getByRole('button', { name: 'Прочитати знову' }).waitFor({ timeout: 8000 });
    const fileFailed = await shoot(p, 'f06-refusal-reread-failed@1440');
    await dialog(p).getByRole('button', { name: 'Прочитати знову' }).click();
    await dialog(p).getByText('Склад змінився — числа обмежено новими межами.').waitFor({ timeout: 8000 });
    const receive = await dialog(p).locator('input[aria-label^="Оприбуткувати надруковане — "]').first().inputValue();
    const unlocked = await footer(p).getByRole('button', { name: 'Виконати' }).isEnabled();
    const fileTrimmed = await shoot(p, 'f06-refusal-trimmed@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['POST …/fulfilment → 409', 'the re-read and its retry → 1.5 s each, then 500', 'the next read → line 1 can receive 1'], actions: ['«Виконати»', 'press again while reading', '«Прочитати знову»'] },
      measured: { reads: n, posts: posts.length, reading, lockedWhileReading, receive, unlocked, errors },
      pass: posts.length === 1 && reading && lockedWhileReading && receive === '1' && unlocked && errors.length === 0,
      screenshots: [fileFailed, fileTrimmed],
    };
  });

  await scenario('f06-trim@1440', ['E6-E13', 'R04'], async () => {
    let n = 0;
    const at = (cap) => (s) => ({ ...s, lines: s.lines.map((l, i) => (i === 0 ? { ...l, can_receive: cap, can_assemble: 0 } : l)) });
    const { ctx, p, errors } = await open(1440, {
      gets: [[new RegExp(`/api/v1/projects/${A}/fulfilment$`), () => { n += 1; return { rewrite: at(n === 2 ? 6 : 10) }; }]],
    });
    await p.clock.install();
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openFulfil(p);
    const field = dialog(p).locator('input[aria-label^="Оприбуткувати надруковане — "]').first();
    const first = await field.inputValue();
    await refetchLater(p);
    const second = await field.inputValue();
    await refetchLater(p);
    const third = await field.inputValue();
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['GET …/fulfilment → line 1 can receive 10, then 6, then 10'], actions: ['open', 'a minute later', 'a minute later'] },
      measured: { reads: n, values: [first, second, third], errors },
      pass: first === '10' && second === '6' && third === '6' && n >= 3 && errors.length === 0,
    };
  });

  await scenario('f06-pending@1440', ['E6-E01', 'E6-E13', 'I4.6'], async () => {
    let release = () => {};
    const held = new Promise((r) => { release = r; });
    const posts = [];
    const [re, ans] = recorder(posts, /\/fulfilment$/, () => ({ order: orderA, issue_id: null, issue_code: null, issue_units: null }));
    const { ctx, p, errors } = await open(1440, { writes: [[re, async (req) => { const out = await ans(req); await held; return out; }]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openFulfil(p);
    await footer(p).getByRole('button', { name: 'Виконати' }).click();
    await p.waitForTimeout(300);
    const frozen = {
      working: await footer(p).getByRole('button', { name: 'Виконую…' }).isDisabled(),
      cancel: await footer(p).getByRole('button', { name: 'Скасувати' }).isDisabled(),
      close: await dialog(p).getByRole('button', { name: 'Закрити' }).isDisabled(),
    };
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    const stays = await dialog(p).isVisible();
    const heldPosts = posts.length;
    release();
    await dialogGone(p);
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['POST …/fulfilment → held, then no issue'], actions: ['«Виконати»', 'Escape'] },
      measured: { frozen, stays, heldPosts, posts: posts.length, errors },
      pass: frozen.working && frozen.cancel && frozen.close && stays && heldPosts === 1 && posts.length === 1 && errors.length === 0,
    };
  });

  // The note window and its pair (E15, R08): the mockup's `docCreated` over its own document,
  // the app's window over the stand's note with the same units.
  const mockupNote = async (w) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: HEIGHTS[w] || 900 }, deviceScaleFactor: 1, locale: 'uk-UA', timezoneId: 'Europe/Kyiv', serviceWorkers: 'block' });
    live.set(ctx, { routeErrors: [], closing: false, pages: [] });
    await ctx.addInitScript(({ key, value }) => { if (!sessionStorage.getItem('e06-mock')) { sessionStorage.setItem('e06-mock', '1'); localStorage.clear(); localStorage.setItem(key, value); } }, { key: job.mockup_pref_key, value: job.mockup_pref });
    const p = await ctx.newPage();
    live.get(ctx).pages.push(p);
    await p.goto(`${job.mockup}#/orders/241`);
    await p.waitForTimeout(800);
    const info = await p.evaluate('(() => { const d = DOC(90000); docCreated(d); return { no: d.no, units: docItemsTotal(d) }; })()');
    await p.waitForTimeout(400);
    const file = await shoot(p, `f26-mockup@${w}`);
    await closeContext(ctx);
    return { info, file };
  };
  for (const w of [1440, 390]) {
    await scenario(`f26-pair@${w}`, ['E6-E15', 'R08', 'F26'], async () => {
      const mock = await mockupNote(w);
      const note = DOC ? await read(`/stock-issues/${DOC}`) : null;
      const posts = [];
      const { ctx, p, errors } = await open(w, { writes: [recorder(posts, /\/fulfilment$/, () => ({ order: orderA, issue_id: DOC, issue_code: note?.code ?? null, issue_units: mock.info.units }))] });
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await openFulfil(p);
      await footer(p).getByRole('button', { name: 'Виконати' }).click();
      await within(p.waitForFunction(() => [...document.querySelectorAll('[role="dialog"]')].some((d) => /Накладну оформлено/.test(d.textContent ?? ''))), 10000, 'no_note_window');
      await p.waitForTimeout(400);
      const sub = await subtitleOf(p);
      const focus = await p.evaluate(() => document.activeElement?.textContent?.trim() ?? null);
      const secondary = await isSecondaryText(dialog(p).locator('p').last());
      const file = await shoot(p, `f26-app@${w}`);
      await p.getByRole('button', { name: 'Відкрити й друкувати' }).click();
      await within(p.waitForURL(new RegExp(`/stock/dispatch-notes/${DOC}(\\?|$)`)), 10000, 'no_note_page');
      await ctx.close();
      return {
        recipe: { mockup: '#/orders/241 + docCreated(DOC(90000))', url: '/projects/{order:241}', fixture: ['POST …/fulfilment → note {doc:90000} with the mockup note\'s units'], actions: ['«Склад і видача…»', '«Виконати»', '«Відкрити й друкувати»'] },
        measured: { mockup: mock.info, sub, focus, secondary, posts: posts.length, errors },
        pass: !!DOC && !!note && sub === `${note.code} · ${mock.info.units} од.` && focus === 'Відкрити й друкувати' && secondary && posts.length === 1 && errors.length === 0,
        screenshots: [mock.file, file],
        pair: { mockup: [mock.file], app: [file] },
      };
    });
  }

  // ======================= 5. surplus and take-stock (F01–F02) =======================
  await scenario('bank-244@1440', ['E6-F01', 'H01', 'K9'], async () => {
    const posts = [];
    const { ctx, p, errors } = await open(1440, {
      writes: [recorder(posts, /\/bank-surplus$/, (_e, k) => (k === 1
        ? { moved: [{ part_id: 1, name: 'деталь', delta: orderB.figures?.bankable_surplus ?? 1 }], nothing_to_bank: false }
        : { moved: [], nothing_to_bank: true }))],
    });
    await p.goto(detail(B), { waitUntil: 'networkidle' });
    await ready(p);
    await p.getByTestId('order-bank-surplus').click();
    await dialog(p).waitFor({ timeout: 8000 });
    const total = orderB.figures?.bankable_surplus ?? 0;
    const title = await titleOf(p);
    const rows = await dialog(p).locator('tbody tr').count();
    const expectedRows = (orderB.lines ?? []).flatMap((l) => (l.parts ?? []).filter((pt) => (pt.bankable ?? 0) > 0)).length;
    const button = footer(p).getByRole('button', { name: `Перенести (${total})` });
    const fileDialog = await shoot(p, 'bank-244@1440');
    await button.click();
    await button.click({ force: true, timeout: 1000 }).catch(() => {});
    await dialogGone(p);
    const doneToast = await toastText(p, /→ у залишок/).then(() => true, () => false);
    await p.getByTestId('order-bank-surplus').click();
    await footer(p).getByRole('button', { name: `Перенести (${total})` }).click();
    await dialogGone(p);
    const nothingToast = await toastText(p, /Нічого списувати/).then(() => true, () => false);
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:244}', fixture: ['POST …/bank-surplus → moved, then nothing_to_bank (runner)'], actions: ['header bank', '«Перенести (N)» ×2', 'again'] },
      measured: { title, total, rows, expectedRows, posts: posts.length, doneToast, nothingToast, errors },
      pass: title === 'Надлишок у вільний залишок' && total > 0 && rows === expectedRows && posts.length === 2 && doneToast && nothingToast && errors.length === 0,
      screenshots: [fileDialog],
    };
  });

  await scenario('bank-refusal@1440', ['E6-F01', 'I4.4'], async () => {
    const sent = [];
    const refusal = 'Запаси замовлення змінилися, поки зміну зберігали — спробуйте ще раз';
    const { ctx, p, errors } = await open(1440, { writes: [recorder(sent, /\/bank-surplus$/, () => ({ __status: 409, json: { detail: refusal } }))] });
    await p.goto(detail(B), { waitUntil: 'networkidle' });
    await ready(p);
    await p.getByTestId('order-bank-surplus').click();
    await dialog(p).waitFor({ timeout: 8000 });
    const total = orderB.figures?.bankable_surplus ?? 0;
    await footer(p).getByRole('button', { name: `Перенести (${total})` }).click();
    await dialog(p).getByRole('alert').waitFor({ timeout: 8000 });
    await p.waitForTimeout(300);
    const measured = {
      alert: ((await dialog(p).getByRole('alert').textContent()) ?? '').trim(),
      title: await titleOf(p),
      focus: await p.evaluate(() => document.activeElement?.textContent?.trim() ?? null),
      posts: sent.length,
    };
    const file = await shoot(p, 'bank-refusal@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:244}', fixture: ['POST …/bank-surplus → 409 (runner)'], actions: ['header bank', '«Перенести (N)»'] },
      measured: { ...measured, total, errors },
      pass: total > 0 && measured.alert === refusal && measured.title === 'Надлишок у вільний залишок' && measured.focus === `Перенести (${total})` &&
        measured.posts === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('take-241@1440', ['E6-F02'], async () => {
    const posts = [];
    const { ctx, p, errors, requests } = await open(1440, {
      writes: [recorder(posts, /\/take-stock$/, (e, k) => (k === 1
        ? { __status: 409, json: { detail: 'Запаси замовлення змінилися, поки зміну зберігали — спробуйте ще раз' } }
        : { order: orderA, results: (e.body?.lines ?? []).map((l) => ({ line_id: l.line_id, asked_finished: l.from_finished, got_finished: l.from_finished, asked_kits: l.kits, got_kits: l.kits })) }))],
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const banner = p.getByTestId('take-stock');
    if (!(await banner.count())) {
      await ctx.close();
      return { pass: null, pending: 'the stand offers no stock for 241' };
    }
    const offersBefore = requests.filter((r) => /stock-offers/.test(r)).length;
    await banner.getByRole('button', { name: 'Взяти зі складу' }).click();
    const refusal = await toastText(p, /Запаси замовлення змінилися/).then(() => true, () => false);
    await p.waitForTimeout(1200);
    const offersAfter = requests.filter((r) => /stock-offers/.test(r)).length;
    await banner.getByRole('button', { name: 'Взяти зі складу' }).click();
    const taken = await toastText(p, /Взято зі складу: \d+ готових · \d+ компл\./).then(() => true, () => false);
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['POST …/take-stock → 409, then what was shown (runner)'], actions: ['«Взяти зі складу»', 'again'] },
      measured: { posts: posts.length, refusal, offersBefore, offersAfter, taken, errors },
      pass: posts.length === 2 && refusal && offersAfter > offersBefore && taken && errors.length === 0,
    };
  });

  // ======================= 6. hit tests at 390, themes =======================
  await scenario('hits@390', ['E6-B03', 'E6-C03', 'E6-E04'], async () => {
    const { ctx, p, errors } = await open(390);
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const trigger = await hitTest(p, '[data-testid="order-actions"] button[aria-label^="Дії замовлення"]');
    await openMenu(p, p.getByTestId('order-actions'));
    const items = await hitTest(p, '[role="menu"] [role="menuitem"]');
    await p.keyboard.press('Escape');
    await openEdit(p);
    const swatches = await hitTest(p, '[role="dialog"] [role="radiogroup"] label');
    const formFooter = await hitTest(p, '[role="dialog"] [data-workshop-dialog-footer] button');
    await p.keyboard.press('Escape');
    await dialogGone(p);
    await openFulfil(p);
    const numbers = await hitTest(p, '[role="dialog"] table input[type="number"], [role="dialog"] table input[type="checkbox"]');
    const f06Footer = await hitTest(p, '[role="dialog"] [data-workshop-dialog-footer] button');
    await ctx.close();
    const all = [...trigger, ...items, ...swatches, ...formFooter, ...numbers, ...f06Footer];
    return {
      recipe: { url: '/projects/{order:241}', viewport: 390, actions: ['menu', 'form', '«Склад і видача…»'] },
      measured: { counts: { trigger: trigger.length, items: items.length, swatches: swatches.length, numbers: numbers.length }, misses: all.filter((h) => !h.inView || !h.hits), errors },
      pass: trigger.length === 1 && items.length > 0 && swatches.length === 10 && numbers.length > 0 && all.every((h) => h.inView && h.hits) && errors.length === 0,
    };
  });

  for (const [id, opts, test] of [
    ['theme-light@1440', { storage: { 'theme-mode': 'light' } }, (e) => !/\bdark\b/.test(e.theme)],
    ['theme-oled@1440', { settings: { dark_background: 'oled' } }, (e) => /bg-oled/.test(e.theme)],
  ]) {
    await scenario(id, ['E2-B01', 'E6-C01', 'E6-E01'], async () => {
      const { ctx, p, errors } = await open(1440, opts);
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await openEdit(p);
      const e = await env(p);
      const swatchContrast = await chosenSwatchContrast(p);
      const fileForm = await shoot(p, `${id}-form`);
      await p.keyboard.press('Escape');
      await dialogGone(p);
      await openFulfil(p);
      const fileF06 = await shoot(p, `${id}-f06`);
      await ctx.close();
      return {
        env: e,
        measured: { swatchContrast, errors },
        pass: test(e) && swatchContrast != null && swatchContrast >= 3 && errors.length === 0,
        screenshots: [fileForm, fileF06],
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
