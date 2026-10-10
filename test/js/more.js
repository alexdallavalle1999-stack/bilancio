// Sezione "Altro": backup, ricorrenti, voci, conti, regole, impostazioni
import { route, go, itemHtml } from './app.js';
import { S, put, putMany, del, delMany, setSetting, getSecret, isPersisted } from './store.js';
import { balance, catsOfType, describeRecurring, nextAfter, firstOccurrence, accName, activeAccounts } from './model.js';
import { $, esc, fmtEur, fmtNum, fmtDate, today, uid, parseAmount, centsToInput, daysBetween, parseISO, lastDayOfMonth, plural } from './util.js';
import { toast, sheet, confirmDialog, promptDialog, pickCategory, editCategory, accountOptions, ICONS } from './ui.js';
import { makeBackup, restoreFromFile, restoreFromText, exportCsv, askPassword } from './backup.js';
import * as dbx from './dropbox.js';

const head = (title, back = '#/altro') => `<div class="page-head"><a class="icon-btn" href="${back}" aria-label="Indietro">${ICONS.back}</a><h1>${esc(title)}</h1></div>`;

/* ---------- Menu ---------- */
route('altro', (root) => {
  const nRules = S.rules.length;
  const nRec = S.recurring.filter((r) => r.active).length;
  const last = S.settings.lastBackupAt;
  const st = S.settings;
  const days = last ? daysBetween(last.slice(0, 10), today()) : null;
  const due = S.transactions.length > 0 && (st.changesSinceBackup || 0) > 0 && (days == null || days >= (st.backupEveryDays || 7));
  root.innerHTML = `<div class="page-head"><h1>Altro</h1></div>
    ${due || dbx.status()?.lastError ? `<div class="banner" style="margin-bottom:14px"><span class="grow">${dbx.status()?.lastError ? esc(dbx.status().lastError) : days == null ? 'Non hai ancora fatto un backup.' : `Ultimo backup ${days} giorni fa.`}${dbx.isConnected() ? '' : ' Salvane uno.'}</span>${dbx.isConnected() ? '<a class="btn small" href="#/altro/backup">Controlla</a>' : '<button class="btn small" data-act="backup">Backup</button>'}</div>` : ''}
    <div class="menu">
      <a href="#/altro/importa"><span class="ic">📥</span><span class="grow">Importa estratto conto<small>PDF o Excel BBVA: le spese vengono classificate da sole</small></span><span class="chev">›</span></a>
      <a href="#/altro/backup"><span class="ic">🔒</span><span class="grow">Backup e ripristino<small>${dbx.isConnected() ? `Automatico su Dropbox${last ? ` · ultimo il ${fmtDate(last.slice(0, 10))}` : ''}` : last ? `Ultimo backup il ${fmtDate(last.slice(0, 10))}` : 'Nessun backup ancora'}</small></span><span class="chev">›</span></a>
    </div>
    <div class="menu" style="margin-top:14px">
      <a href="#/altro/ricorrenti"><span class="ic">↻</span><span class="grow">Spese ricorrenti<small>${nRec ? plural(nRec, 'attiva', 'attive') : 'Abbonamenti, affitto, rate…'}</small></span><span class="chev">›</span></a>
      <a href="#/altro/categorie"><span class="ic">🏷️</span><span class="grow">Voci di spesa e di entrata<small>${S.categories.filter((c) => !c.archived).length} voci</small></span><span class="chev">›</span></a>
      <a href="#/altro/conti"><span class="ic">🏦</span><span class="grow">Conti e saldo<small>${activeAccounts().map((a) => esc(a.name)).join(', ')}</small></span><span class="chev">›</span></a>
      <a href="#/altro/regole"><span class="ic">🧭</span><span class="grow">Regole di classificazione<small>${nRules ? plural(nRules, 'regola memorizzata', 'regole memorizzate') : 'Si creano durante l\'import'}</small></span><span class="chev">›</span></a>
    </div>
    <div class="menu" style="margin-top:14px">
      <button data-act="csv"><span class="ic">📄</span><span class="grow">Esporta movimenti in CSV<small>Da aprire con Excel o Fogli Google</small></span><span class="chev">›</span></button>
      <a href="#/altro/info"><span class="ic">⚙️</span><span class="grow">Impostazioni e informazioni</span><span class="chev">›</span></a>
    </div>`;
  root.querySelector('[data-act="csv"]').onclick = exportCsv;
  root.querySelector('[data-act="backup"]')?.addEventListener('click', makeBackup);
});

/* ---------- Backup ---------- */
function whenLabel(isoStr) {
  if (!isoStr) return 'mai';
  const d = isoStr.slice(0, 10);
  const t = new Date(isoStr).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const days = daysBetween(new Date(isoStr).toLocaleDateString('sv-SE'), today());
  return days === 0 ? `oggi alle ${t}` : days === 1 ? `ieri alle ${t}` : `${fmtDate(d)} (${days} giorni fa)`;
}

