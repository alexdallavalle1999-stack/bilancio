// Sezione Dati: andamento con media mobile, ripartizione per voce, confronti tra anni
import { route, go } from './app.js';
import { S } from './store.js';
import { monthlySeries, movingAverage, monthRange, firstMonth, catsOfType, years as dataYears } from './model.js';
import { $, esc, fmtNum, fmtEur, today, ym, ymAdd, ymLabel, MONTHS, MONTHS_SHORT, cap, loadScript, plural } from './util.js';
import { sheet } from './ui.js';

// Palette categoriale validata (chiaro / scuro), assegnata agli anni in ordine fisso
const CAT_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const CAT_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

const charts = [];
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const isDark = () => document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
const yearColor = (y) => (isDark() ? CAT_DARK : CAT_LIGHT)[((+today().slice(0, 4) - +y) % 8 + 8) % 8];
const alpha = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const compact = (cents) => { const v = cents / 100; return Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })}k` : v.toLocaleString('it-IT', { maximumFractionDigits: 0 }); };

async function ensureChart() {
  if (!window.Chart) await loadScript('lib/chart.umd.js');
  const C = window.Chart;
  C.defaults.font.family = css('--body') || 'system-ui';
  C.defaults.font.size = 11.5;
  C.defaults.color = css('--muted');
  C.defaults.borderColor = css('--line');
  C.defaults.animation = matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 250 };
  return C;
}

function destroyCharts() { while (charts.length) charts.pop().destroy(); }

function baseOptions({ stacked = false, legend = false } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: legend },
      tooltip: {
        backgroundColor: css('--ink'), titleColor: css('--surface'), bodyColor: css('--surface'), padding: 10, cornerRadius: 10,
        boxWidth: 12, boxHeight: 3, usePointStyle: false,
        callbacks: { label: (ctx) => ctx.raw == null ? null : ` ${ctx.dataset.label}: ${fmtEur(ctx.raw)}` },
      },
    },
    scales: {
      x: { stacked, grid: { display: false }, border: { color: css('--line') }, ticks: { maxRotation: 0, autoSkipPadding: 8 } },
      y: { stacked, grid: { color: css('--line') }, border: { display: false }, ticks: { callback: (v) => compact(v), maxTicksLimit: 6 } },
    },
  };
}

const barDs = (label, data, color, extra = {}) => ({
  type: 'bar', label, data, backgroundColor: color, hoverBackgroundColor: color, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24,
  categoryPercentage: 0.82, barPercentage: 0.9, order: 2, ...extra,
});
const lineDs = (label, data, color, extra = {}) => ({
  type: 'line', label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
  pointHoverBorderWidth: 2, pointHoverBorderColor: css('--surface'), tension: 0.3, spanGaps: true, order: 1, ...extra,
});

function legendHtml(items) {
  return `<div class="legend">${items.map(([label, color, kind]) => `<span><i class="${kind === 'line' ? 'ln' : ''}" style="background:${color}"></i>${esc(label)}</span>`).join('')}</div>`;
}

function tableHtml(head, rows) {
  return `<details style="margin-top:10px"><summary class="small ink2" style="cursor:pointer;padding:6px 4px">Tabella dei valori</summary>
    <div class="table-wrap"><table class="data"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td>${i === 0 ? esc(c) : c}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details>`;
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
    <div id="stat"></div>`;
  await ensureChart();
  const render = () => {
    destroyCharts();
    root.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
    ({ trend: renderTrend, cats: renderCats, cmp: renderCmp })[state.tab]($('#stat'));
  };
  root.querySelector('.stat-tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { state.tab = b.dataset.tab; render(); } };
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
    <div class="card chart-card"><div class="chart-title"><h3 id="ttl"></h3><p id="sub"></p></div><div class="chart-box"><canvas aria-label="Grafico andamento mensile" role="img"></canvas></div><div id="lg"></div><div class="kpis" id="kpi"></div><div id="tbl"></div></div>`;
  el.querySelector('.filters').onchange = (e) => {
    const k = e.target.dataset.k;
    s[k] = e.target.value;
    if (k === 'show') s.cat = '';
    destroyCharts(); renderTrend(el);
  };

  const end = ym(today());
  const start = s.period === 'all' ? firstMonth() : ymAdd(end, -(+s.period) + 1);
  const months = monthRange(start, end);
  const ma = +s.ma;
  // per la media mobile servono i mesi precedenti all'inizio del grafico
  const pre = ma ? monthRange(ymAdd(start, -(ma - 1)), end) : months;
  const off = pre.length - months.length;
  const filt = s.cat ? new Set([s.cat]) : null;
  const expAll = monthlySeries('expense', pre, s.show === 'expense' ? filt : null);
  const incAll = monthlySeries('income', pre, s.show === 'income' ? filt : null);
  const exp = expAll.slice(off), inc = incAll.slice(off);
  const labels = months.map((m) => { const [y, mm] = m.split('-'); return mm === '01' || months.length <= 13 ? `${MONTHS_SHORT[+mm - 1]} ${y.slice(2)}` : MONTHS_SHORT[+mm - 1]; });
  const cE = css('--exp'), cI = css('--inc'), cInk = css('--ink-2');
  const ds = [];
  const lg = [];
  const fade = ma ? 0.42 : 1;
  const catName = s.cat ? S.cat.get(s.cat)?.name : null;
  let title, kpis, tHead, tRows;
  if (s.show === 'both') {
    ds.push(barDs('Entrate', inc, alpha(cI, fade)), barDs('Uscite', exp, alpha(cE, fade)));
    lg.push(['Entrate', cI], ['Uscite', cE]);
    if (ma) {
      ds.push(lineDs(`Media entrate (${ma} mesi)`, movingAverage(incAll, ma).slice(off), cI), lineDs(`Media uscite (${ma} mesi)`, movingAverage(expAll, ma).slice(off), cE));
      lg.push([`Media entrate ${ma} mesi`, cI, 'line'], [`Media uscite ${ma} mesi`, cE, 'line']);
    }
    title = 'Entrate e uscite per mese';
    const ti = inc.reduce((a, b) => a + b, 0), te = exp.reduce((a, b) => a + b, 0);
    kpis = [['Entrate medie', fmtEur(Math.round(ti / months.length), { decimals: 0 })], ['Uscite medie', fmtEur(Math.round(te / months.length), { decimals: 0 })], ['Risparmio medio', fmtEur(Math.round((ti - te) / months.length), { decimals: 0, sign: true })]];
    tHead = ['Mese', 'Entrate', 'Uscite', 'Risparmio'];
    tRows = months.map((m, i) => [cap(ymLabel(m)), cell(inc[i]), cell(exp[i]), fmtNum(inc[i] - exp[i])]).reverse();
  } else if (s.show === 'net') {
    const netAll = incAll.map((v, i) => v - expAll[i]);
    const net = netAll.slice(off);
    ds.push(barDs('Risparmio', net, net.map((v) => alpha(v >= 0 ? cI : cE, fade))));
    if (ma) { ds.push(lineDs(`Media ${ma} mesi`, movingAverage(netAll, ma).slice(off), cInk)); lg.push([`Media ${ma} mesi`, cInk, 'line']); }
    title = 'Risparmio per mese (entrate − uscite)';
    const tot = net.reduce((a, b) => a + b, 0);
    const pos = net.filter((v) => v > 0).length;
    kpis = [['Totale periodo', fmtEur(tot, { decimals: 0, sign: true })], ['Media al mese', fmtEur(Math.round(tot / months.length), { decimals: 0, sign: true })], ['Mesi in attivo', `${pos} su ${months.length}`]];
    tHead = ['Mese', 'Risparmio', ma ? `Media ${ma}m` : ''];
    const mav = ma ? movingAverage(netAll, ma).slice(off) : [];
    tRows = months.map((m, i) => [cap(ymLabel(m)), fmtNum(net[i]), ma ? cell(mav[i]) : '']).reverse();
  } else {
    const isE = s.show === 'expense';
    const all = isE ? expAll : incAll;
    const v = isE ? exp : inc;
    const col = isE ? cE : cI;
    const word = isE ? 'Uscite' : 'Entrate';
    ds.push(barDs(catName || word, v, alpha(col, fade)));
    const mav = ma ? movingAverage(all, ma).slice(off) : [];
    if (ma) { ds.push(lineDs(`Media ${ma} mesi`, mav, cInk)); lg.push([catName || word, col], [`Media ${ma} mesi`, cInk, 'line']); }
    title = catName ? `${catName}: ${word.toLowerCase()} per mese` : `${word} per mese`;
    const tot = v.reduce((a, b) => a + b, 0);
    let maxI = 0; v.forEach((x, i) => { if (x > v[maxI]) maxI = i; });
    kpis = [['Totale periodo', fmtEur(tot, { decimals: 0 })], ['Media al mese', fmtEur(Math.round(tot / months.length), { decimals: 0 })], ['Mese più alto', v[maxI] ? `${cap(ymLabel(months[maxI], { short: true }))}` : '—']];
    tHead = ['Mese', catName || word, ma ? `Media ${ma}m` : ''];
    tRows = months.map((m, i) => [cap(ymLabel(m)), cell(v[i]), ma ? cell(mav[i]) : '']).reverse();
  }
  $('#ttl').textContent = title;
  $('#sub').textContent = `${cap(ymLabel(months[0]))} – ${ymLabel(months[months.length - 1])}${months[months.length - 1] === ym(today()) ? ' (mese in corso)' : ''}`;
  $('#lg').innerHTML = lg.length > 1 ? legendHtml(lg) : '';
  $('#kpi').innerHTML = kpis.map(([a, b]) => `<div><span>${esc(a)}</span><b>${b}</b></div>`).join('');
  $('#tbl').innerHTML = tableHtml(tHead.filter(Boolean), tRows.map((r) => r.slice(0, tHead.filter(Boolean).length)));
  const opt = baseOptions();
  charts.push(new window.Chart(el.querySelector('canvas'), { data: { labels, datasets: ds }, options: opt }));
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
    renderCats(el);
  });
  el.querySelectorAll('[data-type]').forEach((b) => (b.onclick = () => { s.type = b.dataset.type; renderCats(el); }));

  const [from, to, label] = periodRange(s.period);
  const sums = new Map();
  let total = 0;
  for (const t of S.transactions) {
    if (t.type !== s.type) continue;
    const m = ym(t.date);
    if (m < from || m > to) continue;
    const k = t.categoryId || '__none';
    const x = sums.get(k) || { sum: 0, n: 0 };
    x.sum += t.amount; x.n++;
    sums.set(k, x);
    total += t.amount;
  }
  const list = [...sums.entries()].sort((a, b) => b[1].sum - a[1].sum);
  const nMonths = monthRange(from, to).length;
  const body = $('#catbody');
  if (!list.length) { body.innerHTML = `<div class="empty card"><h3>Nessun movimento</h3><p class="small">${esc(label)}: nessuna ${s.type === 'expense' ? 'uscita' : 'entrata'}.</p></div>`; return; }
  const max = list[0][1].sum;
  body.innerHTML = `<div class="card">
      <div class="chart-title"><p>${esc(label)}</p><h2 class="num" style="font-size:28px;margin-top:2px">${fmtEur(total)}</h2>
      ${nMonths > 1 ? `<p>Media ${fmtEur(Math.round(total / nMonths), { decimals: 0 })} al mese su ${nMonths} mesi</p>` : ''}</div>
      <div class="bars t-${s.type}" style="margin-top:10px">${list.map(([id, x]) => {
        const c = S.cat.get(id);
        const pc = total ? Math.round((x.sum / total) * 1000) / 10 : 0;
        return `<button class="bar-row" data-cat="${id}"><span class="nm">${esc(c?.icon || '❔')} ${esc(c?.name || 'Da classificare')}</span><span class="vl">${fmtNum(x.sum)} €</span>
          <span class="track"><span style="width:${Math.max(1.5, (x.sum / max) * 100)}%"></span></span>
          <span class="pc">${pc.toLocaleString('it-IT')}% · ${plural(x.n, 'movimento', 'movimenti')}</span></button>`;
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
  const all = monthlySeries(c.type, pre, new Set([id]));
  const v = all.slice(2);
  const mav = movingAverage(all, 3).slice(2);
  const col = css(c.type === 'expense' ? '--exp' : '--inc');
  const yrs = dataYears();
  const perYear = yrs.map((y) => {
    let sum = 0, n = 0;
    for (const t of S.transactions) if (t.categoryId === id && t.date.startsWith(y)) { sum += t.amount; n++; }
    return [y, sum, n];
  }).filter(([, , n]) => n);
  const body = document.createElement('div');
  body.innerHTML = `<p class="small ink2">Ultimi 24 mesi, con media mobile a 3 mesi.</p>
    <div class="chart-box" style="height:220px"><canvas role="img" aria-label="Andamento della voce"></canvas></div>
    ${legendHtml([[c.name, col], ['Media 3 mesi', css('--ink-2'), 'line']])}
    <div class="table-wrap" style="margin-top:14px"><table class="data"><thead><tr><th>Anno</th><th>Totale</th><th>Movimenti</th><th>Media al mese</th></tr></thead><tbody>
    ${perYear.reverse().map(([y, sum, n]) => {
      const nm = y === today().slice(0, 4) ? +today().slice(5, 7) : y === yrs[0] ? 13 - +firstMonth().slice(5, 7) : 12;
      return `<tr><td>${y}</td><td>${fmtNum(sum)}</td><td>${n}</td><td>${fmtNum(Math.round(sum / nm))}</td></tr>`;
    }).join('')}</tbody></table></div>
    <button class="btn block ghost" style="margin-top:14px" data-go>Vedi i movimenti</button>`;
  let chart;
  const sh = sheet({ title: `${c.icon || ''} ${c.name}`, body, onClose: () => chart?.destroy() });
  body.querySelector('[data-go]').onclick = () => { sh.close(); go(`#/movimenti?cat=${id}`); };
  chart = new window.Chart(body.querySelector('canvas'), {
    data: {
      labels: months.map((m) => { const [y, mm] = m.split('-'); return mm === '01' ? `${MONTHS_SHORT[+mm - 1]} ${y.slice(2)}` : MONTHS_SHORT[+mm - 1]; }),
      datasets: [barDs(c.name, v, alpha(col, 0.45)), lineDs('Media 3 mesi', mav, css('--ink-2'))],
    },
    options: baseOptions(),
  });
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
    <div class="card chart-card"><div class="chart-title"><h3 id="ttl"></h3><p id="sub"></p></div><div class="chart-box"><canvas role="img" aria-label="Grafico di confronto"></canvas></div><div id="lg"></div><div class="kpis" id="kpi"></div><div id="tbl"></div></div>`;
  el.onclick = (e) => {
    const m = e.target.closest('[data-mode]');
    if (m) { s.mode = m.dataset.mode; destroyCharts(); renderCmp(el); return; }
    const y = e.target.closest('[data-year]');
    if (y) {
      const v = y.dataset.year;
      s.years = s.years.includes(v) ? s.years.filter((x) => x !== v) : [...s.years, v].sort();
      if (!s.years.length) s.years = [v];
      destroyCharts(); renderCmp(el);
    }
  };
  el.onchange = (e) => {
    const k = e.target.dataset.k;
    if (k === 'voce') s.voce = e.target.value;
    if (k === 'month') s.month = e.target.value;
    if (k === 'cum') s.cumulative = e.target.checked;
    destroyCharts(); renderCmp(el);
  };
  const label = voceLabel(s.voce);
  const nowY = today().slice(0, 4), nowM = +today().slice(5, 7);
  if (s.mode === 'years') {
    const ds = [], lg = [], tRows = MONTHS_SHORT.map((m) => [cap(m)]);
    const totals = [];
    for (const y of s.years) {
      const months = monthRange(`${y}-01`, `${y}-12`);
      let v = voceSeries(s.voce, months);
      const lastM = y === nowY ? nowM : 12;
      v = v.map((x, i) => (i < lastM ? x : null));
      if (s.cumulative) { let acc = 0; v = v.map((x) => (x == null ? null : (acc += x))); }
      const col = yearColor(y);
      ds.push(lineDs(y, v, col, { pointRadius: 3, pointBackgroundColor: col, pointBorderColor: css('--surface'), pointBorderWidth: 1.5, tension: 0.25 }));
      lg.push([y, col, 'line']);
      v.forEach((x, i) => tRows[i].push(cell(x)));
      const raw = voceSeries(s.voce, months).slice(0, lastM);
      totals.push([y, raw.reduce((a, b) => a + b, 0), lastM]);
    }
    tRows.push(['Totale', ...totals.map(([, t]) => `<b>${fmtNum(t)}</b>`)]);
    $('#ttl').textContent = `${label}${s.cumulative ? ', progressivo' : ''} mese per mese`;
    $('#sub').textContent = s.years.includes(nowY) ? `Il ${nowY} arriva fino a ${MONTHS[nowM - 1]}` : `${s.years.join(', ')}`;
    $('#lg').innerHTML = legendHtml(lg);
    // KPI: confronto dello stesso periodo tra gli ultimi due anni selezionati
    const sel = s.years.slice(-2);
    if (sel.length === 2) {
      const upTo = sel[1] === nowY ? nowM : 12;
      const a = voceSeries(s.voce, monthRange(`${sel[0]}-01`, `${sel[0]}-12`)).slice(0, upTo).reduce((x, y) => x + y, 0);
      const b = voceSeries(s.voce, monthRange(`${sel[1]}-01`, `${sel[1]}-12`)).slice(0, upTo).reduce((x, y) => x + y, 0);
      const d = a ? Math.round(((b - a) / Math.abs(a)) * 1000) / 10 : null;
      const per = upTo === 12 ? 'anno intero' : `gen–${MONTHS_SHORT[upTo - 1]}`;
      $('#kpi').innerHTML = `<div><span>${sel[0]} (${per})</span><b>${fmtEur(a, { decimals: 0 })}</b></div><div><span>${sel[1]} (${per})</span><b>${fmtEur(b, { decimals: 0 })}</b></div><div><span>Differenza</span><b>${d == null ? '—' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toLocaleString('it-IT')}%`}</b></div>`;
    } else $('#kpi').innerHTML = '';
    $('#tbl').innerHTML = tableHtml(['Mese', ...s.years], tRows);
    charts.push(new window.Chart(el.querySelector('canvas'), { data: { labels: MONTHS_SHORT.map(cap), datasets: ds }, options: baseOptions() }));
  } else {
    const m = String(s.month).padStart(2, '0');
    const ys = yrs.filter((y) => `${y}-${m}` >= firstMonth() && (y < nowY || +m <= nowM));
    const vals = ys.map((y) => voceSeries(s.voce, [`${y}-${m}`])[0]);
    const isInc = s.voce === 'inc' || S.cat.get(s.voce)?.type === 'income';
    const col = s.voce === 'net' ? null : css(isInc ? '--inc' : '--exp');
    const colors = vals.map((v) => col || css(v >= 0 ? '--inc' : '--exp'));
    $('#ttl').textContent = `${label}: ${MONTHS[+s.month - 1]} di ogni anno`;
    $('#sub').textContent = ys.includes(nowY) && +m === nowM ? `${cap(MONTHS[nowM - 1])} ${nowY} è ancora in corso` : '';
    $('#lg').innerHTML = '';
    const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    let maxI = 0; vals.forEach((v, i) => { if (v > vals[maxI]) maxI = i; });
    $('#kpi').innerHTML = `<div><span>Media degli anni</span><b>${fmtEur(avg, { decimals: 0 })}</b></div><div><span>Anno più alto</span><b>${ys[maxI] || '—'}</b></div><div><span>Anni a confronto</span><b>${ys.length}</b></div>`;
    $('#tbl').innerHTML = tableHtml(['Anno', cap(MONTHS[+s.month - 1]), 'Rispetto all\'anno prima'], ys.map((y, i) => {
      const prev = i ? vals[i - 1] : null;
      const d = prev ? Math.round(((vals[i] - prev) / Math.abs(prev)) * 1000) / 10 : null;
      return [y, fmtNum(vals[i]), d == null ? '—' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toLocaleString('it-IT')}%`];
    }).reverse());
    charts.push(new window.Chart(el.querySelector('canvas'), {
      data: { labels: ys, datasets: [barDs(label, vals, colors)] },
      options: baseOptions(),
    }));
  }
}
