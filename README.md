# NJB Cámara (web / iPhone / Android / PC)

App web (PWA) para sacar fotos de producto, dejarlas listas para catálogo y guardarlas con el nombre del producto en la carpeta que cada usuario elija. Cualquiera la puede usar: no necesita cuenta ni configuración.

**Publicada en:** https://natanaelbertoncello2-sys.github.io/njb-catalogo/

## Dónde se guardan las fotos

| Dispositivo | Cómo |
|---|---|
| PC (Chrome / Edge) | Elegís una carpeta una vez y se guarda ahí directo. Si elegís la carpeta de **Google Drive para escritorio**, se sincroniza sola. |
| Android (Chrome) | Elegís una carpeta del teléfono una vez y se guarda ahí directo. |
| iPhone (Safari) | Apple no permite que una web escriba en carpetas. Al guardar se abre «Guardar en Archivos» y elegís la carpeta (puede ser de Drive); iOS recuerda la última usada. |
| Cualquiera | **Fotos compartidas**: se suben solas a una carpeta fija de Google Drive, sin iniciar sesión. Puede ser el destino principal o una copia adicional («Subir también una copia…»). |
| Avanzado | Google Drive directo por API (requiere Client ID propio de Google Cloud; ver más abajo). |

Se cambia en **Ajustes → Guardar en**.

Es HTML/CSS/JS puro: no requiere compilación. Cualquier hosting estático con HTTPS sirve.

## Qué hace

- **Cámara en vivo** (trasera, máxima resolución) con grilla, guía 1:1, nivel, «fantasma» (superpone la foto anterior para mantener el mismo encuadre en todo el catálogo), temporizador de 3 s, ráfaga, linterna y zoom (si el iPhone lo permite).
- **Cámara del iPhone (HQ)**: abre la cámara nativa de iOS para máxima calidad (HDR, etc.). También se pueden **importar** fotos del carrete.
- **Edición no destructiva**: todo se recalcula desde la foto original, así que siempre se puede volver atrás.
  - **Fondo liso**: borra fondos claros u oscuros uniformes, incluidas sombras suaves y degradés. Con la **varita** se tocan los huecos interiores (por ejemplo, el asa de una taza).
  - **IA**: borra cualquier fondo (descarga ~55 MB la primera vez y después queda guardado en el dispositivo).
  - Color de fondo, sombra suave bajo el producto, **centrado automático** con margen uniforme, proporciones 1:1 / 4:5 / 3:4 / 4:3.
  - Rotar, espejo, enderezar, recorte manual.
  - Auto mejorar (niveles + balance de blancos), exposición, contraste, saturación, temperatura y nitidez.
  - **Aplicar a todas** y **Usar por defecto** (cada foto nueva sale con ese estilo).
- **Nombres automáticos**: `PRODUCTO.jpg`, `PRODUCTO_1.jpg`, `PRODUCTO_2.jpg`… sin pisar archivos existentes. Botón **Deshacer**. Opción de guardar también el original en la subcarpeta `originales`.
- **Catálogo**: explora la carpeta destino con miniaturas y buscador. Cada foto se puede re-editar (reemplaza el archivo), usar como base, usar como guía fantasma o eliminar.
- **Panorámica**: con el botón «Panorámica» las fotos no van a la bandeja sino a una tira; se saca una serie moviendo el celular de a poco (cada foto superpone un 30-50 % con la anterior) y **Unir** las alinea y funde en una sola imagen de alta resolución (hasta 16 MP) para tener más detalle. Corre en segundo plano con OpenCV.js (~10 MB que se descargan la primera vez); se puede seguir sacando fotos mientras une.
- **Rápida**: el obturador solo congela el cuadro y queda libre al instante; el JPG se genera en segundo plano. Al guardar en Drive / Fotos compartidas, se suben varias a la vez mientras se preparan las siguientes.
- **No se pierde nada**: las fotos sin guardar quedan en el dispositivo (IndexedDB) aunque se cierre el navegador, y quedan en cola si algo falla. Las copias a Fotos compartidas también: si no hay conexión se reintentan solas.

## 1. Publicarla (HTTPS obligatorio para la cámara)

Opción simple — **GitHub Pages**:

