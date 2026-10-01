// WS-13 E5 acceptance runner (spec §I1/I2), run by Playwright MCP's browser_run_code_unsafe:
//   filename: scripts/workshop_stand/e05_detail.js — while `e05_evidence.py serve` listens on 127.0.0.1:8197.
// The harness is E4's (e04_detail.js), unchanged in what it guarantees: every scenario records WHAT was run
// (recipe + fixtures), WHERE (viewport, DPR, the actual <html> classes), WHAT was measured and whether it matched
// the spec — a failure is a failure, a surface it cannot reach is `pending`. Nothing reaches the stand but reads:
// every non-GET request of every context is answered here (the stock proposal, the batch and the configuration
// PUT among them), and the states the baseline does not hold are rewritten GET answers in this runner's own
// context only. The oracles measure what a person reads (widths, text, where a control sits, whether a click
// lands), never a class name.
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
  const HEIGHTS = { 2560: 1440, 1920: 1080, 1440: 900, 1280: 800, 1101: 800, 1100: 800, 1024: 768, 768: 1024, 390: 844 };
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
  // `delay`: [[regex, ms]]; `writes`: [[regex, json | (request) => json | {__status, json}]] answers for non-GET,
  // every other non-GET gets {}. `me`: fields merged into /auth/me.
  const open = async (w, { h, storage = {}, me = null, rewrite = [], fail = [], delay = [], writes = [], settings = null } = {}) => {
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
      if (sessionStorage.getItem('e05-init')) return;
      sessionStorage.setItem('e05-init', '1');
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
      const failing = fail.find(([re]) => re.test(url));
      if (failing) return route.fulfill({ status: failing[1], json: { detail: 'e05 runner' } });
      const waiting = delay.find(([re]) => re.test(url));
      if (waiting) await new Promise((r) => setTimeout(r, waiting[1]));
      const rw = rewrite.find(([re]) => re.test(url));
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
  // Every query of the app is fresh for a minute (appQueryClient), so a background re-read is
  // a minute passing and the page coming back to the front.
  const refetchLater = async (p) => {
    await p.clock.fastForward('01:30');
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await p.waitForTimeout(1500);
  };

  const realScenarios = async () => {
  stage = 'prepare';
  const C = O['245'];
  const F = job.files ?? {};
  const P = (job.products ?? {})['2']; // CLM-01, «Корпус датчика клімату»
  const orderA = await read(`/projects/${A}`);
  const orderB = await read(`/projects/${B}`);
  const productP = await read(`/products/${P}`);
  const groups = await read('/groups/');
  const groupList = Array.isArray(groups) ? groups : (groups.items ?? []);
  const adminPerms = (groupList.find((g) => g.name === 'Administrators') ?? { permissions: [] }).permissions;
  const without = (...drop) => adminPerms.filter((perm) => !drop.includes(perm));
  const lineA = (orderA.lines ?? []).find((l) => l.mode !== 'parts');
  const partsLineB = (orderB.lines ?? []).find((l) => l.mode === 'parts');
  const lineProduct = lineA ? await read(`/products/${lineA.product_id}`) : null;
  const NO_LIBRARY = { is_admin: false, role: 'user', permissions: without('library:read_all', 'library:read_own', 'library:read') };

  // --- the dialog's own doors ---
  const dialog = (p) => p.locator('[role="dialog"]').last();
  const panelOf = (p) => dialog(p).locator('[role="tabpanel"]:visible').first();
  const footer = (p) => dialog(p).locator('[data-workshop-dialog-footer]');
  const primary = (p) => footer(p).locator('button').last();
  const productRow = (p, id) => panelOf(p).locator(`[data-testid="add-product-${id}"]`);
  const subtitleOf = (p) => dialog(p).evaluate((d) => {
    const id = d.getAttribute('aria-describedby');
    return id ? (document.getElementById(id)?.textContent ?? null) : null;
  });
  const addButton = (p) => p.getByRole('button', { name: 'Додати в замовлення', exact: true }).first();
  const openAdd = async (p) => {
    await addButton(p).click();
    await dialog(p).waitFor({ timeout: 10000 });
    await p.waitForTimeout(600);
  };
  const tabIn = async (p, name) => {
    await dialog(p).getByRole('tab', { name: new RegExp(`^${name}`) }).click();
    await p.waitForTimeout(700);
  };
  // A search box answers after its debounce and the server's reply: the wait is for the network.
  const search = async (p, q) => {
    await panelOf(p).getByRole('searchbox').first().fill(q);
    await p.waitForTimeout(500);
    await p.waitForLoadState('networkidle');
    await p.waitForTimeout(300);
  };
  const tick = (row) => row.locator('input[type="checkbox"]').first().check();
  // The frame of a dialog against the width the spec gives it — measured against the overlay it
  // sits in (a scrollbar, if any, is not the dialog's).
  const frameOf = (p) => dialog(p).evaluate((d) => ({
    width: Math.round(d.getBoundingClientRect().width),
    overlay: Math.round(d.parentElement.getBoundingClientRect().width),
    vw: innerWidth,
  }));
  const expectedWidth = (f, cap, share) => Math.min(cap, share * f.vw, f.overlay - 32);
  const docOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  // Words of a name split across two lines (a person reads «Демонст / раційна»): each word of
  // the element's own text measured by its line boxes. A break after a hyphen is typography,
  // not a split: «DIN-» and «рейки» are measured apart.
  const splitWords = (locator) => locator.evaluateAll((els) => els.flatMap((el) => {
    const node = el.firstChild;
    if (!node || node.nodeType !== 3) return [];
    const out = [];
    let at = 0;
    for (const w of node.textContent.replace(/-/g, '-\u0000').split(/(\s+|\u0000)/)) {
      if (w === '\u0000') continue;
      if (w.trim()) {
        const r = document.createRange();
        r.setStart(node, at);
        r.setEnd(node, at + w.length);
        if (new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size > 1) out.push(w);
      }
      at += w.length;
    }
    return out;
  }));
  // A control counts as reachable when, scrolled into view (a table at 390 scrolls in itself),
  // it is on screen and a click at its centre lands on it (or on its label).
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

  // The stock proposal is a POST the runner answers itself: the shape the server gives — ready
  // units of the configuration first (5 free), then kits (2 free), the rest to print.
  const suggestAnswer = (req) => {
    const items = JSON.parse(req.postData() || '{"items":[]}').items ?? [];
    return {
      items: items.map((i) => {
        const fin = Math.min(i.quantity, 5);
        const kits = Math.min(Math.max(0, i.quantity - fin), 2);
        return { product_id: i.product_id, finished_free: 5, kits_free: 2, from_finished: fin, from_kits: kits, to_print: i.quantity - fin - kits, position_id: null, position_code: null };
      }),
    };
  };
  const SUGGEST = [/\/stock\/suggest/, suggestAnswer];
  // The stand's library rows were seeded directly and carry no `file_tags` — a cache only the
  // tag writer (`compute_file_tags`) fills, at upload and by migration, on every real install.
  // Where the plate tab is judged, the list answer gets the format tags that writer computes
  // from a row's name and type (the stand holds no content flag). Recorded as a fixture.
  const tagsFor = (f) => (f.file_type === 'gcode' ? (f.filename.toLowerCase().endsWith('.3mf') ? ['gcode', '3mf'] : ['gcode'])
    : f.file_type === '3mf' ? ['3mf', 'project'] : f.file_type === 'stl' ? ['stl', 'geometry'] : []);
  const TAGGED = [/\/api\/v1\/library\/files\?/, (pg) => ({ ...pg, items: (pg.items ?? []).map((f) => ((f.file_tags ?? []).length ? f : { ...f, file_tags: tagsFor(f) })) })];
  const TAGGED_NOTE = 'GET /library/files → file_tags as the tag writer computes them (the stand seeded none)';
  // The batch is answered here too, the shelf giving what was asked; what was sent — its path and
  // body — is kept for the oracle.
  const batchWrite = (sentBatches) => [/\/lines\/batch/, (req) => {
    const body = JSON.parse(req.postData() || '{}');
    const orderId = Number((new URL(req.url()).pathname.match(/\/projects\/(\d+)\//) ?? [])[1]);
    sentBatches.push({ path: new URL(req.url()).pathname, body });
    return {
      order: { id: orderId, lines: [] },
      results: (body.lines ?? []).map((_l, i) => ({ line_id: 900 + i, asked_finished: 0, got_finished: 99, asked_kits: 0, got_kits: 99 })),
    };
  }];

  // ======================= 1. the frame at every width (B01, B02, E02, R07) =======================
  for (const w of [2560, 1920, 1440, 1280, 1101, 1100, 1024, 768, 390]) {
    await scenario(`add-geometry@${w}`, ['E5-B01', 'E5-B02', 'E5-B06', 'E5-E02', 'R07'], async () => {
      const { ctx, p, errors } = await open(w, { writes: [SUGGEST], rewrite: [TAGGED] });
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await openAdd(p);
      // B06: the first focus is the open tab's search box.
      const focusAtOpen = await p.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
      await tick(panelOf(p).locator('[data-testid^="add-product-"]').first());
      await p.waitForTimeout(800);
      const frame = await frameOf(p);
      const subtitle = await subtitleOf(p);
      const table = await panelOf(p).getByRole('region', { name: 'Вироби' }).evaluate((s) => ({ client: s.clientWidth, scroll: s.scrollWidth }));
      const broken = await splitWords(panelOf(p).locator('[data-testid^="add-product-"] td:nth-child(2) .font-semibold'));
      const overflowProducts = await docOverflow(p);
      const file = await shoot(p, `add-geometry@${w}`);
      await tabIn(p, 'Разовий з файлу');
      await panelOf(p).locator('ul li button').first().click();
      await p.waitForTimeout(1200);
      // The file list and the plates: two columns above 1100 px of window, one at or below it —
      // and a line between them either way (beside, or under the list).
      const { grid, divider } = await panelOf(p).evaluate((panel) => {
        let n = panel.querySelector('ul');
        while (n && n !== panel && getComputedStyle(n).display !== 'grid') n = n.parentElement;
        if (!n || n === panel) return { grid: null, divider: null };
        const left = getComputedStyle(n.firstElementChild);
        return {
          grid: getComputedStyle(n).gridTemplateColumns.split(' ').filter(Boolean).length,
          divider: { right: left.borderRightWidth, bottom: left.borderBottomWidth },
        };
      });
      const overflowPlate = await docOverflow(p);
      const filePlate = await shoot(p, `add-geometry-plate@${w}`);
      await ctx.close();
      const expected = expectedWidth(frame, 1560, 0.95);
      return {
        recipe: { url: '/projects/{order:241}', viewport: w, fixture: ['POST /stock/suggest → runner proposal', TAGGED_NOTE], actions: ['«Додати в замовлення»', 'tick the first product', 'tab «Разовий з файлу»', 'the first file'] },
        measured: { frame, expected: Math.round(expected), subtitle, focusAtOpen, table, broken, grid, divider, overflowProducts, overflowPlate, errors },
        pass: Math.abs(frame.width - expected) <= 2 && focusAtOpen === 'Виріб, артикул, категорія, матеріал або назва деталі…' && subtitle === `${orderA.code} · ${orderA.name}` && grid === (w > 1100 ? 2 : 1) && broken.length === 0 &&
          (w > 1100 ? parseFloat(divider?.right) > 0 && parseFloat(divider?.bottom) === 0 : parseFloat(divider?.bottom) > 0 && parseFloat(divider?.right) === 0) &&
          overflowProducts <= 0 && overflowPlate <= 0 && errors.length === 0,
        screenshots: [file, filePlate],
      };
    });
  }

  // Short windows: the footer, its summary and its primary button stay on screen (R07).
  for (const [w, h] of [[390, 600], [1024, 600]]) {
    await scenario(`add-short@${w}x${h}`, ['E5-B03', 'R07'], async () => {
      const { ctx, p, errors } = await open(w, { h, writes: [SUGGEST] });
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await openAdd(p);
      await tick(panelOf(p).locator('[data-testid^="add-product-"]').first());
      await tick(panelOf(p).locator('[data-testid^="add-product-"]').nth(1));
      await p.waitForTimeout(800);
      const m = await footer(p).evaluate((f) => {
        const r = f.getBoundingClientRect();
        const main = [...f.querySelectorAll('button')].pop();
        const b = main.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        const sum = f.firstElementChild;
        const s = sum.getBoundingClientRect();
        return {
          top: Math.round(r.top), bottom: Math.round(r.bottom), primary: main.textContent.trim(),
          primaryHits: !!hit && main.contains(hit), summary: sum.textContent.trim(), summaryIn: s.top >= 0 && s.bottom <= innerHeight && s.right <= innerWidth + 0.5,
        };
      });
      const file = await shoot(p, `add-short@${w}x${h}`);
      await ctx.close();
      return {
        recipe: { url: '/projects/{order:241}', viewport: `${w}×${h}`, fixture: ['POST /stock/suggest → runner proposal'], actions: ['«Додати в замовлення»', 'tick two products'] },
        measured: { ...m, errors },
        pass: m.bottom <= h && m.top >= 0 && m.primaryHits && m.summaryIn && /Обрано: 2/.test(m.summary) && m.primary === 'Додати позиції (2)' && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  // ======================= 2. one draft across tabs, pages and orders (B02, B04, G02, I4.1) =======================
  await scenario('add-draft@1440', ['E5-B02', 'E5-B04', 'E5-B06', 'E5-G02', 'R09', 'I4-1'], async () => {
    const sentBatches = [];
    const { ctx, p, errors, requests } = await open(1440, { writes: [SUGGEST, batchWrite(sentBatches)], rewrite: [TAGGED] });
    await p.goto(`${job.ui}/products/${P}`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(600);
    const mark = requests.length;
    await openAdd(p);
    const lazy = requests.slice(mark);
    // B06: from a product the first focus is the order search.
    const focusAtOpen = await p.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null);
    const subtitleBefore = await subtitleOf(p);
    const d = dialog(p);
    await d.getByLabel('Знайти замовлення…').fill(orderA.code);
    await d.getByLabel('Замовлення', { exact: true }).selectOption(String(A), { timeout: 10000 });
    const subtitleA = await subtitleOf(p);
    const preselected = await productRow(p, P).locator('input[type="checkbox"]').isChecked();
    // Page 2 of the whole catalog, one product picked there.
    await search(p, '');
    await panelOf(p).getByRole('button', { name: 'Наступна сторінка' }).click();
    await p.waitForLoadState('networkidle');
    await p.waitForTimeout(400);
    const page2Row = panelOf(p).locator('[data-testid^="add-product-"]').first();
    const page2Id = await page2Row.getAttribute('data-testid');
    await tick(page2Row);
    // Another tab with its own search.
    await tabIn(p, 'Деталі з виробу');
    const partsRead = requests.slice(mark).some((r) => /\/api\/v1\/products\/parts/.test(r));
    await search(p, 'clm01');
    await tick(panelOf(p).locator('[data-testid^="add-part-"]').first());
    await tabIn(p, 'Разовий з файлу');
    const filesRead = requests.slice(mark).some((r) => /\/api\/v1\/library\/files\?/.test(r));
    await search(p, 'cable_clip');
    await panelOf(p).getByRole('button', { name: /^cable_clip_set/ }).first().click();
    await panelOf(p).getByRole('radio').last().check({ timeout: 10000 });
    await panelOf(p).getByLabel('Копій плити').fill('3');
    // Back: the products tab kept its search and its page.
    await tabIn(p, 'Вироби');
    const kept = {
      search: await panelOf(p).getByRole('searchbox').first().inputValue(),
      page2Row: await panelOf(p).locator(`[data-testid="${page2Id}"]`).isVisible(),
      page2Ticked: await panelOf(p).locator(`[data-testid="${page2Id}"] input[type="checkbox"]`).isChecked(),
    };
    // The order changes last — the draft stays.
    await d.getByLabel('Знайти замовлення…').fill(orderB.code);
    await d.getByLabel('Замовлення', { exact: true }).selectOption(String(B), { timeout: 10000 });
    await p.waitForTimeout(500);
    const summaryText = await footer(p).innerText();
    const file = await shoot(p, 'add-draft@1440');
    await primary(p).click();
    await within(p.waitForURL(new RegExp(`/projects/${B}(\\?|$)`)), 10000, 'no_navigation');
    await ctx.close();
    const lines = sentBatches[0]?.body?.lines ?? [];
    const kinds = lines.map((l) => l.kind);
    const plateLine = lines.find((l) => l.kind === 'plate');
    return {
      recipe: { url: '/products/{product:2}', fixture: ['POST /stock/suggest → runner proposal', 'POST …/lines/batch → intercepted', TAGGED_NOTE], actions: ['«Додати в замовлення»', `order ${orderA.code}`, 'products: clear search, page 2, tick', 'parts: search clm01, tick', 'file: cable_clip_set, last plate, copies 3', 'back to products', `order ${orderB.code}`, 'Add'] },
      measured: { focusAtOpen, lazy: { products_parts: lazy.some((r) => /\/products\/parts/.test(r)), library_files: lazy.some((r) => /\/library\/files\?/.test(r)) }, partsRead, filesRead, subtitleBefore, subtitleA, preselected, page2Id, kept, summaryText, batches: sentBatches.map((b) => b.path), kinds, plateLine, errors },
      pass: !lazy.some((r) => /\/products\/parts|\/library\/files\?/.test(r)) && partsRead && filesRead && subtitleBefore === 'Оберіть замовлення' && focusAtOpen === 'Знайти замовлення…' &&
        subtitleA === `${orderA.code} · ${orderA.name}` && preselected && kept.search === '' && kept.page2Row && kept.page2Ticked &&
        sentBatches.length === 1 && sentBatches[0].path === `/api/v1/projects/${B}/lines/batch` &&
        kinds.filter((k) => k === 'product').length === 2 && kinds.includes('parts') && plateLine?.copies === 3 && errors.length === 0,
      screenshots: [file],
    };
  });

  // Vertical scroll belongs to the dialog's body and is kept per tab; a table's horizontal scroll
  // and the file list's own scroll live with their tab's DOM (R06). The tabs are switched by a DOM
  // click — a real click would first scroll the tab bar into view and move what is being kept.
  await scenario('add-scroll@390', ['E5-B02', 'R06'], async () => {
    const { ctx, p, errors } = await open(390, { writes: [SUGGEST], rewrite: [TAGGED] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openAdd(p);
    const body = dialog(p).locator('.overflow-y-auto').filter({ has: p.locator('[role="tablist"]') }).first();
    const switchTo = async (name) => {
      await dialog(p).getByRole('tab', { name: new RegExp(`^${name}`) }).evaluate((el) => el.click());
      await p.waitForTimeout(800);
    };
    const table = () => panelOf(p).getByRole('region', { name: 'Вироби' });
    const bodyTop = await body.evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
    const tableLeft = await table().evaluate((el) => { el.scrollLeft = el.scrollWidth; return el.scrollLeft; });
    await switchTo('Разовий з файлу');
    const plateFirst = await body.evaluate((el) => el.scrollTop);
    // The first visit reads the files: the list scrolls once they are there.
    await panelOf(p).locator('ul li button').nth(8).waitFor({ timeout: 10000 });
    const list = panelOf(p).locator('ul').first();
    const listTop = await list.evaluate((el) => { el.scrollTop = el.scrollHeight; return el.scrollTop; });
    await switchTo('Вироби');
    const back = { body: await body.evaluate((el) => el.scrollTop), table: await table().evaluate((el) => el.scrollLeft) };
    const file = await shoot(p, 'add-scroll@390');
    await switchTo('Разовий з файлу');
    const listBack = await list.evaluate((el) => el.scrollTop);
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', viewport: 390, fixture: [TAGGED_NOTE], actions: ['«Вироби»: body to the bottom, table to the right', '«Разовий з файлу»: file list to the bottom', 'back and forth (DOM clicks)'] },
      measured: { bodyTop, tableLeft, plateFirst, listTop, back, listBack, errors },
      pass: bodyTop > 0 && tableLeft > 0 && plateFirst === 0 && listTop > 0 && Math.abs(back.body - bodyTop) <= 2 &&
        Math.abs(back.table - tableLeft) <= 2 && Math.abs(listBack - listTop) <= 2 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 3. sending: the frozen draft, a refusal (B04, R09) =======================
  await scenario('add-submit@1440', ['E5-B04', 'R09'], async () => {
    let release = () => {};
    const held = new Promise((r) => { release = r; });
    let posts = 0;
    const { ctx, p, errors } = await open(1440, {
      writes: [SUGGEST, [/\/lines\/batch/, async () => { posts += 1; await held; return { order: { id: A, lines: [] }, results: [] }; }]],
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openAdd(p);
    await tick(panelOf(p).locator('[data-testid^="add-product-"]').first());
    await p.waitForTimeout(600);
    await primary(p).click();
    await p.waitForTimeout(400);
    const frozen = await dialog(p).evaluate((d) => {
      const buttons = [...d.querySelector('[data-workshop-dialog-footer]').querySelectorAll('button')];
      return {
        cancel: buttons[0]?.disabled ?? null,
        primary: buttons.at(-1)?.disabled ?? null,
        label: buttons.at(-1)?.textContent.trim() ?? null,
        close: d.querySelector('button[aria-label="Закрити"]')?.disabled ?? null,
        fieldsets: [...d.querySelectorAll('fieldset')].filter((f) => f.disabled).length,
      };
    });
    await p.keyboard.press('Escape');
    await primary(p).click({ force: true }).catch(() => {});
    await p.waitForTimeout(300);
    const stays = await dialog(p).isVisible();
    const file = await shoot(p, 'add-submit@1440');
    release();
    await within(p.waitForFunction(() => !document.querySelector('[role="dialog"]')), 10000, 'dialog_stayed');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['POST …/lines/batch → held open, then answered'], actions: ['tick', 'Add', 'Escape', 'Add again'] },
      measured: { frozen, stays, posts, errors },
      pass: frozen.cancel === true && frozen.primary === true && frozen.close === true && frozen.label === 'Додаю…' && frozen.fieldsets > 0 &&
        stays && posts === 1 && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('add-refused@1440', ['E5-B04', 'R09'], async () => {
    const { ctx, p, errors } = await open(1440, { writes: [SUGGEST, [/\/lines\/batch/, { __status: 409, json: { detail: 'Замовлення змінилось — додайте ще раз' } }]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openAdd(p);
    await tick(panelOf(p).locator('[data-testid^="add-product-"]').first());
    await p.waitForTimeout(600);
    await primary(p).click();
    const alert = await dialog(p).getByRole('alert').innerText({ timeout: 10000 });
    const state = await dialog(p).evaluate((d) => ({
      ticked: d.querySelectorAll('[data-testid^="add-product-"] input[type="checkbox"]:checked').length,
      primary: [...d.querySelector('[data-workshop-dialog-footer]').querySelectorAll('button')].at(-1)?.disabled ?? null,
    }));
    const file = await shoot(p, 'add-refused@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['POST …/lines/batch → 409 with a sentence'], actions: ['tick', 'Add'] },
      measured: { alert, state, errors },
      pass: /змінилось/.test(alert) && state.ticked === 1 && state.primary === false && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 4. «Вироби» (C02–C06, H01, R02, R11, B05) =======================
  await scenario('add-products@1440', ['E5-C02', 'E5-C03', 'E5-C04', 'E5-C05', 'H01'], async () => {
    // One other row is a draft (the stand has none among the catalog's first rows).
    const { ctx, p, errors, requests } = await open(1440, {
      writes: [SUGGEST],
      rewrite: [[/\/api\/v1\/products\/?\?/, (page) => ({ ...page, items: (page.items ?? []).map((it, i) => (i === 1 ? { ...it, status: 'draft' } : it)) })]],
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openAdd(p);
    const draftRow = await panelOf(p).locator('[data-testid^="add-product-"]').nth(1).locator('td').nth(1).innerText();
    await search(p, productP.sku || productP.code);
    const row = productRow(p, P);
    const heads = await panelOf(p).locator('thead th').evaluateAll((ths) => ths.map((th) => th.textContent.trim()));
    const unpicked = await row.evaluate((tr) => [...tr.children].map((td) => td.innerText.trim().replace(/\s+/g, ' ')));
    // The mockup writes an unpicked row's configuration, stock and material/colour in `small`
    // (12 px): what the row COULD be reads quieter than what is picked.
    const unpickedType = await row.evaluate((tr) => [2, 4, 5].flatMap((i) => [...tr.children[i].querySelectorAll('span, div')]
      .filter((el) => el.childElementCount === 0 && el.textContent.trim()).map((el) => getComputedStyle(el).fontSize)));
    const qtyDisabled = await row.getByLabel('Кількість').isDisabled();
    const mark = requests.length;
    await tick(row);
    await p.waitForTimeout(1000);
    const picked = await row.evaluate((tr) => ({
      selects: [...tr.children[2].querySelectorAll('select')].map((s) => ({ label: s.getAttribute('aria-label'), value: s.value, options: [...s.options].map((o) => o.textContent) })),
      stock: tr.children[4]?.innerText.trim().replace(/\s+/g, ' ') ?? null,
    }));
    const detailReads = requests.slice(mark).filter((r) => /^GET \/api\/v1\/products\/\d+(\?|$)/.test(r));
    const file = await shoot(p, 'add-products@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['POST /stock/suggest → runner proposal', 'GET /products/?… → the second row of a page marked draft'], actions: [`search ${productP.sku || productP.code}`, 'tick'] },
      measured: { heads, unpicked, unpickedType, qtyDisabled, picked, detailReads, draftRow, errors },
      pass: heads.join('|') === 'Обрати|Виріб|Конфігурація|Кількість|Зі складу|Матеріал / колір' && /: .+ \/ /.test(unpicked[2] ?? '') &&
        unpickedType.length >= 3 && unpickedType.every((size) => size === '12px') &&
        /усі конфіг\./.test(unpicked[4] ?? '') && qtyDisabled && picked.selects.length > 0 && /з 5/.test(picked.stock ?? '') &&
        detailReads.length === 0 && /· чернетка/.test(draftRow) && errors.length === 0,
      screenshots: [file],
    };
  });

  // Stock (R02): an answer is shown only for the question it answers; a cached answer whose
  // re-read failed keeps its numbers with a note; a manual row keeps its own numbers throughout.
  await scenario('add-stock-states@1440', ['E5-C06', 'R02', 'I4-2'], async () => {
    let mode = 'answer';
    const { ctx, p, errors } = await open(1440, {
      writes: [[/\/stock\/suggest/, async (req) => {
        if (mode === 'wait') { await new Promise((r) => setTimeout(r, 5000)); return suggestAnswer(req); }
        if (mode === 'fail') return { __status: 500, json: { detail: 'e05 runner' } };
        return suggestAnswer(req);
      }]],
    });
    await p.clock.install();
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openAdd(p);
    await search(p, productP.sku || productP.code);
    const row = productRow(p, P);
    const stockCell = row.locator('td').nth(4);
    await tick(row);
    await stockCell.getByText('з 5').first().waitFor({ timeout: 8000 });
    const answered = await stockCell.innerText();
    // (1) the same question re-read in the background, and the re-read fails.
    mode = 'fail';
    await refetchLater(p);
    await stockCell.getByText('Склад міг змінитися').waitFor({ timeout: 8000 });
    const refreshFailed = await stockCell.innerText();
    const fileNote = await shoot(p, 'add-stock-refresh-failed@1440');
    // (2) another option, its answer held: the old numbers are not shown for the new question.
    mode = 'wait';
    const group = row.locator('td').nth(2).locator('select').first();
    const other = await group.evaluate((s) => [...s.options].map((o) => o.value).find((v) => v !== '' && v !== s.value));
    await group.selectOption(other);
    await p.waitForTimeout(800);
    const waiting = await stockCell.innerText();
    const fileWait = await shoot(p, 'add-stock-waiting@1440');
    // (3) another quantity, refused: no answer, a retry.
    mode = 'fail';
    await row.getByLabel('Кількість').fill('3');
    await stockCell.getByText('Не вдалося прочитати склад').waitFor({ timeout: 8000 });
    const failed = await stockCell.innerText();
    const fileFail = await shoot(p, 'add-stock-failed@1440');
    mode = 'answer';
    await stockCell.getByRole('button', { name: 'Спробувати знову' }).click();
    await stockCell.getByText('з 5').first().waitFor({ timeout: 8000 });
    // (4) the operator's own number survives a new question that is still being asked.
    await stockCell.getByLabel('Готових одиниць').fill('2');
    await p.waitForTimeout(300);
    mode = 'wait';
    await row.getByLabel('Кількість').fill('4');
    await p.waitForTimeout(800);
    const manual = { value: await stockCell.getByLabel('Готових одиниць').inputValue(), text: await stockCell.innerText() };
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['POST /stock/suggest → answered / 500 / held 5 s, switched by the runner'], actions: [`tick ${productP.sku || productP.code}`, 'a minute later: re-read fails', 'another option (held)', 'quantity 3 (refused)', 'retry', 'ready units 2 by hand', 'quantity 4 (held)'] },
      measured: { answered, refreshFailed, waiting, failed, manual, errors },
      pass: /з 5/.test(answered) && /з 5/.test(refreshFailed) && /Склад міг змінитися/.test(refreshFailed) &&
        /склад читається/.test(waiting) && !/з 5|підібрано|друкувати/.test(waiting) &&
        /Не вдалося прочитати склад/.test(failed) && !/з 5|друкувати/.test(failed) &&
        manual.value === '2' && errors.length === 0,
      screenshots: [fileNote, fileWait, fileFail],
    };
  });

  await scenario('add-inactive@1440', ['E5-B05'], async () => {
    const { ctx, p, errors, requests } = await open(1440);
    await p.goto(detail(C), { waitUntil: 'networkidle' });
    await ready(p);
    await openAdd(p);
    await tick(panelOf(p).locator('[data-testid^="add-product-"]').first());
    await p.waitForTimeout(800);
    const text = await dialog(p).innerText();
    const heads = await panelOf(p).locator('thead th').evaluateAll((ths) => ths.map((th) => th.textContent.trim()));
    const suggest = requests.filter((r) => /\/stock\/suggest/.test(r)).length;
    const file = await shoot(p, 'add-inactive@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:245}', actions: ['«Додати в замовлення»', 'tick the first product'] },
      measured: { note: /склад під нього не береться/.test(text), heads, suggest, errors },
      pass: /склад під нього не береться/.test(text) && !heads.includes('Зі складу') && suggest === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 5. «Деталі з виробу» (D01–D07) =======================
  for (const w of [1440, 390]) {
    await scenario(`add-parts@${w}`, ['E5-D02', 'E5-D04', 'E5-D05', 'E5-D06'], async () => {
      const { ctx, p, errors, requests } = await open(w, { writes: [SUGGEST] });
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await openAdd(p);
      await tabIn(p, 'Деталі з виробу');
      await search(p, 'clm01');
      const row = panelOf(p).locator('[data-testid^="add-part-"]').first();
      await tick(row);
      await row.getByLabel('Замовити, шт.').fill('30');
      await tick(panelOf(p).locator('[data-testid^="add-part-"]').nth(1));
      await p.waitForTimeout(300);
      const cells = await row.evaluate((tr) => [...tr.children].map((td) => td.innerText.trim().replace(/\s+/g, ' ')));
      const heads = await panelOf(p).locator('thead th').evaluateAll((ths) => ths.map((th) => th.textContent.trim()));
      const broken = await splitWords(panelOf(p).locator('[data-testid^="add-part-"] td:nth-child(2) .font-semibold'));
      // The source reads as the mockup's `small` (12 px), its file name never split mid-token.
      const fileCell = panelOf(p).locator('[data-testid^="add-part-"] td:nth-child(3) > div:first-child');
      const fileBroken = await splitWords(fileCell);
      const fileSize = await fileCell.first().evaluate((el) => getComputedStyle(el).fontSize);
      const summaryText = await footer(p).innerText();
      const overflow = await docOverflow(p);
      const library = requests.filter((r) => /\/api\/v1\/library\//.test(r));
      const file = await shoot(p, `add-parts@${w}`);
      await ctx.close();
      return {
        recipe: { url: '/projects/{order:241}', viewport: w, actions: ['tab «Деталі з виробу»', 'search clm01', 'tick the first (30) and the second'] },
        measured: { heads, cells, broken, fileBroken, fileSize, summaryText, overflow, library, errors },
        pass: heads.length === 5 && broken.length === 0 && fileBroken.length === 0 && fileSize === '12px' && /(плита \d+|увесь файл)/.test(cells[2] ?? '') && /\d+ шт\./.test(cells[3] ?? '') &&
          /≈ \d+(–\d+)? плит/.test(cells[4] ?? '') && /Обрано деталей: 2 · 31 шт\./.test(summaryText) &&
          overflow <= 0 && library.length === 0 && errors.length === 0,
        screenshots: [file],
      };
    });
  }

  await scenario('add-parts-hidden@1440', ['E5-D04', 'R04'], async () => {
    const hide = (pg) => ({ ...pg, items: (pg.items ?? []).map((row) => ({ ...row, sources: (row.sources ?? []).map((s) => ({ ...s, filename: null, hidden: true })) })) });
    const { ctx, p, errors } = await open(1440, { writes: [SUGGEST], rewrite: [[/\/api\/v1\/products\/parts/, hide]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openAdd(p);
    await tabIn(p, 'Деталі з виробу');
    await search(p, 'clm01');
    const cell = await panelOf(p).locator('[data-testid^="add-part-"]').first().locator('td').nth(2).innerText();
    // A part with nothing sliced, if the catalog holds one: the tail with only its STL.
    await search(p, 'dif01');
    const noSliced = await panelOf(p).getByText('немає нарізаної плити').count();
    const file = await shoot(p, 'add-parts-hidden@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['GET /products/parts → every source hidden'], actions: ['search clm01', 'search dif01'] },
      measured: { cell, noSliced, errors },
      pass: /Файл без доступу/.test(cell) && /плита \d+|увесь файл/.test(cell) && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 6. «Разовий з файлу» (E01–E09, R01, R04, R08) =======================
  const fileRow = (p, name) => panelOf(p).getByRole('button', { name: new RegExp(`^${name}`) }).first();
  await scenario('add-plate@1440', ['E5-E04', 'E5-E05', 'E5-E06', 'E5-E07', 'E5-E08', 'R01', 'R08', 'I4-3'], async () => {
    const sentBatches = [];
    const { ctx, p, errors, requests } = await open(1440, { writes: [SUGGEST, batchWrite(sentBatches)], rewrite: [TAGGED] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openAdd(p);
    await tabIn(p, 'Разовий з файлу');
    const plateReads = () => requests.filter((r) => /\/plates(\?|$)/.test(r)).length;
    const readsBefore = plateReads();

    await search(p, 'rem06_buttons');
    const stlRow = await fileRow(p, 'rem06_buttons\\.stl').innerText();
    await fileRow(p, 'rem06_buttons\\.stl').click();
    await p.waitForTimeout(700);
    const stlPane = await panelOf(p).innerText();
    const stlPrimary = await primary(p).isDisabled();

    await search(p, 'sign_holder');
    const unslicedRow = await fileRow(p, 'sign_holder\\.3mf').innerText();
    await fileRow(p, 'sign_holder\\.3mf').click();
    await p.waitForTimeout(700);
    const unslicedPane = await panelOf(p).innerText();
    const unslicedPrimary = await primary(p).isDisabled();
    const refusedReads = plateReads() - readsBefore;

    await search(p, 'cable_clip');
    const slicedRow = await fileRow(p, 'cable_clip_set').innerText();
    await fileRow(p, 'cable_clip_set').click();
    await panelOf(p).getByRole('radio').last().check({ timeout: 10000 });
    await panelOf(p).getByLabel('Копій плити').fill('3');
    await p.waitForTimeout(600);
    // E08: the field sits in the form grid under the plates — its label over it, 88 px wide.
    const copiesField = await panelOf(p).evaluate((panel) => {
      const input = panel.querySelector('input[aria-label="Копій плити"]');
      const label = input && input.id ? panel.querySelector(`label[for="${input.id}"]`) : null;
      const i = input.getBoundingClientRect();
      const l = label ? label.getBoundingClientRect() : null;
      return { width: Math.round(i.width), labelAbove: l ? l.bottom <= i.top + 1 : false };
    });
    const fileSliced = await shoot(p, 'add-plate@1440');
    // The chosen file survives a search that takes it off the list.
    await search(p, 'price_holder');
    const survives = await panelOf(p).locator('[role="radiogroup"] input:checked').count();
    await fileRow(p, 'price_holder_v2').click();
    await panelOf(p).getByRole('radio').first().waitFor({ timeout: 10000 });
    const kept = {
      copies: await panelOf(p).getByLabel('Копій плити').inputValue(),
      checked: await panelOf(p).locator('[role="radiogroup"] input:checked').count(),
    };
    await panelOf(p).getByRole('radio').first().check();
    await p.waitForTimeout(300);
    await primary(p).click();
    await within(p.waitForFunction(() => !document.querySelector('[role="dialog"]')), 10000, 'dialog_stayed');
    await ctx.close();
    const plateLine = (sentBatches[0]?.body?.lines ?? []).find((l) => l.kind === 'plate');
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['POST …/lines/batch → intercepted', TAGGED_NOTE], actions: ['STL rem06_buttons', 'unsliced sign_holder.3mf', 'cable_clip_set: last plate, copies 3', 'search price_holder (the chosen file leaves the list)', 'price_holder_v2: first plate', 'Add'] },
      measured: { stlRow, stlPane: stlPane.slice(0, 300), stlPrimary, unslicedRow, unslicedPane: unslicedPane.slice(0, 300), unslicedPrimary, refusedReads, slicedRow, copiesField, survives, kept, plateLine, errors },
      pass: /STL — не додається/.test(stlRow) && copiesField.labelAbove && Math.abs(copiesField.width - 88) <= 1 && /Цей тип файлу не додається/.test(stlPane) && stlPrimary &&
        /не нарізано/.test(unslicedRow) && /не нарізаний/.test(unslicedPane) && unslicedPrimary && refusedReads === 0 &&
        !/не нарізано/.test(slicedRow) && survives === 1 && kept.copies === '3' && kept.checked === 0 &&
        plateLine?.library_file_id === F['price_holder_v2.gcode.3mf'] && plateLine?.copies === 3 && errors.length === 0,
      screenshots: [fileSliced],
    };
  });

  // A plate's picture is a protected media path asked with the media token (R04). None of the
  // stand's plates carries a picture, so the plates answer is told they do: the REAL
  // `plate-thumbnail` path is asked, and its status says whether the token was taken (a 404
  // is «no picture», a 401/403 would be the token refused). A loaded picture stays unproven.
  await scenario('add-plate-thumbnail@1440', ['E5-E07', 'R04'], async () => {
    const fileId = F['cable_clip_set.gcode.3mf'];
    const withPictures = (b) => ({ ...b, plates: (b.plates ?? []).map((pl) => ({ ...pl, has_thumbnail: true, thumbnail_url: `/api/v1/library/files/${fileId}/plate-thumbnail/${pl.index}` })) });
    const { ctx, p, errors } = await open(1440, { rewrite: [TAGGED, [new RegExp(`/api/v1/library/files/${fileId}/plates`), withPictures]] });
    const answers = [];
    p.on('response', (r) => {
      if (!r.url().includes('/plate-thumbnail/')) return;
      const u = new URL(r.url());
      answers.push({ path: u.pathname, token: u.searchParams.has('token'), status: r.status() });
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openAdd(p);
    await tabIn(p, 'Разовий з файлу');
    await search(p, 'cable_clip');
    await fileRow(p, 'cable_clip_set').click();
    await panelOf(p).getByRole('radio').first().waitFor({ timeout: 10000 });
    await p.waitForTimeout(1500);
    const shown = await panelOf(p).locator('[role="radiogroup"]').evaluate((g) => ({ imgs: g.querySelectorAll('img').length, icons: g.querySelectorAll('svg').length }));
    await ctx.close();
    const asked = answers.length > 0 && answers.every((a) => /^\/api\/v1\/library\/files\/\d+\/plate-thumbnail\/\d+$/.test(a.path) && a.token);
    const taken = answers.every((a) => a.status !== 401 && a.status !== 403);
    const loaded = answers.length > 0 && answers.every((a) => a.status === 200);
    return {
      recipe: { url: '/projects/{order:241}', fixture: [TAGGED_NOTE, 'GET …/cable_clip_set/plates → each plate told it has a picture (the real thumbnail path)'], actions: ['file: cable_clip_set'] },
      measured: { answers, shown, errors },
      pass: !asked || !taken || errors.length > 0 ? false : loaded ? true : null,
      pending_reason: asked && taken && !loaded ? 'the stand holds no plate picture: the real path was asked with the media token and not refused, a loaded picture is not proven' : undefined,
    };
  });

  await scenario('add-plate-states@1440', ['E5-E03', 'E5-E04', 'E5-E07', 'R01', 'R04'], async () => {
    const { ctx, p, errors } = await open(1440, {
      fail: [
        [/\/api\/v1\/library\/folders/, 500],
        [new RegExp(`/api/v1/library/files/${F['price_holder_v2.gcode.3mf']}/plates`), 500],
        [/\/plate-thumbnail\//, 500],
      ],
      delay: [[new RegExp(`/api/v1/library/files/${F['cable_clip_set.gcode.3mf']}/plates`), 6000]],
      rewrite: [
        TAGGED,
        [new RegExp(`/api/v1/library/files/${F['hook_small_v2.gcode.3mf']}/plates`), (b) => ({ ...b, plates: [], is_multi_plate: false })],
        // A plate told it has a picture whose request then fails: the icon takes its place.
        [new RegExp(`/api/v1/library/files/${F['calibration_cube.gcode.3mf']}/plates`), (b) => ({
          ...b, plates: (b.plates ?? []).map((pl) => ({ ...pl, has_thumbnail: true, thumbnail_url: `/api/v1/library/files/${F['calibration_cube.gcode.3mf']}/plate-thumbnail/${pl.index}` })),
        })],
      ],
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openAdd(p);
    await tabIn(p, 'Разовий з файлу');
    await search(p, 'cable_clip');
    const row = await fileRow(p, 'cable_clip_set').innerText();
    await fileRow(p, 'cable_clip_set').click();
    await p.waitForTimeout(600);
    const reading = await panelOf(p).innerText();
    const fileReading = await shoot(p, 'add-plate-reading@1440');
    await search(p, 'price_holder');
    await fileRow(p, 'price_holder_v2').click();
    await panelOf(p).getByText('Не вдалося прочитати плити').waitFor({ timeout: 8000 });
    const failed = await panelOf(p).innerText();
    await search(p, 'hook_small');
    await fileRow(p, 'hook_small_v2').click();
    await panelOf(p).getByText('Немає плит для додавання').waitFor({ timeout: 8000 });
    // A picture that fails to load gives way to the icon.
    await search(p, 'calibration_cube');
    await fileRow(p, 'calibration_cube').click();
    await panelOf(p).getByRole('radio').first().waitFor({ timeout: 10000 });
    await p.waitForTimeout(1200);
    const stub = await panelOf(p).locator('[role="radiogroup"]').evaluate((g) => ({ imgs: g.querySelectorAll('img').length, icons: g.querySelectorAll('svg').length }));
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: [TAGGED_NOTE, 'GET /library/folders → 500', 'GET …/cable_clip_set/plates → held 6 s', 'GET …/price_holder_v2/plates → 500', 'GET …/hook_small_v2/plates → no plates', 'GET …/calibration_cube/plates → told it has a picture', 'GET …/plate-thumbnail/… → 500'] },
      measured: { row, reading: /Плити читаються/.test(reading), failed: /Не вдалося прочитати плити/.test(failed), stub, errors },
      // A folder the tree could not name is left out — never called the library.
      pass: !/Бібліотека/.test(row) && /Плити читаються/.test(reading) && /Не вдалося прочитати плити/.test(failed) && /Спробувати знову/.test(failed) &&
        stub.imgs === 0 && stub.icons > 0 && errors.length === 0,
      screenshots: [fileReading],
    };
  });

  await scenario('add-plate-list@1440', ['E5-E03'], async () => {
    const run = async (opts, wait) => {
      const { ctx, p, errors } = await open(1440, opts);
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await openAdd(p);
      await tabIn(p, 'Разовий з файлу');
      if (wait) await panelOf(p).getByText(wait).first().waitFor({ timeout: 8000 });
      const text = await panelOf(p).innerText();
      await ctx.close();
      return { text: text.slice(0, 400), errors };
    };
    const cold = await run({ delay: [[/\/api\/v1\/library\/files\?/, 6000]] }, null);
    const refused = await run({ fail: [[/\/api\/v1\/library\/files\?/, 500]] }, 'Не вдалося прочитати файли');
    const forbidden = await run({ fail: [[/\/api\/v1\/library\/files\?/, 403]] }, 'Не вдалося прочитати файли');
    const empty = await run({ rewrite: [[/\/api\/v1\/library\/files\?/, (pg) => ({ ...pg, items: [], meta: { ...(pg.meta ?? {}), total: 0, last_page: 1 } })]] }, 'У бібліотеці немає файлів');
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['GET /library/files → held 6 s', '→ 500', '→ 403', '→ empty page'] },
      measured: { cold, refused, forbidden, empty },
      pass: /Завантаження/.test(cold.text) && /Спробувати знову/.test(refused.text) && /Спробувати знову/.test(forbidden.text) &&
        /У бібліотеці немає файлів/.test(empty.text) && [cold, refused, forbidden, empty].every((r) => r.errors.length === 0),
    };
  });

  await scenario('add-plate-noaccess@1440', ['E5-E01', 'R04', 'I4-4'], async () => {
    const { ctx, p, errors, requests } = await open(1440, { me: NO_LIBRARY, writes: [SUGGEST] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openAdd(p);
    await tabIn(p, 'Деталі з виробу');
    await search(p, 'clm01');
    const partsText = await panelOf(p).locator('[data-testid^="add-part-"]').first().innerText();
    await tabIn(p, 'Разовий з файлу');
    const text = await panelOf(p).innerText();
    const library = requests.filter((r) => /\/api\/v1\/library\//.test(r));
    const file = await shoot(p, 'add-plate-noaccess@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['GET /auth/me → without library:read / read_own / read_all'], actions: ['tab «Деталі з виробу», search clm01', 'tab «Разовий з файлу»'] },
      measured: { partsText, text: text.slice(0, 200), library, errors },
      pass: /\d+ шт\./.test(partsText) && /може читати бібліотеку файлів/.test(text) && library.length === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 7. «Конфігурація деталей» (F01–F08, R03, R05, R11) =======================
  const openConfig = async (p, line) => {
    await p.locator(`tr[data-line="${line.id}"]`).getByRole('button', { name: /^Дії позиції/ }).click();
    await p.getByRole('menuitem', { name: 'Конфігурація деталей…' }).click();
    await dialog(p).waitFor({ timeout: 10000 });
    await p.waitForTimeout(900);
  };
  const standardChoices = () => Object.fromEntries((lineProduct?.variant_groups ?? [])
    .filter((g) => g.default_option_id != null).map((g) => [String(g.id), g.default_option_id]));
  const impactAnswer = { reserved_before: 2, reserved_after: 1, finished_before: 8, finished_after: 0, dropping: [] };
  for (const w of [1440, 390]) {
    await scenario(`config-241@${w}`, ['E5-F01', 'E5-F03', 'E5-F04', 'E5-F06', 'E5-F07', 'R03', 'R05'], async () => {
      if (!lineA) return { pass: null, pending_reason: 'order 241 has no product line on this stand' };
      const saved = [];
      const { ctx, p, errors } = await open(w, {
        writes: [[/\/configuration$/, (req) => {
          const body = JSON.parse(req.postData() || '{}');
          if (body.dry_run) return impactAnswer;
          saved.push(body);
          return orderA;
        }]],
      });
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await openConfig(p, lineA);
      const d = dialog(p);
      await d.getByRole('radio').first().waitFor({ timeout: 10000 });
      const frame = await frameOf(p);
      const subtitle = await subtitleOf(p);
      const heads = await d.locator('thead th').evaluateAll((ths) => ths.map((th) => th.textContent.trim()));
      const legends = await d.locator('fieldset legend').allInnerTexts();
      const standardMark = await d.getByText('(стандарт)').count();
      const rows = await d.locator('[data-testid^="config-part-"]').evaluateAll((trs) => trs.map((tr) => ({ opacity: getComputedStyle(tr).opacity, text: tr.innerText.replace(/\s+/g, ' ').slice(0, 120) })));
      const file = await shoot(p, `config-241@${w}`);
      // A saved non-standard line, untouched: «reset» brings back the standard, and the impact is read.
      const reset = d.getByRole('button', { name: 'Скинути до стандартної' });
      const resetShown = await reset.isVisible();
      await reset.click();
      await d.locator('[data-testid="line-config-impact"]').getByText('Резерв комплектів').waitFor({ timeout: 8000 });
      const impact = await d.locator('[data-testid="line-config-impact"]').innerText();
      const save = d.getByRole('button', { name: 'Зберегти конфігурацію' });
      const enabled = await save.isEnabled();
      const fileImpact = await shoot(p, `config-241-impact@${w}`);
      if (enabled) await save.click();
      await p.waitForTimeout(800);
      const overflow = await docOverflow(p);
      await ctx.close();
      const expected = expectedWidth(frame, 1000, 0.94);
      const body = saved[0] ?? null;
      const choicesOk = body != null && JSON.stringify(Object.entries(body.choices ?? {}).map(([k, v]) => [String(k), v]).sort()) ===
        JSON.stringify(Object.entries(standardChoices()).sort()) && Object.keys(body.part_counts ?? {}).length === 0;
      return {
        recipe: { url: '/projects/{order:241}', viewport: w, fixture: ['PUT …/configuration dry_run → an impact', 'PUT …/configuration → intercepted'], actions: ['line menu → «Конфігурація деталей…»', '«Скинути до стандартної»', 'Save'] },
        measured: { frame, expected: Math.round(expected), subtitle, heads, legends, standardMark, rows, resetShown, impact, enabled, body, overflow, errors },
        pass: Math.abs(frame.width - expected) <= 2 && subtitle === `${orderA.code} · ${lineA.product_name} × ${lineA.quantity}` &&
          heads.length === 5 && legends.length > 0 && standardMark > 0 && resetShown && /Резерв комплектів: 2 → 1/.test(impact) &&
          /Готових зі складу: 8 → 0/.test(impact) && enabled && choicesOk && overflow <= 0 && errors.length === 0,
        screenshots: [file, fileImpact],
      };
    });
  }

  await scenario('config-states@1440', ['E5-F02', 'E5-F07', 'E5-F08', 'R05', 'I4-5'], async () => {
    if (!lineA) return { pass: null, pending_reason: 'order 241 has no product line on this stand' };
    let failProduct = 2; // the read and its one retry (the app retries a read once)
    let failPreview = 1; // the preview is never retried by itself
    const productPath = new RegExp(`/api/v1/products/${lineA.product_id}(\\?.*)?$`);
    const { ctx, p, errors, route } = await open(1440, {
      writes: [[/\/configuration$/, (req) => {
        const body = JSON.parse(req.postData() || '{}');
        if (body.dry_run && failPreview > 0) { failPreview -= 1; return { __status: 500, json: { detail: 'Не вдалося перевірити' } }; }
        return impactAnswer;
      }]],
    });
    // The product read fails through this runner's own fixture (a fulfilled 500), then reads the stand.
    await route(productPath, async (r) => {
      if (r.request().method() === 'GET' && failProduct > 0) {
        failProduct -= 1;
        return r.fulfill({ status: 500, json: { detail: 'e05 runner' } });
      }
      return r.fallback();
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await p.locator(`tr[data-line="${lineA.id}"]`).getByRole('button', { name: /^Дії позиції/ }).click();
    await p.getByRole('menuitem', { name: 'Конфігурація деталей…' }).click();
    const d = dialog(p);
    await d.getByText('Не вдалося прочитати виріб').waitFor({ timeout: 10000 });
    const saveOffOnFail = await d.getByRole('button', { name: 'Зберегти конфігурацію' }).isDisabled();
    await d.getByRole('button', { name: 'Спробувати знову' }).click();
    await d.getByRole('radio').first().waitFor({ timeout: 10000 });
    await d.getByRole('button', { name: 'Скинути до стандартної' }).click();
    const impact = d.locator('[data-testid="line-config-impact"]');
    await impact.getByText('Не вдалося перевірити').waitFor({ timeout: 8000 });
    const previewFailed = await impact.innerText();
    const saveOffOnPreviewFail = await d.getByRole('button', { name: 'Зберегти конфігурацію' }).isDisabled();
    const file = await shoot(p, 'config-states@1440');
    await impact.getByRole('button', { name: 'Спробувати знову' }).click();
    await impact.getByText('Резерв комплектів').waitFor({ timeout: 8000 });
    const saveOnAfterRetry = await d.getByRole('button', { name: 'Зберегти конфігурацію' }).isEnabled();
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['GET /products/{line product} → 500 twice, then the stand', 'PUT …/configuration dry_run → 500 twice, then an impact'], actions: ['line menu → «Конфігурація деталей…»', 'retry', 'reset', 'retry the impact'] },
      measured: { saveOffOnFail, previewFailed, saveOffOnPreviewFail, saveOnAfterRetry, errors },
      pass: saveOffOnFail && /Не вдалося перевірити/.test(previewFailed) && saveOffOnPreviewFail && saveOnAfterRetry && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('config-244-parts@1440', ['E5-F01', 'E5-F05'], async () => {
    if (!partsLineB) return { pass: null, pending_reason: 'order 244 has no parts line on this stand' };
    const { ctx, p, errors } = await open(1440);
    await p.goto(detail(B), { waitUntil: 'networkidle' });
    await ready(p);
    await openConfig(p, partsLineB);
    const d = dialog(p);
    await d.locator('thead th').first().waitFor({ timeout: 10000 });
    const heads = await d.locator('thead th').evaluateAll((ths) => ths.map((th) => th.textContent.trim()));
    const subtitle = await subtitleOf(p);
    const ticks = await d.locator('tbody input[type="checkbox"]').count();
    const file = await shoot(p, 'config-244-parts@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:244}', actions: ['parts line menu → «Конфігурація деталей…»'] },
      measured: { heads, subtitle, ticks, errors },
      pass: heads.join('|') === 'Деталь|Потрібно, шт.|Джерело' && subtitle === `${orderB.code} · ${partsLineB.product_name} · лише деталі` && ticks === 0 && errors.length === 0,
      screenshots: [file],
    };
  });

  // ======================= 8. F12: from a product (G01, G02, K4) =======================
  const catalogUrl = `${job.ui}/products?q=${encodeURIComponent(productP.sku || productP.code)}`;
  await scenario('f12-catalog@1440', ['E5-G01', 'E5-G02'], async () => {
    const more = (pg) => ({ ...pg, meta: { ...(pg.meta ?? {}), total: Math.max(43, pg.meta?.total ?? 0) } });
    const { ctx, p, errors } = await open(1440, { writes: [SUGGEST], rewrite: [[/\/api\/v1\/projects\/?\?.*status=active/, more]] });
    await p.goto(catalogUrl, { waitUntil: 'networkidle' });
    await p.waitForTimeout(800);
    await p.getByTestId(`product-${P}-row-menu`).click();
    const item = p.getByRole('menuitem', { name: 'До замовлення…' });
    const offered = await item.count();
    await item.click();
    await dialog(p).waitFor({ timeout: 10000 });
    await dialog(p).getByText(/Показано \d+ з \d+/).waitFor({ timeout: 10000 });
    const d = dialog(p);
    const subtitle = await subtitleOf(p);
    const options = await d.getByLabel('Замовлення', { exact: true }).evaluate((s) => [...s.options].slice(1).map((o) => o.textContent));
    const shown = await d.getByText(/Показано \d+ з \d+/).innerText();
    const preselected = await productRow(p, P).locator('input[type="checkbox"]').isChecked();
    const file = await shoot(p, 'f12-catalog@1440');
    await ctx.close();
    return {
      recipe: { url: `/products?q=${productP.sku || productP.code}`, fixture: ['GET /projects/?status=active → total ≥ 43'], actions: ['row menu → «До замовлення…»'] },
      measured: { offered, subtitle, options: options.slice(0, 3), shown, preselected, errors },
      pass: offered === 1 && subtitle === 'Оберіть замовлення' && options.length > 0 && options.every((o) => o.split(' · ').length === 3) &&
        /Показано \d+ з 43|Показано \d+ з \d+/.test(shown) && preselected && errors.length === 0,
      screenshots: [file],
    };
  });

  await scenario('f12-menu-gates@1440', ['E5-G01'], async () => {
    const menuHas = async (opts) => {
      const { ctx, p, errors } = await open(1440, opts);
      await p.goto(catalogUrl, { waitUntil: 'networkidle' });
      await p.waitForTimeout(800);
      await p.getByTestId(`product-${P}-row-menu`).click();
      await p.getByRole('menu').waitFor({ timeout: 5000 });
      const items = await p.getByRole('menuitem').allInnerTexts();
      await ctx.close();
      return { toOrder: items.some((i) => /До замовлення/.test(i)), errors };
    };
    const hidden = await menuHas({ rewrite: [[/\/api\/v1\/products\/?\?/, (pg) => ({ ...pg, items: (pg.items ?? []).map((it) => ({ ...it, is_active: false })) })]] });
    const reader = await menuHas({ me: { is_admin: false, role: 'user', permissions: without('projects:update') } });
    return {
      recipe: { url: `/products?q=${productP.sku || productP.code}`, fixture: ['GET /products/?… → the row hidden (is_active false)', 'GET /auth/me → without projects:update'] },
      measured: { hidden, reader },
      pass: !hidden.toOrder && !reader.toOrder && hidden.errors.length === 0 && reader.errors.length === 0,
    };
  });

  await scenario('f12-states@1440', ['E5-G02'], async () => {
    const choice = async (opts, act) => {
      const { ctx, p, errors } = await open(1440, { writes: [SUGGEST], ...opts });
      await p.goto(`${job.ui}/products/${P}`, { waitUntil: 'networkidle' });
      await openAdd(p);
      const out = await act(p);
      await ctx.close();
      return { ...out, errors };
    };
    const orderText = (p) => dialog(p).locator('select[aria-label="Замовлення"]').locator('xpath=..').innerText();
    const loading = await choice({ delay: [[/\/api\/v1\/projects\/?\?.*status=active/, 6000]] }, async (p) => ({
      text: await orderText(p), disabled: await dialog(p).getByLabel('Замовлення', { exact: true }).isDisabled(),
    }));
    const failed = await choice({ fail: [[/\/api\/v1\/projects\/?\?.*status=active/, 500]] }, async (p) => {
      await dialog(p).getByText('Не вдалося прочитати замовлення').waitFor({ timeout: 8000 });
      return { text: await orderText(p) };
    });
    const empty = await choice({ rewrite: [[/\/api\/v1\/projects\/?\?.*status=active/, (pg) => ({ ...pg, items: [], meta: { ...(pg.meta ?? {}), total: 0 } })]] }, async (p) => {
      await dialog(p).getByText('Активних замовлень немає').waitFor({ timeout: 8000 });
      return { text: await orderText(p) };
    });
    // The chosen order stays chosen when a new search no longer lists it.
    const gone = await choice({}, async (p) => {
      const d = dialog(p);
      await d.getByLabel('Знайти замовлення…').fill(orderA.code);
      await d.getByLabel('Замовлення', { exact: true }).selectOption(String(A), { timeout: 10000 });
      await d.getByLabel('Знайти замовлення…').fill('zzzz-nothing');
      await d.getByText('Нічого не знайдено').first().waitFor({ timeout: 8000 });
      const select = d.getByLabel('Замовлення', { exact: true });
      return { value: await select.inputValue(), label: await select.evaluate((s) => s.selectedOptions[0]?.textContent ?? null), subtitle: await subtitleOf(p) };
    });
    return {
      recipe: { url: '/products/{product:2}', fixture: ['GET /projects/?status=active → held 6 s', '→ 500', '→ empty', 'the stand, then a search that lists nothing'] },
      measured: { loading, failed, empty, gone },
      pass: /Завантаження замовлень/.test(loading.text) && loading.disabled && /Спробувати знову/.test(failed.text) && /Активних замовлень немає/.test(empty.text) &&
        gone.value === String(A) && (gone.label ?? '').startsWith(orderA.code) && gone.subtitle === `${orderA.code} · ${orderA.name}` &&
        [loading, failed, empty, gone].every((r) => r.errors.length === 0),
    };
  });

  // From a product, the batch goes to the order it was sent to, and the page follows it there
  // (K4, R09): while it is held, the order cannot be changed.
  await scenario('f12-navigate@1440', ['E5-B04', 'E5-G02', 'K4', 'R09'], async () => {
    let release = () => {};
    const held = new Promise((r) => { release = r; });
    const sentBatches = [];
    const [re, answerBatch] = batchWrite(sentBatches);
    const { ctx, p, errors } = await open(1440, { writes: [SUGGEST, [re, async (req) => { const out = answerBatch(req); await held; return out; }]] });
    await p.goto(`${job.ui}/products/${P}`, { waitUntil: 'networkidle' });
    await openAdd(p);
    const d = dialog(p);
    await d.getByLabel('Знайти замовлення…').fill(orderA.code);
    await d.getByLabel('Замовлення', { exact: true }).selectOption(String(A), { timeout: 10000 });
    await p.waitForTimeout(700);
    await primary(p).click();
    await p.waitForTimeout(400);
    const frozen = {
      select: await d.getByLabel('Замовлення', { exact: true }).isDisabled(),
      search: await d.getByLabel('Знайти замовлення…').isDisabled(),
    };
    release();
    await within(p.waitForURL(new RegExp(`/projects/${A}(\\?|$)`)), 10000, 'no_navigation');
    const url = new URL(p.url()).pathname;
    await ctx.close();
    return {
      recipe: { url: '/products/{product:2}', fixture: ['POST …/lines/batch → held, then answered'], actions: [`order ${orderA.code}`, 'Add', 'try the order field while held'] },
      measured: { frozen, url, batches: sentBatches.map((b) => b.path), errors },
      pass: frozen.select && frozen.search && url === `/projects/${A}` && sentBatches.length === 1 && sentBatches[0].path === `/api/v1/projects/${A}/lines/batch` && errors.length === 0,
    };
  });

  // ======================= 9. hit tests at 390, themes =======================
  await scenario('hits@390', ['E5-C05', 'E5-E07', 'E5-F03'], async () => {
    const { ctx, p, errors } = await open(390, { writes: [SUGGEST], rewrite: [TAGGED] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openAdd(p);
    await tick(panelOf(p).locator('[data-testid^="add-product-"]').first());
    await p.waitForTimeout(1000);
    const scope = '[role="dialog"] [role="tabpanel"]:not([hidden])';
    const products = await hitTest(p, `${scope} [data-testid^="add-product-"] input, ${scope} [data-testid^="add-product-"] select`);
    const footerHits = await hitTest(p, '[role="dialog"] [data-workshop-dialog-footer] button');
    await tabIn(p, 'Разовий з файлу');
    await search(p, 'cable_clip');
    await fileRow(p, 'cable_clip_set').click();
    await panelOf(p).getByRole('radio').first().waitFor({ timeout: 10000 });
    const plates = await hitTest(p, '[role="dialog"] [role="radiogroup"] input[type="radio"]');
    await p.keyboard.press('Escape');
    await within(p.waitForFunction(() => !document.querySelector('[role="dialog"]')), 5000, 'dialog_stayed');
    let config = [];
    if (lineA) {
      await openConfig(p, lineA);
      await dialog(p).getByRole('radio').first().waitFor({ timeout: 10000 });
      config = await hitTest(p, '[role="dialog"] fieldset input[type="radio"], [role="dialog"] [data-workshop-dialog-footer] button');
    }
    await ctx.close();
    const all = [...products, ...footerHits, ...plates, ...config];
    return {
      recipe: { url: '/projects/{order:241}', viewport: 390, fixture: ['POST /stock/suggest → runner proposal', TAGGED_NOTE], actions: ['add: tick a product', 'file: cable_clip_set', 'configuration of the first line'] },
      measured: { products: products.length, footer: footerHits.length, plates: plates.length, config: config.length, misses: all.filter((h) => !h.inView || !h.hits), errors },
      pass: products.length > 0 && plates.length > 0 && config.length > 0 && all.every((h) => h.inView && h.hits) && errors.length === 0,
    };
  });

  for (const [id, opts, test] of [
    ['theme-light@1440', { storage: { 'theme-mode': 'light' } }, (e) => !/\bdark\b/.test(e.theme)],
    ['theme-oled@1440', { settings: { dark_background: 'oled' } }, (e) => /bg-oled/.test(e.theme)],
  ]) {
    await scenario(id, ['E2-B01', 'E5-C02', 'E5-F01'], async () => {
      const { ctx, p, errors } = await open(1440, { ...opts, writes: [SUGGEST] });
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await openAdd(p);
      await tick(panelOf(p).locator('[data-testid^="add-product-"]').first());
      await p.waitForTimeout(1000);
      const e = await env(p);
      const fileAdd = await shoot(p, `${id}-add`);
      await p.keyboard.press('Escape');
      await within(p.waitForFunction(() => !document.querySelector('[role="dialog"]')), 5000, 'dialog_stayed');
      const shots = [fileAdd];
      if (lineA) {
        await openConfig(p, lineA);
        await dialog(p).getByRole('radio').first().waitFor({ timeout: 10000 });
        shots.push(await shoot(p, `${id}-config`));
      }
      await ctx.close();
      return { env: e, measured: { errors }, pass: test(e) && errors.length === 0, screenshots: shots };
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
