// Import da Tricount: ogni spesa comune diventa una spesa con la sola tua parte,
// alla sua data e nella sua voce. Le spese che hai pagato tu vengono ridotte alla tua parte,
// quelle pagate dall'altra persona vengono aggiunte. La vecchia voce riassuntiva ("Spesa con L") sparisce.
import { route, go } from './app.js';
import { S, put, putMany, delMany, setSetting } from './store.js';
import { catsOfType, catOf } from './model.js';
import { $, esc, fmtNum, fmtEur, fmtDate, daysBetween, uid, norm, plural, parseAmount, centsToInput } from './util.js';
import { toast, sheet, confirmDialog, pickCategory, ICONS } from './ui.js';

/* ---------- Lettura del CSV ---------- */

export function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const count = (ch) => first.split(ch).length - 1;
  const delim = count('\t') > count(',') && count('\t') > count(';') ? '\t' : count(';') > count(',') ? ';' : ',';
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const COLS = {
  date: ['date', 'data', 'date & time', 'data e ora', 'date and time'],
  desc: ['description', 'descrizione', 'title', 'titolo', 'what', 'cosa'],
  cat: ['category', 'categoria'],
  by: ['paid_by', 'paid by', 'pagato da', 'payer', 'who paid'],
  total: ['total', 'totale', 'amount', 'importo', 'amount in default currency', 'importo nella valuta predefinita'],
  kind: ['transaction type', 'type', 'tipo', 'tipo di transazione'],
};

