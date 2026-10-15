"""Arma GeoCampo web en dos salidas:
   dist/pwa/       → sitio instalable (index.html, manifest, service worker, iconos)
   dist/artifact/  → una sola página para la vista previa en claude.ai
"""
import json
import pathlib
import shutil

from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
DIST = ROOT / "dist"
LEAFLET = ROOT / "vendor" / "package" / "dist"

FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">'
         '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
         '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@600;700'
         '&family=IBM+Plex+Mono:wght@400;600&display=swap">')

THEME = "#14201d"
BG = "#e6ebe9"
ACCENT = (210, 79, 20)


def read(p):
    return (SRC / p).read_text(encoding="utf-8")


def scripts():
    leaflet = (LEAFLET / "leaflet.js").read_text(encoding="utf-8")
    leaflet = leaflet.replace("//# sourceMappingURL=leaflet.js.map", "")
    parts = [leaflet, read("geo.js"), read("mbtiles.js"), read("app.js")]
    return "\n".join(f"<script>\n{p.replace('</script', '<\\/script')}\n</script>" for p in parts)


def styles():
    css = (LEAFLET / "leaflet.css").read_text(encoding="utf-8") + "\n" + read("app.css")
    return f"<style>\n{css}\n</style>"


def icon(size, maskable=False):
    s = 4  # supersampling
    img = Image.new("RGBA", (size * s, size * s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    W = size * s
    if maskable:
        d.rectangle([0, 0, W, W], fill=ACCENT)
        scale = 0.62
    else:
        d.rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=ACCENT)
        scale = 0.78
    c = W / 2
    L = W * 0.36 * scale / 0.78
    lw = int(W * 0.075 * scale / 0.78)
    # Símbolo de estratificación: rumbo N60E con marca hacia el SE.
    import math
    a = math.radians(60)
    dx, dy = math.sin(a) * L, -math.cos(a) * L
    d.line([(c - dx, c - dy), (c + dx, c + dy)], fill="white", width=lw)
    ta = math.radians(150)
    t = L * 0.55
    d.line([(c, c), (c + math.sin(ta) * t, c - math.cos(ta) * t)], fill="white", width=lw)
    r = lw * 0.5
    for (x, y) in [(c - dx, c - dy), (c + dx, c + dy), (c + math.sin(ta) * t, c - math.cos(ta) * t), (c, c)]:
        d.ellipse([x - r, y - r, x + r, y + r], fill="white")
    return img.resize((size, size), Image.LANCZOS)


def build():
    if DIST.exists():
        shutil.rmtree(DIST)
    pwa = DIST / "pwa"
    art = DIST / "artifact"
    (pwa / "icons").mkdir(parents=True)
    art.mkdir(parents=True)

    body = read("body.html")
    css = styles()
    js = scripts()

    # ---- PWA
    head = (
        '<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        f'<meta name="theme-color" content="{THEME}">\n'
        '<meta name="description" content="Mapeo geológico offline: MBTiles con transparencia y datos estructurales.">\n'
        '<link rel="manifest" href="manifest.webmanifest">\n'
        '<link rel="icon" type="image/png" href="icons/icon-192.png">\n'
        '<link rel="apple-touch-icon" href="icons/icon-192.png">\n'
        '<meta name="apple-mobile-web-app-capable" content="yes">\n'
        '<meta name="mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-title" content="GeoCampo">\n'
        '<title>GeoCampo</title>\n'
        f'{FONTS}\n{css}\n</head>\n<body>\n'
    )
    (pwa / "index.html").write_text(head + body + "\n" + js + "\n</body>\n</html>\n", encoding="utf-8")
    shutil.copy(SRC / "sw.js", pwa / "sw.js")
    manifest = {
        "name": "GeoCampo",
        "short_name": "GeoCampo",
        "description": "Mapeo geológico offline: MBTiles con transparencia y datos estructurales",
        "lang": "es",
        "start_url": "./",
        "scope": "./",
        "display": "standalone",
        "orientation": "any",
        "background_color": BG,
        "theme_color": THEME,
        "icons": [
            {"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
            {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
            {"src": "icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    (pwa / "manifest.webmanifest").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    icon(192).save(pwa / "icons" / "icon-192.png")
    icon(512).save(pwa / "icons" / "icon-512.png")
    icon(512, maskable=True).save(pwa / "icons" / "maskable-512.png")
    shutil.copy(ROOT / "LEEME-web.md", pwa / "LEEME.md")

    # ---- Vista previa (artifact): sin <html>/<head>, el visor los agrega.
    page = (
        '<title>GeoCampo</title>\n'
        '<meta name="claude:viewport-fit-sides" content="cover">\n'
        f'{FONTS}\n{css}\n{body}\n{js}\n'
    )
    (art / "geocampo.html").write_text(page, encoding="utf-8")

    for p in sorted(DIST.rglob("*")):
        if p.is_file():
            print(f"{p.relative_to(DIST)}  {p.stat().st_size // 1024} KB")


if __name__ == "__main__":
    build()
