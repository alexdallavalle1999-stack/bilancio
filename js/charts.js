// Grafici in SVG: barre e linee, tocco (o frecce) per leggere i valori di un punto.
// Niente librerie esterne: si disegnano sempre, anche offline.
import { esc } from './util.js';

const NS = 'http://www.w3.org/2000/svg';

function niceStep(raw) {
  if (raw <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function barPath(x, w, yTop, yBase, r) {
  const h = Math.abs(yBase - yTop);
  if (h < 0.5) return '';
  r = Math.min(r, w / 2, h);
  if (yTop <= yBase) {
    return `M${x},${yBase}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yBase}Z`;
  }
  // valore negativo: arrotonda il lato in basso
  return `M${x},${yBase}V${yTop - r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop - r}V${yBase}Z`;
}

/**
 * box: elemento contenitore (riceve lettura valori + svg)
 * cfg: { labels, tips, series:[{type:'bar'|'line', name, values, color, colors?, opacity?, dots?}], height, axis(v), value(v), select? }
 */
export function drawChart(box, cfg) {
  const height = cfg.height || 240;
  box.innerHTML = `<div class="cx-read" aria-live="polite"></div><svg class="cx" role="img" tabindex="0" aria-label="${esc(cfg.label || 'Grafico')}"></svg>`;
  const read = box.querySelector('.cx-read');
  const svg = box.querySelector('svg');
  const n = cfg.labels.length;
  let sel = cfg.select != null && cfg.select >= 0 && cfg.select < n ? cfg.select : n - 1;
  let geo = null;

  function render() {
    const W = Math.max(240, Math.round(box.clientWidth || 340));
    const H = height;
    const pad = { l: 40, r: 6, t: 10, b: 24 };
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;
    const all = cfg.series.flatMap((s) => s.values).filter((v) => v != null);
    let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
    if (hi === lo) hi = lo + 10000;
    const step = niceStep((hi - lo) / 4);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const y = (v) => pad.t + ((hi - v) / (hi - lo)) * ph;
    const band = pw / Math.max(1, n);
    const cx = (i) => pad.l + band * (i + 0.5);
    geo = { pad, band, n };

    let s = '';
    // griglia e assi
    for (let v = lo; v <= hi + step / 2; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}" style="stroke:var(--line);stroke-width:1"/>`;
      s += `<text x="${pad.l - 6}" y="${yy + 4}" text-anchor="end" class="cx-t">${esc(cfg.axis ? cfg.axis(v) : v)}</text>`;
    }
    if (lo < 0) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(0)}" y2="${y(0)}" style="stroke:var(--ink-2);stroke-width:1;opacity:.5"/>`;
    // evidenziazione colonna selezionata
    if (sel != null && sel >= 0 && sel < n) s += `<rect x="${pad.l + band * sel}" y="${pad.t}" width="${band}" height="${ph}" rx="6" style="fill:var(--ink);opacity:.06"/>`;
    // barre
    const bars = cfg.series.filter((x) => x.type === 'bar');
    const k = bars.length;
    const gap = k > 1 ? 2 : 0;
    const bw = Math.max(2, Math.min(24, (band * 0.78 - gap * (k - 1)) / Math.max(1, k)));
    bars.forEach((ser, j) => {
      ser.values.forEach((v, i) => {
        if (v == null || v === 0) return;
        const x = cx(i) - (k * bw + (k - 1) * gap) / 2 + j * (bw + gap);
        const col = ser.colors ? ser.colors[i] : ser.color;
        const d = barPath(x, bw, y(v), y(0), 4);
        if (d) s += `<path d="${d}" style="fill:${col};fill-opacity:${ser.opacity ?? 1}"/>`;
      });
    });
    // linee
    for (const ser of cfg.series.filter((x) => x.type === 'line')) {
      let d = '';
      let pen = false;
      ser.values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${cx(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      if (d) s += `<path d="${d}" style="fill:none;stroke:${ser.color};stroke-width:2;stroke-linejoin:round;stroke-linecap:round"/>`;
      if (ser.dots) ser.values.forEach((v, i) => { if (v != null) s += `<circle cx="${cx(i)}" cy="${y(v)}" r="3.5" style="fill:${ser.color};stroke:var(--surface);stroke-width:2"/>`; });
    }
    // etichette asse x (sempre l'ultima, poi a ritroso a passo fisso)
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 46))));
    cfg.labels.forEach((lab, i) => {
      if ((n - 1 - i) % every !== 0) return;
      s += `<text x="${cx(i)}" y="${H - 6}" text-anchor="middle" class="cx-t">${esc(lab)}</text>`;
    });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.innerHTML = s;
    readout();
  }

  function readout() {
    if (sel == null || sel < 0 || sel >= n) { read.innerHTML = '<span class="muted">Tocca il grafico per leggere i valori</span>'; return; }
    const parts = cfg.series
      .map((ser, si) => {
        if (ser.hideInReadout) return '';
        const v = ser.values[sel];
        const col = ser.colors ? ser.colors[sel] : ser.color;
        const key = cfg.pointKey?.(si, sel);
        const off = key && cfg.isOff?.(key);
        const val = off ? 'escluso' : v == null ? '—' : cfg.value ? cfg.value(v) : v;
        const inner = `<i class="${ser.type === 'line' ? 'ln' : ''}" style="background:${col}"></i>${esc(ser.name)} <b>${esc(val)}</b>`;
        return key ? `<button type="button" class="cx-r tg ${off ? 'off' : ''}" data-key="${esc(key)}">${inner}</button>` : `<span class="cx-r">${inner}</span>`;
      });
    const ex = cfg.extra?.(sel);
    read.innerHTML = `<span class="cx-when">${esc((cfg.tips || cfg.labels)[sel])}${ex ? `<button type="button" class="cx-act" data-key="${esc(ex.key)}">${esc(ex.label)}</button>` : ''}</span>${parts.join('')}`;
  }
  read.addEventListener('click', (e) => { const b = e.target.closest('[data-key]'); if (b) cfg.onToggle?.(b.dataset.key, sel); });

  function pick(ev) {
    if (!geo) return;
    const r = svg.getBoundingClientRect();
    const scale = r.width ? Number(svg.getAttribute('width')) / r.width : 1;
    const x = (ev.clientX - r.left) * scale;
    const i = Math.floor((x - geo.pad.l) / geo.band);
    if (i >= 0 && i < n && i !== sel) { sel = i; render(); cfg.onSelect?.(i); }
  }
  let down = false;
  svg.addEventListener('pointerdown', (e) => { down = true; pick(e); });
  svg.addEventListener('pointermove', (e) => { if (down || e.pointerType === 'mouse') pick(e); });
  const onUp = () => { down = false; };
  window.addEventListener('pointerup', onUp);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' && sel > 0) { sel--; render(); cfg.onSelect?.(sel); e.preventDefault(); }
    if (e.key === 'ArrowRight' && sel < n - 1) { sel++; render(); cfg.onSelect?.(sel); e.preventDefault(); }
  });

  let raf = 0;
  let lastW = 0;
  const ro = new ResizeObserver(() => {
    const w = Math.round(box.clientWidth);
    if (w === lastW) return;
    lastW = w;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  });
  ro.observe(box);
  render();
  return { destroy() { ro.disconnect(); cancelAnimationFrame(raf); window.removeEventListener('pointerup', onUp); } };
}