function toIsoDate(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// Ritorna { rows, shareCols, me } oppure lancia un errore comprensibile
export function readTricount(text, meCol = null) {
  const aoa = parseCsv(text);
  if (aoa.length < 2) throw new Error('Il file è vuoto.');
  const head = aoa[0].map((h) => norm(h));
  const idx = {};
  for (const [k, names] of Object.entries(COLS)) idx[k] = head.findIndex((h) => names.includes(h));
  for (const k of ['date', 'desc', 'by', 'total']) {
    if (idx[k] < 0) throw new Error('Non sembra un export di Tricount: mancano le colonne data, descrizione, pagato da o totale.');
  }
  const known = new Set(Object.values(idx).filter((i) => i >= 0));
  const body = aoa.slice(1);
  const numeric = (i) => body.every((r) => !String(r[i] ?? '').trim() || parseAmount(r[i]) != null);
  const payers = [...new Set(body.map((r) => String(r[idx.by] ?? '').trim()).filter(Boolean))];
  // colonne con le quote di ciascuno: numeriche e non già riconosciute
  let shareCols = aoa[0].map((h, i) => ({ i, name: h.trim() })).filter((c) => !known.has(c.i) && numeric(c.i));
  const withPayer = shareCols.filter((c) => payers.some((p) => { const a = norm(c.name), b = norm(p); return a === b || a.endsWith(' ' + b) || a.startsWith(b + ' '); }));
  if (withPayer.length) shareCols = withPayer;
  if (!shareCols.length) throw new Error('Non trovo la colonna con la tua parte di ogni spesa.');
  const me = shareCols.find((c) => c.name === meCol) || shareCols[0];
  const meCode = payers.find((p) => { const a = norm(me.name), b = norm(p); return a === b || a.endsWith(' ' + b) || a.startsWith(b + ' '); }) ?? me.name;

  const seen = new Map();
  const rows = [];
  body.forEach((r, n) => {
    if (idx.kind >= 0 && /transfer|trasferiment|rimbors|balance|pareggi/i.test(r[idx.kind] || '')) return;
    const date = toIsoDate(r[idx.date]);
    const total = Math.abs(parseAmount(r[idx.total]) ?? 0);
    if (!date || !total) return;
    const desc = String(r[idx.desc] ?? '').trim() || 'Spesa comune';
    const by = String(r[idx.by] ?? '').trim();
    const share = Math.abs(parseAmount(r[me.i]) ?? 0);
    const base = `${date}|${norm(desc)}|${total}|${norm(by)}`;
    const k = (seen.get(base) || 0) + 1;
    seen.set(base, k);
    rows.push({
      n, date, desc, by, total, share: Math.min(share, total),
      tcat: idx.cat >= 0 ? String(r[idx.cat] ?? '').trim().toUpperCase() : '',
      mine: norm(by) === norm(meCode),
      key: k > 1 ? `${base}#${k}` : base,
    });
  });
  if (!rows.length) throw new Error('Nel file non ci sono spese.');
  return { rows, shareCols: shareCols.map((c) => c.name), me: me.name, payers, meCode };
}

/* ---------- Voci ---------- */

// [espressione sulla descrizione, nomi possibili della voce, crea la voce se manca?]
const KEYWORDS = [
  [/bollett/, ['Bollette']],
  [/tennis|padel|palestra|piscina/, ['Attività fisica']],
  [/tagliando|meccanico|gommist|revisione/, ['Macchina']],
  [/benzina|carburante|gasolio|diesel/, ['Benzina', 'Carburante']],
  [/parcheggi/, ['Parcheggio']],
  [/gatt|crocch|lettiera|tolettatura|arca planet|albero|uccellini|erbetta|\bpure\b|veterinari/, ['Gatti'], '🐈'],
  [/regal|fiori|sushi papa/, ['Regali']],
  [/farmacia|farmac|diclofenac|ibuprofen|tachipirina|medicin/, ['Salute']],
  [/pizz|buns|ramen|kuai|kwai|cena|pranzo|colazione|gelato|mcdonald|old wild|veggie sushi|aperitiv|ristorante|osteria|trattoria|kebab|burger/, ['Mangiar fuori', 'Ristoranti e bar']],
  [/play\b|cinema|kart|formage|structure deck|giochi|sleeve|boruto|teatro|concerto|museo|manga/, ['Svago']],
  [/schermo|computer|\bpc\b|mouse|tastiera/, ['PC']],
  [/contanti|prelievo/, ['Altro']],
  [/spesa|supermerc|eurospin|martinelli|lidl|esselunga|famila|rossetto|sama frutta|adigeo|\bmd\b|detersiv|dentifricio|spazzolin|\bvino\b/, ['Alimentari', 'Spesa alimentare']],
];
const BY_TCAT = {
  GROCERIES: ['Alimentari', 'Spesa alimentare'],
  FOOD_AND_DRINK: ['Mangiar fuori', 'Ristoranti e bar'],
  RENT_AND_UTILITIES: ['Bollette'],
  HEALTHCARE: ['Salute'],
  TRANSPORT: ['Trasporti'],
  ENTERTAINMENT: ['Svago'],
  SHOPPING: ['Altro'],
  OTHER: ['Casa', 'Casa e affitto'],
  UNCATEGORIZED: ['Altro'],
};

const findCat = (names) => {
  for (const n of names) {
    const c = catsOfType('expense').find((x) => norm(x.name) === norm(n));
    if (c) return c.id;
  }
  return null;
};

function mapCategory(row, replacedId) {
  const learned = S.settings.tricountRules?.[norm(row.desc)];
  if (learned && S.cat.has(learned) && learned !== replacedId) return learned;
  const d = norm(row.desc);
  if (row.tcat === 'RENT_AND_UTILITIES') return findCat(['Bollette']) || 'new:Bollette:💡';
  for (const [re, names, icon] of KEYWORDS) {
    if (!re.test(d)) continue;
    const id = findCat(names);
    if (id) return id;
    if (icon) return `new:${names[0]}:${icon}`;
  }
  return findCat(BY_TCAT[row.tcat] || []) || findCat(['Altro']) || 'new:Altro:📦';
}

const catInfo = (id) => {
  if (id?.startsWith('new:')) { const [, name, icon] = id.split(':'); return { name, icon, isNew: true }; }
  const c = S.cat.get(id);
  return c ? { name: c.name, icon: c.icon || '📦' } : { name: 'Scegli la voce', icon: '❔' };
};

/* ---------- Abbinamento con i movimenti già presenti ---------- */

const STOP = new Set(['spesa', 'spese', 'soldi', 'della', 'delle', 'dello', 'degli', 'alex', 'con', 'per', 'post']);
const words = (s) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));
const txText = (t) => norm([t.note, t.bank, t.raw?.keyword, t.raw?.extra].filter(Boolean).join(' '));
const overlap = (desc, t) => { const tx = txText(t); return words(desc).some((w) => tx.includes(w)); };

