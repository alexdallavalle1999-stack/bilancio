// Logica di dominio: saldi, totali, ricorrenze, categorie predefinite
import { S, put, putMany, setSetting } from './store.js';
import { today, addDays, addMonths, parseISO, iso, uid, ym, ymAdd } from './util.js';

export const DEFAULT_CATEGORIES = [
  ['expense', 'Spesa alimentare', '🛒', '#2A78D6'],
  ['expense', 'Casa e affitto', '🏠', '#6250D6'],
  ['expense', 'Bollette', '💡', '#EDA100'],
  ['expense', 'Trasporti', '🚌', '#1BAF7A'],
  ['expense', 'Carburante', '⛽', '#EB6834'],
  ['expense', 'Ristoranti e bar', '🍔', '#E34948'],
  ['expense', 'Salute', '💊', '#E87BA4'],
  ['expense', 'Svago', '🎭', '#008300'],
  ['expense', 'Abbigliamento', '👕', '#2A78D6'],
  ['expense', 'Abbonamenti', '📱', '#6250D6'],
  ['expense', 'Regali', '🎁', '#E87BA4'],
  ['expense', 'Tasse e burocrazia', '📄', '#EDA100'],
  ['expense', 'Altro', '📦', '#898781'],
  ['income', 'Stipendio', '💼', '#1BAF7A'],
  ['income', 'Rimborsi', '↩️', '#2A78D6'],
  ['income', 'Regali', '🎁', '#E87BA4'],
  ['income', 'Interessi', '📈', '#008300'],
  ['income', 'Altro', '📦', '#898781'],
];

export async function ensureDefaults() {
  if (!S.accounts.length) {
    await put('accounts', { id: 'conto', name: 'Conto corrente', kind: 'bank', ref: null, order: 0, archived: false });
    await setSetting('defaultAccountId', 'conto');
  }
  if (!S.categories.length) {
    await putMany('categories', DEFAULT_CATEGORIES.map(([type, name, icon, color], i) => ({ id: uid('c'), type, name, icon, color, order: i, archived: false })));
  }
  if (!S.settings.defaultAccountId || !S.acc.has(S.settings.defaultAccountId)) {
    await setSetting('defaultAccountId', S.accounts[0].id);
  }
}

export const catOf = (t) => (t.categoryId ? S.cat.get(t.categoryId) : null);
export const accName = (id) => S.acc.get(id)?.name ?? 'Conto';
export const activeAccounts = () => S.accounts.filter((a) => !a.archived);
export const catsOfType = (type, { includeArchived = false } = {}) =>
  S.categories.filter((c) => c.type === type && (includeArchived || !c.archived));

// Effetto di un movimento sul saldo di un conto
function delta(t, accId) {
  if (t.type === 'expense') return t.accountId === accId ? -t.amount : 0;
  if (t.type === 'income') return t.accountId === accId ? t.amount : 0;
  if (t.type === 'transfer') return (t.toAccountId === accId ? t.amount : 0) - (t.accountId === accId ? t.amount : 0);
  return 0;
}

// Saldo = saldo di riferimento (allineato con la banca) + movimenti successivi fino a oggi
export function balance(accId, upTo = today()) {
  const a = S.acc.get(accId);
  if (!a) return 0;
  const since = a.ref?.date ?? '0000-00-00';
  let b = a.ref?.amount ?? 0;
  for (const t of S.transactions) if (t.date > since && t.date <= upTo) b += delta(t, accId);
  return b;
}

export function totalBalance() {
  return activeAccounts().reduce((s, a) => s + balance(a.id), 0);
}

export function monthTotals(key) {
  let inc = 0, exp = 0, n = 0;
  for (const t of S.transactions) {
    if (!t.date.startsWith(key)) continue;
    if (t.type === 'income') { inc += t.amount; n++; }
    else if (t.type === 'expense') { exp += t.amount; n++; }
  }
  return { inc, exp, net: inc - exp, n };
}

// Categorie ordinate per frequenza d'uso recente (per l'inserimento rapido)
export function rankedCategories(type) {
  const since = addDays(today(), -180);
  const score = new Map();
  for (const t of S.transactions) {
    if (t.type !== type || !t.categoryId) continue;
    const w = t.date >= since ? 3 : 0.2;
    score.set(t.categoryId, (score.get(t.categoryId) || 0) + w);
  }
  return catsOfType(type).slice().sort((a, b) => (score.get(b.id) || 0) - (score.get(a.id) || 0) || (a.order ?? 0) - (b.order ?? 0));
}

export const uncategorized = () => S.transactions.filter((t) => t.type !== 'transfer' && !t.categoryId);