function dropboxCard() {
  if (!dbx.isConfigured()) return '';
  if (!dbx.isConnected()) {
    return `<div class="card stack">
      <h3>Backup automatico su Dropbox</h3>
      <p class="small ink2">Una copia cifrata al giorno, fatta in automatico mentre usi l'app. Su Dropbox restano le ultime ${dbx.KEEP}.</p>
      <button class="btn block" data-act="dbx-connect">Collega Dropbox</button>
      <p class="tiny muted">Telefono nuovo? Collega Dropbox e potrai ripristinare l'ultimo backup.</p>
    </div>`;
  }
  const d = dbx.status();
  return `<div class="card stack">
    <div class="row between"><h3>Backup automatico su Dropbox</h3><span class="tag" style="${d.lastError ? '' : 'background:var(--inc-soft);color:var(--inc)'}">${d.lastError ? 'da controllare' : 'attivo'}</span></div>
    ${d.lastError ? `<div class="banner" style="font-size:14px">${esc(d.lastError)}</div>` : ''}
    <div>
      <div class="kv"><span>Ultimo backup su Dropbox</span><b>${esc(whenLabel(d.lastAt))}</b></div>
      ${d.content ? `<div class="kv"><span>Contiene</span><b>${fmtNum(d.content.count * 100, { decimals: 0 })} movimenti</b></div>` : ''}
      ${d.content?.last ? `<div class="kv"><span>Ultimo movimento inserito</span><b>${esc(S.cat.get(d.content.last.categoryId)?.name || d.content.last.note || (d.content.last.type === 'transfer' ? 'Giroconto' : 'Movimento'))} · ${esc(fmtEur(d.content.last.amount))}</b></div>` : ''}
      <div class="kv"><span>Modifiche non ancora su Dropbox</span><b>${(S.settings.changesSinceBackup || 0) > 0 ? `${fmtNum((S.settings.changesSinceBackup) * 100, { decimals: 0 })} (vanno su a breve)` : 'nessuna'}</b></div>
      ${d.email ? `<div class="kv"><span>Account</span><b>${esc(d.email)}</b></div>` : ''}
      <div class="kv"><span>Copie conservate</span><b>${d.copies != null ? `${d.copies} su ${dbx.KEEP}` : '—'}</b></div>
    </div>
    <div class="row" style="flex-wrap:wrap">
      <button class="btn small" data-act="dbx-now">Fai il backup ora</button>
      <button class="btn small ghost" data-act="dbx-restore">Ripristina da Dropbox</button>
      <button class="btn small ghost" data-act="dbx-off">Scollega</button>
    </div>
  </div>`;
}

async function connectDropbox() {
  // il backup automatico ha bisogno della password memorizzata su questo telefono
  if (!(await getSecret('backupPassword'))) {
    const pw = await askPassword({ forceNew: true, mustRemember: true, note: 'Se hai già dei backup (per esempio da un altro telefono), scrivi la stessa password di allora.' });
    if (!pw) return false;
  }
  const url = await dbx.authUrl();
  return new Promise((resolve) => {
    let ok = false;
    const f = document.createElement('form');
    f.className = 'stack';
    f.innerHTML = `
      <ol class="steps">
        <li>Tocca <b>Apri Dropbox</b>, accedi e premi <b>Consenti</b>.</li>
        <li>Dropbox ti mostra un codice: copialo.</li>
        <li>Torna qui, incollalo sotto e tocca <b>Collega</b>.</li>
      </ol>
      <a class="btn block ghost" href="${esc(url)}" target="_blank" rel="noopener">Apri Dropbox</a>
      <label class="field"><span>Codice di Dropbox</span><input class="input" name="code" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Incolla qui il codice"></label>
      <p class="tiny" data-err style="color:var(--exp)"></p>
      <button class="btn block">Collega</button>`;
    const sh = sheet({ title: 'Collega Dropbox', body: f, onClose: () => resolve(ok) });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const code = f.querySelector('[name=code]').value.trim();
      if (!code) { f.querySelector('[data-err]').textContent = 'Incolla il codice che ti ha dato Dropbox.'; return; }
      const btn = f.querySelector('button.btn.block:last-child');
      btn.disabled = true; btn.textContent = 'Collego…';
      try { await dbx.connect(code); ok = true; sh.close(); }
      catch (err) { f.querySelector('[data-err]').textContent = err.message; btn.disabled = false; btn.textContent = 'Collega'; }
    };
  });
}

async function restoreFromDropbox() {
  let list;
  try { list = await dbx.listBackups(); } catch (e) { toast(e.message); return false; }
  if (!list.length) { toast('Su Dropbox non ci sono ancora backup'); return false; }
  return new Promise((resolve) => {
    let picked = false;
    const body = document.createElement('div');
    body.className = 'menu';
    body.style.boxShadow = 'none';
    body.innerHTML = list.map((b, i) => `<button data-i="${i}"><span class="ic">🗂️</span><span class="grow">${esc(fmtDate(b.date))}${i === 0 ? ' · il più recente' : ''}<small>${fmtNum(Math.max(1, Math.round(b.size / 1024)) * 100, { decimals: 0 })} KB · salvato ${esc(whenLabel(b.modified))}</small></span><span class="chev">›</span></button>`).join('');
    const sh = sheet({ title: 'Quale backup ripristinare?', body, onClose: () => { if (!picked) resolve(false); } });
    body.onclick = async (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      picked = true;
      sh.close();
      try {
        toast('Scarico il backup…', { ms: 1500 });
        const text = await dbx.download(list[+b.dataset.i].path);
        resolve(await restoreFromText(text));
      } catch (err) { toast(err.message); resolve(false); }
    };
  });
}

