// WS-13 E10 acceptance runner (spec §K.1), run by Playwright MCP's browser_run_code_unsafe:
//   filename: scripts/workshop_stand/e10_editors.js — while `e10_evidence.py serve` listens on 127.0.0.1:8197.
// The harness is E4's (e04_detail.js, via E7–E9), unchanged in what it guarantees: every scenario records WHAT was
// run (recipe + fixtures), WHERE (viewport, DPR, the actual <html> classes), WHAT was measured and whether it
// matched the spec — a failure is a failure, a surface it cannot reach is `pending`. Nothing reaches the stand but
// reads: every non-GET request of every context is answered here, and the states the baseline does not hold are
// rewritten GET answers in this runner's own context only. The oracles measure what a person reads and does — the
// labels in order, the sentence in a dialog's slot, where the focus is, which requests a press sent and with what
// body — never a class name, except where the spec names the geometry rule itself (one column at 760).
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
      if (sessionStorage.getItem('e10-init')) return;
      sessionStorage.setItem('e10-init', '1');
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
      if (step && step.fail) return route.fulfill({ status: step.fail, json: { detail: 'e10 runner' } });
      // A body of the runner's own — the stand is never asked.
      if (step && step.json) return route.fulfill({ status: 200, json: step.json });
      // A picture of the runner's own (the cover fixture, K11): a real PNG file.
      if (step && step.file) return route.fulfill({ status: 200, path: step.file, contentType: 'image/png' });
      const failing = fail.find(([re]) => re.test(url));
      if (failing) return route.fulfill({ status: failing[1], json: { detail: 'e10 runner' } });
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
  // The mockup products (spec §K.1, T0): 1 — six parts (four printed, two purchased), one group
  // «Хвіст» used by lines and parts, a shelf; 8 — where a creation lands.
  const P = job.products ?? {};
  const P1 = P['1'] ?? 1;
  const P8 = P['8'] ?? 8;
  const detail1 = await read(`/products/${P1}`);
  const detail8 = await read(`/products/${P8}`);
  const shelf1 = await read(`/products/${P1}/stock`);
  // The import's archive is product 1's real export — a GET of the stand, read by that scenario.
  const exportOf = async (id) => {
    let res;
    try {
      res = await page.request.get(`${job.api}/api/v1/products/${id}/export`, { headers: auth });
    } catch {
      throw failure('read_network', `/products/${id}/export`);
    }
    if (!res.ok()) throw failure(`read_http_${res.status()}`, `/products/${id}/export`);
    return res.body();
  };
  const partOf = (name) => (detail1.parts ?? []).find((pt) => pt.name === name) ?? { name };
  const KOLBA = partOf('Колба');
  const KRYSHKA = partOf('Кришка');
  const TAIL_ANGLE = partOf('Хвіст кутовий');
  const GROUP = (detail1.variant_groups ?? [])[0] ?? { options: [{}, {}] };

  // --- doors and oracles ---
  const DETAIL = (id) => new RegExp(`/api/v1/products/${id}/?(\\?.*)?$`);
  const SHELF = (id) => new RegExp(`/api/v1/products/${id}/stock/?(\\?.*)?$`);
  const LIBRARY = /\/api\/v1\/library\/files\?/;
  const goto = async (p, path) => {
    await p.goto(`${job.ui}${path}`, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(600);
  };
  const dialogOf = (p, name) => p.getByRole('dialog', { name, exact: true });
  const textOf = (locator) => locator.evaluate((el) => el.textContent.replace(/\s+/g, ' ').trim());
  // What a dialog's `aria-describedby` reads — its subtitle.
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
  const menuItems = (p) => p.getByRole('menuitem').evaluateAll((ms) => ms.map((m) => m.textContent.trim()));
  const urlOf = (p) => p.evaluate(() => location.pathname + location.search);
  const count = (requests, re) => requests.filter((r) => re.test(r)).length;
  const toastText = (p, re, ms = 6000) => within(p.waitForFunction((src) => {
    const rx = new RegExp(src);
    return [...document.querySelectorAll('body *')].some((el) => el.children.length === 0 && rx.test(el.textContent ?? ''));
  }, re.source), ms, 'no_toast');
  // The field the focus is in, by its label — or the button, by its name.
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
  const rowMenu = async (p, name) => {
    await p.locator('[data-testid^="part-"][data-testid$="-row"]', { hasText: name }).first().getByRole('button', { name: 'Дії' }).click();
    await p.getByRole('menuitem').first().waitFor();
  };
  const openEdit = async (p) => {
    await goto(p, `/products/${P1}`);
    await p.getByRole('button', { name: /^Редагувати$/ }).click();
    const d = dialogOf(p, 'Редагувати виріб');
    await d.waitFor();
    return d;
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const FORM_ORDER = ['Назва', 'Артикул', 'Версія', 'Категорія', 'Готовність', 'Опис', 'Автор моделі', 'Ліцензія', 'Джерело'];

  // ---------------------------------------------------------------- the product form (B)
  await scenario('form@1440', ['E10-B01', 'E10-B02', 'E10-B03', 'E10-B04', 'E10-B08'], async () => {
    const { ctx, p, errors } = await open(1440);
    await goto(p, '/products');
    await p.getByRole('button', { name: /^Новий виріб$/ }).click();
    const create = dialogOf(p, 'Новий виріб');
    await create.waitFor();
    await p.waitForTimeout(300);
    const created = {
      labels: (await create.locator('label').evaluateAll((ls) => ls.map((l) => l.textContent.trim()))).slice(0, 9),
      subtitle: await described(create),
      readyShut: await create.getByLabel('Готовність').locator('option[value="ready"]').isDisabled(),
      focus: await focusAt(p),
      primary: await textOf(create.getByRole('button', { name: /^Створити виріб$/ })),
    };
    const fileCreate = await shoot(p, 'form-create');
    await create.getByRole('button', { name: 'Скасувати' }).click();
    const edit = await openEdit(p);
    await p.waitForTimeout(300);
    const more = edit.getByRole('button', { name: 'Додатково' });
    const folded = await more.getAttribute('aria-expanded');
    await more.click();
    const edited = {
      subtitle: await described(edit),
      folded,
      unfolded: await more.getAttribute('aria-expanded'),
      extra: (await edit.getByLabel('ID моделі').isVisible()) && (await edit.getByLabel('Нотатки').isVisible()),
      readyOpen: await edit.getByLabel('Готовність').locator('option[value="ready"]').isEnabled(),
      gallery: await edit.getByTestId(/gallery/).count(),
      primary: await textOf(edit.getByRole('button', { name: /^Зберегти виріб$/ })),
    };
    const fileEdit = await shoot(p, 'form-edit');
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products → «Новий виріб»; /products/{product:1} → «Редагувати»', actions: ['«Додатково» unfolded'] },
      measured: { created, edited, errors },
      pass: same(created.labels, FORM_ORDER) && created.subtitle.startsWith('Деталі з’являться') && created.readyShut &&
        created.focus === 'Назва' && edited.subtitle === `${detail1.code} · ${detail1.sku}` && edited.folded === 'false' &&
        edited.unfolded === 'true' && edited.extra && edited.readyOpen && edited.gallery === 0 && errors.length === 0,
      screenshots: [fileCreate, fileEdit],
    };
  });

  await scenario('form-refusal@1440', ['E10-B05', 'E10-B07', 'E10-J'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      writes: [recorder(writes, new RegExp(`/api/v1/products/${P1}$`), async () => {
        await new Promise((r) => setTimeout(r, 1200));
        return { __status: 409, json: { detail: 'Інший виріб уже має цей артикул' } };
      })],
    });
    const edit = await openEdit(p);
    await edit.getByLabel('Артикул').fill('LMP-1');
    await edit.getByRole('button', { name: /^Зберегти виріб$/ }).click();
    await p.waitForTimeout(150);
    await p.keyboard.press('Escape');
    const underRequest = {
      open: await edit.isVisible(),
      cancelShut: await edit.getByRole('button', { name: 'Скасувати' }).isDisabled(),
      xShut: await edit.getByRole('button', { name: 'Закрити' }).isDisabled(),
    };
    const alert = edit.getByRole('alert');
    await alert.waitFor({ timeout: 6000 });
    const refused = { text: await textOf(alert), focus: await focusAt(p), kept: await edit.getByLabel('Артикул').inputValue() };
    const file = await shoot(p, 'form-refusal');
    await edit.getByLabel('Назва', { exact: true }).fill('   ');
    await edit.getByRole('button', { name: /^Зберегти виріб$/ }).click();
    const empty = { text: await textOf(edit.getByRole('alert')), focus: await focusAt(p) };
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products/{product:1} → «Редагувати»', fixture: ['PATCH /products/{id}: 409 «Інший виріб уже має цей артикул» after 1.2 s (answered here)'], actions: ['SKU changed, «Зберегти виріб», Escape under the request', 'an empty name'] },
      measured: { underRequest, refused, empty, writes: writes.length, errors },
      pass: underRequest.open && underRequest.cancelShut && underRequest.xShut && refused.text === 'Інший виріб уже має цей артикул' &&
        refused.focus === 'Зберегти виріб' && refused.kept === 'LMP-1' && empty.text === 'Вкажіть назву.' && empty.focus === 'Назва' &&
        writes.length === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('form-create@1440', ['E10-B06'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, { writes: [recorder(writes, /\/api\/v1\/products\/?$/, () => detail8)] });
    await goto(p, '/products');
    await p.getByRole('button', { name: /^Новий виріб$/ }).click();
    const create = dialogOf(p, 'Новий виріб');
    await create.waitFor();
    await create.getByLabel('Назва', { exact: true }).fill('Нова лампа');
    await create.getByRole('button', { name: /^Створити виріб$/ }).click();
    await p.waitForURL(new RegExp(`/products/${P8}$`), { timeout: 8000 });
    await toastText(p, /Виріб створено — прив’яжіть файл або додайте деталі/);
    const file = await shoot(p, 'form-created');
    const body = writes[0]?.body ?? null;
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products → «Новий виріб»', fixture: ['POST /products/: product 8 (answered here)'] },
      measured: { body, writes: writes.length, errors },
      pass: writes.length === 1 && body?.name === 'Нова лампа' && !('status' in (body ?? {})) && errors.length === 0,
      screenshots: [file],
    };
  });

  // ---------------------------------------------------------------- the part (C)
  await scenario('part-create@1440', ['E10-C01', 'E10-C02', 'E10-C05', 'E10-C06', 'E10-C07'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      writes: [recorder(writes, new RegExp(`/api/v1/products/${P1}/parts$`), () => ({ ...KOLBA, id: 999, name: 'Хвіст A' }))],
    });
    await goto(p, `/products/${P1}`);
    await p.getByRole('button', { name: /^Додати деталь$/ }).click();
    const d = dialogOf(p, 'Нова деталь');
    await d.waitFor();
    await p.waitForTimeout(300);
    const opened = { subtitle: await described(d), focus: await focusAt(p), variants: await d.getByLabel('Варіант').locator('option').allTextContents() };
    await d.getByLabel('Назва', { exact: true }).fill('Хвіст A');
    await d.getByLabel('Варіант').selectOption(String(TAIL_ANGLE.variant_option_id));
    const alias = d.getByLabel('Також відома як');
    await alias.fill('Tail_A_V2');
    await alias.press('Enter');
    const afterEnter = { writes: writes.length, token: await d.getByTestId('part-alias-tokens').textContent() };
    const file = await shoot(p, 'part-create');
    await d.getByRole('button', { name: /^Зберегти деталь$/ }).click();
    await d.waitFor({ state: 'detached', timeout: 6000 });
    const body = writes[0]?.body ?? null;
    // A purchased one: its own block; «Cancel» sends nothing.
    await p.getByRole('button', { name: /^Додати деталь$/ }).click();
    const again = dialogOf(p, 'Нова деталь');
    await again.waitFor();
    await again.getByLabel('Тип').selectOption('purchased');
    const purchased = {
      price: await again.getByLabel(/^Ціна за штуку/).isVisible(),
      url: await again.getByLabel('Де купити').isVisible(),
      remarks: await again.getByLabel('Примітки').isVisible(),
      aliases: await again.getByLabel('Також відома як').count(),
    };
    const filePurchased = await shoot(p, 'part-create-purchased');
    await again.getByRole('button', { name: 'Скасувати' }).click();
    await again.waitFor({ state: 'detached' });
    await ctx.close();
    const expected = { kind: 'printed', name: 'Хвіст A', qty_per_unit: 1, ignored: false, aliases: ['tail_a_v2'], variant_option_id: TAIL_ANGLE.variant_option_id };
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products/{product:1} → «Додати деталь»', fixture: ['POST …/parts: a part (answered here)'], actions: ['name, variant, an alias by Enter, «Зберегти деталь»', 'a purchased one, «Скасувати»'] },
      measured: { opened, afterEnter, body, purchased, writes: writes.length, errors },
      pass: opened.subtitle === `${detail1.code} · ${detail1.name}` && opened.focus === 'Назва' && opened.variants[0] === 'Завжди (без варіанта)' &&
        afterEnter.writes === 0 && /tail_a_v2/.test(afterEnter.token ?? '') && same(body, expected) && writes.length === 1 &&
        purchased.price && purchased.url && purchased.remarks && purchased.aliases === 0 && errors.length === 0,
      screenshots: [file, filePurchased],
    };
  });

  await scenario('part-edit@1440', ['E10-C03', 'E10-C04', 'E10-C06', 'E10-C07'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      writes: [recorder(writes, new RegExp(`/api/v1/products/${P1}/parts/${KOLBA.id}$`), (_e, n) => (n === 1
        ? { __status: 409, json: { detail: '«cap_v3» уже належить деталі «Кришка»' } }
        : KOLBA))],
    });
    await goto(p, `/products/${P1}`);
    await rowMenu(p, 'Колба');
    await p.getByRole('menuitem', { name: 'Редагувати' }).click();
    const d = dialogOf(p, 'Редагувати деталь');
    await d.waitFor();
    const kind = d.getByLabel('Тип');
    const tokens = d.getByTestId('part-alias-tokens');
    const opened = {
      kind: await kind.inputValue(),
      readOnly: await kind.evaluate((el) => el.readOnly),
      kindHint: await kind.evaluate((el) => document.getElementById(el.getAttribute('aria-describedby'))?.textContent),
      ownRemovable: await tokens.getByRole('button', { name: `Прибрати ${KOLBA.name_key}` }).count(),
      otherRemovable: await tokens.getByRole('button', { name: 'Прибрати flask_body' }).count(),
      ignoreShut: await d.getByLabel('Не рахувати').isDisabled(),
    };
    const alias = d.getByLabel('Також відома як');
    await alias.fill('half');
    await alias.press('Escape');
    const escape = { value: await alias.inputValue(), open: await d.isVisible() };
    await alias.fill('FLASK_BODY');
    await alias.press('Enter');
    const duplicate = await d.getByText('Ця назва вже є в переліку.').isVisible();
    await alias.fill('cap_v3');
    await alias.press('Enter');
    await d.getByRole('button', { name: /^Зберегти деталь$/ }).click();
    await d.getByRole('alert').waitFor({ timeout: 6000 });
    const refused = { text: await textOf(d.getByRole('alert')), kept: await tokens.textContent() };
    const file = await shoot(p, 'part-edit-refused');
    await tokens.getByRole('button', { name: 'Прибрати cap_v3' }).click();
    await tokens.getByRole('button', { name: 'Прибрати flask_body' }).click();
    await d.getByRole('button', { name: /^Зберегти деталь$/ }).click();
    await d.waitFor({ state: 'detached', timeout: 6000 });
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products/{product:1} → «Колба» → «Редагувати»', fixture: ['PATCH …/parts/{Колба}: 409 a key another part owns, then the part (answered here)'] },
      measured: { opened, escape, duplicate, refused, bodies: writes.map((w) => w.body), errors },
      pass: opened.kind === 'Друкована' && opened.readOnly && opened.kindHint === 'Тип не змінюється — створіть нову деталь' &&
        opened.ownRemovable === 0 && opened.otherRemovable === 1 && opened.ignoreShut && escape.value === '' && escape.open &&
        duplicate && refused.text === '«cap_v3» уже належить деталі «Кришка»' && /cap_v3/.test(refused.kept ?? '') &&
        writes.length === 2 && same(writes[0].body, { aliases: ['flask_body', 'cap_v3'] }) && same(writes[1].body, { aliases: [] }) &&
        errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('merge@1440', ['E10-C08', 'E10-C10'], async () => {
    const writes = [];
    let merged = false;
    // «Хвіст кутовий» marked «Не рахувати» (rewritten): the target that holds no stock.
    const shape = (body) => ({
      ...body,
      parts: body.parts
        .filter((pt) => !(merged && pt.id === KRYSHKA.id))
        .map((pt) => (pt.id === TAIL_ANGLE.id ? { ...pt, qty_per_unit: 0, ignored: true } : pt)),
    });
    const { ctx, p, errors } = await open(1440, {
      rewrite: [[DETAIL(P1), shape]],
      writes: [recorder(writes, new RegExp(`/api/v1/products/${P1}/parts/\\d+/merge$`), () => { merged = true; return KOLBA; })],
    });
    await goto(p, `/products/${P1}`);
    await rowMenu(p, 'Кришка');
    const items = await menuItems(p);
    await p.getByRole('menuitem', { name: 'Злити в…' }).click();
    const d = dialogOf(p, `Злити деталь «${KRYSHKA.name}» в…`);
    await d.waitFor();
    const target = d.getByLabel('Деталь-ціль');
    const options = await target.locator('option').evaluateAll((os) => os.map((o) => ({ text: o.textContent.trim(), disabled: o.disabled })));
    const explained = await textOf(d.locator('ul'));
    const file = await shoot(p, 'merge');
    await target.selectOption(String(KOLBA.id));
    await d.getByRole('button', { name: /^Злити/ }).click();
    await d.waitFor({ state: 'detached', timeout: 6000 });
    await p.locator('[data-testid^="part-"][data-testid$="-row"]', { hasText: 'Кришка' }).waitFor({ state: 'detached', timeout: 6000 });
    await p.waitForTimeout(400);
    const focus = await focusAt(p);
    await ctx.close();
    const shut = options.find((o) => o.text.startsWith(TAIL_ANGLE.name));
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products/{product:1} → «Кришка» → «Злити в…»', fixture: ['GET product: «Хвіст кутовий» marked not counted; «Кришка» gone after the merge (rewritten)', 'POST …/merge (answered here)'] },
      measured: { items, options, explained, path: writes[0]?.path, body: writes[0]?.body, focus, errors },
      pass: same(items, ['Редагувати', 'Злити в…', 'Видалити']) && shut?.disabled === true && /не тримає залишку/.test(shut?.text ?? '') &&
        explained.includes(`Її вільний залишок — ${KRYSHKA.stock_balance} шт. — переходить на ціль.`) && writes.length === 1 &&
        writes[0].path === `/api/v1/products/${P1}/parts/${KOLBA.id}/merge` && same(writes[0].body, { source_part_id: KRYSHKA.id }) &&
        focus === 'H1' && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('delete@1440', ['E10-C09'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, { writes: [recorder(writes, /\/api\/v1\/products\//)] });
    await goto(p, `/products/${P1}`);
    await rowMenu(p, 'Колба');
    await p.getByRole('menuitem', { name: 'Видалити' }).click();
    const d = dialogOf(p, 'Видалити деталь?');
    await d.waitFor();
    const printed = await textOf(d);
    const file = await shoot(p, 'delete-printed');
    await d.getByRole('button', { name: 'Скасувати' }).click();
    await d.waitFor({ state: 'detached' });
    await rowMenu(p, 'Гвинт');
    await p.getByRole('menuitem', { name: 'Видалити' }).click();
    const d2 = dialogOf(p, 'Видалити деталь?');
    await d2.waitFor();
    const purchased = await textOf(d2);
    await d2.getByRole('button', { name: 'Скасувати' }).click();
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products/{product:1} → «Колба» / «Гвинт» → «Видалити»', actions: ['«Скасувати» each'] },
      measured: { printed, purchased, writes: writes.length, errors },
      pass: printed.includes('разом з історією її рухів на полиці') && printed.includes(`Зараз на полиці: ${KOLBA.stock_balance} шт.`) &&
        purchased.includes('разом з історією закупівель у замовленнях') && !purchased.includes('Зараз на полиці') &&
        writes.length === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ---------------------------------------------------------------- the variants (D)
  const VARIANTS = new RegExp(`/api/v1/products/${P1}/variants$`);
  const openVariants = async (p) => {
    await p.getByRole('button', { name: /^Керувати варіантами/ }).click();
    const d = dialogOf(p, 'Варіанти виробу');
    await d.waitFor();
    return d;
  };
  await scenario('variants@1440', ['E10-D01', 'E10-D02', 'E10-D03', 'E10-D04', 'E10-D05'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, { writes: [recorder(writes, VARIANTS, () => detail1)] });
    await goto(p, `/products/${P1}`);
    let d = await openVariants(p);
    await p.waitForTimeout(300);
    const opened = {
      subtitle: await described(d),
      group: await d.getByLabel('Група').inputValue(),
      options: await d.getByRole('textbox', { name: /^Опція \d групи/ }).evaluateAll((is) => is.map((i) => i.value)),
      standardShut: await d.getByRole('button', { name: `Видалити опцію «${GROUP.options[0].name}»` }).isDisabled(),
      usedShut: await d.getByRole('button', { name: `Видалити опцію «${GROUP.options[1].name}»` }).isDisabled(),
      groupShut: await d.getByRole('button', { name: `Видалити групу «${GROUP.name}»` }).isDisabled(),
      focus: await focusAt(p),
    };
    const file = await shoot(p, 'variants');
    // Nothing changed: «Зберегти» closes without a request.
    await d.getByRole('button', { name: /^Зберегти$/ }).click();
    await d.waitFor({ state: 'detached', timeout: 4000 });
    const unchangedWrites = writes.length;
    d = await openVariants(p);
    await d.getByRole('textbox', { name: /^Опція 2 групи/ }).fill('кутовий 90°');
    await d.getByRole('button', { name: /^Опція$/ }).click();
    const added = await d.getByRole('textbox', { name: /^Опція 3 групи/ }).inputValue();
    // A blank name is said by its field and holds «Зберегти».
    await d.getByLabel('Група').fill(' ');
    const blank = { said: await d.getByText('Вкажіть назву групи.').isVisible(), shut: await d.getByRole('button', { name: /^Зберегти$/ }).isDisabled() };
    await d.getByLabel('Група').fill(GROUP.name);
    await d.getByRole('button', { name: /^Зберегти$/ }).click();
    await d.waitFor({ state: 'detached', timeout: 6000 });
    // «Скасувати» writes nothing.
    d = await openVariants(p);
    await d.getByLabel('Група').fill('Інша назва');
    await d.getByRole('button', { name: 'Скасувати' }).click();
    await d.waitFor({ state: 'detached' });
    await ctx.close();
    const body = writes[0]?.body;
    const sent = body?.groups?.[0];
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products/{product:1} → «Керувати варіантами…»', fixture: ['PUT …/variants (answered here)'], actions: ['«Зберегти» untouched', 'rename an option, «Опція», a blank group name, «Зберегти»', '«Скасувати» after a change'] },
      measured: { opened, unchangedWrites, added, blank, body, writes: writes.length, errors },
      pass: opened.subtitle === `${detail1.code} · ${detail1.name}` && opened.group === GROUP.name && opened.standardShut && opened.usedShut &&
        opened.groupShut && opened.focus === 'Група' && unchangedWrites === 0 && added === 'опція 3' && blank.said && blank.shut &&
        writes.length === 1 && body.revision === detail1.variants_revision && sent?.id === GROUP.id && sent?.default === GROUP.default_option_id &&
        same(sent?.options?.slice(0, 2), [{ id: GROUP.options[0].id, name: GROUP.options[0].name }, { id: GROUP.options[1].id, name: 'кутовий 90°' }]) &&
        typeof sent?.options?.[2]?.temp_id === 'string' && sent?.options?.[2]?.name === 'опція 3' && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('variants-refusals@1440', ['E10-D05', 'E10-R03'], async () => {
    const writes = [];
    let reads = 0;
    // «кутовий» unused (rewritten) — its «×» opens; the server refuses to let it go.
    const free = (body) => ({
      ...body,
      variant_groups: body.variant_groups.map((g) => ({
        ...g,
        lines_count: 0,
        stock_count: 0,
        parts_count: 0,
        options: g.options.map((o) => (o.id === GROUP.options[1].id ? { ...o, lines_count: 0, parts_count: 0, stock_count: 0 } : o)),
      })),
    });
    const { ctx, p, errors } = await open(1440, {
      rewrite: [[DETAIL(P1), (body) => { reads += 1; return free(body); }]],
      writes: [recorder(writes, VARIANTS, (_e, n) => (n === 1
        ? { __status: 409, json: { detail: { error: 'option_in_use', message: 'Опцію обрано в позиціях замовлень: 2', group: GROUP.id, option: GROUP.options[1].id } } }
        : { __status: 409, json: { detail: { error: 'variants_changed', message: 'Варіанти змінилися відтоді, як їх відкрили, — оновіть і спробуйте ще раз', group: null, option: null } } }))],
    });
    await goto(p, `/products/${P1}`);
    const d = await openVariants(p);
    await d.getByRole('button', { name: `Видалити опцію «${GROUP.options[1].name}»` }).click();
    await d.getByRole('button', { name: /^Зберегти$/ }).click();
    const alert = d.getByRole('alert');
    await alert.waitFor({ timeout: 6000 });
    await p.waitForTimeout(300);
    const refused = { text: await textOf(alert), focus: await focusAt(p) };
    const file = await shoot(p, 'variants-refused');
    await alert.getByRole('button', { name: `Повернути «${GROUP.options[1].name}»` }).click();
    const restored = await d.getByRole('textbox', { name: /^Опція 2 групи/ }).inputValue();
    // The revision moved: «Перечитати» asks, reads, replaces.
    await d.getByLabel('Група').fill('Хвіст змінений');
    await d.getByRole('button', { name: /^Зберегти$/ }).click();
    await d.getByRole('alert').waitFor({ timeout: 6000 });
    const changed = await textOf(d.getByRole('alert'));
    const readsBefore = reads;
    await d.getByRole('alert').getByRole('button', { name: 'Перечитати' }).click();
    const confirm = dialogOf(p, 'Перечитати варіанти?');
    await confirm.waitFor();
    const asked = await textOf(confirm);
    await confirm.getByRole('button', { name: /^Перечитати/ }).click();
    await confirm.waitFor({ state: 'detached', timeout: 6000 });
    const reloaded = await d.getByLabel('Група').inputValue();
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products/{product:1} → «Керувати варіантами…»', fixture: ['GET product: «кутовий» unused (rewritten)', 'PUT …/variants: 409 option_in_use {group, option}, then 409 variants_changed (answered here)'] },
      measured: { refused, restored, changed, asked, reads: reads - readsBefore, reloaded, writes: writes.length, errors },
      pass: refused.text.startsWith(`Опцію «${GROUP.options[1].name}» не можна видалити: Опцію обрано в позиціях замовлень: 2`) &&
        refused.focus === `Повернути «${GROUP.options[1].name}»` && restored === GROUP.options[1].name &&
        changed.startsWith('Варіанти змінилися') && asked.includes('Ваші незбережені зміни буде втрачено.') && reads - readsBefore >= 1 &&
        reloaded === GROUP.name && writes.length === 2 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ---------------------------------------------------------------- from a file, the re-read (E, F)
  await scenario('from-file@1440', ['E10-E01', 'E10-E02', 'E10-E03'], async () => {
    const writes = [];
    let turns = 0;
    const { ctx, p, errors, requests } = await open(1440, {
      gets: [[LIBRARY, () => (++turns <= 2 ? { fail: 500 } : null)]],
      writes: [recorder(writes, /\/api\/v1\/products\/from-file\/\d+$/, async () => {
        await new Promise((r) => setTimeout(r, 900));
        return { product: detail8, notes: [{ code: 'filled_field', params: { field: 'designer' } }] };
      })],
    });
    await goto(p, '/products');
    await p.getByRole('button', { name: /^З файлу/ }).click();
    const d = dialogOf(p, 'Новий виріб із файлу');
    await d.waitFor();
    const failed = d.getByRole('alert');
    await failed.waitFor({ timeout: 8000 });
    const failure = await textOf(failed);
    const fileFailed = await shoot(p, 'from-file-failed');
    await failed.getByRole('button', { name: 'Спробувати знову' }).click();
    const rows = d.getByTestId('from-file-row');
    await rows.first().waitFor({ timeout: 8000 });
    const first = { box: await textOf(rows.first().locator('span').first()), line: await textOf(rows.first().locator('small')) };
    await d.getByRole('searchbox').fill('stl');
    await p.waitForTimeout(900);
    await rows.first().waitFor({ timeout: 8000 });
    const stl = { box: await textOf(rows.first().locator('span').first()), line: await textOf(rows.first().locator('small')) };
    const file = await shoot(p, 'from-file');
    await rows.first().getByRole('button', { name: /^Створити виріб/ }).click();
    await p.waitForTimeout(200);
    const busy = {
      pressed: await textOf(rows.first().getByRole('button')),
      othersShut: await rows.nth(1).getByRole('button').isDisabled(),
    };
    await p.waitForURL(new RegExp(`/products/${P8}$`), { timeout: 8000 });
    await toastText(p, /Заповнено поле «Автор моделі»/);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products → «З файлу…»', fixture: ['GET /library/files: two 500s, then the stand (answered here)', 'POST /products/from-file/{id}: product 8 + a filled-field note after 0.9 s (answered here)'], actions: ['«Спробувати знову»', 'search «stl»', '«Створити виріб» on the first row'] },
      measured: { failure, first, stl, busy, includeRoot: count(requests, /GET \/api\/v1\/library\/files\?.*include_root=false/), writes: writes.length, errors },
      pass: failure.startsWith('Не вдалося прочитати файли бібліотеки.') && first.box === '3MF' && / · /.test(first.line) &&
        stl.box === 'STL' && stl.line.includes('не нарізано') && busy.pressed.endsWith('…') && busy.othersShut &&
        count(requests, /GET \/api\/v1\/library\/files\?(?!.*include_root=false)/) === 0 && writes.length === 1 && errors.length === 0,
      screenshots: [fileFailed, file],
    };
  });

  await scenario('reread@1440', ['E10-F01', 'E10-F02'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      writes: [recorder(writes, new RegExp(`/api/v1/products/${P1}/card/reread`), () => ({
        product: detail1,
        notes: [{ code: 'filled_field', params: { field: 'design_id' } }, { code: 'replaced_files', params: { count: 2 } }],
      }))],
    });
    await goto(p, `/products/${P1}`);
    await p.getByTestId('product-page-menu').click();
    await p.getByRole('menuitem', { name: /^Перечитати картку/ }).click();
    const d = dialogOf(p, 'Перечитати картку з файлу');
    await d.waitFor();
    await d.getByRole('radio').first().waitFor({ timeout: 8000 });
    const review = await textOf(d.locator('p').filter({ hasText: 'Вкладення з цього файлу' }));
    const file = await shoot(p, 'reread-review');
    await d.getByRole('radio').first().check();
    await d.getByRole('button', { name: /^Перечитати$/ }).click();
    const result = dialogOf(p, 'Картку перечитано');
    await result.waitFor({ timeout: 6000 });
    await p.waitForTimeout(300);
    const lines = await result.locator('li').allTextContents();
    const focus = await focusAt(p);
    const fileResult = await shoot(p, 'reread-result');
    await result.getByRole('button', { name: 'Готово' }).click();
    await result.waitFor({ state: 'detached' });
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products/{product:1} → «⋮» → «Перечитати картку з файлу…»', fixture: ['POST …/card/reread: a filled field + 2 replaced (answered here)'] },
      measured: { review, lines, focus, writes: writes.length, errors },
      pass: review === 'Заповняться, якщо є у файлі: ID моделі. Вкладення з цього файлу замінюються, додані руками — ні.' &&
        same(lines, ['Заповнено: Ідентифікатор моделі', 'Замінено вкладень: 2']) && focus === 'Готово' && writes.length === 1 &&
        errors.length === 0,
      screenshots: [file, fileResult],
    };
  });

  // ---------------------------------------------------------------- import, categories (G, H)
  await scenario('import@1440', ['E10-G01', 'E10-G02', 'E10-G03'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      writes: [recorder(writes, /\/api\/v1\/products\/import$/, (_e, n) => (n === 1
        ? { __status: 413, json: { detail: 'An import may be at most 1 bytes' } }
        : { product: detail8, warnings: [{ code: 'import_cover_missing', params: {} }] }))],
    });
    await goto(p, '/products');
    await p.getByRole('button', { name: /^Імпорт/ }).click();
    const d = dialogOf(p, 'Імпорт виробу');
    await d.waitFor();
    const opened = { subtitle: await described(d), shut: await d.getByRole('button', { name: /^Імпортувати$/ }).isDisabled() };
    await d.getByTestId('import-file-input').setInputFiles({ name: 'product-1.zip', mimeType: 'application/zip', buffer: await exportOf(P1) });
    await d.getByRole('button', { name: /^Імпортувати$/ }).click();
    await d.getByRole('alert').waitFor({ timeout: 6000 });
    const tooLarge = await textOf(d.getByRole('alert'));
    await d.getByRole('button', { name: /^Імпортувати$/ }).click();
    await d.getByRole('button', { name: 'Відкрити виріб' }).waitFor({ timeout: 6000 });
    const result = { text: await textOf(d), url: await urlOf(p) };
    const file = await shoot(p, 'import-result');
    await d.getByRole('button', { name: 'Відкрити виріб' }).click();
    await p.waitForURL(new RegExp(`/products/${P8}$`), { timeout: 8000 });
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products → «Імпорт…»', fixture: ['the archive: product 1’s real export (GET)', 'POST /products/import: 413, then product 8 + a missing cover (answered here)'] },
      measured: { opened, tooLarge, result, writes: writes.length, errors },
      pass: opened.subtitle === 'ZIP, експортований з BamDude' && opened.shut && tooLarge === 'Цей архів завеликий для імпорту.' &&
        result.text.includes(`Виріб «${detail8.name}» імпортовано`) && result.text.includes('Обкладинку згадано в архіві') &&
        result.url === '/products' && writes.length === 2 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('categories@1440', ['E10-H01', 'E10-H02', 'E10-H03', 'E10-H04', 'E10-H05'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      writes: [recorder(writes, /\/api\/v1\/product-categories\/\d+$/, (e, n) => (n === 1
        ? { __status: 409, json: { detail: 'Категорія з такою назвою вже є' } }
        : { id: 5, name: e.body?.name ?? 'Декор', products_count: 13 }))],
    });
    await goto(p, '/products');
    const openManager = async () => {
      await p.getByRole('button', { name: 'Керувати категоріями' }).click();
      const d = dialogOf(p, 'Категорії');
      await d.waitFor();
      await d.getByTestId('category-row-Декор').waitFor();
      return d;
    };
    let d = await openManager();
    const row = () => d.getByTestId('category-row-Декор');
    const listed = { rows: await d.locator('[data-testid^="category-row-"]').count(), count: await textOf(row().locator('small')) };
    const file = await shoot(p, 'categories');
    await row().getByRole('button', { name: 'Перейменувати Декор' }).click();
    const field = row().getByLabel('Назва категорії');
    const focusInField = await focusAt(p);
    await field.press('Escape');
    const afterEscape = { field: await row().getByLabel('Назва категорії').count(), open: await d.isVisible(), focus: await focusAt(p) };
    await p.keyboard.press('Escape');
    await d.waitFor({ state: 'detached', timeout: 4000 });
    d = await openManager();
    await row().getByRole('button', { name: 'Перейменувати Декор' }).click();
    await row().getByLabel('Назва категорії').fill('Корпуси');
    await row().getByLabel('Назва категорії').press('Enter');
    await row().getByText('Категорія з такою назвою вже є').waitFor({ timeout: 6000 });
    const refusedKept = await row().getByLabel('Назва категорії').inputValue();
    const fileRefused = await shoot(p, 'categories-refused');
    await row().getByLabel('Назва категорії').fill('Декор і подарунки');
    await row().getByRole('button', { name: /^Зберегти/ }).click();
    await row().getByRole('button', { name: /^Перейменувати/ }).waitFor({ timeout: 6000 });
    await row().getByRole('button', { name: 'Видалити Декор' }).click();
    const confirm = dialogOf(p, 'Видалити категорію «Декор»?');
    await confirm.waitFor();
    const asked = await textOf(confirm);
    await confirm.getByRole('button', { name: 'Скасувати' }).click();
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products → «Керувати категоріями»', fixture: ['PATCH /product-categories/{id}: 409 a taken name, then the row (answered here)'], actions: ['«Перейменувати», Escape, Escape', 'a taken name by Enter, then «Зберегти»', '«Видалити» → «Скасувати»'] },
      measured: { listed, focusInField, afterEscape, refusedKept, asked, bodies: writes.map((w) => w.body), errors },
      pass: listed.rows === 6 && listed.count === '13 виробів' && focusInField === 'Назва категорії' && afterEscape.field === 0 &&
        afterEscape.open && afterEscape.focus === 'Перейменувати Декор' && refusedKept === 'Корпуси' &&
        asked.includes('13 виробів стануть без категорії') && writes.length === 2 && same(writes[1].body, { name: 'Декор і подарунки' }) &&
        errors.length === 0,
      screenshots: [file, fileRefused],
    };
  });

  // ---------------------------------------------------------------- the adjustment (I)
  await scenario('adjust@1440', ['E10-I01', 'E10-I02', 'E10-I03'], async () => {
    const writes = [];
    let shelfReads = 0;
    const { ctx, p, errors } = await open(1440, {
      gets: [[SHELF(P1), () => { shelfReads += 1; return null; }]],
      writes: [recorder(writes, new RegExp(`/api/v1/products/${P1}/stock/adjust$`), (_e, n) => (n === 1
        ? { __status: 409, json: { detail: 'Залишок не може піти нижче нуля' } }
        : { id: 1 }))],
    });
    await goto(p, `/products/${P1}?tab=stock`);
    await p.getByRole('button', { name: /^Коригувати$/ }).click();
    const d = dialogOf(p, 'Коригування вільних деталей');
    await d.waitFor();
    const projection = d.getByTestId('stock-adjust-projection');
    await p.waitForFunction(() => /Зараз/.test(document.querySelector('[data-testid="stock-adjust-projection"]')?.textContent ?? ''), null, { timeout: 6000 });
    const first = shelf1.balances[0];
    const opened = { subtitle: await described(d), option: await d.getByLabel('Деталь').locator('option').first().textContent(), projection: await textOf(projection), focus: await focusAt(p) };
    await d.getByLabel(/^Зміна/).fill(String(-(first.balance + 5)));
    const below = { text: await textOf(projection), shut: await d.getByRole('button', { name: /^Зберегти$/ }).isDisabled() };
    const fileBelow = await shoot(p, 'adjust-below');
    await d.getByLabel(/^Зміна/).fill('0');
    const zero = await d.getByText('Зміна — ціле число, не нуль.').isVisible();
    await d.getByLabel(/^Зміна/).fill('-1');
    const noReason = { hint: await d.getByText('Вкажіть причину — вона потрапить у журнал.').isVisible(), shut: await d.getByRole('button', { name: /^Зберегти$/ }).isDisabled() };
    await d.getByLabel('Чому').fill('Перерахував полицю');
    const readsBefore = shelfReads;
    await d.getByRole('button', { name: /^Зберегти$/ }).click();
    await d.getByRole('alert').waitFor({ timeout: 6000 });
    await p.waitForTimeout(800);
    const refused = { text: await textOf(d.getByRole('alert')), reread: shelfReads - readsBefore, change: await d.getByLabel(/^Зміна/).inputValue(), reason: await d.getByLabel('Чому').inputValue() };
    await d.getByRole('button', { name: /^Зберегти$/ }).click();
    await d.waitFor({ state: 'detached', timeout: 6000 });
    await toastText(p, /Залишок і журнал оновлено/);
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products/{product:1}?tab=stock → «Коригувати»', fixture: ['POST …/stock/adjust: 409, then accepted (answered here)'] },
      measured: { opened, below, zero, noReason, refused, writes: writes.length, errors },
      pass: opened.subtitle === detail1.name && opened.option === `${first.name} (на полиці ${first.balance})` &&
        opened.projection === `Зараз ${first.balance} → стане ${first.balance + 1}` && opened.focus === 'Деталь' &&
        below.text.endsWith('нижче нуля — залишок не може бути від’ємним') && below.shut && zero && noReason.hint && noReason.shut &&
        refused.text === 'Залишок не може піти нижче нуля' && refused.reread >= 1 && refused.change === '-1' &&
        refused.reason === 'Перерахував полицю' && writes.length === 2 && errors.length === 0,
      screenshots: [fileBelow],
    };
  });

  // ---------------------------------------------------------------- the keyboard (R09)
  await scenario('keyboard@1440', ['E10-R09', 'E10-C06', 'E10-B01'], async () => {
    const writes = [];
    const { ctx, p, errors } = await open(1440, {
      writes: [
        recorder(writes, new RegExp(`/api/v1/products/${P1}$`), () => detail1),
        recorder(writes, new RegExp(`/api/v1/products/${P1}/parts/${KOLBA.id}$`), () => KOLBA),
      ],
    });
    const edit = await openEdit(p);
    await edit.getByLabel('Назва', { exact: true }).fill(`${detail1.name} 2`);
    await edit.getByLabel('Назва', { exact: true }).press('Enter');
    await edit.waitFor({ state: 'detached', timeout: 6000 });
    const formEnter = writes.length;
    await rowMenu(p, 'Колба');
    await p.getByRole('menuitem', { name: 'Редагувати' }).click();
    const d = dialogOf(p, 'Редагувати деталь');
    await d.waitFor();
    await d.getByLabel('Також відома як').fill('kb_alias');
    await d.getByLabel('Також відома як').press('Enter');
    const aliasEnter = { writes: writes.length, open: await d.isVisible(), token: await d.getByTestId('part-alias-tokens').textContent() };
    await d.getByLabel('Назва', { exact: true }).press('Enter');
    await d.waitFor({ state: 'detached', timeout: 6000 });
    await ctx.close();
    return {
      env: { viewport: [1440, 900] },
      recipe: { url: '/products/{product:1}', fixture: ['PATCH product and part (answered here)'], actions: ['Enter in the product form’s name', 'Enter in the alias field', 'Enter in the part’s name'] },
      measured: { formEnter, aliasEnter, bodies: writes.map((w) => w.body), errors },
      pass: formEnter === 1 && aliasEnter.writes === 1 && aliasEnter.open && /kb_alias/.test(aliasEnter.token ?? '') && writes.length === 2 &&
        same(writes[1].body, { aliases: ['flask_body', 'kb_alias'] }) && errors.length === 0,
      screenshots: [],
    };
  });

  // ---------------------------------------------------------------- a reader (WS-13 E13 G02)
  // The editors' pages to a user who may read the Workshop and change nothing: no door to a
  // write is drawn — none disabled without a reason, none reachable by Tab.
  await scenario('reader@1440', ['E13-G02'], async () => {
    const groups = await read('/groups/');
    const adminPerms = (Array.isArray(groups) ? groups : groups.items).find((g) => g.name === 'Administrators').permissions;
    const WRITES = ['orders:create', 'products:create', 'customers:create', 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust', 'orders:delete', 'products:delete', 'customers:delete', 'orders:file_prints'];
    const READER = { is_admin: false, role: 'user', permissions: adminPerms.filter((perm) => !WRITES.includes(perm)) };
    const { ctx, p, errors } = await open(1440, { me: READER });
    await goto(p, '/products');
    const list = {
      create: await p.getByRole('button', { name: /^Новий виріб$/ }).count(),
      categories: await p.getByRole('button', { name: 'Керувати категоріями' }).count(),
    };
    await goto(p, `/products/${P1}`);
    const detail = {
      edit: await p.getByRole('button', { name: /^Редагувати$/ }).count(),
      rowMenus: await p.locator('[data-testid^="part-"][data-testid$="-row"]').getByRole('button', { name: 'Дії' }).count(),
      disabledWithoutReason: await p.locator('main button:disabled:not([title]):not([aria-describedby])').count(),
    };
    // Every stop of the keyboard on the page, by name: a write door would be one of them.
    const stops = [];
    for (let i = 0; i < 40; i += 1) {
      await p.keyboard.press('Tab');
      stops.push(await focusAt(p));
    }
    await ctx.close();
    const WRITE = /Редагувати|Видалити|Новий виріб|Злити|Додати деталь|Керувати категоріями|Створити|Зберегти/;
    return {
      env: { viewport: [1440, 900] },
      recipe: {
        url: '/products → /products/{product:1}',
        fixture: ['/auth/me: the Administrators’ permissions without the Workshop’s writes'],
        actions: ['look for every write door', 'Tab forty times through the product page'],
      },
      measured: { list, detail, stops, errors },
      pass: list.create === 0 && list.categories === 0 && detail.edit === 0 && detail.rowMenus === 0 &&
        detail.disabledWithoutReason === 0 && !stops.some((s) => WRITE.test(s)) && errors.length === 0,
      screenshots: [],
    };
  });

  // ---------------------------------------------------------------- windows (K.1, R09)
  for (const [id, w, h] of [['short@390x600', 390, 600], ['short@1024x600', 1024, 600]]) {
    await scenario(id, ['E10-J', 'E10-K1'], async () => {
      const { ctx, p, errors } = await open(w, { h });
      const edit = await openEdit(p);
      const lg = {
        primary: await hits(p, edit.getByRole('button', { name: /^Зберегти виріб$/ })),
        scrolls: await edit.evaluate((el) => [...el.querySelectorAll('*')].some((n) => n.scrollHeight > n.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowY))),
        overflow: await docOverflow(p),
      };
      const fileLg = await shoot(p, `${id}-lg`);
      await edit.getByRole('button', { name: 'Скасувати' }).click();
      await goto(p, `/products/${P1}?tab=stock`);
      await p.getByRole('button', { name: /^Коригувати$/ }).click();
      const adjust = dialogOf(p, 'Коригування вільних деталей');
      await adjust.waitFor();
      const md = { primary: await hits(p, adjust.getByRole('button', { name: 'Скасувати' })), overflow: await docOverflow(p) };
      const fileMd = await shoot(p, `${id}-md`);
      await ctx.close();
      return {
        env: { viewport: [w, h] },
        recipe: { url: '/products/{product:1} → «Редагувати»; ?tab=stock → «Коригувати»', viewport: `${w}×${h}` },
        measured: { lg, md, errors },
        pass: lg.primary.inView && lg.primary.hits && lg.scrolls && lg.overflow <= 0 && md.primary.inView && md.primary.hits && md.overflow <= 0 && errors.length === 0,
        screenshots: [fileLg, fileMd],
      };
    });
  }

  for (const [id, w, two] of [['grid@761', 761, true], ['grid@760', 760, false]]) {
    await scenario(id, ['E10-J', 'E2-D07'], async () => {
      const { ctx, p, errors } = await open(w);
      const edit = await openEdit(p);
      const sku = await box(edit.getByLabel('Артикул'));
      const version = await box(edit.getByLabel('Версія'));
      const file = await shoot(p, id);
      await ctx.close();
      return {
        env: { viewport: [w, 800] },
        recipe: { url: '/products/{product:1} → «Редагувати»' },
        measured: { sku, version, errors },
        pass: (two ? sku.t === version.t && version.l > sku.l : version.t > sku.t && version.l === sku.l) && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('narrow@390', ['E10-J', 'E10-K1'], async () => {
    const { ctx, p, errors } = await open(390);
    const seen = [];
    const measure = async (name, d, primary) => {
      const b = await box(d);
      seen.push({ name, width: b.w, left: b.l, right: b.r, overflow: await docOverflow(p), primary: await hits(p, d.getByRole('button', { name: primary })) });
    };
    let d = await openEdit(p);
    await measure('product', d, /^Зберегти виріб$/);
    const fileForm = await shoot(p, 'narrow-form');
    await d.getByRole('button', { name: 'Скасувати' }).click();
    await p.getByRole('button', { name: /^Додати деталь$/ }).click();
    d = dialogOf(p, 'Нова деталь');
    await d.waitFor();
    await measure('part', d, /^Зберегти деталь$/);
    const filePart = await shoot(p, 'narrow-part');
    await d.getByRole('button', { name: 'Скасувати' }).click();
    d = await openVariants(p);
    await measure('variants', d, /^Зберегти$/);
    const fileVariants = await shoot(p, 'narrow-variants');
    await d.getByRole('button', { name: 'Скасувати' }).click();
    await ctx.close();
    return {
      env: { viewport: [390, 844] },
      recipe: { url: '/products/{product:1}', actions: ['«Редагувати», «Додати деталь», «Керувати варіантами…»'] },
      measured: { seen, errors },
      pass: seen.length === 3 && seen.every((s) => s.left >= 0 && s.right <= 390 && s.overflow <= 0 && s.primary.hits) && errors.length === 0,
      screenshots: [fileForm, filePart, fileVariants],
    };
  });

  for (const [id, opts, test] of [
    ['theme-light@1440', { storage: { 'theme-mode': 'light' } }, (e) => !/\bdark\b/.test(e.theme)],
    ['theme-oled@1440', { settings: { dark_background: 'oled' } }, (e) => /bg-oled/.test(e.theme)],
  ]) {
    await scenario(id, ['E2-B01', 'E10-B01'], async () => {
      const { ctx, p, errors } = await open(1440, opts);
      await openEdit(p);
      const e = await env(p);
      const file = await shoot(p, id);
      await ctx.close();
      return {
        env: e,
        recipe: { url: '/products/{product:1} → «Редагувати»' },
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
