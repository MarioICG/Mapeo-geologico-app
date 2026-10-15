# GeoCampo web 0.1 — app instalable (PWA)

Versión web de GeoCampo para probar rápido en el teléfono. Funciona sin conexión una vez instalada, usa el GPS y guarda tus mapas y datos en el propio teléfono.

## Qué incluye
- Capas **MBTiles raster** (png/jpg/webp) de cualquier tamaño, leídas por trozos: un archivo de varios GB no se carga entero en memoria.
- **Transparencia por capa**, orden (▲▼), mostrar/ocultar, zoom a la capa, renombrar, eliminar.
- **Cuadrícula UTM** dibujada en el teléfono (sin conexión) + OpenStreetMap y OpenTopoMap en línea opcionales.
- GPS con círculo de precisión, botón para seguir tu posición, coordenadas de la cruz en lat/lon y UTM.
- **Ingreso manual de datos**: rumbo/manteo (N30E/45SE, 030/45 con regla de la mano derecha), dirección de manteo (120/45), líneas trend/plunge (S30W/30). Vista previa con símbolo orientado y las tres notaciones.
- Ubicación del dato por GPS, centro del mapa / pulsación larga, o coordenadas UTM o lat/lon escritas.
- "Guardar y otro" para muchas mediciones en la misma estación. Lista con búsqueda, edición y borrado.
- Exportar a **CSV** y **GeoJSON** (compartir o descargar).

## Publicarla gratis (elige una opción, 5 minutos)

La app tiene que estar en una dirección **https** para que el teléfono permita el GPS y la instalación.

### Opción A — Netlify Drop (sin instalar nada)
1. Entra a **app.netlify.com/drop** desde el PC.
2. Arrastra la carpeta **`sitio`** (la que contiene `index.html`) a la página.
3. Netlify te da una dirección tipo `https://nombre-al-azar.netlify.app`. Crea una cuenta gratuita y "reclama" el sitio para conservarlo.

### Opción B — GitHub Pages (queda permanente)
1. Crea una cuenta en github.com y un repositorio nuevo, público, por ejemplo `geocampo`.
2. "Add file → Upload files": sube **el contenido** de la carpeta `sitio` (index.html, sw.js, manifest.webmanifest y la carpeta icons).
3. Settings → Pages → Source: "Deploy from a branch", rama `main`, carpeta `/ (root)` → Save.
4. En un par de minutos queda en `https://TU-USUARIO.github.io/geocampo/`.

## Instalarla en el teléfono
- **Android (Chrome):** abre la dirección → menú ⋮ → **Instalar app** (o "Agregar a pantalla de inicio"). También aparece un botón en Ajustes.
- **iPhone (Safari):** abre la dirección → botón Compartir → **Agregar a pantalla de inicio**.
- La primera vez acepta el permiso de ubicación.

## Cargar tus mapas
Para probar sin tener un mapa a mano: `mapa_de_prueba.mbtiles` es una carta sintética cerca de Antofagasta (zoom 9–14).

Capas → **+ MBTiles** → elige el archivo. Se guarda dentro del navegador del teléfono y queda disponible sin conexión. En el PC también puedes arrastrar el archivo sobre el mapa.

## Importante
- Datos y mapas viven **solo en ese navegador de ese teléfono**. Si borras los datos del navegador o desinstalas la app, se pierden: exporta seguido.
- MBTiles vectoriales (pbf) aún no se admiten.
- La altitud es la del GPS del teléfono (elipsoidal).
- OpenStreetMap y OpenTopoMap en línea son para uso personal ligero.

## Contenido del paquete
- `sitio/` → lo que se publica (Netlify o GitHub Pages).
- `mapa_de_prueba.mbtiles` → mapa sintético para probar capas y transparencia.
- `codigo_fuente/` → código y pruebas (`python3 build.py` regenera `dist/`).
