// Componenti di interfaccia riutilizzabili: fogli, avvisi, toast, selettori
import { esc, uid, norm } from './util.js';
import { S, put } from './store.js';
import { catsOfType } from './model.js';

/* ---------- Toast ---------- */
let toastTimer;
export function toast(msg, { action, onAction, ms = 4000 } = {}) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span class="grow">${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; onAction?.(); };
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? Math.max(ms, 6000) : ms);
}

/* ---------- Fogli dal basso (dialog nativi: il tasto indietro di Android li chiude) ---------- */
export function sheet({ title, body, onClose, actions = '' }) {
  const d = document.createElement('dialog');
  d.className = 'sheet';
  d.innerHTML = `<div class="sheet-grip"></div>
    <div class="sheet-head"><h2>${esc(title)}</h2>${actions}
      <button class="icon-btn flat" data-close aria-label="Chiudi"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="sheet-body"></div>`;
  const b = d.querySelector('.sheet-body');
  if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
  document.body.appendChild(d);
  let closed = false;
  const close = (val) => { if (closed) return; closed = true; d.returnValue = ''; d.close(); d._val = val; };
  d.addEventListener('close', () => { closed = true; onClose?.(d._val); setTimeout(() => d.remove(), 300); });
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  d.querySelector('[data-close]').onclick = () => close();
  d.showModal();
  return { el: d, body: b, close };
}

export function confirmDialog({ title, text = '', ok = 'Conferma', cancel = 'Annulla', danger = false }) {
  return new Promise((res) => {
    const d = document.createElement('dialog');
    d.className = 'alert';
    d.innerHTML = `<h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}
      <div class="actions"><button class="btn ghost small" data-v="0">${esc(cancel)}</button>
      <button class="btn small ${danger ? 'danger' : ''}" data-v="1">${esc(ok)}</button></div>`;
    document.body.appendChild(d);
    let v = false;
    d.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => { v = b.dataset.v === '1'; d.close(); }));
    d.addEventListener('close', () => { res(v); d.remove(); });
    d.showModal();
  });
}

export function alertDialog(title, text) {
  return confirmDialog({ title, text, ok: 'OK', cancel: 'Chiudi' });
}

export function promptDialog({ title, text = '', value = '', placeholder = '', ok = 'Salva', type = 'text', inputmode = '' }) {
  return new Promise((res) => {
    const d = document.createElement('dialog');
    d.className = 'alert';
    d.innerHTML = `<h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}
      <form method="dialog" style="margin-top:14px"><input class="input" type="${type}" ${inputmode ? `inputmode="${inputmode}"` : ''} value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">
      <div class="actions"><button type="button" class="btn ghost small" data-cancel>Annulla</button><button class="btn small">${esc(ok)}</button></div></form>`;
    document.body.appendChild(d);
    const inp = d.querySelector('input');
    let v = null;
    d.querySelector('form').onsubmit = (e) => { e.preventDefault(); v = inp.value; d.close(); };
    d.querySelector('[data-cancel]').onclick = () => d.close();
    d.addEventListener('close', () => { res(v); d.remove(); });
    d.showModal();
    setTimeout(() => inp.focus(), 50);
  });
}

/* ---------- Selettore di categoria ---------- */
// Ritorna: { categoryId } | { transfer: true } | { exclude: true } | null
export function pickCategory({ type, title, allowTransfer = false, allowExclude = false, current = null }) {
  return new Promise((resolve) => {
    let result = null;
    const wrap = document.createElement('div');
    const render = (q = '') => {
      const cats = catsOfType(type).filter((c) => !q || norm(c.name).includes(norm(q)));
      wrap.querySelector('.pick-grid').innerHTML = cats.map((c) => `
        <button class="cat ${c.id === current ? 'on' : ''}" data-id="${c.id}"><span class="em">${esc(c.icon || '📦')}</span><span class="nm">${esc(c.name)}</span></button>`).join('')
        + `<button class="cat more" data-new><span class="em">＋</span><span class="nm">Nuova voce</span></button>`;
    };
    wrap.innerHTML = `
      ${catsOfType(type).length > 12 ? `<div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg><input class="input" placeholder="Cerca voce" autocomplete="off"></div>` : ''}
      <div class="pick-grid"></div>
      ${allowTransfer || allowExclude ? `<div class="row" style="margin-top:14px">
        ${allowTransfer ? `<button class="btn line small grow" data-transfer>↔ È un giroconto</button>` : ''}
        ${allowExclude ? `<button class="btn line small grow" data-exclude>Non importare</button>` : ''}</div>` : ''}`;
    render();
    const sh = sheet({ title: title || (type === 'income' ? 'Voce di entrata' : 'Voce di spesa'), body: wrap, onClose: () => resolve(result) });
    wrap.querySelector('.search input')?.addEventListener('input', (e) => render(e.target.value));
    wrap.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.id) { result = { categoryId: b.dataset.id }; sh.close(); }
      else if ('new' in b.dataset) {
        const c = await editCategory({ type });
        if (c) { result = { categoryId: c.id }; sh.close(); }
      } else if ('transfer' in b.dataset) { result = { transfer: true }; sh.close(); }
      else if ('exclude' in b.dataset) { result = { exclude: true }; sh.close(); }
    });
  });
}

