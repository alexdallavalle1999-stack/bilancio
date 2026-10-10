// Sezione Dati: andamento con media mobile, ripartizione per voce, confronti tra anni.
// Si possono escludere mesi (o singoli valori) dai grafici, per togliere le spese eccezionali.
import { route, go } from './app.js';
import { S } from './store.js';
import { monthlySeries, monthRange, firstMonth, catsOfType, years as dataYears } from './model.js';
import { $, esc, fmtNum, fmtEur, today, ym, ymAdd, ymLabel, MONTHS, MONTHS_SHORT, cap, plural } from './util.js';
import { sheet } from './ui.js';
import { drawChart } from './charts.js';

// Palette categoriale validata (chiaro / scuro), assegnata agli anni in ordine fisso
const CAT_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const CAT_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

const charts = [];
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const isDark = () => document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
const yearColor = (y) => (isDark() ? CAT_DARK : CAT_LIGHT)[((+today().slice(0, 4) - +y) % 8 + 8) % 8];
const compact = (cents) => { const v = cents / 100; return Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })}k` : v.toLocaleString('it-IT', { maximumFractionDigits: 0 }); };
const money = (v) => fmtEur(v);
const pct = (a, b) => (a ? Math.round(((b - a) / Math.abs(a)) * 1000) / 10 : null);
const pctTxt = (d) => (d == null ? '—' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toLocaleString('it-IT')}%`);

function destroyCharts() { while (charts.length) charts.pop().destroy(); }

/* ---------- Mesi esclusi ('YYYY-MM' = un mese, '*-MM' = quel mese in ogni anno) ---------- */

const EX_KEY = 'bilancio.esclusi';
const excl = new Set((() => { try { return JSON.parse(localStorage.getItem(EX_KEY) || '[]'); } catch { return []; } })());
const isEx = (m) => excl.has(m) || excl.has(`*-${m.slice(5, 7)}`);
const exKeyFor = (m) => (excl.has(`*-${m.slice(5, 7)}`) ? `*-${m.slice(5, 7)}` : m);
const exLabel = (k) => (k.startsWith('*-') ? `${MONTHS[+k.slice(2) - 1]} di ogni anno` : ymLabel(k));
let rerender = () => {};
let keepSel = null;
function saveEx() { try { localStorage.setItem(EX_KEY, JSON.stringify([...excl])); } catch { /* resta solo per questa sessione */ } }
function toggleEx(k) { if (excl.has(k)) excl.delete(k); else excl.add(k); saveEx(); rerender(); }
function clearEx() { excl.clear(); saveEx(); rerender(); }
const masked = (vals, months) => vals.map((v, i) => (isEx(months[i]) ? null : v));
const sumOf = (vals) => vals.reduce((a, v) => a + (v ?? 0), 0);
const countOf = (vals) => vals.filter((v) => v != null).length;
const avgOf = (vals) => (countOf(vals) ? Math.round(sumOf(vals) / countOf(vals)) : 0);
// media mobile che salta i mesi esclusi
function movAvg(vals, k) {
  return vals.map((_, i) => {
    if (i < k - 1) return null;
    let s = 0, n = 0;
    for (let j = i - k + 1; j <= i; j++) if (vals[j] != null) { s += vals[j]; n++; }
    return n ? Math.round(s / n) : null;
  });
}

function exBar() {
  if (!excl.size) return '';
  const keys = [...excl].sort();
  return `<div class="exbar"><span class="small ink2">Esclusi dai grafici:</span>
    ${keys.map((k) => `<button class="chip on" data-ex="${esc(k)}" aria-label="Rimetti ${esc(exLabel(k))}">${esc(exLabel(k))} ✕</button>`).join('')}
    <button class="link" data-exall>Rimetti tutti</button></div>`;
}

/* ---------- Grafici e tabelle ---------- */

const barDs = (name, values, color, extra = {}) => ({ type: 'bar', name, values, ...(Array.isArray(color) ? { colors: color } : { color }), ...extra });
const lineDs = (name, values, color, extra = {}) => ({ type: 'line', name, values, color, ...extra });