route('backup', async (root) => {
  const persisted = await isPersisted();
  const hasPw = !!(await getSecret('backupPassword'));
  const st = S.settings;
  root.innerHTML = `${head('Backup e ripristino')}
    ${dropboxCard()}
    <div class="card" style="margin-top:14px">
      <div class="kv"><span>Ultimo backup</span><b>${esc(whenLabel(st.lastBackupAt))}</b></div>
      <div class="kv"><span>Modifiche da allora</span><b>${fmtNum((st.changesSinceBackup || 0) * 100, { decimals: 0 })}</b></div>
      <div class="kv"><span>Movimenti salvati</span><b>${fmtNum(S.transactions.length * 100, { decimals: 0 })}</b></div>
      <div class="kv"><span>Archivio protetto dalla pulizia automatica</span><b>${persisted === true ? 'sì' : persisted === false ? 'non ancora' : '—'}</b></div>
    </div>

    <div class="section-title"><h2>Backup manuale</h2></div>
    <button class="btn block ${dbx.isConnected() ? 'ghost' : ''}" data-act="share" style="min-height:52px">Crea un backup e condividilo</button>
    <p class="tiny muted" style="margin:8px 4px 0">Si apre il menu Condividi: puoi salvarlo su Drive, mandarlo per email… È cifrato con la tua password.</p>
    <button class="btn block ghost" data-act="download" style="margin-top:12px">Scarica il backup nella memoria del telefono</button>

    <div class="section-title"><h2>Password e promemoria</h2></div>
    <div class="card">
      <label class="field"><span>Avvisami se non c'è un backup da</span>
        <select class="input" data-f="every">${[3, 7, 14, 30].map((d) => `<option value="${d}" ${st.backupEveryDays === d ? 'selected' : ''}>${d} giorni</option>`).join('')}</select></label>
      <div class="row" style="margin-top:12px;flex-wrap:wrap">
        <button class="btn small ghost" data-act="pw">${hasPw ? 'Cambia password' : 'Imposta password'}</button>
        ${hasPw ? '<button class="btn small ghost" data-act="forget">Dimentica password su questo telefono</button>' : ''}
      </div>
    </div>

    <div class="section-title"><h2>Ripristina da un file</h2></div>
    <div class="card stack">
      <p class="small ink2">Scegli un file di backup (da Drive, dai Download…). Ti verrà chiesta la password. Qui puoi anche caricare il file dei dati iniziali.</p>
      <label class="btn block line" style="position:relative">Scegli file di backup<input type="file" data-f="file" style="position:absolute;inset:0;opacity:0"></label>
    </div>`;
  root.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'share') { if (await makeBackup()) go('#/altro/backup'); }
    else if (a === 'download') { if (await makeBackup({ download: true })) go('#/altro/backup'); }
    else if (a === 'pw') {
      const pw = await askPassword({ forceNew: true, mustRemember: dbx.isConnected() });
      if (pw) toast('Password aggiornata: vale per i prossimi backup');
      go('#/altro/backup');
    } else if (a === 'forget') {
      if (dbx.isConnected() && !(await confirmDialog({ title: 'Dimenticare la password?', text: 'Senza password memorizzata il backup automatico su Dropbox si ferma.', ok: 'Dimentica', danger: true }))) return;
      await setSetting('backupPassword', null);
      toast('Password rimossa da questo telefono');
      go('#/altro/backup');
    } else if (a === 'dbx-connect') {
      if (!(await connectDropbox())) return;
      toast('Dropbox collegato');
      let list = [];
      try { list = await dbx.listBackups(); } catch { /* */ }
      if (list.length && (!S.transactions.length || await confirmDialog({ title: 'Su Dropbox ci sono già dei backup', text: `Il più recente è del ${fmtDate(list[0].date)}. Vuoi ripristinarlo su questo telefono? Se no, da adesso i backup partiranno da qui.`, ok: 'Scegli un backup', cancel: 'No, continua' }))) {
        if (await restoreFromDropbox()) { go('#/home'); return; }
      } else if (S.transactions.length) {
        try { await dbx.backupNow(); toast('Primo backup su Dropbox fatto'); } catch (err) { toast(err.message); }
      }
      go('#/altro/backup');
    } else if (a === 'dbx-now') {
      toast('Backup in corso…', { ms: 1500 });
      try { await dbx.backupNow(); toast('Backup su Dropbox fatto'); } catch (err) { toast(err.message); }
      go('#/altro/backup');
    } else if (a === 'dbx-restore') {
      if (await restoreFromDropbox()) go('#/home');
    } else if (a === 'dbx-off') {
      if (!(await confirmDialog({ title: 'Scollegare Dropbox?', text: 'Il backup automatico si ferma. I backup già su Dropbox restano lì.', ok: 'Scollega', danger: true }))) return;
      await dbx.disconnect();
      toast('Dropbox scollegato');
      go('#/altro/backup');
    }
  });
  root.addEventListener('change', async (e) => {
    if (e.target.dataset.f === 'every') { await setSetting('backupEveryDays', +e.target.value); toast('Promemoria aggiornato'); }
    if (e.target.dataset.f === 'file') {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try { if (await restoreFromFile(file)) go('#/home'); }
      catch (err) { toast(err.message); }
    }
  });
}, { tab: 'altro', live: true });

