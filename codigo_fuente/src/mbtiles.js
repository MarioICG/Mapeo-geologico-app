/* GeoCampo — lector de MBTiles para el navegador.

   Lee el archivo SQLite por trozos (File.slice), sin cargarlo entero en
   memoria: sirve para MBTiles de varios GB en el teléfono. Implementa solo
   lo necesario para MBTiles: recorrer B-trees de tablas e índices, registros
   y páginas de desbordamiento.

   Esquemas admitidos:
   - tabla `tiles` (zoom_level, tile_column, tile_row, tile_data) con índice
     (QGIS, MapTiler, mb-util, MOBAC…)
   - tablas `map` + `images` (GDAL, tippecanoe, mb-util comprimido)
   - tablas WITHOUT ROWID con PRIMARY KEY (zoom_level, tile_column, tile_row)
   - sin índice: archivos pequeños se indexan en memoria al abrir. */
(function (root) {
  'use strict';

  class MbTilesError extends Error {}

  const LEAF_TABLE = 0x0d, INTERIOR_TABLE = 0x05, LEAF_INDEX = 0x0a, INTERIOR_INDEX = 0x02;
  const NO_INDEX_SCAN_LIMIT = 96 * 1024 * 1024; // bytes

  // ---------------------------------------------------------------- fuentes

  function blobSource(blob) {
    return {
      size: blob.size,
      async read(offset, length) {
        const end = Math.min(offset + length, blob.size);
        return new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      },
    };
  }

  // ---------------------------------------------------------------- utilidades

  function readVarint(buf, pos) {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      const b = buf[pos + i];
      v = v * 128 + (b & 0x7f);
      if (b < 0x80) return [v, pos + i + 1];
    }
    v = v * 256 + buf[pos + 8];
    return [v, pos + 9];
  }

  const u16 = (b, p) => (b[p] << 8) | b[p + 1];
  const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];

  function readInt(buf, pos, n) {
    // Entero con signo big-endian de n bytes (exacto hasta 2^53).
    let x = 0;
    for (let i = 0; i < n; i++) x = x * 256 + buf[pos + i];
    if (buf[pos] & 0x80) x -= Math.pow(2, 8 * n);
    return x;
  }

  // ---------------------------------------------------------------- lector

  class MbTilesReader {
    constructor(source, opts = {}) {
      this.src = source;
      this.cacheLimit = opts.cacheBytes || 48 * 1024 * 1024;
      this._cache = new Map();
      this._cacheBytes = 0;
      this._pending = new Map();
      this.metadata = {};
      this._tileMemo = null;
    }

    static fromBlob(blob, opts) {
      return new MbTilesReader(blobSource(blob), opts);
    }

    // ---------- páginas

    async _readRange(first, count) {
      const ps = this.pageSize;
      const last = Math.min(first + count - 1, this.pageCount);
      const bytes = await this.src.read((first - 1) * ps, (last - first + 1) * ps);
      for (let n = first; n <= last; n++) {
        const off = (n - first) * ps;
        if (off >= bytes.length) break;
        this._put(n, bytes.subarray(off, Math.min(off + ps, bytes.length)));
      }
    }

    _put(n, page) {
      if (this._cache.has(n)) return;
      this._cache.set(n, page);
      this._cacheBytes += page.length;
      while (this._cacheBytes > this.cacheLimit && this._cache.size > 1) {
        const k = this._cache.keys().next().value;
        this._cacheBytes -= this._cache.get(k).length;
        this._cache.delete(k);
      }
    }

    async page(n, readAhead = 1) {
      const hit = this._cache.get(n);
      if (hit) {
        this._cache.delete(n);
        this._cache.set(n, hit);
        return hit;
      }
      if (!this._pending.has(n)) {
        const p = this._readRange(n, readAhead).finally(() => this._pending.delete(n));
        this._pending.set(n, p);
      }
      await this._pending.get(n);
      const pg = this._cache.get(n);
      if (!pg) throw new MbTilesError(`No se pudo leer la página ${n}`);
      return pg;
    }

    // ---------- B-tree

    async btreePage(n) {
      const buf = await this.page(n);
      const h = n === 1 ? 100 : 0;
      const type = buf[h];
      if (type !== LEAF_TABLE && type !== INTERIOR_TABLE && type !== LEAF_INDEX && type !== INTERIOR_INDEX) {
        throw new MbTilesError(`Página ${n} no es un B-tree (tipo ${type})`);
      }
      const count = u16(buf, h + 3);
      const interior = type === INTERIOR_TABLE || type === INTERIOR_INDEX;
      const ptrStart = h + (interior ? 12 : 8);
      const cells = new Array(count);
      for (let i = 0; i < count; i++) cells[i] = u16(buf, ptrStart + i * 2);
      return { n, buf, type, cells, right: interior ? u32(buf, h + 8) : 0 };
    }

    _localSize(P, isTableLeaf) {
      const U = this.usable;
      const X = isTableLeaf ? U - 35 : Math.floor(((U - 12) * 64) / 255) - 23;
      if (P <= X) return P;
      const M = Math.floor(((U - 12) * 32) / 255) - 23;
      const K = M + ((P - M) % (U - 4));
      return K <= X ? K : M;
    }

    /** Payload completo de una celda que empieza en `pos` (tras rowid/hijo). */
    async _payload(buf, pos, P, isTableLeaf) {
      const local = this._localSize(P, isTableLeaf);
      if (local === P) return buf.subarray(pos, pos + P);
      const out = new Uint8Array(P);
      out.set(buf.subarray(pos, pos + local), 0);
      let filled = local;
      let next = u32(buf, pos + local);
      const per = this.usable - 4;
      while (filled < P && next) {
        const remainingPages = Math.ceil((P - filled) / per);
        const pg = await this.page(next, Math.min(remainingPages, 32));
        const take = Math.min(per, P - filled);
        out.set(pg.subarray(4, 4 + take), filled);
        filled += take;
        next = u32(pg, 0);
      }
      if (filled < P) throw new MbTilesError('Cadena de desbordamiento incompleta');
      return out;
    }

    /** Celda de índice → payload (registro). */
    async _indexCell(page, i) {
      let pos = page.cells[i];
      let left = 0;
      if (page.type === INTERIOR_INDEX) {
        left = u32(page.buf, pos);
        pos += 4;
      }
      const [P, p2] = readVarint(page.buf, pos);
      const payload = await this._payload(page.buf, p2, P, false);
      return { left, payload };
    }

    _decodeRecord(payload, limit = Infinity) {
      const [hdrLen, p0] = readVarint(payload, 0);
      const types = [];
      let p = p0;
      while (p < hdrLen && types.length < limit) {
        const [t, np] = readVarint(payload, p);
        types.push(t);
        p = np;
      }
      const vals = [];
      let d = hdrLen;
      for (const t of types) {
        let v = null;
        let len = 0;
        switch (t) {
          case 0: v = null; break;
          case 1: len = 1; v = readInt(payload, d, 1); break;
          case 2: len = 2; v = readInt(payload, d, 2); break;
          case 3: len = 3; v = readInt(payload, d, 3); break;
          case 4: len = 4; v = readInt(payload, d, 4); break;
          case 5: len = 6; v = readInt(payload, d, 6); break;
          case 6: len = 8; v = readInt(payload, d, 8); break;
          case 7: len = 8; v = new DataView(payload.buffer, payload.byteOffset + d, 8).getFloat64(0); break;
          case 8: v = 0; break;
          case 9: v = 1; break;
          default:
            if (t >= 12 && t % 2 === 0) {
              len = (t - 12) / 2;
              v = payload.subarray(d, d + len);
            } else if (t >= 13) {
              len = (t - 13) / 2;
              v = this._decoder.decode(payload.subarray(d, d + len));
            }
        }
        vals.push(v);
        d += len;
      }
      return vals;
    }

    static _cmp(a, b) {
      const rank = (v) => (v === null || v === undefined ? 0 : typeof v === 'number' ? 1 : typeof v === 'string' ? 2 : 3);
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 0) return 0;
      if (ra === 1) return a < b ? -1 : a > b ? 1 : 0;
      if (ra === 2) return a < b ? -1 : a > b ? 1 : 0;
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
      return a.length - b.length;
    }

    /** Busca en un B-tree de índice la primera entrada cuyo prefijo = key. */
    async indexLookup(rootPage, key) {
      let n = rootPage;
      for (let depth = 0; depth < 64; depth++) {
        const page = await this.btreePage(n);
        const cells = page.cells;
        let lo = 0, hi = cells.length - 1, firstGreater = cells.length;
        let leftOfGreater = 0;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const { left, payload } = await this._indexCell(page, mid);
          const rec = this._decodeRecord(payload, key.length + 64);
          let c = 0;
          for (let k = 0; k < key.length && c === 0; k++) c = MbTilesReader._cmp(key[k], rec[k]);
          if (c === 0) return rec;
          if (c < 0) {
            firstGreater = mid;
            leftOfGreater = left;
            hi = mid - 1;
          } else {
            lo = mid + 1;
          }
        }
        if (page.type === LEAF_INDEX) return null;
        n = firstGreater < cells.length ? leftOfGreater : page.right;
      }
      throw new MbTilesError('Índice demasiado profundo');
    }

    /** Fila de una tabla por rowid → valores (o null). */
    async rowById(rootPage, rowid) {
      let n = rootPage;
      for (let depth = 0; depth < 64; depth++) {
        const page = await this.btreePage(n);
        const { buf, cells } = page;
        if (page.type === INTERIOR_TABLE) {
          let lo = 0, hi = cells.length - 1, idx = cells.length;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const [key] = readVarint(buf, cells[mid] + 4);
            if (key >= rowid) { idx = mid; hi = mid - 1; } else { lo = mid + 1; }
          }
          n = idx < cells.length ? u32(buf, cells[idx]) : page.right;
          continue;
        }
        if (page.type !== LEAF_TABLE) throw new MbTilesError('B-tree de tabla inesperado');
        let lo = 0, hi = cells.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const [P, p1] = readVarint(buf, cells[mid]);
          const [rid, p2] = readVarint(buf, p1);
          if (rid === rowid) {
            const payload = await this._payload(buf, p2, P, true);
            return this._decodeRecord(payload);
          }
          if (rid < rowid) lo = mid + 1; else hi = mid - 1;
        }
        return null;
      }
      throw new MbTilesError('Tabla demasiado profunda');
    }

    /** Recorre todas las filas de un B-tree de tabla: fn(rowid, valores). */
    async scanTable(rootPage, fn, { decodeLimit = Infinity } = {}) {
      const page = await this.btreePage(rootPage);
      if (page.type === INTERIOR_TABLE) {
        for (const c of page.cells) await this.scanTable(u32(page.buf, c), fn, { decodeLimit });
        await this.scanTable(page.right, fn, { decodeLimit });
        return;
      }
      for (const c of page.cells) {
        const [P, p1] = readVarint(page.buf, c);
        const [rid, p2] = readVarint(page.buf, p1);
        // Para escanear sin leer blobs grandes basta la parte local si el
        // encabezado y las primeras columnas caben en ella.
        const local = this._localSize(P, true);
        const payload = decodeLimit !== Infinity && local < P
          ? page.buf.subarray(p2, p2 + local)
          : await this._payload(page.buf, p2, P, true);
        fn(rid, this._decodeRecord(payload, decodeLimit));
      }
    }

    // ---------- esquema

    static _splitTop(s) {
      const out = [];
      let depth = 0, cur = '', q = null;
      for (const ch of s) {
        if (q) { cur += ch; if (ch === q) q = null; continue; }
        if (ch === '"' || ch === "'" || ch === '`' || ch === '[') { q = ch === '[' ? ']' : ch; cur += ch; continue; }
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    }

    static _ident(s) {
      return s.trim().replace(/^["'`\[]|["'`\]]$/g, '').toLowerCase();
    }

    static _inner(sql) {
      const a = sql.indexOf('(');
      const b = sql.lastIndexOf(')');
      return a >= 0 && b > a ? sql.slice(a + 1, b) : '';
    }

    static _colList(s) {
      return MbTilesReader._splitTop(s).map((c) => MbTilesReader._ident(c.split(/\s+/)[0]));
    }

    static parseTable(sql) {
      const cols = [];
      const constraints = []; // {kind:'pk'|'unique', cols}
      let rowidAlias = -1;
      const withoutRowid = /\)\s*without\s+rowid\s*;?\s*$/i.test(sql);
      for (const def of MbTilesReader._splitTop(MbTilesReader._inner(sql))) {
        const up = def.toUpperCase();
        const m = /^(CONSTRAINT\s+\S+\s+)?(PRIMARY\s+KEY|UNIQUE)\s*\((.*)\)/i.exec(def);
        if (m) {
          constraints.push({ kind: /PRIMARY/i.test(m[2]) ? 'pk' : 'unique', cols: MbTilesReader._colList(m[3]) });
          continue;
        }
        if (/^(CONSTRAINT|CHECK|FOREIGN)\b/i.test(up)) continue;
        const name = MbTilesReader._ident(def.split(/\s+/)[0]);
        if (/PRIMARY\s+KEY/i.test(up)) {
          if (/^\S+\s+INTEGER\s+PRIMARY\s+KEY/i.test(def) && !withoutRowid) rowidAlias = cols.length;
          constraints.push({ kind: 'pk', cols: [name] });
        } else if (/\bUNIQUE\b/i.test(up)) {
          constraints.push({ kind: 'unique', cols: [name] });
        }
        cols.push(name);
      }
      return { cols, constraints, rowidAlias, withoutRowid };
    }

    async open() {
      const head = await this.src.read(0, 100);
      const magic = new TextDecoder().decode(head.subarray(0, 15));
      if (magic !== 'SQLite format 3') throw new MbTilesError('No es un archivo SQLite/MBTiles');
      let ps = u16(head, 16);
      if (ps === 1) ps = 65536;
      this.pageSize = ps;
      this.usable = ps - head[20];
      this.pageCount = Math.ceil(this.src.size / ps);
      const enc = u32(head, 56);
      this._decoder = new TextDecoder(enc === 2 ? 'utf-16le' : enc === 3 ? 'utf-16be' : 'utf-8');

      // sqlite_master
      const master = [];
      await this.scanTable(1, (rid, v) => master.push({ type: v[0], name: v[1], tbl: v[2], root: v[3], sql: v[4] }));
      const tables = {};
      for (const r of master) {
        if (r.type === 'table' && r.sql) tables[String(r.name).toLowerCase()] = { ...r, ...MbTilesReader.parseTable(r.sql) };
      }
      const indexesOf = (tname) => master.filter((r) => r.type === 'index' && String(r.tbl).toLowerCase() === tname);

      // metadatos
      const meta = tables.metadata;
      if (meta) {
        const ni = meta.cols.indexOf('name'), vi = meta.cols.indexOf('value');
        await this.scanTable(meta.root, (rid, v) => {
          if (v[ni] != null) this.metadata[String(v[ni])] = v[vi] == null ? '' : String(v[vi]);
        });
      }

      const ZXY = ['zoom_level', 'tile_column', 'tile_row'];
      const hasAll = (t, names) => names.every((c) => t.cols.includes(c));

      // Índice cuyo prefijo son `cols` sobre la tabla t.
      const findIndex = (t, cols) => {
        const same = (a) => cols.every((c, i) => a[i] === c);
        const idx = indexesOf(t.name.toLowerCase());
        for (const r of idx) {
          if (r.sql) {
            const m = /\bON\s+\S+\s*\((.*)\)/is.exec(r.sql);
            if (m && same(MbTilesReader._colList(m[1]))) return r.root;
          }
        }
        // Índices automáticos (PRIMARY KEY / UNIQUE): mismo orden que las
        // restricciones que los crean.
        const autos = idx.filter((r) => !r.sql).sort((a, b) => {
          const na = +String(a.name).split('_').pop(), nb = +String(b.name).split('_').pop();
          return na - nb;
        });
        const cons = t.constraints.filter((c) => !(c.kind === 'pk' && t.rowidAlias >= 0 && c.cols.length === 1 && c.cols[0] === t.cols[t.rowidAlias]));
        for (let i = 0; i < Math.min(autos.length, cons.length); i++) {
          if (same(cons[i].cols)) return autos[i].root;
        }
        return 0;
      };

      const tileTables = Object.values(tables).filter((t) => hasAll(t, ZXY));
      const direct = tileTables.find((t) => t.cols.includes('tile_data'));
      const mapT = tileTables.find((t) => t.cols.includes('tile_id'));
      const imagesT = Object.values(tables).find((t) => hasAll(t, ['tile_data', 'tile_id']));

      if (direct) {
        this._tbl = direct;
        this._dataCol = direct.cols.indexOf('tile_data');
        const pk = direct.constraints.find((c) => c.kind === 'pk');
        if (direct.withoutRowid && pk && ZXY.every((c, i) => pk.cols[i] === c)) {
          // El B-tree de la tabla es un índice: PK primero, luego el resto.
          const rest = direct.cols.filter((c) => !pk.cols.includes(c));
          this._mode = 'without_rowid';
          this._wrDataPos = pk.cols.length + rest.indexOf('tile_data');
        } else {
          this._idx = findIndex(direct, ZXY);
          this._mode = this._idx ? 'direct' : 'scan_direct';
        }
      } else if (mapT && imagesT) {
        this._map = mapT;
        this._img = imagesT;
        this._mapIdx = findIndex(mapT, ZXY);
        this._imgIdx = imagesT.rowidAlias >= 0 && imagesT.cols[imagesT.rowidAlias] === 'tile_id'
          ? -1 // tile_id es el rowid
          : findIndex(imagesT, ['tile_id']);
        this._mode = this._mapIdx && this._imgIdx ? 'map_images' : 'scan_map_images';
      } else {
        throw new MbTilesError('El archivo no tiene tablas de teselas MBTiles');
      }

      if (this._mode.startsWith('scan')) await this._buildMemo();
      return this;
    }

    async _buildMemo() {
      if (this.src.size > NO_INDEX_SCAN_LIMIT) {
        throw new MbTilesError('MBTiles sin índice de teselas y demasiado grande para indexarlo en el teléfono');
      }
      const memo = new Map();
      if (this._mode === 'scan_direct') {
        const t = this._tbl;
        const iz = t.cols.indexOf('zoom_level'), ix = t.cols.indexOf('tile_column'), iy = t.cols.indexOf('tile_row');
        await this.scanTable(t.root, (rid, v) => memo.set(`${v[iz]}/${v[ix]}/${v[iy]}`, rid),
          { decodeLimit: Math.max(iz, ix, iy) + 1 });
      } else {
        const t = this._map;
        const iz = t.cols.indexOf('zoom_level'), ix = t.cols.indexOf('tile_column'), iy = t.cols.indexOf('tile_row');
        const it = t.cols.indexOf('tile_id');
        const ids = new Map();
        await this.scanTable(t.root, (rid, v) => ids.set(`${v[iz]}/${v[ix]}/${v[iy]}`, v[it]),
          { decodeLimit: Math.max(iz, ix, iy, it) + 1 });
        const img = this._img;
        const ii = img.cols.indexOf('tile_id');
        const byId = new Map();
        await this.scanTable(img.root, (rid, v) => byId.set(img.rowidAlias === ii ? rid : v[ii], rid),
          { decodeLimit: Math.max(ii, 0) + 1 });
        for (const [k, id] of ids) {
          const rid = byId.get(id);
          if (rid != null) memo.set(k, rid);
        }
        this._tbl = img;
        this._dataCol = img.cols.indexOf('tile_data');
      }
      this._tileMemo = memo;
    }

    _col(t, vals, rowid, i) {
      return i === t.rowidAlias ? rowid : vals[i];
    }

    /** Bytes de la tesela (y en esquema TMS, como guarda MBTiles) o null. */
    async getTile(z, x, y) {
      const key = [z, x, y];
      switch (this._mode) {
        case 'direct': {
          const rec = await this.indexLookup(this._idx, key);
          if (!rec) return null;
          const rowid = rec[rec.length - 1];
          const row = await this.rowById(this._tbl.root, rowid);
          return row ? row[this._dataCol] : null;
        }
        case 'without_rowid': {
          const rec = await this.indexLookup(this._tbl.root, key);
          return rec ? rec[this._wrDataPos] : null;
        }
        case 'map_images': {
          const rec = await this.indexLookup(this._mapIdx, key);
          if (!rec) return null;
          const mapRow = await this.rowById(this._map.root, rec[rec.length - 1]);
          if (!mapRow) return null;
          const tileId = mapRow[this._map.cols.indexOf('tile_id')];
          let imgRowid;
          if (this._imgIdx === -1) {
            imgRowid = tileId;
          } else {
            const r2 = await this.indexLookup(this._imgIdx, [tileId]);
            if (!r2) return null;
            imgRowid = r2[r2.length - 1];
          }
          const img = await this.rowById(this._img.root, imgRowid);
          return img ? img[this._img.cols.indexOf('tile_data')] : null;
        }
        default: {
          const rid = this._tileMemo.get(`${z}/${x}/${y}`);
          if (rid == null) return null;
          const row = await this.rowById(this._tbl.root, rid);
          return row ? row[this._dataCol] : null;
        }
      }
    }

    get mode() { return this._mode; }
  }

  /** Tipo MIME a partir de los primeros bytes. */
  function sniffMime(bytes) {
    if (!bytes || bytes.length < 4) return 'application/octet-stream';
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'application/gzip';
    return 'application/octet-stream';
  }

  root.MbTilesReader = MbTilesReader;
  root.MbTilesError = MbTilesError;
  root.sniffMime = sniffMime;
  if (typeof module !== 'undefined' && module.exports) module.exports = { MbTilesReader, MbTilesError, sniffMime };
})(typeof window !== 'undefined' ? window : globalThis);