/* ---------- Editor categoria ---------- */
const EMOJIS = ['🛒', '🍔', '☕', '🍕', '🏠', '💡', '🔥', '💧', '⛽', '🚗', '🚌', '🅿️', '🛡️', '💊', '🧠', '🦷', '❤️', '🏋️', '🎾', '🎭',
  '🎬', '🎮', '📚', '🎓', '✈️', '🗾', '🏖️', '🎁', '👕', '💇', '🐱', '🐾', '📱', '💻', '📄', '🏛️', '🏦', '💼', '📈', '↩️',
  '👪', '🍷', '🧾', '🔧', '🌿', '💳', '🎉', '📦'];

export function editCategory({ type, cat = null }) {
  return new Promise((resolve) => {
    let saved = null;
    let icon = cat?.icon || '📦';
    const f = document.createElement('form');
    f.className = 'stack';
    f.innerHTML = `
      <label class="field"><span>Nome</span><input class="input" name="catname" required maxlength="40" value="${esc(cat?.name || '')}" placeholder="Es. Palestra" autocomplete="off"></label>
      <div class="field"><span>Icona</span>
        <div class="row" style="margin-bottom:8px"><input class="input" name="icon" value="${esc(icon)}" maxlength="8" style="width:72px;text-align:center;font-size:22px">
        <span class="small muted">Scegli qui sotto o scrivi un'emoji</span></div>
        <div class="emoji-grid">${EMOJIS.map((e) => `<button type="button" data-e="${e}" class="${e === icon ? 'on' : ''}">${e}</button>`).join('')}</div></div>
      ${cat ? '' : `<div class="field"><span>Tipo</span><div class="seg t-${type}"><button type="button" data-t="expense" class="${type === 'expense' ? 'on' : ''}">Uscita</button><button type="button" data-t="income" class="${type === 'income' ? 'on' : ''}">Entrata</button></div></div>`}
      <button class="btn block">${cat ? 'Salva' : 'Crea voce'}</button>`;
    const sh = sheet({ title: cat ? 'Modifica voce' : 'Nuova voce', body: f, onClose: () => resolve(saved) });
    const nameEl = f.querySelector('[name=catname]');
    const iconEl = f.querySelector('[name=icon]');
    f.querySelector('.emoji-grid').onclick = (e) => {
      const b = e.target.closest('[data-e]');
      if (!b) return;
      icon = b.dataset.e;
      iconEl.value = icon;
      f.querySelectorAll('.emoji-grid .on').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    };
    f.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => {
      type = b.dataset.t;
      f.querySelectorAll('[data-t]').forEach((x) => x.classList.toggle('on', x === b));
      f.querySelector('.seg').className = `seg t-${type}`;
    }));
    f.onsubmit = async (e) => {
      e.preventDefault();
      const name = nameEl.value.trim();
      if (!name) return;
      const dup = S.categories.find((c) => c.type === (cat?.type || type) && norm(c.name) === norm(name) && c.id !== cat?.id && !c.archived);
      if (dup) { toast(`Esiste già la voce "${dup.name}"`); return; }
      const obj = cat ? { ...cat, name, icon: iconEl.value.trim() || '📦' }
        : { id: uid('c'), type, name, icon: iconEl.value.trim() || '📦', color: '#898781', order: S.categories.length, archived: false };
      saved = await put('categories', obj);
      sh.close();
    };
    setTimeout(() => { if (!cat) nameEl.focus(); }, 80);
  });
}

/* ---------- Selettore conto ---------- */
export function accountOptions(selected, { exclude = null } = {}) {
  return S.accounts.filter((a) => !a.archived && a.id !== exclude)
    .map((a) => `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
}

export const ICONS = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M5 19h4L19 9l-4-4L5 15v4z"/></svg>',
  repeat: '<svg viewBox="0 0 24 24"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 014-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 01-4 4H4"/></svg>',
  wallet: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M16 12.5h2M3 9h18"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>',
};
