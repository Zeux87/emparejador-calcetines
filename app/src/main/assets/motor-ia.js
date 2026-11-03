/*
 * motor-ia.js — Motor de emparejamiento con IA, todo dentro del móvil.
 *
 *   1. Primer plano: el motor clásico (emparejador.js) separa suelo y objetos
 *      y propone puntos dentro de cada mancha.
 *   2. SlimSAM recorta cada calcetín por separado aunque se toquen o estén arrugados.
 *   3. Cada calcetín se endereza, se "pliega" en un cuadrado y DINOv2 saca la huella
 *      de cada trozo de su dibujo (parches de 14x14 píxeles).
 *   4. Parecido entre dos calcetines: para cada trozo de A se busca el más parecido
 *      en B y se compara con lo que se parece al resto de calcetines de la foto;
 *      cuentan los 20 trozos más distintivos (logos, rayas…), no la forma.
 *   5. Pareja = cada uno es el más parecido del otro y el parecido supera el umbral.
 *
 * Necesita onnxruntime-web (global ort) y Emparejador (emparejador.js).
 */
(function (global) {
  'use strict';

  const CFG = {
    lado1: 1024,          // imagen para SlimSAM
    lado2: 2048,          // imagen para recortes y para mostrar
    espacio: 44,          // separación mínima entre puntos de consulta (px en lado1)
    maxPorMancha: 12,
    lote: 16,
    areaMin: 0.0015, areaMax: 0.08,
    estabilidadMin: 0.85, iouMin: 0.75, dentroMin: 0.6, solape: 0.3,
    cobertura: 0.6,       // parche válido si el calcetín cubre más del 60 %
    topk: 20,             // nº de trozos más distintivos que cuentan
    umbrales: [0.32, 0.26, 0.22], // Estricta, Normal, Flexible
    margenSegura: 0.04,
    difColorDividir: 12,  // ΔE mínima entre partes para separar una máscara mezclada
  };
  const MEDIA = [0.485, 0.456, 0.406], DESV = [0.229, 0.224, 0.225];
  const FONDO = [104, 116, 124]; // gris neutro (RGB) detrás de cada recorte

  let sesiones = null;
  let cargando = null;

  function ortGlobal() {
    const o = global.ort;
    if (!o) throw new Error('No se ha cargado onnxruntime');
    return o;
  }

  async function cargarModelos(base, aviso) {
    if (sesiones) return sesiones;
    if (cargando) return cargando;
    cargando = (async () => {
      const ort = ortGlobal();
      // ruta absoluta: el import() dinámico de onnxruntime no acepta rutas relativas
      base = new URL(base || './', global.location.href).href;
      ort.env.wasm.wasmPaths = base + 'ort/';
      const hilos = global.crossOriginIsolated ? Math.max(1, Math.min(4, (global.navigator && navigator.hardwareConcurrency) || 4)) : 1;
      ort.env.wasm.numThreads = hilos;
      const op = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      aviso && aviso('Cargando modelos (solo la primera vez)…');
      const enc = await ort.InferenceSession.create(base + 'modelos/slimsam-encoder-q.onnx', op);
      const dec = await ort.InferenceSession.create(base + 'modelos/slimsam-decoder-q.onnx', op);
      const dino = await ort.InferenceSession.create(base + 'modelos/dinov2-small-q.onnx', op);
      sesiones = { enc, dec, dino, hilos };
      return sesiones;
    })();
    try {
      return await cargando;
    } finally {
      cargando = null;
    }
  }

  const pausa = () => new Promise((r) => setTimeout(r, 0));

  /* ------------------------------------------------------------ imágenes */

  function rasterizar(img, lado) {
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    const s = Math.min(1, lado / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * s)), h = Math.max(1, Math.round(h0 * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return { w, h, data: ctx.getImageData(0, 0, w, h).data };
  }

  /* ------------------------------------------------------------ 1. puntos de consulta */

  function puntosSemilla(fg, w, h) {
    const E = global.Emparejador;
    const d2 = E.edt(fg, w, h, 0);
    const comps = E.etiquetar(fg, w, h);
    const esp2 = CFG.espacio * CFG.espacio;
    const todos = [];
    for (const c of comps) {
      if (c.pix.length < 0.001 * w * h) continue;
      const orden = Array.from(c.pix).filter((p) => d2[p] >= 9).sort((a, b) => d2[b] - d2[a]);
      const elegidos = [];
      for (const p of orden) {
        if (elegidos.length >= CFG.maxPorMancha) break;
        const x = p % w, y = (p / w) | 0;
        if (x < 6 || y < 6 || x >= w - 6 || y >= h - 6) continue;
        if (elegidos.every((q) => (q.x - x) ** 2 + (q.y - y) ** 2 >= esp2)) elegidos.push({ x, y, d: d2[p] });
      }
      todos.push(...elegidos);
    }
    todos.sort((a, b) => b.d - a.d);
    return todos;
  }

  /* ------------------------------------------------------------ 2. SlimSAM */

  async function recortarConSam(s, I1, fg, lab1, aviso) {
    const ort = ortGlobal();
    const { w, h, data } = I1;
    const N = 1024 * 1024;
    const x = new Float32Array(3 * N);
    for (let y = 0; y < h; y++) {
      for (let xx = 0; xx < w; xx++) {
        const i = (y * w + xx) * 4, o = y * 1024 + xx;
        x[o] = (data[i] / 255 - MEDIA[0]) / DESV[0];
        x[N + o] = (data[i + 1] / 255 - MEDIA[1]) / DESV[1];
        x[2 * N + o] = (data[i + 2] / 255 - MEDIA[2]) / DESV[2];
      }
    }
    aviso && aviso('Buscando calcetines…');
    await pausa();
    const enc = await s.enc.run({ pixel_values: new ort.Tensor('float32', x, [1, 3, 1024, 1024]) });
    const emb = enc.image_embeddings, pos = enc.image_positional_embeddings;

    const hh = Math.ceil(h / 4), ww = Math.ceil(w / 4);
    // primer plano a la resolución de las máscaras (vecino más próximo)
    const fgLo = new Uint8Array(hh * ww);
    for (let y = 0; y < hh; y++) {
      const sy = Math.min(h - 1, Math.floor(y * h / hh));
      for (let xx = 0; xx < ww; xx++) fgLo[y * ww + xx] = fg[sy * w + Math.min(w - 1, Math.floor(xx * w / ww))];
    }

    const puntos = puntosSemilla(fg, w, h);
    const cands = [];
    for (let i0 = 0; i0 < puntos.length; i0 += CFG.lote) {
      const lote = puntos.slice(i0, i0 + CFG.lote), B = lote.length;
      const pts = new Float32Array(B * 2);
      lote.forEach((p, k) => { pts[2 * k] = p.x; pts[2 * k + 1] = p.y; });
      const etiquetas = new BigInt64Array(B).fill(1n);
      aviso && aviso(`Buscando calcetines… ${Math.min(100, Math.round(100 * (i0 + B) / puntos.length))} %`);
      await pausa();
      const r = await s.dec.run({
        input_points: new ort.Tensor('float32', pts, [1, B, 1, 2]),
        input_labels: new ort.Tensor('int64', etiquetas, [1, B, 1]),
        image_embeddings: emb,
        image_positional_embeddings: pos,
      });
      const iou = r.iou_scores.data, ms = r.pred_masks.data;
      for (let k = 0; k < B; k++) {
        for (let j = 0; j < 3; j++) {
          const off = (k * 3 + j) * 65536;
          let a = 0, mas1 = 0, menos1 = 0, dentro = 0, borde = 0;
          for (let y = 0; y < hh; y++) {
            const o = off + y * 256;
            for (let xx = 0; xx < ww; xx++) {
              const v = ms[o + xx];
              if (v > -1) { menos1++; if (v > 1) mas1++; }
              if (v > 0) {
                a++;
                dentro += fgLo[y * ww + xx];
                if (y === 0 || xx === 0 || y === hh - 1 || xx === ww - 1) borde++;
              }
            }
          }
          if (a < CFG.areaMin * hh * ww || a > CFG.areaMax * hh * ww) continue;
          const est = mas1 / Math.max(1, menos1), sc = iou[k * 3 + j];
          if (est < CFG.estabilidadMin || sc < CFG.iouMin) continue;
          if (dentro / a < CFG.dentroMin || borde > 2) continue;
          const lo = new Float32Array(hh * ww), m = new Uint8Array(hh * ww);
          for (let y = 0; y < hh; y++) {
            for (let xx = 0; xx < ww; xx++) {
              const v = ms[off + y * 256 + xx];
              lo[y * ww + xx] = v; m[y * ww + xx] = v > 0 ? 1 : 0;
            }
          }
          cands.push({ lo, m, a, s: sc * est });
        }
      }
    }
    cands.sort((p, q) => q.s - p.s);
    const aceptadas = [];
    for (const c of cands) {
      let ok = true;
      for (const d of aceptadas) {
        let inter = 0;
        for (let i = 0; i < c.m.length; i++) inter += c.m[i] & d.m[i];
        if (inter / Math.min(c.a, d.a) > CFG.solape) { ok = false; break; }
      }
      if (ok) aceptadas.push(c);
    }
    const final = dividirMezclas(aceptadas, cands, labLo(lab1, w, h, hh, ww), hh * ww);
    return { mascaras: final, hh, ww, puntos: puntos.length };
  }

  // Color Lab medio por bloques de 4x4 (resolución de las máscaras)
  function labLo(lab, w, h, hh, ww) {
    const L = new Float32Array(hh * ww), A = new Float32Array(hh * ww), B = new Float32Array(hh * ww), n = new Float32Array(hh * ww);
    for (let y = 0; y < h; y++) {
      const o = (y >> 2) * ww;
      for (let x = 0; x < w; x++) {
        const q = o + (x >> 2), i = y * w + x;
        L[q] += lab.L[i]; A[q] += lab.A[i]; B[q] += lab.B[i]; n[q]++;
      }
    }
    for (let q = 0; q < n.length; q++) if (n[q]) { L[q] /= n[q]; A[q] /= n[q]; B[q] /= n[q]; }
    return { L, A, B };
  }

  function colorMedio(m, lab) {
    let l = 0, a = 0, b = 0, n = 0;
    for (let i = 0; i < m.length; i++) if (m[i]) { l += lab.L[i]; a += lab.A[i]; b += lab.B[i]; n++; }
    return n ? [l / n, a / n, b / n] : [0, 0, 0];
  }

  function interseccion(p, q) {
    let s = 0;
    for (let i = 0; i < p.length; i++) s += p[i] & q[i];
    return s;
  }

  // Si una máscara aceptada es la suma de dos o más máscaras que SAM también propuso
  // por separado y que tienen colores claramente distintos, son calcetines distintos: se divide.
  function dividirMezclas(aceptadas, cands, lab, total) {
    const res = [];
    for (const M of aceptadas) {
      const partes = cands
        .filter((c) => c !== M && c.a >= 0.2 * M.a && c.a <= 0.85 * M.a)
        .filter((c) => interseccion(c.m, M.m) / c.a >= 0.9)
        .sort((p, q) => q.s - p.s);
      const elegidas = [];
      for (const c of partes) {
        if (elegidas.every((d) => interseccion(c.m, d.m) / Math.min(c.a, d.a) < 0.1)) elegidas.push(c);
      }
      let dividir = false;
      if (elegidas.length >= 2) {
        const union = new Uint8Array(total);
        for (const c of elegidas) for (let i = 0; i < total; i++) union[i] |= c.m[i];
        let cubre = 0;
        for (let i = 0; i < total; i++) cubre += union[i] & M.m[i];
        const colores = elegidas.map((c) => colorMedio(c.m, lab));
        let maxDif = 0;
        for (let i = 0; i < colores.length; i++) for (let j = i + 1; j < colores.length; j++) {
          maxDif = Math.max(maxDif, Math.hypot(colores[i][0] - colores[j][0], colores[i][1] - colores[j][1], colores[i][2] - colores[j][2]));
        }
        dividir = cubre >= 0.75 * M.a && maxDif >= CFG.difColorDividir;
      }
      if (dividir) res.push(...elegidas);
      else res.push(M);
    }
    return res;
  }

  /* ------------------------------------------------------------ 3. recorte y huella con DINOv2 */

  // Valor del logit de la máscara en un punto de la imagen grande (bilineal, como cv2.INTER_LINEAR)
  function logitEn(lo, hh, ww, sx, sy, X, Y) {
    let u = (X + 0.5) / sx - 0.5, v = (Y + 0.5) / sy - 0.5;
    if (u < 0) u = 0; if (v < 0) v = 0;
    if (u > ww - 1) u = ww - 1; if (v > hh - 1) v = hh - 1;
    const u0 = Math.floor(u), v0 = Math.floor(v), u1 = Math.min(ww - 1, u0 + 1), v1 = Math.min(hh - 1, v0 + 1);
    const fu = u - u0, fv = v - v0;
    return lo[v0 * ww + u0] * (1 - fu) * (1 - fv) + lo[v0 * ww + u1] * fu * (1 - fv) +
      lo[v1 * ww + u0] * (1 - fu) * fv + lo[v1 * ww + u1] * fu * fv;
  }

  function pixelesEn(mask, hh, ww, I1, I2) {
    const sx = 4 * I2.w / I1.w, sy = 4 * I2.h / I1.h;
    let lx0 = ww, ly0 = hh, lx1 = -1, ly1 = -1;
    for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) {
      if (!mask.m[y * ww + x]) continue;
      if (x < lx0) lx0 = x; if (x > lx1) lx1 = x; if (y < ly0) ly0 = y; if (y > ly1) ly1 = y;
    }
    const X0 = Math.max(0, Math.floor((lx0 - 1) * sx)), X1 = Math.min(I2.w - 1, Math.ceil((lx1 + 2) * sx));
    const Y0 = Math.max(0, Math.floor((ly0 - 1) * sy)), Y1 = Math.min(I2.h - 1, Math.ceil((ly1 + 2) * sy));
    const pix = [];
    let x0 = I2.w, y0 = I2.h, x1 = -1, y1 = -1;
    for (let Y = Y0; Y <= Y1; Y++) for (let X = X0; X <= X1; X++) {
      if (logitEn(mask.lo, hh, ww, sx, sy, X, Y) > 0) {
        pix.push(Y * I2.w + X);
        if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
      }
    }
    // solo la mancha más grande (quita islas sueltas del reescalado)
    if (pix.length) {
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1, m = new Uint8Array(bw * bh);
      for (const p of pix) m[(((p / I2.w) | 0) - y0) * bw + (p % I2.w) - x0] = 1;
      const comps = global.Emparejador.etiquetar(m, bw, bh);
      if (comps.length > 1) {
        const g = comps.reduce((a, b) => (b.pix.length > a.pix.length ? b : a));
        const res = new Int32Array(g.pix.length);
        for (let i = 0; i < g.pix.length; i++) {
          const q = g.pix[i];
          res[i] = (((q / bw) | 0) + y0) * I2.w + (q % bw) + x0;
        }
        return { pix: res, x0: g.x0 + x0, y0: g.y0 + y0, x1: g.x1 + x0, y1: g.y1 + y0, sx, sy };
      }
    }
    return { pix: Int32Array.from(pix), x0, y0, x1, y1, sx, sy };
  }

  // Muestra RGB bilineal de la imagen grande
  function rgbEn(I, x, y, out) {
    if (x < 0) x = 0; if (y < 0) y = 0;
    if (x > I.w - 1.001) x = I.w - 1.001; if (y > I.h - 1.001) y = I.h - 1.001;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
    const i00 = (y0 * I.w + x0) * 4, i10 = i00 + 4, i01 = i00 + I.w * 4, i11 = i01 + 4, d = I.data;
    for (let c = 0; c < 3; c++) {
      out[c] = d[i00 + c] * (1 - fx) * (1 - fy) + d[i10 + c] * fx * (1 - fy) + d[i01 + c] * (1 - fx) * fy + d[i11 + c] * fx * fy;
    }
  }

  // Endereza el calcetín (eje largo vertical), lo corta en k tramos lado a lado
  // y lo encaja en un cuadrado de 224x224 sobre fondo gris.
  function recortePlegado(I2, cal, mask, hh, ww) {
    const W = I2.w;
    let mx = 0, my = 0;
    const n = cal.pix.length;
    for (const p of cal.pix) { mx += p % W; my += (p / W) | 0; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of cal.pix) {
      const dx = (p % W) - mx, dy = ((p / W) | 0) - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    const t = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ex = [Math.cos(t), Math.sin(t)];        // eje largo
    const en = [Math.sin(t), -Math.cos(t)];       // eje corto (rotación propia, sin espejo)
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    for (const p of cal.pix) {
      const dx = (p % W) - mx, dy = ((p / W) | 0) - my;
      const u = dx * en[0] + dy * en[1], v = dx * ex[0] + dy * ex[1];
      if (u < umin) umin = u; if (u > umax) umax = u; if (v < vmin) vmin = v; if (v > vmax) vmax = v;
    }
    umin -= 6; vmin -= 6; umax += 6; vmax += 6;
    const wr = Math.max(1, umax - umin), hr = Math.max(1, vmax - vmin);
    const k = Math.max(1, Math.min(4, Math.round(Math.sqrt(hr / wr))));
    const seg = Math.ceil(hr / k);
    const Hc = seg, Wc = wr * k, L = Math.max(Hc, Wc);
    const ox = (L - Wc) / 2, oy = (L - Hc) / 2;
    const lado = 224, paso = L / lado;
    const ss = Math.max(1, Math.min(4, Math.ceil(paso)));
    const rgb = new Float32Array(lado * lado * 3), cob = new Float32Array(lado * lado);
    const tmp = [0, 0, 0];
    for (let Yo = 0; Yo < lado; Yo++) {
      for (let Xo = 0; Xo < lado; Xo++) {
        let r = 0, g = 0, b = 0, dentro = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const cx = (Xo + (sx + 0.5) / ss) * paso - ox, cy = (Yo + (sy + 0.5) / ss) * paso - oy;
            let ok = false;
            if (cx >= 0 && cy >= 0 && cx < Wc && cy < Hc) {
              const tramo = Math.floor(cx / wr);
              const u = umin + (cx - tramo * wr), v = vmin + tramo * seg + cy;
              if (tramo < k && v <= vmax) {
                const X = mx + u * en[0] + v * ex[0], Y = my + u * en[1] + v * ex[1];
                if (X >= 0 && Y >= 0 && X <= W - 1 && Y <= I2.h - 1 &&
                  logitEn(mask.lo, hh, ww, cal.sx, cal.sy, X, Y) > 0) {
                  rgbEn(I2, X, Y, tmp);
                  r += tmp[0]; g += tmp[1]; b += tmp[2]; dentro++; ok = true;
                }
              }
            }
            if (!ok) { r += FONDO[0]; g += FONDO[1]; b += FONDO[2]; }
          }
        }
        const q = ss * ss, o = Yo * lado + Xo;
        rgb[3 * o] = r / q; rgb[3 * o + 1] = g / q; rgb[3 * o + 2] = b / q;
        cob[o] = dentro / q;
      }
    }
    return { rgb, cob };
  }

  async function huellasDino(s, recortes, aviso) {
    const ort = ortGlobal();
    const lado = 224, P = lado * lado;
    const res = [];
    for (let i = 0; i < recortes.length; i++) {
      aviso && aviso(`Comparando dibujos… ${i + 1}/${recortes.length}`);
      await pausa();
      const { rgb, cob } = recortes[i];
      const x = new Float32Array(2 * 3 * P);
      for (let v = 0; v < 2; v++) {          // v=0 tal cual, v=1 girado 180°
        const base = v * 3 * P;
        for (let o = 0; o < P; o++) {
          const src = v === 0 ? o : P - 1 - o;
          for (let c = 0; c < 3; c++) x[base + c * P + o] = (rgb[3 * src + c] / 255 - MEDIA[c]) / DESV[c];
        }
      }
      const out = await s.dino.run({ pixel_values: new ort.Tensor('float32', x, [2, 3, lado, lado]) });
      const hs = out.last_hidden_state.data; // [2, 257, 384]
      const variantes = [];
      for (let v = 0; v < 2; v++) {
        const lista = [];
        for (let py = 0; py < 16; py++) {
          for (let px = 0; px < 16; px++) {
            let c = 0;
            for (let yy = 0; yy < 14; yy++) for (let xx = 0; xx < 14; xx++) {
              const o = (py * 14 + yy) * lado + px * 14 + xx;
              c += cob[v === 0 ? o : P - 1 - o];
            }
            if (c / 196 <= CFG.cobertura) continue;
            const off = (v * 257 + 1 + py * 16 + px) * 384;
            const f = new Float32Array(384);
            let nn = 0;
            for (let d = 0; d < 384; d++) { f[d] = hs[off + d]; nn += f[d] * f[d]; }
            nn = 1 / Math.sqrt(nn || 1);
            for (let d = 0; d < 384; d++) f[d] *= nn;
            lista.push(f);
          }
        }
        variantes.push(lista);
      }
      res.push(variantes);
    }
    return res;
  }

  /* ------------------------------------------------------------ 4. parecidos */

  function mediana(v) {
    const s = Float64Array.from(v).sort(), m = s.length >> 1;
    return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }

  function matrizParecidos(feats) {
    const n = feats.length;
    // mejor[a][b][p] = parecido del parche p de A con su mejor parche de B (cualquier orientación)
    const mejor = Array.from({ length: n }, () => new Array(n));
    for (let a = 0; a < n; a++) {
      const A = feats[a][0];
      for (let b = 0; b < n; b++) {
        if (a === b) continue;
        const r = new Float32Array(A.length).fill(-1);
        for (const V of feats[b]) {
          for (let p = 0; p < A.length; p++) {
            const fa = A[p];
            let m = r[p];
            for (const fb of V) {
              let d = 0;
              for (let k = 0; k < 384; k++) d += fa[k] * fb[k];
              if (d > m) m = d;
            }
            r[p] = m;
          }
        }
        mejor[a][b] = r;
      }
    }
    const S = Array.from({ length: n }, () => new Float64Array(n));
    for (let a = 0; a < n; a++) {
      const P = feats[a][0].length;
      if (!P) continue;
      const otros = [];
      for (let b = 0; b < n; b++) if (b !== a) otros.push(b);
      const ref = new Float64Array(P);
      for (let p = 0; p < P; p++) ref[p] = mediana(otros.map((b) => mejor[a][b][p]));
      for (const b of otros) {
        const z = new Float64Array(P);
        for (let p = 0; p < P; p++) z[p] = mejor[a][b][p] - ref[p];
        z.sort();
        const k = Math.min(CFG.topk, P);
        let s = 0;
        for (let i = P - k; i < P; i++) s += z[i];
        S[a][b] = s / k;
      }
    }
    for (let a = 0; a < n; a++) {
      S[a][a] = -Infinity;
      for (let b = a + 1; b < n; b++) {
        const v = 0.5 * (S[a][b] + S[b][a]);
        S[a][b] = S[b][a] = v;
      }
    }
    return S;
  }

  function emparejar(S, nivel) {
    const T = CFG.umbrales[nivel == null ? 1 : nivel];
    const n = S.length, mejor = new Int32Array(n).fill(-1);
    for (let a = 0; a < n; a++) {
      let m = -Infinity;
      for (let b = 0; b < n; b++) if (b !== a && S[a][b] > m) { m = S[a][b]; mejor[a] = b; }
    }
    const parejas = [], usado = new Uint8Array(n);
    for (let a = 0; a < n; a++) {
      const b = mejor[a];
      if (b > a && mejor[b] === a && S[a][b] >= T) {
        parejas.push({ a, b, parecido: S[a][b], segura: S[a][b] >= T + CFG.margenSegura });
        usado[a] = usado[b] = 1;
      }
    }
    const huerfanos = [];
    for (let i = 0; i < n; i++) if (!usado[i]) huerfanos.push(i);
    return { parejas, huerfanos };
  }

  /* ------------------------------------------------------------ API */

  function puntoInterior(cal, W) {
    const bw = cal.x1 - cal.x0 + 3, bh = cal.y1 - cal.y0 + 3;
    const m = new Uint8Array(bw * bh);
    for (const p of cal.pix) m[(((p / W) | 0) - cal.y0 + 1) * bw + (p % W) - cal.x0 + 1] = 1;
    const d = global.Emparejador.edt(m, bw, bh, 0);
    let mejor = -1, pos = [cal.x0, cal.y0];
    for (let i = 0; i < d.length; i++) {
      if (m[i] && d[i] > mejor) { mejor = d[i]; pos = [(i % bw) + cal.x0 - 1, ((i / bw) | 0) + cal.y0 - 1]; }
    }
    return pos;
  }

  /**
   * Analiza una foto (HTMLImageElement / ImageBitmap).
   * Devuelve { ancho, alto, imagen (RGBA a lado2), calcetines[{pix,x0,y0,x1,y1,huella:{etiqueta}}], S, tiempos }
   */
  async function analizar(img, opciones) {
    const op = opciones || {};
    const aviso = op.aviso || null;
    const base = op.base || '';
    const t0 = performance.now();
    const s = await cargarModelos(base, aviso);
    const t1 = performance.now();
    const I1 = rasterizar(img, CFG.lado1), I2 = rasterizar(img, CFG.lado2);
    const E = global.Emparejador;
    const lab1 = E.aLab(I1.data, I1.w * I1.h);
    const fg = E.segmentar(lab1, I1.w, I1.h).mascara;
    const sam = await recortarConSam(s, I1, fg, lab1, aviso);
    const t2 = performance.now();
    aviso && aviso('Recortando calcetines…');
    await pausa();
    const calcetines = [], recortes = [];
    for (const m of sam.mascaras) {
      const cal = pixelesEn(m, sam.hh, sam.ww, I1, I2);
      if (cal.pix.length < 50) continue;
      recortes.push(recortePlegado(I2, cal, m, sam.hh, sam.ww));
      calcetines.push({ pix: cal.pix, x0: cal.x0, y0: cal.y0, x1: cal.x1, y1: cal.y1, huella: { etiqueta: puntoInterior(cal, I2.w) } });
    }
    const feats = await huellasDino(s, recortes, aviso);
    const t3 = performance.now();
    const S = calcetines.length >= 2 ? matrizParecidos(feats) : [];
    const t4 = performance.now();
    return {
      ancho: I2.w, alto: I2.h, imagen: I2.data, calcetines, S,
      tiempos: {
        modelos: Math.round(t1 - t0), sam: Math.round(t2 - t1), dino: Math.round(t3 - t2),
        parecidos: Math.round(t4 - t3), total: Math.round(t4 - t0), hilos: s.hilos, puntos: sam.puntos,
      },
      recortes: op.devolverRecortes ? recortes : undefined,
      _feats: feats,
    };
  }

  global.MotorIA = { CFG, analizar, emparejar, cargarModelos, matrizParecidos };
})(typeof window !== 'undefined' ? window : globalThis);
