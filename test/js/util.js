// Utility comuni: formati italiani, date, id, DOM

export const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
export const MONTHS_SHORT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
export const WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

const pad = (n) => String(n).padStart(2, '0');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export { cap };

// 123456 -> "1.234,56" (separatore delle migliaia sempre, anche sotto i 10.000)
export function fmtNum(cents, { decimals = 2 } = {}) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  let int = Math.floor(abs / 100);
  let dec = abs % 100;
  if (decimals === 0) { int = Math.round(abs / 100); }
  const intStr = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const s = decimals === 0 ? intStr : `${intStr},${pad(dec)}`;
  return (neg ? '−' : '') + s;
}

// Euro con segno opzionale: "1.234,56 €", "+12,00 €", "−6,99 €"
export function fmtEur(cents, { sign = false, decimals = 2 } = {}) {
  const s = fmtNum(Math.abs(cents), { decimals });
  const pre = cents < 0 ? '−' : sign && cents > 0 ? '+' : '';
  return `${pre}${s} €`;
}

// Interpreta l'input dell'utente ("6,99", "1.234,5", "12.5") in centesimi
export function parseAmount(str) {
  let s = String(str || '').trim().replace(/[€\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  else if (/^\d{1,3}\.\d{3}$/.test(s)) s = s.replace('.', '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function centsToInput(cents) {
  if (cents == null) return '';
  const abs = Math.abs(cents);
  return abs % 100 === 0 ? String(abs / 100) : (abs / 100).toFixed(2).replace('.', ',');
}

/* ---- Date (sempre stringhe locali "YYYY-MM-DD") ---- */

export function iso(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export const today = () => iso(new Date());
export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s, n) {
  const d = parseISO(s);
  d.setDate(d.getDate() + n);
  return iso(d);
}
export function daysBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}
export function lastDayOfMonth(y, m /* 1-12 */) {
  return new Date(y, m, 0).getDate();
}
// Aggiunge mesi mantenendo il giorno desiderato (31 -> ultimo giorno del mese)
export function addMonths(s, n, day) {
  const d = parseISO(s);
  let y = d.getFullYear();
  let m = d.getMonth() + 1 + n;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12 + 12) % 12 + 1;
  const dd = Math.min(day ?? d.getDate(), lastDayOfMonth(y, m));
  return `${y}-${pad(m)}-${pad(dd)}`;
}
export const ym = (s) => s.slice(0, 7);
export function ymAdd(k, n) {
  let [y, m] = k.split('-').map(Number);
  m += n;
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12 + 12) % 12 + 1;
  return `${y}-${pad(m)}`;
}
export function ymLabel(k, { short = false, year = true } = {}) {
  const [y, m] = k.split('-').map(Number);
  const name = short ? MONTHS_SHORT[m - 1] : MONTHS[m - 1];
  return year ? `${name} ${short ? String(y).slice(2) : y}` : name;
}
// "06/10/2026"
export function fmtDate(s) {
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}
// "Oggi", "Ieri", "lunedì 5 ottobre"
export function fmtDay(s) {
  const t = today();
  if (s === t) return 'Oggi';
  if (s === addDays(t, -1)) return 'Ieri';
  const d = parseISO(s);
  const base = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date().getFullYear() ? cap(base) : `${cap(base)} ${d.getFullYear()}`;
}
export function fmtDayShort(s) {
  const d = parseISO(s);
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

/* ---- Varie ---- */

let _seq = 0;
export function uid(prefix = '') {
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  return prefix + Date.now().toString(36) + (_seq++ % 1296).toString(36).padStart(2, '0') + rnd[0].toString(36).slice(0, 5);
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function plural(n, one, many) {
  return `${fmtNum(n * 100, { decimals: 0 })} ${n === 1 ? one : many}`;
}

export function norm(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

export function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src;
    s.dataset.src = src;
    s.onload = () => res();
    s.onerror = () => rej(new Error('Impossibile caricare ' + src));
    document.head.appendChild(s);
  });
}
