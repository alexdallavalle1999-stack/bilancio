// Backup automatico su Dropbox: una copia cifrata al giorno, si tengono le ultime 10.
// Collegamento con OAuth PKCE senza redirect: Dropbox mostra un codice da incollare nell'app.
import { S, setSetting, getSecret, onChange, IS_TEST } from './store.js';
import { encryptBackup } from './backup.js';
import { today } from './util.js';

// Chiave pubblica dell'app registrata su Dropbox (non è un segreto: può stare nel codice)
export const APP_KEY = 'lecxca8koqw0fqb';
const FOLDER = IS_TEST ? '/prova' : '/backup';
export const KEEP = 10;
const API = 'https://api.dropboxapi.com';
const CONTENT = 'https://content.dropboxapi.com';
const VERIFIER_KEY = 'bilancio.dbx.verifier';

let access = null; // { token, exp }

export const isConfigured = () => !!APP_KEY;
export const isConnected = () => !!S.settings.dropbox?.refresh;
export const status = () => S.settings.dropbox || null;

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// 1) prepara l'indirizzo della pagina Dropbox in cui consentire l'accesso
export async function authUrl() {
  // se l'app si è riavviata mentre eri su Dropbox, riusa la stessa chiave così il codice resta valido
  let verifier = null;
  try { const o = JSON.parse(localStorage.getItem(VERIFIER_KEY) || 'null'); if (o && Date.now() - o.t < 15 * 60000) verifier = o.v; } catch { /* */ }
  verifier = verifier || b64url(crypto.getRandomValues(new Uint8Array(48)));
  try { localStorage.setItem(VERIFIER_KEY, JSON.stringify({ v: verifier, t: Date.now() })); } catch { /* resta in memoria */ }
  authUrl.verifier = verifier;
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({ client_id: APP_KEY, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline' });
  return `https://www.dropbox.com/oauth2/authorize?${q}`;
}

// 2) scambia il codice mostrato da Dropbox con un permesso che si rinnova da solo
export async function connect(code) {
  let verifier = authUrl.verifier;
  try { verifier = JSON.parse(localStorage.getItem(VERIFIER_KEY) || 'null')?.v || verifier; } catch { /* */ }
  if (!verifier) throw new Error('Ripeti il collegamento dall\'inizio.');
  const r = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({ code: code.trim(), grant_type: 'authorization_code', code_verifier: verifier, client_id: APP_KEY }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) throw new Error(j.error_description || 'Codice non valido o scaduto: ripeti il collegamento.');
  access = { token: j.access_token, exp: Date.now() + (j.expires_in || 14400) * 1000 };
  let email = '';
  try { const a = await apiCall('users/get_current_account', null); email = a.email || ''; } catch { /* permesso non concesso: pazienza */ }
  await setSetting('dropbox', { refresh: j.refresh_token, account: j.account_id || '', email, connectedAt: new Date().toISOString(), lastAt: null, lastError: null });
  try { localStorage.removeItem(VERIFIER_KEY); } catch { /* */ }
}

export async function disconnect() {
  try { if (isConnected()) await apiCall('auth/token/revoke', null); } catch { /* già revocato */ }
  access = null;
  await setSetting('dropbox', null);
}

async function token() {
  if (access && access.exp > Date.now() + 60000) return access.token;
  const d = S.settings.dropbox;
  if (!d?.refresh) throw new Error('Dropbox non è collegato.');
  const r = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: d.refresh, client_id: APP_KEY }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error === 'invalid_grant' ? 'Accesso a Dropbox revocato: ricollega Dropbox.' : 'Dropbox non risponde, riprovo più tardi.';
    await setSetting('dropbox', { ...d, lastError: msg });
    throw new Error(msg);
  }
  access = { token: j.access_token, exp: Date.now() + (j.expires_in || 14400) * 1000 };
  return access.token;
}

async function apiCall(path, body) {
  const t = await token();
  const r = await fetch(`${API}/2/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, ...(body === null ? {} : { 'Content-Type': 'application/json' }) },
    body: body === null ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) { const e = new Error(j.error_summary || `Errore Dropbox ${r.status}`); e.summary = j.error_summary || ''; throw e; }
  return j;
}

async function upload(path, text) {
  const t = await token();
  const r = await fetch(`${CONTENT}/2/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path, mode: 'overwrite', mute: true }) },
    body: new Blob([text]),
  });
  if (!r.ok) throw new Error(`Caricamento su Dropbox non riuscito (${r.status})`);
  return r.json();
}

export async function download(path) {
  const t = await token();
  const r = await fetch(`${CONTENT}/2/files/download`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Dropbox-API-Arg': JSON.stringify({ path }) },
  });
  if (!r.ok) throw new Error(`Download da Dropbox non riuscito (${r.status})`);
  return r.text();
}

// copie presenti, dalla più recente
export async function listBackups() {
  try {
    const j = await apiCall('files/list_folder', { path: FOLDER });
    return j.entries.filter((e) => e['.tag'] === 'file' && /^bilancio_\d{4}-\d{2}-\d{2}\.txt$/.test(e.name))
      .sort((a, b) => b.name.localeCompare(a.name))
      .map((e) => ({ name: e.name, path: e.path_lower || `${FOLDER}/${e.name}`, date: e.name.slice(9, 19), modified: e.server_modified, size: e.size }));
  } catch (e) {
    if (/not_found/.test(e.summary || '')) return [];
    throw e;
  }
}

let running = null;
export async function backupNow() {
  if (running) return running;
  running = (async () => {
    if (!S.transactions.length) throw new Error('Non c\'è ancora niente da salvare.');
    const pw = await getSecret('backupPassword');
    if (!pw) throw new Error('Per il backup automatico la password deve essere memorizzata su questo telefono.');
    const changesAtStart = S.settings.changesSinceBackup || 0;
    const text = await encryptBackup(pw);
    await upload(`${FOLDER}/bilancio_${today()}.txt`, text);
    const list = await listBackups();
    for (const old of list.slice(KEEP)) { try { await apiCall('files/delete_v2', { path: old.path }); } catch { /* riproverò la prossima volta */ } }
    const now = new Date().toISOString();
    await setSetting('lastBackupAt', now);
    // le modifiche fatte durante il caricamento restano da salvare
    await setSetting('changesSinceBackup', Math.max(0, (S.settings.changesSinceBackup || 0) - changesAtStart));
    await setSetting('dropbox', { ...S.settings.dropbox, lastAt: now, lastError: null, copies: Math.min(list.length, KEEP) });
    return now;
  })();
  try { return await running; } finally { running = null; }
}

// Backup automatico: qualche secondo dopo l'ultima modifica, all'avvio e quando l'app va in secondo piano
let timer = null;
const DELAY = 15000;
async function autoRun() {
  timer = null;
  // mai caricare un archivio vuoto (es. telefono nuovo appena installato): coprirebbe un backup buono
  if (!isConfigured() || !isConnected() || !S.transactions.length || !(S.settings.changesSinceBackup > 0)) return;
  if (!(await getSecret('backupPassword'))) return;
  try { await backupNow(); } catch (e) {
    if (isConnected()) await setSetting('dropbox', { ...S.settings.dropbox, lastError: e.message });
  }
}
export function startAuto() {
  onChange((what) => {
    if (what === 'settings' || !isConnected()) return;
    clearTimeout(timer);
    timer = setTimeout(autoRun, DELAY);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && timer) { clearTimeout(timer); autoRun(); }
  });
  setTimeout(autoRun, 4000);
}