/* ---------- Spese ricorrenti ---------- */
route('ricorrenti', (root) => {
  const list = S.recurring.slice().sort((a, b) => (b.active - a.active) || (a.next || '').localeCompare(b.next || ''));
  root.innerHTML = `${head('Spese ricorrenti')}
    <p class="small ink2" style="margin:-6px 4px 14px">Vengono aggiunte da sole il giorno previsto, quando apri l'app.</p>
    ${list.length ? `<div class="list">${list.map((r) => {
      const c = S.cat.get(r.categoryId);
      const sign = r.type === 'expense' ? '−' : r.type === 'income' ? '+' : '';
      return `<button class="item wrap" data-id="${r.id}" style="${r.active ? '' : 'opacity:.55'}">
        <span class="bubble">${esc(r.type === 'transfer' ? '↔' : c?.icon || '📦')}</span>
        <span class="grow"><span class="t1" style="display:block">${esc(r.note || c?.name || 'Ricorrente')}</span>
        <span class="t2" style="display:block">${esc(describeRecurring(r))}${r.active ? ` · prossima ${fmtDate(r.next)}` : ' · in pausa'}</span></span>
        <span class="amt ${r.type === 'expense' ? 'exp' : r.type === 'income' ? 'inc' : ''}">${sign}${fmtNum(r.amount)} €</span></button>`;
    }).join('')}</div>` : `<div class="empty card"><h3>Nessuna spesa ricorrente</h3><p class="small">Aggiungine una qui sotto, oppure usa “Ripeti” quando inserisci una spesa.</p></div>`}
    <button class="btn block" data-act="new" style="margin-top:16px">${ICONS.plus.replace('<svg', '<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"')} Nuova ricorrente</button>`;
  root.addEventListener('click', (e) => {
    const it = e.target.closest('.item[data-id]');
    if (it) editRecurring(S.recurring.find((r) => r.id === it.dataset.id));
    if (e.target.closest('[data-act="new"]')) editRecurring(null);
  });
}, { tab: 'altro' });

