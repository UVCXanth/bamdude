// The WS-13 reference, dumped (vault 60-specs/workshop-ui-parity-e00-stand.md, B1 / C4 / C6).
//
//   node scripts/workshop_stand/dump_mockup.mjs [out.json]
//
// Reads the FINAL mockup HTML — never the loose sources alone — and runs its
// embedded data block in a vm with an empty localStorage, so the dump is the
// state the reference opens with. Stops (non-zero exit) when:
//   - the HTML is not the audited one (SHA-256 below; changing it is a deliberate
//     edit of this constant and of the spec note, never a warning);
//   - the embedded block differs from mockup/data.js;
//   - the counts differ from the audited ones;
//   - an order's dispatch notes do not add up to what its lines issued, except
//     for the one agreed exception (C6: order 245, notes 90030 and 90031).
// The stage of each order comes from the mockup's own stageOf() (C4).

import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = resolve(REPO, 'temp/proj-ui-work/02-mockup-v2.html');
const DATA_JS = resolve(REPO, 'temp/proj-ui-work/mockup/data.js');
const AUDITED_SHA256 = '6b91bc62b113221ae0430ab56fb6f9e5def2e43564d651b3935cf3a7f4744ecb';
const EXPECTED_COUNTS = {products: 105, orders: 41, customers: 10, fin: 107, docs: 32};
// C6 — the one agreed exception: seedDocs issues order 245 twice.
const AGREED_DUPLICATES = {90031: 90030};
// Found while implementing E0 and NOT yet agreed by the review (spec C5): a completed
// order that issued nothing. The seed applies the proposed replacement, and `status`
// fails until the review moves it into an agreed list.
const PROPOSED_COMPLETIONS = {
  249: 'issue what the order printed, then complete it (one dispatch note the mockup does not have)',
};
export const RECIPE_VERSION = 1;

const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const fail = msg => {
  console.error(`dump_mockup: ${msg}`);
  process.exit(2);
};

const htmlBytes = readFileSync(HTML);
const htmlSha = sha256(htmlBytes);
if (htmlSha !== AUDITED_SHA256) fail(`${HTML} is not the audited reference (sha256 ${htmlSha}).`);

const html = htmlBytes.toString('utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const dataBlocks = blocks.filter(b => b.includes('const STORE_KEY'));
if (dataBlocks.length !== 1) fail(`expected one embedded data block, found ${dataBlocks.length}.`);
const block = dataBlocks[0];
const loose = readFileSync(DATA_JS, 'utf8').replace(/\r\n/g, '\n');
if (block !== loose) fail('the data block embedded in the HTML differs from mockup/data.js.');

const store = {};
const context = vm.createContext({
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  },
  console, Date, Math, JSON, structuredClone,
});
vm.runInContext(block, context, {filename: 'data.js (embedded)'});
const pick = expr => JSON.parse(vm.runInContext(`JSON.stringify(${expr})`, context));

const db = pick('DB');
for (const [key, want] of Object.entries(EXPECTED_COUNTS)) {
  const got = (db[key] || []).length;
  if (got !== want) fail(`${key}: ${got}, expected ${want}.`);
}

const stages = pick('Object.fromEntries(DB.orders.map(o => [o.id, stageOf(o).id]))');
const figures = pick(
  'Object.fromEntries(DB.orders.map(o => { const f = orderFig(o); return [o.id, {printing: f.printing, queued: f.queued, allCovered: f.allCovered}]; }))',
);

// C6 preflight: notes against what the lines issued.
const docUnits = {};
for (const d of db.docs) docUnits[d.orderId] = (docUnits[d.orderId] || 0) + d.items.reduce((a, i) => a + (i.qty || 0), 0);
const duplicateUnits = {};
for (const [dup, canonical] of Object.entries(AGREED_DUPLICATES)) {
  const a = db.docs.find(d => d.id === +dup);
  const b = db.docs.find(d => d.id === +canonical);
  if (!a || !b || a.orderId !== b.orderId || JSON.stringify(a.items) !== JSON.stringify(b.items)) {
    fail(`agreed duplicate ${dup} → ${canonical} no longer matches the reference.`);
  }
  duplicateUnits[a.orderId] = (duplicateUnits[a.orderId] || 0) + a.items.reduce((s, i) => s + i.qty, 0);
}
const conflicts = [];
for (const o of db.orders) {
  const issued = o.lines.reduce((a, l) => a + (l.issued || 0), 0);
  const noted = (docUnits[o.id] || 0) - (duplicateUnits[o.id] || 0);
  if (noted !== issued) conflicts.push({order: o.id, issued, noted});
}
if (conflicts.length) fail(`dispatch notes do not add up to what was issued: ${JSON.stringify(conflicts)}`);

// A completed order with a customer must have issued every unit.
const unagreed = [];
for (const o of db.orders) {
  if (o.status !== 'completed' || !o.customerId) continue;
  const ordered = o.lines.reduce((a, l) => a + (l.mode === 'parts' ? 1 : l.qty), 0);
  const issued = o.lines.reduce((a, l) => a + (l.issued || 0), 0);
  if (issued >= ordered) continue;
  if (!(o.id in PROPOSED_COMPLETIONS)) fail(`completed order ${o.id} issued ${issued} of ${ordered}.`);
  unagreed.push({order: o.id, issued, ordered, proposal: PROPOSED_COMPLETIONS[o.id]});
}

const constants = pick('({TODAY, USERS, FARM, PRINTERS, CATEGORIES, MATERIALS, COLORS, STAGES, CUSTOMER_TYPES, PRIORITIES, FIN_TYPES, PART_REASONS})');
const dump = {
  meta: {
    html: HTML.replace(REPO, '').replace(/\\/g, '/').replace(/^\//, ''),
    html_sha256: htmlSha,
    data_js_sha256: sha256(Buffer.from(loose, 'utf8')),
    recipe_version: RECIPE_VERSION,
    counts: Object.fromEntries(Object.keys(EXPECTED_COUNTS).map(k => [k, db[k].length])),
    agreed_duplicates: AGREED_DUPLICATES,
    unagreed_completions: unagreed,
  },
  constants,
  stages,
  figures,
  db,
};
dump.meta.dump_sha256 = sha256(Buffer.from(JSON.stringify({...dump, meta: {...dump.meta, dump_sha256: undefined}}), 'utf8'));

const out = resolve(process.argv[2] || resolve(REPO, 'temp/ws13-stand/mockup-db.json'));
mkdirSync(dirname(out), {recursive: true});
writeFileSync(out, JSON.stringify(dump, null, 1), 'utf8');
console.log(JSON.stringify({out, ...dump.meta}));
