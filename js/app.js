// Avvio, navigazione, Home (inserimento rapido) e lista Movimenti
import { S, load, put, del, putMany, onChange, requestPersistence } from './store.js';
import {
  ensureDefaults, runRecurring, balance, monthTotals, rankedCategories, catOf, txTitle, txSubtitle, uncategorized,
  activeAccounts, accName, nextAfter, describeRecurring,
} from './model.js';
import {
  $, $$, esc, fmtEur, fmtNum, parseAmount, centsToInput, today, addDays, fmtDay, fmtDayShort, fmtDate, ym, ymAdd, ymLabel,
  uid, cap, norm, debounce, daysBetween, parseISO, lastDayOfMonth,
} from './util.js';
import { toast, sheet, confirmDialog, pickCategory, accountOptions, ICONS, promptDialog, editCategory } from './ui.js';
import * as B from './bank.js';

const view = document.getElementById('view');
const routes = {};
let current = null;
let cleanup = null;

export function route(name, render, { tab = name, live = true } = {}) { routes[name] = { render, tab, live }; }
export function go(hash) { if (location.hash === hash) renderRoute(); else location.hash = hash; }

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const name = parts[parts.length - 1] || 'home';
  return { name: routes[name] ? name : 'home', params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

async function renderRoute() {
  const { name, params } = parseHash();
  const sameRoute = current && current.name === name && JSON.stringify(current.params) === JSON.stringify(params);
  const r = routes[name];
  if (typeof cleanup === 'function') { try { cleanup(); } catch {} }
  cleanup = null;
  current = { name, params };
  $$('#tabbar a').forEach((a) => a.classList.toggle('on', a.dataset.tab === r.tab));
  // contenitore nuovo a ogni pagina: gli ascoltatori della pagina precedente spariscono con lei
  const root = document.createElement('div');
  const keepScroll = sameRoute ? window.scrollY : 0;
  view.replaceChildren(root);
  try { cleanup = await r.render(root, params); } catch (e) { console.error(e); root.innerHTML = `<div class="empty"><h3>Qualcosa non ha funzionato</h3><p>${esc(e.message)}</p></div>`; }
  window.scrollTo(0, keepScroll);
}

onChange(() => {
  if (!current) return;
  const r = routes[current.name];
  if (r.live === true) renderRoute();
  else if (typeof r.live === 'function') r.live();
});

/* ======================= HOME ======================= */

route('home', (root) => {
  root.innerHTML = `<div id="banners" class="stack"></div>
    <header class="month-head" id="summary"></header>
    <section class="card entry" id="entry"></section>
    <div class="section-title"><h2>Ultimi movimenti</h2><a class="link" href="#/movimenti">Vedi tutti</a></div>
    <div id="recent"></div>`;
  const refresh = () => { renderSummary(); renderRecent(); renderBanners(); };
  refresh();
  mountEntryForm($('#entry'), { onSaved: () => {} });
  routes.home.live = refresh;
}, { live: () => {} });

function renderSummary() {
  const el = $('#summary');
  if (!el) return;
  const key = ym(today());
  const { inc, exp, net } = monthTotals(key);
  const acc = S.acc.get(S.settings.defaultAccountId) || activeAccounts()[0];
  const bal = acc ? balance(acc.id) : 0;
  const pct = inc > 0 ? Math.round((exp / inc) * 100) : null;
  el.innerHTML = `
    <div class="mh-top">
      <span class="month">${cap(ymLabel(key))}</span>
      <a class="saldo" href="#/altro/conti">${esc(acc?.name || 'Saldo')}<b>${fmtEur(bal)}</b></a>
    </div>
    <div class="mh-main">
      <div><div class="mh-net ${net < 0 ? 'exp' : ''}">${net < 0 ? '−' : net > 0 ? '+' : ''}${fmtNum(Math.abs(net))}<small> €</small></div>
        <div class="mh-label">Bilancio del mese</div></div>
      <div class="mh-side"><div class="inc">+${fmtNum(inc)} €</div><div class="exp">−${fmtNum(exp)} €</div></div>
    </div>
    <div class="ratio ${pct != null && pct > 100 ? 'over' : ''}" role="img" aria-label="Uscite pari al ${pct ?? 0}% delle entrate"><span style="width:${Math.min(100, pct ?? (exp > 0 ? 100 : 0))}%"></span></div>
    <p class="tiny muted" style="margin-top:7px">${!inc && !exp ? 'Nessun movimento questo mese' : !inc ? 'Nessuna entrata registrata questo mese' : exp > inc ? `Uscite superiori alle entrate di ${fmtEur(exp - inc)}` : `Hai speso il ${pct}% di quanto è entrato`}</p>`;
  el.querySelector('.saldo').style.textDecoration = 'none';
}

function renderBanners() {
  const el = $('#banners');
  if (!el) return;
  const out = [];
  if (!S.transactions.length) {
    out.push(`<div class="banner neutral"><span class="grow">Hai già un backup o i dati iniziali? Ripristinali prima di iniziare.</span><a class="btn small" href="#/altro/backup">Ripristina</a></div>`);
  }
  const n = uncategorized().length;
  if (n) out.push(`<div class="banner"><span class="grow">${n === 1 ? '1 movimento' : `${n} movimenti`} da classificare</span><a class="btn small" href="#/movimenti?f=none">Classifica</a></div>`);
  const st = S.settings;
  if (S.transactions.length && (st.changesSinceBackup || 0) > 0) {
    const days = st.lastBackupAt ? daysBetween(st.lastBackupAt.slice(0, 10), today()) : null;
    if (days == null || days >= (st.backupEveryDays || 7)) {
      out.push(`<div class="banner"><span class="grow">${days == null ? 'Non hai ancora fatto un backup.' : `Ultimo backup ${days} giorni fa.`} Salvane uno su Drive.</span><a class="btn small" href="#/altro/backup?quick=1">Backup</a></div>`);
    }
  }
  el.innerHTML = out.join('');
  el.style.marginBottom = out.length ? '14px' : '0';
}

function renderRecent() {
  const el = $('#recent');
  if (!el) return;
  const items = S.transactions.slice(-8).reverse();
  el.innerHTML = items.length
    ? `<div class="list">${items.map((t) => itemHtml(t, { showDate: true })).join('')}</div>`
    : `<div class="empty card"><h3>Nessun movimento</h3><p class="small">Inserisci la prima spesa qui sopra.</p></div>`;
  el.querySelector('.list')?.addEventListener('click', onItemClick);
}

/* ---------- Riga movimento ---------- */

export function itemHtml(t, { showDate = false } = {}) {
  const c = catOf(t);
  const icon = t.type === 'transfer' ? '↔' : c?.icon || '❔';
  const sign = t.type === 'expense' ? '−' : t.type === 'income' ? '+' : '';
  const cls = t.type === 'expense' ? 'exp' : t.type === 'income' ? 'inc' : '';
  const sub = [showDate ? fmtDayShort(t.date) : '', txSubtitle(t)].filter(Boolean).join(' · ');
  const tags = `${!c && t.type !== 'transfer' ? '<span class="tag warn">senza voce</span>' : ''}${t.recurringId ? '<span class="tag">↻</span>' : ''}`;
  return `<button class="item" data-id="${t.id}">
    <span class="bubble">${esc(icon)}</span>
    <span class="grow"><span class="t1" style="display:block">${esc(txTitle(t))}${tags}</span><span class="t2" style="display:block">${esc(sub) || '&nbsp;'}</span></span>
    <span class="amt ${cls}">${sign}${fmtNum(t.amount)} €</span></button>`;
}

function onItemClick(e) {
  const b = e.target.closest('.item[data-id]');
  if (!b) return;
  const t = S.transactions.find((x) => x.id === b.dataset.id);
  if (!t) return;
  if (t.type !== 'transfer' && !t.categoryId) classifyTx(t); else openTxEditor(t);
}

// Classificazione veloce di un movimento senza voce (con regola opzionale)
export function classifyTx(t) {
  const raw = t.raw || null;
  const body = document.createElement('div');
  const draw = () => {
    const cats = rankedCategories(t.type);
    body.innerHTML = `
      <div class="row" style="align-items:flex-start;margin-bottom:12px"><div class="grow"><p style="font-weight:650">${esc(txTitle(t))}</p>
        <p class="small muted">${fmtDate(t.date)}${txSubtitle(t) ? ' · ' + esc(txSubtitle(t)) : ''}</p></div>
        <b class="${t.type === 'expense' ? 'exp' : 'inc'} num">${t.type === 'expense' ? '−' : '+'}${fmtNum(t.amount)} €</b></div>
      ${raw ? `<label class="remember" style="margin-bottom:12px"><input type="checkbox" data-rem ${B.isGenericRow(raw) ? '' : 'checked'}> Ricorda per <input type="text" data-pat value="${esc(B.merchantKey(raw))}"></label>` : ''}
      <div class="pick-grid">${cats.map((c) => `<button class="cat" data-id="${c.id}"><span class="em">${esc(c.icon || '📦')}</span><span class="nm">${esc(c.name)}</span></button>`).join('')}
        <button class="cat more" data-new><span class="em">＋</span><span class="nm">Nuova voce</span></button></div>
      <button class="btn block ghost" data-full style="margin-top:14px">Modifica tutti i dettagli</button>`;
  };
  draw();
  const sh = sheet({ title: 'Scegli la voce', body });
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if ('full' in b.dataset) { sh.close(); openTxEditor(t); return; }
    let catId = b.dataset.id;
    if ('new' in b.dataset) { const c = await editCategory({ type: t.type }); if (!c) return; catId = c.id; }
    if (!catId) return;
    const rem = body.querySelector('[data-rem]')?.checked;
    const pat = B.normText(body.querySelector('[data-pat]')?.value || '');
    await put('transactions', { ...t, categoryId: catId });
    let n = 1;
    if (raw && rem && pat.length >= 3) {
      const ex = S.rules.find((r) => B.normText(r.pattern) === pat && r.type === t.type);
      await put('rules', { ...(ex || { id: uid('r') }), pattern: pat, type: t.type, categoryId: catId, toAccountId: null });
      const others = S.transactions.filter((x) => x.id !== t.id && x.type === t.type && !x.categoryId && x.raw && B.rowText(x.raw).includes(pat));
      if (others.length) { await putMany('transactions', others.map((x) => ({ ...x, categoryId: catId }))); n += others.length; }
    }
    sh.close();
    toast(n > 1 ? `Classificati ${n} movimenti in “${S.cat.get(catId).name}”` : `Classificato in “${S.cat.get(catId).name}”`);
  });
}