function plot(container, cfg) {
  const box = container.querySelector('.chart-box');
  try {
    const c = drawChart(box, {
      axis: compact, value: money, isOff: isEx, onToggle: (k) => toggleEx(k), onSelect: (i) => { keepSel = i; },
      ...cfg, select: keepSel ?? cfg.select,
    });
    charts.push(c);
    return c;
  } catch (e) {
    console.error(e);
    box.innerHTML = `<div class="empty small">Grafico non disponibile: ${esc(e.message)}</div>`;
    return null;
  }
}

// rows: [{ label, key?, cells: [{ v, key? }] }]
let tableOpen = false;
function tableHtml(head, rows) {
  const tg = (key, html) => (key ? `<button class="tg ${isEx(key) ? 'off' : ''}" data-ex="${esc(exKeyFor(key))}">${html}</button>` : html);
  return `<details class="vals" ${tableOpen ? 'open' : ''}><summary class="small ink2">Tabella dei valori</summary>
    <p class="tiny muted" style="margin:4px 4px 2px">Tocca un mese o un valore per toglierlo dal grafico e dalle medie; toccalo di nuovo per rimetterlo.</p>
    <div class="table-wrap"><table class="data"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr class="${r.key && isEx(r.key) ? 'off' : ''}"><td>${tg(r.key, esc(r.label))}</td>${r.cells.map((c) => `<td>${c.key ? tg(c.key, c.v) : c.v}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
}

const cell = (v) => (v == null ? '—' : fmtNum(v));

function catOptions(type, selected) {
  return catsOfType(type, { includeArchived: true }).slice().sort((a, b) => a.name.localeCompare(b.name, 'it'))
    .map((c) => `<option value="${c.id}" ${c.id === selected ? 'selected' : ''}>${esc(c.icon || '')} ${esc(c.name)}</option>`).join('');
}

/* ======================= Pagina ======================= */

const state = {
  tab: 'trend',
  trend: { period: '24', show: 'both', cat: '', ma: '3' },
  cats: { period: 'y0', type: 'expense', month: null },
  cmp: { mode: 'years', voce: 'exp', years: null, cumulative: false, month: String(new Date().getMonth() + 1) },
};