function editRecurring(r) {
  const isNew = !r;
  const st = r ? { ...r } : { id: uid('p'), type: 'expense', amount: 0, categoryId: null, accountId: S.settings.defaultAccountId, toAccountId: null, note: '', freq: 'month', every: 1, day: null, start: today(), end: null, active: true };
  const f = document.createElement('form');
  f.className = 'stack';
  const draw = () => {
    const c = S.cat.get(st.categoryId);
    f.innerHTML = `
      <div class="seg t-${st.type}">${[['expense', 'Uscita'], ['income', 'Entrata'], ['transfer', 'Giroconto']].map(([t, l]) => `<button type="button" data-type="${t}" class="${st.type === t ? 'on' : ''}">${l}</button>`).join('')}</div>
      <label class="field"><span>Importo (€)</span><input class="input" name="amount" inputmode="decimal" value="${st.amount ? centsToInput(st.amount) : ''}" placeholder="Es. 6,99" autocomplete="off"></label>
      ${st.type === 'transfer'
        ? `<div class="row"><label class="field grow"><span>Da</span><select class="input" name="acc">${accountOptions(st.accountId)}</select></label>
           <label class="field grow"><span>A</span><select class="input" name="to">${accountOptions(st.toAccountId, { exclude: st.accountId })}</select></label></div>`
        : `<div class="field"><span>Voce</span><button type="button" class="cat-btn ${c ? '' : 'need'}" data-act="cat" style="width:100%;min-height:48px;justify-content:flex-start">${c ? `${esc(c.icon)} ${esc(c.name)}` : 'Scegli la voce'}</button></div>
           ${activeAccounts().length > 1 ? `<label class="field"><span>Conto</span><select class="input" name="acc">${accountOptions(st.accountId)}</select></label>` : ''}`}
      <label class="field"><span>Descrizione</span><input class="input" name="note" value="${esc(st.note)}" placeholder="Es. Abbonamento Iliad" maxlength="80" autocomplete="off"></label>
      <div class="row"><label class="field" style="width:90px"><span>Ogni</span><input class="input" name="every" type="number" min="1" max="99" value="${st.every}"></label>
        <label class="field grow"><span>&nbsp;</span><select class="input" name="freq">${[['day', 'giorno/i'], ['week', 'settimana/e'], ['month', 'mese/i'], ['year', 'anno/i']].map(([v, l]) => `<option value="${v}" ${st.freq === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      ${st.freq === 'month' ? `<label class="field"><span>Giorno del mese</span><select class="input" name="day">${Array.from({ length: 30 }, (_, i) => i + 1).map((d) => `<option value="${d}" ${st.day === d ? 'selected' : ''}>${d}</option>`).join('')}<option value="31" ${st.day >= 31 ? 'selected' : ''}>ultimo giorno del mese</option></select></label>` : ''}
      <div class="row"><label class="field grow"><span>${isNew ? 'Prima volta' : 'Prossima volta'}</span><input class="input" type="date" name="start" value="${isNew ? st.start : st.next || st.start}"></label>
        <label class="field grow"><span>Fino al (facoltativo)</span><input class="input" type="date" name="end" value="${st.end || ''}"></label></div>
      ${isNew ? '' : `<label class="remember" style="font-size:15px"><input type="checkbox" name="active" ${st.active ? 'checked' : ''}> Attiva</label>`}
      <p class="tiny" data-err style="color:var(--exp)"></p>
      <button class="btn block">${isNew ? 'Crea ricorrente' : 'Salva'}</button>
      ${isNew ? '' : '<button type="button" class="btn block line" data-act="delete" style="color:var(--exp)">Elimina ricorrente</button><p class="tiny muted">I movimenti già creati restano nell\'elenco.</p>'}`;
    if (!st.day && st.freq === 'month') { const d = parseISO(st.start); st.day = d.getDate(); f.querySelector('[name=day]').value = String(st.day); }
  };
  const collect = () => {
    const g = (n) => f.querySelector(`[name=${n}]`);
    st.amount = parseAmount(g('amount')?.value) || 0;
    st.note = g('note')?.value.trim() || '';
    st.every = Math.max(1, parseInt(g('every')?.value, 10) || 1);
    st.freq = g('freq')?.value || st.freq;
    if (g('day')) st.day = +g('day').value;
    if (g('acc')) st.accountId = g('acc').value;
    if (g('to')) st.toAccountId = g('to').value;
    st.startInput = g('start')?.value || today();
    st.end = g('end')?.value || null;
    if (g('active')) st.active = g('active').checked;
  };
  draw();
  const sh = sheet({ title: isNew ? 'Nuova ricorrente' : 'Spesa ricorrente', body: f });
  f.addEventListener('change', (e) => { if (['freq'].includes(e.target.name)) { collect(); st.start = st.startInput; draw(); } });
  f.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.type) { collect(); st.type = b.dataset.type; st.categoryId = null; if (st.type === 'transfer' && !st.toAccountId) st.toAccountId = activeAccounts().find((a) => a.id !== st.accountId)?.id || null; st.start = st.startInput; draw(); }
    if (b.dataset.act === 'cat') { collect(); st.start = st.startInput; const r2 = await pickCategory({ type: st.type, current: st.categoryId }); if (r2?.categoryId) st.categoryId = r2.categoryId; draw(); }
    if (b.dataset.act === 'delete') {
      if (await confirmDialog({ title: 'Eliminare la ricorrente?', text: 'Non verranno più aggiunti nuovi movimenti.', ok: 'Elimina', danger: true })) { await del('recurring', st.id); sh.close(); toast('Ricorrente eliminata'); }
    }
  });
  f.onsubmit = async (e) => {
    e.preventDefault();
    collect();
    const err = (m) => { f.querySelector('[data-err]').textContent = m; };
    if (!st.amount) return err('Scrivi l\'importo.');
    if (st.type !== 'transfer' && !st.categoryId) return err('Scegli la voce.');
    if (st.type === 'transfer' && (!st.toAccountId || st.toAccountId === st.accountId)) return err('Scegli due conti diversi (crea prima il secondo conto in “Conti e saldo”).');
    if (st.end && st.end < st.startInput) return err('La data di fine è prima dell\'inizio.');
    const out = { ...st };
    delete out.startInput;
    if (isNew) { out.start = st.startInput; out.next = firstOccurrence(out); }
    else { out.next = st.startInput; if (st.freq === 'month' && st.day) out.next = firstOccurrence({ ...out, start: st.startInput }); }
    if (out.type === 'transfer') out.categoryId = null; else out.toAccountId = null;
    await put('recurring', out);
    sh.close();
    const { runRecurring } = await import('./model.js');
    const n = await runRecurring();
    toast(n ? `Salvata. Aggiunti ${n} movimenti già scaduti` : `Salvata. Prossima volta: ${fmtDate(S.recurring.find((x) => x.id === out.id).next)}`);
  };
}

/* ---------- Voci (categorie) ---------- */
route('categorie', (root, params) => {
  const type = params.t === 'income' ? 'income' : 'expense';
  const stats = new Map();
  for (const t of S.transactions) {
    if (!t.categoryId) continue;
    const s = stats.get(t.categoryId) || { n: 0, sum: 0, last: '' };
    s.n++; s.sum += t.amount; if (t.date > s.last) s.last = t.date;
    stats.set(t.categoryId, s);
  }
  const cats = catsOfType(type, { includeArchived: true }).slice().sort((a, b) => (a.archived - b.archived) || ((stats.get(b.id)?.n || 0) - (stats.get(a.id)?.n || 0)));
  root.innerHTML = `${head('Voci')}
    <div class="seg t-${type}" style="margin-bottom:14px"><a class="${type === 'expense' ? 'on' : ''}" href="#/altro/categorie?t=expense">Uscite</a><a class="${type === 'income' ? 'on' : ''}" href="#/altro/categorie?t=income">Entrate</a></div>
    <div class="list">${cats.map((c) => {
      const s = stats.get(c.id);
      return `<button class="item" data-id="${c.id}" style="${c.archived ? 'opacity:.5' : ''}"><span class="bubble">${esc(c.icon || '📦')}</span>
        <span class="grow"><span class="t1" style="display:block">${esc(c.name)}${c.archived ? '<span class="tag">archiviata</span>' : ''}</span>
        <span class="t2" style="display:block">${s ? `${plural(s.n, 'movimento', 'movimenti')} · ultimo ${fmtDate(s.last)}` : 'Mai usata'}</span></span>
        <span class="amt">${s ? fmtNum(s.sum, { decimals: 0 }) + ' €' : ''}</span></button>`;
    }).join('')}</div>
    <button class="btn block" data-act="new" style="margin-top:16px">Nuova voce</button>`;
  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="new"]')) { await editCategory({ type }); return; }
    const it = e.target.closest('.item[data-id]');
    if (it) categoryActions(S.cat.get(it.dataset.id), stats.get(it.dataset.id));
  });
}, { tab: 'altro' });

function categoryActions(c, s) {
  const body = document.createElement('div');
  body.className = 'menu';
  body.style.boxShadow = 'none';
  body.innerHTML = `
    <button data-a="edit"><span class="ic">✏️</span><span class="grow">Rinomina o cambia icona</span></button>
    <button data-a="list"><span class="ic">📋</span><span class="grow">Vedi i movimenti</span></button>
    <button data-a="merge"><span class="ic">🔀</span><span class="grow">Unisci a un'altra voce<small>Sposta tutti i movimenti e le regole</small></span></button>
    <button data-a="archive"><span class="ic">🗄️</span><span class="grow">${c.archived ? 'Ripristina voce' : 'Archivia'}<small>${c.archived ? '' : 'Non compare più nell\'inserimento, i dati restano'}</small></span></button>
    ${s ? '' : '<button data-a="delete"><span class="ic">🗑️</span><span class="grow" style="color:var(--exp)">Elimina</span></button>'}`;
  const sh = sheet({ title: `${c.icon || ''} ${c.name}`, body });
  body.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    sh.close();
    if (a === 'edit') await editCategory({ type: c.type, cat: c });
    if (a === 'list') go(`#/movimenti?cat=${c.id}`);
    if (a === 'archive') { await put('categories', { ...c, archived: !c.archived }); toast(c.archived ? 'Voce ripristinata' : 'Voce archiviata'); }
    if (a === 'delete') { if (await confirmDialog({ title: `Eliminare “${c.name}”?`, ok: 'Elimina', danger: true })) { await del('categories', c.id); toast('Voce eliminata'); } }
    if (a === 'merge') {
      const r = await pickCategory({ type: c.type, title: `Unisci “${c.name}” in…` });
      if (!r?.categoryId || r.categoryId === c.id) return;
      const target = S.cat.get(r.categoryId);
      if (!(await confirmDialog({ title: `Unire in “${target.name}”?`, text: `${s ? plural(s.n, 'movimento passa', 'movimenti passano') : 'Nessun movimento passa'} da “${c.name}” a “${target.name}”, che poi viene eliminata.`, ok: 'Unisci' }))) return;
      await putMany('transactions', S.transactions.filter((t) => t.categoryId === c.id).map((t) => ({ ...t, categoryId: target.id })));
      await putMany('rules', S.rules.filter((x) => x.categoryId === c.id).map((x) => ({ ...x, categoryId: target.id })));
      await putMany('recurring', S.recurring.filter((x) => x.categoryId === c.id).map((x) => ({ ...x, categoryId: target.id })));
      await del('categories', c.id);
      toast(`Unita in “${target.name}”`);
    }
  };
}

/* ---------- Conti ---------- */
route('conti', (root) => {
  root.innerHTML = `${head('Conti e saldo')}
    <p class="small ink2" style="margin:-6px 4px 14px">Il saldo parte dall'ultimo valore allineato con la banca e somma i movimenti successivi. Importando un estratto conto si allinea da solo.</p>
    <div class="list">${S.accounts.map((a) => `<button class="item" data-id="${a.id}" style="${a.archived ? 'opacity:.5' : ''}">
      <span class="bubble">${a.kind === 'cash' ? '💶' : a.kind === 'bank' ? '🏦' : '👛'}</span>
      <span class="grow"><span class="t1" style="display:block">${esc(a.name)}${a.id === S.settings.defaultAccountId ? '<span class="tag">predefinito</span>' : ''}</span>
      <span class="t2" style="display:block">${a.ref ? `Allineato al ${fmtDate(a.ref.date)}: ${fmtEur(a.ref.amount)}` : 'Mai allineato'}</span></span>
      <span class="amt">${fmtEur(balance(a.id))}</span></button>`).join('')}</div>
    <button class="btn block" data-act="new" style="margin-top:16px">Nuovo conto</button>`;
  root.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="new"]')) {
      const name = await promptDialog({ title: 'Nuovo conto', placeholder: 'Es. Contanti, Conto deposito', ok: 'Crea' });
      if (name?.trim()) await put('accounts', { id: uid('a'), name: name.trim(), kind: /contant/i.test(name) ? 'cash' : 'other', ref: null, order: S.accounts.length, archived: false });
      return;
    }
    const it = e.target.closest('.item[data-id]');
    if (it) accountSheet(S.acc.get(it.dataset.id));
  });
}, { tab: 'altro' });

