// Import dell'estratto conto: lettura file, classificazione, doppioni, conferma
import { route, go } from './app.js';
import { S, put, putMany, setSetting } from './store.js';
import { activeAccounts, accName, catOf } from './model.js';
import * as B from './bank.js';
import { $, esc, fmtNum, fmtEur, fmtDate, addDays, daysBetween, uid, loadScript, plural } from './util.js';
import { toast, pickCategory, confirmDialog, promptDialog, sheet, ICONS } from './ui.js';

let pdfjs = null;
async function readPdf(buf) {
  if (!pdfjs) {
    pdfjs = await import('../lib/pdf.min.js');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.min.js', import.meta.url).href;
  }
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    pages.push({ items: tc.items.map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: Math.hypot(i.transform[0], i.transform[1]) })) });
  }
  return B.rowsFromPdfPages(pages);
}

async function readSheet(buf) {
  await loadScript('lib/xlsx.mini.min.js');
  const wb = window.XLSX.read(new Uint8Array(buf), { type: 'array', cellDates: false });
  let lastErr = null;
  for (const name of wb.SheetNames) {
    try {
      const aoa = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
      return B.rowsFromSheet(aoa);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Il file Excel è vuoto.');
}

export async function readStatement(file) {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 5));
  const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
  return isPdf ? readPdf(buf) : readSheet(buf);
}

/* ---------- Pagina ---------- */

