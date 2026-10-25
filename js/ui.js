export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastTimer = null;
export function toast(text, { type = '', action = null, actionLabel = '', ms = 2600 } = {}) {
  const el = $('#toast');
  const btn = $('#toastAction');
  $('#toastText').textContent = text;
  el.className = 'toast ' + type;
  btn.classList.toggle('hidden', !action);
  btn.textContent = actionLabel;
  btn.onclick = action ? () => { hideToast(); action(); } : null;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? Math.max(ms, 6000) : ms);
}
export function hideToast() { $('#toast').classList.add('hidden'); }

// Diálogo genérico. Devuelve true/false, o el texto ingresado si input !== undefined (null si cancela).
export function dialog({ title, text = '', input, okLabel = 'Aceptar', cancelLabel = 'Cancelar', danger = false, noCancel = false }) {
  const root = $('#dialog');
  const inp = $('#dlgInput');
  const ok = $('#dlgOk');
  const cancel = $('#dlgCancel');
  $('#dlgTitle').textContent = title;
  $('#dlgText').textContent = text;
  $('#dlgText').classList.toggle('hidden', !text);
  inp.classList.toggle('hidden', input === undefined);
  inp.value = input ?? '';
  ok.textContent = okLabel;
  ok.className = 'btn ' + (danger ? 'danger' : 'primary');
  cancel.textContent = cancelLabel;
  cancel.classList.toggle('hidden', noCancel);
  root.classList.remove('hidden');
  if (input !== undefined) setTimeout(() => { inp.focus(); inp.select(); }, 50);

  return new Promise((resolve) => {
    const done = (v) => {
      root.classList.add('hidden');
      ok.onclick = cancel.onclick = inp.onkeydown = null;
      resolve(v);
    };
    ok.onclick = () => done(input !== undefined ? inp.value : true);
    cancel.onclick = () => done(input !== undefined ? null : false);
    inp.onkeydown = (ev) => { if (ev.key === 'Enter') ok.click(); };
  });
}

let openSheet = null;
export function showSheet(id) {
  closeSheet();
  openSheet = $(id);
  openSheet.classList.remove('hidden');
  $('#sheetBackdrop').classList.remove('hidden');
}
export function closeSheet() {
  if (openSheet) openSheet.classList.add('hidden');
  openSheet = null;
  $('#sheetBackdrop').classList.add('hidden');
}

export function showView(id) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === id));
}

// Menú de acciones simple (hoja inferior). Devuelve la clave elegida o null.
export function actionSheet(title, actions) {
  return new Promise((resolve) => {
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.innerHTML = `<div class="sheet-head"><b></b><button class="icon-btn" data-k="">✕</button></div><ul class="folder-list"></ul>`;
    sheet.querySelector('b').textContent = title;
    const ul = sheet.querySelector('ul');
    for (const a of actions) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.textContent = a.label;
      b.dataset.k = a.key;
      if (a.danger) b.style.color = 'var(--danger)';
      li.append(b);
      ul.append(li);
    }
    const backdrop = $('#sheetBackdrop');
    backdrop.classList.remove('hidden');
    document.body.append(sheet);
    const done = (k) => {
      sheet.remove();
      backdrop.classList.add('hidden');
      backdrop.removeEventListener('click', onBackdrop);
      resolve(k || null);
    };
    const onBackdrop = () => done(null);
    backdrop.addEventListener('click', onBackdrop);
    sheet.addEventListener('click', (ev) => { const b = ev.target.closest('[data-k]'); if (b) done(b.dataset.k); });
  });
}

export const debounce =(fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
