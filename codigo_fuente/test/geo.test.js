const assert = require('assert');
const { Utm, GeoOrient: G } = require('../src/geo.js');
const ref = require('./utm_ref.json');
let maxF = 0, maxI = 0;
for (const [lat, lon, z, e, n] of ref) {
  const u = Utm.fromLatLon(lat, lon);
  assert.strictEqual(u.zone, z);
  maxF = Math.max(maxF, Math.abs(u.easting - e), Math.abs(u.northing - n));
  const [la, lo] = Utm.toLatLon(e, n, z, lat >= 0);
  maxI = Math.max(maxI, Math.abs(la - lat) * 111000, Math.abs(lo - lon) * 111000 * Math.cos(lat * Math.PI / 180));
}
console.log('UTM forward max err m', maxF.toFixed(4), 'inverse max err m', maxI.toFixed(4));
assert(maxF < 0.01);
const cases = [['N30E','45SE',120],['N30E','45NW',300],['N30W','60SW',240],['N30O','60NE',60],['30','45',120],['210','45',300],['S45W','20NW',315],['NS','80E',90],['EW','10S',180],['N 30 E','45 SE',120],['n30e','45se',120],['N30°E','45°SE',120],['30,5','45',120.5]];
for (const [s, d, exp] of cases) assert(Math.abs(G.planeFromStrike(s, d).dipDirection - exp) < 1e-9, s + '/' + d);
assert.throws(() => G.planeFromStrike('NS', '45N'));
assert(G.planeFromStrike('N30E', '45NE').warning);
for (const [s,d] of [['N95E','45SE'],['400','45'],['N30E','95SE'],['ABC','4'],['E30N','45']]) assert.throws(() => G.planeFromStrike(s, d), G.OrientationError);
assert.strictEqual(G.planeQuadrant(120, 45), 'N30E/45SE');
assert.strictEqual(G.planeQuadrant(300, 45), 'N30E/45NW');
assert.strictEqual(G.planeQuadrant(0, 30), 'N90E/30N');
assert.strictEqual(G.quadrantBearing(210), 'S30W');
assert.strictEqual(G.planeShort(120, 5), '120/05');
assert.strictEqual(G.lineShort(359.6, 30), '000→30');
assert(Math.abs(G.line('S30W', '30').trend - 210) < 1e-9);
assert.strictEqual(G.planeFromDipDirection('120', '45NW').warning !== null, true);
console.log('geo tests OK');
