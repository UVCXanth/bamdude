// WS-13 E3 acceptance runner (spec §I1/I2), run by Playwright MCP's browser_run_code_unsafe:
//   filename: scripts/workshop_stand/e03_detail.js — while `e03_evidence.py serve` listens on 127.0.0.1:8197.
// Every scenario records WHAT was run (recipe), WHERE (viewport, DPR, the actual <html> classes), WHAT was
// measured and whether it matched the spec — a failure is a failure, a surface it cannot reach is `pending`.
// Nothing reaches the stand but reads: every non-GET request of every context is answered here, and the
// states the baseline does not hold are rewritten GET answers in this runner's own context only.
async (page) => {
  const base = 'http://127.0.0.1:8197';
  const job = await (await page.request.get(`${base}/job.json`)).json();
  const browser = page.context().browser();
  const O = job.orders;
  const A = O['241'];
  const HEIGHTS = { 2560: 1440, 1920: 1080, 1440: 900, 1280: 800, 1024: 768, 768: 1024, 761: 900, 760: 900, 561: 900, 560: 900, 390: 844 };
  const summary = [];
  const auth = { Authorization: `Bearer ${job.token}` };

  const record = async (r) => {
    summary.push(`${r.pass ? 'ok  ' : r.pass === null ? 'PEND' : 'FAIL'} ${r.id}`);
    await page.request.post(`${base}/record`, { data: r });
  };
  const env = async (p) => p.evaluate(() => ({ viewport: [innerWidth, innerHeight], dpr: window.devicePixelRatio, theme: document.documentElement.className }));
  const shoot = async (p, name) => {
    const file = `${job.out}/${name}.png`;
    await p.screenshot({ path: file, fullPage: false });
    return file;
  };
  const read = async (path) => (await page.request.get(`${job.api}/api/v1${path}`, { headers: auth })).json();
  const exact = (path) => new RegExp(`/api/v1${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?(\\?.*)?$`);

  // A context of our own. `rewrite`: [[pathRegex, (json) => json]] for GET answers; `fail`: [[regex, status]];
  // `delay`: [[regex, ms]]; `writes`: [[regex, json | (request) => json]] answers for non-GET, everything else non-GET gets {}.
  const open = async (w, { h, storage = {}, me = null, rewrite = [], fail = [], delay = [], writes = [], settings = null } = {}) => {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h || HEIGHTS[w] || 900 }, deviceScaleFactor: 1, locale: 'uk-UA',
      timezoneId: 'Europe/Kyiv', serviceWorkers: 'block',
    });
    // The socket's token is minted by a POST (it writes a row), which this runner answers itself — so the real
    // /api/v1/ws refused every context and the app toasted «Відновлюю з'єднання…» over the frames. A silent
    // socket of our own instead: nothing reaches the stand, and no event is invented.
    if (typeof ctx.routeWebSocket === 'function') await ctx.routeWebSocket(/\/api\/v1\/ws/, () => {});
    await ctx.addInitScript(({ token, storage }) => {
      if (sessionStorage.getItem('e03-init')) return;
      sessionStorage.setItem('e03-init', '1');
      localStorage.clear();
      localStorage.setItem('auth_token', token);
      for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    }, { token: job.token, storage });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    const requests = [];
    p.on('request', (r) => { if (r.url().includes('/api/v1/')) requests.push(`${r.method()} ${new URL(r.url()).pathname}`); });
    await p.route(/\/api\/v1\//, async (route) => {
      const req = route.request();
      const url = req.url();
      if (req.method() !== 'GET') {
        const hit = writes.find(([re]) => re.test(url));
        const answer = hit ? (typeof hit[1] === 'function' ? hit[1](req) : hit[1]) : {};
        return route.fulfill({ status: 200, json: answer });
      }
      const failing = fail.find(([re]) => re.test(url));
      if (failing) return route.fulfill({ status: failing[1], json: { detail: 'e03 runner' } });
      const waiting = delay.find(([re]) => re.test(url));
      if (waiting) await new Promise((r) => setTimeout(r, waiting[1]));
      const rw = rewrite.find(([re]) => re.test(url));
      const isMe = me && /\/api\/v1\/auth\/me\/?(\?.*)?$/.test(url);
      const isSettings = settings && /\/api\/v1\/settings\/?(\?.*)?$/.test(url);
      if (!rw && !isMe && !isSettings) return route.continue();
      const response = await route.fetch();
      let body = await response.json();
      if (rw) body = rw[1](body);
      if (isMe) body = { ...body, ...me };
      if (isSettings) body = { ...body, ...settings };
      return route.fulfill({ response, json: body });
    });
    return { ctx, p, errors, requests };
  };
  const scenario = async (id, ids, fn) => {
    try {
      await record({ id, ids, source: 'app', ...(await fn()) });
    } catch (e) {
      await record({ id, ids, source: 'app', pass: false, error: String(e.message || e).split('\n')[0].slice(0, 300) });
    }
  };
  const near = (a, b) => Math.abs(a - b) <= 1;
  const detail = (id, q = '') => `${job.ui}/projects/${id}${q}`;
  const ready = async (p) => {
    await p.waitForSelector('[data-testid="order-grid"]', { timeout: 15000 });
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(400);
  };
  const layout = (p) => p.evaluate(() => {
    const root = document.querySelector('[data-testid="order-view"]');
    const cs = getComputedStyle(root);
    const grid = document.querySelector('[data-testid="order-grid"]');
    const main = document.querySelector('[data-testid="order-main"]');
    const side = document.querySelector('[data-testid="order-side"]');
    const tiles = [...document.querySelectorAll('[data-testid^="order-tile-"]')];
    const top = tiles[0]?.getBoundingClientRect().top;
    const actions = document.querySelector('[data-testid="order-actions"]').getBoundingClientRect();
    const strip = document.querySelector('[role="tablist"]');
    const mainBody = main.querySelector(':scope > div') ?? main;
    // C06 (E3-V01): the title must stay readable — its width and lines, and where the actions went.
    const header = document.querySelector('[data-testid="order-head"] header');
    const titleEl = header.querySelector('h1, h2');
    const tr = titleEl.getBoundingClientRect();
    const lr = header.firstElementChild.getBoundingClientRect();
    const ar = document.querySelector('[data-testid="order-actions"]').getBoundingClientRect();
    const head = {
      width: +header.getBoundingClientRect().width.toFixed(1),
      height: Math.round(header.getBoundingClientRect().height),
      titleWidth: +tr.width.toFixed(1),
      titleLines: Math.round(tr.height / parseFloat(getComputedStyle(titleEl).lineHeight)),
      leftWidth: +lr.width.toFixed(1),
      actions: ar.height === 0 ? 'none' : ar.top >= lr.bottom - 1 ? 'below' : 'beside',
    };
    const mb = mainBody.getBoundingClientRect();
    const mcs = getComputedStyle(mainBody);
    return {
      container: root.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      gridCols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      mainWidth: +main.getBoundingClientRect().width.toFixed(1),
      sideWidth: +side.getBoundingClientRect().width.toFixed(1),
      sideCols: getComputedStyle(side).gridTemplateColumns.split(' ').filter((c) => c !== '0px').length,
      sidePanels: [...side.querySelectorAll('h2, h3')].map((h) => h.textContent),
      tilesPerRow: tiles.filter((t) => Math.abs(t.getBoundingClientRect().top - top) < 2).length,
      mainInner: +(mb.width - parseFloat(mcs.paddingLeft) - parseFloat(mcs.paddingRight)).toFixed(1),
      actionsInView: actions.right <= innerWidth + 0.5 && actions.left >= 0,
      stripScrolls: strip ? getComputedStyle(strip).overflowX : null,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      head,
    };
  });
  // C06: the title keeps a readable width, and actions beside it never squeeze its block under its 20rem basis.
  const headOk = (h) => h.titleWidth >= Math.min(240, h.width * 0.6) && (h.actions !== 'beside' || h.leftWidth >= 319.5);
  const expectedTiles = (inner) => Math.min(8, Math.floor((inner + 12) / 142));
  const sideClamp = (w) => Math.min(440, Math.max(320, 0.22 * w));
  const text = (p, sel) => p.locator(sel).first().textContent();
  const RETRY = /Спробувати знову/;

  // ======================= 1. geometry on every width (§I1, R05) =======================
  const pageGeometry = {};
  for (const w of [2560, 1920, 1440, 1280, 1024, 768, 761, 760, 561, 560, 390]) {
    await scenario(`geometry@${w}`, ['E3-B01', 'E3-B02', 'E3-B04', 'E3-C06', 'E3-E01'], async () => {
      const { ctx, p, errors } = await open(w);
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      const m = await layout(p);
      const file = await shoot(p, `geometry@${w}`);
      const e = await env(p);
      await ctx.close();
      pageGeometry[w] = m;
      const two = m.container > 1150;
      const ok =
        m.docOverflow <= 0 && m.gridCols === (two ? 2 : 1) && m.actionsInView && errors.length === 0 &&
        m.tilesPerRow === expectedTiles(m.mainInner) &&
        (two ? near(m.sideWidth, sideClamp(w)) : true) && m.stripScrolls === 'auto' &&
        headOk(m.head) && (w === 390 ? m.head.actions === 'below' : true);
      return { recipe: { url: `/projects/{order:241}`, viewport: w }, env: e, measured: { ...m, expectedTiles: expectedTiles(m.mainInner), errors }, pass: ok, screenshots: [file] };
    });
  }

  // ======================= 2. the 1150 boundary, both sides (B02) =======================
  const delta = pageGeometry[1440] ? 1440 - pageGeometry[1440].container : null;
  for (const target of [1150, 1151]) {
    await scenario(`boundary-container-${target}`, ['E3-B02'], async () => {
      if (delta == null) return { pass: null, pending: 'no 1440 measurement to derive the viewport from' };
      const w = target + delta;
      const { ctx, p } = await open(w, { h: 900 });
      await p.goto(detail(A), { waitUntil: 'networkidle' });
      await ready(p);
      const m = await layout(p);
      await ctx.close();
      return { recipe: { viewport: w, derived: `container ${target} = viewport − ${delta}` }, measured: m, pass: m.container === target && m.gridCols === (target <= 1150 ? 1 : 2) };
    });
  }

  // ======================= 3. sidebar collapsed at 1440 =======================
  await scenario('sidebar-collapsed@1440', ['E3-B02'], async () => {
    const { ctx, p } = await open(1440, { storage: { sidebarExpanded: 'false' } });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const m = await layout(p);
    const file = await shoot(p, 'sidebar-collapsed@1440');
    await ctx.close();
    return { recipe: { viewport: 1440, storage: { sidebarExpanded: 'false' } }, measured: m, pass: m.container > 1150 && m.gridCols === 2 && m.docOverflow <= 0, screenshots: [file] };
  });

  // ======================= 4. the workspace pane (H01–H03) =======================
  for (const w of [1920, 1440]) {
    await scenario(`workspace@${w}`, ['E3-H01', 'E3-H02', 'E3-H03', 'E3-B02'], async () => {
      const { ctx, p } = await open(w, { storage: { 'projects.view': 'workspace' } });
      await p.goto(`${job.ui}/projects?order=${A}`, { waitUntil: 'networkidle' });
      await ready(p);
      const m = await layout(p);
      const pane = await p.evaluate(() => {
        const view = document.querySelector('[data-testid="order-view"]');
        const frame = view.parentElement;
        const fcs = getComputedStyle(frame);
        return {
          viewPadding: getComputedStyle(view).paddingLeft,
          frameBorder: fcs.borderLeftWidth,
          frameBg: fcs.backgroundColor,
          crumbs: !!view.querySelector('nav'),
          title: view.querySelector('h1, h2')?.tagName,
          open: view.querySelector('a[aria-label^="Відкрити повну сторінку"]')?.getAttribute('href'),
        };
      });
      const file = await shoot(p, `workspace@${w}`);
      await ctx.close();
      const ok = pane.viewPadding === '0px' && pane.frameBorder === '0px' && !pane.crumbs && pane.title === 'H2' &&
        pane.open === `/projects/${A}` && m.docOverflow <= 0 && m.gridCols === (m.container > 1150 ? 2 : 1) &&
        m.tilesPerRow === expectedTiles(m.mainInner) && headOk(m.head);
      return { recipe: { url: `/projects?order={order:241}`, viewport: w, storage: { 'projects.view': 'workspace' } }, measured: { ...m, pane }, pass: ok, screenshots: [file] };
    });
  }

  // ======================= 4b. the header at narrow widths (C06, E3-V01) =======================
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const LONG = {
    name: 'Корпуси датчиків клімату для лабораторії зберігання харчових продуктів — друга партія з посиленими кріпленнями',
    tags: 'серія-для-лабораторії-зберігання, довгий-тег-що-не-має-пробілів-взагалі, PETG',
  };
  const headerCase = async ({ name, w, url, storage = {}, cover, long = false }) => {
    const { ctx, p, errors } = await open(w, {
      storage,
      rewrite: [[exact(`/projects/${A}`), (o) => ({ ...o, cover_image_filename: cover ? 'cover.png' : null, ...(long ? LONG : {}) })]],
    });
    // The cover picture is answered here — a fixture, not the stand's data.
    if (cover) await p.route(new RegExp(`/api/v1/projects/${A}/cover-image`), (route) => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG, 'base64') }));
    await p.goto(url, { waitUntil: 'networkidle' });
    await ready(p);
    const m = await layout(p);
    const coverShown = await p.locator('[data-testid="order-head"] [data-testid="order-cover-image"]').count();
    const file = await shoot(p, `header-c06-${name}`);
    await ctx.close();
    return { name, viewport: w, cover, long, coverShown, head: m.head, docOverflow: m.docOverflow, errors, file };
  };
  await scenario('header-c06', ['E3-C06', 'E3-V01'], async () => {
    const cases = [
      await headerCase({ name: '390-no-cover', w: 390, url: detail(A), cover: false }),
      await headerCase({ name: '390-cover', w: 390, url: detail(A), cover: true }),
      await headerCase({ name: '390-long-cover', w: 390, url: detail(A), cover: true, long: true }),
      await headerCase({ name: '390-long-no-cover', w: 390, url: detail(A), cover: false, long: true }),
      // The narrowest pane the workspace has: its right side appears from 1024 on.
      await headerCase({ name: 'embedded-1024-long-cover', w: 1024, url: `${job.ui}/projects?order=${A}`, storage: { 'projects.view': 'workspace' }, cover: true, long: true }),
    ];
    const ok = cases.every((c) => headOk(c.head) && c.docOverflow <= 0 && c.errors.length === 0 && c.coverShown === (c.cover ? 1 : 0) &&
      (c.viewport === 390 ? c.head.actions === 'below' : true));
    return {
      recipe: { cases: cases.map(({ name, viewport, cover, long }) => ({ name, viewport, cover, long })), fixture: ['GET order → cover_image_filename, long name/tags', 'GET cover-image → 1×1 PNG'] },
      measured: cases.map(({ file, ...rest }) => rest), pass: ok, screenshots: cases.map((c) => c.file),
    };
  });

  // ======================= 4c. the stock banner at narrow widths (D03/D05, E3-V07) =======================
  // Coordinates of the sentence and the button, not the document's width: the button goes UNDER the
  // sentence when the two do not fit, beside it otherwise, and the configuration is amber (the mockup's .m-cfg).
  const bannerGeo = (p) => p.evaluate(() => {
    const banner = document.querySelector('[data-testid="take-stock"]');
    if (!banner) return null;
    const para = banner.querySelector('p');
    const button = banner.querySelector('button');
    const pr = para.getBoundingClientRect();
    const br = button.getBoundingClientRect();
    const configs = [...para.querySelectorAll('.text-amber-700')];
    // The theme's own amber, read the way the browser resolves it (Tailwind 4 writes it in oklch).
    const probe = document.createElement('span');
    probe.className = 'text-amber-700 dark:text-amber-400';
    para.appendChild(probe);
    const amber = getComputedStyle(probe).color;
    probe.remove();
    return {
      banner: Math.round(banner.getBoundingClientRect().width),
      paraWidth: Math.round(pr.width), paraHeight: Math.round(pr.height), paraBottom: Math.round(pr.bottom), paraRight: Math.round(pr.right),
      buttonTop: Math.round(br.top), buttonLeft: Math.round(br.left), buttonWidth: Math.round(br.width),
      button: br.top >= pr.bottom - 1 ? 'below' : 'beside',
      configs: configs.length, configColors: [...new Set(configs.map((el) => getComputedStyle(el).color))],
      amber, sentenceColor: getComputedStyle(para).color,
      bannerOverflow: banner.scrollWidth - banner.clientWidth,
      docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  const bannerCase = async ({ name, w, url, storage = {}, long = false }) => {
    const rewrite = [];
    if (long) {
      // Three lines of the order's product in three long configurations, and one offer for each.
      const option = (text) => ({ group_id: 1, group_name: 'Кріплення', option_id: 1, option_name: text, is_default: false });
      const LONG_OPTIONS = ['на DIN-рейку з додатковою пластиною для щитових шаф', 'настінне з прихованим кабельним вводом знизу', 'на магніт для металевих стелажів складу'];
      rewrite.push([exact(`/projects/${A}`), (o) => ({ ...o, lines: LONG_OPTIONS.map((text, i) => ({ ...o.lines[0], id: 900 + i, configuration: { choices: [option(text)], changed_parts: [] } })) })]);
      rewrite.push([exact(`/projects/${A}/stock-offers`), (offers) => LONG_OPTIONS.map((_, i) => ({ ...(offers[0] ?? {}), line_id: 900 + i, from_finished: 2 + i, kits: 1 }))]);
    }
    const { ctx, p, errors } = await open(w, { storage, rewrite });
    await p.goto(url, { waitUntil: 'networkidle' });
    await ready(p);
    await p.waitForSelector('[data-testid="take-stock"]', { timeout: 8000 });
    const m = await bannerGeo(p);
    await p.locator('[data-testid="take-stock"]').scrollIntoViewIfNeeded();
    const file = await shoot(p, `take-stock-${name}`);
    await ctx.close();
    return { name, viewport: w, long, ...m, errors, file };
  };
  await scenario('take-stock-wrap', ['E3-D03', 'E3-D05', 'E3-V07'], async () => {
    const cases = [
      await bannerCase({ name: '390', w: 390, url: detail(A) }),
      await bannerCase({ name: '390-long', w: 390, url: detail(A), long: true }),
      await bannerCase({ name: '1440', w: 1440, url: detail(A) }),
      await bannerCase({ name: 'embedded-1024', w: 1024, url: `${job.ui}/projects?order=${A}`, storage: { 'projects.view': 'workspace' } }),
      await bannerCase({ name: 'embedded-1024-long', w: 1024, url: `${job.ui}/projects?order=${A}`, storage: { 'projects.view': 'workspace' }, long: true }),
    ];
    const ok = cases.every((c) =>
      c.docOverflow <= 0 && c.bannerOverflow <= 0 && c.errors.length === 0 &&
      c.configs === (c.long ? 3 : 1) && c.configColors.length === 1 && c.configColors[0] === c.amber && c.amber !== c.sentenceColor &&
      (c.viewport === 390 ? c.button === 'below' : true) &&
      (c.viewport === 1440 ? c.button === 'beside' && c.buttonLeft > c.paraRight : true) &&
      (c.button === 'beside' ? c.paraWidth >= 320 : true));
    return {
      recipe: { cases: cases.map(({ name, viewport, long }) => ({ name, viewport, long })), fixture: ['long: GET order → three lines in three long configurations', 'long: GET stock-offers → one offer per line'] },
      measured: cases.map(({ file, ...rest }) => rest), pass: ok, screenshots: cases.map((c) => c.file),
    };
  });

  // ======================= 5. states =======================
  const stateShot = async (id, ids, { order = A, q = '', w = 1440, opts = {}, check }) =>
    scenario(id, ids, async () => {
      const { ctx, p, errors } = await open(w, opts);
      await p.goto(detail(order, q), { waitUntil: 'networkidle' });
      await p.waitForTimeout(600);
      const out = await check(p);
      const file = await shoot(p, id);
      await ctx.close();
      return { recipe: { order, q, viewport: w, rewrite: opts.rewrite?.map(([re]) => String(re)), fail: opts.fail?.map(([re, s]) => `${re} → ${s}`), delay: opts.delay?.map(([re, ms]) => `${re} +${ms}ms`) }, measured: { ...out.m, errors }, pass: out.pass && errors.length === 0, screenshots: [file] };
    });

  await stateShot('state-close-banner-244', ['E3-D03', 'E3-D04'], {
    order: O['244'],
    check: async (p) => {
      const banner = p.locator('[data-testid="close-suggestion"]');
      const visible = await banner.isVisible();
      const primaries = await banner.locator('[data-emphasis="primary"]').count();
      return { m: { visible, primaries }, pass: visible && primaries === 1 };
    },
  });
  await stateShot('state-completed-245', ['E3-D02', 'E3-G01', 'E3-G03'], {
    order: O['245'],
    check: async (p) => {
      const m = await p.evaluate(() => ({
        states: [...document.querySelectorAll('[data-testid="order-stage"] li')].map((li) => li.dataset.state),
        select: !!document.querySelector('[data-testid="order-stage"] select'),
        side: [...document.querySelectorAll('[data-testid="order-side"] h2')].map((h) => h.textContent),
        filament: document.querySelector('[data-testid="order-filament-panel"]')?.textContent ?? '',
      }));
      return { m, pass: m.states.join() === 'passed,passed,passed,current' && !m.select && m.side.join() === 'Філамент,Черга,Активність' && m.filament.includes('не розраховується') };
    },
  });
  await stateShot('state-cancelled-250', ['E3-D02', 'E3-G01'], {
    order: O['250'],
    check: async (p) => {
      const m = await p.evaluate(() => ({ stepper: !!document.querySelector('[data-testid="order-stage"]'), forecast: !!document.querySelector('[data-testid="order-forecast-panel"]') }));
      return { m, pass: !m.stepper && !m.forecast };
    },
  });
  await stateShot('state-customerless-251', ['E3-D04', 'E4-E04'], {
    order: O['251'],
    opts: {
      rewrite: [
        [exact(`/projects/${O['251']}`), (o) => ({ ...o, figures: { ...o.figures, all_printed: true } })],
        [exact(`/projects/${O['251']}/fulfilment`), (s) => ({ ...s, closes_to_stock: true })],
      ],
    },
    check: async (p) => {
      const banner = await text(p, '[data-testid="close-suggestion"]');
      const issue = await p.locator('[data-testid="close-suggestion-issue"]').count();
      return { m: { banner }, pass: /Замовника немає/.test(banner ?? '') && issue === 0 };
    },
  });
  await stateShot('state-manual-stage-247', ['E3-D02', 'E01'], {
    order: O['247'],
    check: async (p) => {
      const m = await p.evaluate(() => {
        const select = document.querySelector('[data-testid="order-stage"] select');
        return { value: select?.value, options: select ? [...select.options].map((o) => o.textContent) : [], auto: /авто/i.test(document.querySelector('[data-testid="order-head"]')?.textContent ?? '') };
      });
      return { m, pass: m.options.length === 3 && !m.auto };
    },
  });
  await stateShot('state-overdue', ['E3-C02'], {
    opts: { rewrite: [[exact(`/projects/${A}`), (o) => ({ ...o, due_date: '2026-01-10' })]] },
    check: async (p) => {
      const due = p.locator('[data-fact="due"]');
      const m = { overdue: await due.getAttribute('data-overdue'), text: await due.textContent() };
      return { m, pass: m.overdue === 'true' && /прострочено/.test(m.text ?? '') };
    },
  });
  await stateShot('state-forecast-late-incomplete', ['E3-G02', 'E3-E04'], {
    opts: {
      rewrite: [[exact(`/projects/${A}/forecast`), (f) => ({
        ...f, late: true, incomplete_reasons: [{ code: 'no_plate', count: 2 }],
        by_model: [...(f.by_model ?? []), { model: 'X1C', prints: 2, seconds: null, accepting_printers: 0 }],
      })]],
    },
    check: async (p) => {
      const m = await p.evaluate(() => ({
        eta: document.querySelector('[data-testid="order-forecast-eta"]')?.dataset.tone,
        tile: document.querySelector('[data-testid="order-tile-ready"] [data-tone]')?.getAttribute('data-tone'),
        reasons: document.querySelectorAll('[data-testid="order-forecast-reason"]').length,
        noPrinters: /немає принтерів/.test(document.querySelector('[data-testid="order-forecast-panel"]')?.textContent ?? ''),
        incompleteIcon: !!document.querySelector('[data-testid="order-tile-ready"] [role="img"]'),
      }));
      return { m, pass: m.eta === 'late' && m.tile === 'late' && m.reasons === 1 && m.noPrinters && m.incompleteIcon };
    },
  });
  await stateShot('state-no-eta', ['E3-G02', 'E3-E04'], {
    opts: { rewrite: [[exact(`/projects/${A}/forecast`), (f) => ({ ...f, now_eta: null, after_eta: null })]] },
    check: async (p) => {
      const m = { panel: await text(p, '[data-testid="order-forecast-panel"]'), tile: await text(p, '[data-testid="order-tile-ready"]') };
      return { m, pass: /Немає оцінки/.test(m.panel ?? '') && /—/.test(m.tile ?? '') };
    },
  });
  await stateShot('state-forecast-error', ['E3-G02'], {
    opts: { fail: [[exact(`/projects/${A}/forecast`), 500]] },
    check: async (p) => {
      await p.waitForTimeout(1500);
      const panel = p.locator('[data-testid="order-forecast-panel"]');
      const m = { retry: await panel.getByRole('button', { name: RETRY }).count(), tile: await text(p, '[data-testid="order-tile-ready"]') };
      return { m, pass: m.retry === 1 && /—/.test(m.tile ?? '') };
    },
  });
  await stateShot('state-order-error', ['E3-B05'], {
    opts: { fail: [[exact(`/projects/${A}`), 500]] },
    check: async (p) => {
      await p.waitForTimeout(2500);
      const m = await p.evaluate(() => ({ crumbs: !!document.querySelector('nav[aria-label]'), grid: !!document.querySelector('[data-testid="order-grid"]'), body: document.querySelector('main')?.textContent?.slice(0, 200) }));
      return { m, pass: m.crumbs && !m.grid };
    },
  });
  await stateShot('state-order-404', ['E3-B05'], {
    opts: { fail: [[exact(`/projects/${A}`), 404]] },
    check: async (p) => {
      await p.waitForTimeout(2500);
      const m = await p.evaluate(() => ({ crumbs: !!document.querySelector('nav[aria-label]'), grid: !!document.querySelector('[data-testid="order-grid"]') }));
      return { m, pass: m.crumbs && !m.grid };
    },
  });
  await scenario('state-reader-bankable', ['E3-C03', 'E3-C04', 'R08'], async () => {
    const groups = await read('/groups/');
    const viewers = (Array.isArray(groups) ? groups : groups.items).find((g) => g.name === 'Viewers');
    const { ctx, p, errors } = await open(1440, {
      me: { is_admin: false, role: 'user', permissions: viewers.permissions },
      rewrite: [[exact(`/projects/${A}`), (o) => ({ ...o, figures: { ...o.figures, bankable_surplus: 5 } })]],
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const m = await p.evaluate(() => {
      const head = document.querySelector('[data-testid="order-head"]');
      return {
        buttons: [...head.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()),
        bank: !!document.querySelector('[data-testid="order-bank-surplus"]'),
        select: !!document.querySelector('[data-testid="order-stage"] select'),
      };
    });
    await p.getByRole('tab', { name: /^Друки/ }).click();
    const tabWorks = await p
      .waitForFunction(() => /^Друки/.test(document.querySelector('[role="tablist"][aria-label="Розділи замовлення"] [aria-selected="true"]')?.textContent ?? ''), null, { timeout: 5000 })
      .then(() => true, () => false);
    const file = await shoot(p, 'state-reader-bankable');
    await ctx.close();
    return { recipe: { viewport: 1440, rewrite: ['GET /auth/me → Viewers', 'GET order → bankable_surplus 5'] }, measured: { ...m, tabWorks, errors }, pass: m.buttons.length === 0 && !m.bank && !m.select && tabWorks, screenshots: [file] };
  });
  await stateShot('state-empty-draft', ['E3-E03', 'E3-E06', '§13'], {
    opts: {
      rewrite: [[exact(`/projects/${A}`), (o) => ({
        ...o, lines: [], counts: { prints: 0, issues: 0 },
        figures: { ...o.figures, ordered: 0, printed: 0, covered_units: 0, remaining: 0, progress: 0, from_stock_units: 0, prints_in_progress: 0, prints_queued: 0, defective: 0 },
      })]],
    },
    check: async (p) => {
      const m = await p.evaluate(() => ({ bar: !!document.querySelector('[data-testid="order-progress"]'), lines: document.querySelector('[data-testid="order-main"] h2')?.textContent }));
      return { m, pass: !m.bar && /\(0\)/.test(m.lines ?? '') };
    },
  });
  await stateShot('state-long-texts@390', ['E3-C06', 'E3-B04'], {
    w: 390,
    opts: {
      rewrite: [[exact(`/projects/${A}`), (o) => ({
        ...o,
        name: 'Корпуси датчиків клімату для лабораторії зберігання харчових продуктів — друга партія з посиленими кріпленнями',
        tags: 'серія-для-лабораторії-зберігання, довгий-тег-що-не-має-пробілів-взагалі, PETG',
      })]],
    },
    check: async (p) => {
      const m = await layout(p);
      return { m: { docOverflow: m.docOverflow, head: m.head }, pass: m.docOverflow <= 0 && headOk(m.head) && m.head.actions === 'below' };
    },
  });
  await stateShot('state-procurement-unknown', ['E3-E02', 'E3-C02', 'R07'], {
    opts: {
      rewrite: [[exact(`/projects/${A}`), (o) => ({
        ...o, figures: { ...o.figures, procurement_partial: true, procurement_cost: null, procurement_known_cost: 50, cost_with_procurement: null, margin_with_procurement: null },
      })]],
    },
    check: async (p) => {
      const m = { tile: await text(p, '[data-testid="order-tile-cost"]'), margin: await text(p, '[data-testid="order-margin"]'), stats: await text(p, '[data-testid="order-cost-breakdown"]') };
      return { m, pass: /≥/.test(m.tile ?? '') && /—/.test(m.margin ?? '') && /≥/.test(m.stats ?? '') };
    },
  });
  await stateShot('state-filament-unknown', ['E3-G03', 'R02'], {
    opts: {
      rewrite: [[exact(`/projects/${A}/filament`), (n) => ({
        ...n, stock_unavailable: true, unknown_prints: 2,
        rows: [
          { material: 'PETG', colour: null, need_g: 800, have_g: 1200, have_type_g: null, short_g: 0, unknown_prints: 2 },
          { material: 'PLA', colour: null, need_g: 0, have_g: null, have_type_g: null, short_g: null, unknown_prints: 3 },
        ],
      })]],
    },
    check: async (p) => {
      const petg = await text(p, '[data-testid="filament-need-PETG"]');
      const pla = await text(p, '[data-testid="filament-need-PLA"]');
      const panel = await text(p, '[data-testid="order-filament-panel"]');
      const m = { petg, pla, panel };
      const greenEnough = await p.locator('[data-testid="order-filament-panel"] .text-bambu-green').count();
      return { m: { ...m, greenEnough }, pass: /щонайменше/.test(petg ?? '') && /відомої частини/.test(petg ?? '') && /вага невідома/.test(pla ?? '') && greenEnough === 0 && /невідомим філаментом/.test(panel ?? '') };
    },
  });
  await stateShot('state-filament-error', ['E3-G03', 'R02'], {
    opts: { fail: [[exact(`/projects/${A}/filament`), 500]] },
    check: async (p) => {
      await p.waitForTimeout(1500);
      const panel = p.locator('[data-testid="order-filament-panel"]');
      const m = { retry: await panel.getByRole('button', { name: RETRY }).count(), text: await panel.textContent() };
      return { m, pass: m.retry === 1 && !/потреби немає/i.test(m.text ?? '') };
    },
  });
  await scenario('state-cold-reads', ['E3-G03', 'E3-G04', 'R02'], async () => {
    const { ctx, p } = await open(1440, { delay: [[exact(`/projects/${A}/filament`), 4000], [exact(`/projects/${A}/queue`), 4000]] });
    await p.goto(detail(A), { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('[data-testid="order-filament-panel"]', { timeout: 15000 });
    const m = await p.evaluate(() => ({
      filament: document.querySelector('[data-testid="order-filament-panel"]').textContent,
      queue: document.querySelector('[data-testid="order-queue-panel"]').textContent,
    }));
    const file = await shoot(p, 'state-cold-reads');
    await ctx.close();
    return { recipe: { delay: ['filament +4s', 'queue +4s'] }, measured: m, pass: /Завантаження/.test(m.filament) && /Завантаження/.test(m.queue) && !/нічого немає/.test(m.queue), screenshots: [file] };
  });
  await stateShot('state-queue-error', ['E3-G04', 'R02'], {
    opts: { fail: [[exact(`/projects/${A}/queue`), 500]] },
    check: async (p) => {
      await p.waitForTimeout(1500);
      const panel = p.locator('[data-testid="order-queue-panel"]');
      const m = { retry: await panel.getByRole('button', { name: RETRY }).count(), text: await panel.textContent() };
      return { m, pass: m.retry === 1 && !/нічого немає/.test(m.text ?? '') };
    },
  });

  // ======================= 6. interactions =======================
  await scenario('tabs-keyboard-url-history', ['E3-F02', 'E3-F07', 'E2-C03'], async () => {
    const { ctx, p } = await open(1440);
    await p.goto(`${job.ui}/projects`, { waitUntil: 'networkidle' });
    await p.locator(`a[href="/projects/${A}"]`).first().click();
    await ready(p);
    const depth0 = await p.evaluate(() => history.length);
    await p.getByRole('tab', { name: /^План друку/ }).focus();
    await p.keyboard.press('ArrowRight');
    const afterArrow = await p.evaluate(() => location.search);
    await p.keyboard.press('Enter');
    await p.waitForTimeout(300);
    const afterEnter = await p.evaluate(() => location.search);
    const depth1 = await p.evaluate(() => history.length);
    await p.goBack();
    await p.waitForTimeout(500);
    const back = await p.evaluate(() => location.pathname + location.search);
    await p.goForward();
    await ready(p);
    const forward = await p.evaluate(() => location.pathname + location.search);
    const selected = await p.getByRole('tab', { name: /^Друки/ }).getAttribute('aria-selected');
    await ctx.close();
    const m = { afterArrow, afterEnter, depth0, depth1, back, forward, selected };
    return { recipe: { from: '/projects', actions: ['click order 241', 'focus plan tab', 'ArrowRight', 'Enter', 'Back', 'Forward'] }, measured: m,
      pass: afterArrow === '' && afterEnter === '?section=prints' && depth0 === depth1 && back === '/projects' && forward === `/projects/${A}?section=prints` && selected === 'true' };
  });
  await scenario('tabs-no-request-before-visit', ['E3-F04', 'R08'], async () => {
    const { ctx, p, requests } = await open(1440);
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const before = requests.filter((r) => /\/archives|stock-issues|dispatch/.test(r));
    await p.getByRole('tab', { name: /^Друки/ }).click();
    await p.waitForTimeout(1000);
    const archivesAfter = requests.filter((r) => /\/archives/.test(r)).length;
    await p.getByRole('tab', { name: /^План друку/ }).click();
    await p.getByRole('tab', { name: /^Друки/ }).click();
    await p.waitForTimeout(800);
    const archivesAgain = requests.filter((r) => /\/archives/.test(r)).length;
    await ctx.close();
    return { measured: { before, archivesAfter, archivesAgain }, pass: before.length === 0 && archivesAfter >= 1 && archivesAgain === archivesAfter };
  });
  await scenario('notes-draft-survives-tabs', ['E3-F04'], async () => {
    const { ctx, p } = await open(1440);
    await p.goto(detail(A, '?section=notes'), { waitUntil: 'networkidle' });
    await ready(p);
    const panel = p.getByRole('tabpanel', { name: /^Нотатки/ });
    await panel.getByRole('button', { name: 'Редагувати' }).click();
    const editor = panel.locator('[contenteditable="true"]').first();
    await editor.click();
    await p.keyboard.type(' E3 чернетка');
    await p.getByRole('tab', { name: /^Друки/ }).click();
    await p.getByRole('tab', { name: /^Нотатки/ }).click();
    const kept = await p.getByRole('tabpanel', { name: /^Нотатки/ }).locator('[contenteditable="true"]').first().textContent();
    const file = await shoot(p, 'notes-draft-survives-tabs');
    await ctx.close();
    return { measured: { kept }, pass: /E3 чернетка/.test(kept ?? ''), screenshots: [file] };
  });
  // After the send, the plan comes back as the server would have it — the line's rows answered — so the
  // draft clears and only the forecast re-read stands between the send and the new numbers (review 1).
  const planAfterSend = (plan) => ({ ...plan, lines: plan.lines.map((line) => ({ ...line, rows: [] })) });
  const sendPlan = async (p, sent, forecastRoute) => {
    await p.locator('[data-testid$="-inc"]').first().click();
    await p.waitForTimeout(300);
    await p.route(exact(`/projects/${A}/forecast`), forecastRoute);
    sent.value = true;
    await p.locator('[data-testid="plan-enqueue-all"]').click();
  };
  await scenario('plan-draft-send-refresh', ['E3-E04', 'E3-G02', 'R03'], async () => {
    const sent = { value: false };
    const { ctx, p } = await open(1440, {
      writes: [[/\/plan\/enqueue/, { created: [] }]],
      rewrite: [[exact(`/projects/${A}/plan`), (plan) => (sent.value ? planAfterSend(plan) : plan)]],
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const tileBase = await text(p, '[data-testid="order-tile-ready"]');
    await p.locator('[data-testid$="-inc"]').first().click();
    await p.waitForTimeout(300);
    const tileDraft = await text(p, '[data-testid="order-tile-ready"]');
    const panelDraft = await text(p, '[data-testid="order-forecast-panel"]');
    await p.getByRole('tab', { name: /^Нотатки/ }).click();
    await p.getByRole('tab', { name: /^План друку/ }).click();
    const tileStill = await text(p, '[data-testid="order-tile-ready"]');
    // Undo the edit so `sendPlan` makes the same one, then send with the forecast re-read held 3 s.
    await p.locator('[data-testid$="-dec"]').first().click();
    await sendPlan(p, sent, async (route) => { await new Promise((r) => setTimeout(r, 3000)); await route.continue(); });
    await p.waitForTimeout(800);
    const panelGap = await text(p, '[data-testid="order-forecast-panel"]');
    const tileGap = await text(p, '[data-testid="order-tile-ready"]');
    const file = await shoot(p, 'plan-draft-send-refresh');
    await p.waitForTimeout(3500);
    const panelAfter = await text(p, '[data-testid="order-forecast-panel"]');
    const tileAfter = await text(p, '[data-testid="order-tile-ready"]');
    await ctx.close();
    const m = { tileBase, tileDraft, panelDraft, tileStill, panelGap, tileGap, panelAfter, tileAfter };
    return { recipe: { actions: ['plan row +', 'tab away and back', 'send the plan (POST intercepted; the plan GET after it answers the rows)', 'forecast re-read held 3 s'] }, measured: m,
      pass: /план змінено/.test(tileDraft ?? '') && /попередньому плану/.test(panelDraft ?? '') && !/Машино-години/.test(panelDraft ?? '') &&
        /план змінено/.test(tileStill ?? '') &&
        /Завантаження/.test(panelGap ?? '') && !/Машино-години/.test(panelGap ?? '') && /…/.test(tileGap ?? '') && !/план змінено/.test(tileGap ?? '') &&
        /Машино-години/.test(panelAfter ?? '') && tileAfter === tileBase, screenshots: [file] };
  });
  await scenario('plan-send-refresh-fails', ['E3-E04', 'E3-G02', 'R03'], async () => {
    const sent = { value: false };
    const { ctx, p } = await open(1440, {
      writes: [[/\/plan\/enqueue/, { created: [] }]],
      rewrite: [[exact(`/projects/${A}/plan`), (plan) => (sent.value ? planAfterSend(plan) : plan)]],
    });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await sendPlan(p, sent, (route) => route.fulfill({ status: 500, json: { detail: 'e03 runner' } }));
    await p.waitForTimeout(1500);
    const panel = p.locator('[data-testid="order-forecast-panel"]');
    const panelFailed = await panel.textContent();
    const tileFailed = await text(p, '[data-testid="order-tile-ready"]');
    const retry = await panel.getByRole('button', { name: 'Спробувати знову' }).count();
    const file = await shoot(p, 'plan-send-refresh-fails');
    await ctx.close();
    const m = { panelFailed, tileFailed, retry };
    return { recipe: { actions: ['plan row +', 'send the plan (POST intercepted)', 'forecast re-read → 500'] }, measured: m,
      pass: retry === 1 && !/Завантаження|Машино-години/.test(panelFailed ?? '') && /—/.test(tileFailed ?? '') && !/…/.test(tileFailed ?? ''), screenshots: [file] };
  });
  await scenario('workspace-tabs-pick-open', ['E3-F03', 'E3-H02', 'R01'], async () => {
    const { ctx, p } = await open(1920, { storage: { 'projects.view': 'workspace' } });
    await p.goto(`${job.ui}/projects`, { waitUntil: 'networkidle' });
    await ready(p);
    const code = await p.evaluate((id) => document.querySelector(`[data-testid="order-view"]`)?.querySelector('[data-testid="order-meta"]')?.textContent, A);
    const rows = p.getByRole('list', { name: /Замовлення/ }).getByRole('button');
    const firstRow = rows.first();
    await firstRow.click();
    await p.getByRole('tab', { name: /^Нотатки/ }).click();
    await p.waitForTimeout(300);
    const afterTab = await p.evaluate(() => location.search);
    const openHref = await p.locator('a[aria-label^="Відкрити повну сторінку"]').getAttribute('href');
    await rows.nth(1).click();
    await p.waitForTimeout(500);
    const afterPick = await p.evaluate(() => location.search);
    const planSelected = await p.getByRole('tab', { name: /^План друку/ }).getAttribute('aria-selected');
    await ctx.close();
    const m = { code, afterTab, openHref, afterPick, planSelected };
    return { measured: m, pass: /order=\d+&section=notes/.test(afterTab) && /\?section=notes$/.test(openHref ?? '') && /order=\d+$/.test(afterPick) && !/section/.test(afterPick) && planSelected === 'true' };
  });
  await scenario('workspace-filter-drops-the-order-opens-plan', ['E3-F03', 'R01'], async () => {
    // The URL names order 241 on its notes; the «completed» tab cannot show an active order, so the
    // pane falls back to the first completed one — which must open on its plan, the pair left in the URL.
    const { ctx, p } = await open(1920, { storage: { 'projects.view': 'workspace' } });
    await p.goto(`${job.ui}/projects?tab=completed&order=${A}&section=notes`, { waitUntil: 'networkidle' });
    await ready(p);
    const m = await p.evaluate(() => ({
      search: location.search,
      shownMeta: document.querySelector('[data-testid="order-meta"]')?.textContent,
      selected: document.querySelector('[role="tablist"][aria-label="Розділи замовлення"] [aria-selected="true"]')?.textContent,
    }));
    const file = await shoot(p, 'workspace-filter-drops-the-order');
    await ctx.close();
    return { recipe: { url: '/projects?tab=completed&order={order:241}&section=notes', viewport: 1920 }, measured: m,
      pass: !/OR-0031/.test(m.shownMeta ?? '') && /^План друку/.test(m.selected ?? '') && /order=\d+&section=notes/.test(m.search), screenshots: [file] };
  });
  await scenario('menu-cover-dialog-focus', ['E3-C04', 'E3-C05', 'E2-D05'], async () => {
    const { ctx, p } = await open(1440);
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const trigger = p.getByRole('button', { name: /^Дії замовлення/ });
    await trigger.click();
    const items = await p.getByRole('menuitem').allTextContents();
    await p.getByRole('menuitem', { name: 'Обкладинка…' }).click();
    const dialog = await p.getByRole('dialog').isVisible();
    const file = await shoot(p, 'menu-cover-dialog');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    const closed = (await p.getByRole('dialog').count()) === 0;
    const focusOnTrigger = await trigger.evaluate((el) => el === document.activeElement);
    await ctx.close();
    return { measured: { items, dialog, closed, focusOnTrigger }, pass: dialog && closed && focusOnTrigger && !items.some((t) => /авто/i.test(t)), screenshots: [file] };
  });
  await scenario('stage-change-intercepted', ['E3-D02'], async () => {
    const current = await read(`/projects/${A}`);
    const { ctx, p } = await open(1440, { writes: [[/\/stage$/, { ...current, stage: 'qc' }]] });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    await p.locator('[data-testid="order-stage"] select').selectOption('qc');
    const toast = await p.getByText(/Етап:/).first().isVisible({ timeout: 3000 }).catch(() => false);
    await ctx.close();
    return { recipe: { action: 'select «Контроль якості» (PUT intercepted)' }, measured: { toast }, pass: toast };
  });
  await scenario('hit-targets@390', ['E3-C06', 'E2-F02'], async () => {
    const { ctx, p } = await open(390);
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const hits = await p.evaluate(() => {
      const check = (el) => {
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return at === el || el.contains(at);
      };
      return {
        menu: check(document.querySelector('[data-testid="order-actions"] button[aria-haspopup], [data-testid="order-actions"] button:last-child')),
        stage: check(document.querySelector('[data-testid="order-stage"] select')),
        take: check(document.querySelector('[data-testid="take-stock"] button')),
        tab: check(document.querySelector('[role="tab"]:nth-child(3)')),
        queueLink: check(document.querySelector('[data-testid="order-queue-panel"] a[href="/queue"]')),
      };
    });
    await ctx.close();
    return { measured: hits, pass: Object.values(hits).every((v) => v === true || v === null) && Object.values(hits).some((v) => v === true) };
  });
  await scenario('reading-order', ['E3-B01'], async () => {
    const { ctx, p } = await open(1920);
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const m = await p.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const seq = [q('[data-testid="order-actions"] button'), q('[data-testid="order-stage"] select'), q('[data-testid="take-stock"] button, [data-testid="close-suggestion"] button'),
        q('[role="tab"]'), q('[data-testid="order-side"] a, [data-testid="order-side"] button')].filter(Boolean);
      const ordered = seq.every((el, i) => i === 0 || Boolean(seq[i - 1].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
      return { count: seq.length, ordered };
    });
    await ctx.close();
    return { measured: m, pass: m.ordered && m.count >= 4 };
  });

  // ======================= 7. themes =======================
  await scenario('theme-light@1440', ['E2-B01'], async () => {
    const { ctx, p } = await open(1440, { storage: { 'theme-mode': 'light' } });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const e = await env(p);
    const file = await shoot(p, 'theme-light@1440');
    await ctx.close();
    return { env: e, pass: !/\bdark\b/.test(e.theme), screenshots: [file] };
  });
  await scenario('theme-oled@1440', ['E2-B01'], async () => {
    const { ctx, p } = await open(1440, { settings: { dark_background: 'oled' } });
    await p.goto(detail(A), { waitUntil: 'networkidle' });
    await ready(p);
    const e = await env(p);
    const file = await shoot(p, 'theme-oled@1440');
    await ctx.close();
    return { env: e, pass: /bg-oled/.test(e.theme), screenshots: [file] };
  });

  // ======================= 8. outside consumers (R04) =======================
  await scenario('consumer-customer-issues', ['E3-F05', 'R04'], async () => {
    const { ctx, p } = await open(1440);
    await p.goto(`${job.ui}/customers/${job.customer}`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(800);
    const heading = await p.getByRole('heading', { name: 'Видачі' }).count();
    const file = await shoot(p, 'consumer-customer-issues');
    await ctx.close();
    return { measured: { heading }, pass: heading >= 1, screenshots: [file] };
  });
  await scenario('consumer-plan-dialog-filament', ['E3-F06', 'R04', 'E3-V06'], async () => {
    // The stand's library carries no file tags, so the file manager offers «Розрахувати» for nothing, and
    // the dialog's parts preview is a POST this runner answers itself. Both are FIXTURES, recorded below:
    // the list marks one CLM-01 file as a 3MF, and the preview is built from order 241's own product and
    // that file. The order POST is intercepted and answers order 241, whose plan and filament are real reads.
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
    const { ctx, p, errors } = await open(1440, {
      rewrite: [[/\/api\/v1\/library\/files\/?\?/, (body) => (Array.isArray(body) ? body.map(tag) : body?.items ? { ...body, items: body.items.map(tag) } : body)]],
      writes: [[/\/library\/files\/parts-preview/, () => preview()], [/\/projects\/from-files/, order]],
    });
    await p.goto(`${job.ui}/files`, { waitUntil: 'networkidle' });
    await p.getByText('Корпуси', { exact: true }).first().click();
    await p.waitForTimeout(800);
    await p.getByText('CLM-01', { exact: true }).first().click();
    await p.waitForTimeout(1200);
    const selected = await p.evaluate((name) => {
      const label = [...document.querySelectorAll('*')].find((el) => el.childElementCount === 0 && el.textContent.trim() === name);
      for (let el = label; el; el = el.parentElement) {
        const box = el.querySelector('[data-select-file]');
        if (box) { box.click(); return true; }
      }
      return false;
    }, FILE);
    if (!selected || fileId == null) { await ctx.close(); return { pass: false, measured: { selected, fileId } }; }
    await p.getByRole('button', { name: /^Розрахувати$/ }).click();
    const dialog = p.getByRole('dialog');
    await dialog.waitFor({ timeout: 8000 });
    await p.waitForTimeout(800);
    const stepParts = await dialog.textContent();
    await dialog.getByRole('button', { name: /Розрахувати/ }).last().click();
    await dialog.locator('[data-testid="plan-block"]').waitFor({ timeout: 10000 });
    await p.waitForTimeout(1500);
    const m = await p.evaluate(() => {
      const d = [...document.querySelectorAll('[role="dialog"]')].pop();
      const plan = d.querySelector('[data-testid="plan-block"]');
      const block = d.querySelector('[data-testid="filament-needs"]');
      const pr = plan?.getBoundingClientRect();
      const br = block?.getBoundingClientRect();
      return {
        plan: !!plan,
        block: !!block,
        rows: block ? block.querySelectorAll('[data-testid^="filament-need-"]').length : 0,
        blockClass: block?.className ?? null,
        blockTitle: block?.querySelector('p')?.textContent ?? null,
        underPlan: !!(pr && br && br.top >= pr.top),
        sidePanelInDialog: !!d.querySelector('[data-testid="order-filament-panel"]'),
      };
    });
    const file = await shoot(p, 'consumer-plan-dialog-filament');
    await ctx.close();
    return {
      recipe: {
        route: '/files', actions: ['Корпуси / CLM-01', `select ${FILE}`, 'Розрахувати (toolbar)', 'Розрахувати in the dialog (catalog product, 1 unit)'],
        fixture: [`GET /library/files → ${FILE} tagged 3mf+sliced`, 'POST parts-preview → built from order 241’s product and that file', 'POST from-files → order 241 (intercepted)'],
      },
      measured: { ...m, fileId, stepParts: (stepParts ?? '').slice(0, 160), errors },
      pass: m.plan && m.block && m.rows > 0 && m.underPlan && !m.sidePanelInDialog && /rounded-xl/.test(m.blockClass ?? '') && /Філамент/.test(m.blockTitle ?? '') && errors.length === 0,
      screenshots: [file],
    };
  });

  await page.request.post(`${base}/done`, { data: { count: summary.length } });
  return { records: summary.length, summary };
}
