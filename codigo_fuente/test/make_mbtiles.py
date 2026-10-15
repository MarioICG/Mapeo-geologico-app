import sqlite3, random, os, json, hashlib
OUT='data'; os.makedirs(OUT, exist_ok=True)
def blob(z,x,y):
    r = random.Random(z*1000003 + x*1009 + y)
    n = r.choice([60, 300, 900, 2500, 5000, 9000, 20000, 70000])
    b = bytes([0x89,0x50,0x4E,0x47]) + bytes(r.getrandbits(8) for _ in range(n))
    return b
tiles=[(z,x,y) for z in range(0,6) for x in range(2**z) for y in range(2**z)]
def meta(c):
    c.execute("CREATE TABLE metadata (name text, value text)")
    c.executemany("INSERT INTO metadata VALUES (?,?)", [("name","Prueba"),("format","png"),("minzoom","0"),("maxzoom","5"),("bounds","-71,-34,-70,-33")])
def mk(name, page, ddl, insert):
    p=f"{OUT}/{name}.mbtiles"
    if os.path.exists(p): os.remove(p)
    c=sqlite3.connect(p); c.execute(f"PRAGMA page_size={page}"); meta(c)
    for d in ddl: c.execute(d)
    order=tiles[:]; random.Random(1).shuffle(order)
    insert(c, order); c.commit(); c.execute("VACUUM"); c.close()
    return p
def ins_direct(c, order):
    c.executemany("INSERT INTO tiles (zoom_level,tile_column,tile_row,tile_data) VALUES (?,?,?,?)", [(z,x,y,blob(z,x,y)) for z,x,y in order])
mk('qgis', 4096, ["CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)", "CREATE UNIQUE INDEX tile_index on tiles (zoom_level, tile_column, tile_row)"], ins_direct)
mk('pk', 65536, ['CREATE TABLE "tiles" ("zoom_level" INTEGER NOT NULL, "tile_column" INTEGER NOT NULL, "tile_row" INTEGER NOT NULL, "tile_data" BLOB, PRIMARY KEY (zoom_level, tile_column, tile_row))'], ins_direct)
mk('worowid', 2048, ["CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB, PRIMARY KEY (zoom_level, tile_column, tile_row)) WITHOUT ROWID"], ins_direct)
mk('noindex', 1024, ["CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)"], ins_direct)
def ins_mapimg(c, order, textid=True):
    for z,x,y in order:
        b=blob(z,x,y); tid=hashlib.md5(b).hexdigest() if textid else None
        if textid:
            c.execute("INSERT OR IGNORE INTO images (tile_data, tile_id) VALUES (?,?)", (b, tid))
        else:
            cur=c.execute("INSERT INTO images (tile_data) VALUES (?)", (b,)); tid=cur.lastrowid
        c.execute("INSERT INTO map (zoom_level,tile_column,tile_row,tile_id) VALUES (?,?,?,?)", (z,x,y,tid))
mk('gdal', 1024, ["CREATE TABLE map (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_id TEXT, grid_id TEXT)", "CREATE TABLE images (tile_data blob, tile_id text)", "CREATE UNIQUE INDEX map_index ON map (zoom_level, tile_column, tile_row)", "CREATE UNIQUE INDEX images_id ON images (tile_id)", "CREATE VIEW tiles AS SELECT map.zoom_level AS zoom_level, map.tile_column AS tile_column, map.tile_row AS tile_row, images.tile_data AS tile_data FROM map JOIN images ON images.tile_id = map.tile_id"], ins_mapimg)
mk('intid', 4096, ["CREATE TABLE map (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_id INTEGER)", "CREATE TABLE images (tile_id INTEGER PRIMARY KEY, tile_data BLOB)", "CREATE UNIQUE INDEX map_index ON map (zoom_level, tile_column, tile_row)", "CREATE VIEW tiles AS SELECT map.zoom_level AS zoom_level, map.tile_column AS tile_column, map.tile_row AS tile_row, images.tile_data AS tile_data FROM map JOIN images ON images.tile_id = map.tile_id"], lambda c,o: ins_mapimg(c,o,False))
for f in sorted(os.listdir(OUT)): print(f, os.path.getsize(f"{OUT}/{f}")//1024, 'KB')
