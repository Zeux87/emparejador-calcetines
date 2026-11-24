#!/usr/bin/env node
/*
 * evaluar-escenas.js — Mide el motor con IA con las escenas de escenas.py (que traen el mapa de
 * qué píxel es de qué calcetín). Usa los mismos modelos que el APK, en Chrome sin ventana.
 *
 * Recorte, por escena:
 *   fondo     calcetín detectado que es sobre todo suelo
 *   uniones   calcetín detectado que se ha comido dos calcetines
 *   trozos    calcetín partido en dos o más detectados
 *   perdidos  calcetín que no se ha detectado
 * Parejas: bien / mal (pareja propuesta que no lo es) con el umbral por defecto.
 *
 * Uso: node herramientas/evaluar-escenas.js [carpeta] [--umbral U] [--solo texto] [--guardar dir]
 *   --guardar guarda, por escena, la detección con huellas y recortes (para estudiar el parecido)
 * Necesita Playwright (npm install --no-save playwright), Python con opencv-python y los modelos en
 * app/src/main/assets/modelos y ort/ (los pasos están en .github/workflows/compilar-apk.yml).
 */
'use strict';
const fs = require('fs'), http = require('http'), path = require('path'), zlib = require('zlib');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
let dir = path.join(__dirname, 'escenas'), assets = path.join(__dirname, '..', 'app', 'src', 'main', 'assets'), guardar = null, solo = null, umbral = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--assets') assets = path.resolve(args[++i]);
  else if (args[i] === '--guardar') guardar = path.resolve(args[++i]);
  else if (args[i] === '--solo') solo = args[++i];
  else if (args[i] === '--umbral') umbral = parseFloat(args[++i]);
  else dir = path.resolve(args[i]);
}

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json' };
const PAGINA = `<!DOCTYPE html><meta charset="utf-8"><title>eval</title>
<script src="ort/ort.wasm.min.js"></script><script src="emparejador.js"></script><script src="motor-ia.js"></script>
<script>
window.analizarCaso = async (url, guardar) => {
  const img = new Image(); img.src = url; await img.decode();
  const s = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const r = await MotorIA.analizar(c, {});
  const W = r.ancho, H = r.alto, w = Math.ceil(W / 4), h = Math.ceil(H / 4);
  const etq = new Uint8Array(w * h);
  r.calcetines.forEach((k, i) => { for (const p of k.pix) { const x = p % W, y = (p / W) | 0; etq[(y >> 2) * w + (x >> 2)] = i + 1; } });
  let b = ''; for (let i = 0; i < etq.length; i += 0x8000) b += String.fromCharCode.apply(null, etq.subarray(i, i + 0x8000));
  const out = { ancho: W, alto: H, w, h, etq: btoa(b), tiempos: r.tiempos, n: r.calcetines.length,
    S: r.S.map((f) => Array.from(f, (v) => (Number.isFinite(v) ? v : null))),
    P: (r.P || []).map((f) => Array.from(f)),
    etiquetas: r.calcetines.map((k) => [k.huella.etiqueta[0] / W, k.huella.etiqueta[1] / H]) };
  if (guardar) {
    const enc = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
    out.huellas = r.huellas.map((x) => ({ n0: x.n0, n1: x.n1, f0: enc(new Uint8Array(x.f0.buffer.slice(x.f0.byteOffset, x.f0.byteOffset + x.f0.byteLength))), f1: enc(new Uint8Array(x.f1.buffer.slice(x.f1.byteOffset, x.f1.byteOffset + x.f1.byteLength))) }));
    out.recortes = r.recortes.map((x) => ({ rgb: enc(Uint8Array.from(x.rgb, (v) => Math.round(v))), cob: enc(Uint8Array.from(x.cob, (v) => Math.round(v * 255))) }));
  }
  return out;
};
</script>`;

