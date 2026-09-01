/**
 * In-house QR Code generator (ISO/IEC 18004) — byte mode, ECC level M, versions 1–10. No third
 * party. Deterministic. Produces a crisp SVG (scalable, no raster dependency) for the MFA otpauth
 * URI. The manual Base32 key is always offered too, so a scan is never the only path.
 *
 * Implements: GF(256) Reed–Solomon ECC, block interleaving, finder/timing/alignment patterns,
 * format & version info (BCH), the 8 data masks with penalty scoring, and module placement.
 */

// ---- GF(256) arithmetic (primitive polynomial 0x11D) ------------------------------------------
const EXP = new Array(512); const LOG = new Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i += 1) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]; })();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenPoly(degree) {
  // Build g(x) = ∏ (x - α^i) for i=0..degree-1, then return the `degree` NON-leading coefficients
  // (highest→lowest). The leading coefficient is always 1 and is implicit in the division register,
  // so it must be excluded — rsEncode consumes exactly `degree` coefficients.
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) { next[j] ^= poly[j]; next[j + 1] ^= gfMul(poly[j], EXP[i]); }
    poly = next;
  }
  return poly.slice(1);
}
function rsEncode(data, ecLen) {
  const gen = rsGenPoly(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0];
    res.shift(); res.push(0);
    if (factor !== 0) for (let j = 0; j < ecLen; j += 1) res[j] ^= gfMul(gen[j], factor);
  }
  return res;
}

// ---- Version tables for ECC level M -----------------------------------------------------------
// [dataCodewords, ecPerBlock, [ [numBlocks, dataPerBlock], ... ] ]  (ISO/IEC 18004 Annex)
const VER_M = {
  1: [16, 10, [[1, 16]]], 2: [28, 16, [[1, 28]]], 3: [44, 26, [[1, 44]]], 4: [64, 18, [[2, 32]]],
  5: [86, 24, [[2, 43]]], 6: [108, 16, [[4, 27]]], 7: [124, 18, [[4, 31]]],
  8: [154, 22, [[2, 38], [2, 39]]], 9: [182, 22, [[3, 36], [2, 37]]], 10: [216, 26, [[4, 43], [1, 44]]],
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

function chooseVersion(byteLen) {
  for (let v = 1; v <= 10; v += 1) {
    const cci = v < 10 ? 1 : 2;               // byte-mode char-count indicator: 8 bits (v1-9) / 16 (v10+)
    const overheadBits = 4 + (cci === 1 ? 8 : 16);
    const capacityBits = VER_M[v][0] * 8;
    if (overheadBits + byteLen * 8 <= capacityBits) return v;
  }
  throw new Error('otpauth data too long for supported QR versions (1–10)');
}

// ---- Bit buffer -------------------------------------------------------------------------------
function encodeData(bytes, version) {
  const [dataCodewords] = VER_M[version];
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i -= 1) bits.push((val >>> i) & 1); };
  put(0b0100, 4);                                    // byte mode
  put(bytes.length, version < 10 ? 8 : 16);          // char count
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords * 8;
  for (let i = 0; i < 4 && bits.length < cap; i += 1) bits.push(0); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j += 1) v = (v << 1) | bits[i + j]; codewords.push(v); }
  const pad = [0xec, 0x11]; let pi = 0;
  while (codewords.length < dataCodewords) { codewords.push(pad[pi % 2]); pi += 1; }
  return codewords;
}

function interleave(dataCodewords, version) {
  const [, ecLen, blockSpec] = VER_M[version];
  const blocks = [];
  let pos = 0;
  for (const [num, dataPer] of blockSpec) {
    for (let b = 0; b < num; b += 1) { const d = dataCodewords.slice(pos, pos + dataPer); pos += dataPer; blocks.push({ data: d, ec: rsEncode(d, ecLen) }); }
  }
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  const out = [];
  for (let i = 0; i < maxData; i += 1) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecLen; i += 1) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// ---- Matrix construction ----------------------------------------------------------------------
