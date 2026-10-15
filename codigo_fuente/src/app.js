/* GeoCampo web — app principal (Leaflet + MBTiles locales + datos estructurales). */
(function () {
  'use strict';

  const G = window.GeoOrient;
  const U = window.Utm;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // Vista previa dentro de claude.ai (iframe con permisos limitados) o app publicada.
  const IN_FRAME = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
  const IN_ARTIFACT = IN_FRAME || (typeof window.claude === 'object' && window.claude !== null);

  // ================================================================ catálogo
  const PLANES = [
    { name: 'Estratificación', color: '#212121', style: 'tick' },
    { name: 'Foliación', color: '#7b1fa2', style: 'triangle' },
    { name: 'Diaclasa', color: '#ef6c00', style: 'bar' },
    { name: 'Falla', color: '#d32f2f', style: 'thick' },
    { name: 'Contacto', color: '#1565c0', style: 'tick' },
    { name: 'Veta / vetilla', color: '#00897b', style: 'tick' },
    { name: 'Dique', color: '#6d4c41', style: 'tick' },
    { name: 'Plano axial', color: '#c2185b', style: 'triangle' },
    { name: 'Otro plano', color: '#546e7a', style: 'tick' },
  ];
  const LINES = [
    { name: 'Lineación', color: '#2e7d32', style: 'arrow' },
    { name: 'Eje de pliegue', color: '#c2185b', style: 'arrow' },
    { name: 'Estría de falla', color: '#d32f2f', style: 'arrow' },
    { name: 'Lineación de intersección', color: '#7b1fa2', style: 'arrow' },
    { name: 'Otra línea', color: '#546e7a', style: 'arrow' },
  ];
  const catalog = (kind) => (kind === 'line' ? LINES : PLANES);
  const typeOf = (name, kind) => catalog(kind).find((t) => t.name === name) || catalog(kind)[catalog(kind).length - 1];

  // ================================================================ símbolos
  function symbolSVG(kind, style, color, az, inc, size = 40) {
    const r = size / 2;
    const w = Math.max(2, r * 0.12) * (style === 'thick' ? 1.6 : 1);
    const halo = `stroke="#fff" stroke-width="${(w + 3).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
    const pen = `stroke="${color}" stroke-width="${w.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
    const solid = `fill="${color}" stroke="#fff" stroke-width="3" stroke-linejoin="round" paint-order="stroke"`;
    const ln = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${halo}/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${pen}/>`;
    const f = (n) => n.toFixed(2);
    let body = '';
    let rot = 0;
    if (kind === 'plane') {
      if (inc <= 0.5) {
        const rr = r * 0.45;
        body = `<circle r="${f(rr)}" ${halo}/><circle r="${f(rr)}" ${pen}/>` + ln(f(-rr), 0, f(rr), 0) + ln(0, f(-rr), 0, f(rr));
      } else {
        rot = az;
        const l = r * 0.9, t = r * 0.45;
        const mark = (dir) => {
          if (style === 'triangle') return `<path d="M${f(-t * 0.5)} 0 L0 ${f(dir * t)} L${f(t * 0.5)} 0Z" ${solid}/>`;
          if (style === 'bar') {
            const y0 = Math.min(0, dir * t), h = Math.abs(dir * t);
            return `<rect x="${f(-w * 1.1)}" y="${f(y0)}" width="${f(w * 2.2)}" height="${f(h)}" ${solid}/>`;
          }
          return ln(0, 0, 0, f(dir * t));
        };
        body = ln(f(-l), 0, f(l), 0) + mark(-1) + (inc >= 89.5 ? mark(1) : '');
      }
    } else if (inc >= 89.5) {
      body = `<circle r="${f(r * 0.35)}" ${halo}/><circle r="${f(r * 0.35)}" ${pen}/><circle r="${f(w)}" fill="${color}"/>`;
    } else {
      rot = az;
      const l = r * 0.95, hw = r * 0.28, hl = r * 0.42;
      body = ln(0, f(r * 0.15), 0, f(-l + hl * 0.5)) + `<path d="M${f(-hw)} ${f(-l + hl)} L0 ${f(-l)} L${f(hw)} ${f(-l + hl)}Z" ${solid}/>`;
    }
    return `<svg viewBox="${-r} ${-r} ${size} ${size}" width="${size}" height="${size}" aria-hidden="true"><g transform="rotate(${rot.toFixed(2)})">${body}</g></svg>`;
  }
  const symbolOf = (m, size) => {
    const t = typeOf(m.structure, m.kind);
    return symbolSVG(m.kind, t.style, t.color, m.azimuth, m.inclination, size);
  };

  // ================================================================ almacenamiento
  const Store = (() => {
    let db = null;
    const mem = new Map();
    const memFiles = new Map();
    function tx(store, mode, fn) {
      return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('abortado'));
      });
    }
    return {
      async open() {
        try {
          db = await new Promise((resolve, reject) => {
            const r = indexedDB.open('geocampo', 1);
            r.onupgradeneeded = () => {
              r.result.createObjectStore('kv');
              r.result.createObjectStore('files');
            };
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
            r.onblocked = () => reject(new Error('bloqueado'));
          });
        } catch (e) {
          db = null;
        }
        return !!db;
      },
      get ok() { return !!db; },
      async get(k) {
        if (!db) return mem.get(k);
        try { return await tx('kv', 'readonly', (s) => s.get(k)); } catch (e) { return mem.get(k); }
      },
      async set(k, v) {
        mem.set(k, v);
        if (!db) return false;
        try { await tx('kv', 'readwrite', (s) => s.put(v, k)); return true; } catch (e) { console.warn(e); return false; }
      },
      async putFile(id, blob) {
        memFiles.set(id, blob);
        if (!db) return false;
        try { await tx('files', 'readwrite', (s) => s.put(blob, id)); return true; } catch (e) { console.warn(e); return false; }
      },
      async getFile(id) {
        if (memFiles.has(id)) return memFiles.get(id);
        if (!db) return null;
        try { return (await tx('files', 'readonly', (s) => s.get(id))) || null; } catch (e) { return null; }
      },
      async delFile(id) {
        memFiles.delete(id);
        if (!db) return;
        try { await tx('files', 'readwrite', (s) => s.delete(id)); } catch (e) { /* nada */ }
      },
    };
  })();

  // ================================================================ estado
  const BUILTIN = [
    { id: 'utm', kind: 'grid', name: 'Cuadrícula UTM', opacity: 0.7, visible: true },
    { id: 'otm', kind: 'online', name: 'OpenTopoMap (en línea)', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', maxNative: 17, attribution: 'Datos © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM · Estilo © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)', opacity: 1, visible: false },
    { id: 'osm', kind: 'online', name: 'OpenStreetMap (en línea)', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxNative: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', opacity: 1, visible: true },
  ];

  const state = {
    layers: [],
    items: [],
    settings: { declination: 0, showLabels: true, view: null, welcomeDismissed: false },
    pos: null,
    gpsError: null,
    follow: false,
  };
  const runtime = new Map(); // id → { reader, leaflet, error }

  const saveLayers = () => Store.set('layers', state.layers.map((l) => ({ ...l })));
  const saveItems = () => Store.set('items', state.items);
  const saveSettings = () => Store.set('settings', state.settings);

  // ================================================================ UI básica
  let toastTimer = 0;
  function toast(msg, ms = 2800) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  function busy(msg) {
    $('#busy').hidden = !msg;
    if (msg) $('#busy-text').textContent = msg;
  }
  function confirmBox(title, text, okLabel = 'Aceptar', danger = false) {
    return new Promise((resolve) => {
      const d = $('#dialog');
      $('#dlg-title').textContent = title;
      $('#dlg-text').textContent = text || '';
      $('#dlg-text').hidden = !text;
      const ok = $('#dlg-ok');
      ok.textContent = okLabel;
      ok.classList.toggle('danger', danger);
      ok.classList.toggle('primary', !danger);
      d.hidden = false;
      ok.focus();
      const done = (v) => {
        d.hidden = true;
        ok.onclick = null;
        $('#dlg-cancel').onclick = null;
        resolve(v);
      };
      ok.onclick = () => done(true);
      $('#dlg-cancel').onclick = () => done(false);
    });
  }

  let openSheetEl = null;
  function openSheet(id, { light = false } = {}) {
    closeSheet();
    const el = $('#' + id);
    el.hidden = false;
    const scrim = $('#scrim');
    scrim.hidden = false;
    scrim.classList.toggle('light', light);
    openSheetEl = el;
  }
  function closeSheet() {
    if (openSheetEl) openSheetEl.hidden = true;
    openSheetEl = null;
    $('#scrim').hidden = true;
  }

  // ================================================================ mapa
  const map = L.map('map', {
    zoomControl: false,
    minZoom: 2,
    maxZoom: 22,
    worldCopyJump: true,
    attributionControl: true,
  });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 140 }).addTo(map);

  // Capa MBTiles leída por trozos.
  const MbLayer = L.GridLayer.extend({
    initialize(reader, options) {
      this._reader = reader;
      L.GridLayer.prototype.initialize.call(this, options);
    },
    createTile(coords, done) {
      const img = document.createElement('img');
      img.alt = '';
      img.setAttribute('role', 'presentation');
      img.decoding = 'async';
      const z = coords.z;
      const y = (1 << z) - 1 - coords.y;
      this._reader.getTile(z, coords.x, y).then((bytes) => {
        if (!bytes || !bytes.length) {
          img.style.visibility = 'hidden';
          done(null, img);
          return;
        }
        const url = URL.createObjectURL(new Blob([bytes], { type: window.sniffMime(bytes) }));
        img.onload = () => { URL.revokeObjectURL(url); done(null, img); };
        img.onerror = () => { URL.revokeObjectURL(url); img.style.visibility = 'hidden'; done(null, img); };
        img.src = url;
      }).catch((err) => {
        img.style.visibility = 'hidden';
        done(err, img);
      });
      return img;
    },
  });

  // Cuadrícula UTM dibujada en el teléfono (funciona sin conexión).
  const UtmGrid = L.GridLayer.extend({
    createTile(coords) {
      const size = this.getTileSize();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const c = document.createElement('canvas');
      c.width = size.x * dpr;
      c.height = size.y * dpr;
      const ctx = c.getContext('2d');
      ctx.scale(dpr, dpr);
      const nwP = coords.scaleBy(size);
      const nw = map.unproject(nwP, coords.z);
      const se = map.unproject(nwP.add(size), coords.z);
      const lat0 = (nw.lat + se.lat) / 2;
      const lon0 = L.Util.wrapNum((nw.lng + se.lng) / 2, [-180, 180], true);
      if (Math.abs(lat0) > 83 || (nw.lat > 0 && se.lat < 0)) return c;
      const zone = U.zoneNumber(lat0, lon0);
      const north = lat0 >= 0;
      const lonShift = lon0 - (nw.lng + se.lng) / 2; // copias del mundo
      const corners = [[nw.lat, nw.lng], [nw.lat, se.lng], [se.lat, nw.lng], [se.lat, se.lng]]
        .map(([la, lo]) => U.fromLatLon(la, lo + lonShift, zone));
      const es = corners.map((u) => u.easting), ns = corners.map((u) => u.northing);
      const minE = Math.min(...es), maxE = Math.max(...es), minN = Math.min(...ns), maxN = Math.max(...ns);
      const mpp = (maxE - minE) / size.x;
      const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000];
      const s = steps.find((v) => v / mpp >= 90) || steps[steps.length - 1];
      const color = getComputedStyle(document.documentElement).getPropertyValue('--grid').trim() || 'rgba(0,0,0,.5)';
      const toPx = (e, n) => {
        const [la, lo] = U.toLatLon(e, n, zone, north);
        const p = map.project([la, lo - lonShift], coords.z);
        return [p.x - nwP.x, p.y - nwP.y];
      };
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.font = '600 10px ui-monospace, Menlo, monospace';
      const lbl = (v) => (s >= 1000 ? String(Math.round(v / 1000)) : String(Math.round(v)));
      const pad = s * 0.5;
      for (let e = Math.ceil((minE - pad) / s) * s; e <= maxE + pad; e += s) {
        ctx.beginPath();
        for (let i = 0; i <= 8; i++) {
          const [x, y] = toPx(e, minN - pad + (maxN - minN + 2 * pad) * (i / 8));
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        const [lx] = toPx(e, maxN);
        if (lx > 2 && lx < size.x - 30) ctx.fillText(lbl(e), lx + 3, 11);
      }
      for (let n = Math.ceil((minN - pad) / s) * s; n <= maxN + pad; n += s) {
        ctx.beginPath();
        for (let i = 0; i <= 8; i++) {
          const [x, y] = toPx(minE - pad + (maxE - minE + 2 * pad) * (i / 8), n);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        const [, ly] = toPx(minE, n);
        if (ly > 14 && ly < size.y - 2) ctx.fillText(lbl(n), 3, ly - 3);
      }
      return c;
    },
  });

  function makeLeaflet(l) {
    if (l.kind === 'online') {
      return L.tileLayer(l.url, { maxNativeZoom: l.maxNative, maxZoom: 22, attribution: l.attribution, subdomains: 'abc' });
    }
    if (l.kind === 'grid') return new UtmGrid({ minZoom: 4, maxZoom: 22, updateWhenZooming: false });
    const rt = runtime.get(l.id);
    if (!rt || !rt.reader) return null;
    const opts = {
      minNativeZoom: l.minNative,
      maxNativeZoom: l.maxNative,
      minZoom: Math.max(0, l.minNative - 3),
      maxZoom: 22,
      keepBuffer: 2,
    };
    if (l.bounds) opts.bounds = L.latLngBounds([l.bounds[1], l.bounds[0]], [l.bounds[3], l.bounds[2]]);
    return new MbLayer(rt.reader, opts);
  }

  function leafletOf(l) {
    let rt = runtime.get(l.id);
    if (!rt) { rt = {}; runtime.set(l.id, rt); }
    if (!rt.leaflet) rt.leaflet = makeLeaflet(l);
    return rt.leaflet;
  }

  function applyLayers() {
    const n = state.layers.length;
    state.layers.forEach((l, i) => {
      const lf = leafletOf(l);
      if (!lf) return;
      lf.setZIndex(n - i);
      if (lf.setOpacity) lf.setOpacity(l.opacity);
      if (l.visible && !map.hasLayer(lf)) lf.addTo(map);
      if (!l.visible && map.hasLayer(lf)) map.removeLayer(lf);
    });
  }

  function fitLayer(l) {
    if (!l.bounds) { toast('Esta capa no indica su extensión'); return; }
    state.follow = false;
    updateGpsButton();
    // Deja visible la capa aunque el panel de capas siga abierto.
    const bottom = (openSheetEl ? openSheetEl.offsetHeight : $('#bottombar').offsetHeight) + 16;
    const top = $('#infobar').offsetHeight + 24;
    map.fitBounds([[l.bounds[1], l.bounds[0]], [l.bounds[3], l.bounds[2]]], {
      paddingTopLeft: [16, top],
      paddingBottomRight: [64, bottom],
    });
  }

  // ---------------------------------------------------------------- símbolos
  const symbolsLayer = L.layerGroup().addTo(map);
  function renderSymbols() {
    symbolsLayer.clearLayers();
    for (const m of state.items) {
      const t = typeOf(m.structure, m.kind);
      const label = state.settings.showLabels ? `<span class="lbl" style="--c:${t.color}">${Math.round(m.inclination)}</span>` : '';
      const icon = L.divIcon({ className: 'sym', html: symbolOf(m, 40) + label, iconSize: [40, 40], iconAnchor: [20, 20] });
      L.marker([m.lat, m.lon], { icon, keyboard: true, title: `${m.structure} ${valueText(m)}` })
        .on('click', () => showDetail(m.id))
        .addTo(symbolsLayer);
    }
  }

  const valueText = (m) => (m.kind === 'plane'
    ? `${G.planeShort(m.azimuth, m.inclination)} · ${G.planeQuadrant(m.azimuth, m.inclination)}`
    : `${G.lineShort(m.azimuth, m.inclination)} · ${G.lineQuadrant(m.azimuth, m.inclination)}`);

  // ---------------------------------------------------------------- lectura de coordenadas
  let coordsFrame = 0;
  function updateCoords() {
    cancelAnimationFrame(coordsFrame);
    coordsFrame = requestAnimationFrame(() => {
      const c = map.getCenter().wrap();
      const u = U.fromLatLon(c.lat, c.lng);
      $('#coords').textContent = `✛ ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)} · ${U.format(u)} · z${map.getZoom().toFixed(1)}`;
    });
  }
  let viewTimer = 0;
  map.on('move', updateCoords);
  map.on('moveend', () => {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      const c = map.getCenter();
      state.settings.view = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
      saveSettings();
    }, 1200);
  });
  map.on('dragstart', () => {
    if (state.follow) { state.follow = false; updateGpsButton(); }
  });
  map.on('contextmenu', (e) => openForm({ point: e.latlng, source: 'mapa' }));

  // ================================================================ GPS
  const accCircle = L.circle([0, 0], { radius: 1, weight: 1, color: '#1a6ddc', fillColor: '#1a6ddc', fillOpacity: 0.15, interactive: false });
  const gpsMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="gps-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, keyboard: false });
  let centeredOnce = false;

  function gpsQuality(acc) {
    return acc <= 10 ? 'q-good' : acc <= 30 ? 'q-fair' : 'q-bad';
  }

  function renderGpsLine() {
    const el = $('#gpsline');
    const p = state.pos;
    el.className = 'gps-line';
    if (!p) {
      el.textContent = state.gpsError || 'GPS: buscando señal…';
      el.classList.add(state.gpsError ? 'q-bad' : 'q-fair');
      return;
    }
    const alt = p.alt == null ? '' : ` · alt ${Math.round(p.alt)} m`;
    el.textContent = `GPS ±${Math.round(p.acc)} m${alt}`;
    el.classList.add(gpsQuality(p.acc));
  }

  function updateGpsButton() {
    $('#btn-gps').setAttribute('aria-pressed', state.follow ? 'true' : 'false');
  }

  function startGps() {
    if (!('geolocation' in navigator)) {
      state.gpsError = 'Este navegador no tiene GPS';
      renderGpsLine();
      return;
    }
    navigator.geolocation.watchPosition((pos) => {
      const c = pos.coords;
      state.pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: c.altitude, t: pos.timestamp };
      state.gpsError = null;
      const ll = [c.latitude, c.longitude];
      accCircle.setLatLng(ll).setRadius(Math.max(c.accuracy, 1));
      gpsMarker.setLatLng(ll);
      if (!map.hasLayer(accCircle)) accCircle.addTo(map);
      if (!map.hasLayer(gpsMarker)) gpsMarker.addTo(map);
      if (!centeredOnce && !state.settings.view) {
        centeredOnce = true;
        map.setView(ll, 15);
      } else if (state.follow) {
        map.panTo(ll, { animate: true });
      }
      renderGpsLine();
      if (formState) refreshFormLocation();
    }, (err) => {
      state.gpsError = err.code === 1
        ? (IN_ARTIFACT ? 'GPS no disponible en esta vista previa: instala la app' : 'Sin permiso de ubicación para este sitio')
        : err.code === 2 ? 'GPS: posición no disponible' : 'GPS: esperando señal…';
      renderGpsLine();
      if (formState) refreshFormLocation();
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  }

  // ================================================================ capas: panel
  function layerMeta(l) {
    if (l.kind === 'grid') return 'Dibujada en el teléfono · sin conexión';
    if (l.kind === 'online') return 'En línea · necesita internet';
    const rt = runtime.get(l.id);
    if (rt && rt.error) return `<span class="err">${esc(rt.error)}</span>`;
    const mb = l.size ? `${(l.size / 1048576).toFixed(l.size > 1048576 * 100 ? 0 : 1)} MB · ` : '';
    return `${mb}${esc((l.format || 'png').toUpperCase())} · zoom ${l.minNative}–${l.maxNative}`;
  }

  function renderLayers() {
    const ul = $('#layer-list');
    ul.innerHTML = state.layers.map((l, i) => `
      <li class="layer${l.visible ? '' : ' off'}" data-id="${esc(l.id)}">
        <div class="layer-row">
          <input type="checkbox" id="vis-${esc(l.id)}" ${l.visible ? 'checked' : ''} aria-label="Mostrar ${esc(l.name)}">
          <button class="layer-name" data-act="fit" ${l.bounds ? '' : 'aria-disabled="true"'}>
            <b>${esc(l.name)}</b><small>${layerMeta(l)}</small>
          </button>
          <button class="icon-btn" data-act="up" aria-label="Subir" ${i === 0 ? 'disabled' : ''}><svg class="i"><use href="#i-up"/></svg></button>
          <button class="icon-btn" data-act="down" aria-label="Bajar" ${i === state.layers.length - 1 ? 'disabled' : ''}><svg class="i"><use href="#i-down"/></svg></button>
          <button class="icon-btn" data-act="more" aria-label="Más opciones"><svg class="i"><use href="#i-more"/></svg></button>
        </div>
        <div class="opacity">
          <svg class="i" aria-hidden="true"><use href="#i-drop"/></svg>
          <input type="range" id="op-${esc(l.id)}" min="0" max="100" step="5" value="${Math.round(l.opacity * 100)}" aria-label="Transparencia de ${esc(l.name)}">
          <output>${Math.round(l.opacity * 100)}%</output>
        </div>
        <div class="layer-more" hidden>
          <input class="input" id="rn-${esc(l.id)}" value="${esc(l.name)}" aria-label="Nombre de la capa">
          <button class="btn small" data-act="rename">Renombrar</button>
          ${l.kind === 'mbtiles' ? '<button class="btn small danger" data-act="delete">Eliminar</button>' : ''}
        </div>
      </li>`).join('');
  }

  $('#layer-list').addEventListener('input', (e) => {
    if (e.target.type !== 'range') return;
    const li = e.target.closest('.layer');
    const l = state.layers.find((x) => x.id === li.dataset.id);
    l.opacity = e.target.value / 100;
    e.target.nextElementSibling.textContent = `${e.target.value}%`;
    const lf = leafletOf(l);
    if (lf && lf.setOpacity) lf.setOpacity(l.opacity);
  });
  $('#layer-list').addEventListener('change', (e) => {
    const li = e.target.closest('.layer');
    if (!li) return;
    const l = state.layers.find((x) => x.id === li.dataset.id);
    if (e.target.type === 'range') { saveLayers(); return; }
    if (e.target.type === 'checkbox') {
      l.visible = e.target.checked;
      li.classList.toggle('off', !l.visible);
      applyLayers();
      saveLayers();
    }
  });
  $('#layer-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const li = btn.closest('.layer');
    const idx = state.layers.findIndex((x) => x.id === li.dataset.id);
    const l = state.layers[idx];
    switch (btn.dataset.act) {
      case 'fit':
        if (l.bounds) { closeSheet(); fitLayer(l); }
        break;
      case 'up':
      case 'down': {
        const j = btn.dataset.act === 'up' ? idx - 1 : idx + 1;
        if (j < 0 || j >= state.layers.length) return;
        [state.layers[idx], state.layers[j]] = [state.layers[j], state.layers[idx]];
        applyLayers();
        renderLayers();
        saveLayers();
        break;
      }
      case 'more':
        li.querySelector('.layer-more').hidden = !li.querySelector('.layer-more').hidden;
        break;
      case 'rename': {
        const v = li.querySelector('.layer-more input').value.trim();
        if (v) { l.name = v; renderLayers(); saveLayers(); }
        break;
      }
      case 'delete': {
        const ok = await confirmBox('¿Eliminar capa?', `Se borrará "${l.name}" de este navegador. El archivo original no se toca.`, 'Eliminar', true);
        if (!ok) return;
        const rt = runtime.get(l.id);
        if (rt && rt.leaflet && map.hasLayer(rt.leaflet)) map.removeLayer(rt.leaflet);
        runtime.delete(l.id);
        state.layers.splice(idx, 1);
        await Store.delFile(l.id);
        renderLayers();
        saveLayers();
        toast('Capa eliminada');
        break;
      }
    }
  });

  // ---------------------------------------------------------------- importar MBTiles
  const toInt = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  function parseBounds(s) {
    if (!s) return null;
    const v = String(s).split(',').map(Number);
    if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) return null;
    const [w, so, e, n] = v;
    if (!(n > so && e > w && n <= 90 && so >= -90)) return null;
    return v;
  }

  async function openReader(blob) {
    const reader = await window.MbTilesReader.fromBlob(blob).open();
    const fmt = String(reader.metadata.format || '').toLowerCase();
    if (fmt === 'pbf' || fmt === 'mvt') {
      throw new Error('MBTiles vectorial (pbf): por ahora solo se admiten MBTiles raster (png, jpg, webp)');
    }
    return reader;
  }

  async function importFiles(files) {
    for (const f of files) {
      if (!/\.mbtiles$/i.test(f.name)) { toast(`"${f.name}" no es un archivo .mbtiles`); continue; }
      busy(`Abriendo ${f.name}…`);
      try {
        const reader = await openReader(f);
        const md = reader.metadata;
        const id = newId();
        const layer = {
          id,
          kind: 'mbtiles',
          name: (md.name && md.name.trim()) || f.name.replace(/\.mbtiles$/i, ''),
          fileName: f.name,
          size: f.size,
          format: String(md.format || 'png').toLowerCase(),
          minNative: toInt(md.minzoom, 0),
          maxNative: toInt(md.maxzoom, 18),
          bounds: parseBounds(md.bounds),
          opacity: 1,
          visible: true,
        };
        runtime.set(id, { reader });
        const at = state.layers.findIndex((l) => l.kind !== 'grid');
        state.layers.splice(at < 0 ? 0 : at, 0, layer);
        applyLayers();
        renderLayers();
        saveLayers();
        busy(`Guardando ${f.name} en este navegador…`);
        const stored = await Store.putFile(id, f);
        if (!stored) toast('El mapa se verá solo en esta sesión: el navegador no permitió guardarlo', 4500);
        else if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
        busy(false);
        fitLayer(layer);
        toast(`Capa "${layer.name}" agregada`);
        maybeHideWelcome();
      } catch (e) {
        busy(false);
        toast(e.message || String(e), 5000);
      }
    }
  }

  $('#btn-add-mbtiles').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length) importFiles(files);
  });
  $('#map').addEventListener('dragover', (e) => e.preventDefault());
  $('#map').addEventListener('drop', (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) importFiles(files);
  });

  // ================================================================ formulario
  let formState = null;

  function suggestStation() {
    let max = 0;
    for (const m of state.items) {
      const r = /^E-(\d+)$/.exec((m.station || '').trim());
      if (r) max = Math.max(max, parseInt(r[1], 10));
    }
    return `E-${String(max + 1).padStart(3, '0')}`;
  }
  function distinctUnits() {
    const out = [];
    for (let i = state.items.length - 1; i >= 0 && out.length < 8; i--) {
      const u = (state.items[i].unit || '').trim();
      if (u && !out.includes(u)) out.push(u);
    }
    return out;
  }

  function openForm({ point = null, source = null, edit = null } = {}) {
    closeSheet();
    const m = edit ? state.items.find((x) => x.id === edit) : null;
    const decl = m ? m.declination : state.settings.declination;
    const base = m ? { lat: m.lat, lng: m.lon } : point || (state.pos ? { lat: state.pos.lat, lng: state.pos.lon } : map.getCenter());
    const utm = U.fromLatLon(base.lat, base.lng);
    formState = {
      m,
      kind: m ? m.kind : 'plane',
      structure: m ? m.structure : PLANES[0].name,
      notation: m ? 'dipdir' : 'strike',
      a: m ? G.fmtAz(G.normAz(m.azimuth - m.declination)) : '',
      b: m ? String(Math.round(m.inclination)) : '',
      source: m ? 'original' : (source || (state.pos && state.pos.acc <= 50 ? 'gps' : 'mapa')),
      mapPoint: point || (m ? null : map.getCenter()),
      coordMode: 'utm',
      lat: base.lat.toFixed(6),
      lon: base.lng.toFixed(6),
      zone: String(utm.zone),
      east: String(Math.round(utm.easting)),
      north: String(Math.round(utm.northing)),
      utmNorth: utm.north,
      station: m ? m.station : suggestStation(),
      unit: m ? m.unit : '',
      notes: m ? m.notes : '',
      decl,
      saved: 0,
    };
    $('#h-form').textContent = m ? 'Editar dato' : 'Nuevo dato';
    $('#form-delete').hidden = !m;
    $('#form-save-new').hidden = !!m;
    renderForm();
    $('#form-page').hidden = false;
    if (!m) $('#f-a').focus();
  }

  function closeForm() {
    $('#form-page').hidden = true;
    formState = null;
  }

  function radio(name, value, label, checked, extra = '') {
    return `<label><input type="radio" name="${name}" value="${esc(value)}" ${checked ? 'checked' : ''}><span>${extra}${esc(label)}</span></label>`;
  }

  function renderForm() {
    const f = formState;
    const structs = catalog(f.kind);
    const plane = f.kind === 'plane';
    const strike = plane && f.notation === 'strike';
    const aLabel = strike ? 'Rumbo' : plane ? 'Dir. de manteo' : 'Trend';
    const aHint = strike ? 'N30E · 030' : plane ? '120' : 'S30W · 210';
    const bLabel = plane ? 'Manteo' : 'Plunge';
    const bHint = strike ? '45SE · 45' : plane ? '45' : '30';
    const units = distinctUnits();
    const last = state.items.length ? state.items[state.items.length - 1].station : '';

    $('#form').innerHTML = `
      <div class="seg" role="radiogroup" aria-label="Tipo">
        ${radio('kind', 'plane', 'Plano', plane)}${radio('kind', 'line', 'Línea', !plane)}
      </div>
      <div class="chips" role="radiogroup" aria-label="Estructura">
        ${structs.map((t) => `<label class="chip"><input type="radio" name="structure" value="${esc(t.name)}" ${t.name === f.structure ? 'checked' : ''}><span><i style="background:${t.color}"></i>${esc(t.name)}</span></label>`).join('')}
      </div>
      ${plane ? `<div class="seg" role="radiogroup" aria-label="Notación">
        ${radio('notation', 'strike', 'Rumbo / manteo', strike)}${radio('notation', 'dipdir', 'Dir. manteo / manteo', !strike)}
      </div>` : ''}
      <div class="angles">
        <label class="field"><span>${aLabel}</span>
          <input class="input angle" id="f-a" value="${esc(f.a)}" placeholder="${aHint}" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="${plane && !strike ? 'decimal' : 'text'}" enterkeyhint="next"></label>
        <span class="slash" aria-hidden="true">/</span>
        <label class="field"><span>${bLabel}</span>
          <input class="input angle" id="f-b" value="${esc(f.b)}" placeholder="${bHint}" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="${strike ? 'text' : 'decimal'}" enterkeyhint="done"></label>
      </div>
      ${strike ? '<p class="hint">Sin sentido de manteo (solo 45) se aplica la regla de la mano derecha. O = oeste también vale.</p>' : ''}
      <div class="preview" id="f-preview"></div>

      <h3 class="section-title">Ubicación</h3>
      <div class="seg" role="radiogroup" aria-label="Ubicación">
        ${f.m ? radio('source', 'original', 'Original', f.source === 'original') : ''}
        ${radio('source', 'gps', 'GPS', f.source === 'gps')}
        ${radio('source', 'mapa', 'Mapa', f.source === 'mapa')}
        ${radio('source', 'manual', 'Coordenadas', f.source === 'manual')}
      </div>
      <div id="f-loc"></div>

      <h3 class="section-title">Contexto</h3>
      <label class="field"><span>Estación</span>
        <div class="row"><input class="input grow" id="f-station" value="${esc(f.station)}" autocomplete="off">
        ${last && last !== f.station ? `<button type="button" class="btn small" id="f-last">Usar ${esc(last)}</button>` : ''}</div>
      </label>
      <label class="field"><span>Unidad / litología</span>
        <input class="input" id="f-unit" value="${esc(f.unit)}" autocomplete="off"></label>
      ${units.length ? `<div class="chips" id="f-units">${units.map((u) => `<button type="button" class="chip" data-unit="${esc(u)}">${esc(u)}</button>`).join('')}</div>` : ''}
      <label class="field"><span>Notas</span>
        <textarea class="input" id="f-notes" rows="3">${esc(f.notes)}</textarea></label>
    `;
    renderPreview();
    renderLocation();
  }

  function compute() {
    const f = formState;
    if (!f.a.trim() || !f.b.trim()) return { error: '' };
    try {
      if (f.kind === 'plane') {
        const r = f.notation === 'strike' ? G.planeFromStrike(f.a, f.b) : G.planeFromDipDirection(f.a, f.b);
        return { az: G.normAz(r.dipDirection + f.decl), inc: r.dip, warning: r.warning, error: null };
      }
      const r = G.line(f.a, f.b);
      return { az: G.normAz(r.trend + f.decl), inc: r.plunge, warning: r.warning, error: null };
    } catch (e) {
      return { error: e.message };
    }
  }

  function renderPreview() {
    const f = formState;
    const r = compute();
    const t = typeOf(f.structure, f.kind);
    let read;
    if (r.error !== null) {
      read = r.error ? `<span class="err">${esc(r.error)}</span>` : '<span class="note">Escribe los dos valores para ver el dato</span>';
    } else if (f.kind === 'plane') {
      read = `<span class="big">${G.planeShort(r.az, r.inc)}</span>
        <span>Rumbo RHR ${G.fmtAz(G.strikeRhr(r.az))} · ${G.planeQuadrant(r.az, r.inc)}</span>`;
    } else {
      read = `<span class="big">${G.lineShort(r.az, r.inc)}</span><span>${G.lineQuadrant(r.az, r.inc)}</span>`;
    }
    if (r.error === null && r.warning) read += `<span class="warn">⚠ ${esc(r.warning)}</span>`;
    if (r.error === null && f.decl) read += `<span class="note">Incluye declinación ${f.decl > 0 ? '+' : ''}${f.decl}°</span>`;
    const sym = r.error === null ? symbolSVG(f.kind, t.style, t.color, r.az, r.inc, 60) : '';
    $('#f-preview').innerHTML = `<div class="dial"><b>N</b>${sym}</div><div class="read">${read}</div>`;
  }

  function refreshFormLocation() {
    if (formState && (formState.source === 'gps')) renderLocation();
  }

  function renderLocation() {
    const f = formState;
    const el = $('#f-loc');
    if (!el) return;
    const line = (lat, lon) => `${lat.toFixed(6)}, ${lon.toFixed(6)}<br>UTM ${U.format(U.fromLatLon(lat, lon))}`;
    if (f.source === 'original') {
      el.innerHTML = `<div class="loc-detail">${line(f.m.lat, f.m.lon)}</div>`;
    } else if (f.source === 'gps') {
      const p = state.pos;
      if (!p) {
        el.innerHTML = `<p class="hint q-bad">${esc(state.gpsError || 'Esperando señal GPS…')}</p>`;
      } else {
        el.innerHTML = `<div class="loc-detail">${line(p.lat, p.lon)}<br><b class="${gpsQuality(p.acc)}">±${Math.round(p.acc)} m</b>${p.acc > 30 ? ' · precisión baja: espera unos segundos o usa "Mapa"' : ''}</div>`;
      }
    } else if (f.source === 'mapa') {
      const pt = f.mapPoint;
      el.innerHTML = pt
        ? `<div class="loc-detail">${line(pt.lat, pt.lng)}</div><p class="hint">Centro del mapa (cruz) o el punto que mantuviste presionado.</p>`
        : '<p class="hint">Sin punto del mapa.</p>';
    } else {
      el.innerHTML = `
        <div class="seg" role="radiogroup" aria-label="Sistema">
          ${radio('coordmode', 'utm', 'UTM (WGS84)', f.coordMode === 'utm')}${radio('coordmode', 'wgs', 'Lat / Lon', f.coordMode === 'wgs')}
        </div>
        ${f.coordMode === 'utm' ? `
          <div class="grid-utm">
            <label class="field"><span>Zona</span><input class="input mono" id="c-zone" inputmode="numeric" value="${esc(f.zone)}"></label>
            <div class="seg" role="radiogroup" aria-label="Hemisferio">${radio('hemi', 'N', 'Norte', f.utmNorth)}${radio('hemi', 'S', 'Sur', !f.utmNorth)}</div>
          </div>
          <div class="grid2">
            <label class="field"><span>Este (m)</span><input class="input mono" id="c-east" inputmode="decimal" value="${esc(f.east)}"></label>
            <label class="field"><span>Norte (m)</span><input class="input mono" id="c-north" inputmode="decimal" value="${esc(f.north)}"></label>
          </div>` : `
          <div class="grid2">
            <label class="field"><span>Latitud</span><input class="input mono" id="c-lat" inputmode="decimal" value="${esc(f.lat)}"></label>
            <label class="field"><span>Longitud</span><input class="input mono" id="c-lon" inputmode="decimal" value="${esc(f.lon)}"></label>
          </div>`}`;
    }
  }

  const num = (s) => { const v = parseFloat(String(s).trim().replace(',', '.')); return Number.isFinite(v) ? v : null; };

  function resolveLocation() {
    const f = formState;
    if (f.source === 'original') return { lat: f.m.lat, lon: f.m.lon, alt: f.m.altitude, acc: f.m.accuracy, source: f.m.locationSource };
    if (f.source === 'gps') {
      const p = state.pos;
      if (!p) throw new Error('Aún no hay posición GPS: usa "Mapa" o "Coordenadas"');
      return { lat: p.lat, lon: p.lon, alt: p.alt, acc: p.acc, source: 'gps' };
    }
    if (f.source === 'mapa') {
      if (!f.mapPoint) throw new Error('No hay punto del mapa');
      return { lat: f.mapPoint.lat, lon: f.mapPoint.lng, alt: null, acc: null, source: 'mapa' };
    }
    if (f.coordMode === 'wgs') {
      const lat = num(f.lat), lon = num(f.lon);
      if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error('Latitud o longitud no válidas');
      return { lat, lon, alt: null, acc: null, source: 'manual' };
    }
    const zone = parseInt(f.zone, 10), e = num(f.east), n = num(f.north);
    if (!(zone >= 1 && zone <= 60)) throw new Error('La zona UTM va de 1 a 60');
    if (e === null || n === null || e < 100000 || e > 900000 || n < 0 || n > 10000000) throw new Error('Este (100000–900000) o Norte (0–10000000) no válidos');
    const [lat, lon] = U.toLatLon(e, n, zone, f.utmNorth);
    return { lat, lon, alt: null, acc: null, source: 'manual' };
  }

  async function saveForm(andNew) {
    const f = formState;
    const r = compute();
    if (r.error !== null) { toast(r.error || 'Completa los dos valores'); return; }
    let loc;
    try { loc = resolveLocation(); } catch (e) { toast(e.message); return; }
    const raw = `${f.a.trim()} / ${f.b.trim()}`;
    const fields = {
      kind: f.kind, structure: f.structure, azimuth: r.az, inclination: r.inc, rawInput: raw, declination: f.decl,
      lat: loc.lat, lon: loc.lon, altitude: loc.alt == null ? null : loc.alt, accuracy: loc.acc == null ? null : loc.acc,
      locationSource: loc.source, station: f.station.trim(), unit: f.unit.trim(), notes: f.notes.trim(),
    };
    if (f.m) {
      Object.assign(f.m, fields, { updatedAt: new Date().toISOString() });
      await saveItems();
      renderSymbols();
      closeForm();
      toast('Dato actualizado');
      return;
    }
    state.items.push({ id: newId(), ...fields, createdAt: new Date().toISOString() });
    await saveItems();
    renderSymbols();
    maybeHideWelcome();
    if (andNew) {
      f.saved++;
      f.a = ''; f.b = ''; f.notes = '';
      $('#f-a').value = ''; $('#f-b').value = ''; $('#f-notes').value = '';
      renderPreview();
      $('#f-a').focus();
      toast(`Guardado (${f.saved} en esta estación)`);
    } else {
      closeForm();
      toast('Dato guardado');
    }
  }

  // eventos del formulario (delegados)
  $('#form').addEventListener('input', (e) => {
    const f = formState;
    if (!f) return;
    const id = e.target.id;
    const map_ = { 'f-a': 'a', 'f-b': 'b', 'f-station': 'station', 'f-unit': 'unit', 'f-notes': 'notes', 'c-zone': 'zone', 'c-east': 'east', 'c-north': 'north', 'c-lat': 'lat', 'c-lon': 'lon' };
    if (map_[id]) {
      f[map_[id]] = e.target.value;
      if (id === 'f-a' || id === 'f-b') renderPreview();
    }
  });
  $('#form').addEventListener('change', (e) => {
    const f = formState;
    if (!f || e.target.type !== 'radio') return;
    const v = e.target.value;
    switch (e.target.name) {
      case 'kind':
        f.kind = v;
        f.structure = catalog(v)[0].name;
        renderForm();
        break;
      case 'structure': f.structure = v; renderPreview(); break;
      case 'notation': f.notation = v; renderForm(); break;
      case 'source': f.source = v; renderLocation(); break;
      case 'coordmode': f.coordMode = v; renderLocation(); break;
      case 'hemi': f.utmNorth = v === 'N'; break;
    }
  });
  $('#form').addEventListener('click', (e) => {
    const f = formState;
    if (!f) return;
    if (e.target.id === 'f-last') {
      f.station = state.items[state.items.length - 1].station;
      $('#f-station').value = f.station;
      e.target.remove();
    }
    const u = e.target.closest('[data-unit]');
    if (u) { f.unit = u.dataset.unit; $('#f-unit').value = f.unit; }
  });
  $('#form').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'f-a') { e.preventDefault(); $('#f-b').focus(); }
    else if (e.key === 'Enter' && e.target.id === 'f-b') { e.preventDefault(); e.target.blur(); }
  });
  $('#form').addEventListener('submit', (e) => e.preventDefault());
  $('#form-back').addEventListener('click', closeForm);
  $('#form-save').addEventListener('click', () => saveForm(false));
  $('#form-save-new').addEventListener('click', () => saveForm(true));
  $('#form-delete').addEventListener('click', async () => {
    const m = formState && formState.m;
    if (!m) return;
    if (!(await confirmBox('¿Eliminar este dato?', `${m.structure} ${valueText(m)}`, 'Eliminar', true))) return;
    state.items = state.items.filter((x) => x.id !== m.id);
    await saveItems();
    renderSymbols();
    closeForm();
    toast('Dato eliminado');
  });

  // ================================================================ detalle y lista
  function showDetail(id) {
    const m = state.items.find((x) => x.id === id);
    if (!m) return;
    const u = U.fromLatLon(m.lat, m.lon);
    const when = new Date(m.createdAt);
    $('#h-detail').textContent = m.structure;
    $('#detail-body').innerHTML = `
      <div class="detail-head">${symbolOf(m, 52)}<div class="read mono"><div style="font-size:20px;font-weight:600">${m.kind === 'plane' ? G.planeShort(m.azimuth, m.inclination) : G.lineShort(m.azimuth, m.inclination)}</div>
        <div>${m.kind === 'plane' ? `${G.planeQuadrant(m.azimuth, m.inclination)} · rumbo RHR ${G.fmtAz(G.strikeRhr(m.azimuth))}` : G.lineQuadrant(m.azimuth, m.inclination)}</div></div></div>
      <dl class="kv">
        ${m.station ? `<dt>Estación</dt><dd>${esc(m.station)}</dd>` : ''}
        ${m.unit ? `<dt>Unidad</dt><dd>${esc(m.unit)}</dd>` : ''}
        <dt>Lat, lon</dt><dd>${m.lat.toFixed(6)}, ${m.lon.toFixed(6)}</dd>
        <dt>UTM</dt><dd>${U.format(u)}</dd>
        <dt>Ubicación</dt><dd>${{ gps: 'GPS', mapa: 'Mapa', manual: 'Coordenadas' }[m.locationSource] || esc(m.locationSource)}${m.accuracy != null ? ` ±${Math.round(m.accuracy)} m` : ''}</dd>
        ${m.declination ? `<dt>Declinación</dt><dd>${m.declination}°</dd>` : ''}
        <dt>Entrada</dt><dd>${esc(m.rawInput)}</dd>
        <dt>Fecha</dt><dd>${when.toLocaleString('es')}</dd>
      </dl>
      ${m.notes ? `<p style="margin:0">${esc(m.notes)}</p>` : ''}
      <div class="actions">
        <button class="btn primary" data-act="edit"><svg class="i"><use href="#i-edit"/></svg>Editar</button>
        <button class="btn" data-act="go"><svg class="i"><use href="#i-map"/></svg>Ver en mapa</button>
        <button class="btn danger" data-act="del" aria-label="Eliminar dato"><svg class="i"><use href="#i-trash"/></svg></button>
      </div>`;
    $('#detail-body').dataset.id = id;
    openSheet('sheet-detail', { light: true });
  }
  $('#detail-body').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = $('#detail-body').dataset.id;
    const m = state.items.find((x) => x.id === id);
    if (!m) return;
    if (b.dataset.act === 'go') {
      closeSheet();
      state.follow = false; updateGpsButton();
      map.setView([m.lat, m.lon], Math.max(map.getZoom(), 16));
    } else if (b.dataset.act === 'edit') {
      openForm({ edit: id });
    } else if (b.dataset.act === 'del') {
      if (!(await confirmBox('¿Eliminar este dato?', `${m.structure} ${valueText(m)}`, 'Eliminar', true))) return;
      state.items = state.items.filter((x) => x.id !== id);
      await saveItems();
      renderSymbols();
      closeSheet();
      toast('Dato eliminado');
    }
  });

  let dataFilter = 'all';
  function renderList() {
    const q = $('#data-search').value.trim().toLowerCase();
    const planes = state.items.filter((m) => m.kind === 'plane').length;
    $('#f-all').textContent = `Todos (${state.items.length})`;
    $('#f-plane').textContent = `Planos (${planes})`;
    $('#f-line').textContent = `Líneas (${state.items.length - planes})`;
    $('#h-data').textContent = `Datos (${state.items.length})`;
    const list = state.items
      .filter((m) => dataFilter === 'all' || m.kind === dataFilter)
      .filter((m) => !q || [m.structure, m.station, m.unit, m.notes].some((s) => (s || '').toLowerCase().includes(q)))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const ul = $('#data-list');
    if (!list.length) {
      ul.innerHTML = `<li><p class="empty">${state.items.length ? 'Ningún dato coincide con la búsqueda.' : 'Aún no hay datos. Toca <b>+ Dato</b> para anotar el primero.'}</p></li>`;
      return;
    }
    ul.innerHTML = list.map((m) => {
      const d = new Date(m.createdAt);
      const when = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const sub = [m.station, m.unit, when].filter(Boolean).map(esc).join(' · ');
      return `<li><button class="data-item" data-id="${esc(m.id)}">${symbolOf(m, 40)}<span class="txt"><b>${esc(m.structure)}</b><span class="v">${valueText(m)}</span><small>${sub}</small></span></button></li>`;
    }).join('');
  }
  $('#data-search').addEventListener('input', renderList);
  $('#data-filter').addEventListener('change', (e) => { dataFilter = e.target.value; renderList(); });
  $('#data-list').addEventListener('click', (e) => {
    const b = e.target.closest('.data-item');
    if (b) showDetail(b.dataset.id);
  });

  // ================================================================ exportar
  function rowOf(m) {
    const u = U.fromLatLon(m.lat, m.lon);
    const plane = m.kind === 'plane';
    const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
    return {
      id: m.id,
      tipo: plane ? 'plano' : 'linea',
      estructura: m.structure,
      azimut: Math.round(m.azimuth),
      inclinacion: Math.round(m.inclination),
      dir_manteo: plane ? Math.round(m.azimuth) : null,
      manteo: plane ? Math.round(m.inclination) : null,
      rumbo_rhr: plane ? Math.round(G.strikeRhr(m.azimuth)) % 360 : null,
      trend: plane ? null : Math.round(m.azimuth),
      plunge: plane ? null : Math.round(m.inclination),
      notacion: plane ? G.planeQuadrant(m.azimuth, m.inclination) : G.lineQuadrant(m.azimuth, m.inclination),
      lat: Number(m.lat.toFixed(7)),
      lon: Number(m.lon.toFixed(7)),
      utm_zona: `${u.zone}${u.band}`,
      utm_e: r1(u.easting),
      utm_n: r1(u.northing),
      altitud_m: r1(m.altitude),
      precision_m: r1(m.accuracy),
      fuente_ubicacion: m.locationSource,
      estacion: m.station,
      unidad: m.unit,
      notas: m.notes,
      declinacion: m.declination,
      entrada_original: m.rawInput,
      fecha: m.createdAt,
    };
  }
  const stamp = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  };
  const sorted = () => [...state.items].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  function toCsv() {
    const rows = sorted().map(rowOf);
    const head = Object.keys(rows[0]);
    const cell = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [head.join(','), ...rows.map((r) => head.map((h) => cell(r[h])).join(','))].join('\n') + '\n';
  }
  function toGeoJson() {
    return JSON.stringify({
      type: 'FeatureCollection',
      name: 'geocampo_datos',
      features: sorted().map((m) => {
        const p = rowOf(m);
        delete p.lat; delete p.lon;
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [Number(m.lon.toFixed(7)), Number(m.lat.toFixed(7))] }, properties: p };
      }),
    }, null, 1);
  }

  async function deliver(kind, how) {
    if (!state.items.length) { toast('Todavía no hay datos para exportar'); return; }
    const csv = kind === 'csv';
    const text = csv ? toCsv() : toGeoJson();
    let name = `geocampo_${stamp()}.${csv ? 'csv' : 'geojson'}`;
    const mime = csv ? 'text/csv' : 'application/geo+json';
    if (IN_ARTIFACT) {
      const dl = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
      if (!dl) { toast('La descarga no está disponible en esta vista'); return; }
      if (!csv) name = name.replace(/\.geojson$/, '.json');
      try { await dl.save({ filename: name, data: text }); toast('Archivo guardado'); } catch (e) {
        if (e && e.code !== 'declined') toast('No se pudo guardar el archivo');
      }
      return;
    }
    const file = new File([text], name, { type: mime });
    if (how === 'share') {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        toast('No se pudo compartir; se descargará el archivo');
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    toast(`Descargado: ${name}`);
  }

  function renderExport() {
    const canShare = !IN_ARTIFACT && navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.csv', { type: 'text/csv' })] });
    const n = state.items.length;
    const btns = (k) => `${canShare ? `<button class="btn" data-k="${k}" data-how="share">Compartir</button>` : ''}<button class="btn ${canShare ? '' : 'primary'}" data-k="${k}" data-how="download">Descargar</button>`;
    $('#export-body').innerHTML = `
      <p class="hint">${n ? `${n} dato${n === 1 ? '' : 's'} con lat/lon, UTM, dirección de manteo, rumbo RHR y notación en cuadrante.` : 'Todavía no hay datos para exportar.'}</p>
      <div class="layer"><div class="layer-row"><div class="layer-name"><b>CSV</b><small>QGIS (texto delimitado), LibreOffice, Excel</small></div></div><div class="row">${btns('csv')}</div></div>
      <div class="layer"><div class="layer-row"><div class="layer-name"><b>GeoJSON</b><small>Puntos con atributos para QGIS o ArcGIS Pro</small></div></div><div class="row">${btns('geojson')}</div></div>`;
  }
  $('#export-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]');
    if (b) deliver(b.dataset.k, b.dataset.how);
  });

  // ================================================================ ajustes
  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    if (openSheetEl && openSheetEl.id === 'sheet-settings') renderSettings();
  });

  async function renderSettings() {
    const s = state.settings;
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    let install;
    if (IN_ARTIFACT) {
      install = '<p class="hint">Esta es una vista previa: aquí no hay GPS ni instalación. Para usarla en terreno, publica la versión instalable (ver LEEME del paquete).</p>';
    } else if (standalone) {
      install = '<p class="hint">App instalada: funciona sin conexión.</p>';
    } else if (installEvent) {
      install = '<button class="btn primary" id="s-install">Instalar en este dispositivo</button>';
    } else if (ios) {
      install = '<p class="hint">En iPhone/iPad: botón Compartir → <b>Agregar a pantalla de inicio</b>.</p>';
    } else {
      install = '<p class="hint">Para instalarla: menú del navegador (⋮) → <b>Instalar app</b> o <b>Agregar a pantalla de inicio</b>.</p>';
    }
    let storage = '';
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        const persisted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
        storage = `${(est.usage / 1048576).toFixed(0)} MB usados de ${(est.quota / 1073741824).toFixed(1)} GB disponibles${persisted ? ' · almacenamiento persistente' : ''}`;
      }
    } catch (e) { storage = ''; }
    $('#settings-body').innerHTML = `
      <label class="field"><span>Declinación magnética (°)</span>
        <input class="input mono" id="s-decl" inputmode="decimal" value="${esc(s.declination)}">
      </label>
      <p class="hint">Este +, Oeste −. Se suma a los azimuts que ingreses. Déjala en 0 si ya la ajustaste en la brújula.</p>
      <label class="row"><input type="checkbox" id="s-labels" ${s.showLabels ? 'checked' : ''} style="width:22px;height:22px;accent-color:var(--accent)"> Mostrar manteo/plunge junto a cada símbolo</label>
      <h3 class="section-title">Instalar</h3>
      ${install}
      <h3 class="section-title">Almacenamiento</h3>
      <p class="hint">Datos y mapas se guardan solo en este navegador${Store.ok ? '' : ' (aquí no se pueden guardar: se perderán al cerrar)'}. Exporta seguido para respaldar.${storage ? `<br>${storage}` : ''}</p>
      <button class="btn danger" id="s-wipe">Borrar todos los datos estructurales</button>
      <p class="hint">GeoCampo web 0.1 · mapas offline MBTiles · conversiones verificadas contra PROJ.</p>`;
  }
  $('#settings-body').addEventListener('change', (e) => {
    if (e.target.id === 's-decl') {
      const v = num(e.target.value);
      if (v === null || v < -90 || v > 90) { toast('La declinación va de -90 a 90'); e.target.value = state.settings.declination; return; }
      state.settings.declination = v;
      saveSettings();
      toast(`Declinación ${v}° guardada`);
    }
    if (e.target.id === 's-labels') {
      state.settings.showLabels = e.target.checked;
      saveSettings();
      renderSymbols();
    }
  });
  $('#settings-body').addEventListener('click', async (e) => {
    if (e.target.id === 's-install' && installEvent) {
      installEvent.prompt();
      installEvent = null;
      renderSettings();
    }
    if (e.target.id === 's-wipe') {
      if (!state.items.length) { toast('No hay datos'); return; }
      if (!(await confirmBox(`¿Borrar los ${state.items.length} datos?`, 'No se puede deshacer. Exporta antes si los necesitas.', 'Borrar todo', true))) return;
      state.items = [];
      await saveItems();
      renderSymbols();
      toast('Datos borrados');
    }
  });

  // ================================================================ bienvenida
  function maybeHideWelcome() {
    const hasMaps = state.layers.some((l) => l.kind === 'mbtiles');
    $('#welcome').hidden = state.settings.welcomeDismissed || (hasMaps && state.items.length > 0);
  }
  $('#welcome-close').addEventListener('click', () => {
    state.settings.welcomeDismissed = true;
    saveSettings();
    maybeHideWelcome();
  });

  // ================================================================ barra y botones
  $('#tab-layers').addEventListener('click', () => { renderLayers(); openSheet('sheet-layers', { light: true }); });
  $('#tab-data').addEventListener('click', () => { renderList(); openSheet('sheet-data'); });
  $('#tab-add').addEventListener('click', () => openForm());
  $('#tab-export').addEventListener('click', () => { renderExport(); openSheet('sheet-export'); });
  $('#tab-settings').addEventListener('click', () => { renderSettings(); openSheet('sheet-settings'); });
  $('#scrim').addEventListener('click', closeSheet);
  $$('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  $('#btn-zin').addEventListener('click', () => map.zoomIn());
  $('#btn-zout').addEventListener('click', () => map.zoomOut());
  $('#btn-gps').addEventListener('click', () => {
    if (!state.pos) { toast(state.gpsError || 'Esperando señal GPS…'); return; }
    state.follow = true;
    updateGpsButton();
    map.setView([state.pos.lat, state.pos.lon], Math.max(map.getZoom(), 16));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#dialog').hidden) { $('#dlg-cancel').click(); return; }
    if (!$('#form-page').hidden) { closeForm(); return; }
    closeSheet();
  });

  // ================================================================ arranque
  async function boot() {
    await Store.open();
    const [layers, items, settings] = await Promise.all([Store.get('layers'), Store.get('items'), Store.get('settings')]);
    if (settings && typeof settings === 'object') Object.assign(state.settings, settings);
    state.items = Array.isArray(items) ? items : [];
    const saved = Array.isArray(layers) ? layers : [];
    for (const b of BUILTIN) if (!saved.some((l) => l.id === b.id)) saved.push({ ...b });
    // Las capas integradas siempre usan la definición actual (URL, atribución).
    state.layers = saved.map((l) => {
      const b = BUILTIN.find((x) => x.id === l.id);
      return b ? { ...b, opacity: l.opacity, visible: l.visible } : l;
    });

    for (const l of state.layers.filter((x) => x.kind === 'mbtiles')) {
      try {
        const blob = await Store.getFile(l.id);
        if (!blob) { runtime.set(l.id, { error: 'Archivo no disponible: vuelve a cargarlo' }); continue; }
        runtime.set(l.id, { reader: await openReader(blob) });
      } catch (e) {
        runtime.set(l.id, { error: e.message || 'No se pudo abrir' });
      }
    }

    const v = state.settings.view;
    if (v && Number.isFinite(v.lat)) map.setView([v.lat, v.lon], v.zoom);
    else map.setView([-30, -70], 5);
    applyLayers();
    renderSymbols();
    updateCoords();
    renderGpsLine();
    maybeHideWelcome();
    startGps();
    if (!Store.ok) toast('Este navegador no permite guardar: los datos se perderán al cerrar', 5000);

    if ('serviceWorker' in navigator && !IN_ARTIFACT && /^https:|^http:\/\/localhost/.test(location.href)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  boot();
})();