function servidor() {
  const srv = http.createServer((req, res) => {
    const ruta = decodeURIComponent(req.url.split('?')[0]);
    const cab = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' };
    if (ruta === '/__e.html') { res.writeHead(200, { ...cab, 'Content-Type': TIPOS['.html'] }); res.end(PAGINA); return; }
    const enCasos = ruta.startsWith('/__casos/');
    const base = enCasos ? dir : assets;
    const archivo = path.normalize(path.join(base, enCasos ? ruta.slice(9) : ruta));
    if (!archivo.startsWith(base) || !fs.existsSync(archivo)) { res.writeHead(404, cab); res.end(); return; }
    res.writeHead(200, { ...cab, 'Content-Type': TIPOS[path.extname(archivo)] || 'application/octet-stream' });
    fs.createReadStream(archivo).pipe(res);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

// mapa de etiquetas de la verdad, reducido a la rejilla de la detección (vecino más próximo)
function verdadReducida(caso, w, h) {
  const png = path.join(dir, caso.etiquetas);
  const raw = execFileSync('python3', ['-c', `
import cv2,sys,numpy as np
m=cv2.imread(sys.argv[1],cv2.IMREAD_UNCHANGED)
r=cv2.resize(m,(int(sys.argv[2]),int(sys.argv[3])),interpolation=cv2.INTER_NEAREST).astype(np.uint8)
sys.stdout.buffer.write(r.tobytes())`, png, String(w), String(h)], { maxBuffer: 1 << 26 });
  return new Uint8Array(raw);
}

function segmentacion(gt, det, nG, nD) {
  const C = Array.from({ length: nD + 1 }, () => new Int32Array(nG + 1));
  for (let i = 0; i < gt.length; i++) C[det[i]][gt[i]]++;
  const tamD = C.map((f) => f.reduce((a, b) => a + b, 0));
  const tamG = new Int32Array(nG + 1);
  for (let d = 0; d <= nD; d++) for (let g = 0; g <= nG; g++) tamG[g] += C[d][g];
  const res = { fondo: [], uniones: [], trozos: [], perdidos: [], deDet: new Array(nD + 1).fill(-1) };
  for (let d = 1; d <= nD; d++) {
    let mg = 0, mv = 0;
    for (let g = 1; g <= nG; g++) if (C[d][g] > mv) { mv = C[d][g]; mg = g; }
    const cubre = [];
    for (let g = 1; g <= nG; g++) if (tamG[g] && C[d][g] >= 0.3 * tamG[g] && C[d][g] >= 0.15 * tamD[d]) cubre.push(g);
    if (mv < 0.5 * tamD[d]) res.fondo.push({ d, fondo: +(C[d][0] / tamD[d]).toFixed(2) });
    if (cubre.length >= 2) res.uniones.push({ d, gts: cubre });
    if (mv >= 0.5 * tamD[d] && mv >= 0.3 * tamG[mg]) res.deDet[d] = mg;
  }
  for (let g = 1; g <= nG; g++) {
    if (!tamG[g]) continue;
    const partes = [];
    for (let d = 1; d <= nD; d++) if (C[d][g] >= 0.2 * tamG[g] && C[d][g] >= 0.5 * tamD[d]) partes.push(d);
    if (partes.length >= 2) res.trozos.push({ g, partes });
    let tot = 0;
    for (let d = 1; d <= nD; d++) tot += C[d][g];
    if (!res.deDet.includes(g)) res.perdidos.push(g);
  }
  return res;
}

(async () => {
  globalThis.Emparejador = require(path.join(assets, 'emparejador.js'));
  require(path.join(assets, 'motor-ia.js'));
  const M = globalThis.MotorIA;
  const T = umbral != null ? umbral : M.CFG.umbralBase;
  let archivos = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
  if (solo) archivos = archivos.filter((f) => f.includes(solo));
  const srv = await servidor();
  const url = `http://127.0.0.1:${srv.address().port}`;
  let pw;
  try { pw = require('playwright'); } catch (e) { throw new Error('Falta Playwright. Instálalo con: npm install --no-save playwright'); }
  let nav;
  try { nav = await pw.chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] }); } catch (e) { nav = await pw.chromium.launch({ args: ['--no-sandbox'] }); }
  const pag = await nav.newPage();
  pag.on('pageerror', (e) => console.error('[página] ' + e.message));
  await pag.goto(url + '/__e.html');
  const tot = { esperados: 0, detectados: 0, fondo: 0, uniones: 0, trozos: 0, perdidos: 0, parejas: 0, bien: 0, mal: 0, ms: 0 };
  const resultados = [];
  if (guardar) fs.mkdirSync(guardar, { recursive: true });
  for (const f of archivos) {
    const caso = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const det = await pag.evaluate(([u, g]) => window.analizarCaso(u, g), [`${url}/__casos/${caso.foto}`, !!guardar]);
    const etq = new Uint8Array(Buffer.from(det.etq, 'base64'));
    const gt = verdadReducida(caso, det.w, det.h);
    const nG = caso.calcetines.length;
    const sg = segmentacion(gt, etq, nG, det.n);
    const S = det.S.map((r) => Float64Array.from(r, (v) => (v == null ? -Infinity : v)));
    const parejas = S.length ? M.emparejar(S, T, det.n).parejas : [];
    const buenas = new Set(caso.parejas.map(([a, b]) => [a + 1, b + 1].sort((x, y) => x - y).join('-')));
    let bien = 0; const mal = [];
    for (const p of parejas) {
      const x = sg.deDet[p.a + 1], y = sg.deDet[p.b + 1];
      const k = [x, y].sort((u, v) => u - v).join('-');
      if (x > 0 && y > 0 && buenas.has(k)) bien++;
      else mal.push(`${x > 0 ? caso.calcetines[x - 1].nombre : 'd' + (p.a + 1)}+${y > 0 ? caso.calcetines[y - 1].nombre : 'd' + (p.b + 1)}(${p.parecido.toFixed(2)})`);
    }
    tot.esperados += nG; tot.detectados += det.n; tot.fondo += sg.fondo.length; tot.uniones += sg.uniones.length;
    tot.trozos += sg.trozos.length; tot.perdidos += sg.perdidos.length; tot.parejas += buenas.size; tot.bien += bien; tot.mal += mal.length; tot.ms += det.tiempos.total;
    const nm = (g) => caso.calcetines[g - 1].nombre;
    console.log(`${caso.id} ${caso.fondo}/${caso.modo}/${caso.sesgo}: calc ${det.n}/${nG} fondo ${sg.fondo.length} uniones ${sg.uniones.length} trozos ${sg.trozos.length} perdidos ${sg.perdidos.length} | parejas ${bien}/${buenas.size} mal ${mal.length} ${mal.join(' ')} ${(det.tiempos.total / 1000).toFixed(0)}s` +
      (sg.uniones.length ? `\n   uniones: ${sg.uniones.map((u) => u.gts.map(nm).join('&')).join(', ')}` : '') +
      (sg.perdidos.length ? `\n   perdidos: ${sg.perdidos.map(nm).join(', ')}` : ''));
    resultados.push({ id: caso.id, sg: { fondo: sg.fondo, uniones: sg.uniones, trozos: sg.trozos, perdidos: sg.perdidos }, deDet: sg.deDet, n: det.n, bien, mal });
    if (guardar) fs.writeFileSync(path.join(guardar, caso.id + '.json'), JSON.stringify({ caso, det: { ...det, deDet: sg.deDet } }));
  }
  await nav.close(); srv.close();
  console.log(`\nTOTAL ${archivos.length} casos · calcetines ${tot.detectados}/${tot.esperados} · fondo ${tot.fondo} · uniones ${tot.uniones} · trozos ${tot.trozos} · perdidos ${tot.perdidos} · parejas bien ${tot.bien}/${tot.parejas} · mal ${tot.mal} · ${(tot.ms / 1000 / archivos.length).toFixed(1)} s/foto`);
})().catch((e) => { console.error(e); process.exit(2); });
