// WS-13 capture runner (spec F1–F5), run by Playwright MCP's browser_run_code_unsafe:
//   filename: scripts/workshop_stand/capture.js — while `capture_serve.py` listens on 127.0.0.1:8199.
// It never sees a credential in its own text: the job (shots, the app token) comes from
// the loopback job server, and every result goes back to it, which writes the manifest.
async (page) => {
  const base = 'http://127.0.0.1:8199'; // capture_serve.py
  const job = await (await page.request.get(`${base}/job.json`)).json();
  const browser = page.context().browser();
  const done = [];

  const measure = () => {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const all = sel => [...document.querySelectorAll(sel)].filter(visible);
    const box = el => { const r = el.getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x)}; };
    const dialog = all('[role="dialog"], dialog[open]').pop() || null;
    const root = dialog || document;
    const table = [...root.querySelectorAll('table')].filter(visible)[0] || null;
    const heads = table ? [...table.querySelectorAll('thead th')].filter(visible) : [];
    const firstRow = table ? [...table.querySelectorAll('tbody tr')].filter(visible)[0] : null;
    const tabs = [...root.querySelectorAll('[role="tab"], .detailtabs > button, .w-picker-tabs > button')].filter(visible);
    // The page's layout grid: the widest element that lays out two or more tracks side by side.
    let layout = null;
    for (const el of all('main *, #app *')) {
      const cs = getComputedStyle(el);
      if (cs.display !== 'grid') continue;
      const tracks = cs.gridTemplateColumns.split(' ').filter(t => t && t !== 'none');
      if (tracks.length < 2) continue;
      const w = el.getBoundingClientRect().width;
      if (w < innerWidth * 0.5) continue;
      const kids = [...el.children].filter(visible).map(k => box(k).w);
      if (!layout || w > layout.width) layout = {width: Math.round(w), tracks: tracks.map(t => Math.round(parseFloat(t))), children: kids.slice(0, 6)};
    }
    // The detail layouts by name (spec §3 geometry): main/side, left/right, sidebar/results.
    const named = {};
    for (const sel of ['.m-widegrid', '.w-product-layout', '.w-customer-layout', '.w-catalog-layout', '.m-stockgrid']) {
      const el = all(sel)[0];
      if (el) named[sel] = [...el.children].filter(visible).map(k => box(k).w);
    }
    const tiles = all('.detailstats > div, .stats > .stat, [data-testid="order-figures"] > div');
    const cards = all('.cards > *, .m-pcards > *, [data-testid$="-card"]');
    const cardRow = cards.length ? cards.filter(c => Math.abs(c.getBoundingClientRect().y - cards[0].getBoundingClientRect().y) < 4).length : 0;
    return {
      viewport: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      tableHeaders: heads.map(h => h.textContent.trim().replace(/\s+/g, ' ')).slice(0, 20),
      rowHeight: firstRow ? Math.round(firstRow.getBoundingClientRect().height) : null,
      tabs: tabs.map(t => t.textContent.trim().replace(/\s+/g, ' ')).slice(0, 12),
      layout,
      columns: Object.keys(named).length ? named : null,
      tiles: tiles.length || null,
      cardsFirstRow: cardRow || null,
      cardWidth: cards[0] ? box(cards[0]).w : null,
      dialog: dialog ? {...box(dialog), fields: dialog.querySelectorAll('input, select, textarea').length,
        buttons: [...dialog.querySelectorAll('button')].filter(visible).map(b => b.textContent.trim()).filter(Boolean).slice(-4)} : null,
      title: (document.querySelector('h1') || {}).textContent || null,
    };
  };

  for (const shot of job.shots) {
    const ctx = await browser.newContext({
      viewport: {width: shot.width, height: shot.height}, deviceScaleFactor: 1, locale: 'uk-UA', timezoneId: 'Europe/Kyiv',
    });
    const result = {id: shot.id, side: shot.side, width: shot.width, file: shot.file, steps: []};
    try {
      await ctx.addInitScript(({side, storage, token}) => {
        if (sessionStorage.getItem('ws13-init')) return;
        sessionStorage.setItem('ws13-init', '1');
        localStorage.clear();
        for (const [k, v] of Object.entries(storage || {})) localStorage.setItem(k, v);
        if (side === 'app' && token) localStorage.setItem('auth_token', token);
      }, {side: shot.side, storage: shot.storage, token: shot.side === 'app' ? job.token : null});
      const p = await ctx.newPage();
      await p.goto(shot.url, {waitUntil: 'networkidle', timeout: 60000});
      await p.evaluate(() => document.fonts.ready);
      await p.waitForTimeout(600);
      for (const action of shot.actions || []) {
        const step = {action, ok: false};
        try {
          if (action.click) await p.locator(action.click).first().click({timeout: 5000});
          else if (action.check) await p.locator(action.check).first().check({timeout: 5000});
          else if (action.click_text) await p.getByText(action.click_text, {exact: false}).first().click({timeout: 5000});
          else if (action.click_button) await p.getByRole('button', {name: new RegExp(action.click_button, 'i')}).first().click({timeout: 5000});
          else if (action.click_label) await p.getByRole('button', {name: new RegExp(action.click_label, 'i')}).first().click({timeout: 5000});
          else if (action.check_label) await p.getByLabel(new RegExp(action.check_label, 'i')).first().check({timeout: 5000});
          else if (action.click_role_tab) await p.getByRole('tab', {name: new RegExp(action.click_role_tab, 'i')}).first().click({timeout: 5000});
          else if (action.click_testid) await p.getByTestId(action.click_testid).first().click({timeout: 5000});
          // The mockup's own action handler, called as its menu item would call it.
          else if (action.eval) await p.evaluate(action.eval);
          step.ok = true;
          await p.waitForLoadState('networkidle', {timeout: 15000}).catch(() => {});
          await p.waitForTimeout(500);
        } catch (e) {
          step.error = String(e.message || e).split('\n')[0].slice(0, 200);
        }
        result.steps.push(step);
      }
      result.measures = await p.evaluate(measure);
      result.dpr = await p.evaluate(() => window.devicePixelRatio);
      await p.screenshot({path: shot.file, fullPage: true});
      result.ok = result.steps.every(s => s.ok);
    } catch (e) {
      result.ok = false;
      result.error = String(e.message || e).split('\n')[0].slice(0, 300);
    } finally {
      await ctx.close();
    }
    await page.request.post(`${base}/result`, {data: result});
    done.push(`${result.ok ? 'ok ' : 'FAIL'} ${shot.side} ${shot.id} @${shot.width}`);
  }
  await page.request.post(`${base}/done`, {data: {count: done.length}});
  return {shots: done.length, failed: done.filter(d => d.startsWith('FAIL'))};
}
