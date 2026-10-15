/* GeoCampo — conversiones geográficas y de orientación.
   Equivalente a lib/geo/utm.dart y lib/geo/orientation.dart de la app Flutter. */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ UTM
  const K0 = 0.9996;
  const A = 6378137.0;
  const F = 1 / 298.257223563;
  const E = F * (2 - F);
  const E2 = E * E;
  const E3 = E2 * E;
  const EP2 = E / (1 - E);
  const M1 = 1 - E / 4 - 3 * E2 / 64 - 5 * E3 / 256;
  const M2 = 3 * E / 8 + 3 * E2 / 32 + 45 * E3 / 1024;
  const M3 = 15 * E2 / 256 + 45 * E3 / 1024;
  const M4 = 35 * E3 / 3072;
  const SQRT_E = Math.sqrt(1 - E);
  const N1 = (1 - SQRT_E) / (1 + SQRT_E);
  const N2 = N1 * N1, N3 = N2 * N1, N4 = N3 * N1, N5 = N4 * N1;
  const P2 = 3 / 2 * N1 - 27 / 32 * N3 + 269 / 512 * N5;
  const P3 = 21 / 16 * N2 - 55 / 32 * N4;
  const P4 = 151 / 96 * N3 - 417 / 128 * N5;
  const P5 = 1097 / 512 * N4;
  const BANDS = 'CDEFGHJKLMNPQRSTUVWXX';

  const rad = (d) => d * Math.PI / 180;
  const deg = (r) => r * 180 / Math.PI;
  const mod = (a, n) => ((a % n) + n) % n;
  const modAngle = (v) => mod(v + Math.PI, 2 * Math.PI) - Math.PI;

  function zoneNumber(lat, lon) {
    if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) return 32;
    if (lat >= 72 && lat <= 84 && lon >= 0) {
      if (lon < 9) return 31;
      if (lon < 21) return 33;
      if (lon < 33) return 35;
      if (lon < 42) return 37;
    }
    return mod(Math.floor((lon + 180) / 6), 60) + 1;
  }

  function bandLetter(lat) {
    if (lat < -80 || lat > 84) return '-';
    const i = Math.floor((lat + 80) / 8);
    return BANDS[Math.min(i, BANDS.length - 1)];
  }

  const centralMeridian = (zone) => (zone - 1) * 6 - 180 + 3;

  function fromLatLon(lat, lon, forceZone) {
    const zone = forceZone || zoneNumber(lat, lon);
    const latRad = rad(lat);
    const s = Math.sin(latRad), c0 = Math.cos(latRad);
    const t = s / c0, t2 = t * t, t4 = t2 * t2;
    const n = A / Math.sqrt(1 - E * s * s);
    const c = EP2 * c0 * c0;
    const a = c0 * modAngle(rad(lon) - rad(centralMeridian(zone)));
    const a2 = a * a, a3 = a2 * a, a4 = a3 * a, a5 = a4 * a, a6 = a5 * a;
    const m = A * (M1 * latRad - M2 * Math.sin(2 * latRad) + M3 * Math.sin(4 * latRad) - M4 * Math.sin(6 * latRad));
    const easting = K0 * n * (a + a3 / 6 * (1 - t2 + c) + a5 / 120 * (5 - 18 * t2 + t4 + 72 * c - 58 * EP2)) + 500000;
    let northing = K0 * (m + n * t * (a2 / 2 + a4 / 24 * (5 - t2 + 9 * c + 4 * c * c) + a6 / 720 * (61 - 58 * t2 + t4 + 600 * c - 330 * EP2)));
    if (lat < 0) northing += 10000000;
    return { zone, band: bandLetter(lat), north: lat >= 0, easting, northing };
  }

  function toLatLon(easting, northing, zone, north) {
    const x = easting - 500000;
    let y = northing;
    if (!north) y -= 10000000;
    const mu = y / K0 / (A * M1);
    const p = mu + P2 * Math.sin(2 * mu) + P3 * Math.sin(4 * mu) + P4 * Math.sin(6 * mu) + P5 * Math.sin(8 * mu);
    const ps = Math.sin(p), pc = Math.cos(p);
    const pt = ps / pc, pt2 = pt * pt, pt4 = pt2 * pt2;
    const eps = 1 - E * ps * ps;
    const n = A / Math.sqrt(eps);
    const r = (1 - E) / eps;
    const c = EP2 * pc * pc, c2 = c * c;
    const d = x / (n * K0);
    const d2 = d * d, d3 = d2 * d, d4 = d3 * d, d5 = d4 * d, d6 = d5 * d;
    const lat = p - (pt / r) * (d2 / 2 - d4 / 24 * (5 + 3 * pt2 + 10 * c - 4 * c2 - 9 * EP2)
      + d6 / 720 * (61 + 90 * pt2 + 298 * c + 45 * pt4 - 252 * EP2 - 3 * c2));
    let lon = (d - d3 / 6 * (1 + 2 * pt2 + c) + d5 / 120 * (5 - 2 * c + 28 * pt2 - 3 * c2 + 8 * EP2 + 24 * pt4)) / pc;
    lon = modAngle(lon + rad(centralMeridian(zone)));
    return [deg(lat), deg(lon)];
  }

  const fmtUtm = (u) => `${u.zone}${u.band} ${Math.round(u.easting)} E ${Math.round(u.northing)} N`;

  const Utm = { zoneNumber, bandLetter, centralMeridian, fromLatLon, toLatLon, format: fmtUtm };

  // ------------------------------------------------------------ Orientación
  class OrientationError extends Error {}

  const normAz = (a) => { const r = mod(a, 360); return r >= 360 ? 0 : r; };
  const clean = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');

  function parseNumber(s) {
    const t = String(s).trim().replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(t)) throw new OrientationError(`"${s}" no es un número`);
    return parseFloat(t);
  }

  const QUAD_RE = /^([NS])(\d+(?:[.,]\d+)?)[°º]?([EWO])$/;
  const DIP_RE = /^(\d+(?:[.,]\d+)?)[°º]?([NSEWO]{0,3})$/;
  const NUM_RE = /^\d+(?:[.,]\d+)?[°º]?$/;
  const LETTER = { N: [0, 1], S: [0, -1], E: [1, 0], W: [-1, 0], O: [-1, 0] };

  function parseBearing(input) {
    const t = clean(input);
    if (!t) throw new OrientationError('Falta el valor');
    if (['NS', 'N-S', 'SN', 'S-N'].includes(t)) return 0;
    if (['EW', 'E-W', 'WE', 'W-E', 'EO', 'E-O', 'OE', 'O-E'].includes(t)) return 90;
    const single = { N: 0, E: 90, S: 180, W: 270, O: 270 };
    if (t in single) return single[t];
    const m = QUAD_RE.exec(t);
    if (m) {
      const a = parseNumber(m[2]);
      if (a > 90) throw new OrientationError('En cuadrante el ángulo va de 0 a 90 (ej. N30E)');
      const n = m[1] === 'N', e = m[3] === 'E';
      if (n && e) return normAz(a);
      if (n) return normAz(360 - a);
      if (e) return normAz(180 - a);
      return normAz(180 + a);
    }
    if (NUM_RE.test(t)) {
      const v = parseNumber(t.replace(/[°º]/g, ''));
      if (v < 0 || v > 360) throw new OrientationError('El azimut va de 0 a 360');
      return normAz(v);
    }
    throw new OrientationError('Formato no reconocido: usa azimut (030) o cuadrante (N30E)');
  }

  function parseDip(input) {
    const t = clean(input);
    if (!t) throw new OrientationError('Falta el manteo');
    const m = DIP_RE.exec(t);
    if (!m) throw new OrientationError('Manteo no válido: usa 45 o 45SE');
    const d = parseNumber(m[1]);
    if (d < 0 || d > 90) throw new OrientationError('El manteo va de 0 a 90');
    return [d, m[2] || ''];
  }

  function letterVec(letters) {
    let vx = 0, vy = 0;
    for (const ch of letters) {
      const v = LETTER[ch];
      if (!v) return null;
      vx += v[0]; vy += v[1];
    }
    const l = Math.hypot(vx, vy);
    return l < 1e-9 ? null : [vx / l, vy / l];
  }

  const dot = (az, v) => Math.sin(rad(az)) * v[0] + Math.cos(rad(az)) * v[1];

  function planeFromStrike(strikeIn, dipIn) {
    const strike = parseBearing(strikeIn);
    const [dip, letters] = parseDip(dipIn);
    if (!letters) return { dipDirection: normAz(strike + 90), dip, warning: null };
    const v = letterVec(letters);
    if (!v) throw new OrientationError('Sentido de manteo no válido');
    const c1 = normAz(strike + 90);
    const d = dot(c1, v);
    if (Math.abs(d) < 0.05) throw new OrientationError('El sentido de manteo es paralelo al rumbo: revisa (ej. N30E/45SE)');
    return {
      dipDirection: d > 0 ? c1 : normAz(strike - 90),
      dip,
      warning: Math.abs(d) < 0.5 ? 'Sentido de manteo poco coherente con el rumbo' : null,
    };
  }

  function planeFromDipDirection(ddIn, dipIn) {
    const dd = parseBearing(ddIn);
    const [dip, letters] = parseDip(dipIn);
    let warning = null;
    if (letters) {
      const v = letterVec(letters);
      if (v && dot(dd, v) < 0) warning = 'El sentido escrito no coincide con la dirección de manteo';
    }
    return { dipDirection: dd, dip, warning };
  }

  function line(trendIn, plungeIn) {
    const trend = parseBearing(trendIn);
    const [plunge, letters] = parseDip(plungeIn);
    let warning = null;
    if (letters) {
      const v = letterVec(letters);
      if (v && dot(trend, v) < 0) warning = 'El sentido escrito no coincide con el trend';
    }
    return { trend, plunge, warning };
  }

  const strikeRhr = (dd) => normAz(dd - 90);

  function quadrantStrike(az) {
    let a = normAz(az);
    if (a > 90 && a <= 270) a = normAz(a + 180);
    return a <= 90 ? `N${Math.round(a)}E` : `N${Math.round(360 - a)}W`;
  }

  function quadrantBearing(az) {
    const a = normAz(az);
    if (a <= 90) return `N${Math.round(a)}E`;
    if (a <= 180) return `S${Math.round(180 - a)}E`;
    if (a <= 270) return `S${Math.round(a - 180)}W`;
    return `N${Math.round(360 - a)}W`;
  }

  const NAMES8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const compass8 = (az) => NAMES8[mod(Math.floor(normAz(az) / 45 + 0.5), 8)];
  const fmtAz = (az) => String(mod(Math.round(az), 360)).padStart(3, '0');
  const fmtDip = (d) => String(Math.round(d)).padStart(2, '0');
  const planeShort = (dd, dip) => `${fmtAz(dd)}/${fmtDip(dip)}`;
  const planeQuadrant = (dd, dip) => `${quadrantStrike(strikeRhr(dd))}/${Math.round(dip)}${compass8(dd)}`;
  const lineShort = (tr, pl) => `${fmtAz(tr)}→${fmtDip(pl)}`;
  const lineQuadrant = (tr, pl) => `${quadrantBearing(tr)}/${Math.round(pl)}`;

  const GeoOrient = {
    OrientationError, normAz, parseBearing, parseDip, planeFromStrike, planeFromDipDirection, line,
    strikeRhr, quadrantStrike, quadrantBearing, compass8, fmtAz, fmtDip, planeShort, planeQuadrant,
    lineShort, lineQuadrant,
  };

  root.Utm = Utm;
  root.GeoOrient = GeoOrient;
  if (typeof module !== 'undefined' && module.exports) module.exports = { Utm, GeoOrient };
})(typeof window !== 'undefined' ? window : globalThis);
