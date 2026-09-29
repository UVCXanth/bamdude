// WS-13 E2 acceptance — the rest of §H1 (review round 2): run by Playwright MCP's browser_run_code_unsafe:
//   filename: scripts/workshop_stand/e02_primitives_rest.js — while `e02_evidence.py serve primitives-rest`
//   listens on 127.0.0.1:8197. Adds only what the accepted 41 scenarios did not cover: the wide / boundary
//   geometry smoke, the pager's late-page filter / vanished-row clamp / single page, Forward into a detail,
//   the sidebar expanded / collapsed and the narrow drawer, a read-only reader. Same record shape as
//   e02_primitives.js; nothing is written to the stand — rewritten responses live in the runner's own context.
async (page) => {
  const base = 'http://127.0.0.1:8197';
  const job = await (await page.request.get(`${base}/job.json`)).json();
  const browser = page.context().browser();
  const FIX = `${job.ui}/src/__tests__/fixtures/workshop/index.html`;
  const HEIGHTS = { 2560: 1440, 1440: 900, 1280: 800, 1024: 768, 768: 1024, 561: 900, 560: 900, 390: 844 };
  const summary = [];
  const record = async (r) => { summary.push(`${r.pass ? 'ok  ' : r.pass === null ? 'PEND' : 'FAIL'} ${r.id}`); await page.request.post(`${base}/record`, { data: r }); };
  const env = async (p) => p.evaluate(() => ({ viewport: [innerWidth, innerHeight], dpr: window.devicePixelRatio, theme: document.documentElement.className }));
  const shoot = async (p, name) => { const file = `${job.out}/${name}.png`; await p.screenshot({ path: file, fullPage: false }); return file; };
  const open = async (w, { h, storage = {}, app = false, me = null } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h || HEIGHTS[w] || 900 }, deviceScaleFactor: 1, locale: 'uk-UA', timezoneId: 'Europe/Kyiv', serviceWorkers: 'block' });
    await ctx.addInitScript(({ token, storage, app }) => {
      if (sessionStorage.getItem('e02-init')) return;
      sessionStorage.setItem('e02-init', '1');
      localStorage.clear();
      if (app) localStorage.setItem('auth_token', token);
      for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    }, { token: job.token, storage, app });
    const p = await ctx.newPage();
    if (me) {
      // Read-only reader, in this context only: the answer to GET /auth/me is the same user with
      // the Viewers group's permissions and no admin flag. The server is not told anything.
      await p.route(/\/api\/v1\/auth\/me\/?(\?.*)?$/, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, ...me } });
      });
    }
    return { ctx, p };
  };
  const scenario = async (id, primitives, source, fn) => {
    try { await record({ id, primitives, source, ...(await fn()) }); }
    catch (e) { await record({ id, primitives, source, pass: false, error: String(e.message || e).split('\n')[0].slice(0, 300) }); }
  };
  const near = (a, b) => Math.abs(a - b) <= 1;
  const ORDERS = /\/api\/v1\/projects\/?\?/;
  const listRequests = (p, re) => { const seen = []; p.on('request', (r) => { if (r.method() === 'GET' && re.test(r.url())) seen.push(r.url().replace(job.ui, '')); }); return seen; };
  const settle = async (p) => { await p.waitForLoadState('networkidle'); await p.waitForTimeout(400); };

  // ---------- 1. geometry smoke at the wide and boundary widths ----------
  for (const w of [2560, 1280, 768, 561, 560]) {
    await scenario(`smoke-geometry@${w}`, ['E2-B04', 'E2-B06', 'E2-C04', 'E2-D01', 'E2-D07', 'E2-E02', 'E2-E06'], 'app+test-fixture', async () => {
      const m = {};
      {
        const { ctx, p } = await open(w, { app: true, storage: { 'projects.perPage': '12' } });
        await p.goto(`${job.ui}/projects?tab=all`, { waitUntil: 'networkidle' });
        await p.evaluate(() => document.fonts.ready);
        m.orders = await p.evaluate(() => {
          const labels = [...document.querySelector('[role="group"]').querySelectorAll('button span')].map((s) => getComputedStyle(s).display !== 'none');
          const box = document.querySelector('input[type="search"]').parentElement;
          const strip = document.querySelector('[role="tablist"]');
          const region = document.querySelector('[role="region"]');
          const bar = document.querySelector('[data-pagination]'); const br = bar.getBoundingClientRect();
          const clipped = [...bar.querySelectorAll('button, select')].filter((c) => c.getBoundingClientRect().right > br.right + 0.5).length;
          return { labels, searchW: Math.round(box.getBoundingClientRect().width), searchContainer: Math.round(box.parentElement.getBoundingClientRect().width),
            strip: [strip.clientWidth, strip.scrollWidth], region: region ? [region.clientWidth, region.scrollWidth] : null, pagerClipped: clipped,
            doc: [document.documentElement.clientWidth, document.documentElement.scrollWidth] };
        });
        m.ordersFile = await shoot(p, `smoke-orders@${w}`);
        await p.goto(`${job.ui}/stock`, { waitUntil: 'networkidle' });
        m.stock = await p.evaluate(() => { const s = document.querySelector('[role="tablist"]'); return { strip: [s.clientWidth, s.scrollWidth], doc: [document.documentElement.clientWidth, document.documentElement.scrollWidth] }; });
        await ctx.close();
      }
      {
        const { ctx, p } = await open(w);
        m.dialogs = {};
        for (const size of ['lg', 'xl']) {
          await p.goto(`${FIX}?mode=dark&bg=neutral&dialog=${size}`, { waitUntil: 'networkidle' });
          m.dialogs[size] = await p.evaluate(() => ({ width: document.querySelector('[role="dialog"]').getBoundingClientRect().width, layoutW: document.documentElement.clientWidth,
            cols: getComputedStyle(document.querySelector('[data-fixture="form"] > div')).gridTemplateColumns.split(' ').length }));
        }
        await ctx.close();
      }
      const narrow = w <= 760;
      const W = (size, L) => (size === 'lg' ? Math.min(1000, 0.94 * w, L - 32) : Math.min(1560, 0.95 * w, L - 32));
      const pass = m.orders.labels.every((s) => s === !narrow) && (narrow ? near(m.orders.searchW, m.orders.searchContainer) : m.orders.searchW === 280)
        && m.orders.doc[1] <= m.orders.doc[0] && m.orders.pagerClipped === 0 && m.stock.doc[1] <= m.stock.doc[0]
        && Object.entries(m.dialogs).every(([size, d]) => near(d.width, W(size, d.layoutW)) && d.cols === (narrow ? 1 : 2));
      return { recipe: { routes: ['/projects?tab=all', '/stock', 'fixture dialog lg/xl'], viewport: w }, measured: m, pass, screenshots: [m.ordersFile] };
    });
  }

  // ---------- 2. pager: filter on a late page, a vanished last row, a single page ----------
  await scenario('pager-filter-on-late-page', ['E2-E04', 'E2-E05', 'E2-B07'], 'app', async () => {
    const { ctx, p } = await open(1440, { app: true, storage: { 'projects.view': 'table', 'projects.perPage': '12' } });
    const seen = listRequests(p, ORDERS);
    await p.goto(`${job.ui}/projects?tab=all&page=4`, { waitUntil: 'networkidle' });
    const before = { url: await p.evaluate(() => location.search), page: seen[seen.length - 1] };
    await p.locator('input[type="search"]').fill('а');
    await p.waitForTimeout(900); await settle(p);
    const after = { url: await p.evaluate(() => location.search), request: seen[seen.length - 1],
      bar: await p.locator('[data-pagination]').first().textContent().catch(() => null) };
    await ctx.close();
    const pass = before.url.includes('page=4') && /page=4/.test(before.page) && !after.url.includes('page=') && after.url.includes('q=') && /page=1/.test(after.request) && /q=/.test(after.request);
    return { recipe: { url: '/projects?tab=all&page=4', viewport: 1440, storage: { perPage: 12 }, actions: ['type «а» in search'] }, measured: { before, after }, pass };
  });

  await scenario('pager-vanished-last-row-clamps', ['E2-E05'], 'app', async () => {
    const { ctx, p } = await open(1440, { app: true, storage: { 'projects.view': 'table', 'projects.perPage': '12' } });
    const seen = listRequests(p, ORDERS);
    // The read response says the last page is gone: the rows of page 4 vanished (36 left, 3 pages).
    // Rewritten in this context only — nothing is deleted from the baseline.
    await p.route(ORDERS, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const page = Number(new URL(route.request().url()).searchParams.get('page') || 1);
      const meta = { ...body.meta, total: 36, last_page: 3, current_page: page };
      await route.fulfill({ response, json: { ...body, items: page >= 4 ? [] : body.items, meta } });
    });
    await p.goto(`${job.ui}/projects?tab=all&page=4`, { waitUntil: 'networkidle' });
    await p.waitForFunction(() => location.search.includes('page=3'), null, { timeout: 8000 }).catch(() => {});
    await settle(p);
    const m = { url: await p.evaluate(() => location.search), requests: seen.map((u) => (u.match(/page=\d+/) || [''])[0]),
      bar: await p.locator('[data-pagination]').first().evaluate((el) => ({ text: el.textContent, buttons: [...el.querySelectorAll('button')].map((b) => b.disabled) })),
      rows: await p.locator('[role="region"] tbody tr').count() };
    const file = await shoot(p, 'pager-clamped');
    await ctx.close();
    const pass = m.url.includes('page=3') && m.requests.includes('page=4') && m.requests[m.requests.length - 1] === 'page=3'
      && m.bar.text.includes('3') && m.bar.buttons.length === 4 && m.bar.buttons[2] && m.bar.buttons[3] && m.rows > 0;
    return { recipe: { url: '/projects?tab=all&page=4', viewport: 1440, rewrite: 'GET list: total 36, last_page 3, page 4 → no items (this context only)' }, measured: m, pass, screenshots: [file] };
  });

  await scenario('pager-single-page-keeps-selector', ['E2-E04'], 'app', async () => {
    const { ctx, p } = await open(1440, { app: true, storage: { 'projects.view': 'table', 'projects.perPage': '96' } });
    await p.goto(`${job.ui}/projects?tab=all`, { waitUntil: 'networkidle' });
    const m = await p.locator('[data-pagination]').first().evaluate((el) => ({ text: el.textContent, select: !!el.querySelector('select'), value: el.querySelector('select')?.value, arrows: el.querySelectorAll('button').length }));
    const file = await shoot(p, 'pager-single-page');
    await ctx.close();
    return { recipe: { url: '/projects?tab=all', viewport: 1440, storage: { perPage: 96 } }, measured: m, pass: m.select && m.value === '96' && m.arrows === 0, screenshots: [file] };
  });

  // ---------- 3. Forward back into the detail ----------
  await scenario('history-back-then-forward', ['E2-B07'], 'app', async () => {
    const { ctx, p } = await open(1440, { app: true });
    await p.goto(`${job.ui}/projects?tab=completed`, { waitUntil: 'networkidle' });
    await p.locator('table tbody a').first().click();
    await p.waitForURL(/\/projects\/\d+/);
    const detail = await p.evaluate(() => location.pathname);
    await p.goBack(); await p.waitForURL(/\/projects\?/); await settle(p);
    const back = await p.evaluate(() => location.pathname + location.search);
    await p.goForward(); await p.waitForURL(/\/projects\/\d+/); await settle(p);
    const forward = { url: await p.evaluate(() => location.pathname), heading: await p.locator('h1').first().textContent().catch(() => null) };
    await ctx.close();
    return { recipe: { url: '/projects?tab=completed', viewport: 1440, actions: ['open first order', 'Back', 'Forward'] }, measured: { detail, back, forward },
      pass: back === '/projects?tab=completed' && forward.url === detail && !!forward.heading };
  });

  // ---------- 4. the sidebar expanded / collapsed; the narrow drawer ----------
  // Below 1144 px the app's sidebar is compact — a drawer, with no expanded / collapsed state at all
  // (hooks/useIsSidebarCompact.ts): the two states are checked above it, the drawer below it.
  for (const w of [1440, 1280]) {
    await scenario(`sidebar-expanded-collapsed@${w}`, ['E2-B03', 'E2-B07', 'E2-E02'], 'app', async () => {
      const out = {};
      for (const state of ['true', 'false']) {
        const { ctx, p } = await open(w, { app: true, storage: { sidebarExpanded: state, 'projects.view': 'table' } });
        await p.goto(`${job.ui}/projects?tab=all`, { waitUntil: 'networkidle' });
        out[state === 'true' ? 'expanded' : 'collapsed'] = await p.evaluate(() => {
          const header = document.querySelector('[data-testid="list-page-header"]'); const kids = [...header.children].map((k) => k.getBoundingClientRect());
          const overlap = kids.length === 2 && !(kids[0].right <= kids[1].left || kids[1].top >= kids[0].bottom || kids[0].top >= kids[1].bottom);
          const bar = document.querySelector('[data-pagination]'); const br = bar.getBoundingClientRect();
          return { contentLeft: Math.round(document.querySelector('.workshop').getBoundingClientRect().left), headerOverlap: overlap,
            pagerClipped: [...bar.querySelectorAll('button, select')].filter((c) => c.getBoundingClientRect().right > br.right + 0.5).length,
            doc: [document.documentElement.clientWidth, document.documentElement.scrollWidth] };
        });
        if (state === 'true') {
          // The toggle changes the sidebar and nothing else: the URL stays.
          const url = await p.evaluate(() => location.pathname + location.search);
          await p.locator('button[title="Згорнути"]').click();
          await p.waitForTimeout(400);
          out.toggle = { urlBefore: url, urlAfter: await p.evaluate(() => location.pathname + location.search), contentLeftAfter: Math.round(await p.evaluate(() => document.querySelector('.workshop').getBoundingClientRect().left)) };
        }
        out[`file_${state}`] = await shoot(p, `sidebar-${state === 'true' ? 'expanded' : 'collapsed'}@${w}`);
        await ctx.close();
      }
      const ok = (s) => !s.headerOverlap && s.pagerClipped === 0 && s.doc[1] <= s.doc[0];
      const pass = ok(out.expanded) && ok(out.collapsed) && out.collapsed.contentLeft < out.expanded.contentLeft
        && out.toggle.urlAfter === out.toggle.urlBefore && out.toggle.contentLeftAfter < out.expanded.contentLeft;
      return { recipe: { url: '/projects?tab=all', viewport: w, storage: 'sidebarExpanded true / false (own context)', actions: ['click «Згорнути»'] }, measured: out, pass, screenshots: [out.file_true, out.file_false] };
    });
  }

  for (const dw of [390, 1024]) await scenario(`narrow-drawer@${dw}`, ['E2-B07', 'E2-G44'], 'app', async () => {
    const { ctx, p } = await open(dw, { app: true });
    await p.goto(`${job.ui}/projects`, { waitUntil: 'networkidle' });
    const url = await p.evaluate(() => location.pathname + location.search);
    const stored = await p.evaluate(() => localStorage.getItem('sidebarExpanded'));
    await p.locator('header button').first().click();
    await p.waitForTimeout(400);
    const opened = await p.evaluate(() => { const nav = [...document.querySelectorAll('nav')].find((n) => n.getBoundingClientRect().width > 0 && n.querySelector('a[href="/projects"]')); return !!nav; });
    const file = await shoot(p, `narrow-drawer-open@${dw}`);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(400);
    const m = { opened, urlAfter: await p.evaluate(() => location.pathname + location.search), storedAfter: await p.evaluate(() => localStorage.getItem('sidebarExpanded')),
      doc: await p.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollWidth]) };
    await ctx.close();
    return { recipe: { url: '/projects', viewport: dw, actions: ['menu button', 'Escape'] }, measured: { url, stored, ...m },
      pass: opened && m.urlAfter === url && m.storedAfter === stored && m.doc[1] <= m.doc[0], screenshots: [file] };
  });

  // ---------- 5. a read-only reader: no Create, the tabs still work ----------
  await scenario('read-only-reader', ['E2-B03', 'E2-C06', 'E2-F02'], 'app', async () => {
    const groups = await (await page.request.get(`${job.api}/api/v1/groups/`, { headers: { Authorization: `Bearer ${job.token}` } })).json();
    const viewers = (Array.isArray(groups) ? groups : groups.items).find((g) => g.name === 'Viewers');
    const me = { is_admin: false, role: 'user', permissions: viewers.permissions };
    const { ctx, p } = await open(1440, { app: true, me });
    const out = {};
    for (const [key, route, create] of [['orders', '/projects', 'Нове замовлення'], ['products', '/products', null], ['customers', '/customers', null], ['stock', '/stock', null]]) {
      await p.goto(job.ui + route, { waitUntil: 'networkidle' });
      await p.waitForTimeout(300);
      out[key] = await p.evaluate(() => {
        const header = document.querySelector('[data-testid="list-page-header"]');
        return { headerButtons: [...header.querySelectorAll('button')].filter((b) => !b.closest('[role="group"]')).map((b) => b.textContent.trim()),
          tabs: [...document.querySelectorAll('[role="tab"]')].length };
      });
      if (create) out[key].createVisible = await p.getByRole('button', { name: create }).count();
    }
    // The read tabs still switch.
    await p.goto(`${job.ui}/projects`, { waitUntil: 'networkidle' });
    const strip = p.locator('[role="tablist"]').first();
    await strip.locator('[aria-selected="true"]').focus();
    await p.keyboard.press('ArrowRight'); await p.keyboard.press('Enter');
    await p.waitForFunction(() => location.search.includes('tab=completed'), null, { timeout: 5000 }).catch(() => {});
    out.tabSwitch = await p.evaluate(() => location.search);
    out.permissions = viewers.permissions;
    const file = await shoot(p, 'read-only-orders');
    await ctx.close();
    const pass = out.orders.createVisible === 0 && Object.values(out).filter((o) => o && o.headerButtons).every((o) => o.headerButtons.length === 0)
      && out.orders.tabs === 4 && out.stock.tabs === 4 && out.tabSwitch === '?tab=completed';
    return { recipe: { routes: ['/projects', '/products', '/customers', '/stock'], viewport: 1440, rewrite: 'GET /auth/me → is_admin false, the Viewers group permissions (this context only)' }, measured: out, pass, screenshots: [file] };
  });

  await page.request.post(`${base}/done`, { data: { count: summary.length } });
  return { records: summary.length, summary };
}