1. Crear un repositorio (puede ser privado con GitHub Pro, o público) y subir el contenido de esta carpeta `catalogo_web/`.
2. Settings → Pages → Deploy from branch → `main` / root.
3. La URL queda tipo `https://TU_USUARIO.github.io/njb-catalogo/`.

Alternativa sin cuenta de Git: **Netlify Drop** (https://app.netlify.com/drop) — arrastrás la carpeta `catalogo_web` y listo.

## «Fotos compartidas» (Apps Script)

El código está en `apps-script/fotos-compartidas.gs`, con la carpeta de destino fija (`FOLDER_ID`). Se publica una vez desde https://script.google.com con la cuenta dueña de la carpeta (Implementar → Aplicación web → Ejecutar como: Yo, Acceso: Cualquier usuario) y la URL `/exec` va en `js/config.js` (`SHARED_SCRIPT_URL`). Si se cambia el script: Gestionar implementaciones → Editar → Nueva versión (la URL no cambia).

Ojo: cualquiera que tenga esa URL puede subir archivos a esa carpeta (solo a esa).

## 2. (Opcional, avanzado) Google Drive directo por API

No hace falta para usar la app. Solo sirve si querés subir directo a Drive desde el iPhone sin pasar por «Guardar en Archivos». En modo prueba, Google solo deja usarlo a las cuentas agregadas como «usuarios de prueba».

1. Entrá a https://console.cloud.google.com/ y creá un proyecto (por ejemplo «NJB Cámara»).
2. **APIs y servicios → Biblioteca** → buscar **Google Drive API** → Habilitar.
3. **APIs y servicios → Pantalla de consentimiento de OAuth**:
   - Tipo de usuario: **Externo**. Nombre de la app: NJB Cámara. Tu correo como soporte y contacto.
   - En **Usuarios de prueba** agregá tu cuenta de Gmail (y la de quien más vaya a usarla).
   - Dejala en modo **Prueba** (no hace falta publicarla ni verificarla para uso propio).
4. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**:
   - Tipo: **Aplicación web**.
   - **Orígenes de JavaScript autorizados**: la URL base, por ejemplo `https://TU_USUARIO.github.io`
   - **URI de redireccionamiento autorizados**: la URL exacta de la app, por ejemplo `https://TU_USUARIO.github.io/njb-catalogo/` (con la barra final).
5. Copiá el **ID de cliente** (`xxxx.apps.googleusercontent.com`) y:
   - pegalo en `js/config.js` (`GOOGLE_CLIENT_ID`) para que quede en todos los dispositivos, **o**
   - pegalo en la app: logo NJB (arriba a la izquierda) → Ajustes → Client ID.
6. En la app: **Conectar Drive** → elegí tu cuenta → Google avisa «app no verificada» → *Avanzado* → *Ir a NJB Cámara* → Permitir.
7. Tocá el chip de carpeta (arriba) y elegí la carpeta del catálogo.

La sesión de Google dura 1 hora; después la app redirige sola para renovarla (sin volver a pedir permisos) y continúa con las subidas pendientes.

## 3. Instalarla en el iPhone

Abrí la URL en **Safari** → botón Compartir → **Agregar a pantalla de inicio**. Queda con ícono propio y a pantalla completa.

## Flujo recomendado para catálogo

1. Fondo liso (cartulina blanca o gris), buena luz pareja.
2. Primera foto → editor → Fondo liso, 1:1, centrado, margen → **Usar por defecto**.
3. Escribí el nombre del producto → sacá las fotos → cambiá el nombre → siguiente producto…
4. **Guardar**: todo sube a Drive ya procesado y numerado.

## Actualizar la app

Subí el número `APP_VERSION` en `js/config.js` y publicá (git push). Las apps ya instaladas lo detectan al abrirse o al volver a ellas, se recargan solas cuando no hay nada en curso y muestran «App actualizada a la versión X». `sw.js` no hace falta tocarlo.

## Privacidad

Las fotos se procesan en el teléfono (también las panorámicas). Solo salen hacia tu Google Drive o, si se activa, hacia «Fotos compartidas» a través del Apps Script. Si usás el modo IA o panorámicas, la app descarga el motor desde un CDN (IMG.LY / jsDelivr); las fotos no se envían a esos servidores. La librería de IA (`@imgly/background-removal`) tiene licencia AGPL: uso personal/interno sin problema.