function accountSheet(a) {
  const used = S.transactions.some((t) => t.accountId === a.id || t.toAccountId === a.id);
  const f = document.createElement('form');
  f.className = 'stack';
  f.innerHTML = `
    <label class="field"><span>Nome</span><input class="input" name="nm" value="${esc(a.name)}" maxlength="40"></label>
    <div class="card" style="box-shadow:none;background:var(--surface-2)">
      <h3>Allinea il saldo</h3>
      <p class="small ink2" style="margin:4px 0 10px">Scrivi il saldo reale che vedi nell'app della banca. I movimenti di quella data si considerano già inclusi.</p>
      <div class="row"><label class="field grow"><span>Saldo reale (€)</span><input class="input" name="bal" inputmode="decimal" placeholder="${centsToInput(balance(a.id))}" autocomplete="off"></label>
      <label class="field grow"><span>Alla data</span><input class="input" type="date" name="dt" value="${today()}"></label></div>
    </div>
    <label class="remember" style="font-size:15px"><input type="checkbox" name="def" ${a.id === S.settings.defaultAccountId ? 'checked' : ''}> Conto predefinito per le nuove spese</label>
    <button class="btn block">Salva</button>
    ${S.accounts.length > 1 ? `<button type="button" class="btn block line" data-act="${used ? 'archive' : 'delete'}">${used ? (a.archived ? 'Riattiva conto' : 'Archivia conto') : 'Elimina conto'}</button>` : ''}`;
  const sh = sheet({ title: a.name, body: f });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const upd = { ...a, name: f.querySelector('[name=nm]').value.trim() || a.name };
    const bal = parseAmount(f.querySelector('[name=bal]').value.replace(/^−/, '-'));
    if (f.querySelector('[name=bal]').value.trim() !== '' && bal != null) upd.ref = { date: f.querySelector('[name=dt]').value || today(), amount: bal };
    await put('accounts', upd);
    if (f.querySelector('[name=def]').checked) await setSetting('defaultAccountId', a.id);
    sh.close();
    toast('Conto aggiornato');
  };
  f.querySelector('[data-act]')?.addEventListener('click', async (e) => {
    const act = e.target.dataset.act;
    if (act === 'delete' && (await confirmDialog({ title: `Eliminare “${a.name}”?`, ok: 'Elimina', danger: true }))) {
      await del('accounts', a.id);
      if (S.settings.defaultAccountId === a.id) await setSetting('defaultAccountId', S.accounts[0].id);
      sh.close();
    }
    if (act === 'archive') { await put('accounts', { ...a, archived: !a.archived }); sh.close(); }
  });
}

