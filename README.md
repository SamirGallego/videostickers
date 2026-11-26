# VideoStickers

Crea stickers animados con sonido para WhatsApp a partir de un video:
eliges el fragmento y genera el **WebP animado (512×512, ≤500 KB)** y su **audio (MP3/WAV)** con exactamente el mismo inicio y duración.

Todo se procesa en el navegador (no hay servidor), por eso funciona en GitHub Pages.

## Publicar en GitHub Pages
1. Sube `index.html`, `app.js` y este README a un repositorio.
2. En GitHub: **Settings → Pages → Build and deployment → Deploy from a branch**, rama `main`, carpeta `/ (root)`.
3. Abre `https://<tu-usuario>.github.io/<repo>/`.

## Uso
- Controles: ▶/⏸, ±1 s, ±1 cuadro, bucle del fragmento, zoom.
- Forma de onda: clic para mover el cursor; arrastra la zona verde o sus bordes para ajustar el fragmento.
- Atajos: `Espacio` play · `←/→` cuadro · `Shift+←/→` 1 s · `I` inicio · `O` fin · `L` bucle · `Z` zoom.

## Compatibilidad
Chrome, Edge, Firefox y Chrome de Android. Safari no puede crear WebP.
Videos HEVC (H.265, iPhone) solo se abren si el navegador los reproduce; si no, conviértelos a MP4 H.264.
