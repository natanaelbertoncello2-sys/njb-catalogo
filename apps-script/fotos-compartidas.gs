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

    var folder = DriveApp.getFolderById(FOLDER_ID);
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
  return _json({ ok: true, message: 'NJBCAM Drive activo' });
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
