// «Fotos compartidas»: carpeta fija de Google Drive a la que cualquiera puede subir sin iniciar sesión.
// Las fotos pasan por un Apps Script (apps-script/fotos-compartidas.gs) que corre con la cuenta dueña.
import { SHARED_SCRIPT_URL } from './config.js';

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

export async function uploadShared(blob, name) {
  if (!navigator.onLine) throw new Error('Sin conexión');
  // text/plain evita la consulta previa de CORS; el script responde con JSON.
  const res = await fetch(SHARED_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ name, mimeType: blob.type || 'image/jpeg', data: await toBase64(blob) }),
  });
  if (!res.ok) throw new Error(`Drive ${res.status}`);
  let r;
  try { r = await res.json(); } catch { throw new Error('Respuesta inválida de Fotos compartidas'); }
  if (!r.ok) throw new Error(r.error || 'No se pudo subir');
  return r.id;
}
