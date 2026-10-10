// Home: inserimento veloce con tastierino (importo → voce → salva)
import { route } from './app.js';
import { S, put, del } from './store.js';
import { monthTotals, balance, activeAccounts, rankedCategories, accName, nextAfter } from './model.js';
import { esc, fmtEur, fmtNum, today, addDays, fmtDayShort, fmtDate, ym, ymLabel, MONTHS, cap, uid, parseISO, lastDayOfMonth } from './util.js';
import { toast, sheet, pickCategory, promptDialog, accountOptions } from './ui.js';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', '⌫'];
const WORD = { expense: 'uscita', income: 'entrata', transfer: 'giroconto' };
const REPEATS = [
  ['', 'Non ripetere'], ['week:1', 'Ogni settimana'], ['month:1', 'Ogni mese'], ['month:2', 'Ogni 2 mesi'],
  ['month:3', 'Ogni 3 mesi'], ['month:6', 'Ogni 6 mesi'], ['year:1', 'Ogni anno'],
];

// La bozza sopravvive al cambio di pagina (non al riavvio dell'app)
const draft = { type: 'expense', digits: '', categoryId: null, date: null, note: '', repeat: '', accountId: null, toAccountId: null };

const cents = () => {
  if (!draft.digits) return 0;
  const [i, f = ''] = draft.digits.split(',');
  return (parseInt(i || '0', 10) * 100) + parseInt((f + '00').slice(0, 2), 10);
};
const shown = () => {
  if (!draft.digits) return '0';
  const [i, f] = draft.digits.split(',');
  const int = (i || '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return f === undefined ? int : `${int},${f}`;
};

function dateLabel(d) {
  if (d === today()) return 'Oggi';
  if (d === addDays(today(), -1)) return 'Ieri';
  return fmtDayShort(d) + (d.slice(0, 4) !== today().slice(0, 4) ? ` ${d.slice(0, 4)}` : '');
}

route('home', (root) => {
  if (!draft.accountId || !S.acc.has(draft.accountId)) draft.accountId = S.settings.defaultAccountId;
  root.innerHTML = '<div class="qe"></div>';
  const el = root.firstElementChild;

  function header() {
    const key = ym(today());
    const { net } = monthTotals(key);
    return `<header class="qe-head">
        <span class="qe-month">${cap(ymLabel(key, { year: false }))}</span>
        <button class="qe-bal" data-act="summary" aria-label="Riepilogo del mese">Bilancio <b class="${net < 0 ? 'exp' : net > 0 ? 'inc' : ''}">${fmtEur(net, { sign: true })}</b></button>
      </header>`;
  }

  function chipsHtml() {
    if (draft.type === 'transfer') {
      if (!draft.toAccountId || draft.toAccountId === draft.accountId) draft.toAccountId = activeAccounts().find((a) => a.id !== draft.accountId)?.id || null;
      return `<div class="qe-transfer">
          <select class="input" data-f="from" aria-label="Dal conto">${accountOptions(draft.accountId)}</select>
          <span aria-hidden="true">→</span>
          <select class="input" data-f="to" aria-label="Al conto">${accountOptions(draft.toAccountId, { exclude: draft.accountId })}</select>
        </div>`;
    }
    let cats = rankedCategories(draft.type).slice(0, 10);
    if (draft.categoryId && !cats.some((c) => c.id === draft.categoryId)) {
      const c = S.cat.get(draft.categoryId);
      if (c && c.type === draft.type) cats = [c, ...cats.slice(0, 9)];
    }
    return `<div class="qe-chips" role="group" aria-label="Voce">${cats.map((c) => `<button class="qe-chip ${c.id === draft.categoryId ? 'on' : ''}" data-cat="${c.id}"><span aria-hidden="true">${esc(c.icon || '📦')}</span>${esc(c.name)}</button>`).join('')}
        <button class="qe-chip more" data-act="morecats">Altre voci…</button></div>`;
  }

  function metaHtml() {
    const d = draft.date || today();
    const rep = REPEATS.find(([v]) => v === draft.repeat);
    const multi = activeAccounts().length > 1 && draft.type !== 'transfer';
    return `<div class="qe-meta">
        <label class="qe-link ${d !== today() ? 'on' : ''}">${esc(dateLabel(d))}<input type="date" value="${d}" data-f="date" aria-label="Data"></label>
        <button class="qe-link ${draft.note ? 'on' : ''}" data-act="note">${draft.note ? `“${esc(draft.note.length > 18 ? draft.note.slice(0, 17) + '…' : draft.note)}”` : 'Aggiungi nota'}</button>
        ${draft.repeat ? `<button class="qe-link on" data-act="options">↻ ${esc(rep[1].replace('Ogni', 'ogni'))}</button>` : ''}
        ${multi && draft.accountId !== S.settings.defaultAccountId ? `<button class="qe-link on" data-act="options">${esc(accName(draft.accountId))}</button>` : ''}
        <button class="qe-link" data-act="options">Opzioni</button>
      </div>`;
  }

  function draw() {
    const t = draft.type;
    el.className = `qe t-${t}`;
    el.innerHTML = `${header()}
      ${S.transactions.length ? '' : '<a class="qe-first" href="#/altro/backup">Hai già un backup o i dati iniziali? <b>Ripristinali</b></a>'}
      <div class="seg qe-type t-${t}">
        <button data-type="expense" class="${t === 'expense' ? 'on' : ''}">Uscita</button>
        <button data-type="income" class="${t === 'income' ? 'on' : ''}">Entrata</button>
        ${t === 'transfer' ? '<button data-type="transfer" class="on">Giroconto</button>' : ''}
      </div>
      <div class="qe-mid">
        <div class="qe-amount" aria-live="polite"><span class="sign">${t === 'expense' ? '−' : t === 'income' ? '+' : ''}</span><span class="val ${draft.digits ? '' : 'zero'}">${shown()}</span><span class="cur">€</span></div>
        ${metaHtml()}
      </div>
      ${chipsHtml()}
      <div class="qe-keys">${KEYS.map((k) => `<button data-k="${k}" ${k === '⌫' ? 'aria-label="Cancella (tieni premuto per azzerare)"' : ''}>${k}</button>`).join('')}</div>
      <button class="btn block save-btn qe-save" data-act="save">Salva ${WORD[t]}</button>`;
  }

  function updateAmount() {
    const v = el.querySelector('.qe-amount .val');
    v.textContent = shown();
    v.classList.toggle('zero', !draft.digits);
  }

  function press(k) {
    let d = draft.digits;
    if (k === '⌫') d = d.slice(0, -1);
    else if (k === ',') { if (!d.includes(',')) d = (d || '0') + ','; }
    else {
      const [i, f] = d.split(',');
      if (f !== undefined) { if (f.length >= 2) return; d += k; }
      else if (i === '0') d = k;
      else if (i.length >= 7) return;
      else d += k;
    }
    if (d === '0' && k === '0' && !draft.digits) d = '';
    draft.digits = d;
    updateAmount();
  }

  function flash(sel) {
    const n = el.querySelector(sel);
    if (!n) return;
    n.classList.remove('flash');
    void n.offsetWidth;
    n.classList.add('flash');
  }

  async function save() {
    const amount = cents();
    if (!amount) { flash('.qe-amount'); toast('Scrivi l\'importo'); return; }
    if (draft.type !== 'transfer' && !draft.categoryId) { flash('.qe-chips'); toast('Scegli una voce'); return; }
    if (draft.type === 'transfer' && (!draft.toAccountId || draft.toAccountId === draft.accountId)) { toast('Scegli due conti diversi'); return; }
    const date = draft.date || today();
    const base = {
      type: draft.type, amount, date,
      categoryId: draft.type === 'transfer' ? null : draft.categoryId,
      accountId: draft.accountId, toAccountId: draft.type === 'transfer' ? draft.toAccountId : null,
      note: draft.note.trim(),
    };
    let recurringId = null;
    let msg = draft.type === 'transfer' ? `Giroconto di ${fmtEur(amount)} salvato` : `${cap(WORD[draft.type])} di ${fmtEur(amount)} salvata`;
    if (draft.repeat) {
      const [freq, every] = draft.repeat.split(':');
      const d = parseISO(date);
      const isLast = d.getDate() === lastDayOfMonth(d.getFullYear(), d.getMonth() + 1);
      const r = { id: uid('p'), ...base, freq, every: +every, day: freq === 'month' ? (isLast ? 31 : d.getDate()) : null, start: date, end: null, active: true };
      r.next = date <= today() ? nextAfter(r, date) : date;
      await put('recurring', r);
      recurringId = r.id;
      msg = date <= today() ? `${msg}, si ripeterà dal ${fmtDate(r.next)}` : `Programmata dal ${fmtDate(date)}`;
    }
    let saved = null;
    if (!draft.repeat || date <= today()) saved = await put('transactions', { id: uid('t'), ...base, source: 'manual', bank: null, importKey: null, recurringId });
    draft.digits = ''; draft.categoryId = null; draft.note = ''; draft.repeat = '';
    if (draft.type === 'transfer') draft.type = 'expense';
    draw();
    toast(msg, saved ? { action: 'Annulla', onAction: () => del('transactions', saved.id) } : {});
  }

  function summarySheet() {
    const key = ym(today());
    const { inc, exp, net } = monthTotals(key);
    const pct = inc > 0 ? Math.round((exp / inc) * 100) : null;
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="kv"><span>Entrate</span><b class="inc">${fmtEur(inc)}</b></div>
      <div class="kv"><span>Uscite</span><b class="exp">${fmtEur(exp)}</b></div>
      <div class="kv"><span>Bilancio</span><b>${fmtEur(net, { sign: true })}</b></div>
      <div class="ratio ${pct != null && pct > 100 ? 'over' : ''}" style="margin-top:4px"><span style="width:${Math.min(100, pct ?? (exp > 0 ? 100 : 0))}%"></span></div>
      <p class="tiny muted" style="margin:7px 0 14px">${!inc && !exp ? 'Nessun movimento questo mese' : !inc ? 'Nessuna entrata registrata questo mese' : exp > inc ? `Uscite superiori alle entrate di ${fmtEur(exp - inc)}` : `Hai speso il ${pct}% di quanto è entrato`}</p>
      ${activeAccounts().map((a) => `<div class="kv"><span>Saldo ${esc(a.name)}</span><b>${fmtEur(balance(a.id))}</b></div>`).join('')}
      <a class="btn block ghost" href="#/movimenti" style="margin-top:14px">Vedi i movimenti</a>`;
    const sh = sheet({ title: cap(ymLabel(key)), body });
    body.querySelector('a').addEventListener('click', () => sh.close());
  }

  function optionsSheet() {
    const f = document.createElement('form');
    f.className = 'stack';
    const multi = activeAccounts().length > 1;
    f.innerHTML = `
      ${draft.type !== 'transfer' ? `<label class="field"><span>Ripeti</span><select class="input" name="rep">${REPEATS.map(([v, l]) => `<option value="${v}" ${draft.repeat === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <p class="tiny muted" style="margin-top:6px">Le ripetizioni vengono aggiunte da sole il giorno previsto. Le trovi in Altro → Spese ricorrenti.</p>` : ''}
      ${multi && draft.type !== 'transfer' ? `<label class="field"><span>Conto</span><select class="input" name="acc">${accountOptions(draft.accountId)}</select></label>` : ''}
      ${draft.type !== 'transfer' ? '<button type="button" class="btn line block" data-tr>↔ Giroconto tra i tuoi conti</button>' : ''}
      <button class="btn block">Fatto</button>`;
    const sh = sheet({ title: 'Opzioni', body: f });
    f.querySelector('[data-tr]')?.addEventListener('click', async () => {
      sh.close();
      if (activeAccounts().length < 2) {
        const name = await promptDialog({ title: 'Serve un secondo conto', text: 'Un giroconto sposta soldi tra due conti tuoi e non conta come spesa. Come si chiama l\'altro conto?', placeholder: 'Es. Contanti, Conto deposito', ok: 'Crea conto' });
        if (!name?.trim()) return;
        const a = await put('accounts', { id: uid('a'), name: name.trim(), kind: /contant/i.test(name) ? 'cash' : 'other', ref: null, order: S.accounts.length, archived: false });
        draft.toAccountId = a.id;
      }
      draft.type = 'transfer'; draft.categoryId = null; draft.repeat = '';
      draw();
    });
    f.onsubmit = (e) => {
      e.preventDefault();
      const rep = f.querySelector('[name=rep]');
      const acc = f.querySelector('[name=acc]');
      if (rep) draft.repeat = rep.value;
      if (acc) draft.accountId = acc.value;
      sh.close();
      draw();
    };
  }

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !el.contains(b)) return;
    if (b.dataset.k) { press(b.dataset.k); return; }
    if (b.dataset.type) {
      if (b.dataset.type !== draft.type) { draft.type = b.dataset.type; draft.categoryId = null; }
      draw();
      return;
    }
    if (b.dataset.cat) {
      draft.categoryId = draft.categoryId === b.dataset.cat ? null : b.dataset.cat;
      el.querySelectorAll('.qe-chip[data-cat]').forEach((x) => x.classList.toggle('on', x.dataset.cat === draft.categoryId));
      return;
    }
    const act = b.dataset.act;
    if (act === 'save') save();
    else if (act === 'summary') summarySheet();
    else if (act === 'options') optionsSheet();
    else if (act === 'morecats') {
      const r = await pickCategory({ type: draft.type, current: draft.categoryId });
      if (r?.categoryId) { draft.categoryId = r.categoryId; draw(); }
    } else if (act === 'note') {
      const v = await promptDialog({ title: 'Nota', value: draft.note, placeholder: 'Es. Pizza con gli amici', ok: 'Fatto' });
      if (v != null) { draft.note = v.trim().slice(0, 140); draw(); }
    }
  });

  el.addEventListener('change', (e) => {
    const f = e.target.dataset.f;
    if (f === 'date') { draft.date = e.target.value && e.target.value !== today() ? e.target.value : null; draw(); }
    if (f === 'from') { draft.accountId = e.target.value; draw(); }
    if (f === 'to') draft.toAccountId = e.target.value;
  });

  // tieni premuto ⌫ per azzerare
  let hold = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-k="⌫"]')) hold = setTimeout(() => { draft.digits = ''; updateAmount(); hold = null; }, 550);
  });
  const stopHold = () => { clearTimeout(hold); hold = null; };
  el.addEventListener('pointerup', stopHold);
  el.addEventListener('pointercancel', stopHold);

  // tastiera fisica (utile su computer e per i test)
  const onKey = (e) => {
    if (document.querySelector('dialog[open]') || e.target.closest?.('input, select, textarea')) return;
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === ',' || e.key === '.') press(',');
    else if (e.key === 'Backspace') press('⌫');
    else if (e.key === 'Enter') save();
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  draw();
  // dati cambiati altrove (es. ricorrenze, annulla): aggiorna solo l'intestazione
  route.home_live = () => { const h = el.querySelector('.qe-head'); if (h) h.outerHTML = header(); };
  return () => document.removeEventListener('keydown', onKey);
}, { live: () => route.home_live?.() });
