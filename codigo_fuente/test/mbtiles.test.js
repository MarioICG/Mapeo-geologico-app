const fs = require('fs');
const assert = require('assert');
const { MbTilesReader } = require('../src/mbtiles.js');

function fileSource(path) {
  const fd = fs.openSync(path, 'r');
  const size = fs.fstatSync(fd).size;
  let reads = 0;
  return {
    size,
    get reads() { return reads; },
    async read(off, len) {
      reads++;
      const n = Math.max(0, Math.min(len, size - off));
      const b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, off);
      return new Uint8Array(b.buffer, b.byteOffset, n);
    },
  };
}

// Mismo generador que make_mbtiles.py, vía Python precalculado: comparamos contra sqlite3 de Python.
const { execFileSync } = require('child_process');
function expected(path, z, x, y) {
  const out = execFileSync('python3', ['-c', `
import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
r=c.execute("SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?", (int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4]))).fetchone()
sys.stdout.write(r[0].hex() if r else "NONE")`, path, z, x, y]).toString();
  return out === 'NONE' ? null : Buffer.from(out, 'hex');
}

(async () => {
  const files = ['qgis', 'pk', 'worowid', 'noindex', 'gdal', 'intid'];
  const probes = [[0,0,0],[1,1,0],[3,5,2],[4,0,15],[5,31,31],[5,17,9],[5,0,0],[2,3,3],[6,0,0],[5,32,1],[9,1,1]];
  for (const f of files) {
    const path = `data/${f}.mbtiles`;
    const src = fileSource(path);
    const r = await new MbTilesReader(src).open();
    assert.strictEqual(r.metadata.name, 'Prueba');
    assert.strictEqual(r.metadata.maxzoom, '5');
    let checked = 0;
    for (const [z, x, y] of probes) {
      const got = await r.getTile(z, x, y);
      const exp = expected(path, z, x, y);
      if (exp === null) assert.strictEqual(got, null, `${f} ${z}/${x}/${y} debería faltar`);
      else assert.ok(got && Buffer.compare(Buffer.from(got), exp) === 0, `${f} ${z}/${x}/${y} distinto`);
      checked++;
    }
    // Recorrido completo del nivel 5 (1024 teselas) para comparar en bloque.
    const all = JSON.parse(execFileSync('python3', ['-c', `
import sqlite3,sys,json,hashlib
c=sqlite3.connect(sys.argv[1])
print(json.dumps({f"{z}/{x}/{y}": hashlib.md5(d).hexdigest() for z,x,y,d in c.execute("SELECT zoom_level,tile_column,tile_row,tile_data FROM tiles WHERE zoom_level=5")}))`, path]).toString());
    const crypto = require('crypto');
    for (const [k, h] of Object.entries(all)) {
      const [z, x, y] = k.split('/').map(Number);
      const got = await r.getTile(z, x, y);
      assert.strictEqual(crypto.createHash('md5').update(got).digest('hex'), h, `${f} ${k}`);
      checked++;
    }
    console.log(`${f.padEnd(8)} modo=${r.mode.padEnd(15)} pág=${String(r.pageSize).padEnd(5)} teselas OK=${checked} lecturas=${src.reads}`);
  }
  console.log('mbtiles tests OK');
})().catch((e) => { console.error(e); process.exit(1); });
