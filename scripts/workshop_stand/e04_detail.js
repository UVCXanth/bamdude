// WS-13 E4 acceptance runner (spec §I1/I2), run by Playwright MCP's browser_run_code_unsafe:
//   filename: scripts/workshop_stand/e04_detail.js — while `e04_evidence.py serve` listens on 127.0.0.1:8197.
// Every scenario records WHAT was run (recipe + fixtures), WHERE (viewport, DPR, the actual <html> classes), WHAT
// was measured and whether it matched the spec — a failure is a failure, a surface it cannot reach is `pending`.
// Nothing reaches the stand but reads: every non-GET request of every context is answered here, and the states the
// baseline does not hold are rewritten GET answers in this runner's own context only. The oracles measure what a
// person reads (widths, lines, where a button sits, one-line buttons), never a class name.
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
    const secretFree = !/authori[sz]ation|bearer|cookie|token|eyJ[\w-]{10,}/i.test(first) && !(job && job.token && first.includes(job.token));
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
    if (job && job.token && text.includes(job.token)) return { id: r.id, ids: r.ids, source: r.source, pass: false, error: { code: 'secret_in_record', stage: r.id } };
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
  const HEIGHTS = { 2560: 1440, 1920: 1080, 1440: 900, 1280: 800, 1024: 768, 768: 1024, 390: 844 };
  const WIDTHS = [2560, 1920, 1440, 1280, 1024, 768, 390];
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
  // `delay`: [[regex, ms]]; `writes`: [[regex, json | (request) => json | {status, json}]] answers for non-GET,
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
      if (sessionStorage.getItem('e04-init')) return;
      sessionStorage.setItem('e04-init', '1');
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
        // Two POSTs only READ — the stock proposal and the print dialog's routing preview —
        // and are answered here with the shape they have (empty), never with `{}`, which the
        // print dialog cannot read.
        const fallback = /\/stock\/suggest/.test(url) ? { items: [] } : /\/printer-routing-preview/.test(url) ? { targets: [] } : {};
        let answer = hit ? (typeof hit[1] === 'function' ? await hit[1](req) : hit[1]) : fallback;
        if (answer && answer.__status) return route.fulfill({ status: answer.__status, json: answer.json ?? {} });
        return route.fulfill({ status: 200, json: answer });
      }
      const failing = fail.find(([re]) => re.test(url));
      if (failing) return route.fulfill({ status: failing[1], json: { detail: 'e04 runner' } });
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
  const tab = async (p, name) => {
    await p.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
    await p.waitForTimeout(700);
  };
  // How many lines a button's text takes — by the distinct line tops of its text, never by a class.
  const buttonLines = (p, selector) => p.evaluate((sel) => [...document.querySelectorAll(sel)].map((b) => {
    const range = document.createRange();
    range.selectNodeContents(b);
    const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
    return { text: b.textContent.trim(), lines: tops.size, height: Math.round(b.getBoundingClientRect().height) };
  }), selector);

  stage = 'prepare';
  const exact = (path) => new RegExp(`/api/v1${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?(\\?.*)?$`);
  const orderA = await read(`/projects/${A}`);
  const orderB = await read(`/projects/${B}`);
  const groups = await read('/groups/');
  const groupList = Array.isArray(groups) ? groups : groups.items;
  const adminPerms = groupList.find((g) => g.name === 'Administrators').permissions;
  const viewerPerms = groupList.find((g) => g.name === 'Viewers').permissions;
  const without = (...drop) => adminPerms.filter((perm) => !drop.includes(perm));
  const meId = (await read('/auth/me')).id;
  const partsLineB = orderB.lines.find((l) => l.mode === 'parts');
  const productLineA = orderA.lines[0];
  // A person reads the menu by its trigger's name: «Дії позиції: <product>».
  const openLineMenu = async (p, product) => {
    await p.getByRole('button', { name: `Дії позиції: ${product}` }).first().click();
    const menu = p.getByRole('menu');
    await menu.waitFor({ timeout: 5000 });
    return menu;
  };
  const menuState = (p) => p.evaluate(() => [...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="separator"]')]
    .map((el) => (el.getAttribute('role') === 'separator' ? '—' : `${el.textContent.trim()}${el.disabled ? ' [off]' : ''}${el.title ? ` {${el.title}}` : ''}`)));
  const dialogText = (p) => p.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].pop()?.innerText ?? null);
  const panel = (p) => p.locator('[role="tabpanel"]:visible').first();
  // Every query of the app is fresh for a minute (appQueryClient), so a background re-read is
  // a minute passing and the page coming back to the front.
  const refetchLater = async (p) => {
    await p.clock.fastForward('01:30');
    await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await p.waitForTimeout(1500);
  };
  // A control counts as reachable when, scrolled into view (a table at 390 scrolls in itself),
  // it is on screen and nothing covers it.
  const hitTest = (p, selector) => p.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { inView: r.left >= 0 && r.right <= innerWidth + 0.5 && r.width > 0, hits: !!hit && (hit === el || el.contains(hit)) };
  }), selector);

  const realScenarios = async () => {
  // ======================= 1. geometry of the lines and the plan (B01, E03, E07) =======================
  for (const w of WIDTHS) {
    await scenario(`geometry@${w}`, ['E4-B01', 'E4-E03', 'E4-E07'], async () => {
      const { ctx, p, errors } = await open(w);
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      const m = await p.evaluate(() => {
        const table = document.querySelector('tr[data-line]')?.closest('table');
        const scroll = table?.parentElement;
        const heads = [...(table?.querySelectorAll('thead th') ?? [])].map((th) => th.textContent.trim());
        const planTables = [...document.querySelectorAll('[data-testid$="-scroll"]')].filter((s) => s.dataset.testid.startsWith('plan-line-'));
        return {
          heads,
          linesTable: table ? Math.round(table.getBoundingClientRect().width) : null,
          linesScroll: scroll ? { client: scroll.clientWidth, scroll: scroll.scrollWidth, overflowX: getComputedStyle(scroll).overflowX } : null,
          planScrolls: planTables.map((s) => ({ client: s.clientWidth, scroll: s.scrollWidth, overflowX: getComputedStyle(s).overflowX })),
          docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      const buttons = await buttonLines(p, '[data-testid^="plan-row-"] td:last-child button');
      const file = await shoot(p, `geometry@${w}`);
      const lower = await p.evaluate(() => document.querySelector('[data-testid="plan-block"]')?.scrollIntoView({ block: 'start' }));
      const file2 = await shoot(p, `geometry@${w}-plan`);
      await ctx.close();
      const sixCols = m.heads.length === 6 && m.heads[1] === 'Виріб / конфігурація' && m.heads[4] === 'Забезпечено';
      const ownScroll = m.linesScroll && (m.linesScroll.scroll <= m.linesScroll.client || /auto|scroll/.test(m.linesScroll.overflowX));
      const oneLine = buttons.length > 0 && buttons.every((b) => b.lines === 1);
      return {
        recipe: { url: '/projects/{order:241}', viewport: w, lower },
        measured: { ...m, buttons, errors },
        pass: sixCols && ownScroll && m.docOverflow <= 0 && oneLine && errors.length === 0,
        screenshots: [file, file2],
      };
    });
  }

  // ======================= 2. lines: menu, reader, delete (B06–B08) =======================
  await scenario('lines-menu@1440', ['E4-B06', 'E4-B08'], async () => {
    const { ctx, p } = await open(1440);
    await p.goto(detail(B), { waitUntil: 'networkidle' });
    await ready(p);
    const names = orderB.lines.slice().sort((a, b) => a.sort_order - b.sort_order || a.id - b.id).map((l) => l.product_name);
    await openLineMenu(p, names[0]);
    const first = await menuState(p);
    const file = await shoot(p, 'lines-menu@1440');
    await p.keyboard.press('Escape');
    // The last row: its trigger is the last one on the page.
    await p.locator('button[aria-label^="Дії позиції"]').last().click();
    await p.getByRole('menu').waitFor();
    const last = await menuState(p);
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:244}', actions: ['menu of the first line', 'menu of the last line'] },
      measured: { first, last },
      pass: first[0].startsWith('Конфігурація деталей…') && first[1] === 'Редагувати позицію…' && first[2] === 'Підняти [off]' &&
        first[3] === 'Опустити' && first[4] === '—' && first[5] === 'Видалити позицію' && last[3] === 'Опустити [off]' && last[2] === 'Підняти',
      screenshots: [file],
    };
  });
  await scenario('lines-reader@1440', ['E4-B06', 'E4-B09'], async () => {
    const { ctx, p } = await open(1440, { me: { is_admin: false, role: 'user', permissions: viewerPerms } });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const m = await p.evaluate(() => ({
      menus: document.querySelectorAll('button[aria-label^="Дії позиції"]').length,
      expanders: document.querySelectorAll('[data-testid^="line-"][data-testid$="-expand"]').length,
    }));
    const file = await shoot(p, 'lines-reader@1440');
    await ctx.close();
    return { recipe: { url: '/projects/{order:241}', fixture: ['GET /auth/me → the Viewers group'] }, measured: m, pass: m.menus === 0 && m.expanders > 0, screenshots: [file] };
  });
  await scenario('lines-delete-confirm@1440', ['E4-B07'], async () => {
    const sent = [];
    const { ctx, p } = await open(1440, { writes: [[/\/projects\/\d+\/lines\/\d+/, (req) => { sent.push(`${req.method()} ${new URL(req.url()).pathname}`); return orderA; }]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openLineMenu(p, productLineA.product_name);
    await p.getByRole('menuitem', { name: 'Видалити позицію' }).click();
    await p.waitForTimeout(400);
    const text = await dialogText(p);
    const file = await shoot(p, 'lines-delete-confirm@1440');
    await p.getByRole('dialog').getByRole('button', { name: 'Видалити' }).click();
    await p.waitForTimeout(600);
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['DELETE /projects/{id}/lines/{line} intercepted, answered with the order'] },
      measured: { text, sent },
      pass: text?.includes(`Видалити позицію «${productLineA.product_name}»?`) && text.includes('Друки цієї позиції лишаться в замовленні без прив’язки; резерв складу повернеться.') &&
        sent.length === 1 && sent[0].startsWith('DELETE'),
      screenshots: [file],
    };
  });

  // ======================= 3. expanded parts (C01–C04) =======================
  for (const [name, id, order] of [['241', A, orderA], ['244', B, orderB]]) {
    for (const w of [1440, 390]) {
      await scenario(`parts-${name}@${w}`, ['E4-C01', 'E4-C02', 'E4-C03', 'E4-B02', 'E4-B03', 'E4-B04', 'E4-B05'], async () => {
        // One part of the first line dropped out of the kit — the «out of the kit» row the stand does not hold.
        const zeroPart = order.lines[0].parts[0]?.part_id;
        const { ctx, p, errors } = await open(w, {
          rewrite: [[exact(`/projects/${id}`), (o) => ({ ...o, lines: o.lines.map((l, i) => (i === 0 ? { ...l, parts: l.parts.map((pt) => (pt.part_id === zeroPart ? { ...pt, qty_per_unit: 0 } : pt)) } : l)) })]],
        });
        await p.goto(detail(id), { waitUntil: 'networkidle' });
        await ready(p);
        await p.evaluate(() => document.querySelectorAll('[data-testid^="line-"][data-testid$="-expand"]').forEach((b) => b.click()));
        await p.waitForTimeout(600);
        const m = await p.evaluate(() => {
          const minis = [...document.querySelectorAll('tr[data-line] + tr table')];
          return {
            heads: minis.map((t) => [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim())),
            variant: document.body.innerText.includes('варіант'),
            bought: document.body.innerText.includes('купується'),
            countedIn: document.body.innerText.includes('рахується в «Куповані деталі»'),
            outOfKit: document.body.innerText.includes('поза комплектом'),
            dash: minis.some((t) => [...t.querySelectorAll('tbody tr')].some((tr) => tr.children[1]?.textContent.trim() === '—')),
            thumbs: document.querySelectorAll('[data-testid$="-thumb"]').length,
            configs: [...document.querySelectorAll('[data-testid$="-config"]')].map((el) => el.textContent.trim()),
            docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        const file = await shoot(p, `parts-${name}@${w}`);
        await p.evaluate(() => document.querySelector('tr[data-line] + tr')?.scrollIntoView({ block: 'start' }));
        const file2 = await shoot(p, `parts-${name}@${w}-rows`);
        await ctx.close();
        const sevenCols = m.heads.length > 0 && m.heads.every((h) => h.length === 7 && h[4] === 'У роботі / черзі');
        return {
          recipe: { url: `/projects/{order:${name}}`, viewport: w, actions: ['expand every line'], fixture: [`GET /projects/{order:${name}} → part ${zeroPart} of the first line at qty_per_unit 0`] },
          measured: { ...m, errors },
          pass: sevenCols && m.outOfKit && m.bought === m.countedIn && m.docOverflow <= 0 && (name !== '244' || m.dash) && errors.length === 0,
          screenshots: [file, file2],
        };
      });
    }
  }

  // ======================= 4. «Edit line» (D01–D05) =======================
  const editOpen = async (p, product) => {
    await openLineMenu(p, product);
    await p.getByRole('menuitem', { name: 'Редагувати позицію…' }).click();
    await p.getByRole('dialog', { name: 'Редагувати позицію' }).waitFor({ timeout: 8000 });
    await p.waitForTimeout(800);
  };
  for (const w of [1440, 390]) {
    await scenario(`edit-product@${w}`, ['E4-D01', 'E4-D02', 'E4-D05'], async () => {
      const sent = [];
      const { ctx, p, errors } = await open(w, { writes: [[/\/projects\/\d+\/lines\/\d+$/, (req) => { sent.push({ method: req.method(), body: req.postDataJSON() }); return orderA; }], [/\/stock\/suggest/, { items: [] }]] });
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await editOpen(p, productLineA.product_name);
      const text = await dialogText(p);
      const selects = await p.evaluate(() => [...[...document.querySelectorAll('[role="dialog"]')].pop().querySelectorAll('select')].map((s) => [...s.options].map((o) => o.textContent)));
      const file = await shoot(p, `edit-product@${w}`);
      await p.getByRole('dialog').getByLabel('Нотатка').fill('перевірка e04');
      await p.getByRole('dialog').getByRole('button', { name: 'Зберегти' }).click();
      await p.waitForTimeout(800);
      await ctx.close();
      return {
        recipe: { url: '/projects/{order:241}', viewport: w, actions: ['menu → Редагувати позицію…', 'note typed', 'Зберегти'], fixture: ['PATCH line intercepted'] },
        measured: { text: text?.slice(0, 600), selects, sent, errors },
        pass: /Кількість, шт\./.test(text ?? '') && /Зі складу — готових/.test(text ?? '') && /Зі складу — комплектів деталей/.test(text ?? '') &&
          selects.length === 2 && selects.every((o) => o.includes('будь-який')) && sent.length === 1 && JSON.stringify(sent[0].body) === JSON.stringify({ note: 'перевірка e04' }),
        screenshots: [file],
      };
    });
  }
  await scenario('edit-moved-inactive@1440', ['E4-D04'], async () => {
    const { ctx, p } = await open(1440, {
      rewrite: [[exact(`/projects/${A}`), (o) => ({ ...o, status: 'completed', lines: o.lines.map((l, i) => (i === 0 ? { ...l, issued: 2, held: 3 } : l)) })]],
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await editOpen(p, productLineA.product_name);
    const text = await dialogText(p);
    const qtyMin = await p.getByRole('dialog').getByLabel('Кількість, шт.').getAttribute('min');
    const file = await shoot(p, 'edit-moved-inactive@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', fixture: ['GET /projects/{order:241} → status completed, first line issued 2 held 3'] },
      measured: { text: text?.slice(0, 700), qtyMin },
      pass: qtyMin === '5' && !/Зі складу — готових/.test(text ?? '') && !/Підібрати зі складу/.test(text ?? ''),
      screenshots: [file],
    };
  });
  await scenario('edit-refusal@1440', ['E4-D05'], async () => {
    const { ctx, p } = await open(1440, { writes: [[/\/projects\/\d+\/lines\/\d+$/, () => ({ __status: 409, json: { detail: 'Кількість менша за видане' } })]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await editOpen(p, productLineA.product_name);
    await p.getByRole('dialog').getByLabel('Нотатка').fill('x');
    await p.getByRole('dialog').getByRole('button', { name: 'Зберегти' }).click();
    await p.waitForTimeout(800);
    const alert = await p.getByRole('dialog').getByRole('alert').textContent().catch(() => null);
    const kept = await p.getByRole('dialog').getByLabel('Нотатка').inputValue();
    const file = await shoot(p, 'edit-refusal@1440');
    await ctx.close();
    return { recipe: { fixture: ['PATCH line → 409 «Кількість менша за видане»'] }, measured: { alert, kept }, pass: !!alert && alert.includes('Кількість менша за видане') && kept === 'x', screenshots: [file] };
  });
  await scenario('edit-sources-cold@1440', ['E4-D02', 'R09'], async () => {
    const productId = productLineA.product_id;
    const { ctx, p } = await open(1440, {
      delay: [[exact(`/products/${productId}`), 8000], [new RegExp(`/api/v1/products/${productId}/(stock|kits)`), 8000]],
      writes: [[/\/stock\/suggest/, async () => { await new Promise((r) => setTimeout(r, 8000)); return { items: [] }; }]],
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await openLineMenu(p, productLineA.product_name);
    await p.getByRole('menuitem', { name: 'Редагувати позицію…' }).click();
    await p.getByRole('dialog', { name: 'Редагувати позицію' }).waitFor();
    await p.waitForTimeout(500);
    const text = await dialogText(p);
    const file = await shoot(p, 'edit-sources-cold@1440');
    await ctx.close();
    return {
      recipe: { fixture: ['GET /products/{product}, its stock and its kits delayed 8 s', 'POST /stock/suggest answered after 8 s'] },
      measured: { text: text?.slice(0, 700) },
      pass: /варіанти виробу ще читаються/.test(text ?? '') && /доступність ще читається/.test(text ?? '') && !/доступно 0/.test(text ?? ''),
      screenshots: [file],
    };
  });
  await scenario('edit-sources-failed@1440', ['E4-D02', 'R09'], async () => {
    const productId = productLineA.product_id;
    const { ctx, p } = await open(1440, { fail: [[exact(`/products/${productId}`), 500], [new RegExp(`/api/v1/products/${productId}/(stock|kits)`), 500]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await editOpen(p, productLineA.product_name);
    // One retry (appQueryClient) before a read counts as failed.
    await p.getByText('не вдалося прочитати матеріали виробу').first().waitFor({ timeout: 15000 }).catch(() => {});
    const text = await dialogText(p);
    const file = await shoot(p, 'edit-sources-failed@1440');
    await ctx.close();
    return {
      recipe: { fixture: ['GET /products/{product}, its stock and kits → 500'] },
      measured: { text: text?.slice(0, 700) },
      pass: /не вдалося прочитати матеріали виробу/.test(text ?? '') && /Не вдалося прочитати склад/.test(text ?? '') && !/доступно 0/.test(text ?? ''),
      screenshots: [file],
    };
  });

  // ======================= 5. F03 → F05 (R01) =======================
  await scenario('edit-to-config@1440', ['E4-D03', 'R01'], async () => {
    const requests = [];
    const { ctx, p } = await open(1440);
    p.on('request', (r) => {
      // The page's own token POSTs (socket, media, camera) are not writes of the line.
      if (r.method() !== 'GET' && r.url().includes('/api/v1/') && !/\/auth\/|stream-token/.test(r.url())) requests.push(`${r.method()} ${new URL(r.url()).pathname}`);
    });
    await p.goto(detail(B), { waitUntil: 'networkidle' });
    await ready(p);
    // Clean: straight to the configuration. The parts line is the LAST line of 244; its
    // menu is the last trigger.
    await p.locator('button[aria-label^="Дії позиції"]').last().click();
    await p.getByRole('menuitem', { name: 'Редагувати позицію…' }).click();
    const edit = p.getByRole('dialog', { name: 'Редагувати позицію' });
    await edit.waitFor();
    const editText = await dialogText(p);
    const fileEdit = await shoot(p, 'edit-parts-line@1440');
    await edit.getByRole('button', { name: 'Змінити кількості деталей…' }).click();
    await p.waitForTimeout(800);
    const clean = await dialogText(p);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
    // Dirty: asked; «Лишитися» keeps the fields; «Відкинути й перейти» writes nothing.
    await p.locator('button[aria-label^="Дії позиції"]').last().click();
    await p.getByRole('menuitem', { name: 'Редагувати позицію…' }).click();
    await edit.waitFor();
    await edit.getByLabel('Нотатка').fill('змінено');
    await edit.getByRole('button', { name: 'Змінити кількості деталей…' }).click();
    const ask = p.getByRole('dialog', { name: 'Відкинути незбережені зміни позиції?' });
    await ask.waitFor();
    const fileAsk = await shoot(p, 'edit-to-config-ask@1440');
    await ask.getByRole('button', { name: 'Лишитися' }).click();
    await p.waitForTimeout(300);
    const keptNote = await edit.getByLabel('Нотатка').inputValue();
    await edit.getByRole('button', { name: 'Змінити кількості деталей…' }).click();
    await ask.getByRole('button', { name: 'Відкинути й перейти' }).click();
    await p.waitForTimeout(800);
    const after = await dialogText(p);
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:244}', actions: ['parts line → Редагувати позицію…', 'Змінити кількості деталей… (clean)', 'note typed → Змінити… → Лишитися → Змінити… → Відкинути й перейти'] },
      measured: { editText: editText?.slice(0, 400), clean: clean?.slice(0, 120), keptNote, after: after?.slice(0, 120), writes: requests },
      pass: /лише деталі/.test(editText ?? '') && /Конфігурація/.test(clean ?? '') && keptNote === 'змінено' && /Конфігурація/.test(after ?? '') && requests.length === 0,
      screenshots: [fileEdit, fileAsk],
    };
  });
  await scenario('config-gate@1440', ['E4-B06', 'E4-D03', 'R01'], async () => {
    const { ctx, p } = await open(1440, {
      rewrite: [[exact(`/projects/${B}`), (o) => ({ ...o, lines: o.lines.map((l) => (l.mode === 'parts' ? { ...l, issued: 1 } : l)) })]],
    });
    await p.goto(detail(B), { waitUntil: 'networkidle' });
    await ready(p);
    await p.locator('button[aria-label^="Дії позиції"]').last().click();
    await p.getByRole('menu').waitFor();
    const menu = await menuState(p);
    const fileMenu = await shoot(p, 'config-gate-menu@1440');
    await p.getByRole('menuitem', { name: 'Редагувати позицію…' }).click();
    const edit = p.getByRole('dialog', { name: 'Редагувати позицію' });
    await edit.waitFor();
    const button = edit.getByRole('button', { name: 'Змінити кількості деталей…' });
    const state = { disabled: await button.isDisabled(), title: await button.getAttribute('title') };
    const file = await shoot(p, 'config-gate-edit@1440');
    await ctx.close();
    const reason = 'Склад цієї позиції вже рухався — додайте, взявши зі складу';
    return {
      recipe: { url: '/projects/{order:244}', fixture: ['GET /projects/{order:244} → the parts line issued 1'] },
      measured: { menu, state },
      pass: menu[0] === `Конфігурація деталей… [off] {${reason}}` && state.disabled && state.title === reason,
      screenshots: [fileMenu, file],
    };
  });

  // ======================= 6. the plan (E01–E11) =======================
  await scenario('plan-stepper-split@1440', ['E4-E01', 'E4-E02', 'E4-E03', 'E4-E06', 'E4-E08', 'E4-E11'], async () => {
    const { ctx, p, errors } = await open(1440);
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await p.locator('[data-testid^="plan-row-"][data-testid$="-inc"]').first().click();
    await p.waitForTimeout(300);
    const planned = await p.locator('[data-testid$="-planned"]').first().textContent().catch(() => null);
    const split = p.locator('[data-testid^="plan-row-"][data-testid$="-split"]').first();
    const hasSplit = (await split.count()) > 0;
    if (hasSplit) await split.click();
    await p.waitForTimeout(400);
    const m = await p.evaluate(() => {
      const panel = document.querySelector('[data-testid$="-split-panel"]');
      const row = panel?.closest('tr');
      return {
        intro: !!document.querySelector('[data-testid="plan-intro"]'),
        panelOwnRow: !!row && !row.hasAttribute('data-testid') && row.previousElementSibling?.getAttribute('data-testid')?.startsWith('plan-row-'),
        total: document.querySelector('[data-testid="plan-total"]')?.innerText ?? null,
        stale: !!document.querySelector('[data-testid="plan-forecast-stale"]'),
      };
    });
    const file = await shoot(p, 'plan-stepper-split@1440');
    await p.evaluate(() => document.querySelector('[data-testid$="-split-panel"]')?.scrollIntoView({ block: 'center' }));
    const file2 = await shoot(p, 'plan-split-panel@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', actions: ['+ on the first row', 'the first split toggle'] },
      measured: { planned, hasSplit, ...m, errors },
      pass: /^план: \d+$/.test(planned ?? '') && m.intro && (!hasSplit || m.panelOwnRow) && /^Разом:/.test(m.total ?? '') && m.stale && errors.length === 0,
      screenshots: [file, file2],
    };
  });
  // The farm's proposal on the first row with alternatives, and a reader who may not queue.
  const proposing = (body, plan) => {
    const withAlt = plan.lines.flatMap((l) => l.rows.map((r) => ({ l, r }))).find(({ r }) => r.alternatives.length > 0);
    if (!withAlt) return body;
    const split = Object.fromEntries([[withAlt.r.plate_id, 0], ...withAlt.r.alternatives.map((a, i) => [a.plate_id, i === 0 ? withAlt.r.count : 0])]);
    return { ...body, lines: [{ ...(body.lines?.[0] ?? {}), line_id: withAlt.l.line_id, eta_complete: true, rows: [{ plate_id: withAlt.r.plate_id, proposed_split: split }] }, ...(body.lines ?? []).filter((l) => l.line_id !== withAlt.l.line_id)] };
  };
  stage = 'prepare';
  const planA = await read(`/projects/${A}/plan`);
  for (const [id, me] of [['plan-proposal-editor@1440', null], ['plan-proposal-reader@1440', { is_admin: false, role: 'user', permissions: without('queue:create') }]]) {
    await scenario(id, ['E4-E07', 'E4-E08', 'R06'], async () => {
      const { ctx, p } = await open(1440, { me, rewrite: [[exact(`/projects/${A}/forecast`), (b) => proposing(b, planA)]] });
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      const toggle = p.locator('[data-testid^="plan-row-"][data-testid$="-split"]').first();
      const label = await toggle.textContent().catch(() => null);
      await toggle.click();
      await p.waitForTimeout(400);
      const m = await p.evaluate(() => {
        const panel = document.querySelector('[data-testid$="-split-panel"]');
        return {
          proposal: panel?.querySelector('[data-testid$="-proposal"]')?.textContent ?? null,
          inputs: panel?.querySelectorAll('input').length ?? null,
          buttons: [...(panel?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()),
        };
      });
      const file = await shoot(p, id);
      await ctx.close();
      const reader = me != null;
      return {
        recipe: { url: '/projects/{order:241}', fixture: ['GET /projects/{order:241}/forecast → a proposed split on the first row with alternatives', ...(reader ? ['GET /auth/me → Administrators without queue:create'] : [])] },
        measured: { label, ...m },
        pass: !!m.proposal && m.proposal.startsWith('за фермою:') &&
          (reader ? label === 'Пропозиція ферми' && m.inputs === 0 && m.buttons.length === 0 : label === 'Розділити між файлами' && m.inputs > 0 && m.buttons.includes('Застосувати пропозицію ферми')),
        screenshots: [file],
      };
    });
  }
  await scenario('plan-printer@1440', ['E4-E09'], async () => {
    const { ctx, p } = await open(1440);
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await p.locator('[data-testid^="plan-row-"][data-testid$="-printer"]').first().click();
    const dlg = p.getByRole('dialog', { name: 'На принтер' });
    await dlg.waitFor({ timeout: 8000 });
    await p.waitForTimeout(800);
    const text = await dialogText(p);
    const file = await shoot(p, 'plan-printer@1440');
    const next = dlg.getByRole('button', { name: 'Далі — діалог друку' });
    const enabled = await next.isEnabled();
    if (enabled) await next.click();
    await p.waitForTimeout(1500);
    const printModal = await p.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map((d) => d.getAttribute('aria-label') || d.querySelector('h2, h3')?.textContent || ''));
    const crashed = await p.evaluate(() => document.body.innerText.includes('Something went wrong'));
    const file2 = await shoot(p, 'plan-printer-next@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', actions: ['«На принтер…» on the first row', 'Далі — діалог друку'], fixture: ['POST /auto-queue/printer-routing-preview → { targets: [] }'] },
      measured: { text: text?.slice(0, 500), enabled, printModal, crashed },
      pass: /Принтер/.test(text ?? '') && /Далі відкриється звичний діалог друку/.test(text ?? '') && enabled && printModal.length >= 1 && !crashed,
      screenshots: [file, file2],
    };
  });
  for (const [id, opts, expect] of [
    ['plan-printer-loading@1440', { delay: [[/\/api\/v1\/printers\/?(\?.*)?$/, 8000]] }, /Завантаження принтерів…/],
    ['plan-printer-failed@1440', { fail: [[/\/api\/v1\/printers\/?(\?.*)?$/, 500]] }, /Не вдалося прочитати принтери/],
  ]) {
    await scenario(id, ['E4-E09', 'R09'], async () => {
      const { ctx, p } = await open(1440, opts);
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await p.locator('[data-testid^="plan-row-"][data-testid$="-printer"]').first().click();
      const dlg = p.getByRole('dialog', { name: 'На принтер' });
      await dlg.waitFor({ timeout: 8000 });
      // A failed read shows after its one retry.
      if (opts.fail) await dlg.getByText(expect).waitFor({ timeout: 15000 }).catch(() => {});
      else await p.waitForTimeout(900);
      const text = await dialogText(p);
      const disabled = await dlg.getByRole('button', { name: 'Далі — діалог друку' }).isDisabled();
      const file = await shoot(p, id);
      await ctx.close();
      return {
        recipe: { fixture: [opts.delay ? 'GET /printers/ delayed 8 s' : 'GET /printers/ → 500'] },
        measured: { text: text?.slice(0, 300), disabled },
        pass: expect.test(text ?? '') && !/Немає активного принтера/.test(text ?? '') && disabled,
        screenshots: [file],
      };
    });
  }
  await scenario('plan-printer-gone@1440', ['E4-E09', 'R09'], async () => {
    let answered = 0;
    const { ctx, p } = await open(1440, { rewrite: [[/\/api\/v1\/printers\/?(\?.*)?$/, (list) => (answered++ === 0 ? list : [])]] });
    await p.clock.install();
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await p.locator('[data-testid^="plan-row-"][data-testid$="-printer"]').first().click();
    const dlg = p.getByRole('dialog', { name: 'На принтер' });
    await dlg.waitFor({ timeout: 8000 });
    await p.waitForTimeout(800);
    // A minute on, the page comes back to the front and the farm is read again — the chosen
    // printer is gone from it.
    await refetchLater(p);
    const text = await dialogText(p);
    const disabled = await dlg.getByRole('button', { name: 'Далі — діалог друку' }).isDisabled().catch(() => null);
    const file = await shoot(p, 'plan-printer-gone@1440');
    await ctx.close();
    return {
      recipe: { fixture: ['GET /printers/ → the farm on the first read, none on the next', 'the clock fast-forwarded 90 s + visibilitychange (a focus refetch of a stale query)'] },
      measured: { text: text?.slice(0, 300), disabled, answered },
      pass: answered >= 2 && (/Цей принтер більше недоступний/.test(text ?? '') || /Немає активного принтера цієї моделі/.test(text ?? '')) && disabled === true,
      screenshots: [file],
    };
  });
  await scenario('plan-unsatisfiable@1440', ['E4-E10'], async () => {
    const { ctx, p } = await open(1440, {
      rewrite: [[exact(`/projects/${A}/plan`), (plan) => ({ ...plan, lines: plan.lines.map((l, i) => (i === 0 ? { ...l, unsatisfiable: [{ part_id: l.outstanding_before[0]?.part_id ?? 1, name: l.outstanding_before[0]?.name ?? 'деталь', count: 3 }] } : l)) })]],
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const block = p.locator('[data-testid^="plan-unsatisfiable-"]').first();
    await block.scrollIntoViewIfNeeded();
    const text = await block.textContent();
    const href = await block.getByRole('link').getAttribute('href');
    const file = await shoot(p, 'plan-unsatisfiable@1440');
    await ctx.close();
    return { recipe: { fixture: ['GET /projects/{order:241}/plan → the first line with an unsatisfiable part × 3'] }, measured: { text, href }, pass: /Немає плити для/.test(text ?? '') && /#files$/.test(href ?? ''), screenshots: [file] };
  });

  // ======================= 7. prints (F01–F11, R02, R03, R05) =======================
  stage = 'prepare';
  const archivesA = await read(`/projects/${A}/archives?limit=500&offset=0`);
  await scenario('prints-page@1440', ['E4-F01', 'E4-F02', 'E4-F03', 'E4-F04'], async () => {
    const { ctx, p, errors } = await open(1440);
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Друки');
    await p.waitForTimeout(800);
    const m = await p.evaluate(() => ({
      heads: [...document.querySelectorAll('[data-testid^="prints-"] h3')].map((h) => h.textContent.trim()),
      cards: document.querySelectorAll('[data-print-card]').length,
      pagers: [...document.querySelectorAll('[data-testid^="prints-"] [data-pagination]')].map((p) => p.querySelector('span')?.textContent.trim()),
      where: [...document.querySelectorAll('[data-testid^="print-where-"]')].slice(0, 3).map((el) => el.textContent.trim()),
    }));
    const file = await shoot(p, 'prints-page@1440');
    await ctx.close();
    return {
      recipe: { url: '/projects/{order:241}', actions: ['tab «Друки»'] },
      measured: { ...m, archives: archivesA.length, errors },
      pass: m.heads.length > 0 && m.cards > 0 && m.pagers.length > 0 && m.where.every((w) => /\d{1,2}:\d{2}/.test(w)) && errors.length === 0,
      screenshots: [file],
    };
  });
  await scenario('prints-failed@1440', ['E4-F07'], async () => {
    const { ctx, p } = await open(1440, { fail: [[/\/api\/v1\/projects\/\d+\/archives/, 500]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Друки');
    await p.waitForTimeout(1200);
    await panel(p).getByText('Не вдалося завантажити друки').waitFor({ timeout: 15000 }).catch(() => {});
    const text = await panel(p).innerText();
    const file = await shoot(p, 'prints-failed@1440');
    await ctx.close();
    return { recipe: { fixture: ['GET /projects/{order:241}/archives → 500'] }, measured: { text: text.slice(0, 200) }, pass: /Не вдалося завантажити друки/.test(text) && /Спробувати знову/.test(text) && !/Друків ще немає/.test(text), screenshots: [file] };
  });
  await scenario('prints-partial@1440', ['E4-F02', 'R02'], async () => {
    // Every page answers 500 rows that never include one id the order names — the walk stops at its guard.
    const missing = archivesA[0]?.id;
    const pad = (url) => {
      const offset = Number(new URL(url).searchParams.get('offset') || 0);
      const rows = archivesA.filter((a) => a.id !== missing);
      const out = [];
      for (let i = 0; out.length < 500; i++) out.push({ ...rows[i % rows.length], id: i < rows.length ? rows[i].id : 900000 + offset + i });
      return out;
    };
    const { ctx, p, requests } = await open(1440, { rewrite: [[/\/api\/v1\/projects\/\d+\/archives/, (_b, url) => pad(url)]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Друки');
    await panel(p).getByText('Завантажено не всі друки замовлення').waitFor({ timeout: 30000 }).catch(() => {});
    const text = await panel(p).innerText();
    const file = await shoot(p, 'prints-partial@1440');
    const pagesBefore = requests.filter((u) => /\/archives\?/.test(u)).length;
    await panel(p).getByRole('button', { name: 'Завантажити давніші' }).click();
    await p.waitForTimeout(4000);
    const pagesAfter = requests.filter((u) => /\/archives\?/.test(u)).length;
    await ctx.close();
    return {
      recipe: { fixture: [`GET archives → 500 rows per page without archive ${missing}`], actions: ['tab «Друки»', 'Завантажити давніші'] },
      measured: { text: text.slice(0, 300), pagesBefore, pagesAfter },
      pass: /Завантажено не всі друки замовлення/.test(text) && /із завантажених/.test(text) && pagesAfter > pagesBefore,
      screenshots: [file],
    };
  });
  await scenario('prints-rights@1440', ['E4-F05', 'R03'], async () => {
    // Owners by position: mine / another user's / nobody's, over every print of the order.
    const owner = new Map(archivesA.map((a, i) => [a.id, ['mine', 'theirs', 'nobody'][i % 3]]));
    const by = { mine: meId, theirs: meId + 1000, nobody: null };
    const { ctx, p } = await open(1440, {
      me: { is_admin: false, role: 'user', permissions: without('archives:update_all', 'printers:read') },
      rewrite: [[/\/api\/v1\/projects\/\d+\/archives/, (rows) => rows.map((a) => ({ ...a, created_by_id: by[owner.get(a.id) ?? 'nobody'] }))]],
    });
    const printerReads = [];
    p.on('request', (r) => { if (/\/printers\/\?include_archived/.test(r.url())) printerReads.push(r.url()); });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Друки');
    await p.waitForTimeout(800);
    const ids = await p.evaluate(() => [...document.querySelectorAll('[data-print-card] [data-testid^="print-menu-"]')].slice(0, 6).map((b) => Number(b.getAttribute('data-testid').slice(11))));
    const offers = [];
    for (const id of ids) {
      await p.locator(`[data-testid="print-menu-${id}"]`).click();
      await p.getByRole('menu').waitFor();
      offers.push({ id, owner: owner.get(id), offered: (await p.getByRole('menuitem', { name: 'Призначити до позиції…' }).count()) > 0 });
      await p.keyboard.press('Escape');
      await p.waitForTimeout(200);
    }
    const where = await p.evaluate(() => [...document.querySelectorAll('[data-testid^="print-where-"]')].slice(0, 3).map((el) => el.textContent));
    const file = await shoot(p, 'prints-rights@1440');
    await ctx.close();
    return {
      recipe: { fixture: ['GET /auth/me → Administrators without archives:update_all and printers:read (update_own kept)', 'GET archives → owners mine / another / none by position'] },
      measured: { offers, printerReads, where },
      pass: offers.length >= 3 && offers.every((o) => o.offered === (o.owner === 'mine')) && printerReads.length === 0 && where.every((w) => !/P1S-|X1C-/.test(w)),
      screenshots: [file],
    };
  });
  await scenario('prints-printers-500@1440', ['E4-F04', 'R03'], async () => {
    const { ctx, p } = await open(1440, { fail: [[/\/api\/v1\/printers\/\?include_archived/, 500]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Друки');
    await p.waitForTimeout(3000);
    const cards = await p.locator('[data-print-card]').count();
    const text = await panel(p).innerText();
    await ctx.close();
    return { recipe: { fixture: ['GET /printers/?include_archived=true → 500'] }, measured: { cards }, pass: cards > 0 && !/Не вдалося завантажити друки/.test(text) };
  });
  // R02: the set shrinks under a page (a print leaves the order) and a print moves between groups —
  // the order and its archives answered from one state the intercepted writes change.
  const livePrints = () => {
    const state = { removed: new Set(), moved: new Map() };
    const orderRw = (o) => ({
      ...o,
      lines: o.lines.map((l) => ({ ...l, archive_ids: (l.archive_ids ?? []).filter((id) => !state.removed.has(id) && !state.moved.has(id)) })),
      other_archive_ids: [...(o.other_archive_ids ?? []).filter((id) => !state.removed.has(id)), ...state.moved.keys()],
    });
    const archivesRw = (rows) => rows.filter((a) => !state.removed.has(a.id)).map((a) => (state.moved.has(a.id) ? { ...a, project_line_id: null } : a));
    return {
      state,
      rewrite: [[exact(`/projects/${A}`), orderRw], [/\/api\/v1\/projects\/\d+\/archives/, archivesRw]],
      writes: [
        [/\/remove-archives/, (req) => { for (const id of req.postDataJSON().archive_ids) state.removed.add(id); return { message: 'ok' }; }],
        [/\/archives\/\d+$/, (req) => { const id = Number(new URL(req.url()).pathname.split('/').pop()); if (req.postDataJSON().project_line_id == null) state.moved.set(id, null); return {}; }],
      ],
    };
  };
  await scenario('prints-clamp@1440', ['E4-F02', 'R02'], async () => {
    const live = livePrints();
    const { ctx, p } = await open(1440, { rewrite: live.rewrite, writes: live.writes });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Друки');
    const group = panel(p).locator('[data-testid^="prints-line-"]').first();
    await group.locator('select').selectOption('12');
    await p.waitForTimeout(300);
    await group.getByRole('button', { name: /остання сторінка/i }).click();
    await p.waitForTimeout(300);
    const before = await group.locator('[data-pagination] span').first().textContent();
    const cards = await group.locator('[data-print-card]').count();
    // The last page holds one card: take it off the order.
    await group.locator('[data-testid^="print-menu-"]').last().click();
    await p.getByRole('menuitem', { name: 'Прибрати із замовлення' }).click();
    await p.getByRole('dialog').getByRole('button', { name: 'Прибрати' }).click();
    await p.waitForTimeout(2000);
    const after = await group.locator('[data-pagination] span').first().textContent();
    const file = await shoot(p, 'prints-clamp@1440');
    await ctx.close();
    return {
      recipe: { actions: ['tab «Друки»', 'Показати 12', 'last page', 'Прибрати із замовлення the last card'], fixture: ['POST remove-archives and PATCH archive intercepted; the order and its archives re-read without the removed print'] },
      measured: { before, cards, after, removed: [...live.state.removed] },
      pass: live.state.removed.size === 1 && !!after && after !== before && /-\d+ з \d+/.test(after) && after.split('-')[1].split(' ')[0] === after.split('з ')[1].split(' ')[0],
      screenshots: [file],
    };
  });
  await scenario('prints-move@1440', ['E4-F02', 'E4-F08', 'R02'], async () => {
    const live = livePrints();
    const { ctx, p } = await open(1440, { rewrite: live.rewrite, writes: live.writes });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Друки');
    const countOf = async (sel) => ((await panel(p).locator(`${sel} h3 small`).textContent().catch(() => '0')) ?? '0').trim();
    const otherBefore = await countOf('[data-testid="prints-other"]');
    await panel(p).locator('[data-testid^="prints-line-"] [data-testid^="print-menu-"]').first().click();
    await p.getByRole('menuitem', { name: 'Призначити до позиції…' }).click();
    const dlg = p.getByRole('dialog', { name: 'Призначити до позиції' });
    await dlg.locator('select').selectOption('');
    await dlg.getByRole('button', { name: 'Призначити' }).click();
    await p.waitForTimeout(2000);
    const otherAfter = await countOf('[data-testid="prints-other"]');
    const file = await shoot(p, 'prints-move@1440');
    await ctx.close();
    return {
      recipe: { actions: ['menu of the first filed print → Призначити до позиції… → Без позиції'], fixture: ['PATCH archive intercepted; the order re-read with the print among other prints'] },
      measured: { otherBefore, otherAfter, moved: [...live.state.moved.keys()] },
      pass: live.state.moved.size === 1 && Number(otherAfter) === Number(otherBefore) + 1,
      screenshots: [file],
    };
  });
  await scenario('prints-assign-dialog@1440', ['E4-F08'], async () => {
    const sent = [];
    const { ctx, p } = await open(1440, { writes: [[/\/archives\/\d+$/, (req) => { sent.push({ method: req.method(), body: req.postDataJSON() }); return {}; }]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Друки');
    await p.locator('[data-print-card][data-status="completed"] [data-testid^="print-menu-"]').first().click();
    await p.getByRole('menuitem', { name: 'Призначити до позиції…' }).click();
    const dlg = p.getByRole('dialog', { name: 'Призначити до позиції' });
    await dlg.waitFor();
    const options = await dlg.locator('select option').allTextContents();
    const file = await shoot(p, 'prints-assign-dialog@1440');
    await dlg.locator('select').selectOption({ index: 0 });
    await dlg.getByRole('button', { name: 'Призначити' }).click().catch(() => {});
    await p.waitForTimeout(600);
    await ctx.close();
    return {
      recipe: { fixture: ['PATCH /archives/{id} intercepted'] },
      measured: { options, sent },
      pass: options[0] === 'Без позиції (інші друки)' && options.length >= 2 && sent.length <= 1 && sent.every((s) => 'project_id' in s.body && 'project_line_id' in s.body),
      screenshots: [file],
    };
  });
  await scenario('prints-defects-dialog@1440', ['E4-F09'], async () => {
    const { ctx, p } = await open(1440);
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Друки');
    await p.locator('[data-print-card][data-status="completed"] [data-testid^="print-menu-"]').first().click();
    await p.getByRole('menuitem', { name: 'Брак…' }).click();
    const dlg = p.getByRole('dialog', { name: 'Брак у цьому друці' });
    await dlg.waitFor();
    await p.waitForTimeout(800);
    const text = await dialogText(p);
    const file = await shoot(p, 'prints-defects-dialog@1440');
    await ctx.close();
    return { recipe: { actions: ['menu of the first completed print → Брак…'] }, measured: { text: text?.slice(0, 300) }, pass: / · \d+ дет\./.test(text ?? ''), screenshots: [file] };
  });
  await scenario('prints-unlink-confirm@1440', ['E4-F06'], async () => {
    const sent = [];
    const { ctx, p } = await open(1440, { writes: [[/\/remove-archives/, (req) => { sent.push(req.postDataJSON()); return { message: 'ok' }; }]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Друки');
    await p.locator('[data-testid^="print-menu-"]').first().click();
    await p.getByRole('menuitem', { name: 'Прибрати із замовлення' }).click();
    await p.waitForTimeout(400);
    const text = await dialogText(p);
    const file = await shoot(p, 'prints-unlink-confirm@1440');
    await p.getByRole('dialog').getByRole('button', { name: 'Прибрати' }).click();
    await p.waitForTimeout(600);
    await ctx.close();
    return {
      recipe: { fixture: ['POST /projects/{id}/remove-archives intercepted'] },
      measured: { text, sent },
      pass: /Прибрати друк «.+» із замовлення\?/.test(text ?? '') && /Друк лишається в архіві/.test(text ?? '') && sent.length === 1,
      screenshots: [file],
    };
  });
  for (const [id, w, url] of [['prints-390', 390, detail(A)], ['prints-pane-1024', 1024, `${job.ui}/projects?order=${A}`]]) {
    await scenario(id, ['E4-F03', 'R05'], async () => {
      const long = archivesA[0]?.id;
      const { ctx, p } = await open(w, {
        storage: id.includes('pane') ? { 'projects.view': 'workspace' } : {},
        rewrite: [[/\/api\/v1\/projects\/\d+\/archives/, (rows) => rows.map((a) => (a.id === long ? { ...a, print_name: 'Корпус_датчика_клімату_DIN-рейка_посилений_варіант_для_щитових_шаф_партія_2026_09.gcode.3mf' } : a))]],
      });
      await p.goto(url, { waitUntil: 'networkidle' });
      await ready(p);
      await tab(p, 'Друки');
      await p.waitForTimeout(800);
      const m = await p.evaluate(() => {
        const grid = document.querySelector('[data-print-card]')?.parentElement;
        return { grid: grid ? { client: grid.clientWidth, scroll: grid.scrollWidth } : null, docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      const hits = await hitTest(p, '[data-testid^="print-menu-"]');
      const file = await shoot(p, id);
      await ctx.close();
      return {
        recipe: { url: id.includes('pane') ? '/projects?order={order:241} (workspace)' : '/projects/{order:241}', viewport: w, fixture: [`GET archives → a long print name on archive ${long}`] },
        measured: { ...m, hits: hits.slice(0, 4) },
        pass: !!m.grid && m.grid.scroll <= m.grid.client && m.docOverflow <= 0 && hits.slice(0, 3).every((h) => h.inView && h.hits),
        screenshots: [file],
      };
    });
  }

  // ======================= 8. the other tabs (G01–G04) =======================
  await scenario('procurement@1440', ['E4-G01', 'R07'], async () => {
    const sent = [];
    const { ctx, p } = await open(1440, {
      rewrite: [[exact(`/projects/${A}`), (o) => ({ ...o, procurement: o.procurement.map((r, i) => (i === 0 ? { ...r, sourcing_url: 'https://example.com/part' } : { ...r, planned_cost: null })) })]],
      writes: [[/\/procurement\/\d+/, async (req) => { sent.push(req.postDataJSON()); await new Promise((r) => setTimeout(r, 1500)); return orderA; }]],
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Куповані');
    const heads = await panel(p).locator('thead th').allTextContents();
    const input = p.locator('[data-testid$="-acquired"]').first();
    await input.fill('7');
    await input.press('Enter');
    await input.press('Tab').catch(() => {});
    await p.waitForTimeout(400);
    const file = await shoot(p, 'procurement@1440');
    await p.waitForTimeout(1500);
    await ctx.close();
    return {
      recipe: { fixture: ['GET order → the first purchased part with a supplier link, the others without a price', 'PATCH procurement answered after 1.5 s'] },
      measured: { heads, sent },
      pass: heads.join('|') === 'Деталь|Потрібно|Придбано|Лишилось|Ціна' && sent.length === 1,
      screenshots: [file],
    };
  });
  await scenario('issues-empty@1440', ['E4-G02'], async () => {
    const { ctx, p } = await open(1440, { rewrite: [[/\/api\/v1\/stock-issues/, (b) => ({ ...b, items: [], meta: { ...(b.meta ?? {}), total: 0, last_page: 1 } })]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Видачі');
    await p.waitForTimeout(600);
    const text = await panel(p).innerText();
    const file = await shoot(p, 'issues-empty@1440');
    await ctx.close();
    return { recipe: { fixture: ['GET /stock-issues → empty'] }, measured: { text }, pass: /Видач ще не було/.test(text) && /Склад і видача/.test(text), screenshots: [file] };
  });
  await scenario('notes@1440', ['E4-G03', 'R04'], async () => {
    let second = false;
    const { ctx, p } = await open(1440, { rewrite: [[exact(`/projects/${A}`), (o) => (second ? { ...o, notes: '<p>Оновлено на сервері</p>' } : o)]] });
    await p.clock.install();
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Нотатки');
    const notes = panel(p);
    const saveOff = await notes.getByRole('button', { name: 'Зберегти нотатки' }).isDisabled();
    const file = await shoot(p, 'notes@1440');
    // A clean editor follows a background re-read.
    second = true;
    await refetchLater(p);
    const followed = await notes.locator('.ProseMirror').innerText();
    // Typed text, discarded, comes back to the saved text.
    await notes.locator('.ProseMirror').click();
    await p.keyboard.type(' додано');
    await p.waitForTimeout(300);
    const dirtySave = await notes.getByRole('button', { name: 'Зберегти нотатки' }).isEnabled();
    await notes.getByRole('button', { name: 'Скасувати зміни' }).click();
    await p.waitForTimeout(400);
    const discarded = await notes.locator('.ProseMirror').innerText();
    const file2 = await shoot(p, 'notes-after@1440');
    await ctx.close();
    return {
      recipe: { fixture: ['GET order → a changed note on the second read', 'the clock fast-forwarded 90 s + visibilitychange (a focus refetch)'] },
      measured: { saveOff, followed, dirtySave, discarded },
      pass: saveOff && /Оновлено на сервері/.test(followed) && dirtySave && !/додано/.test(discarded) && /Оновлено на сервері/.test(discarded),
      screenshots: [file, file2],
    };
  });
  await scenario('notes-empty@1440', ['E4-G03', 'R04'], async () => {
    const { ctx, p } = await open(1440, { rewrite: [[exact(`/projects/${A}`), (o) => ({ ...o, notes: null })]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Нотатки');
    await p.waitForTimeout(500);
    const saveOff = await panel(p).getByRole('button', { name: 'Зберегти нотатки' }).isDisabled();
    const discard = await panel(p).getByRole('button', { name: 'Скасувати зміни' }).count();
    await ctx.close();
    return { recipe: { fixture: ['GET order → notes null'] }, measured: { saveOff, discard }, pass: saveOff && discard === 0 };
  });
  await scenario('attachments@1440', ['E4-G04', 'R09'], async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const files = [
      { filename: 'parcel.png', original_name: 'Пакування.png', size: 48213, uploaded_at: '2026-09-28T09:40:00Z' },
      { filename: 'spec.pdf', original_name: 'Специфікація.pdf', size: 204800, uploaded_at: '2026-09-27T15:10:00Z' },
    ];
    const posts = [];
    const { ctx, p, route } = await open(1440, {
      rewrite: [[exact(`/projects/${A}`), (o) => ({ ...o, attachments: files })]],
      writes: [[/\/attachments$/, (req) => { posts.push(req.method()); return { status: 'ok', filename: 'x', original_name: 'x', size: 1 }; }]],
    });
    await route(/\/attachments\/parcel\.png/, (r) => r.fulfill({ status: 200, body: png, contentType: 'image/png' }));
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Вкладення');
    const text = await panel(p).innerText();
    const file = await shoot(p, 'attachments@1440');
    await p.getByRole('button', { name: 'Переглянути' }).click();
    await p.waitForTimeout(700);
    const viewer = await p.evaluate(() => document.querySelector('[role="dialog"] img')?.getAttribute('src') ?? null);
    const file2 = await shoot(p, 'attachments-viewer@1440');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    await p.getByRole('button', { name: 'Видалити вкладення «Специфікація.pdf»' }).click();
    await p.waitForTimeout(300);
    const confirm = await dialogText(p);
    const file3 = await shoot(p, 'attachments-confirm@1440');
    await p.getByRole('dialog').getByRole('button', { name: 'Скасувати' }).click().catch(() => p.keyboard.press('Escape'));
    await p.locator('input[type="file"]').setInputFiles([
      { name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('1') },
      { name: 'two.txt', mimeType: 'text/plain', buffer: Buffer.from('2') },
    ]);
    await p.waitForTimeout(1200);
    await ctx.close();
    return {
      recipe: { fixture: ['GET order → two attachments (PNG, PDF)', 'GET attachments/parcel.png → a 1×1 PNG', 'POST attachments intercepted'] },
      measured: { text: text.slice(0, 300), viewer, confirm, posts },
      pass: /PNG/.test(text) && /PDF/.test(text) && /\d{1,2}:\d{2}/.test(text) && /^blob:/.test(viewer ?? '') && /Видалити вкладення «Специфікація\.pdf»\?/.test(confirm ?? '') && posts.length === 2,
      screenshots: [file, file2, file3],
    };
  });
  await scenario('attachments-late@1440', ['E4-G04', 'R09'], async () => {
    const files = [{ filename: 'parcel.png', original_name: 'Пакування.png', size: 48213, uploaded_at: '2026-09-28T09:40:00Z' }];
    const { ctx, p, route, errors } = await open(1440, { rewrite: [[exact(`/projects/${A}`), (o) => ({ ...o, attachments: files })]] });
    // The app does not cancel the read when the viewer closes — it drops the answer. So the answer is
    // held until the viewer has been shown and closed, then delivered in full, and the client is seen
    // to take it and let it go; a fixture that cannot deliver it fails the scenario.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let requested;
    const asked = new Promise((resolve) => { requested = resolve; });
    let delivered = false;
    await route(/\/attachments\/parcel\.png/, async (r) => {
      requested();
      await gate;
      await r.fulfill({ status: 200, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), contentType: 'image/png' });
      delivered = true;
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await tab(p, 'Вкладення');
    // Every object URL the page makes and lets go of, from here on.
    await p.evaluate(() => {
      const seen = { created: [], revoked: [] };
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { const u = create(blob); seen.created.push(u); return u; };
      URL.revokeObjectURL = (u) => { seen.revoked.push(u); revoke(u); };
      window.__e04blobs = seen;
    });
    const finished = p.waitForEvent('requestfinished', { predicate: (q) => /\/attachments\/parcel\.png/.test(q.url()), timeout: 30000 }).catch(() => null);
    await p.getByRole('button', { name: 'Переглянути' }).click();
    await within(asked, 10000, 'picture_not_requested');
    const lightbox = p.locator('[role="dialog"]');
    await lightbox.waitFor({ state: 'visible', timeout: 5000 });
    const whileReading = (await lightbox.innerText()).trim();
    await p.keyboard.press('Escape');
    await lightbox.waitFor({ state: 'detached', timeout: 5000 });
    const made = await p.evaluate(() => window.__e04blobs.created.length);
    release();
    const request = await finished;
    if (!request) throw failure('late_answer_not_finished', 'attachments-late');
    const status = (await request.response())?.status() ?? null;
    // The client read the late answer: the URL it made of it is revoked, and nothing reopened.
    await p.waitForFunction((n) => {
      const seen = window.__e04blobs;
      const late = seen.created.slice(n);
      return late.length > 0 && late.every((u) => seen.revoked.includes(u));
    }, made, { timeout: 10000 });
    const after = await p.evaluate(() => ({ dialogs: document.querySelectorAll('[role="dialog"]').length, blobImages: document.querySelectorAll('img[src^="blob:"]').length }));
    await ctx.close();
    return {
      recipe: { fixture: ['GET attachments/parcel.png held until the viewer was shown and closed, then answered 200 with a PNG'] },
      measured: { whileReading, delivered, status, ...after, errors },
      pass: delivered && status === 200 && whileReading.length > 0 && after.dialogs === 0 && after.blobImages === 0 && errors.length === 0,
    };
  });

  // ======================= 9. hit tests at 390 and the themes =======================
  await scenario('hits@390', ['E4-B06', 'E4-E07'], async () => {
    const { ctx, p } = await open(390);
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const lines = await hitTest(p, 'button[aria-label^="Дії позиції"]');
    await p.locator('[data-testid="plan-block"]').scrollIntoViewIfNeeded();
    const plan = await hitTest(p, '[data-testid^="plan-row-"] td:last-child button');
    const file = await shoot(p, 'hits@390');
    await ctx.close();
    return { measured: { lines, plan: plan.slice(0, 6) }, pass: lines.every((h) => h.hits) && plan.filter((h) => h.inView).every((h) => h.hits), screenshots: [file] };
  });
  for (const [id, opts, test] of [['theme-light@1440', { storage: { 'theme-mode': 'light' } }, (e) => !/\bdark\b/.test(e.theme)], ['theme-oled@1440', { settings: { dark_background: 'oled' } }, (e) => /bg-oled/.test(e.theme)]]) {
    await scenario(id, ['E2-B01'], async () => {
      const { ctx, p } = await open(1440, opts);
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      await p.evaluate(() => document.querySelectorAll('[data-testid^="line-"][data-testid$="-expand"]').forEach((b) => b.click()));
      await p.waitForTimeout(500);
      const e = await env(p);
      const file = await shoot(p, id);
      await ctx.close();
      return { env: e, pass: test(e), screenshots: [file] };
    });
  }

  // ======================= E12: the «Plan from files» dialog =======================
  // The stand's library carries no file tags, so the file manager offers «Розрахувати» for nothing, and the dialog's
  // parts preview is a POST this runner answers itself — the E3 V06 fixture, recorded in each record.
  const planDialog = async (w) => {
    const FILE = 'clm01_p1s.gcode.3mf';
    const order = await read(`/projects/${A}`);
    const productId = order.lines.find((l) => l.product_id != null)?.product_id;
    const product = await read(`/products/${productId}`);
    let fileId = null;
    const tag = (f) => {
      if (f.filename !== FILE) return f;
      fileId = f.id;
      return { ...f, file_tags: [...new Set([...(f.file_tags ?? []), '3mf', 'sliced'])] };
    };
    const preview = () => ({
      files: [{ id: fileId, filename: FILE, sliced_for_model: 'P1S', plates: [{ plate_index: 1, sliced: true, print_time_seconds: 3600 }] }],
      parts: (product.parts ?? []).map((part) => ({ name_key: part.name_key ?? String(part.name).toLowerCase(), name: part.name, yields: [{ library_file_id: fileId, plate_index: 1, count: 1 }] })),
      catalog_product: { id: product.id, name: product.name, parts: (product.parts ?? []).map((part) => ({ id: part.id, name: part.name, qty_per_unit: part.qty_per_unit ?? 1 })) },
    });
    // The file manager's toolbar is reached at 1440; a narrow width is then the same dialog, resized.
    const opened = await open(1440, {
      rewrite: [[/\/api\/v1\/library\/files\/?\?/, (body) => (Array.isArray(body) ? body.map(tag) : body?.items ? { ...body, items: body.items.map(tag) } : body)]],
      writes: [[/\/library\/files\/parts-preview/, () => preview()], [/\/projects\/from-files/, order]],
    });
    const { p } = opened;
    await p.goto(`${job.ui}/files`, { waitUntil: 'networkidle' });
    await p.getByText('Корпуси', { exact: true }).first().click();
    await p.waitForTimeout(800);
    await p.getByText('CLM-01', { exact: true }).first().click();
    await p.waitForTimeout(1200);
    await p.evaluate((name) => {
      const label = [...document.querySelectorAll('*')].find((el) => el.childElementCount === 0 && el.textContent.trim() === name);
      for (let el = label; el; el = el.parentElement) {
        const box = el.querySelector('[data-select-file]');
        if (box) { box.click(); return true; }
      }
      return false;
    }, FILE);
    await p.getByRole('button', { name: /^Розрахувати$/ }).click();
    const dialog = p.getByRole('dialog');
    await dialog.waitFor({ timeout: 8000 });
    await p.waitForTimeout(800);
    await dialog.getByRole('button', { name: /Розрахувати/ }).last().click();
    await dialog.locator('[data-testid="plan-block"]').waitFor({ timeout: 10000 });
    if (w !== 1440) await p.setViewportSize({ width: w, height: HEIGHTS[w] || 900 });
    await p.waitForTimeout(1500);
    return { ...opened, fixture: [`GET /library/files → ${FILE} tagged 3mf+sliced`, 'POST parts-preview → order 241’s product and that file', 'POST from-files → order 241 (intercepted)'] };
  };
  const dialogGeometry = (p) => p.evaluate(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].pop();
    const plan = d.querySelector('[data-testid="plan-block"]');
    const scrolls = [...d.querySelectorAll('[data-testid$="-scroll"]')].filter((s) => s.dataset.testid.startsWith('plan-line-'));
    let body = plan.parentElement;
    while (body && body !== d && getComputedStyle(body).overflowY !== 'auto') body = body.parentElement;
    return {
      dialogWidth: Math.round(d.getBoundingClientRect().width),
      bodyClient: body?.clientWidth ?? null,
      bodyScroll: body?.scrollWidth ?? null,
      planWidth: Math.round(plan.getBoundingClientRect().width),
      tables: scrolls.map((s) => ({ client: s.clientWidth, scroll: s.scrollWidth, table: Math.round(s.querySelector('table').getBoundingClientRect().width) })),
    };
  });
  for (const w of [1440, 390]) {
    await scenario(`E12-plan-dialog@${w}`, ['E4-E12', 'E3-V06', 'P04'], async () => {
      const { ctx, p, errors, fixture } = await planDialog(w);
      const g = await dialogGeometry(p);
      const buttons = await buttonLines(p, '[role="dialog"] [data-testid^="plan-row-"] td:last-child button');
      const file = await shoot(p, `E12-plan-dialog@${w}`);
      await ctx.close();
      const oneLine = buttons.length > 0 && buttons.every((b) => b.lines === 1);
      const bodyHolds = g.bodyScroll != null && g.bodyScroll <= g.bodyClient;
      const tablesFit = g.tables.length > 0 && g.tables.every((t) => t.scroll <= t.client);
      return {
        recipe: { route: '/files → CLM-01 → Розрахувати', viewport: w, opened_at: 1440, fixture },
        measured: { ...g, buttons, errors },
        pass: oneLine && bodyHolds && (w === 390 || tablesFit) && errors.length === 0,
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
