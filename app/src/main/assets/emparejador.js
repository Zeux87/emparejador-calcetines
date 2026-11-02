/*
 * emparejador.js — Detecta los calcetines de una foto y busca sus parejas.
 *
 * Funciona en el navegador/WebView (window.Emparejador) y en Node
 * (module.exports) para el banco de pruebas de herramientas/.
 *
 * Pasos:
 *   1. Segmentación: modela el color del fondo (con su iluminación desigual)
 *      y separa lo que no es fondo; intenta partir calcetines que se tocan.
 *   2. Huella de cada calcetín: colores dominantes, histograma de color,
 *      textura (LBP), rayas a lo largo de la pierna (espectro), variación
 *      interna de color y tamaño.
 *   3. Distancias entre todos, normalizadas por la mediana de la foto, y
 *      emparejamiento de suma máxima; los que no tienen pareja parecida
 *      quedan como huérfanos.
 */
(function (global) {
  'use strict';

  const MAX_LADO = 1600;
  const PESOS = { colorDominante: 0.30, histograma: 0.15, textura: 0.15, rayas: 0.15, variacion: 0.10, tamano: 0.15 };
  const SUELOS = { colorDominante: 4.0, histograma: 0.05, textura: 0.02, rayas: 0.5, variacion: 1.5, tamano: 0.08 };
  const CLAVES = Object.keys(PESOS);
  const INF = 1e20;

  /* ------------------------------------------------------------ utilidades */

  function aleatorio(semilla) { // mulberry32: determinista para que el resultado sea repetible
    let a = semilla >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function mediana(v) {
    if (!v.length) return 0;
    const s = Float64Array.from(v).sort();
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }

  function resolver(M, b) { // Gauss con pivote parcial (sistemas pequeños)
    const n = b.length;
    const A = M.map((fila, i) => fila.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let f = c + 1; f < n; f++) if (Math.abs(A[f][c]) > Math.abs(A[p][c])) p = f;
      [A[c], A[p]] = [A[p], A[c]];
      const piv = A[c][c] || 1e-12;
      for (let f = 0; f < n; f++) {
        if (f === c) continue;
        const k = A[f][c] / piv;
        if (k) for (let j = c; j <= n; j++) A[f][j] -= k * A[c][j];
      }
    }
    return A.map((fila, i) => fila[n] / (fila[i] || 1e-12));
  }

  function suavizar1d(v, sigma) { // gaussiana con bordes en espejo
    const r = Math.round(sigma * 4), n = v.length;
    const k = [];
    let s = 0;
    for (let i = -r; i <= r; i++) { const e = Math.exp(-0.5 * (i / sigma) ** 2); k.push(e); s += e; }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (let j = -r; j <= r; j++) {
        let q = i + j;
        while (q < 0 || q >= n) q = q < 0 ? -q : 2 * (n - 1) - q;
        acc += v[q] * k[j + r];
      }
      out[i] = acc / s;
    }
    return out;
  }

  /* ------------------------------------------------------------ color */

  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function fLab(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }

  function aLab(rgba, n) {
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n), G = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r8 = rgba[j], g8 = rgba[j + 1], b8 = rgba[j + 2];
      const r = LIN[r8], g = LIN[g8], b = LIN[b8];
      const fx = fLab((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
      const fy = fLab(0.2126729 * r + 0.7151522 * g + 0.0721750 * b);
      const fz = fLab((0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883);
      L[i] = 116 * fy - 16;
      A[i] = 500 * (fx - fy);
      B[i] = 200 * (fy - fz);
      G[i] = 0.299 * r8 + 0.587 * g8 + 0.114 * b8;
    }
    return { L, A, B, G };
  }

  /* ------------------------------------------------------------ filtros */

  function cajaH(s, d, w, h, r) {
    const inv = 1 / (2 * r + 1);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += s[o + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) {
        d[o + x] = acc * inv;
        acc += s[o + Math.min(w - 1, x + r + 1)] - s[o + Math.max(0, x - r)];
      }
    }
  }

  function cajaV(s, d, w, h, r) {
    const inv = 1 / (2 * r + 1);
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += s[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) {
        d[y * w + x] = acc * inv;
        acc += s[Math.min(h - 1, y + r + 1) * w + x] - s[Math.max(0, y - r) * w + x];
      }
    }
  }

  function desenfocar(src, w, h, r) { // 3 pasadas de caja ≈ gaussiana
    const a = Float32Array.from(src);
    if (r < 1) return a;
    const b = new Float32Array(src.length);
    for (let p = 0; p < 3; p++) { cajaH(a, b, w, h, r); cajaV(b, a, w, h, r); }
    return a;
  }

  // Transformada de distancia euclídea exacta (Felzenszwalb), devuelve distancias al cuadrado
  function edt1d(f, n, d, v, z) {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      d[q] = dq * dq + f[v[k]];
    }
  }

  // Distancia (al cuadrado) de cada píxel al píxel más cercano con mascara == objetivo
  function edt(m, w, h, objetivo) {
    const n = w * h, out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = m[i] === objetivo ? 0 : INF;
    const lado = Math.max(w, h);
    const f = new Float64Array(lado), d = new Float64Array(lado), v = new Int32Array(lado), z = new Float64Array(lado + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = out[y * w + x];
      edt1d(f, h, d, v, z);
      for (let y = 0; y < h; y++) out[y * w + x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) f[x] = out[o + x];
      edt1d(f, w, d, v, z);
      for (let x = 0; x < w; x++) out[o + x] = d[x];
    }
    return out;
  }

  function dilatar(m, w, h, r) {
    const d = edt(m, w, h, 1), o = new Uint8Array(w * h), r2 = r * r;
    for (let i = 0; i < o.length; i++) o[i] = d[i] <= r2 ? 1 : 0;
    return o;
  }

  function erosionar(m, w, h, r) {
    const d = edt(m, w, h, 0), o = new Uint8Array(w * h), r2 = r * r;
    for (let i = 0; i < o.length; i++) o[i] = m[i] && d[i] > r2 ? 1 : 0;
    return o;
  }

  function rellenarAgujeros(m, w, h) {
    const n = w * h, vis = new Uint8Array(n), pila = new Int32Array(n);
    let sp = 0;
    const meter = (i) => { if (!m[i] && !vis[i]) { vis[i] = 1; pila[sp++] = i; } };
    for (let x = 0; x < w; x++) { meter(x); meter((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { meter(y * w); meter(y * w + w - 1); }
    while (sp) {
      const p = pila[--sp], x = p % w, y = (p / w) | 0;
      if (x > 0) meter(p - 1);
      if (x < w - 1) meter(p + 1);
      if (y > 0) meter(p - w);
      if (y < h - 1) meter(p + w);
    }
    const o = new Uint8Array(n);
    for (let i = 0; i < n; i++) o[i] = m[i] || !vis[i] ? 1 : 0;
    return o;
  }

  // Componentes conexas (8 vecinos). Devuelve listas de píxeles y caja.
  function etiquetar(m, w, h) {
    const n = w * h, et = new Int32Array(n), pila = new Int32Array(n), comps = [];
    let id = 0;
    for (let i = 0; i < n; i++) {
      if (!m[i] || et[i]) continue;
      id++;
      let sp = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
      const pix = [];
      pila[sp++] = i; et[i] = id;
      while (sp) {
        const p = pila[--sp], x = p % w, y = (p / w) | 0;
        pix.push(p);
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (m[q] && !et[q]) { et[q] = id; pila[sp++] = q; }
          }
        }
      }
      comps.push({ pix: Int32Array.from(pix), x0, y0, x1, y1 });
    }
    return comps;
  }

  /* ------------------------------------------------------------ 1. segmentación */

  function ajustarFondo(canales, fondoM, w, h, rnd) {
    let total = 0;
    for (let i = 0; i < fondoM.length; i++) total += fondoM[i];
    const p = Math.min(1, 30000 / Math.max(1, total));
    const AtA = Array.from({ length: 6 }, () => new Array(6).fill(0));
    const Atb = canales.map(() => new Array(6).fill(0));
    const fi = new Array(6);
    for (let i = 0; i < fondoM.length; i++) {
      if (!fondoM[i] || (p < 1 && rnd() > p)) continue;
      const xn = (i % w) / w, yn = ((i / w) | 0) / h;
      fi[0] = 1; fi[1] = xn; fi[2] = yn; fi[3] = xn * xn; fi[4] = xn * yn; fi[5] = yn * yn;
      for (let a = 0; a < 6; a++) {
        for (let b = 0; b < 6; b++) AtA[a][b] += fi[a] * fi[b];
        for (let c = 0; c < canales.length; c++) Atb[c][a] += fi[a] * canales[c][i];
      }
    }
    for (let a = 0; a < 6; a++) AtA[a][a] += 1e-6;
    return Atb.map((b) => resolver(AtA, b));
  }

  function segmentar(lab, w, h) {
    const n = w * h, rnd = aleatorio(1);
    const Ls = desenfocar(lab.L, w, h, 2), As = desenfocar(lab.A, w, h, 2), Bs = desenfocar(lab.B, w, h, 2);
    const borde = Math.max(5, Math.floor(0.02 * Math.min(w, h)));
    let fondoM = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < borde || x >= w - borde || y < borde || y >= h - borde) fondoM[y * w + x] = 1;
      }
    }
    const dist = new Float32Array(n);
    let obj = null, umbral = 0;
    for (let it = 0; it < 3; it++) {
      const [cL, cA, cB] = ajustarFondo([Ls, As, Bs], fondoM, w, h, rnd);
      for (let y = 0; y < h; y++) {
        const yn = y / h;
        for (let x = 0; x < w; x++) {
          const xn = x / w, i = y * w + x;
          const b1 = xn, b2 = yn, b3 = xn * xn, b4 = xn * yn, b5 = yn * yn;
          const dL = (Ls[i] - (cL[0] + cL[1] * b1 + cL[2] * b2 + cL[3] * b3 + cL[4] * b4 + cL[5] * b5)) * 0.6;
          const dA = As[i] - (cA[0] + cA[1] * b1 + cA[2] * b2 + cA[3] * b3 + cA[4] * b4 + cA[5] * b5);
          const dB = Bs[i] - (cB[0] + cB[1] * b1 + cB[2] * b2 + cB[3] * b3 + cB[4] * b4 + cB[5] * b5);
          dist[i] = Math.sqrt(dL * dL + dA * dA + dB * dB);
        }
      }
      // umbral según el "ruido" del fondo: mediana + 8 desviaciones robustas
      let total = 0;
      for (let i = 0; i < n; i++) total += fondoM[i];
      const p = Math.min(1, 60000 / Math.max(1, total));
      const muestra = [];
      for (let i = 0; i < n; i++) if (fondoM[i] && (p >= 1 || rnd() < p)) muestra.push(dist[i]);
      const med = mediana(muestra);
      const mad = mediana(muestra.map((v) => Math.abs(v - med))) * 1.4826;
      umbral = Math.min(15, Math.max(5, med + 8 * mad));
      obj = new Uint8Array(n);
      for (let i = 0; i < n; i++) obj[i] = dist[i] > umbral ? 1 : 0;
      const dil = dilatar(obj, w, h, 7);
      fondoM = new Uint8Array(n);
      for (let i = 0; i < n; i++) fondoM[i] = dil[i] ? 0 : 1;
    }
    obj = erosionar(dilatar(obj, w, h, 2), w, h, 2); // cierre pequeño
    obj = dilatar(erosionar(obj, w, h, 3), w, h, 3); // apertura
    obj = rellenarAgujeros(obj, w, h);

    let comps = separarPegados(etiquetar(obj, w, h), w, h);
    const minimo0 = 0.0015 * w * h;
    const grandes = comps.filter((c) => c.pix.length > minimo0).map((c) => c.pix.length);
    const minimo = Math.max(minimo0, grandes.length ? 0.25 * mediana(grandes) : 0);
    comps = comps.filter((c) => c.pix.length >= minimo);
    return { comps, umbral, mascara: obj };
  }

  function recorteLocal(c, W, margen) {
    const bx0 = c.x0 - margen, by0 = c.y0 - margen;
    const bw = c.x1 - c.x0 + 1 + 2 * margen, bh = c.y1 - c.y0 + 1 + 2 * margen;
    const m = new Uint8Array(bw * bh);
    for (let k = 0; k < c.pix.length; k++) {
      const p = c.pix[k], x = p % W, y = (p / W) | 0;
      m[(y - by0) * bw + (x - bx0)] = 1;
    }
    return { m, bx0, by0, bw, bh };
  }

  // Si una mancha es mucho mayor que la típica, se "adelgaza" hasta que se parte
  // en núcleos y desde ellos se reparte la mancha (crecimiento geodésico).
  function separarPegados(comps, W, H) {
    const minA = 0.0015 * W * H;
    const validas = comps.filter((c) => c.pix.length > minA).map((c) => c.pix.length);
    if (validas.length < 3) return comps;
    const tipica = mediana(validas);
    const res = [];
    for (const c of comps) {
      const partes = c.pix.length >= 1.5 * tipica ? partir(c, tipica, W) : null;
      if (partes) res.push(...partes);
      else res.push(c);
    }
    return res;
  }

  function partir(c, tipica, W) {
    const { m, bx0, by0, bw, bh } = recorteLocal(c, W, 1);
    const d = edt(m, bw, bh, 0);
    let max = 0;
    for (let i = 0; i < d.length; i++) if (m[i] && d[i] > max) max = d[i];
    const dmax = Math.sqrt(max);
    for (const frac of [0.3, 0.4, 0.5, 0.6]) {
      const t = (frac * dmax) ** 2;
      const nucleo = new Uint8Array(bw * bh);
      for (let i = 0; i < nucleo.length; i++) nucleo[i] = m[i] && d[i] > t ? 1 : 0;
      const trozos = etiquetar(nucleo, bw, bh).filter((q) => q.pix.length > 0.08 * tipica * (1 - frac));
      if (trozos.length < 2) continue;
      const asig = new Int32Array(bw * bh), cola = new Int32Array(bw * bh);
      let ini = 0, fin = 0;
      trozos.forEach((q, k) => { for (const p of q.pix) { asig[p] = k + 1; cola[fin++] = p; } });
      while (ini < fin) {
        const p = cola[ini++], x = p % bw, y = (p / bw) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= bw || yy >= bh) continue;
            const q = yy * bw + xx;
            if (m[q] && !asig[q]) { asig[q] = asig[p]; cola[fin++] = q; }
          }
        }
      }
      const partes = trozos.map(() => ({ pix: [], x0: Infinity, y0: Infinity, x1: -1, y1: -1 }));
      for (let i = 0; i < asig.length; i++) {
        if (!asig[i]) continue;
        const pt = partes[asig[i] - 1], x = (i % bw) + bx0, y = ((i / bw) | 0) + by0;
        pt.pix.push(y * W + x);
        if (x < pt.x0) pt.x0 = x; if (x > pt.x1) pt.x1 = x;
        if (y < pt.y0) pt.y0 = y; if (y > pt.y1) pt.y1 = y;
      }
      return partes.filter((pt) => pt.pix.length).map((pt) => ({ ...pt, pix: Int32Array.from(pt.pix) }));
    }
    return null;
  }

  /* ------------------------------------------------------------ 2. huella */

  function kmeans3(L, A, B, ids, rnd) {
    const n = Math.min(4000, ids.length);
    const copia = Int32Array.from(ids);
    for (let i = 0; i < n; i++) { // Fisher-Yates parcial
      const j = i + Math.floor(rnd() * (copia.length - i));
      const t = copia[i]; copia[i] = copia[j]; copia[j] = t;
    }
    const P = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) { const q = copia[i]; P[3 * i] = L[q]; P[3 * i + 1] = A[q]; P[3 * i + 2] = B[q]; }
    const d2 = (i, c, k) => (P[3 * i] - c[3 * k]) ** 2 + (P[3 * i + 1] - c[3 * k + 1]) ** 2 + (P[3 * i + 2] - c[3 * k + 2]) ** 2;
    const K = 3;
    let mejor = null;
    for (let intento = 0; intento < 3; intento++) {
      const C = new Float64Array(K * 3);
      let primero = Math.floor(rnd() * n);
      C.set([P[3 * primero], P[3 * primero + 1], P[3 * primero + 2]], 0);
      const dmin = new Float64Array(n).fill(Infinity);
      for (let k = 1; k < K; k++) { // k-means++
        let s = 0;
        for (let i = 0; i < n; i++) { dmin[i] = Math.min(dmin[i], d2(i, C, k - 1)); s += dmin[i]; }
        let r = rnd() * s, elegido = n - 1;
        for (let i = 0; i < n; i++) { r -= dmin[i]; if (r <= 0) { elegido = i; break; } }
        C.set([P[3 * elegido], P[3 * elegido + 1], P[3 * elegido + 2]], 3 * k);
      }
      const et = new Int32Array(n);
      let compacidad = 0;
      for (let it = 0; it < 30; it++) {
        compacidad = 0;
        for (let i = 0; i < n; i++) {
          let bk = 0, bd = Infinity;
          for (let k = 0; k < K; k++) { const dd = d2(i, C, k); if (dd < bd) { bd = dd; bk = k; } }
          et[i] = bk; compacidad += bd;
        }
        const S = new Float64Array(K * 3), cnt = new Float64Array(K);
        for (let i = 0; i < n; i++) {
          const k = et[i];
          cnt[k]++; S[3 * k] += P[3 * i]; S[3 * k + 1] += P[3 * i + 1]; S[3 * k + 2] += P[3 * i + 2];
        }
        let mov = 0;
        for (let k = 0; k < K; k++) {
          if (!cnt[k]) continue;
          for (let c = 0; c < 3; c++) {
            const nv = S[3 * k + c] / cnt[k];
            mov = Math.max(mov, Math.abs(nv - C[3 * k + c]));
            C[3 * k + c] = nv;
          }
        }
        if (mov < 0.5) break;
      }
      if (!mejor || compacidad < mejor.compacidad) {
        const cnt = new Float64Array(K);
        for (let i = 0; i < n; i++) cnt[et[i]]++;
        mejor = { compacidad, firma: [] };
        for (let k = 0; k < K; k++) {
          if (cnt[k]) mejor.firma.push({ w: cnt[k] / n, L: C[3 * k], a: C[3 * k + 1], b: C[3 * k + 2] });
        }
      }
    }
    return mejor.firma;
  }

  function emd(f1, f2) { // transporte voraz entre las dos firmas de color (aprox. EMD)
    const pares = [];
    for (let i = 0; i < f1.length; i++) {
      for (let j = 0; j < f2.length; j++) {
        pares.push([i, j, Math.hypot(f1[i].L - f2[j].L, f1[i].a - f2[j].a, f1[i].b - f2[j].b)]);
      }
    }
    pares.sort((p, q) => p[2] - q[2]);
    const s = f1.map((c) => c.w), d = f2.map((c) => c.w);
    let coste = 0, flujo = 0;
    for (const [i, j, c] of pares) {
      const q = Math.min(s[i], d[j]);
      if (q > 0) { coste += q * c; flujo += q; s[i] -= q; d[j] -= q; }
    }
    return flujo > 0 ? coste / flujo : 0;
  }

  function bilineal(img, w, h, x, y) {
    if (x < 0) x = 0; if (y < 0) y = 0;
    if (x > w - 1.001) x = w - 1.001; if (y > h - 1.001) y = h - 1.001;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return img[i] * (1 - fx) * (1 - fy) + img[i + 1] * fx * (1 - fy) + img[i + w] * (1 - fx) * fy + img[i + w + 1] * fx * fy;
  }

  function huella(c, lab, W, H, rnd) {
    const margen = 6;
    const { m, bx0, by0, bw, bh } = recorteLocal(c, W, margen);
    const dIn = edt(m, bw, bh, 0);

    // interior (sin el borde, que se mezcla con el fondo)
    const interior = [];
    let mejorD = 0, etiqueta = [0, 0];
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      if (dIn[i] > 16) interior.push(i);
      if (dIn[i] > mejorD) { mejorD = dIn[i]; etiqueta = [(i % bw) + bx0, ((i / bw) | 0) + by0]; }
    }
    let localIds = interior;
    if (localIds.length < 200) {
      localIds = [];
      for (let i = 0; i < m.length; i++) if (m[i]) localIds.push(i);
    }
    const ids = new Int32Array(localIds.length);
    for (let k = 0; k < localIds.length; k++) {
      const i = localIds[k];
      ids[k] = (((i / bw) | 0) + by0) * W + (i % bw) + bx0;
    }

    // media y desviación de color
    let sL = 0, sA = 0, sB = 0, qL = 0, qA = 0, qB = 0;
    for (const q of ids) {
      const l = lab.L[q], a = lab.A[q], b = lab.B[q];
      sL += l; sA += a; sB += b; qL += l * l; qA += a * a; qB += b * b;
    }
    const N = ids.length;
    const media = [sL / N, sA / N, sB / N];
    const variacion = [
      Math.sqrt(Math.max(0, qL / N - media[0] ** 2)),
      Math.sqrt(Math.max(0, qA / N - media[1] ** 2)),
      Math.sqrt(Math.max(0, qB / N - media[2] ** 2)),
    ];

    const firma = kmeans3(lab.L, lab.A, lab.B, ids, rnd);

    // histograma Lab 6x8x8
    const hist = new Float64Array(6 * 8 * 8);
    let enRango = 0;
    for (const q of ids) {
      const l = lab.L[q], a = lab.A[q], b = lab.B[q];
      if (l < 0 || l >= 100 || a < -80 || a >= 80 || b < -80 || b >= 80) continue;
      hist[Math.floor(l * 0.06) * 64 + Math.floor((a + 80) / 20) * 8 + Math.floor((b + 80) / 20)]++;
      enRango++;
    }
    if (enRango) for (let k = 0; k < hist.length; k++) hist[k] /= enRango;

    // eje principal (PCA) del calcetín
    let mx = 0, my = 0;
    for (const i of localIds) { mx += i % bw; my += (i / bw) | 0; }
    mx /= N; my /= N;
    let sxx = 0, syy = 0, sxy = 0;
    for (const i of localIds) {
      const dx = (i % bw) - mx, dy = ((i / bw) | 0) - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ct = Math.cos(th), st = Math.sin(th);
    let tmin = Infinity, tmax = -Infinity;
    for (let i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      const t = ((i % bw) - mx) * ct + (((i / bw) | 0) - my) * st;
      if (t < tmin) tmin = t; if (t > tmax) tmax = t;
    }
    const largo = Math.max(1, tmax - tmin);
    const escala = largo / 200; // 200 px = tamaño normalizado para comparar texturas

    // rayas: perfil de luminosidad a lo largo del eje y su espectro
    const NB = 256, sum = new Float64Array(NB), cnt = new Float64Array(NB);
    for (let k = 0; k < localIds.length; k++) {
      const i = localIds[k];
      const t = ((i % bw) - mx) * ct + (((i / bw) | 0) - my) * st;
      const b = Math.min(NB - 1, Math.max(0, Math.floor(((t - tmin) / largo) * NB)));
      sum[b] += lab.L[ids[k]]; cnt[b]++;
    }
    let maxCnt = 0;
    for (let b = 0; b < NB; b++) maxCnt = Math.max(maxCnt, cnt[b]);
    const perfil = new Float64Array(NB);
    let ultimo = NaN;
    for (let b = 0; b < NB; b++) {
      if (cnt[b] >= Math.max(1, 0.1 * maxCnt)) ultimo = sum[b] / cnt[b];
      perfil[b] = ultimo;
    }
    let primero = NaN;
    for (let b = 0; b < NB; b++) if (!isNaN(perfil[b])) { primero = perfil[b]; break; }
    for (let b = 0; b < NB && isNaN(perfil[b]); b++) perfil[b] = isNaN(primero) ? 0 : primero;
    const tendencia = suavizar1d(perfil, 12);
    const senal = new Float64Array(NB);
    for (let b = 0; b < NB; b++) senal[b] = (perfil[b] - tendencia[b]) * (0.5 - 0.5 * Math.cos((2 * Math.PI * b) / (NB - 1)));
    const espectro = new Float64Array(40);
    for (let k = 2; k < 42; k++) {
      let re = 0, im = 0;
      for (let b = 0; b < NB; b++) { const a = (2 * Math.PI * k * b) / NB; re += senal[b] * Math.cos(a); im -= senal[b] * Math.sin(a); }
      espectro[k - 2] = Math.hypot(re, im) / NB;
    }
    const rayas = suavizar1d(espectro, 1);

    // textura: LBP uniforme invariante a la rotación, a escala normalizada
    const rb = Math.max(0, Math.floor(escala / 2));
    const gl = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      const yy = Math.min(H - 1, Math.max(0, y + by0));
      for (let x = 0; x < bw; x++) {
        const xx = Math.min(W - 1, Math.max(0, x + bx0));
        gl[y * bw + x] = lab.G[yy * W + xx];
      }
    }
    const gs = desenfocar(gl, bw, bh, rb);
    const paso = Math.max(1, Math.round(escala));
    const lbp = [];
    for (const [P, R] of [[8, 1], [16, 3]]) {
      const radio = R * escala, hh = new Float64Array(P + 2);
      const cx = [], cy = [];
      for (let p = 0; p < P; p++) { cx.push(radio * Math.cos((2 * Math.PI * p) / P)); cy.push(-radio * Math.sin((2 * Math.PI * p) / P)); }
      let total = 0;
      const bits = new Uint8Array(P);
      for (const i of localIds) {
        const x = i % bw, y = (i / bw) | 0;
        if (x % paso || y % paso) continue;
        const c0 = gs[i];
        let unos = 0;
        for (let p = 0; p < P; p++) { bits[p] = bilineal(gs, bw, bh, x + cx[p], y + cy[p]) >= c0 ? 1 : 0; unos += bits[p]; }
        let trans = 0;
        for (let p = 0; p < P; p++) if (bits[p] !== bits[(p + 1) % P]) trans++;
        hh[trans <= 2 ? unos : P + 1]++;
        total++;
      }
      for (let k = 0; k < hh.length; k++) lbp.push(total ? hh[k] / total : 0);
    }

    let cx = 0, cy = 0;
    for (const p of c.pix) { cx += p % W; cy += (p / W) | 0; }
    return {
      firma, hist, lbp: Float64Array.from(lbp), rayas, variacion,
      tamano: Math.log(Math.sqrt(c.pix.length)), area: c.pix.length, largo,
      centro: [cx / c.pix.length, cy / c.pix.length], etiqueta, colorMedio: media,
    };
  }

  /* ------------------------------------------------------------ 3. distancias y emparejamiento */

  function distanciasCrudas(a, b) {
    let bc = 0;
    for (let k = 0; k < a.hist.length; k++) if (a.hist[k] && b.hist[k]) bc += Math.sqrt(a.hist[k] * b.hist[k]);
    let chi = 0;
    for (let k = 0; k < a.lbp.length; k++) chi += (a.lbp[k] - b.lbp[k]) ** 2 / (a.lbp[k] + b.lbp[k] + 1e-9);
    let ry = 0;
    for (let k = 0; k < a.rayas.length; k++) ry += (a.rayas[k] - b.rayas[k]) ** 2;
    return {
      colorDominante: emd(a.firma, b.firma),
      histograma: Math.sqrt(Math.max(0, 1 - bc)),
      textura: 0.5 * chi,
      rayas: Math.sqrt(ry),
      variacion: Math.hypot(a.variacion[0] - b.variacion[0], a.variacion[1] - b.variacion[1], a.variacion[2] - b.variacion[2]),
      tamano: Math.abs(a.tamano - b.tamano),
    };
  }

  function matrizDistancias(huellas) {
    const n = huellas.length, crudas = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) crudas.push([i, j, distanciasCrudas(huellas[i], huellas[j])]);
    const escalas = {};
    for (const k of CLAVES) escalas[k] = Math.max(crudas.length ? mediana(crudas.map((c) => c[2][k])) : 1, SUELOS[k]);
    const D = Array.from({ length: n }, () => new Float64Array(n).fill(Infinity));
    for (const [i, j, d] of crudas) {
      let s = 0;
      for (const k of CLAVES) s += (PESOS[k] * d[k]) / escalas[k];
      D[i][j] = D[j][i] = s;
    }
    return D;
  }

  // Emparejamiento de suma máxima de (umbral - distancia): voraz + mejoras locales
  function emparejar(D, umbral) {
    const n = D.length, pareja = new Int32Array(n).fill(-1);
    const ganancia = (i, j) => (i >= 0 && j >= 0 && D[i][j] < umbral ? umbral - D[i][j] : 0);
    const aristas = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (D[i][j] < umbral) aristas.push([D[i][j], i, j]);
    aristas.sort((a, b) => a[0] - b[0]);
    for (const [, i, j] of aristas) if (pareja[i] < 0 && pareja[j] < 0) { pareja[i] = j; pareja[j] = i; }

    let mejora = true, vueltas = 0;
    while (mejora && vueltas++ < 50) {
      mejora = false;
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < n; k++) {
          if (k === i || pareja[i] === k) continue;
          const j = pareja[i], l = pareja[k];
          const actual = (j >= 0 ? ganancia(i, j) : 0) + (l >= 0 ? ganancia(k, l) : 0);
          // opción: i con k, y sus antiguas parejas j y l entre sí
          const nueva = ganancia(i, k) + (j >= 0 && l >= 0 && j !== l ? ganancia(j, l) : 0);
          if (ganancia(i, k) > 0 && nueva > actual + 1e-9) {
            if (j >= 0) pareja[j] = -1;
            if (l >= 0) pareja[l] = -1;
            pareja[i] = k; pareja[k] = i;
            if (j >= 0 && l >= 0 && j !== l && ganancia(j, l) > 0) { pareja[j] = l; pareja[l] = j; }
            mejora = true;
          }
        }
      }
    }
    const parejas = [];
    for (let i = 0; i < n; i++) {
      const j = pareja[i];
      if (j > i) {
        let alt = Infinity;
        for (let k = 0; k < n; k++) {
          if (k === i || k === j) continue;
          alt = Math.min(alt, D[i][k], D[j][k]);
        }
        const margen = alt - D[i][j];
        parejas.push({ a: i, b: j, distancia: D[i][j], margen, segura: margen > 0.15 });
      }
    }
    parejas.sort((p, q) => Math.min(p.a, p.b) - Math.min(q.a, q.b));
    const huerfanos = [];
    for (let i = 0; i < n; i++) if (pareja[i] < 0) huerfanos.push(i);
    return { parejas, huerfanos };
  }

  /* ------------------------------------------------------------ API */

  /**
   * Analiza una imagen RGBA (ya reducida a MAX_LADO como máximo).
   * @returns {{ancho, alto, calcetines, D, umbralSegmentacion}}
   *   calcetines[i] = { pix (índices), x0,y0,x1,y1, huella }
   */
  function analizar(rgba, w, h) {
    const lab = aLab(rgba, w * h);
    const seg = segmentar(lab, w, h);
    const rnd = aleatorio(7);
    const calcetines = seg.comps.map((c) => ({ ...c, huella: huella(c, lab, w, h, rnd) }));
    const D = matrizDistancias(calcetines.map((c) => c.huella));
    return { ancho: w, alto: h, calcetines, D, umbralSegmentacion: seg.umbral };
  }

  const api = { MAX_LADO, analizar, emparejar, edt, dilatar };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Emparejador = api;
})(typeof window !== 'undefined' ? window : globalThis);