/* ---------- Form di inserimento / modifica ---------- */

const TYPE_WORD = { expense: 'uscita', income: 'entrata', transfer: 'giroconto' };

export function mountEntryForm(root, { tx = null, onSaved, onDeleted, bare = false } = {}) {
  const editing = !!tx;
  const st = {
    type: tx?.type || 'expense',
    amount: tx ? centsToInput(tx.amount) : '',
    categoryId: tx?.categoryId || null,
    date: tx?.date || today(),
    accountId: tx?.accountId || S.settings.defaultAccountId,
    toAccountId: tx?.toAccountId || null,
    note: tx?.note || '',
    noteOpen: !!tx?.note,
    repeat: false,
    freq: 'month',
    every: 1,
  };

  function draw() {
    root.className = `${bare ? '' : 'card '}entry t-${st.type}`;
    const multi = activeAccounts().length > 1;
    root.innerHTML = `
      <div class="seg t-${st.type}" role="tablist">
        ${['expense', 'income', 'transfer'].map((t) => `<button type="button" data-type="${t}" class="${st.type === t ? 'on' : ''}">${cap(TYPE_WORD[t])}</button>`).join('')}
      </div>
      <label class="amount-wrap"><span class="sign">${st.type === 'expense' ? '−' : st.type === 'income' ? '+' : ''}</span>
        <input class="amount-input" inputmode="decimal" enterkeyhint="done" autocomplete="off" placeholder="0" value="${esc(st.amount)}" aria-label="Importo in euro">
        <span class="cur">€</span></label>
      <div class="amount-hint" aria-live="polite"></div>
      ${st.type === 'transfer' ? transferHtml() : `<div class="cat-grid">${catGridHtml()}</div>`}
      <div class="meta-row">
        <span class="meta ${st.date !== today() ? 'on' : ''}">${ICONS.cal}<span>${esc(dateLabel(st.date))}</span><input type="date" value="${st.date}" aria-label="Data" data-f="date"></span>
        ${st.type !== 'transfer' && multi ? `<span class="meta">${ICONS.wallet}<span>${esc(accName(st.accountId))}</span>
          <select data-f="account" aria-label="Conto" style="position:absolute;inset:0;opacity:0">${accountOptions(st.accountId)}</select></span>` : ''}
        <button type="button" class="meta ${st.noteOpen ? 'on' : ''}" data-act="note">${ICONS.note}<span>Nota</span></button>
        ${editing ? '' : `<button type="button" class="meta ${st.repeat ? 'on' : ''}" data-act="repeat">${ICONS.repeat}<span>Ripeti</span></button>`}
      </div>
      ${st.noteOpen ? `<input class="input note-input" data-f="note" placeholder="Nota (facoltativa)" value="${esc(st.note)}" maxlength="140" autocomplete="off">` : ''}
      ${st.repeat ? repeatHtml() : ''}
      ${tx?.bank ? `<p class="tiny muted" style="margin-top:10px">Dall'estratto conto: ${esc(tx.bank)}</p>` : ''}
      ${tx?.recurringId ? `<p class="tiny muted" style="margin-top:6px">Creato da una spesa ricorrente. <a href="#/altro/ricorrenti">Gestisci</a></p>` : ''}
      <button type="button" class="btn block save-btn" data-act="save">${editing ? 'Salva modifiche' : `Salva ${TYPE_WORD[st.type]}`}</button>
      ${editing ? `<button type="button" class="btn block line" data-act="delete" style="margin-top:8px;color:var(--exp)">Elimina movimento</button>` : ''}`;
    const amt = root.querySelector('.amount-input');
    fitAmount(amt);
    document.fonts?.ready.then(() => fitAmount(amt));
    amt.addEventListener('input', () => { st.amount = amt.value; fitAmount(amt); hint(''); });
    amt.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); amt.blur(); } });
    root.querySelector('[data-f="note"]')?.addEventListener('input', (e) => (st.note = e.target.value));
  }

  function fitAmount(inp) {
    const m = fitAmount.m || (fitAmount.m = Object.assign(document.createElement('span'), { className: 'amount-input' }));
    if (!m.isConnected) { m.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;width:auto;left:-9999px;top:0'; document.body.appendChild(m); }
    m.textContent = inp.value || inp.placeholder || '0';
    inp.style.width = `${Math.ceil(m.getBoundingClientRect().width) + 6}px`;
  }
  function hint(msg) { const h = root.querySelector('.amount-hint'); if (h) h.textContent = msg; }

  function dateLabel(d) {
    if (d === today()) return 'Oggi';
    if (d === addDays(today(), -1)) return 'Ieri';
    return fmtDayShort(d) + (d.slice(0, 4) !== today().slice(0, 4) ? ` ${d.slice(0, 4)}` : '');
  }

  function catGridHtml() {
    const ranked = rankedCategories(st.type);
    let shown = ranked.slice(0, 7);
    if (st.categoryId && !shown.some((c) => c.id === st.categoryId)) {
      const sel = S.cat.get(st.categoryId);
      if (sel && sel.type === st.type) shown = [sel, ...shown.slice(0, 6)];
    }
    return shown.map((c) => `<button type="button" class="cat ${c.id === st.categoryId ? 'on' : ''}" data-cat="${c.id}">
        <span class="em">${esc(c.icon || '📦')}</span><span class="nm">${esc(c.name)}</span></button>`).join('')
      + `<button type="button" class="cat more" data-act="morecats"><span class="em">⋯</span><span class="nm">Tutte le voci</span></button>`;
  }

  function transferHtml() {
    if (!st.toAccountId || st.toAccountId === st.accountId) st.toAccountId = activeAccounts().find((a) => a.id !== st.accountId)?.id || null;
    return `<div class="transfer-row">
      <label class="field"><span>Da</span><select class="input" data-f="account">${accountOptions(st.accountId)}</select></label>
      <span class="arrow" style="padding-top:22px">→</span>
      <label class="field"><span>A</span><select class="input" data-f="to">${accountOptions(st.toAccountId, { exclude: st.accountId })}<option value="__new">＋ Nuovo conto…</option></select></label>
    </div>`;
  }

  function repeatHtml() {
    const d = parseISO(st.date);
    const isLast = d.getDate() === lastDayOfMonth(d.getFullYear(), d.getMonth() + 1);
    const r = { freq: st.freq, every: st.every, start: st.date, day: st.freq === 'month' ? (isLast ? 31 : d.getDate()) : null };
    return `<div class="repeat-box">
      <div class="row"><label class="field"><span>Ogni</span><input class="input" data-f="every" type="number" min="1" max="99" inputmode="numeric" value="${st.every}"></label>
      <label class="field"><span>&nbsp;</span><select class="input" data-f="freq">
        ${[['day', 'giorni'], ['week', 'settimane'], ['month', 'mesi'], ['year', 'anni']].map(([v, l]) => `<option value="${v}" ${st.freq === v ? 'selected' : ''}>${st.every > 1 ? l : { day: 'giorno', week: 'settimana', month: 'mese', year: 'anno' }[v]}</option>`).join('')}
      </select></label></div>
      <p class="small ink2">${esc(describeRecurring(r))}, a partire dal ${fmtDate(st.date)}. Prossima volta: ${fmtDate(nextAfter(r, st.date))}. Verrà aggiunta in automatico.</p>
    </div>`;
  }

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !root.contains(b)) return;
    if (b.dataset.type) {
      if (b.dataset.type === 'transfer' && activeAccounts().length < 2) {
        const name = await promptDialog({ title: 'Serve un secondo conto', text: 'Un giroconto sposta soldi tra due conti tuoi. Come si chiama l\'altro conto?', placeholder: 'Es. Contanti, Conto deposito', ok: 'Crea conto' });
        if (!name?.trim()) return;
        const a = await put('accounts', { id: uid('a'), name: name.trim(), kind: 'other', ref: null, order: S.accounts.length, archived: false });
        st.toAccountId = a.id;
      }
      if (st.type !== b.dataset.type) st.categoryId = null;
      st.type = b.dataset.type;
      draw();
    } else if (b.dataset.cat) {
      st.categoryId = st.categoryId === b.dataset.cat ? null : b.dataset.cat;
      root.querySelectorAll('.cat[data-cat]').forEach((x) => x.classList.toggle('on', x.dataset.cat === st.categoryId));
      hint('');
    } else if (b.dataset.act === 'morecats') {
      const r = await pickCategory({ type: st.type, current: st.categoryId });
      if (r?.categoryId) { st.categoryId = r.categoryId; draw(); }
    } else if (b.dataset.act === 'note') {
      st.noteOpen = !st.noteOpen; draw();
      if (st.noteOpen) root.querySelector('[data-f="note"]')?.focus();
    } else if (b.dataset.act === 'repeat') {
      st.repeat = !st.repeat; draw();
    } else if (b.dataset.act === 'save') {
      save();
    } else if (b.dataset.act === 'delete') {
      const ok = await confirmDialog({ title: 'Eliminare il movimento?', text: `${txTitle(tx)} · ${fmtEur(tx.amount)} · ${fmtDate(tx.date)}`, ok: 'Elimina', danger: true });
      if (!ok) return;
      const copy = { ...tx };
      await del('transactions', tx.id);
      toast('Movimento eliminato', { action: 'Annulla', onAction: () => put('transactions', copy) });
      onDeleted?.();
    }
  });

  root.addEventListener('change', async (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    if (f === 'date') { st.date = e.target.value || today(); draw(); }
    else if (f === 'account') { st.accountId = e.target.value; draw(); }
    else if (f === 'to') {
      if (e.target.value === '__new') {
        const name = await promptDialog({ title: 'Nuovo conto', placeholder: 'Es. Contanti', ok: 'Crea' });
        if (name?.trim()) { const a = await put('accounts', { id: uid('a'), name: name.trim(), kind: 'other', ref: null, order: S.accounts.length, archived: false }); st.toAccountId = a.id; }
        draw();
      } else st.toAccountId = e.target.value;
    } else if (f === 'freq') { st.freq = e.target.value; draw(); }
    else if (f === 'every') { st.every = Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1)); draw(); }
  });

  async function save() {
    const cents = parseAmount(st.amount);
    if (!cents || cents <= 0) { hint('Scrivi un importo'); root.querySelector('.amount-input').focus(); return; }
    if (st.type !== 'transfer' && !st.categoryId) { hint('Scegli una voce'); return; }
    if (st.type === 'transfer' && (!st.toAccountId || st.toAccountId === st.accountId)) { hint('Scegli due conti diversi'); return; }
    const base = {
      type: st.type, amount: cents, date: st.date,
      categoryId: st.type === 'transfer' ? null : st.categoryId,
      accountId: st.accountId, toAccountId: st.type === 'transfer' ? st.toAccountId : null,
      note: st.note.trim(),
    };
    if (editing) {
      await put('transactions', { ...tx, ...base });
      toast('Modifiche salvate');
      onSaved?.();
      return;
    }
    let recurringId = null;
    let msg = `${cap(TYPE_WORD[st.type])} di ${fmtEur(cents)} salvata`;
    if (st.type === 'transfer') msg = `Giroconto di ${fmtEur(cents)} salvato`;
    if (st.repeat) {
      const d = parseISO(st.date);
      const isLast = d.getDate() === lastDayOfMonth(d.getFullYear(), d.getMonth() + 1);
      const r = { id: uid('p'), ...base, freq: st.freq, every: st.every, day: st.freq === 'month' ? (isLast ? 31 : d.getDate()) : null, start: st.date, end: null, active: true };
      r.next = st.date <= today() ? nextAfter(r, st.date) : st.date;
      await put('recurring', r);
      recurringId = r.id;
      msg = st.date <= today() ? `${msg}. Si ripeterà dal ${fmtDate(r.next)}` : `Programmata dal ${fmtDate(st.date)}`;
    }
    let saved = null;
    if (!st.repeat || st.date <= today()) {
      saved = await put('transactions', { id: uid('t'), ...base, source: 'manual', bank: null, importKey: null, recurringId });
    }
    st.amount = ''; st.categoryId = null; st.note = ''; st.noteOpen = false; st.repeat = false;
    draw();
    toast(msg, saved ? { action: 'Annulla', onAction: () => del('transactions', saved.id) } : {});
    onSaved?.(saved);
  }

  draw();
}

export function openTxEditor(t) {
  const wrap = document.createElement('div');
  const sh = sheet({ title: t.type === 'transfer' ? 'Giroconto' : t.type === 'income' ? 'Entrata' : 'Uscita', body: wrap });
  mountEntryForm(wrap, { tx: t, bare: true, onSaved: () => sh.close(), onDeleted: () => sh.close() });
}

/* ======================= MOVIMENTI ======================= */

route('movimenti', (root, params) => {
  const st = { month: params.m || ym(today()), q: '', f: params.f || 'all', cat: params.cat || null };
  root.innerHTML = `
    <div class="page-head"><h1>Movimenti</h1><a class="icon-btn" href="#/altro/importa" aria-label="Importa estratto conto">${ICONS.upload}</a></div>
    <div class="month-nav">
      <button class="icon-btn" data-m="-1" aria-label="Mese precedente">${ICONS.prev}</button>
      <label class="label" style="position:relative"><span id="mlabel"></span><input type="month" id="mpick" style="position:absolute;inset:0;opacity:0" aria-label="Scegli mese"></label>
      <button class="icon-btn" data-m="1" aria-label="Mese successivo">${ICONS.next}</button>
    </div>
    <div class="totals" id="totals"></div>
    <div class="search">${ICONS.search}<input class="input" id="q" type="search" placeholder="Cerca in tutti i mesi" autocomplete="off"></div>
    <div class="chips" id="filters" style="margin-bottom:14px"></div>
    <div id="mlist"></div>`;
  const draw = () => {
    $('#mlabel').textContent = cap(ymLabel(st.month));
    $('#mpick').value = st.month;
    const nNone = uncategorized().length;
    const catName = st.cat ? S.cat.get(st.cat)?.name : null;
    $('#filters').innerHTML = [['all', 'Tutti'], ['expense', 'Uscite'], ['income', 'Entrate'], ['transfer', 'Giroconti'], ['none', `Da classificare${nNone ? ` (${nNone})` : ''}`]]
      .filter(([k]) => k !== 'none' || nNone || st.f === 'none')
      .map(([k, l]) => `<button class="chip ${st.f === k && !st.cat ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')
      + `<button class="chip ${st.cat ? 'on' : ''}" data-f="cat">${catName ? esc(catName) + ' ✕' : 'Per voce…'}</button>`;
    const q = norm(st.q);
    const all = st.f === 'none' && !st.cat;
    let list = S.transactions.filter((t) => {
      if (st.cat) { if (t.categoryId !== st.cat) return false; }
      else if (st.f === 'none') { if (t.type === 'transfer' || t.categoryId) return false; }
      else if (st.f !== 'all' && t.type !== st.f) return false;
      if (q) {
        const hay = norm(`${txTitle(t)} ${t.note} ${t.bank || ''} ${fmtNum(t.amount)}`);
        return q.split(' ').every((w) => hay.includes(w));
      }
      return all || st.cat ? true : t.date.startsWith(st.month);
    });
    if (st.cat && !q) list = list.filter((t) => t.date.startsWith(st.month.slice(0, 4)));
    let inc = 0, exp = 0;
    for (const t of list) { if (t.type === 'income') inc += t.amount; else if (t.type === 'expense') exp += t.amount; }
    const scope = q ? 'Risultati' : st.cat ? `Anno ${st.month.slice(0, 4)}` : all ? 'Tutti i mesi' : '';
    $('#totals').innerHTML = `<div><span>Entrate</span><b class="inc">${fmtNum(inc)} €</b></div><div><span>Uscite</span><b class="exp">${fmtNum(exp)} €</b></div><div><span>Bilancio</span><b>${fmtEur(inc - exp, { sign: true })}</b></div>`;
    root.querySelector('.month-nav').style.opacity = q || all ? '.4' : '1';
    const shown = list.slice().reverse().slice(0, 400);
    if (!shown.length) {
      $('#mlist').innerHTML = `<div class="empty card"><h3>${q ? 'Nessun risultato' : 'Nessun movimento'}</h3><p class="small">${q ? 'Prova con un\'altra parola o un importo, es. 6,99.' : 'In questo periodo non ci sono movimenti con questi filtri.'}</p></div>`;
      return;
    }
    let html = scope ? `<p class="small muted" style="margin:0 4px 8px">${scope}: ${list.length} movimenti${list.length > 400 ? ' (mostro i più recenti 400)' : ''}</p>` : '';
    html += '<div class="list">';
    let day = null;
    for (const t of shown) {
      if (t.date !== day) {
        day = t.date;
        const dayNet = shown.filter((x) => x.date === day).reduce((s, x) => s + (x.type === 'income' ? x.amount : x.type === 'expense' ? -x.amount : 0), 0);
        html += `<div class="day-head"><span>${esc(fmtDay(day))}</span><span class="num">${dayNet ? fmtEur(dayNet, { sign: true }) : ''}</span></div>`;
      }
      html += itemHtml(t);
    }
    $('#mlist').innerHTML = html + '</div>';
  };
  root.addEventListener('click', async (e) => {
    const m = e.target.closest('[data-m]');
    if (m) { st.month = ymAdd(st.month, +m.dataset.m); draw(); return; }
    const f = e.target.closest('[data-f]');
    if (f && f.classList.contains('chip')) {
      if (f.dataset.f === 'cat') {
        if (st.cat) { st.cat = null; draw(); return; }
        const tsel = st.f === 'income' ? 'income' : 'expense';
        const r = await pickCategory({ type: tsel, title: 'Filtra per voce' });
        if (r?.categoryId) { st.cat = r.categoryId; draw(); }
        return;
      }
      st.f = f.dataset.f; st.cat = null; draw(); return;
    }
    onItemClick(e);
  });
  $('#mpick').addEventListener('change', (e) => { if (e.target.value) { st.month = e.target.value; draw(); } });
  $('#q').addEventListener('input', debounce((e) => { st.q = e.target.value; draw(); }, 150));
  draw();
  routes.movimenti.live = draw;
}, { live: () => {} });

/* ======================= AVVIO ======================= */

async function start() {
  view.innerHTML = '<div class="splash">Bilancio</div>';
  try {
    await load();
  } catch (e) {
    view.innerHTML = `<div class="empty"><h3>Archivio non disponibile</h3><p>${esc(e.message)}. Se stai usando una finestra in incognito, apri l'app normalmente.</p></div>`;
    return;
  }
  await ensureDefaults();
  await import('./more.js');
  await import('./stats.js');
  await import('./importer.js');
  const n = await runRecurring();
  if (n) toast(n === 1 ? 'Aggiunto 1 movimento ricorrente' : `Aggiunti ${n} movimenti ricorrenti`);
  window.addEventListener('hashchange', renderRoute);
  renderRoute();
  requestPersistence();
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      const k = await runRecurring();
      if (k) toast(k === 1 ? 'Aggiunto 1 movimento ricorrente' : `Aggiunti ${k} movimenti ricorrenti`);
    }
  });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            toast('È disponibile una nuova versione', { action: 'Aggiorna', onAction: () => { w.postMessage('skipWaiting'); } });
          }
        });
      });
    }).catch(() => {});
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
  }
}

start();
