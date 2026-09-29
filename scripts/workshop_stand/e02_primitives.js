// WS-13 E2 acceptance runner (spec §H1/H2), run by Playwright MCP's browser_run_code_unsafe:
//   filename: scripts/workshop_stand/e02_primitives.js — while `e02_evidence.py serve` listens on 127.0.0.1:8197.
// Every scenario records WHAT was run (recipe), WHERE (viewport, DPR, the actual <html> theme
// classes), WHAT was measured (rects, computed styles, interaction results) and whether it
// matched the spec — a failure is recorded as a failure, never skipped. Writes go nowhere:
// app POSTs are intercepted before the server, and nothing the runner does changes the stand.
async (page) => {
  const base = 'http://127.0.0.1:8197';
  const job = await (await page.request.get(`${base}/job.json`)).json();
  const browser = page.context().browser();
  const FIX = `${job.ui}/src/__tests__/fixtures/workshop/index.html`;
  const HEIGHTS = { 1920: 1080, 1440: 900, 1024: 768, 761: 900, 760: 900, 390: 844 };
  const summary = [];

  const record = async (r) => {
    summary.push(`${r.pass ? 'ok  ' : 'FAIL'} ${r.id}`);
    await page.request.post(`${base}/record`, { data: r });
  };
  const env = async (p) => p.evaluate(() => ({
    viewport: [innerWidth, innerHeight], dpr: window.devicePixelRatio,
    theme: document.documentElement.className,
    pageBg: getComputedStyle(document.body).backgroundColor,
  }));
  const shoot = async (p, name) => {
    const file = `${job.out}/${name}.png`;
    await p.screenshot({ path: file, fullPage: false });
    return file;
  };
  const open = async (w, { h, storage = {}, app = false, settings = null } = {}) => {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h || HEIGHTS[w] || 900 }, deviceScaleFactor: 1, locale: 'uk-UA',
      timezoneId: 'Europe/Kyiv', serviceWorkers: 'block',
    });
    await ctx.addInitScript(({ token, storage, app }) => {
      if (sessionStorage.getItem('e02-init')) return;
      sessionStorage.setItem('e02-init', '1');
      localStorage.clear();
      if (app) localStorage.setItem('auth_token', token);
      for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
    }, { token: job.token, storage, app });
    const p = await ctx.newPage();
    if (settings) {
      // The reviewer's recipe: only this context's GET of the settings is rewritten —
      // nothing is PATCHed or PUT, the stand keeps its own theme.
      await p.route(/\/api\/v1\/settings\/?(\?.*)?$/, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, ...settings } });
      });
    }
    return { ctx, p };
  };
  const scenario = async (id, primitives, source, fn) => {
    try {
      const r = await fn();
      await record({ id, primitives, source, ...r });
    } catch (e) {
      await record({ id, primitives, source, pass: false, error: String(e.message || e).split('\n')[0].slice(0, 300) });
    }
  };
  const near = (a, b) => Math.abs(a - b) <= 1;

  // ======================= fixture (source: test-fixture) =======================

  for (const w of [1440, 390]) {
    await scenario(`fixture-tabs-geometry@${w}`, ['E2-C01', 'E2-C04', 'E2-C05'], 'test-fixture', async () => {
      const { ctx, p } = await open(w);
      const url = `${FIX}?mode=dark&bg=neutral`;
      await p.goto(url, { waitUntil: 'networkidle' });
      await p.evaluate(() => document.fonts.ready);
      const m = await p.evaluate(() => {
        const strip = document.querySelector('[data-fixture="tabs-detail"] [role="tablist"]');
        const tabs = [...strip.querySelectorAll('[role="tab"]')];
        const cs = getComputedStyle(strip), t0 = getComputedStyle(tabs[0]);
        const filter = [...document.querySelectorAll('[data-fixture="tabs-filter"] [role="tab"]')];
        const f0 = getComputedStyle(filter[0]);
        return {
          stripGap: cs.columnGap, stripLine: cs.boxShadow.includes('inset'), stripOverflowX: cs.overflowX,
          detailPad: `${t0.paddingTop} ${t0.paddingRight}`, filterPad: `${f0.paddingTop} ${f0.paddingRight}`,
          activeBorder: `${f0.borderBottomWidth}`, font: `${t0.fontSize}/${t0.fontWeight}`, radius: t0.borderRadius,
          strip: [strip.clientWidth, strip.scrollWidth], doc: [document.documentElement.clientWidth, document.documentElement.scrollWidth],
          counts: filter.map((t) => t.textContent),
        };
      });
      const e = await env(p);
      const file = await shoot(p, `fixture-tabs@${w}`);
      await ctx.close();
      const pass = m.stripGap === '4px' && m.stripLine && m.detailPad === '8px 14px' && m.filterPad === '8px 16px'
        && m.activeBorder === '2px' && m.font === '14px/400' && m.radius === '0px' && m.doc[1] <= m.doc[0]
        && m.counts.some((c) => c.endsWith('(0)')) && m.counts.some((c) => c.includes('(—)')) && m.counts.some((c) => !c.includes('('));
      return { recipe: { url, viewport: w }, env: e, measured: m, pass, screenshots: [file] };
    });
  }

  await scenario('fixture-tabs-keyboard', ['E2-C03', 'E2-V01'], 'test-fixture', async () => {
    const { ctx, p } = await open(1440);
    const url = `${FIX}?mode=dark&bg=neutral`;
    await p.goto(url, { waitUntil: 'networkidle' });
    const strip = p.locator('[data-fixture="tabs-filter"] [role="tablist"]');
    const who = () => p.evaluate(() => { const a = document.activeElement; return a.getAttribute('data-fixture') || (a.getAttribute('role') === 'tab' ? `tab:${a.textContent.split(' (')[0]}` : a.tagName); });
    const selected = () => strip.locator('[role="tab"][aria-selected="true"]').textContent();
    const steps = [];
    await strip.locator('[role="tab"][aria-selected="true"]').focus();
    await p.keyboard.press('ArrowRight'); steps.push(['ArrowRight', await who(), await selected()]);
    await p.keyboard.press('ArrowRight'); steps.push(['ArrowRight (disabled skipped)', await who(), await selected()]);
    await p.keyboard.press('End'); await p.keyboard.press('Enter'); steps.push(['End, Enter', await who(), await selected()]);
    await p.keyboard.press('Home'); steps.push(['Home', await who(), await selected()]);
    await p.keyboard.press('Tab'); steps.push(['Tab (leaves forward)', await who(), await selected()]);
    await p.keyboard.press('Shift+Tab'); steps.push(['Shift+Tab (re-enters on the selection)', await who(), await selected()]);
    await p.keyboard.press('Home'); await p.keyboard.press(' '); steps.push(['Home, Space', await who(), await selected()]);
    await p.keyboard.press('End'); steps.push(['End', await who(), await selected()]);
    await p.keyboard.press('Shift+Tab'); steps.push(['Shift+Tab (leaves backward)', await who(), await selected()]);
    const e = await env(p);
    await ctx.close();
    const expect = [
      ['tab:Виконані', 'Активні (12)'], ['tab:Архівні замовлення з дуже довгою назвою вкладки', 'Активні (12)'],
      ['tab:Усі', 'Усі (—), кількість завантажується'], ['tab:Активні', 'Усі (—), кількість завантажується'],
      ['tab:Позиції', 'Усі (—), кількість завантажується'], ['tab:Усі', 'Усі (—), кількість завантажується'],
      ['tab:Активні', 'Активні (12)'], ['tab:Усі', 'Активні (12)'], ['before-tabs', 'Активні (12)'],
    ];
    const pass = steps.every((s, i) => s[1] === expect[i][0] && s[2] === expect[i][1]);
    return { recipe: { url, viewport: 1440, actions: steps.map((s) => s[0]) }, env: e, measured: { steps }, expected: expect, pass };
  });

  const WIDTH = (size, W) => ({ sm: Math.min(448, W - 32), md: Math.min(560, W - 32), lg: Math.min(1000, 0.94 * W, W - 32), xl: Math.min(1560, 0.95 * W, W - 32) })[size];
  for (const W of [1920, 1024, 390]) {
    await scenario(`fixture-dialog-sizes@${W}`, ['E2-D01', 'E2-D02'], 'test-fixture', async () => {
      const { ctx, p } = await open(W);
      const rows = [];
      const files = [];
      for (const size of ['sm', 'md', 'lg', 'xl']) {
        const url = `${FIX}?mode=dark&bg=neutral&dialog=${size}&error=short`;
        await p.goto(url, { waitUntil: 'networkidle' });
        await p.evaluate(() => document.fonts.ready);
        const m = await p.evaluate(() => {
          const panel = document.querySelector('[role="dialog"]'); const kids = [...panel.children]; const cs = (el) => getComputedStyle(el);
          const header = kids[0], sub = kids[1].firstElementChild, body = kids[2], alert = panel.querySelector('[role="alert"]'), footer = kids[4];
          const h2 = header.querySelector('h2'), x = header.querySelector('button[aria-label]');
          return {
            width: panel.getBoundingClientRect().width, radius: cs(panel).borderTopLeftRadius, maxH: cs(panel).maxHeight, workshop: panel.classList.contains('workshop'),
            header: cs(header).padding, title: `${cs(h2).fontSize}/${cs(h2).lineHeight}/${cs(h2).fontWeight}`, x: `${cs(x).padding} ${x.querySelector('svg').getBoundingClientRect().width}`,
            subtitle: cs(sub).padding, body: cs(body).padding, alert: `${cs(alert).margin} ${cs(alert).fontSize}`,
            footer: `${cs(footer).padding} gap ${cs(footer.firstElementChild).columnGap}`, layoutW: document.documentElement.clientWidth,
          };
        });
        const expected = WIDTH(size, m.layoutW);
        rows.push({ size, ...m, expected, ok: near(m.width, expected) && m.radius === '12px' && m.header === '16px' && m.title === '18px/28px/600'
          && m.x === '4px 20' && m.subtitle === '12px 16px 0px' && m.body === '12px 16px 16px' && m.alert === '0px 16px 8px 14px'
          && m.footer === '12px 16px gap 8px' && m.workshop });
        if (size === 'lg' || W === 1920) files.push(await shoot(p, `fixture-dialog-${size}@${W}`));
      }
      const e = await env(p);
      await ctx.close();
      return { recipe: { url: `${FIX}?mode=dark&bg=neutral&dialog=<size>&error=short`, viewport: W }, env: e, measured: { rows }, pass: rows.every((r) => r.ok), screenshots: files };
    });
  }

  for (const [W, H] of [[390, 600], [1024, 600]]) {
    await scenario(`fixture-dialog-short@${W}x${H}`, ['E2-D03'], 'test-fixture', async () => {
      const { ctx, p } = await open(W, { h: H });
      const url = `${FIX}?mode=dark&bg=neutral&dialog=lg&error=long&long=1`;
      await p.goto(url, { waitUntil: 'networkidle' });
      const m = await p.evaluate(() => {
        const panel = document.querySelector('[role="dialog"]'); const kids = [...panel.children]; const r = (el) => el.getBoundingClientRect();
        const primary = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Створити');
        return { panelBottom: r(panel).bottom, vh: innerHeight, body: Math.round(r(kids[2]).height), bodyScrolls: kids[2].scrollHeight > kids[2].clientHeight,
          alert: Math.round(r(kids[3]).height), alertScrolls: kids[3].scrollHeight > kids[3].clientHeight,
          primaryInView: r(primary).bottom <= innerHeight && r(primary).top >= 0, panelOverflowX: panel.scrollWidth > panel.clientWidth,
          doc: [document.documentElement.clientWidth, document.documentElement.scrollWidth] };
      });
      const e = await env(p);
      const file = await shoot(p, `fixture-dialog-short@${W}x${H}`);
      await ctx.close();
      const pass = m.primaryInView && m.alertScrolls && m.alert <= 0.25 * H + 1 && m.body > 0 && m.bodyScrolls && !m.panelOverflowX && m.panelBottom <= H && m.doc[1] <= m.doc[0];
      return { recipe: { url, viewport: [W, H] }, env: e, measured: m, pass, screenshots: [file] };
    });
  }

  await scenario('fixture-dialog-submit', ['E2-D04', 'E2-D05'], 'test-fixture', async () => {
    const { ctx, p } = await open(1024);
    const url = `${FIX}?mode=dark&bg=neutral&dialog=lg`;
    await p.goto(url, { waitUntil: 'networkidle' });
    const submitted = async () => Number(await p.locator('[data-fixture="submitted"]').textContent());
    await p.locator('#fx-name').press('Enter');
    const emptyEnter = await submitted();
    const validation = await p.evaluate(() => document.getElementById('fx-name').validationMessage !== '');
    await p.locator('#fx-name').fill('Лампа');
    await p.locator('#fx-name').press('Enter');
    const filledEnter = await submitted();
    await p.locator('#fx-note').focus();
    await p.keyboard.type('a'); await p.keyboard.press('Enter'); await p.keyboard.type('b');
    const note = await p.locator('#fx-note').inputValue();
    const afterTextarea = await submitted();
    await p.getByRole('button', { name: 'Створити' }).click();
    const afterClick = await submitted();
    await p.getByRole('button', { name: 'Скасувати' }).click();
    const open_ = await p.locator('[role="dialog"]').count();
    const e = await env(p);
    await ctx.close();
    const m = { emptyEnter, validation, filledEnter, note, afterTextarea, afterClick, dialogsAfterCancel: open_ };
    return { recipe: { url, viewport: 1024, actions: ['Enter empty', 'fill', 'Enter', 'textarea a Enter b', 'click Створити', 'click Скасувати'] }, env: e, measured: m,
      pass: emptyEnter === 0 && validation && filledEnter === 1 && note === 'a\nb' && afterTextarea === 1 && afterClick === 2 && open_ === 0 };
  });

  await scenario('fixture-dialog-pending', ['E2-D05'], 'test-fixture', async () => {
    const { ctx, p } = await open(1024);
    const url = `${FIX}?mode=dark&bg=neutral&dialog=md&pending=1`;
    await p.goto(url, { waitUntil: 'networkidle' });
    const x = await p.getByRole('button', { name: 'Закрити' }).isDisabled();
    const submit = await p.getByRole('button', { name: 'Створити' }).isDisabled();
    await p.keyboard.press('Escape');
    const stillOpen = await p.locator('[role="dialog"]').count();
    const e = await env(p);
    await ctx.close();
    return { recipe: { url, viewport: 1024, actions: ['Escape'] }, env: e, measured: { xDisabled: x, submitDisabled: submit, openAfterEscape: stillOpen }, pass: x && submit && stillOpen === 1 };
  });

  await scenario('fixture-menu-nested-dialog', ['E2-F01', 'E2-D05', 'E2-F02'], 'test-fixture', async () => {
    const { ctx, p } = await open(1024);
    const url = `${FIX}?mode=dark&bg=neutral&dialog=md`;
    await p.goto(url, { waitUntil: 'networkidle' });
    const act = () => p.evaluate(() => document.activeElement.textContent || document.activeElement.getAttribute('data-testid'));
    await p.getByTestId('fixture-menu').click();
    await p.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem');
    const first = await act();
    const geo = await p.evaluate(() => {
      const items = [...document.querySelectorAll('[role="menuitem"]')]; const last = items[items.length - 1].getBoundingClientRect(); const m = document.querySelector('[role="menu"]').getBoundingClientRect();
      const top = document.elementFromPoint(m.left + 8, m.top + 8);
      return { menuInView: m.top >= 0 && m.bottom <= innerHeight && m.right <= innerWidth, lastInView: last.bottom <= innerHeight, onTop: !!top && !!top.closest('[role="menu"]') };
    });
    const file = await shoot(p, 'fixture-menu-in-dialog');
    await p.keyboard.press('ArrowDown');
    const second = await act();
    await p.keyboard.press('Enter');
    await p.getByRole('dialog', { name: 'Вкладений діалог' }).waitFor();
    const two = await p.locator('[role="dialog"]').count();
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 1);
    const back = await act();
    const e = await env(p);
    await ctx.close();
    const m = { first, ...geo, second, dialogsOpen: two, focusAfterEscape: back };
    return { recipe: { url, viewport: 1024, actions: ['open menu', 'ArrowDown', 'Enter', 'Escape'] }, env: e, measured: m,
      pass: first === 'Дублювати' && geo.menuInView && geo.lastInView && geo.onTop && second === 'Відкрити вкладений діалог' && two === 2 && back === 'fixture-menu', screenshots: [file] };
  });

  await scenario('fixture-grid-boundary', ['E2-D07'], 'test-fixture', async () => {
    const rows = [];
    for (const w of [761, 760]) {
      const { ctx, p } = await open(w);
      await p.goto(`${FIX}?mode=dark&bg=neutral&dialog=lg`, { waitUntil: 'networkidle' });
      rows.push({ w, ...(await p.evaluate(() => { const g = document.querySelector('[data-fixture="form"] > div'); const cs = getComputedStyle(g); const hint = document.getElementById('fx-name-hint'); const hc = getComputedStyle(hint);
        return { cols: cs.gridTemplateColumns.split(' ').length, gap: `${cs.rowGap} ${cs.columnGap}`, margin: cs.margin, fieldGap: getComputedStyle(g.firstElementChild).rowGap, hint: `${hc.fontSize}/${hc.lineHeight}` }; })) });
      await ctx.close();
    }
    const [a, b] = rows;
    return { recipe: { url: `${FIX}?mode=dark&bg=neutral&dialog=lg`, viewport: [761, 760] }, measured: { rows },
      pass: a.cols === 2 && b.cols === 1 && a.gap === '14px 16px' && a.margin === '8px 0px 12px' && a.fieldGap === '4px' && a.hint === '12px/18px' };
  });

  for (const [name, q] of [['neutral', 'mode=dark&bg=neutral'], ['light', 'mode=light&bg=neutral'], ['oled', 'mode=dark&bg=oled']]) {
    await scenario(`fixture-theme-${name}`, ['E2-B01'], 'test-fixture', async () => {
      const { ctx, p } = await open(1440);
      const url = `${FIX}?${q}&dialog=lg&error=short`;
      await p.goto(url, { waitUntil: 'networkidle' });
      const m = await p.evaluate(() => { const panel = document.querySelector('[role="dialog"]'); return { panelBg: getComputedStyle(panel).backgroundColor, title: getComputedStyle(panel.querySelector('h2')).color }; });
      const e = await env(p);
      const file = await shoot(p, `fixture-theme-${name}`);
      await ctx.close();
      const pass = name === 'light' ? !e.theme.includes('dark') : e.theme.includes('dark') && e.theme.includes(`bg-${name}`);
      return { recipe: { url, viewport: 1440 }, env: e, measured: m, pass, screenshots: [file] };
    });
  }

  // =========================== app (source: app) ===========================

  const listRequests = (p, re) => { const seen = []; p.on('request', (r) => { if (r.method() === 'GET' && re.test(r.url())) seen.push(r.url().replace(job.ui, '')); }); return seen; };
  const ORDERS = /\/api\/v1\/projects\/?\?/;

  await scenario('app-fallback-table', ['E2-B05'], 'app', async () => {
    const out = {};
    for (const [key, route, re] of [['orders', '/projects', ORDERS], ['products', '/products', /\/api\/v1\/products\/?\?/], ['customer', `/customers/${job.customer}`, ORDERS]]) {
      const { ctx, p } = await open(1440, { app: true });
      const seen = listRequests(p, re);
      await p.goto(job.ui + route, { waitUntil: 'networkidle' });
      out[key] = { pressed: await p.locator('[role="group"] button[aria-pressed="true"]').first().getAttribute('aria-label'), request: seen[seen.length - 1] || null,
        stored: await p.evaluate((k) => localStorage.getItem(k), { orders: 'projects.view', products: 'bamdude-products-view', customer: 'bamdude-customer-orders-view' }[key]) };
      await ctx.close();
    }
    const pass = out.orders.pressed === 'Таблиця' && /sort_by=due-asc/.test(out.orders.request) && out.orders.stored === null
      && out.products.pressed === 'Таблиця' && /sort_by=name-asc/.test(out.products.request)
      && out.customer.pressed === 'Таблиця' && /sort_by=due-asc/.test(out.customer.request);
    return { recipe: { routes: ['/projects', '/products', '/customers/:id'], storage: 'fresh' }, measured: out, pass };
  });

  for (const [key, route, next] of [['orders', '/projects', 'Виконане'], ['stock', '/stock', 'Вільні деталі']]) {
    await scenario(`app-tabs-${key}`, ['E2-C02', 'E2-C03', 'E2-C06'], 'app', async () => {
      const { ctx, p } = await open(1440, { app: true });
      const seen = listRequests(p, key === 'orders' ? ORDERS : /\/api\/v1\/stock/);
      await p.goto(job.ui + route, { waitUntil: 'networkidle' });
      const strip = p.locator('[role="tablist"]').first();
      const label = await strip.getAttribute('aria-label');
      const panelOk = await strip.evaluate((el) => { const sel = el.querySelector('[aria-selected="true"]'); const panel = document.getElementById(sel.getAttribute('aria-controls')); return !!panel && panel.getAttribute('aria-labelledby') === sel.id; });
      const before = { url: await p.evaluate(() => location.search), len: await p.evaluate(() => history.length), requests: seen.length };
      await strip.locator('[role="tab"][aria-selected="true"]').focus();
      await p.keyboard.press('ArrowRight');
      await p.waitForTimeout(400);
      const afterArrow = { url: await p.evaluate(() => location.search), requests: seen.length, selected: await strip.locator('[aria-selected="true"]').textContent() };
      await p.keyboard.press('Enter');
      await p.waitForFunction((n) => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.startsWith(n), next);
      await p.waitForLoadState('networkidle');
      const afterEnter = { url: await p.evaluate(() => location.search), len: await p.evaluate(() => history.length), focusOnSelected: await p.evaluate(() => document.activeElement?.getAttribute('aria-selected') === 'true') };
      const e = await env(p);
      await ctx.close();
      const m = { label, panelOk, before, afterArrow, afterEnter };
      const pass = !!label && panelOk && afterArrow.url === before.url && afterArrow.requests === before.requests && afterEnter.len === before.len && afterEnter.focusOnSelected
        && (key === 'orders' ? afterEnter.url === '?tab=completed' : afterEnter.url === '?tab=parts');
      return { recipe: { url: job.ui + route, viewport: 1440, actions: ['focus selected', 'ArrowRight', 'Enter'] }, env: e, measured: m, pass };
    });
  }

  await scenario('app-back-from-detail', ['E2-B07'], 'app', async () => {
    const { ctx, p } = await open(1440, { app: true });
    await p.goto(`${job.ui}/projects?tab=completed`, { waitUntil: 'networkidle' });
    const link = p.locator('table tbody a').first();
    await link.click();
    await p.waitForURL(/\/projects\/\d+/);
    await p.goBack();
    await p.waitForURL(/\/projects\?/);
    await p.waitForLoadState('networkidle');
    const m = { url: await p.evaluate(() => location.pathname + location.search), selected: await p.locator('[role="tab"][aria-selected="true"]').first().textContent() };
    await ctx.close();
    return { recipe: { url: '/projects?tab=completed', actions: ['open first order', 'Back'] }, measured: m, pass: m.url === '/projects?tab=completed' && m.selected.startsWith('Виконане') };
  });

  for (const w of [1440, 761, 760, 390]) {
    await scenario(`app-header-toggle-search@${w}`, ['E2-B02', 'E2-B03', 'E2-B04', 'E2-B06'], 'app', async () => {
      const { ctx, p } = await open(w, { app: true });
      await p.goto(`${job.ui}/projects`, { waitUntil: 'networkidle' });
      await p.evaluate(() => document.fonts.ready);
      const m = await p.evaluate(() => {
        const buttons = [...document.querySelector('[role="group"]').querySelectorAll('button')];
        const search = document.querySelector('input[type="search"]'); const box = search.parentElement;
        const root = document.querySelector('.workshop'); const rcs = getComputedStyle(root);
        const header = document.querySelector('[data-testid="list-page-header"]'); const kids = [...header.children].map((k) => k.getBoundingClientRect());
        const overlap = kids.length === 2 && !(kids[0].right <= kids[1].left || kids[1].top >= kids[0].bottom || kids[0].top >= kids[1].bottom);
        const icon = box.querySelector('svg').getBoundingClientRect(); const bcs = getComputedStyle(search);
        return { labels: buttons.map((b) => getComputedStyle(b.querySelector('span')).display !== 'none'), names: buttons.map((b) => b.getAttribute('aria-label')),
          toggle: (() => { const g = getComputedStyle(buttons[0]); return `${g.paddingTop} ${g.paddingRight} gap ${g.columnGap}`; })(),
          searchW: Math.round(box.getBoundingClientRect().width), containerW: Math.round(box.parentElement.getBoundingClientRect().width),
          icon: [Math.round(icon.width), Math.round(icon.left - box.getBoundingClientRect().left)], inputPadLeft: bcs.paddingLeft,
          base: `${rcs.fontSize}/${rcs.lineHeight}`, title: (() => { const h = getComputedStyle(document.querySelector('h1')); return `${h.fontSize}/${h.lineHeight}/${h.fontWeight}`; })(),
          headerOverlap: overlap, doc: [document.documentElement.clientWidth, document.documentElement.scrollWidth] };
      });
      const search = p.locator('input[type="search"]');
      await search.fill('ла');
      await p.getByRole('button', { name: 'Очистити пошук' }).click();
      m.clearFocus = await p.evaluate(() => document.activeElement?.getAttribute('type'));
      await search.fill('лампа');
      await search.hover();
      const bb = await search.locator('..').boundingBox();
      const crop = `${job.out}/app-search@${w}.png`;
      await p.screenshot({ path: crop, clip: { x: bb.x - 4, y: bb.y - 4, width: bb.width + 8, height: bb.height + 8 } });
      m.cancelRule = await p.evaluate(() => { for (const sheet of document.styleSheets) { let rs; try { rs = sheet.cssRules; } catch { continue; } for (const r of rs) if (r.cssText.includes('search-cancel-button')) return true; } return false; });
      const e = await env(p);
      const file = await shoot(p, `app-orders-header@${w}`);
      await ctx.close();
      const narrow = w <= 760;
      const pass = m.labels.every((s) => s === !narrow) && m.names.length === 5 && m.names.every(Boolean) && m.toggle === '6px 12px gap 6px'
        && (narrow ? near(m.searchW, m.containerW) : m.searchW === 280) && m.icon[0] === 16 && near(m.icon[1], 12) && m.inputPadLeft === '36px'
        && m.base === '14px/21px' && m.title === '24px/32px/600' && !m.headerOverlap && m.doc[1] <= m.doc[0] && m.clearFocus === 'search' && m.cancelRule;
      return { recipe: { url: `${job.ui}/projects`, viewport: w, storage: 'fresh', actions: ['type, clear', 'type, hover'] }, env: e, measured: m, pass, screenshots: [file, crop] };
    });
  }

  const openAddToOrder = async (p) => {
    const list = await (await p.request.get(`${job.api}/api/v1/projects/?status=active&page=1&per_page=1`, { headers: { Authorization: `Bearer ${job.token}` } })).json();
    await p.goto(`${job.ui}/projects/${list.items[0].id}`, { waitUntil: 'networkidle' });
    await p.getByRole('button', { name: 'Додати в замовлення' }).first().click();
    const dlg = p.getByRole('dialog');
    await dlg.waitFor();
    return dlg;
  };

  for (const w of [1024, 390]) {
    await scenario(`app-picker-search@${w}`, ['E2-B06'], 'app', async () => {
      const { ctx, p } = await open(w, { app: true });
      const writes = []; p.on('request', (r) => { if (!['GET', 'HEAD', 'OPTIONS'].includes(r.method()) && !/\/auth\/|stream-token/.test(r.url())) writes.push(r.url()); });
      const dlg = await openAddToOrder(p);
      const tabs = await dlg.getByRole('tab').allTextContents();
      const res = {};
      for (let i = 0; i < tabs.length; i++) {
        await dlg.getByRole('tab').nth(i).click();
        await p.waitForTimeout(400);
        res[tabs[i]] = await dlg.locator('input[type="search"]').first().evaluate((input) => {
          const box = input.parentElement; const row = box.parentElement; const r = box.getBoundingClientRect();
          const others = [...row.children].filter((c) => c !== box);
          const reserved = others.reduce((s, c) => s + c.getBoundingClientRect().width, 0) + 8 * others.length;
          return { box: Math.round(r.width), row: Math.round(row.getBoundingClientRect().width), rowDisplay: getComputedStyle(row).display, others: others.length, fillsRest: Math.round(r.width + reserved) >= Math.round(row.getBoundingClientRect().width) - 2,
            ownRow: others.every((c) => { const cr = c.getBoundingClientRect(); return cr.top >= r.bottom - 1 || cr.bottom <= r.top + 1; }) };
        });
      }
      const file = await shoot(p, `app-picker@${w}`);
      await ctx.close();
      const pass = Object.values(res).every((r) => (r.rowDisplay === 'block' ? near(r.box, r.row) : w <= 760 ? r.ownRow && near(r.box, r.row) : r.fillsRest)) && writes.length === 0;
      return { recipe: { url: '/projects/:active', viewport: w, actions: ['Додати в замовлення', ...tabs] }, measured: { tabs: res, writes }, pass, screenshots: [file] };
    });
  }

  for (const w of [1440, 390]) {
    await scenario(`app-order-modal@${w}`, ['E2-D01', 'E2-D04', 'E2-D05', 'E2-G-OrderModal'], 'app', async () => {
      const { ctx, p } = await open(w, { app: true });
      const writes = []; let answers = []; let hold = null;
      await p.route(/\/api\/v1\/projects\/?$/, async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        writes.push(route.request().postDataJSON());
        const next = answers.shift() ?? { status: 409, detail: 'Тестова відмова' };
        if (next.hold) await new Promise((r) => { hold = r; });
        await route.fulfill({ status: next.status, contentType: 'application/json', body: JSON.stringify({ detail: next.detail }) });
      });
      await p.goto(`${job.ui}/projects`, { waitUntil: 'networkidle' });
      await p.getByRole('button', { name: 'Нове замовлення' }).click();
      const dlg = p.getByRole('dialog'); await dlg.waitFor();
      const geo = await dlg.evaluate((el) => ({ width: el.getBoundingClientRect().width, layoutW: document.documentElement.clientWidth, workshop: el.classList.contains('workshop'), submitInBody: !!el.children[1]?.querySelector('button[type="submit"]') }));
      const name = dlg.locator('#order-name');
      await name.press('Enter'); await p.waitForTimeout(300);
      const emptyWrites = writes.length;
      answers = [{ status: 409, detail: 'Замовлення змінилось' }, { status: 422, detail: 'Назва задовга' }, { status: 403, detail: 'Немає права' }];
      await name.fill('Тестове замовлення E2');
      const refusals = [];
      for (const text of ['Замовлення змінилось', 'Назва задовга', 'Немає права']) {
        await name.press('Enter');
        await p.getByText(text).first().waitFor({ timeout: 5000 });
        refusals.push({ text, open: await p.getByRole('dialog').count(), kept: await name.inputValue(), writes: writes.length });
      }
      answers = [{ status: 409, detail: 'Після очікування', hold: true }];
      const before = writes.length;
      const submit = dlg.locator('button[type="submit"]');
      await submit.click(); await p.waitForTimeout(200);
      const locked = { submit: await submit.isDisabled(), x: await dlg.getByRole('button', { name: 'Закрити' }).isDisabled(), field: await name.isDisabled() };
      await submit.click({ force: true, timeout: 500 }).catch(() => {});
      await p.keyboard.press('Enter');
      const duringPending = writes.length - before;
      if (hold) hold();
      await p.getByText('Після очікування').first().waitFor({ timeout: 5000 });
      await p.keyboard.press('Escape');
      await p.waitForFunction(() => !document.querySelector('[role="dialog"]'));
      const focusBack = await p.evaluate(() => document.activeElement?.textContent?.trim());
      const e = await env(p);
      await ctx.close();
      const m = { ...geo, emptyWrites, refusals, locked, duringPending, focusBack, payloadKeys: Object.keys(writes[0] || {}) };
      const pass = near(geo.width, Math.min(1000, 0.94 * w, geo.layoutW - 32)) && geo.workshop && !geo.submitInBody && emptyWrites === 0
        && refusals.every((r, i) => r.open === 1 && r.kept === 'Тестове замовлення E2' && r.writes === i + 1) && locked.submit && locked.x && duringPending === 1;
      return { recipe: { url: `${job.ui}/projects`, viewport: w, intercept: 'POST /api/v1/projects/ (never reaches the server)' }, env: e, measured: m, pass };
    });
  }

  for (const [key, route] of [['orders', '/projects?tab=all'], ['customer', `/customers/${job.customer}?tab=all`]]) {
    for (const w of [1440, 390]) {
      await scenario(`app-table-panel-${key}@${w}`, ['E2-E01', 'E2-E02', 'E2-E03'], 'app', async () => {
        const { ctx, p } = await open(w, { app: true, storage: { 'projects.view': 'table', 'bamdude-customer-orders-view': 'table' } });
        await p.goto(job.ui + route, { waitUntil: 'networkidle' });
        const region = p.getByRole('region', { name: 'Замовлення' }).first();
        await region.waitFor();
        const m = await region.evaluate((el) => {
          const panel = el.parentElement; const cs = getComputedStyle(panel); const bar = panel.querySelector('[data-pagination]');
          return { bg: cs.backgroundColor, border: cs.borderTopStyle, radius: cs.borderTopLeftRadius, shadow: cs.boxShadow !== 'none', region: [el.clientWidth, el.scrollWidth],
            barInPanelOutsideScroll: !!bar && !el.contains(bar) && panel.contains(bar), barPad: bar ? getComputedStyle(bar).padding : null,
            doc: [document.documentElement.clientWidth, document.documentElement.scrollWidth] };
        });
        await region.focus();
        await p.keyboard.press('ArrowRight'); await p.waitForTimeout(500);
        m.keyboardScroll = await region.evaluate((el) => el.scrollLeft);
        m.pageScrollX = await p.evaluate(() => window.scrollX);
        const e = await env(p);
        const file = await shoot(p, `app-table-${key}@${w}`);
        await ctx.close();
        const scrolls = m.region[1] > m.region[0];
        const pass = m.radius === '12px' && m.shadow && m.barInPanelOutsideScroll && m.barPad === '12px 56px 12px 16px' && m.doc[1] <= m.doc[0] && m.pageScrollX === 0 && (!scrolls || m.keyboardScroll > 0);
        return { recipe: { url: job.ui + route, viewport: w, storage: { view: 'table' }, actions: ['focus region', 'ArrowRight'] }, env: e, measured: m, pass, screenshots: [file] };
      });
    }
  }

  await scenario('app-pager-states', ['E2-E04', 'E2-E05'], 'app', async () => {
    const { ctx, p } = await open(1440, { app: true, storage: { 'projects.view': 'table', 'projects.perPage': '12' } });
    const seen = listRequests(p, ORDERS);
    await p.goto(`${job.ui}/projects?tab=all`, { waitUntil: 'networkidle' });
    const bar = () => p.locator('[data-pagination]').first();
    const state = async () => bar().evaluate((el) => ({ text: el.textContent, buttons: [...el.querySelectorAll('button')].map((b) => b.disabled), url: location.search }));
    const s = {};
    s.first = await state();
    await bar().locator('button').nth(2).click(); await p.waitForLoadState('networkidle'); await p.waitForTimeout(300);
    s.middle = await state();
    await bar().locator('button').nth(3).click(); await p.waitForLoadState('networkidle'); await p.waitForTimeout(300);
    s.last = await state();
    await bar().locator('select').selectOption('-1'); await p.waitForLoadState('networkidle'); await p.waitForTimeout(300);
    s.all = { ...(await state()), request: seen[seen.length - 1] };
    await bar().locator('select').selectOption('24'); await p.waitForLoadState('networkidle'); await p.waitForTimeout(300);
    s.back24 = { ...(await state()), request: seen[seen.length - 1] };
    // a slow answer keeps the previous rows on screen, marked busy — never read as the new result
    await p.route(ORDERS, async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.continue(); });
    await p.locator('[role="tab"]').first().click();
    await p.waitForTimeout(400);
    s.slow = await p.evaluate(() => ({ busy: document.querySelector('[data-testid="list-body"]')?.getAttribute('aria-busy'), tabsBusy: document.querySelector('[role="tablist"]')?.getAttribute('aria-busy') }));
    await p.unroute(ORDERS);
    await p.waitForLoadState('networkidle');
    // nothing matches → no page bar, the empty state stays
    await p.locator('input[type="search"]').fill('zzzz-немає-такого');
    await p.waitForTimeout(900); await p.waitForLoadState('networkidle');
    s.total0 = { bars: await p.locator('[data-pagination]').count(), empty: await p.getByText('Нічого не збігається', { exact: false }).count() };
    const e = await env(p);
    await ctx.close();
    const pass = s.first.buttons[0] && s.first.buttons[1] && !s.first.buttons[2] && !s.first.buttons[3]
      && s.middle.buttons.every((d) => !d) && s.middle.url.includes('page=2')
      && !s.last.buttons[0] && s.last.buttons[2] && s.last.buttons[3]
      && s.all.buttons.length === 0 && /all=true/.test(s.all.request) && !/per_page=-1/.test(s.all.request)
      && s.back24.buttons.length === 4 && !s.back24.url.includes('page=') && /per_page=24/.test(s.back24.request)
      && s.slow.busy === 'true' && s.total0.bars === 0 && s.total0.empty > 0;
    return { recipe: { url: '/projects?tab=all', viewport: 1440, storage: { perPage: 12 }, actions: ['next', 'last', 'Усі', '24', 'slow tab switch (1.5 s)', 'search with no match'] }, env: e, measured: s, pass };
  });

  for (const w of [390, 1440]) {
    await scenario(`app-pager-fit@${w}`, ['E2-E06', 'E2-F03'], 'app', async () => {
      const out = {};
      for (const [key, route, storage] of [['orders', '/projects?tab=all', { 'projects.view': 'table', 'projects.perPage': '12' }], ['archives', '/archives', {}]]) {
        const { ctx, p } = await open(w, { app: true, storage });
        await p.goto(job.ui + route, { waitUntil: 'networkidle' });
        const bar = p.locator('[data-pagination]').first();
        await bar.scrollIntoViewIfNeeded();
        out[key] = await bar.evaluate((el) => {
          const r = el.getBoundingClientRect(); const controls = [...el.querySelectorAll('button, select')];
          const hit = controls.map((b) => { const br = b.getBoundingClientRect(); const top = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2); return !!top && (b === top || b.contains(top)); });
          return { bar: [el.clientWidth, el.scrollWidth], clipped: controls.filter((b) => b.getBoundingClientRect().right > r.right + 0.5).length, allHit: hit.every(Boolean), controls: controls.length, pad: getComputedStyle(el).padding };
        });
        out[key].file = await shoot(p, `app-pager-${key}@${w}`);
        await ctx.close();
      }
      const pass = Object.values(out).every((o) => o.bar[1] <= o.bar[0] && o.clipped === 0 && o.allHit);
      return { recipe: { routes: ['/projects?tab=all (table, 12)', '/archives'], viewport: w }, measured: out, pass, screenshots: Object.values(out).map((o) => o.file) };
    });
  }

  await scenario('app-allowall-both-modes', ['E2-E04'], 'app', async () => {
    const { ctx, p } = await open(1440, { app: true, storage: { 'projects.view': 'table' } });
    const seen = listRequests(p, /\/api\/v1\/products\/parts/);
    await p.goto(`${job.ui}/projects?tab=all`, { waitUntil: 'networkidle' });
    const listOptions = await p.locator('[data-pagination] select').first().locator('option').allTextContents();
    const dlg = await openAddToOrder(p);
    await dlg.getByRole('tab', { name: 'Деталі з виробу' }).click();
    await p.waitForTimeout(600);
    const pickerOptions = await dlg.locator('[data-pagination] select').first().locator('option').allTextContents();
    await ctx.close();
    const m = { listOptions, pickerOptions, partsRequests: seen };
    const pass = listOptions.includes('Усі') && !pickerOptions.includes('Усі') && seen.length > 0 && seen.every((u) => !/all=true|per_page=-1/.test(u));
    return { recipe: { routes: ['/projects?tab=all', 'Додати в замовлення › Деталі з виробу'], viewport: 1440 }, measured: m, pass };
  });

  await scenario('app-card-menu-dialogs', ['E2-F01', 'E2-F02', 'E2-F03'], 'app', async () => {
    const { ctx, p } = await open(1440, { app: true, storage: { 'projects.view': 'cards' } });
    const writes = []; p.on('request', (r) => { if (['DELETE', 'PATCH', 'POST'].includes(r.method()) && /\/projects\//.test(r.url())) writes.push(`${r.method()} ${r.url()}`); });
    await p.goto(`${job.ui}/projects`, { waitUntil: 'networkidle' });
    const triggers = p.locator('main button[aria-haspopup="menu"], #root button[aria-haspopup="menu"]');
    const last = triggers.nth((await triggers.count()) - 1);
    await p.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await last.click();
    await p.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem');
    const geo = await p.evaluate(() => { const items = [...document.querySelectorAll('[role="menuitem"]')]; const l = items[items.length - 1].getBoundingClientRect(); const m = document.querySelector('[role="menu"]').getBoundingClientRect(); return { items: items.map((i) => i.textContent), lastInView: l.bottom <= innerHeight && l.top >= 0, menuInView: m.top >= 0 && m.bottom <= innerHeight }; });
    await p.getByRole('menuitem', { name: /Редагувати/ }).click();
    await p.getByRole('dialog').waitFor();
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    const focusAfterEdit = await p.evaluate(() => document.activeElement?.getAttribute('aria-haspopup'));
    await last.click();
    await p.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem');
    await p.getByRole('menuitem', { name: /Видалити/ }).click();
    await p.getByRole('dialog').waitFor();
    const confirm = await p.getByRole('dialog').textContent();
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    const focusAfterConfirm = await p.evaluate(() => document.activeElement?.getAttribute('aria-haspopup'));
    await ctx.close();
    const m = { ...geo, focusAfterEdit, confirmOpened: !!confirm, focusAfterConfirm, writes };
    return { recipe: { url: '/projects (cards)', viewport: 1440, actions: ['last card menu', 'Редагувати, Escape', 'Видалити (ConfirmModal), Escape'] }, measured: m,
      pass: geo.lastInView && geo.menuInView && focusAfterEdit === 'menu' && !!confirm && focusAfterConfirm === 'menu' && writes.length === 0 };
  });

  await scenario('app-third-party', ['E2-F03'], 'app', async () => {
    const out = {};
    {
      const { ctx, p } = await open(1440, { app: true });
      await p.goto(`${job.ui}/`, { waitUntil: 'networkidle' }); // the printers page is the index route
      const trigger = p.locator('[data-testid^="printer-menu-"]').first();
      await trigger.waitFor({ timeout: 10000 }).catch(() => {});
      if (await trigger.count()) {
        await trigger.click();
        await p.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem', null, { timeout: 5000 });
        const inView = await p.evaluate(() => { const m = document.querySelector('[role="menu"]').getBoundingClientRect(); return m.top >= 0 && m.bottom <= innerHeight && m.right <= innerWidth; });
        await p.keyboard.press('Escape');
        out.printersMenu = { inView, focusBack: await p.evaluate(() => document.activeElement?.getAttribute('aria-haspopup')) };
      } else out.printersMenu = { missing: 'no printer card menu on the stand' };
      await ctx.close();
    }
    {
      const { ctx, p } = await open(1440, { app: true });
      await p.goto(`${job.ui}/queue`, { waitUntil: 'networkidle' });
      const opener = p.locator('button[title="Завантажити з бібліотеки"]').first();
      if (await opener.count()) {
        await opener.click();
        await p.getByRole('dialog').waitFor();
        const d = await p.getByRole('dialog').evaluate((el) => ({ workshop: el.classList.contains('workshop'), width: Math.round(el.getBoundingClientRect().width) }));
        await p.keyboard.press('Escape');
        await p.waitForFunction(() => !document.querySelector('[role="dialog"]'));
        out.libraryPicker = { ...d, focusBack: await p.evaluate(() => document.activeElement?.getAttribute('title')) };
      } else out.libraryPicker = { missing: 'no auto-queue picker button on the stand' };
      await ctx.close();
    }
    const pm = out.printersMenu, lp = out.libraryPicker;
    // A surface the stand does not show is PENDING (spec H2), never a pass.
    const pending = [pm.missing && 'printers card menu', lp.missing && 'LibraryPickerModal'].filter(Boolean);
    const pass = pending.length ? null : pm.inView && pm.focusBack === 'menu' && !lp.workshop && lp.focusBack === 'Завантажити з бібліотеки';
    return { recipe: { routes: ['/ (printers, card menu)', '/queue (LibraryPickerModal)'], viewport: 1440 }, measured: out, pending, pass };
  });

  for (const [name, storage, settings] of [['light', { 'theme-mode': 'light' }, null], ['oled', { 'theme-mode': 'dark' }, { dark_background: 'oled' }]]) {
    for (const w of [1440, 390]) {
      await scenario(`app-theme-${name}@${w}`, ['E2-B01'], 'app', async () => {
        const { ctx, p } = await open(w, { app: true, storage: { ...storage, 'projects.view': 'table' }, settings });
        const files = [];
        const out = {};
        for (const [key, route] of [['orders', '/projects?tab=all'], ['stock', '/stock']]) {
          await p.goto(job.ui + route, { waitUntil: 'networkidle' });
          await p.waitForTimeout(500);
          out[key] = { ...(await env(p)), panelBg: await p.evaluate(() => { const c = document.querySelector('.card-shadow'); return c ? getComputedStyle(c).backgroundColor : null; }) };
          files.push(await shoot(p, `app-theme-${name}-${key}@${w}`));
        }
        await ctx.close();
        const ok = (t) => (name === 'light' ? !t.includes('dark') : t.includes('dark') && t.includes('bg-oled'));
        return { recipe: { routes: ['/projects?tab=all', '/stock'], viewport: w, storage, settingsOverride: settings ? 'GET /api/v1/settings/ → dark_background=oled (no write)' : null },
          measured: out, pass: Object.values(out).every((o) => ok(o.theme)), screenshots: files };
      });
    }
  }

  await page.request.post(`${base}/done`, { data: { count: summary.length } });
  return { records: summary.length, failed: summary.filter((s) => s.startsWith('FAIL')) };
}