function buildMatrix(finalCodewords, version) {
  const size = 17 + version * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(null)); // null = unset
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v, res = true) => { m[r][c] = v ? 1 : 0; if (res) reserved[r][c] = true; };

  const finder = (r, c) => {
    for (let i = -1; i <= 7; i += 1) for (let j = -1; j <= 7; j += 1) {
      const rr = r + i; const cc = c + j; if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
      const inRing = i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6);
      const inCore = i >= 2 && i <= 4 && j >= 2 && j <= 4;
      set(rr, cc, inRing || inCore ? 1 : 0);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  // timing patterns
  for (let i = 8; i < size - 8; i += 1) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }
  // alignment patterns
  const centers = ALIGN[version];
  for (const r of centers) for (const c of centers) {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
    for (let i = -2; i <= 2; i += 1) for (let j = -2; j <= 2; j += 1) {
      const ring = Math.max(Math.abs(i), Math.abs(j));
      set(r + i, c + j, ring === 1 ? 0 : 1);
    }
  }
  // dark module + reserve format/version areas
  set(size - 8, 8, 1);
  for (let i = 0; i < 9; i += 1) { if (m[8][i] === null) reserved[8][i] = true; if (m[i][8] === null) reserved[i][8] = true; }
  for (let i = 0; i < 8; i += 1) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) for (let j = 0; j < 3; j += 1) { reserved[i][size - 11 + j] = true; reserved[size - 11 + j][i] = true; }
  }

  // place data (zigzag, upward/downward columns, skipping column 6)
  const bitsArr = [];
  for (const cw of finalCodewords) for (let i = 7; i >= 0; i -= 1) bitsArr.push((cw >>> i) & 1);
  let bi = 0; let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1; // skip the vertical timing column, shifting the WHOLE pair left (spec)
    for (let k = 0; k < size; k += 1) {
      const row = up ? size - 1 - k : k;
      for (let t = 0; t < 2; t += 1) {
        const cc = col - t;
        if (m[row][cc] === null && !reserved[row][cc]) { m[row][cc] = bi < bitsArr.length ? bitsArr[bi] : 0; bi += 1; }
      }
    }
    up = !up;
  }
  return { m, reserved, size };
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(base, maskFn) {
  const { m, reserved, size } = base;
  const out = m.map((row) => row.slice());
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (!reserved[r][c] && out[r][c] !== null && maskFn(r, c)) out[r][c] ^= 1;
  return out;
}
function penalty(m, size) {
  let p = 0;
  // rule 1: runs ≥5
  for (let r = 0; r < size; r += 1) for (let dir = 0; dir < 2; dir += 1) {
    let run = 1; let prev = -1;
    for (let c = 0; c < size; c += 1) { const v = dir === 0 ? m[r][c] : m[c][r]; if (v === prev) { run += 1; if (run === 5) p += 3; else if (run > 5) p += 1; } else { run = 1; prev = v; } }
  }
  // rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r += 1) for (let c = 0; c < size - 1; c += 1) { const v = m[r][c]; if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3; }
  // rule 3: finder-like pattern 10111010000 / reverse
  const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const match = (arr, i) => pat.every((x, k) => arr[i + k] === x) || pat.every((x, k) => arr[i + k] === pat[10 - k]);
  for (let r = 0; r < size; r += 1) { const row = m[r]; const col = m.map((x) => x[r]); for (let i = 0; i + 11 <= size; i += 1) { if (match(row, i)) p += 40; if (match(col, i)) p += 40; } }
  // rule 4: dark proportion
  let dark = 0; for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (m[r][c]) dark += 1;
  const ratio = (dark / (size * size)) * 100;
  p += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return p;
}

// BCH for format info (15-bit) and version info (18-bit)
function bch(data, poly, deg) { let d = data << deg; while (Math.floor(Math.log2(d)) >= deg) d ^= poly << (Math.floor(Math.log2(d)) - Math.floor(Math.log2(poly))); return (data << deg) | d; }
function formatBits(maskIdx) {
  const ecLevelM = 0b00; // level M
  const data = (ecLevelM << 3) | maskIdx;
  const bits = bch(data, 0b10100110111, 10) ^ 0b101010000010010;
  return bits;
}
function versionBits(version) { return bch(version, 0b1111100100101, 12); }

function placeFormatAndVersion(m, size, version, maskIdx) {
  const fmt = formatBits(maskIdx); // 15-bit value
  const bitOf = (n, i) => (n >>> i) & 1;
  // Format info is placed MSB-first: the first module in read order carries bit 14, the last bit 0.
  // (Verified against a reference encoder — placing LSB-first corrupts the format and makes the
  // whole symbol unreadable, since format info only tolerates 3 bit-errors.)
  const fb = (readIdx) => bitOf(fmt, 14 - readIdx);
  // Copy 1 (around the top-left finder): read positions 0-5 along row 8, 6→(8,7), 7→(8,8), 8→(7,8),
  // 9-14 up column 8.
  for (let i = 0; i <= 5; i += 1) m[8][i] = fb(i);
  m[8][7] = fb(6); m[8][8] = fb(7); m[7][8] = fb(8);
  for (let i = 9; i <= 14; i += 1) m[14 - i][8] = fb(i); // i=9→row5 … i=14→row0
  // Copy 2: read positions 0-6 down column 8 (rows size-1 … size-7), 7-14 along row 8 (cols size-8 …
  // size-1). The dark module at (size-8,8) is a function pattern, set separately — never touched here.
  for (let i = 0; i <= 6; i += 1) m[size - 1 - i][8] = fb(i);
  for (let i = 7; i <= 14; i += 1) m[8][size - 8 + (i - 7)] = fb(i);
  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i += 1) { const r = Math.floor(i / 3); const c = i % 3; m[r][size - 11 + c] = bitOf(vb, i); m[size - 11 + c][r] = bitOf(vb, i); }
  }
}

/** Generate the QR matrix (2D array of 0/1) for a string (byte mode). */
export function qrMatrix(text) {
  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  const version = chooseVersion(bytes.length);
  const codewords = encodeData(bytes, version);
  const finalCw = interleave(codewords, version);
  const base = buildMatrix(finalCw, version);
  let best = null;
  for (let mi = 0; mi < 8; mi += 1) {
    const masked = applyMask(base, MASKS[mi]);
    placeFormatAndVersion(masked, base.size, version, mi);
    const pen = penalty(masked, base.size);
    if (!best || pen < best.pen) best = { masked, pen, mi };
  }
  return best.masked;
}

/** Render the QR for `text` as a self-contained SVG string. */
export function qrSvg(text, { scale = 6, margin = 4, dark = '#0b1220', light = '#ffffff' } = {}) {
  const m = qrMatrix(text);
  const size = m.length;
  const dim = (size + margin * 2) * scale;
  let rects = '';
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (m[r][c]) rects += `<rect x="${(c + margin) * scale}" y="${(r + margin) * scale}" width="${scale}" height="${scale}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="${light}"/><g fill="${dark}">${rects}</g></svg>`;
}

/** QR as a data: URI (embeddable directly in an <img src>). */
export function qrDataUri(text, opts) { return `data:image/svg+xml;base64,${Buffer.from(qrSvg(text, opts)).toString('base64')}`; }
