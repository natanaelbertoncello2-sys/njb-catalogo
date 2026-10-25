// Destinos de guardado con una interfaz común:
//  - carpeta: una carpeta del dispositivo (PC y Android con Chrome/Edge). Si es la carpeta de
//    Google Drive para escritorio, las fotos se sincronizan solas.
//  - drive:   Google Drive directo (opcional, requiere Client ID propio).
// El modo «Guardar en Archivos» (iPhone) no es un destino persistente: se resuelve con Compartir en app.js.
import { kv } from './db.js';
import { drive, AuthError, uniqueName } from './drive.js';

export class NeedsGesture extends Error {}

const IMG = /\.(jpe?g|png|webp|heic|heif)$/i;
export const folderSupported = typeof window.showDirectoryPicker === 'function';

/* ------------------------------------------------------------------ */
/* Carpeta del dispositivo                                             */
/* ------------------------------------------------------------------ */

export const folderTarget = {
  kind: 'folder',
  root: null, // FileSystemDirectoryHandle

  async load() {
    if (!folderSupported) return null;
    try { this.root = (await kv.get('dirHandle')) || null; } catch { this.root = null; }
    return this.root;
  },

  label() { return this.root?.name || null; },
  configured() { return !!this.root; },

  async pick() {
    const h = await window.showDirectoryPicker({ id: 'njb-catalogo', mode: 'readwrite', startIn: 'pictures' });
    this.root = h;
    await kv.set('dirHandle', h);
    return h;
  },

  async forget() { this.root = null; await kv.delete('dirHandle'); },

  // Chrome pide confirmar el permiso en cada sesión; requestPermission necesita un toque del usuario.
  async hasPermission() {
    return !!this.root && (await this.root.queryPermission({ mode: 'readwrite' })) === 'granted';
  },
  async prepare({ interactive = false } = {}) {
    if (!this.root) throw new Error('Elegí una carpeta primero');
    if (await this.hasPermission()) return;
    if (!interactive) throw new NeedsGesture('Falta permiso para escribir en la carpeta');
    const r = await this.root.requestPermission({ mode: 'readwrite' });
    if (r !== 'granted') throw new Error('Sin permiso para escribir en la carpeta');
  },

  async dir(path, create = false) {
    let d = this.root;
    for (const part of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create });
    return d;
  },
  split(id) { const i = id.lastIndexOf('/'); return [id.slice(0, i), id.slice(i + 1)]; },

  async namesIn(d) {
    const s = new Set();
    for await (const name of d.keys()) s.add(name.toLowerCase());
    return s;
  },
  names() { return this.namesIn(this.root); },

  async writeFile(d, name, blob) {
    const fh = await d.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  },

  async create(blob, name) { await this.writeFile(this.root, name, blob); return '/' + name; },
  async replace(blob, id) { const [p, n] = this.split(id); await this.writeFile(await this.dir(p), n, blob); return id; },

  async saveOriginal(blob, base, sep) {
    const d = await this.dir('originales', true);
    const name = uniqueName(base, await this.namesIn(d), sep);
    await this.writeFile(d, name, blob);
    return 'originales/' + name;
  },

  async trash(id) { const [p, n] = this.split(id); await (await this.dir(p)).removeEntry(n); },

  // Catálogo
  rootNode() { return { id: '', name: this.root?.name || 'Carpeta' }; },
  async list(node) {
    const d = await this.dir(node.id);
    const folders = [], files = [];
    for await (const [name, h] of d.entries()) {
      if (h.kind === 'directory') folders.push({ id: node.id + '/' + name, name });
      else if (IMG.test(name)) {
        const file = await h.getFile();
        files.push({ id: node.id + '/' + name, name, key: name + file.lastModified, modified: file.lastModified, blob: async () => file, thumb: async () => file });
      }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => b.modified - a.modified);
    return { folders, files };
  },
  async allNames() {
    const out = [];
    for await (const name of this.root.keys()) if (IMG.test(name)) out.push(name);
    return out;
  },
};

/* ------------------------------------------------------------------ */
/* Google Drive directo                                                */
/* ------------------------------------------------------------------ */

export function makeDriveTarget(settings) {
  return {
    kind: 'drive',
    label() { return settings.folder?.name || null; },
    configured() { return !!settings.clientId && !!settings.folder; },
    async prepare() {
      if (!settings.folder) throw new Error('Elegí la carpeta de Drive');
      if (!drive.token()) throw new AuthError('Sesión de Drive vencida');
    },
    names() { return drive.namesIn(settings.folder.id); },
    async create(blob, name) { return (await drive.upload(blob, { name, parentId: settings.folder.id })).id; },
    async replace(blob, id, name) { return (await drive.upload(blob, { name, fileId: id })).id; },
    async saveOriginal(blob, base, sep) {
      const f = await drive.findOrCreateFolder('originales', settings.folder.id);
      const name = uniqueName(base, await drive.namesIn(f.id), sep);
      return (await drive.upload(blob, { name, parentId: f.id })).id;
    },
    trash(id) { return drive.trash(id); },
    rootNode() { return { id: settings.folder.id, name: settings.folder.name }; },
    async list(node) {
      const [folders, files] = await Promise.all([drive.listFolders(node.id), drive.listImages(node.id)]);
      return {
        folders,
        files: files.map((f) => ({ id: f.id, name: f.name, key: f.id + f.modifiedTime, blob: () => drive.download(f.id), thumb: () => drive.thumbnail(f) })),
      };
    },
    async allNames() { return (await drive.listImages(settings.folder.id)).map((f) => f.name); },
  };
}