route('dati', async (root) => {
  if (!S.transactions.length) {
    root.innerHTML = `<div class="page-head"><h1>Dati</h1></div><div class="empty card"><h3>Ancora nessun dato</h3><p class="small">Inserisci qualche movimento o ripristina un backup per vedere grafici e confronti.</p></div>`;
    return;
  }
  root.innerHTML = `<div class="page-head"><h1>Dati</h1></div>
    <div class="seg stat-tabs">${[['trend', 'Andamento'], ['cats', 'Voci'], ['cmp', 'Confronta']].map(([k, l]) => `<button data-tab="${k}" class="${state.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="exbar"></div>
    <div id="stat"></div>`;
  const render = () => {
    destroyCharts();
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
    $('#exbar').innerHTML = exBar();
    ({ trend: renderTrend, cats: renderCats, cmp: renderCmp })[state.tab]($('#stat'));
  };
  rerender = render;
  root.querySelector('.stat-tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { state.tab = b.dataset.tab; keepSel = null; render(); } };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ex], [data-exall]');
    if (!b || b.closest('.cx-read')) return;
    if ('exall' in b.dataset) clearEx(); else toggleEx(b.dataset.ex);
  });
  root.addEventListener('toggle', (e) => { if (e.target.matches?.('details.vals')) tableOpen = e.target.open; }, true);
  render();
  return destroyCharts;
}, { live: false });

/* ---------- Andamento ---------- */

function renderTrend(el) {
  const s = state.trend;
  const typeForCat = s.show === 'income' ? 'income' : 'expense';
  el.innerHTML = `<div class="filters">
      <select class="input" data-k="period" aria-label="Periodo">${[['12', 'Ultimi 12 mesi'], ['24', 'Ultimi 24 mesi'], ['60', 'Ultimi 5 anni'], ['all', 'Tutto']].map(([v, l]) => `<option value="${v}" ${s.period === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="input" data-k="ma" aria-label="Media mobile">${[['0', 'Senza media'], ['3', 'Media 3 mesi'], ['6', 'Media 6 mesi'], ['12', 'Media 12 mesi']].map(([v, l]) => `<option value="${v}" ${s.ma === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="input" data-k="show" aria-label="Cosa mostrare">${[['both', 'Entrate e uscite'], ['expense', 'Uscite'], ['income', 'Entrate'], ['net', 'Risparmio']].map(([v, l]) => `<option value="${v}" ${s.show === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select class="input" data-k="cat" aria-label="Voce" ${s.show === 'both' || s.show === 'net' ? 'disabled' : ''}><option value="">Tutte le voci</option>${catOptions(typeForCat, s.cat)}</select>
    </div>
    <div class="card chart-card"><div class="chart-title"><h3 id="ttl"></h3><p id="sub"></p></div><div class="chart-box"></div><div class="kpis" id="kpi"></div><div id="tbl"></div></div>`;
  el.querySelector('.filters').onchange = (e) => {
    const k = e.target.dataset.k;
    s[k] = e.target.value;
    if (k === 'show') s.cat = '';
    keepSel = null;
    rerender();
  };

  const end = ym(today());
  const start = s.period === 'all' ? firstMonth() : ymAdd(end, -(+s.period) + 1);
  const months = monthRange(start, end);
  const ma = +s.ma;
  // per la media mobile servono anche i mesi prima dell'inizio del grafico
  const pre = ma ? monthRange(ymAdd(start, -(ma - 1)), end) : months;
  const off = pre.length - months.length;
  const filt = s.cat ? new Set([s.cat]) : null;
  const expAll = masked(monthlySeries('expense', pre, s.show === 'expense' ? filt : null), pre);
  const incAll = masked(monthlySeries('income', pre, s.show === 'income' ? filt : null), pre);
  const exp = expAll.slice(off), inc = incAll.slice(off);
  const labels = months.map((m) => { const [y, mm] = m.split('-'); return mm === '01' || months.length <= 13 ? `${MONTHS_SHORT[+mm - 1]} ${y.slice(2)}` : MONTHS_SHORT[+mm - 1]; });
  const cE = css('--exp'), cI = css('--inc'), cInk = css('--ink-2');
  const fade = ma ? 0.5 : 1;
  const catName = s.cat ? S.cat.get(s.cat)?.name : null;
  const ds = [];
  let title, kpis, tHead, rows;
  const n = months.filter((m) => !isEx(m)).length;
  const per = (v) => Math.round(v / (n || 1));
  if (s.show === 'both') {
    ds.push(barDs('Entrate', inc, cI, { opacity: fade }), barDs('Uscite', exp, cE, { opacity: fade }));
    if (ma) ds.push(lineDs(`Media entrate (${ma} mesi)`, movAvg(incAll, ma).slice(off), cI), lineDs(`Media uscite (${ma} mesi)`, movAvg(expAll, ma).slice(off), cE));
    title = 'Entrate e uscite per mese';
    const ti = sumOf(inc), te = sumOf(exp);
    kpis = [['Entrate medie', fmtEur(per(ti), { decimals: 0 })], ['Uscite medie', fmtEur(per(te), { decimals: 0 })], ['Risparmio medio', fmtEur(per(ti - te), { decimals: 0, sign: true })]];
    tHead = ['Mese', 'Entrate', 'Uscite', 'Risparmio'];
    rows = months.map((m, i) => ({ label: cap(ymLabel(m)), key: m, cells: [{ v: cell(inc[i]) }, { v: cell(exp[i]) }, { v: inc[i] == null ? '—' : fmtNum(inc[i] - exp[i]) }] }));
  } else if (s.show === 'net') {
    const netAll = incAll.map((v, i) => (v == null || expAll[i] == null ? null : v - expAll[i]));
    const net = netAll.slice(off);
    ds.push(barDs('Risparmio', net, net.map((v) => (v >= 0 ? cI : cE)), { opacity: fade }));
    const mav = ma ? movAvg(netAll, ma).slice(off) : [];
    if (ma) ds.push(lineDs(`Media ${ma} mesi`, mav, cInk));
    title = 'Risparmio per mese (entrate − uscite)';
    const tot = sumOf(net);
    const pos = net.filter((v) => v != null && v > 0).length;
    kpis = [['Totale periodo', fmtEur(tot, { decimals: 0, sign: true })], ['Media al mese', fmtEur(per(tot), { decimals: 0, sign: true })], ['Mesi in attivo', `${pos} su ${n}`]];
    tHead = ['Mese', 'Risparmio', ...(ma ? [`Media ${ma}m`] : [])];
    rows = months.map((m, i) => ({ label: cap(ymLabel(m)), key: m, cells: [{ v: cell(net[i]) }, ...(ma ? [{ v: cell(mav[i]) }] : [])] }));
  } else {
    const isE = s.show === 'expense';
    const all = isE ? expAll : incAll;
    const v = isE ? exp : inc;
    const col = isE ? cE : cI;
    const word = isE ? 'Uscite' : 'Entrate';
    ds.push(barDs(catName || word, v, col, { opacity: fade }));
    const mav = ma ? movAvg(all, ma).slice(off) : [];
    if (ma) ds.push(lineDs(`Media ${ma} mesi`, mav, cInk));
    title = catName ? `${catName}: ${word.toLowerCase()} per mese` : `${word} per mese`;
    const tot = sumOf(v);
    let maxI = -1; v.forEach((x, i) => { if (x != null && (maxI < 0 || x > v[maxI])) maxI = i; });
    kpis = [['Totale periodo', fmtEur(tot, { decimals: 0 })], ['Media al mese', fmtEur(per(tot), { decimals: 0 })], ['Mese più alto', maxI >= 0 && v[maxI] ? cap(ymLabel(months[maxI], { short: true })) : '—']];
    tHead = ['Mese', catName || word, ...(ma ? [`Media ${ma}m`] : [])];
    rows = months.map((m, i) => ({ label: cap(ymLabel(m)), key: m, cells: [{ v: cell(v[i]) }, ...(ma ? [{ v: cell(mav[i]) }] : [])] }));
  }
  const exN = months.length - n;
  $('#ttl').textContent = title;
  $('#sub').textContent = `${cap(ymLabel(months[0]))} – ${ymLabel(months[months.length - 1])}${months[months.length - 1] === ym(today()) ? ' (mese in corso)' : ''}${exN ? ` · ${plural(exN, 'mese escluso', 'mesi esclusi')}` : ''}`;
  $('#kpi').innerHTML = kpis.map(([a, b]) => `<div><span>${esc(a)}</span><b>${b}</b></div>`).join('');
  $('#tbl').innerHTML = tableHtml(tHead, rows.reverse());
  plot(el, {
    labels, tips: months.map((m) => cap(ymLabel(m))), series: ds, label: title,
    extra: (i) => ({ key: exKeyFor(months[i]), label: isEx(months[i]) ? 'Rimetti nel grafico' : 'Escludi questo mese' }),
  });
}

/* ---------- Voci ---------- */

function periodRange(p) {
  const t = today();
  const y = t.slice(0, 4);
  if (p === 'm0') return [ym(t), ym(t), cap(ymLabel(ym(t)))];
  if (p === 'm1') { const m = ymAdd(ym(t), -1); return [m, m, cap(ymLabel(m))]; }
  if (p === 'y0') return [`${y}-01`, ym(t), `${y} (da gennaio a oggi)`];
  if (p === '12') return [ymAdd(ym(t), -11), ym(t), 'Ultimi 12 mesi'];
  if (p === 'all') return [firstMonth(), ym(t), 'Da sempre'];
  if (p.startsWith('y-')) { const yy = p.slice(2); return [`${yy}-01`, `${yy}-12`, `Anno ${yy}`]; }
  if (p.startsWith('m-')) { const m = p.slice(2); return [m, m, cap(ymLabel(m))]; }
  return [ym(t), ym(t), ''];
}

function renderCats(el) {
  const s = state.cats;
  const yrs = dataYears().filter((y) => y < today().slice(0, 4)).reverse();
  const opts = [['m0', 'Questo mese'], ['m1', 'Mese scorso'], ['y0', 'Quest\'anno'], ['12', 'Ultimi 12 mesi'], ...yrs.map((y) => [`y-${y}`, `Anno ${y}`]), ['all', 'Da sempre']];
  if (s.period.startsWith('m-')) opts.unshift([s.period, cap(ymLabel(s.period.slice(2)))]);
  el.innerHTML = `<div class="filters">
      <select class="input" data-k="period">${opts.map(([v, l]) => `<option value="${v}" ${s.period === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <label class="input" style="position:relative;display:flex;align-items:center;min-height:42px;font-size:14.5px">Scegli un mese…<input type="month" data-k="month" style="position:absolute;inset:0;opacity:0"></label>
      <div class="seg full t-${s.type}">${[['expense', 'Uscite'], ['income', 'Entrate']].map(([v, l]) => `<button data-type="${v}" class="${s.type === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div><div id="catbody"></div>`;
  el.querySelector('.filters').addEventListener('change', (e) => {
    if (e.target.dataset.k === 'period') s.period = e.target.value;
    if (e.target.dataset.k === 'month' && e.target.value) s.period = `m-${e.target.value}`;
    rerender();
  });
  el.querySelectorAll('[data-type]').forEach((b) => (b.onclick = () => { s.type = b.dataset.type; rerender(); }));

  const [from, to, label] = periodRange(s.period);
  const sums = new Map();
  let total = 0;
  for (const t of S.transactions) {
    if (t.type !== s.type) continue;
    const m = ym(t.date);
    if (m < from || m > to || isEx(m)) continue;
    const k = t.categoryId || '__none';
    const x = sums.get(k) || { sum: 0, n: 0 };
    x.sum += t.amount; x.n++;
    sums.set(k, x);
    total += t.amount;
  }
  const list = [...sums.entries()].sort((a, b) => b[1].sum - a[1].sum);
  const nMonths = monthRange(from, to).filter((m) => !isEx(m)).length;
  const body = $('#catbody');
  if (!list.length) { body.innerHTML = `<div class="empty card"><h3>Nessun movimento</h3><p class="small">${esc(label)}: nessuna ${s.type === 'expense' ? 'uscita' : 'entrata'}.</p></div>`; return; }
  const max = list[0][1].sum;
  body.innerHTML = `<div class="card">
      <div class="chart-title"><p>${esc(label)}</p><h2 class="num" style="font-size:28px;margin-top:2px">${fmtEur(total)}</h2>
      ${nMonths > 1 ? `<p>Media ${fmtEur(Math.round(total / nMonths), { decimals: 0 })} al mese su ${nMonths} mesi</p>` : ''}</div>
      <div class="bars t-${s.type}" style="margin-top:10px">${list.map(([id, x]) => {
        const c = S.cat.get(id);
        const p = total ? Math.round((x.sum / total) * 1000) / 10 : 0;
        return `<button class="bar-row" data-cat="${id}"><span class="nm">${esc(c?.icon || '❔')} ${esc(c?.name || 'Da classificare')}</span><span class="vl">${fmtNum(x.sum)} €</span>
          <span class="track"><span style="width:${Math.max(1.5, (x.sum / max) * 100)}%"></span></span>
          <span class="pc">${p.toLocaleString('it-IT')}% · ${plural(x.n, 'movimento', 'movimenti')}</span></button>`;
      }).join('')}</div></div>
    <p class="tiny muted" style="margin:10px 4px">Tocca una voce per vederne l'andamento.</p>`;
  body.querySelector('.bars').onclick = (e) => {
    const b = e.target.closest('[data-cat]');
    if (b && b.dataset.cat !== '__none') categoryDetail(b.dataset.cat);
    else if (b) go('#/movimenti?f=none');
  };
}

function categoryDetail(id) {
  const c = S.cat.get(id);
  const end = ym(today());
  const months = monthRange(ymAdd(end, -23), end);
  const pre = monthRange(ymAdd(end, -25), end);
  const all = masked(monthlySeries(c.type, pre, new Set([id])), pre);
  const v = all.slice(2);
  const mav = movAvg(all, 3).slice(2);
  const col = css(c.type === 'expense' ? '--exp' : '--inc');
  const first = firstMonth();
  const perYear = dataYears().map((y) => {
    let sum = 0, n = 0;
    for (const t of S.transactions) if (t.categoryId === id && t.date.startsWith(y) && !isEx(ym(t.date))) { sum += t.amount; n++; }
    const ms = monthRange(`${y}-01`, `${y}-12`).filter((m) => m >= first && m <= end && !isEx(m)).length;
    return [y, sum, n, ms];
  }).filter(([, , n]) => n);
  const body = document.createElement('div');
  body.innerHTML = `<p class="small ink2">Ultimi 24 mesi, con media mobile a 3 mesi${excl.size ? '. I mesi esclusi non sono contati' : ''}.</p>
    <div class="chart-box"></div>
    <div class="table-wrap" style="margin-top:14px"><table class="data"><thead><tr><th>Anno</th><th>Totale</th><th>Movimenti</th><th>Media al mese</th></tr></thead><tbody>
    ${perYear.reverse().map(([y, sum, n, ms]) => `<tr><td>${y}</td><td>${fmtNum(sum)}</td><td>${n}</td><td>${fmtNum(Math.round(sum / (ms || 1)))}</td></tr>`).join('')}</tbody></table></div>
    <button class="btn block ghost" style="margin-top:14px" data-go>Vedi i movimenti</button>`;
  let chart = null;
  const sh = sheet({ title: `${c.icon || ''} ${c.name}`, body, onClose: () => chart?.destroy() });
  body.querySelector('[data-go]').onclick = () => { sh.close(); go(`#/movimenti?cat=${id}`); };
  try {
    chart = drawChart(body.querySelector('.chart-box'), {
      labels: months.map((m) => { const [y, mm] = m.split('-'); return mm === '01' ? `${MONTHS_SHORT[+mm - 1]} ${y.slice(2)}` : MONTHS_SHORT[+mm - 1]; }),
      tips: months.map((m) => cap(ymLabel(m))),
      series: [barDs(c.name, v, col, { opacity: 0.5 }), lineDs('Media 3 mesi', mav, css('--ink-2'))],
      axis: compact, value: money, height: 220, label: `Andamento di ${c.name}`,
    });
  } catch (e) { body.querySelector('.chart-box').textContent = `Grafico non disponibile: ${e.message}`; }
}

/* ---------- Confronta ---------- */

function voceSeries(voce, months) {
  if (voce === 'exp') return monthlySeries('expense', months);
  if (voce === 'inc') return monthlySeries('income', months);
  if (voce === 'net') { const i = monthlySeries('income', months), e = monthlySeries('expense', months); return i.map((x, k) => x - e[k]); }
  const c = S.cat.get(voce);
  return monthlySeries(c?.type || 'expense', months, new Set([voce]));
}
function voceLabel(voce) {
  return voce === 'exp' ? 'Tutte le uscite' : voce === 'inc' ? 'Tutte le entrate' : voce === 'net' ? 'Risparmio' : S.cat.get(voce)?.name || '';
}
const mm2 = (i) => String(i + 1).padStart(2, '0');

function renderCmp(el) {
  const s = state.cmp;
  const yrs = dataYears();
  if (!s.years) s.years = yrs.slice(-3);
  s.years = s.years.filter((y) => yrs.includes(y));
  el.innerHTML = `<div class="seg" style="margin-bottom:10px">${[['years', 'Anno su anno'], ['month', 'Stesso mese']].map(([v, l]) => `<button data-mode="${v}" class="${s.mode === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="filters">
      <select class="input ${s.mode === 'years' ? 'full' : ''}" data-k="voce" aria-label="Voce">
        <option value="exp" ${s.voce === 'exp' ? 'selected' : ''}>Tutte le uscite</option>
        <option value="inc" ${s.voce === 'inc' ? 'selected' : ''}>Tutte le entrate</option>
        <option value="net" ${s.voce === 'net' ? 'selected' : ''}>Risparmio</option>
        <optgroup label="Voci di uscita">${catOptions('expense', s.voce)}</optgroup>
        <optgroup label="Voci di entrata">${catOptions('income', s.voce)}</optgroup>
      </select>
      ${s.mode === 'month' ? `<select class="input" data-k="month" aria-label="Mese">${MONTHS.map((m, i) => `<option value="${i + 1}" ${+s.month === i + 1 ? 'selected' : ''}>${cap(m)}</option>`).join('')}</select>` : ''}
    </div>
    ${s.mode === 'years' ? `<div class="chips year-chips" style="margin-bottom:10px">${yrs.map((y) => `<button class="chip ${s.years.includes(y) ? 'on' : ''}" data-year="${y}"><i style="background:${yearColor(y)}"></i>${y}</button>`).join('')}</div>
      <label class="remember" style="margin:0 2px 12px;font-size:14px"><input type="checkbox" data-k="cum" ${s.cumulative ? 'checked' : ''}> Mostra il progressivo dall'inizio dell'anno</label>` : ''}
    <div class="card chart-card"><div class="chart-title"><h3 id="ttl"></h3><p id="sub"></p></div><div class="chart-box"></div><div class="kpis" id="kpi"></div><div id="tbl"></div></div>`;
  el.onclick = (e) => {
    const m = e.target.closest('[data-mode]');
    if (m) { s.mode = m.dataset.mode; keepSel = null; rerender(); return; }
    const y = e.target.closest('[data-year]');
    if (y) {
      const v = y.dataset.year;
      s.years = s.years.includes(v) ? s.years.filter((x) => x !== v) : [...s.years, v].sort();
      if (!s.years.length) s.years = [v];
      rerender();
    }
  };
  el.onchange = (e) => {
    const k = e.target.dataset.k;
    if (k === 'voce') s.voce = e.target.value;
    if (k === 'month') { s.month = e.target.value; keepSel = null; }
    if (k === 'cum') s.cumulative = e.target.checked;
    rerender();
  };
  const label = voceLabel(s.voce);
  const nowY = today().slice(0, 4), nowM = +today().slice(5, 7);
  const first = firstMonth();
  if (s.mode === 'years') {
    const ds = [];
    const per = {};
    for (const y of s.years) {
      const months = monthRange(`${y}-01`, `${y}-12`);
      const lastM = y === nowY ? nowM : 12;
      const full = voceSeries(s.voce, months);
      const raw = full.map((x, i) => (i < lastM && months[i] >= first && !isEx(months[i]) ? x : null));
      let v = raw;
      if (s.cumulative) { let acc = 0; v = raw.map((x, i) => (i >= lastM || months[i] < first ? null : (acc += x ?? 0))); }
      per[y] = { raw, full, lastM };
      ds.push(lineDs(y, v, yearColor(y), { dots: true }));
    }
    const valid = (y, i) => i < per[y].lastM && `${y}-${mm2(i)}` >= first;
    const rows = MONTHS.map((m, i) => ({
      label: cap(MONTHS_SHORT[i]), key: `*-${mm2(i)}`,
      cells: s.years.map((y) => (valid(y, i) ? { v: cell(per[y].full[i]), key: `${y}-${mm2(i)}` } : { v: '—' })),
    }));
    rows.push({ label: 'Totale', cells: s.years.map((y) => ({ v: `<b>${fmtNum(sumOf(per[y].raw))}</b>` })) });
    rows.push({ label: 'Media al mese', cells: s.years.map((y) => ({ v: fmtNum(avgOf(per[y].raw)) })) });
    $('#ttl').textContent = `${label}${s.cumulative ? ', progressivo' : ''} mese per mese`;
    $('#sub').textContent = s.years.includes(nowY) ? `Il ${nowY} arriva fino a ${MONTHS[nowM - 1]}` : `${s.years.join(', ')}`;
    // confronto tra gli ultimi due anni scelti: media al mese sugli stessi mesi, senza quelli esclusi
    const sel = s.years.slice(-2);
    if (sel.length === 2) {
      const upTo = Math.min(per[sel[0]].lastM, per[sel[1]].lastM);
      const a = avgOf(per[sel[0]].raw.slice(0, upTo)), b = avgOf(per[sel[1]].raw.slice(0, upTo));
      const span = upTo === 12 ? 'anno intero' : `gen–${MONTHS_SHORT[upTo - 1]}`;
      $('#kpi').innerHTML = `<div><span>${sel[0]}, media al mese</span><b>${fmtEur(a, { decimals: 0 })}</b></div><div><span>${sel[1]}, media al mese</span><b>${fmtEur(b, { decimals: 0 })}</b></div><div><span>Differenza (${span})</span><b>${pctTxt(pct(a, b))}</b></div>`;
    } else $('#kpi').innerHTML = '';
    $('#tbl').innerHTML = tableHtml(['Mese', ...s.years], rows);
    plot(el, {
      labels: MONTHS_SHORT.map(cap), tips: MONTHS.map(cap), series: ds, label: 'Confronto tra anni', select: (s.years.includes(nowY) ? nowM : 12) - 1,
      pointKey: (si, i) => { const y = s.years[si]; return valid(y, i) ? exKeyFor(`${y}-${mm2(i)}`) : null; },
      extra: (i) => { const k = `*-${mm2(i)}`; return { key: k, label: excl.has(k) ? `Rimetti ${MONTHS[i]}` : `Escludi ${MONTHS[i]} da tutti gli anni` }; },
    });
  } else {
    const m = String(s.month).padStart(2, '0');
    const ys = yrs.filter((y) => `${y}-${m}` >= first && (y < nowY || +m <= nowM));
    const vals = ys.map((y) => (isEx(`${y}-${m}`) ? null : voceSeries(s.voce, [`${y}-${m}`])[0]));
    const isInc = s.voce === 'inc' || S.cat.get(s.voce)?.type === 'income';
    const col = s.voce === 'net' ? null : css(isInc ? '--inc' : '--exp');
    const colors = vals.map((v) => col || css(v >= 0 ? '--inc' : '--exp'));
    $('#ttl').textContent = `${label}: ${MONTHS[+s.month - 1]} di ogni anno`;
    $('#sub').textContent = ys.includes(nowY) && +m === nowM ? `${cap(MONTHS[nowM - 1])} ${nowY} è ancora in corso` : '';
    let maxI = -1; vals.forEach((v, i) => { if (v != null && (maxI < 0 || v > vals[maxI])) maxI = i; });
    $('#kpi').innerHTML = `<div><span>Media degli anni</span><b>${fmtEur(avgOf(vals), { decimals: 0 })}</b></div><div><span>Anno più alto</span><b>${maxI >= 0 ? ys[maxI] : '—'}</b></div><div><span>Anni a confronto</span><b>${countOf(vals)}</b></div>`;
    $('#tbl').innerHTML = tableHtml(['Anno', cap(MONTHS[+s.month - 1]), 'Rispetto all\'anno prima'], ys.map((y, i) => {
      const prev = i ? vals[i - 1] : null;
      return { label: y, key: `${y}-${m}`, cells: [{ v: cell(vals[i]) }, { v: vals[i] == null || prev == null ? '—' : pctTxt(pct(prev, vals[i])) }] };
    }).reverse());
    plot(el, {
      labels: ys, tips: ys.map((y) => `${cap(MONTHS[+s.month - 1])} ${y}`), series: [barDs(label, vals, colors)], label: 'Stesso mese negli anni',
      extra: (i) => ({ key: exKeyFor(`${ys[i]}-${m}`), label: isEx(`${ys[i]}-${m}`) ? 'Rimetti nel grafico' : `Escludi ${ys[i]}` }),
    });
  }
}
