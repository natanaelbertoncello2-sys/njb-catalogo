/**
 * NJBCAM - Receptor de fotos para Google Drive
 *
 * INSTALACIÓN:
 * 1. Entrá a https://script.google.com con la cuenta dueña de la carpeta y creá un proyecto nuevo.
 * 2. Pegá todo este código en Code.gs y guardá.
 * 3. Implementar > Nueva implementación > Tipo: "Aplicación web".
 *      - Ejecutar como: "Yo"
 *      - Quién tiene acceso: "Cualquier usuario"
 * 4. Autorizá los permisos que pide Google.
 * 5. Copiá la URL que termina en /exec y pegala en js/config.js (SHARED_SCRIPT_URL).
 *
 * Si modificás el código, hacé Implementar > Gestionar implementaciones > Editar > Nueva versión
 * para que la URL /exec use el código nuevo.
 */

// Carpeta fija de destino: se ignora cualquier carpeta que mande la app
var FOLDER_ID = '1uvd0F7ORNyGLzkYNPR-mCKy0_T199-7f';

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (!body.name || !body.data) {
      return _json({ ok: false, error: 'Faltan datos (name, data)' });
    }

    // Facturas de proveedores: van a la carpeta del sistema RED (Mi unidad/SISTEMA NUEVO/SISTEMAREDV2/
    // FACTURAS_PROVEEDORES/POR_CARGAR), que cada PC tiene sincronizada con Drive para escritorio.
    var folder = body.destino === 'FACTURAS_PROVEEDORES'
      ? _carpeta(['SISTEMA NUEVO', 'SISTEMAREDV2', 'FACTURAS_PROVEEDORES', 'POR_CARGAR'])
      : DriveApp.getFolderById(FOLDER_ID);
    var bytes = Utilities.base64Decode(body.data);
    var blob = Utilities.newBlob(bytes, body.mimeType || 'image/jpeg', body.name);
    var file = folder.createFile(blob);

    return _json({ ok: true, id: file.getId(), url: file.getUrl() });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

// Permite probar la URL desde el navegador
function doGet() {
  return _json({ ok: true, message: 'NJBCAM Drive activo', facturas: true });
}

// Busca (o crea) la carpeta siguiendo los nombres desde «Mi unidad».
// La cámara sube varias hojas a la vez: sin el candado cada una creaba su propia carpeta
// (Drive permite dos con el mismo nombre). Se recuerda el ID para no volver a buscarla.
function _carpeta(nombres) {
  var props = PropertiesService.getScriptProperties();
  var clave = 'carpeta:' + nombres.join('/');
  var guardada = _porId(props.getProperty(clave));
  if (guardada) return guardada;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    guardada = _porId(props.getProperty(clave)); // otra subida la pudo crear mientras esperaba
    if (guardada) return guardada;
    var f = DriveApp.getRootFolder();
    for (var i = 0; i < nombres.length; i++) {
      var it = f.getFoldersByName(nombres[i]);
      f = it.hasNext() ? it.next() : f.createFolder(nombres[i]);
    }
    props.setProperty(clave, f.getId());
    return f;
  } finally {
    lock.releaseLock();
  }
}

function _porId(id) {
  if (!id) return null;
  try {
    var f = DriveApp.getFolderById(id);
    return f.isTrashed() ? null : f;
  } catch (e) {
    return null;
  }
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
