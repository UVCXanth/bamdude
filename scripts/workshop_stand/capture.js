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
      clientWidth: document.documentElement.clientWidth,
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
      // The section headings this frame shows — what a frame is evidence OF.
      headings: [...document.querySelectorAll('h1, h2, h3')].filter(h => {
        const r = h.getBoundingClientRect();
        return r.height > 0 && r.bottom > 0 && r.top < innerHeight;
      }).map(h => h.textContent.trim().replace(/\s+/g, ' ')).slice(0, 20),
    };
  };

  // A filter rewrite: walk `keys` (`*` = every item of an array) and keep, in the array
  // at the end, the items whose `field` matches `pattern`.
  const filterAt = (node, keys, field, pattern) => {
    if (node == null || typeof node !== 'object') return;
    const [key, ...rest] = keys;
    if (key === '*') {
      if (Array.isArray(node)) node.forEach(child => filterAt(child, rest, field, pattern));
      return;
    }
    if (rest.length) return filterAt(node[key], rest, field, pattern);
    if (Array.isArray(node[key])) node[key] = node[key].filter(item => pattern.test(String(item && item[field])));
  };

  for (const shot of job.shots) {
    // WS-13 E4 F6: the pair's explicit GET fixtures (validated by capture_serve). Each is
    // recorded with how many responses it rewrote — one that never applied fails the shot.
    // ⚠️ A request the app's service worker answers never reaches `page.route`, so a shot
    // with a fixture blocks the worker (measured: every rewrite applied 0 times without).
    const rewrites = shot.rewrites || [];
    const ctx = await browser.newContext({
      viewport: {width: shot.width, height: shot.height}, deviceScaleFactor: 1, locale: 'uk-UA', timezoneId: 'Europe/Kyiv',
      ...(rewrites.length ? {serviceWorkers: 'block'} : {}),
    });
    const result = {id: shot.id, side: shot.side, width: shot.width, file: shot.file, steps: []};
    if (rewrites.length) result.fixture = rewrites.map(r => ({...r, applied: 0}));
    let p = null;
    try {
      await ctx.addInitScript(({side, storage, token}) => {
        if (sessionStorage.getItem('ws13-init')) return;
        sessionStorage.setItem('ws13-init', '1');
        localStorage.clear();
        for (const [k, v] of Object.entries(storage || {})) localStorage.setItem(k, v);
        if (side === 'app' && token) localStorage.setItem('auth_token', token);
      }, {side: shot.side, storage: shot.storage, token: shot.side === 'app' ? job.token : null});
      p = await ctx.newPage();
      if (rewrites.length) {
        // Only a GET on the exact path is rewritten; everything else goes on untouched.
        await p.route(url => rewrites.some(r => r.path === url.pathname), async route => {
          try {
            const request = route.request();
            const at = rewrites.findIndex(r => r.path === new URL(request.url()).pathname);
            if (request.method() !== 'GET' || at < 0) return await route.fallback();
            const response = await route.fetch();
            if (!response.ok()) return await route.fulfill({response});
            let body = await response.json();
            const rewrite = rewrites[at];
            if (rewrite.merge) body = {...body, ...rewrite.merge};
            if (rewrite.filter) filterAt(body, rewrite.filter.at.split('.'), rewrite.filter.field, new RegExp(rewrite.filter.match));
            await route.fulfill({response, json: body});
            result.fixture[at].applied += 1;
          } catch (e) {
            // A name only: a message may carry a URL, and nothing here should echo one.
            (result.route_errors = result.route_errors || []).push(String((e && e.name) || 'Error'));
            try { await route.abort(); } catch { /* the page is closing */ }
          }
        });
      }
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
      // Spec F1/F5 and review V02: every frame is the FIXED viewport. A full-page shot
      // resizes the viewport, drops the scrollbar and can cross a container breakpoint
      // (the mockup's order page went from one column to two), so the picture would not
      // be the layout that was measured. Lower parts are extra frames at a recorded scroll.
      result.measures = await p.evaluate(measure);
      result.dpr = await p.evaluate(() => window.devicePixelRatio);
      const key = m => JSON.stringify([m.viewport, m.clientWidth, m.columns, m.layout && m.layout.tracks]);
      // A dialog is covered by its OWN scroll body; the page behind it is not the recipe.
      const scroller = await p.evaluateHandle((isDialog) => {
        const scrollable = el => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 4;
        if (isDialog) {
          const dialog = [...document.querySelectorAll('[role="dialog"], dialog[open]')].pop();
          if (!dialog) return document.scrollingElement;
          let best = null;
          for (const el of [dialog, ...dialog.querySelectorAll('*')]) {
            if (scrollable(el) && (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth)) best = el;
          }
          return best || dialog;
        }
        let best = document.scrollingElement;
        for (const el of document.querySelectorAll('main, main *, #app, #root *')) {
          const cs = getComputedStyle(el);
          if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 4) continue;
          if (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth
              || best.scrollHeight <= best.clientHeight + 4) best = el;
        }
        return best;
      }, shot.measure === 'dialog');
      const extent = await scroller.evaluate(el => ({height: el.scrollHeight, view: el.clientHeight}));
      // The plan is the job server's (plan_offsets, tested there): overlapping frames to
      // the very bottom, or an explicit "incomplete" when the safety limit is reached.
      const plan = await (await page.request.post(`${base}/plan`, {data: extent})).json();
      const offsets = plan.offsets;
      result.frames = [];
      result.stable = true;
      const reference = key(result.measures);
      for (const [k, y] of offsets.entries()) {
        const at = await scroller.evaluate((el, top) => { el.scrollTop = top; return el.scrollTop; }, y);
        await p.waitForTimeout(250);
        const before = await p.evaluate(measure);
        const file = k === 0 ? shot.file : shot.file.replace(/\.png$/, `.s${k}.png`);
        await p.screenshot({path: file, fullPage: false});
        const after = await p.evaluate(measure);
        const stable = key(before) === reference && key(after) === reference;
        result.stable = result.stable && stable;
        result.frames.push({file, scrollTop: at, stable, headings: after.headings,
          clientWidth: after.clientWidth, columns: after.columns, tracks: after.layout && after.layout.tracks});
      }
      await scroller.evaluate(el => { el.scrollTop = 0; });
      const lastEnd = offsets[offsets.length - 1] + extent.view;
      result.scroll = {height: extent.height, view: extent.view, frames: offsets.length, container: shot.measure === 'dialog' ? 'dialog' : 'page',
        complete: plan.complete && lastEnd >= extent.height - 4, truncated: !(plan.complete && lastEnd >= extent.height - 4)};
      result.ok = result.steps.every(s => s.ok) && result.stable && result.scroll.complete &&
        (result.fixture || []).every(f => f.applied > 0) && !result.route_errors;
    } catch (e) {
      result.ok = false;
      result.error = String(e.message || e).split('\n')[0].slice(0, 300);
    } finally {
      // A route left on a closing page answers into nothing; take it off first.
      if (p && rewrites.length) { try { await p.unrouteAll({behavior: 'ignoreErrors'}); } catch { /* gone */ } }
      await ctx.close();
    }
    await page.request.post(`${base}/result`, {data: result});
    done.push(`${result.ok ? 'ok ' : 'FAIL'} ${shot.side} ${shot.id} @${shot.width}`);
  }
  await page.request.post(`${base}/done`, {data: {count: done.length}});
  return {shots: done.length, failed: done.filter(d => d.startsWith('FAIL'))};
}