function matchScore(it, t, replacedId) {
  const dd = Math.abs(daysBetween(t.date, it.date));
  if (dd > 14) return 0;
  const inRep = t.categoryId === replacedId;
  if (!it.mine && inRep) return 0; // nella vecchia voce ci sono i bonifici: mai abbinarli alle spese pagate dall'altra persona
  if (it.mine && t.amount === it.total) return 100 - dd + (inRep ? 5 : 0);
  if (it.share > 0 && Math.abs(t.amount - it.share) <= 2 && dd <= 7 && !inRep && t.categoryId === it.mapCat) return 80 - dd;
  // stessa spesa registrata a mano anche da te (non un pagamento della banca: quello è uscito davvero dal tuo conto)
  if (it.share > 0 && (Math.abs(t.amount - it.share) <= 2 || t.amount === it.total) && dd <= 10 && !inRep && overlap(it.desc, t) && (it.mine || !t.importKey)) return 70 - dd;
  return 0;
}

/* ---------- Pagina ---------- */

const head = `<div class="page-head"><a class="icon-btn" href="#/altro" aria-label="Indietro">${ICONS.back}</a><h1>Importa da Tricount</h1></div>`;

route('tricount', (root) => {
  const last = S.settings.tricountLast;
  root.innerHTML = `${head}
    <div id="tc">
      <div class="card stack">
        <p class="ink2">Carica il file CSV con le spese esportate da Tricount. Per ogni spesa comune registro <b>solo la tua parte</b>, alla sua data e nella sua voce: quelle pagate da te le riduco alla tua parte, quelle pagate dall'altra persona le aggiungo.</p>
        <p class="small ink2">I bonifici con cui pareggiate i conti non vanno registrati: la voce che usavi per loro viene sostituita dalle singole spese.</p>
        <label class="btn block" style="position:relative;min-height:54px">${ICONS.upload.replace('<svg', '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"')} Scegli il file CSV<input type="file" id="tcfile" accept=".csv,text/csv,text/plain" style="position:absolute;inset:0;opacity:0"></label>
        <p class="tiny muted">Puoi caricare ogni volta il file completo: le spese già importate le salto.</p>
      </div>
      ${last ? lastCard(last) : ''}
    </div>`;
  $('#tcfile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      review($('#tc'), text, file.name);
    } catch (err) {
      console.error(err);
      $('#tc').innerHTML = `<div class="empty card"><h3>Non riesco a leggere il file</h3><p class="small">${esc(err.message)}</p><a class="btn small" href="#/altro" style="margin-top:14px">Indietro</a></div>`;
    }
  });
  root.querySelector('[data-undo]')?.addEventListener('click', undoLast);
}, { tab: 'altro', live: false });

function lastCard(last) {
  return `<div class="card stack" style="margin-top:14px">
    <h3>Ultimo import</h3>
    <p class="small ink2">${fmtDate(last.at.slice(0, 10))}: ${plural(last.added.length, 'spesa aggiunta', 'spese aggiunte')}, ${plural(last.updated.length, 'movimento ridotto', 'movimenti ridotti')} alla tua parte, ${plural(last.deleted.length, 'movimento tolto', 'movimenti tolti')}.</p>
    <button class="btn line block" data-undo>Annulla l'ultimo import</button>
    <p class="tiny muted">Rimette i movimenti com'erano prima dell'import.</p>
  </div>`;
}

/* ---------- Revisione ---------- */

