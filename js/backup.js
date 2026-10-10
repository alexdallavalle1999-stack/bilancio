// Backup cifrato (AES-GCM, chiave derivata dalla password con PBKDF2) e ripristino
import { S, exportData, replaceAll, setSetting, getSecret } from './store.js';
import { today, fmtNum, fmtDate } from './util.js';
import { toast, confirmDialog, sheet } from './ui.js';
import { catOf, accName } from './model.js';

const ITER = 310000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password, salt, iterations = ITER) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function gzip(bytes) {
  if (!('CompressionStream' in self)) return { bytes, gz: false };
  const cs = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return { bytes: new Uint8Array(await new Response(cs).arrayBuffer()), gz: true };
}
async function gunzip(bytes) {
  const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(ds).arrayBuffer());
}

export async function encryptBackup(password) {
  const payload = enc.encode(JSON.stringify(exportData()));
  const { bytes, gz } = await gzip(payload);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return JSON.stringify({
    app: 'bilancio', version: 1, encrypted: true, exportedAt: new Date().toISOString(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITER, salt: b64(salt) },
    cipher: { name: 'AES-GCM', iv: b64(iv) }, gzip: gz, data: b64(ct),
  });
}

export async function decryptBackup(obj, password) {
  const key = await deriveKey(password, unb64(obj.kdf.salt), obj.kdf.iterations);
  let bytes;
  try { bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(obj.cipher.iv) }, key, unb64(obj.data))); }
  catch { throw new Error('Password errata'); }
  if (obj.gzip) bytes = await gunzip(bytes);
  return JSON.parse(dec.decode(bytes));
}

export function parseBackupText(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('Il file non è un backup di Bilancio.'); }
  if (obj?.app !== 'bilancio') throw new Error('Il file non è un backup di Bilancio.');
  return obj;
}

export function validateData(d) {
  if (!d || !Array.isArray(d.transactions) || !Array.isArray(d.categories) || !Array.isArray(d.accounts)) throw new Error('Il backup è incompleto o danneggiato.');
  return d;
}

function fileName(ext = 'txt') { return `bilancio_backup_${today()}.${ext}`; }

async function deliver(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Backup Bilancio' });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'aborted';
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'downloaded';
}

async function markDone() {
  await setSetting('lastBackupAt', new Date().toISOString());
  await setSetting('changesSinceBackup', 0);
}

// Chiede (o recupera) la password del backup
export async function askPassword({ forceNew = false, mustRemember = false, note = '' } = {}) {
  const stored = !forceNew ? await getSecret('backupPassword') : null;
  if (stored) return stored;
  return new Promise((resolve) => {
    let result = null;
    const f = document.createElement('form');
    f.className = 'stack';
    f.innerHTML = `
      ${note ? `<p class="small" style="font-weight:600">${note}</p>` : ''}
      <p class="small ink2">Il file di backup viene cifrato con questa password: senza, nessuno può leggerlo, neanche su Drive. Se la dimentichi il backup non è recuperabile, quindi annotala in un posto sicuro.</p>
      <label class="field"><span>Password</span><input class="input" type="password" name="p1" minlength="6" required autocomplete="new-password"></label>
      <label class="field"><span>Ripeti password</span><input class="input" type="password" name="p2" minlength="6" required autocomplete="new-password"></label>
      <label class="remember" style="font-size:14px"><input type="checkbox" name="rem" checked ${mustRemember ? 'disabled' : ''}> Ricorda su questo telefono ${mustRemember ? '(serve per il backup automatico)' : '(backup con un tocco)'}</label>
      <p class="tiny muted" data-err style="color:var(--exp)"></p>
      <button class="btn block">Usa questa password</button>`;
    const sh = sheet({ title: 'Password del backup', body: f, onClose: () => resolve(result) });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const p1 = f.querySelector('[name=p1]').value, p2 = f.querySelector('[name=p2]').value;
      if (p1.length < 6) { f.querySelector('[data-err]').textContent = 'Usa almeno 6 caratteri.'; return; }
      if (p1 !== p2) { f.querySelector('[data-err]').textContent = 'Le due password non coincidono.'; return; }
      if (mustRemember || f.querySelector('[name=rem]').checked) await setSetting('backupPassword', p1);
      result = p1;
      sh.close();
    };
    setTimeout(() => f.querySelector('[name=p1]').focus(), 80);
  });
}

export async function makeBackup({ download = false } = {}) {
  const pw = await askPassword();
  if (!pw) return false;
  toast('Preparo il backup…', { ms: 1500 });
  const text = await encryptBackup(pw);
  const file = new File([text], fileName('txt'), { type: 'text/plain' });
  const how = download ? await (async () => { const u = URL.createObjectURL(file); const a = document.createElement('a'); a.href = u; a.download = file.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); return 'downloaded'; })() : await deliver(file);
  if (how === 'aborted') { toast('Backup annullato'); return false; }
  await markDone();
  toast(how === 'shared' ? 'Backup creato e condiviso' : `Backup scaricato: ${file.name}`);
  return true;
}

export async function restoreFromFile(file) {
  return restoreFromText(await file.text());
}

export async function restoreFromText(text) {
  const obj = parseBackupText(text);
  let data;
  if (obj.encrypted) {
    const stored = await getSecret('backupPassword');
    let pw = stored;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!pw) {
        const { promptDialog } = await import('./ui.js');
        pw = await promptDialog({ title: 'Password del backup', text: 'Inserisci la password usata per creare il backup.', type: 'password', ok: 'Apri' });
        if (pw == null) return false;
      }
      try { data = await decryptBackup(obj, pw); break; }
      catch (e) { toast(e.message); pw = null; }
    }
    if (!data) return false;
  } else {
    data = obj.data;
  }
  validateData(data);
  const nTx = data.transactions.length;
  const span = nTx ? `dal ${fmtDate(data.transactions.reduce((m, t) => (t.date < m ? t.date : m), '9999'))} al ${fmtDate(data.transactions.reduce((m, t) => (t.date > m ? t.date : m), '0000'))}` : '';
  const ok = await confirmDialog({
    title: 'Ripristinare questo backup?',
    text: `${fmtNum(nTx * 100, { decimals: 0 })} movimenti ${span}, ${data.categories.length} voci, ${data.recurring?.length || 0} ricorrenti.${S.transactions.length ? ` I ${fmtNum(S.transactions.length * 100, { decimals: 0 })} movimenti presenti ora su questo telefono verranno sostituiti.` : ''}`,
    ok: 'Ripristina',
    danger: S.transactions.length > 0,
  });
  if (!ok) return false;
  await replaceAll(data);
  await setSetting('changesSinceBackup', obj.encrypted ? 0 : 1);
  toast('Dati ripristinati');
  return true;
}

export async function exportCsv() {
  const rows = [['Data', 'Tipo', 'Voce', 'Importo', 'Conto', 'Verso conto', 'Nota', 'Descrizione banca']];
  const tipo = { expense: 'Uscita', income: 'Entrata', transfer: 'Giroconto' };
  for (const t of S.transactions) {
    const amt = (t.type === 'expense' ? -t.amount : t.amount) / 100;
    rows.push([fmtDate(t.date), tipo[t.type], catOf(t)?.name || '', String(amt).replace('.', ','), accName(t.accountId), t.toAccountId ? accName(t.toAccountId) : '', t.note || '', t.bank || '']);
  }
  const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const file = new File([csv], `bilancio_movimenti_${today()}.csv`, { type: 'text/csv' });
  const how = await deliver(file);
  if (how !== 'aborted') toast('File CSV pronto');
}