route('importa', (root) => {
  const accs = activeAccounts();
  const accId = S.settings.defaultAccountId && S.acc.has(S.settings.defaultAccountId) ? S.settings.defaultAccountId : accs[0].id;
  root.innerHTML = `
    <div class="page-head"><a class="icon-btn" href="#/altro" aria-label="Indietro">${ICONS.back}</a><h1>Importa estratto</h1></div>
    <div id="imp">
      <div class="card stack">
        <p class="ink2">Scarica dall'app BBVA le “Ultime transazioni” in <b>Excel</b> (consigliato) o PDF e caricale qui. I movimenti vengono divisi nelle voci in automatico; per quelli nuovi te lo chiedo io e me lo ricordo per la prossima volta.</p>
        ${accs.length > 1 ? `<label class="field"><span>Conto</span><select class="input" id="acc">${accs.map((a) => `<option value="${a.id}" ${a.id === accId ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></label>` : ''}
        <label class="btn block" style="position:relative;min-height:54px">${ICONS.upload.replace('<svg', '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"')} Scegli il file<input type="file" id="file" accept=".pdf,.xlsx,.xls,.csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="position:absolute;inset:0;opacity:0"></label>
        ${S.settings.lastImported?.[accId] ? `<p class="tiny muted">Ultimo movimento importato per ${esc(accName(accId))}: ${fmtDate(S.settings.lastImported[accId])}. Quelli precedenti li escludo in automatico.</p>` : ''}
      </div>
    </div>`;
  $('#file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const acc = $('#acc')?.value || accId;
    $('#imp').innerHTML = '<div class="loading">Leggo l\'estratto conto…</div>';
    try {
      const rows = await readStatement(file);
      review($('#imp'), rows, acc, file.name);
    } catch (err) {
      console.error(err);
      $('#imp').innerHTML = `<div class="empty card"><h3>Non riesco a leggere il file</h3><p class="small">${esc(err.message)}</p><a class="btn small" href="#/altro" style="margin-top:14px">Indietro</a></div>`;
    }
  });
}, { tab: 'altro', live: false });

/* ---------- Revisione ---------- */

function review(root, rows, accId, fileName) {
  const keys = new Set(S.transactions.map((t) => t.importKey).filter(Boolean));
  const minD = rows.reduce((m, r) => (r.valuta < m ? r.valuta : m), '9999-99-99');
  const maxD = rows.reduce((m, r) => (r.valuta > m ? r.valuta : m), '0000-00-00');
  const last = S.settings.lastImported?.[accId];
  let from = last && addDays(last, 1) > minD ? addDays(last, 1) : minD;

  // stato per riga, conservato quando cambia la data "dal"
  const items = rows.map((row, i) => ({
    i, row, key: B.importKey(row), type: B.rowType(row), amount: Math.abs(row.amount), date: row.valuta,
    title: B.displayTitle(row), sub: B.displaySub(row),
    status: 'new', include: true, categoryId: null, toAccountId: null, how: null, remember: false, pattern: B.merchantKey(row), dupOf: null, rule: null, group: null,
  }));

  function classify() {
    const used = new Set();
    const pool = S.transactions.filter((t) => !t.importKey && (t.accountId === accId || t.toAccountId === accId));
    for (const it of items) {
      const prevManual = it.how === 'manual' || it.how === 'propagated';
      if (keys.has(it.key)) { it.status = 'imported'; it.include = false; continue; }
      if (it.date < from) { it.status = 'before'; it.include = false; continue; }
      const dup = pool.find((t) => !used.has(t.id) && t.amount === it.amount && Math.abs(daysBetween(t.date, it.date)) <= 3 &&
        (t.type === it.type || (t.type === 'transfer' && ((it.type === 'expense' && t.accountId === accId) || (it.type === 'income' && t.toAccountId === accId)))));
      if (dup) { used.add(dup.id); it.status = 'dup'; it.dupOf = dup; if (!prevManual) it.include = false; continue; }
      it.status = 'new';
      if (!prevManual) {
        it.include = true;
        const rule = B.findRule(S.rules, it.row);
        it.rule = rule;
        if (rule) { it.categoryId = rule.categoryId || null; it.toAccountId = rule.toAccountId || null; it.how = 'rule'; }
        else { it.categoryId = null; it.toAccountId = null; it.how = null; }
      }
    }
    for (const it of items) it.group = it.status === 'new' ? (it.how === 'rule' ? 'auto' : 'ask') : it.status;
  }
  classify();

  const saldoRow = rows.filter((r) => r.saldo != null).reduce((best, r) => (!best || r.contabile > best.contabile ? r : best), null);
  const acc = S.acc.get(accId);
  let align = !!saldoRow && (!acc.ref || acc.ref.date <= saldoRow.contabile);

  const ROW = (it) => {
    const sign = it.type === 'expense' ? '−' : '+';
    const c = it.categoryId ? S.cat.get(it.categoryId) : null;
    let ctl = '';
    if (it.status === 'dup') {
      const d = it.dupOf;
      ctl = `<span class="tiny ink2">Già inserito a mano: ${fmtDate(d.date)} · ${esc(catOf(d)?.name || (d.type === 'transfer' ? 'Giroconto' : 'senza voce'))}${d.note ? ` · ${esc(d.note)}` : ''}</span>`;
      if (it.include) ctl += catBtn(it, c);
    } else if (it.status === 'before') {
      ctl = '';
    } else {
      ctl = catBtn(it, c);
      if (it.how === 'rule' && it.rule) ctl += `<span class="tiny muted">regola “${esc(it.rule.pattern)}”</span>`;
      if (it.how === 'propagated') ctl += `<span class="tiny muted">come “${esc(it.pattern)}”</span>`;
      if (it.how === 'manual' && (it.categoryId || it.toAccountId)) {
        ctl += `<label class="remember"><input type="checkbox" data-rem ${it.remember ? 'checked' : ''}> Ricorda per <input type="text" data-pat value="${esc(it.pattern)}" aria-label="Testo da riconoscere"></label>`;
      }
    }
    return `<div class="imp-row ${it.include ? '' : 'off'}" data-i="${it.i}">
      <input type="checkbox" class="ck" data-inc ${it.include ? 'checked' : ''} aria-label="Importa questo movimento">
      <div class="desc"><div class="t1">${esc(it.title)}</div><div class="t2">${fmtDate(it.date)}${it.sub ? ` · ${esc(it.sub)}` : ''}</div></div>
      <div class="amt ${it.type === 'expense' ? 'exp' : 'inc'}">${sign}${fmtNum(it.amount)} €</div>
      ${ctl ? `<div class="ctl">${ctl}</div>` : ''}
    </div>`;
  };
  const catBtn = (it, c) => {
    if (!it.include) return '';
    if (it.toAccountId) return `<button class="cat-btn" data-pick>↔ Giroconto ${it.type === 'expense' ? 'verso' : 'da'} ${esc(accName(it.toAccountId))}</button>`;
    return c ? `<button class="cat-btn" data-pick>${esc(c.icon || '📦')} ${esc(c.name)}</button>` : `<button class="cat-btn need" data-pick>Scegli la voce</button>`;
  };

  const GROUPS = [
    ['ask', 'Da classificare', 'Movimenti nuovi: scegli la voce. Con “Ricorda” la prossima volta lo faccio io.'],
    ['auto', 'Classificati in automatico', 'Riconosciuti dalle regole. Tocca la voce per cambiarla.'],
    ['dup', 'Probabilmente già inseriti', 'Stesso importo entro 3 giorni da un movimento già presente: non li importo, a meno che tu non li selezioni.'],
    ['before', null, ''],
  ];

  function draw() {
    const counts = {};
    for (const it of items) counts[it.group] = (counts[it.group] || 0) + 1;
    const imported = counts.imported || 0;
    let html = `<div class="card stack">
      <div class="row between"><div><h3>${esc(fileName)}</h3><p class="tiny muted">${rows.length} movimenti dal ${fmtDate(minD)} al ${fmtDate(maxD)} · ${esc(accName(accId))}</p></div></div>
      <label class="field"><span>Importa i movimenti dal</span><input class="input" type="date" id="from" value="${from}" min="${minD}" max="${maxD}"></label>
      ${imported ? `<p class="tiny ink2">${plural(imported, 'movimento era', 'movimenti erano')} già stati importati in passato: li salto.</p>` : ''}
      ${saldoRow ? `<label class="remember" style="font-size:14px"><input type="checkbox" id="align" ${align ? 'checked' : ''}> Allinea il saldo di ${esc(accName(accId))} a ${fmtEur(saldoRow.saldo)} (saldo della banca al ${fmtDate(saldoRow.contabile)})</label>` : ''}
    </div>`;
    for (const [g, title, help] of GROUPS) {
      const list = items.filter((it) => it.group === g).sort((a, b) => b.date.localeCompare(a.date));
      if (!list.length) continue;
      if (g === 'before') {
        html += `<details class="card group" style="margin-top:14px;padding:0"><summary class="group-head"><h3>Prima del ${fmtDate(from)} (${list.length})</h3><span class="tiny muted">esclusi</span></summary>
          <div>${list.map(ROW).join('')}</div></details>`;
        continue;
      }
      html += `<div class="card" style="margin-top:14px;padding:0"><div class="group-head" style="display:block"><h3>${title} (${list.length})</h3><p class="tiny muted" style="margin-top:2px">${help}</p></div>
        <div data-g="${g}">${list.map(ROW).join('')}</div></div>`;
    }
    html += `<div class="sticky-foot"><button class="btn block" id="go" style="min-height:54px"></button></div>`;
    root.innerHTML = html;
    foot();
  }

  function foot() {
    const inc = items.filter((it) => it.include);
    const missing = inc.filter((it) => !it.categoryId && !it.toAccountId).length;
    const b = $('#go');
    if (!b) return;
    b.disabled = !inc.length && !(saldoRow && align);
    b.textContent = inc.length ? `Importa ${plural(inc.length, 'movimento', 'movimenti')}${missing ? ` (${missing} senza voce)` : ''}` : saldoRow && align ? 'Allinea solo il saldo' : 'Nessun movimento da importare';
  }

  function redrawRow(it) {
    const el = root.querySelector(`.imp-row[data-i="${it.i}"]`);
    if (el) el.outerHTML = ROW(it);
  }

  function propagate(src) {
    if (!src.remember) return;
    const p = B.normText(src.pattern);
    if (p.length < 3) return;
    for (const it of items) {
      if (it === src || it.status !== 'new' || it.type !== src.type || it.how === 'manual' || it.how === 'rule') continue;
      if (it.categoryId || it.toAccountId) { if (it.how !== 'propagated') continue; }
      if (B.rowText(it.row).includes(p)) {
        it.categoryId = src.categoryId; it.toAccountId = src.toAccountId; it.how = 'propagated'; it.include = true;
        redrawRow(it);
      }
    }
  }

  async function choose(it) {
    const r = await pickCategory({ type: it.type, allowTransfer: true, allowExclude: true, current: it.categoryId, title: it.title });
    if (!r) return;
    if (r.exclude) { it.include = false; redrawRow(it); foot(); return; }
    if (r.transfer) {
      let others = activeAccounts().filter((a) => a.id !== accId);
      if (!others.length) {
        const name = await promptDialog({ title: 'Verso quale conto?', text: 'Un giroconto sposta soldi tra due conti tuoi e non conta come spesa. Come si chiama l\'altro conto?', placeholder: 'Es. Conto deposito', ok: 'Crea conto' });
        if (!name?.trim()) return;
        await put('accounts', { id: uid('a'), name: name.trim(), kind: 'other', ref: null, order: S.accounts.length, archived: false });
        others = activeAccounts().filter((a) => a.id !== accId);
      }
      let target = others[0].id;
      if (others.length > 1) {
        target = await new Promise((res) => {
          let v = null;
          const body = document.createElement('div');
          body.className = 'menu'; body.style.boxShadow = 'none';
          body.innerHTML = others.map((a) => `<button data-id="${a.id}"><span class="ic">🏦</span><span class="grow">${esc(a.name)}</span></button>`).join('');
          const sh = sheet({ title: it.type === 'expense' ? 'Verso quale conto?' : 'Da quale conto?', body, onClose: () => res(v) });
          body.onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) { v = b.dataset.id; sh.close(); } };
        });
        if (!target) return;
      }
      it.toAccountId = target; it.categoryId = null;
    } else {
      it.categoryId = r.categoryId; it.toAccountId = null;
    }
    const wasManual = it.how === 'manual';
    it.how = 'manual';
    it.include = true;
    if (!wasManual) it.remember = !B.isGenericRow(it.row);
    redrawRow(it);
    propagate(it);
    foot();
  }

  root.addEventListener('click', (e) => {
    const rowEl = e.target.closest('.imp-row');
    if (!rowEl) {
      if (e.target.id === 'go') doImport();
      return;
    }
    const it = items[+rowEl.dataset.i];
    if (e.target.closest('[data-pick]')) choose(it);
  });

  root.addEventListener('change', (e) => {
    if (e.target.id === 'from') { from = e.target.value || minD; classify(); draw(); return; }
    if (e.target.id === 'align') { align = e.target.checked; foot(); return; }
    const rowEl = e.target.closest('.imp-row');
    if (!rowEl) return;
    const it = items[+rowEl.dataset.i];
    if (e.target.matches('[data-inc]')) {
      it.include = e.target.checked;
      redrawRow(it);
      if (it.include && !it.categoryId && !it.toAccountId && it.status !== 'before') choose(it);
      foot();
    } else if (e.target.matches('[data-rem]')) {
      it.remember = e.target.checked;
      if (it.remember) propagate(it);
    } else if (e.target.matches('[data-pat]')) {
      it.pattern = e.target.value.trim();
      if (it.remember) propagate(it);
    }
  });

  async function doImport() {
    const inc = items.filter((it) => it.include);
    const missing = inc.filter((it) => !it.categoryId && !it.toAccountId).length;
    if (missing) {
      const ok = await confirmDialog({ title: `${plural(missing, 'movimento', 'movimenti')} senza voce`, text: 'Li importo comunque: li ritrovi in Movimenti → “Da classificare”.', ok: 'Importa' });
      if (!ok) return;
    }
    const tx = inc.map((it) => {
      const isTr = !!it.toAccountId;
      return {
        id: uid('t'),
        type: isTr ? 'transfer' : it.type,
        amount: it.amount,
        date: it.date,
        categoryId: isTr ? null : it.categoryId,
        accountId: isTr && it.type === 'income' ? it.toAccountId : accId,
        toAccountId: isTr ? (it.type === 'income' ? accId : it.toAccountId) : null,
        note: '',
        source: 'import',
        bank: [it.title, it.sub].filter(Boolean).join(' · '),
        importKey: it.key,
        raw: { keyword: it.row.keyword, detail: it.row.detail, extra: it.row.extra },
        recurringId: null,
      };
    });
    // regole nuove o aggiornate
    const newRules = [];
    for (const it of inc) {
      if (it.how !== 'manual' || !it.remember) continue;
      const p = B.normText(it.pattern);
      if (p.length < 3) continue;
      const existing = S.rules.find((r) => B.normText(r.pattern) === p && r.type === it.type) || newRules.find((r) => r.pattern === p && r.type === it.type);
      const rule = { ...(existing || { id: uid('r') }), pattern: p, type: it.type, categoryId: it.categoryId, toAccountId: it.toAccountId };
      if (existing && newRules.includes(existing)) Object.assign(existing, rule); else newRules.push(rule);
    }
    await putMany('transactions', tx);
    await putMany('rules', newRules);
    const lastImp = { ...(S.settings.lastImported || {}) };
    if (!lastImp[accId] || maxD > lastImp[accId]) lastImp[accId] = maxD;
    await setSetting('lastImported', lastImp);
    if (saldoRow && align) await put('accounts', { ...S.acc.get(accId), ref: { date: saldoRow.contabile, amount: saldoRow.saldo } });
    toast(`${tx.length ? `Importati ${plural(tx.length, 'movimento', 'movimenti')}` : 'Saldo allineato'}${newRules.length ? `, ${plural(newRules.length, 'regola nuova', 'regole nuove')}` : ''}`);
    go(missing ? '#/movimenti?f=none' : '#/movimenti');
  }

  draw();
}