function review(root, text, fileName) {
  let parsed = readTricount(text, S.settings.tricountMe || null);
  const expCats = catsOfType('expense', { includeArchived: true });
  // voce riassuntiva da sostituire: proposta in automatico se si chiama "... con L", "spese comuni"…
  let replacedId = expCats.find((c) => !c.archived && /\bcon [a-z]$|\bcon [a-z]\b|comun|tricount/.test(norm(c.name)))?.id || '';
  let items = [];
  let extraBon = [];
  const openGroups = new Set(['check']);

  function build() {
    const linked = new Set(S.settings.tricountSeen || []);
    for (const t of S.transactions) if (t.tricount?.key) linked.add(t.tricount.key);
    items = parsed.rows.map((r) => ({ ...r, done: linked.has(r.key) }));
    for (const it of items) {
      it.include = true; it.match = null; it.hint = null; it.catManual = false; it.shareManual = false;
      it.mapCat = mapCategory(it, replacedId);
      it.catId = it.mapCat;
    }
    autoMatch();
  }

  function pool() {
    return S.transactions.filter((t) => t.type === 'expense' && !t.tricount);
  }

  function autoMatch() {
    const pairs = [];
    const P = pool();
    for (const it of items) {
      if (it.done || (!it.mine && it.share === 0)) continue;
      for (const t of P) { const s = matchScore(it, t, replacedId); if (s > 0) pairs.push([s, it, t]); }
    }
    pairs.sort((a, b) => b[0] - a[0]);
    const used = new Set();
    for (const [, it, t] of pairs) {
      if (it.match || used.has(t.id)) continue;
      it.match = t; used.add(t.id);
      if (t.categoryId && t.categoryId !== replacedId) it.catId = t.categoryId;
    }
    // pagata dall'altra persona secondo Tricount, ma in banca risulta un tuo pagamento identico: da controllare
    for (const it of items) {
      it.warn = null;
      if (it.done || it.match || it.mine) continue;
      it.warn = P.find((t) => !used.has(t.id) && t.importKey && t.amount === it.total && Math.abs(daysBetween(t.date, it.date)) <= 2 && overlap(it.desc, t)) || null;
    }
    // per le spese pagate da te e non trovate: un suggerimento (stessa voce, pochi giorni di distanza)
    for (const it of items) {
      if (it.done || it.match || !it.mine || it.share === 0) continue;
      it.hint = P.find((t) => !used.has(t.id) && t.categoryId && t.categoryId !== replacedId && t.categoryId === it.mapCat && Math.abs(daysBetween(t.date, it.date)) <= 3) || null;
    }
    findExtraBonifici(used);
  }

  // altri bonifici del periodo non classificati nella voce da sostituire: potrebbero essere pareggi
  function findExtraBonifici(used) {
    const from = parsed.rows.reduce((m, r) => (r.date < m ? r.date : m), '9999');
    const to = parsed.rows.reduce((m, r) => (r.date > m ? r.date : m), '0000');
    const prev = new Map(extraBon.map((x) => [x.t.id, x.on]));
    extraBon = pool().filter((t) => !used.has(t.id) && !t.categoryId && t.date >= from && daysBetween(to, t.date) <= 20 &&
      /bonific/.test(norm([t.bank, t.raw?.keyword].filter(Boolean).join(' '))))
      .map((t) => ({ t, on: prev.get(t.id) || false }));
  }

  const repTx = () => (replacedId ? S.transactions.filter((t) => t.categoryId === replacedId) : []);
  const matchedIds = () => new Set(items.filter((it) => it.include && it.match && !it.done && it.share > 0).map((it) => it.match.id));
  const group = (it) => {
    if (it.done) return 'done';
    if (it.share === 0) return 'zero';
    if (it.mine && !it.match) return 'check';
    return 'cat:' + it.catId;
  };
  const txLabel = (t) => `${catOf(t)?.name || t.note || (t.bank || '').split(' · ')[0] || 'Movimento'} ${fmtEur(t.amount)} del ${fmtDate(t.date)}`;

  const ROW = (it) => {
    const ci = catInfo(it.catId);
    const who = it.mine ? 'pagata da te' : `pagata da ${esc(it.by)}`;
    let status = '';
    if (it.share === 0) status = it.match ? `Tolgo ${esc(txLabel(it.match))}: la tua parte è 0` : 'Niente da registrare: la tua parte è 0';
    else if (it.match) status = `Sostituisce ${esc(txLabel(it.match))}`;
    else if (it.mine) status = `Non trovata nel bilancio: la aggiungo${it.hint ? `. Forse è ${esc(txLabel(it.hint))}?` : ''}`;
    else if (it.warn) status = `⚠️ In banca risulta pagata da te: ${esc(txLabel(it.warn))}. Se è così, su Tricount è segnata male (e il pareggio ti è costato il doppio).`;
    return `<div class="imp-row ${it.include ? '' : 'off'}" data-n="${it.n}">
      <input type="checkbox" class="ck" data-inc ${it.include ? 'checked' : ''} aria-label="Importa questa spesa">
      <div class="desc"><div class="t1">${esc(it.desc)}</div><div class="t2">${fmtDate(it.date)} · ${who}${it.total !== it.share ? ` · totale ${fmtNum(it.total)}&nbsp;€` : ''}</div></div>
      <div class="amt exp">${it.share ? `−${fmtNum(it.share)} €` : '0 €'}</div>
      ${it.include ? `<div class="ctl">${it.share ? `<button class="cat-btn" data-pick>${esc(ci.icon)} ${esc(ci.name)}${ci.isNew ? ' (nuova)' : ''}</button>` : ''}<button class="cat-btn" data-more>Dettagli</button>
        ${status ? `<span class="tiny ink2" style="width:100%">${status}</span>` : ''}</div>` : ''}
    </div>`;
  };

  function draw() {
    const y = window.scrollY;
    const todo = items.filter((it) => !it.done);
    const done = items.length - todo.length;
    const inc = todo.filter((it) => it.include);
    const sum = inc.reduce((s, it) => s + it.share, 0);
    const minD = parsed.rows.reduce((m, r) => (r.date < m ? r.date : m), '9999');
    const maxD = parsed.rows.reduce((m, r) => (r.date > m ? r.date : m), '0000');
    const rep = repTx();
    const mIds = matchedIds();
    const repDel = rep.filter((t) => !mIds.has(t.id));
    const repOpts = expCats.filter((c) => !c.archived || c.id === replacedId)
      .map((c) => ({ c, n: S.transactions.filter((t) => t.categoryId === c.id).length }))
      .map(({ c, n }) => `<option value="${c.id}" ${c.id === replacedId ? 'selected' : ''}>${esc(c.icon || '')} ${esc(c.name)}${n ? ` (${n})` : ''}</option>`).join('');

    let html = `<div class="card stack">
      <div><h3>${esc(fileName)}</h3><p class="tiny muted">${plural(items.length, 'spesa', 'spese')} dal ${fmtDate(minD)} al ${fmtDate(maxD)}</p></div>
      ${parsed.shareCols.length > 1 ? `<label class="field"><span>La tua parte è nella colonna</span><select class="input" id="me">${parsed.shareCols.map((c) => `<option ${c === parsed.me ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>` : ''}
      <div class="kv"><span>La tua parte da registrare</span><b>${fmtEur(sum)}</b></div>
      ${done ? `<div class="kv"><span>Già importate</span><b>${plural(done, 'spesa', 'spese')}</b></div>` : ''}
      <label class="field"><span>Voce da sostituire</span><select class="input" id="rep"><option value="">Nessuna</option>${repOpts}</select></label>
      ${replacedId ? `<p class="tiny ink2">${repDel.length ? `Tolgo ${plural(repDel.length, 'movimento', 'movimenti')} di questa voce (${fmtEur(repDel.reduce((s, t) => s + t.amount, 0))}): i bonifici di pareggio e le spese comuni registrate per intero. ` : ''}${rep.length - repDel.length ? `${plural(rep.length - repDel.length, 'altro diventa', 'altri diventano')} la tua parte della spesa corrispondente. ` : ''}Poi la voce sparisce dall'elenco.</p>` : ''}
    </div>`;

    const groups = new Map();
    for (const it of items) { const g = group(it); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(it); }
    const sortRows = (l) => l.sort((a, b) => b.date.localeCompare(a.date) || a.n - b.n);
    const block = (g, title, sub, help, list) => `<details class="card group" style="margin-top:14px;padding:0" data-g="${esc(g)}" ${openGroups.has(g) ? 'open' : ''}>
      <summary class="group-head"><h3>${title}</h3><span class="tiny muted">${sub}</span></summary>
      ${help ? `<p class="tiny muted" style="padding:0 14px 8px">${help}</p>` : ''}
      ${g.startsWith('cat:') ? `<div style="padding:0 14px 10px"><button type="button" class="cat-btn" data-gpick="${esc(g)}">Sposta tutte in un'altra voce</button></div>` : ''}
      <div>${sortRows(list).map(ROW).join('')}</div></details>`;

    if (groups.has('check')) {
      const l = groups.get('check');
      html += block('check', `Pagate da te, non trovate (${l.length})`, '',
        'Non le trovo nel bilancio con lo stesso importo: le aggiungo con la tua parte. Se invece ci sono già (magari con un importo o una data diversi), apri “Dettagli” e collegale al movimento giusto.', l);
    }
    const catGroups = [...groups.keys()].filter((g) => g.startsWith('cat:'))
      .map((g) => ({ g, l: groups.get(g), s: groups.get(g).filter((it) => it.include).reduce((s, it) => s + it.share, 0) }))
      .sort((a, b) => b.s - a.s);
    for (const { g, l, s } of catGroups) {
      const ci = catInfo(g.slice(4));
      html += block(g, `${esc(ci.icon)} ${esc(ci.name)}${ci.isNew ? ' <span class="tag">nuova voce</span>' : ''}`, `${l.length} · ${fmtEur(s)}`, '', l);
    }
    if (groups.has('zero')) {
      const l = groups.get('zero');
      html += block('zero', `Non ti riguardano (${l.length})`, 'tua parte 0', 'Spese solo dell\'altra persona, o che hai anticipato tu per lei.', l);
    }
    if (replacedId && repDel.length) {
      html += `<details class="card group" style="margin-top:14px;padding:0" data-g="del" ${openGroups.has('del') ? 'open' : ''}>
        <summary class="group-head"><h3>Movimenti tolti (${repDel.length})</h3><span class="tiny muted">${fmtEur(repDel.reduce((s, t) => s + t.amount, 0))}</span></summary>
        <div>${repDel.sort((a, b) => b.date.localeCompare(a.date)).map((t) => `<div class="imp-row"><span></span><div class="desc"><div class="t1">${esc(t.note || (t.bank || '').split(' · ')[0] || catOf(t)?.name || 'Movimento')}</div><div class="t2">${fmtDate(t.date)}</div></div><div class="amt">${fmtNum(t.amount)} €</div></div>`).join('')}</div></details>`;
    }
    if (extraBon.length) {
      html += `<div class="card" style="margin-top:14px;padding:0"><div class="group-head" style="display:block"><h3>Altri bonifici nel periodo</h3>
        <p class="tiny muted" style="margin-top:2px">Bonifici ancora senza voce. Se uno di questi è un pareggio dei conti di Tricount, selezionalo e lo tolgo: la spesa vera sono già le singole voci.</p></div>
        <div>${extraBon.map((x, i) => `<label class="imp-row ${x.on ? '' : 'off'}" style="cursor:pointer"><input type="checkbox" class="ck" data-bon="${i}" ${x.on ? 'checked' : ''}><div class="desc"><div class="t1">${esc(catOf(x.t)?.name || 'Senza voce')}</div><div class="t2">${fmtDate(x.t.date)} · ${esc(x.t.bank || x.t.note || '')}</div></div><div class="amt exp">−${fmtNum(x.t.amount)} €</div></label>`).join('')}</div></div>`;
    }
    html += `<div class="sticky-foot"><button class="btn block" id="go" style="min-height:54px" ${inc.length || repDel.length ? '' : 'disabled'}>${inc.length ? `Importa ${plural(inc.length, 'spesa', 'spese')}` : repDel.length ? 'Togli i movimenti della vecchia voce' : 'Niente di nuovo da importare'}</button></div>`;
    root.innerHTML = html;
    window.scrollTo(0, y);
  }

  async function chooseCat(it) {
    const cur = it.catId?.startsWith('new:') ? null : it.catId;
    const r = await pickCategory({ type: 'expense', current: cur, title: it.desc });
    if (!r?.categoryId) return;
    if (r.categoryId === replacedId) { toast('Questa è la voce che stai sostituendo: scegline un\'altra'); return; }
    it.catId = r.categoryId; it.catManual = true;
    // stessa descrizione → stessa voce
    for (const o of items) if (o !== it && !o.done && !o.catManual && norm(o.desc) === norm(it.desc)) o.catId = r.categoryId;
    draw();
  }

  async function moveGroup(g) {
    const list = items.filter((it) => group(it) === g);
    const r = await pickCategory({ type: 'expense', title: `Sposta ${plural(list.length, 'spesa', 'spese')}` });
    if (!r?.categoryId) return;
    if (r.categoryId === replacedId) { toast('Questa è la voce che stai sostituendo: scegline un\'altra'); return; }
    for (const it of list) { it.catId = r.categoryId; it.catManual = true; }
    openGroups.add('cat:' + r.categoryId);
    draw();
  }

  function details(it) {
    const used = new Set(items.filter((o) => o !== it && o.match && o.include).map((o) => o.match.id));
    const cands = pool().filter((t) => !used.has(t.id) && Math.abs(daysBetween(t.date, it.date)) <= 10)
      .map((t) => ({ t, s: (t.amount === it.total || Math.abs(t.amount - it.share) <= 2 ? 0 : 20) + (t.categoryId === it.mapCat ? 0 : 5) + Math.abs(daysBetween(t.date, it.date)) }))
      .sort((a, b) => a.s - b.s).slice(0, 8).map((x) => x.t);
    if (it.match && !cands.includes(it.match)) cands.unshift(it.match);
    let pick = it.match?.id || '';
    const body = document.createElement('div');
    body.className = 'stack';
    const opt = (id, ic, title, sub) => `<button type="button" data-m="${id}" style="${pick === id ? 'background:var(--surface-2)' : ''}"><span class="ic">${esc(ic)}</span><span class="grow">${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</span><span>${pick === id ? '✓' : ''}</span></button>`;
    const drawSheet = () => {
      body.innerHTML = `<p class="small ink2">${fmtDate(it.date)} · ${it.mine ? 'pagata da te' : `pagata da ${esc(it.by)}`} · totale ${fmtEur(it.total)}${it.tcat ? ` · ${esc(it.tcat.toLowerCase().replace(/_/g, ' '))}` : ''}</p>
        <label class="field"><span>La tua parte</span><input class="input" inputmode="decimal" name="share" value="${esc(centsToInput(it.share))}" autocomplete="off"></label>
        <div class="field"><span>È già nel bilancio?</span>
          <div class="menu" style="box-shadow:none;border:1.5px solid var(--line)">
            ${opt('', '＋', 'No: aggiungila come spesa nuova', '')}
            ${cands.map((t) => opt(t.id, catOf(t)?.icon || '❔', `${catOf(t)?.name || 'Senza voce'} · ${fmtEur(t.amount)}`, `${fmtDate(t.date)}${t.note ? ' · ' + t.note : t.bank ? ' · ' + t.bank : ''}`)).join('')}
          </div>
          <p class="tiny muted" style="margin-top:6px">Se scegli un movimento, diventa questa spesa con la tua parte come importo.</p></div>
        <button type="button" class="btn block" data-save>Fatto</button>`;
    };
    drawSheet();
    const sh = sheet({ title: it.desc, body });
    body.addEventListener('click', (e) => {
      const m = e.target.closest('[data-m]');
      if (m) { const inp = body.querySelector('[name=share]').value; pick = m.dataset.m; drawSheet(); body.querySelector('[name=share]').value = inp; return; }
      if (e.target.closest('[data-save]')) {
        const v = parseAmount(body.querySelector('[name=share]').value);
        if (v == null || v < 0) { toast('Importo non valido'); return; }
        it.share = v; it.shareManual = true;
        const t = pick ? S.transactions.find((x) => x.id === pick) : null;
        it.match = t || null;
        if (t && !it.catManual && t.categoryId && t.categoryId !== replacedId) it.catId = t.categoryId;
        if (!t && !it.catManual) it.catId = it.mapCat;
        it.include = true;
        sh.close();
        draw();
      }
    });
  }

  root.addEventListener('click', (e) => {
    if (e.target.id === 'go') { apply(); return; }
    const gp = e.target.closest('[data-gpick]');
    if (gp) { moveGroup(gp.dataset.gpick); return; }
    const rowEl = e.target.closest('.imp-row[data-n]');
    if (!rowEl) return;
    const it = items.find((x) => x.n === +rowEl.dataset.n);
    if (e.target.closest('[data-pick]')) chooseCat(it);
    else if (e.target.closest('[data-more]')) details(it);
  });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'rep') { replacedId = e.target.value; build(); draw(); return; }
    if (e.target.id === 'me') { parsed = readTricount(text, e.target.value); setSetting('tricountMe', e.target.value); build(); draw(); return; }
    if (e.target.matches('[data-bon]')) { extraBon[+e.target.dataset.bon].on = e.target.checked; draw(); return; }
    if (e.target.matches('[data-inc]')) {
      const it = items.find((x) => x.n === +e.target.closest('.imp-row').dataset.n);
      it.include = e.target.checked;
      draw();
    }
  });
  root.addEventListener('toggle', (e) => {
    const g = e.target.dataset?.g;
    if (!g) return;
    if (e.target.open) openGroups.add(g); else openGroups.delete(g);
  }, true);

  async function apply() {
    const todo = items.filter((it) => !it.done);
    const inc = todo.filter((it) => it.include);
    const mIds = matchedIds();
    const repDel = repTx().filter((t) => !mIds.has(t.id));
    const zeroDel = inc.filter((it) => it.share === 0 && it.match).map((it) => it.match);
    const bonDel = extraBon.filter((x) => x.on).map((x) => x.t);
    const nAdd = inc.filter((it) => it.share > 0 && !it.match).length;
    const nUpd = inc.filter((it) => it.share > 0 && it.match).length;
    const nDel = new Set([...repDel, ...zeroDel, ...bonDel].map((t) => t.id)).size;
    const ok = await confirmDialog({
      title: 'Confermi l\'import?',
      text: `Aggiungo ${plural(nAdd, 'spesa', 'spese')}, ${nUpd ? `trasformo ${plural(nUpd, 'movimento', 'movimenti')} nella tua parte ` : ''}e tolgo ${plural(nDel, 'movimento', 'movimenti')}. Potrai annullare tutto da questa pagina.`,
      ok: 'Importa',
    });
    if (!ok) return;

    const undo = { at: new Date().toISOString(), added: [], updated: [], deleted: [], catsCreated: [], archived: null,
      seenBefore: S.settings.tricountSeen || [], rulesBefore: S.settings.tricountRules || {} };
    // voci nuove (es. Gatti) solo se servono
    const newCats = new Map();
    for (const it of inc) {
      if (!it.share || !it.catId?.startsWith('new:') || newCats.has(it.catId)) continue;
      const [, name, icon] = it.catId.split(':');
      newCats.set(it.catId, { id: uid('c'), type: 'expense', name, icon, color: '#898781', order: S.categories.length + newCats.size, archived: false });
    }
    if (newCats.size) { await putMany('categories', [...newCats.values()]); undo.catsCreated = [...newCats.values()].map((c) => c.id); }
    const cid = (id) => newCats.get(id)?.id || id;
    const acc = S.settings.defaultAccountId && S.acc.has(S.settings.defaultAccountId) ? S.settings.defaultAccountId : S.accounts[0].id;

    const putTx = [];
    const seen = new Set(S.settings.tricountSeen || []);
    const rules = { ...(S.settings.tricountRules || {}) };
    for (const it of todo) {
      if (!it.include || it.share === 0) { seen.add(it.key); continue; }
      const meta = { key: it.key, total: it.total, share: it.share, paidByMe: it.mine, by: it.by, desc: it.desc, tcat: it.tcat };
      if (it.catManual) rules[norm(it.desc)] = cid(it.catId);
      if (it.match) {
        undo.updated.push(structuredClone(it.match));
        putTx.push({ ...it.match, amount: it.share, categoryId: cid(it.catId), note: it.match.note || it.desc, tricount: meta });
      } else {
        const id = uid('t');
        undo.added.push(id);
        putTx.push({ id, type: 'expense', amount: it.share, date: it.date, categoryId: cid(it.catId), accountId: acc, toAccountId: null,
          note: it.desc, source: 'tricount', bank: null, importKey: null, recurringId: null, tricount: meta });
      }
    }
    const delTx = [...new Map([...repDel, ...zeroDel, ...bonDel].map((t) => [t.id, t])).values()];
    undo.deleted = delTx.map((t) => structuredClone(t));
    await putMany('transactions', putTx);
    await delMany('transactions', delTx.map((t) => t.id));
    if (replacedId && !S.transactions.some((t) => t.categoryId === replacedId)) {
      const c = S.cat.get(replacedId);
      if (c && !c.archived) { await put('categories', { ...c, archived: true }); undo.archived = c.id; }
    }
    await setSetting('tricountSeen', [...seen]);
    await setSetting('tricountRules', rules);
    await setSetting('tricountLast', undo);
    toast(`Fatto: ${plural(putTx.length, 'spesa registrata', 'spese registrate')} con la tua parte`);
    go('#/altro/tricount');
  }

  build();
  draw();
}

async function undoLast() {
  const u = S.settings.tricountLast;
  if (!u) return;
  const ok = await confirmDialog({ title: 'Annullo l\'ultimo import?', text: 'Le spese aggiunte vengono tolte e i movimenti tornano com\'erano prima.', ok: 'Annulla import', danger: true });
  if (!ok) return;
  await delMany('transactions', u.added);
  await putMany('transactions', [...u.updated, ...u.deleted].map((t) => structuredClone(t)));
  if (u.archived && S.cat.get(u.archived)) await put('categories', { ...S.cat.get(u.archived), archived: false });
  const unused = u.catsCreated.filter((id) => !S.transactions.some((t) => t.categoryId === id));
  if (unused.length) await delMany('categories', unused);
  await setSetting('tricountSeen', u.seenBefore || []);
  await setSetting('tricountRules', u.rulesBefore || {});
  await setSetting('tricountLast', null);
  toast('Import annullato');
  go('#/altro/tricount');
}
