// Google Drive vía REST + OAuth (flujo por redirección: funciona en Safari y como app en la pantalla de inicio,
// sin ventanas emergentes bloqueadas). El token dura ~1 h; las subidas pendientes quedan en cola y se reanudan.
const TOKEN_KEY = 'njb-drive-token';
const STATE_KEY = 'njb-oauth-state';
const SCOPE = 'https://www.googleapis.com/auth/drive';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const COMMON = 'supportsAllDrives=true';

export class AuthError extends Error {}

// Siempre la carpeta de la app (sin «index.html»), igual a la URI registrada en Google Cloud.
const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

export const drive = {
  // Lee el token que vuelve de Google en el #hash. Devuelve true si se acaba de conectar.
  handleRedirect() {
    if (!location.hash.includes('access_token=') && !location.hash.includes('error=')) return false;
    const p = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    if (p.get('error')) throw new Error('Google rechazó la conexión: ' + p.get('error'));
    const expected = sessionStorage.getItem(STATE_KEY) || localStorage.getItem(STATE_KEY);
    if (!expected || p.get('state') !== expected) throw new Error('Respuesta de Google no válida (state)');
    localStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(STATE_KEY);
    const token = { access: p.get('access_token'), exp: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000 - 60_000 };
    localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
    return true;
  },

  token() {
    try {
      const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
      return t && t.exp > Date.now() ? t.access : null;
    } catch { return null; }
  },

  wasConnected() { return !!localStorage.getItem(TOKEN_KEY); },

  connect(clientId) {
    if (!clientId) throw new Error('Falta el Client ID de Google (Ajustes)');
    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem(STATE_KEY, state);
    localStorage.setItem(STATE_KEY, state);
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: SCOPE,
      include_granted_scopes: 'true',
      state,
    });
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + q);
  },

  disconnect() {
    const t = this.token();
    localStorage.removeItem(TOKEN_KEY);
    if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + t, { method: 'POST' }).catch(() => {});
  },

  async req(url, opts = {}) {
    const t = this.token();
    if (!t) throw new AuthError('Sesión de Drive vencida');
    const res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + t, ...(opts.headers || {}) } });
    if (res.status === 401) { localStorage.removeItem(TOKEN_KEY); throw new AuthError('Sesión de Drive vencida'); }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).error?.message || msg; } catch { /* sin cuerpo */ }
      throw new Error(`Drive ${res.status}: ${msg}`);
    }
    return res;
  },

  async json(url, opts) { return (await this.req(url, opts)).json(); },

  async user() {
    const r = await this.json(`${API}/about?fields=user(displayName,emailAddress)`);
    return r.user;
  },

  async listAll(q, fields, orderBy = 'name') {
    const out = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q, fields: `nextPageToken,files(${fields})`, orderBy, pageSize: '1000',
        supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const r = await this.json(`${API}/files?${params}`);
      out.push(...r.files);
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return out;
  },

  listFolders(parentId = 'root') {
    return this.listAll(`'${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`, 'id,name');
  },

  listImages(folderId) {
    return this.listAll(
      `'${folderId}' in parents and mimeType contains 'image/' and trashed=false`,
      'id,name,thumbnailLink,modifiedTime,size', 'modifiedTime desc');
  },

  async namesIn(folderId) {
    const files = await this.listAll(`'${folderId}' in parents and trashed=false`, 'name');
    return new Set(files.map((f) => f.name.toLowerCase()));
  },

  async createFolder(name, parentId) {
    return this.json(`${API}/files?${COMMON}&fields=id,name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
  },

  async findOrCreateFolder(name, parentId) {
    const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const found = await this.listAll(`'${parentId}' in parents and name='${esc}' and mimeType='${FOLDER_MIME}' and trashed=false`, 'id,name');
    return found[0] || this.createFolder(name, parentId);
  },

  // Sube un archivo nuevo (o reemplaza el contenido si se pasa fileId).
  async upload(blob, { name, parentId, fileId, mimeType = 'image/jpeg' }) {
    const meta = fileId ? { name } : { name, parents: [parentId], mimeType };
    const base = fileId ? `${UPLOAD}/files/${fileId}` : `${UPLOAD}/files`;
    const method = fileId ? 'PATCH' : 'POST';

    if (blob.size > 4.5 * 1024 * 1024) {
      // Subida reanudable para archivos grandes.
      const init = await this.req(`${base}?uploadType=resumable&${COMMON}&fields=id,name`, {
        method,
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType },
        body: JSON.stringify(meta),
      });
      const loc = init.headers.get('Location');
      if (loc) {
        const put = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: blob });
        if (!put.ok) throw new Error(`Drive ${put.status} al subir ${name}`);
        return put.json();
      }
    }
    const boundary = 'njb' + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`, blob, `\r\n--${boundary}--`,
    ]);
    return this.json(`${base}?uploadType=multipart&${COMMON}&fields=id,name`, {
      method,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  },

  async trash(fileId) {
    return this.json(`${API}/files/${fileId}?${COMMON}&fields=id`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed: true }),
    });
  },

  async download(fileId) {
    return (await this.req(`${API}/files/${fileId}?alt=media&${COMMON}`)).blob();
  },

  async thumbnail(file) {
    if (file.thumbnailLink) {
      try {
        const r = await fetch(file.thumbnailLink.replace(/=s\d+$/, '=s320'), { headers: { Authorization: 'Bearer ' + this.token() } });
        if (r.ok) return await r.blob();
      } catch { /* CORS o enlace vencido: bajamos el archivo completo */ }
    }
    return this.download(file.id);
  },
};

// Nombre libre siguiendo la convención PRODUCTO.jpg, PRODUCTO_1.jpg, PRODUCTO_2.jpg…
export function uniqueName(base, taken, sep = '_', ext = 'jpg') {
  let name = `${base}.${ext}`;
  for (let i = 1; taken.has(name.toLowerCase()); i++) name = `${base}${sep}${i}.${ext}`;
  taken.add(name.toLowerCase());
  return name;
}

// Quita caracteres que Drive/Windows no toleran bien en nombres.
export const cleanName = (s) => (s || '').replace(/[\\/:*?"<>|#%]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
