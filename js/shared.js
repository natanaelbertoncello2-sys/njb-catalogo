// «Fotos compartidas»: carpeta fija de Google Drive a la que cualquiera puede subir sin iniciar sesión.
// Las fotos pasan por un Apps Script (apps-script/fotos-compartidas.gs) que corre con la cuenta dueña.
import { SHARED_SCRIPT_URL } from './config.js';

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// ¿El Apps Script publicado ya sabe guardar facturas ('facturas') o pagos ('pagos')? Uno viejo las
// mandaría a «Fotos compartidas».
export async function sharedSupports(flag) {
  if (!navigator.onLine) return true; // sin conexión quedan en cola; se comprueba al volver a enviar
  try {
    const r = await (await fetch(SHARED_SCRIPT_URL)).json();
    return r[flag] === true;
  } catch { return true; }
}
export const sharedSupportsInvoices = () => sharedSupports('facturas');

// destino: undefined = «Fotos compartidas»; 'FACTURAS_PROVEEDORES' = carpeta de facturas del sistema RED;
// 'FOTOS_PAGOS' = fotos de pagos de clientes para caja (CAJA_CUENTAS/FOTOS_PAGOS/POR_VINCULAR).
export async function uploadShared(blob, name, destino) {
  if (!navigator.onLine) throw new Error('Sin conexión');
  // text/plain evita la consulta previa de CORS; el script responde con JSON.
  const res = await fetch(SHARED_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ name, destino, mimeType: blob.type || 'image/jpeg', data: await toBase64(blob) }),
  });
  if (!res.ok) throw new Error(`Drive ${res.status}`);
  let r;
  try { r = await res.json(); } catch { throw new Error('Respuesta inválida de Fotos compartidas'); }
  if (!r.ok) throw new Error(r.error || 'No se pudo subir');
  return r.id;
}