/* ---------- Regole ---------- */
route('regole', (root) => {
  const rules = S.rules.slice().sort((a, b) => a.pattern.localeCompare(b.pattern));
  root.innerHTML = `${head('Regole')}
    <p class="small ink2" style="margin:-6px 4px 14px">Quando importi un estratto conto, se la descrizione contiene il testo della regola il movimento va nella voce indicata. Le regole nascono quando classifichi un movimento nuovo e lasci attivo “Ricorda”.</p>
    ${rules.length ? `<div class="list">${rules.map((r) => {
      const c = S.cat.get(r.categoryId);
      return `<button class="item" data-id="${r.id}"><span class="bubble">${esc(r.toAccountId ? '↔' : c?.icon || '❔')}</span>
        <span class="grow"><span class="t1" style="display:block">“${esc(r.pattern)}”</span>
        <span class="t2" style="display:block">${r.type === 'income' ? 'Entrata' : 'Uscita'} → ${esc(r.toAccountId ? `Giroconto verso ${accName(r.toAccountId)}` : c?.name || 'voce eliminata')}</span></span></button>`;
    }).join('')}</div>` : '<div class="empty card"><h3>Nessuna regola</h3><p class="small">Si creano durante l\'import dell\'estratto conto.</p></div>'}
    <button class="btn block ghost" data-act="new" style="margin-top:16px">Aggiungi regola</button>`;
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="new"]')) return editRule(null);
    const it = e.target.closest('.item[data-id]');
    if (it) editRule(S.rules.find((r) => r.id === it.dataset.id));
  });
}, { tab: 'altro' });