export function txTitle(t) {
  if (t.type === 'transfer') return `${accName(t.accountId)} → ${accName(t.toAccountId)}`;
  const c = catOf(t);
  if (c) return c.name;
  return t.note || (t.bank ? t.bank.split(' · ')[0] : '') || 'Da classificare';
}
export function txSubtitle(t) {
  if (!catOf(t) && t.type !== 'transfer') {
    const rest = t.bank ? t.bank.split(' · ').slice(1).join(' · ') : '';
    return t.note && t.bank ? t.bank : rest;
  }
  return t.note || t.bank || '';
}

/* ---------- Ricorrenze ---------- */

export const FREQ_LABEL = { day: 'giorno', week: 'settimana', month: 'mese', year: 'anno' };
export const FREQ_PLURAL = { day: 'giorni', week: 'settimane', month: 'mesi', year: 'anni' };

export function describeRecurring(r) {
  const every = r.every > 1 ? `Ogni ${r.every} ${FREQ_PLURAL[r.freq]}` : `Ogni ${FREQ_LABEL[r.freq]}`;
  if (r.freq === 'month') return `${every}, il giorno ${r.day >= 31 ? 'ultimo' : r.day}`.replace('il giorno ultimo', "l'ultimo giorno");
  if (r.freq === 'week') {
    const wd = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'][parseISO(r.start).getDay()];
    return `${every}, di ${wd}`;
  }
  return every;
}

export function nextAfter(r, date) {
  const n = r.every || 1;
  if (r.freq === 'day') return addDays(date, n);
  if (r.freq === 'week') return addDays(date, 7 * n);
  if (r.freq === 'year') return addMonths(date, 12 * n, parseISO(r.start).getDate());
  return addMonths(date, n, r.day ?? parseISO(r.start).getDate());
}

// Prima occorrenza >= start, con il giorno del mese corretto
export function firstOccurrence(r) {
  if (r.freq !== 'month') return r.start;
  const d = parseISO(r.start);
  const day = r.day ?? d.getDate();
  const candidate = addMonths(iso(new Date(d.getFullYear(), d.getMonth(), 1)), 0, day);
  return candidate >= r.start ? candidate : addMonths(candidate, 1, day);
}

// Crea i movimenti ricorrenti scaduti (fino a oggi). Ritorna quanti ne ha creati.
export async function runRecurring() {
  const t0 = today();
  const created = [];
  const changed = [];
  for (const r of S.recurring) {
    if (!r.active || !r.next) continue;
    let next = r.next;
    let guard = 0;
    while (next <= t0 && (!r.end || next <= r.end) && guard++ < 400) {
      created.push({
        id: uid('t'), type: r.type, amount: r.amount, date: next,
        categoryId: r.type === 'transfer' ? null : r.categoryId, accountId: r.accountId,
        toAccountId: r.type === 'transfer' ? r.toAccountId : null,
        note: r.note || '', source: 'recurring', bank: null, importKey: null, recurringId: r.id,
      });
      next = nextAfter(r, next);
    }
    if (next !== r.next) {
      const upd = { ...r, next };
      if (r.end && next > r.end) upd.active = false;
      changed.push(upd);
    }
  }
  if (created.length) await putMany('transactions', created);
  if (changed.length) await putMany('recurring', changed);
  return created.length;
}

/* ---------- Serie per le statistiche ---------- */

export function firstMonth() {
  return S.transactions.length ? ym(S.transactions[0].date) : ym(today());
}

export function monthRange(from, to) {
  const out = [];
  for (let k = from; k <= to; k = ymAdd(k, 1)) out.push(k);
  return out;
}

// Totali mensili per tipo e filtro categorie (Set di id o null = tutte)
export function monthlySeries(type, months, catFilter = null) {
  const idx = new Map(months.map((m, i) => [m, i]));
  const vals = months.map(() => 0);
  for (const t of S.transactions) {
    if (t.type !== type) continue;
    if (catFilter && !catFilter.has(t.categoryId ?? '__none')) continue;
    const i = idx.get(ym(t.date));
    if (i != null) vals[i] += t.amount;
  }
  return vals;
}

export function movingAverage(vals, k) {
  return vals.map((_, i) => {
    if (i < k - 1) return null;
    let s = 0;
    for (let j = i - k + 1; j <= i; j++) s += vals[j];
    return Math.round(s / k);
  });
}

export function years() {
  const set = new Set(S.transactions.map((t) => t.date.slice(0, 4)));
  set.add(today().slice(0, 4));
  return [...set].sort();
}
