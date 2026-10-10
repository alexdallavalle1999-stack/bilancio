// Lettura degli estratti conto BBVA (Excel e PDF) e classificazione automatica.
// Modulo "puro": nessun accesso al DOM, usabile anche da Node per i test.

const DATE_RE = /^(\d{2})[\/.-](\d{2})[\/.-](\d{4})$/;
const AMOUNT_EUR_RE = /^[-+]?\d{1,3}(?:\.\d{3})*,\d{2}\s?€$/;
const NUM_IT_RE = /^[-+]?\d{1,3}(?:\.\d{3})*,\d{2}$/;

// Intermediari di pagamento che precedono il nome reale dell'esercente ("SumUp *Bar Rossi")
const PROCESSORS = new Set(['sumup', 'sum', 'mgp', 'sp', 'paypal', 'pp', 'google', 'zettle', 'sq', 'nexi', 'stripe']);

export function normText(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Rimuove numeri di carta/conto (12-19 cifre) da un testo
export function stripCard(s) {
  return String(s ?? '').replace(/\b\d{12,19}\b/g, '').replace(/\s+/g, ' ').trim();
}

// "1.075,67" -> 107567 ; "-6,99 €" -> -699 ; 12.5 -> 1250
export function toCents(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  let s = String(v).replace(/[€\s]|EUR/gi, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const pad = (n) => String(n).padStart(2, '0');

// Accetta "06/10/2026", "2026-10-06", seriale Excel, oggetto Date. Ritorna "YYYY-MM-DD" o null.
export function toISODate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  let m = s.match(DATE_RE);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/* ---------------- Excel ---------------- */

// aoa = array di righe (array di celle), come da XLSX.utils.sheet_to_json(ws, {header:1, raw:true})
export function rowsFromSheet(aoa) {
  let h = -1, cols = null;
  for (let i = 0; i < Math.min(aoa.length, 40); i++) {
    const r = (aoa[i] || []).map((c) => normText(c));
    if (r.includes('data valuta') && r.includes('importo')) {
      h = i;
      const idx = (name) => r.indexOf(name);
      cols = {
        valuta: idx('data valuta'),
        data: idx('data'),
        kw: idx('parola chiave'),
        mov: idx('movimento'),
        imp: idx('importo'),
        disp: idx('disponibile'),
        oss: idx('osservazioni'),
      };
      break;
    }
  }
  if (h < 0) throw new Error('Non trovo le colonne "Data valuta" e "Importo": il file non sembra un estratto BBVA.');
  const out = [];
  for (let i = h + 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    const amount = toCents(r[cols.imp]);
    const contabile = toISODate(r[cols.data]) || toISODate(r[cols.valuta]);
    const valuta = toISODate(r[cols.valuta]) || contabile;
    if (amount == null || !contabile) continue;
    out.push({
      valuta,
      contabile,
      keyword: String(r[cols.kw] ?? '').replace(/\s+/g, ' ').trim(),
      detail: cols.mov >= 0 ? String(r[cols.mov] ?? '').replace(/\s+/g, ' ').trim() : '',
      extra: cols.oss >= 0 ? stripCard(r[cols.oss]) : '',
      amount,
      saldo: cols.disp >= 0 ? toCents(r[cols.disp]) : null,
    });
  }
  return out;
}

/* ---------------- PDF ---------------- */

// pages = [{ items: [{ str, x, y, w, h }] }]  (coordinate PDF: y cresce verso l'alto)
export function rowsFromPdfPages(pages) {
  const rows = [];
  let cur = null;
  let kwX = null;
  for (const pg of pages) {
    const items = pg.items.filter((i) => i.str && i.str.trim());
    const lines = [];
    for (const it of items) {
      let L = lines.find((l) => Math.abs(l.y - it.y) < 1 && Math.abs(l.h - it.h) < 0.6);
      if (!L) { L = { y: it.y, h: it.h, items: [] }; lines.push(L); }
      L.items.push(it);
    }
    lines.sort((a, b) => b.y - a.y);
    for (const L of lines) {
      L.items.sort((a, b) => a.x - b.x);
      const cells = [];
      for (const it of L.items) {
        const last = cells[cells.length - 1];
        const gap = last ? it.x - last.x1 : 99;
        if (last && gap < 8) { last.t += (gap < 0.8 ? '' : ' ') + it.str; last.x1 = it.x + it.w; }
        else cells.push({ x0: it.x, x1: it.x + it.w, t: it.str });
      }
      cells.forEach((c) => { c.t = c.t.replace(/\s+/g, ' ').trim(); });
      const amtIdx = cells.findIndex((c) => AMOUNT_EUR_RE.test(c.t));
      if (cells.length >= 3 && DATE_RE.test(cells[0].t) && amtIdx > 1) {
        if (kwX == null) kwX = cells[1].x0;
        const saldoCell = cells.slice(amtIdx + 1).find((c) => /EUR$/.test(c.t));
        cur = {
          contabile: toISODate(cells[0].t),
          valuta: null,
          h: L.h,
          kw: [cells.slice(1, amtIdx).map((c) => c.t).join(' ')],
          det: [],
          amount: toCents(cells[amtIdx].t),
          saldo: saldoCell ? toCents(saldoCell.t.replace(/EUR$/, '')) : null,
        };
        rows.push(cur);
        continue;
      }
      if (!cur) continue;
      for (const c of cells) {
        const m = c.t.match(/^Data valuta:?\s*(\d{2}\/\d{2}\/\d{4})$/i);
        if (m) { cur.valuta = toISODate(m[1]); continue; }
        if (kwX != null && Math.abs(c.x0 - kwX) < 6) {
          if (L.h >= cur.h - 0.6) cur.kw.push(c.t);
          else cur.det.push(c.t);
        }
      }
    }
  }
  if (!rows.length) throw new Error('Nel PDF non ho trovato movimenti: il file non sembra un estratto BBVA "Ultime transazioni".');
  return rows.map((r) => ({
    valuta: r.valuta || r.contabile,
    contabile: r.contabile,
    keyword: r.kw.join(' ').replace(/\s+/g, ' ').trim(),
    detail: r.det.join(' ').replace(/\s+/g, ' ').trim(),
    extra: '',
    amount: r.amount,
    saldo: r.saldo,
  }));
}

/* ---------------- Classificazione ---------------- */

const firstWords = (s, n) => s.split(' ').filter(Boolean).slice(0, n).join(' ');

export function isTransferLike(row) {
  return /^bonifico\b/.test(normText(row.keyword));
}

// Movimenti con descrizione generica: di default non si memorizza una regola
export function isGenericRow(row) {
  const kw = normText(row.keyword);
  return /^(bonifico|pagamenti\/riscossioni|commissione|giroconto|prelievo|ricarica)/.test(kw);
}

// Chiave "esercente" proposta come regola da memorizzare
export function merchantKey(row) {
  const kw = normText(row.keyword);
  const det = normText(row.detail);
  if (/^bonifico\b/.test(kw)) return firstWords(det, 4) || kw;
  if (/^(accredito dello stipendio|pagamenti\/riscossioni|liquidazione interessi|pagamento imposte|commissione)/.test(kw)) return firstWords(kw, 4);
  let parts = kw.split('*').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) parts = parts.filter((p) => !PROCESSORS.has(p) && !(/\d/.test(p) && !/\s/.test(p) && p.length >= 5));
  let s = (parts.join(' ') || kw)
    .split(' ')
    .map((t) => { const m = t.match(/^([a-z]{2,})\d{3,}$/); return m ? m[1] : t; })
    .filter((t) => t && !/^\d+$/.test(t))
    .join(' ');
  return firstWords(s || kw, 4);
}

// Testo completo su cui si cercano le regole
export function rowText(row) {
  return normText([row.keyword, row.detail, row.extra].filter(Boolean).join(' '));
}

export function rowType(row) {
  return row.amount < 0 ? 'expense' : 'income';
}

// La regola più specifica (pattern più lungo) dello stesso tipo
export function findRule(rules, row) {
  const text = rowText(row);
  const key = merchantKey(row);
  const type = rowType(row);
  let best = null;
  for (const r of rules) {
    if (!r.pattern || r.type !== type) continue;
    const p = normText(r.pattern);
    const ok = text.includes(p) || (key.length >= 8 && p.startsWith(key));
    if (ok && (!best || p.length > normText(best.pattern).length)) best = r;
  }
  return best;
}

// Identifica in modo stabile una riga dell'estratto (uguale tra PDF ed Excel)
export function importKey(row) {
  return [row.contabile, row.amount, row.saldo ?? normText(row.keyword)].join('|');
}

export function displayTitle(row) {
  return isTransferLike(row) && row.detail ? row.detail : row.keyword;
}

export function displaySub(row) {
  return isTransferLike(row) && row.detail ? row.keyword : row.detail;
}