function editRule(r) {
  const st = r ? { ...r } : { id: uid('r'), pattern: '', type: 'expense', categoryId: null, toAccountId: null };
  const f = document.createElement('form');
  f.className = 'stack';
  const draw = () => {
    const c = S.cat.get(st.categoryId);
    f.innerHTML = `
      <label class="field"><span>Se la descrizione contiene</span><input class="input" name="p" value="${esc(st.pattern)}" placeholder="Es. esselunga" autocomplete="off"></label>
      <div class="seg t-${st.type}">${[['expense', 'Uscita'], ['income', 'Entrata']].map(([t, l]) => `<button type="button" data-type="${t}" class="${st.type === t ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="field"><span>Allora mettilo in</span><button type="button" class="cat-btn ${c || st.toAccountId ? '' : 'need'}" data-act="cat" style="width:100%;min-height:48px;justify-content:flex-start">${st.toAccountId ? `↔ Giroconto verso ${esc(accName(st.toAccountId))}` : c ? `${esc(c.icon)} ${esc(c.name)}` : 'Scegli la voce'}</button></div>
      <button class="btn block">Salva regola</button>
      ${r ? '<button type="button" class="btn block line" data-act="delete" style="color:var(--exp)">Elimina regola</button>' : ''}`;
  };
  draw();
  const sh = sheet({ title: r ? 'Regola' : 'Nuova regola', body: f });
  f.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    st.pattern = f.querySelector('[name=p]').value;
    if (b.dataset.type) { st.type = b.dataset.type; st.categoryId = null; draw(); }
    if (b.dataset.act === 'cat') {
      const x = await pickCategory({ type: st.type, allowTransfer: activeAccounts().length > 1, current: st.categoryId });
      if (x?.categoryId) { st.categoryId = x.categoryId; st.toAccountId = null; }
      if (x?.transfer) {
        const others = activeAccounts().filter((a) => a.id !== S.settings.defaultAccountId);
        st.toAccountId = others[0]?.id || null; st.categoryId = null;
      }
      draw();
    }
    if (b.dataset.act === 'delete') { await del('rules', st.id); sh.close(); toast('Regola eliminata'); }
  });
  f.onsubmit = async (e) => {
    e.preventDefault();
    st.pattern = f.querySelector('[name=p]').value.trim().toLowerCase();
    if (st.pattern.length < 3) return toast('Scrivi almeno 3 caratteri');
    if (!st.categoryId && !st.toAccountId) return toast('Scegli la voce');
    await put('rules', st);
    sh.close();
    toast('Regola salvata');
  };
}

/* ---------- Impostazioni e info ---------- */
route('info', async (root) => {
  let est = null;
  try { est = await navigator.storage?.estimate?.(); } catch {}
  const theme = localStorageGet('theme') || 'auto';
  root.innerHTML = `${head('Impostazioni')}
    <div class="card stack">
      <label class="field"><span>Aspetto</span><select class="input" data-f="theme">
        ${[['auto', 'Come il telefono'], ['light', 'Chiaro'], ['dark', 'Scuro']].map(([v, l]) => `<option value="${v}" ${theme === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="section-title"><h2>Dove sono i dati</h2></div>
    <div class="card">
      <p class="small ink2">Tutto resta in questo telefono, nell'archivio del browser dedicato all'app. Nessun server riceve i tuoi movimenti. La copia di sicurezza è il backup cifrato che salvi su Drive.</p>
      <div class="kv" style="margin-top:8px"><span>Spazio usato</span><b>${est?.usage ? fmtNum(Math.max(1, Math.round(est.usage / 1024)) * 100, { decimals: 0 }) + ' KB' : '—'}</b></div>
      <div class="kv"><span>Movimenti</span><b>${fmtNum(S.transactions.length * 100, { decimals: 0 })}</b></div>
      <div class="kv"><span>Versione</span><b>1.0</b></div>
    </div>
    <div class="section-title"><h2>Zona pericolosa</h2></div>
    <button class="btn block line" data-act="wipe" style="color:var(--exp)">Cancella tutti i dati da questo telefono</button>`;
  root.querySelector('[data-f="theme"]').onchange = (e) => { localStorageSet('theme', e.target.value); applyTheme(); };
  root.querySelector('[data-act="wipe"]').onclick = async () => {
    const ok = await confirmDialog({ title: 'Cancellare tutto?', text: 'Movimenti, voci, regole e impostazioni verranno eliminati da questo telefono. I backup su Drive restano. Fai prima un backup se non ne hai uno recente.', ok: 'Cancella tutto', danger: true });
    if (!ok) return;
    const typed = await promptDialog({ title: 'Conferma', text: 'Scrivi CANCELLA per confermare.', ok: 'Cancella' });
    if ((typed || '').trim().toUpperCase() !== 'CANCELLA') return toast('Operazione annullata');
    const { replaceAll } = await import('./store.js');
    await replaceAll({ categories: [], accounts: [], transactions: [], recurring: [], rules: [], settings: {} });
    const { ensureDefaults } = await import('./model.js');
    await ensureDefaults();
    toast('Dati cancellati');
    go('#/home');
  };
}, { tab: 'altro', live: false });

function localStorageGet(k) { try { return localStorage.getItem('bilancio.' + k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem('bilancio.' + k, v); } catch {} }
export function applyTheme() {
  const t = localStorageGet('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const meta = document.querySelectorAll('meta[name="theme-color"]');
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  meta.forEach((m) => m.setAttribute('content', dark ? '#0E1413' : '#EEF1EF'));
}
applyTheme();
