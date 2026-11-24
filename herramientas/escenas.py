#!/usr/bin/env python3
"""
escenas.py — Monta fotos de prueba con recortes de calcetines reales sobre suelos sintéticos.

Cada escena lleva varias parejas (y algún calcetín suelto) sobre madera, sábana, baldosa o
alfombra, con sombras, luz desigual, calcetines separados, que se tocan o que se montan, y
escenas con muchos blancos u oscuros parecidos. Guarda, por escena:
  <id>.jpg        la foto
  <id>_etq.png    mapa de etiquetas (16 bits): 0 suelo, k = calcetín k del caso
  <id>.json       el caso, con el formato de banco-reales.js (+ "etiquetas")

Los recortes son una carpeta por pareja con 2 o más fotos (PNG o JPG) de cada calcetín sobre
fondo negro puro (por ejemplo, la salida de rembg). Las fotos de una carpeta se toman como
calcetines de la misma pareja.

Uso:
    pip install opencv-python numpy
    python herramientas/escenas.py --recortes <carpeta> [--n 16] [--semilla 1] [-o herramientas/escenas]
    node herramientas/evaluar-escenas.js herramientas/escenas
"""
import argparse, json, glob, os, random
from pathlib import Path
import cv2
import numpy as np

W, H = 2400, 3200


def cargar_recortes(SRC):
    pares = []
    for d in sorted(os.listdir(SRC)):
        fotos = []
        for f in sorted(glob.glob(f'{SRC}/{d}/*.png') + glob.glob(f'{SRC}/{d}/*.jpg')):
            img = cv2.imread(f)
            s = img.astype(int).sum(2)
            m = (s > 6).astype(np.uint8)
            m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            n, lab, st, _ = cv2.connectedComponentsWithStats(m)
            if n < 2:
                continue
            k = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
            m = (lab == k).astype(np.uint8)
            # rellenar agujeros (zonas negras dentro de calcetines oscuros)
            inv = (1 - m).astype(np.uint8)
            n2, lab2, st2, _ = cv2.connectedComponentsWithStats(inv)
            for j in range(1, n2):
                x, y, w, h, a = st2[j]
                if x > 0 and y > 0 and x + w < m.shape[1] and y + h < m.shape[0]:
                    m[lab2 == j] = 1
            m = cv2.erode(m, np.ones((3, 3), np.uint8))  # quita el halo del recorte
            ys, xs = np.nonzero(m)
            y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
            fotos.append((img[y0:y1, x0:x1].copy(), m[y0:y1, x0:x1].copy()))
        if len(fotos) >= 2:
            lab = cv2.cvtColor(np.concatenate([f[0][f[1] > 0] for f in fotos])[None], cv2.COLOR_BGR2LAB)[0].astype(float)
            pares.append({'id': d, 'fotos': fotos, 'L': lab[:, 0].mean(), 'croma': np.hypot(lab[:, 1] - 128, lab[:, 2] - 128).mean()})
    return pares


def ruido_lento(rng, h, w, celdas=(12, 16)):
    return cv2.resize(rng.normal(0, 1, celdas).astype(np.float32), (w, h), interpolation=cv2.INTER_CUBIC)


def fondo(tipo, rng):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    lento = ruido_lento(rng, H, W)
    if tipo == 'madera':
        base = np.array(rng.choice([(60, 95, 140), (85, 120, 160), (45, 70, 110), (110, 150, 185)]), np.float32)
        img = np.zeros((H, W, 3), np.float32) + base
        img += (lento * 5)[..., None]
        ancho = int(rng.integers(160, 300))
        vertical = rng.random() < 0.5
        coord = xx if vertical else yy
        tabla = (coord // ancho).astype(int)
        tono = rng.uniform(0.88, 1.1, tabla.max() + 1)[tabla]
        veta = cv2.GaussianBlur(rng.normal(0, 1, (H, W // 8) if not vertical else (H // 8, W)).astype(np.float32), (0, 0), 1.0)
        veta = cv2.resize(veta, (W, H), interpolation=cv2.INTER_LINEAR)
        img *= (tono * (1 + 0.06 * veta))[..., None]
        img[(coord % ancho) < 3] *= 0.7
    elif tipo == 'sabana':
        base = np.array(rng.choice([(195, 212, 226), (170, 175, 180), (150, 120, 100), (120, 140, 120)]), np.float32)
        img = np.zeros((H, W, 3), np.float32) + base
        arr = cv2.GaussianBlur(rng.normal(0, 1, (H // 16, W // 16)).astype(np.float32), (0, 0), 2.5)
        arr = cv2.resize(arr, (W, H), interpolation=cv2.INTER_CUBIC)
        gy, gx = np.gradient(arr)
        img *= (1 + np.clip(6 * (gx + gy), -0.3, 0.3))[..., None]  # pliegues: luz y sombra
        img += (lento * 4)[..., None]
    elif tipo == 'baldosa':
        base = np.array(rng.choice([(150, 150, 150), (180, 185, 190), (110, 120, 130), (200, 200, 195)]), np.float32)
        img = np.zeros((H, W, 3), np.float32) + base
        lado = int(rng.integers(300, 600))
        idx = (yy // lado).astype(int) * 100 + (xx // lado).astype(int)
        tono = rng.uniform(0.93, 1.07, idx.max() + 1)[idx]
        mota = cv2.GaussianBlur(rng.normal(0, 1, (H, W)).astype(np.float32), (0, 0), 1.2)
        img *= (tono * (1 + 0.05 * mota))[..., None]
        junta = ((yy % lado) < 6) | ((xx % lado) < 6)
        img[junta] = img[junta] * 0.55 + 30
    else:  # alfombra
        base = np.array(rng.choice([(120, 110, 100), (90, 90, 95), (140, 120, 90), (70, 80, 60)]), np.float32)
        img = np.zeros((H, W, 3), np.float32) + base
        fibra = cv2.GaussianBlur(rng.normal(0, 1, (H, W)).astype(np.float32), (0, 0), 0.8)
        img *= (1 + 0.12 * fibra)[..., None]
        img += (lento * 6)[..., None]
    return img


def preparar_calcetin(foto, rng, largo):
    img, m = foto
    h, w = m.shape
    s = largo / max(h, w)
    img = cv2.resize(img, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_CUBIC)
    m = cv2.resize(m * 255, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_LINEAR)
    if rng.random() < 0.5:
        img, m = img[:, ::-1], m[:, ::-1]
    ang = rng.uniform(0, 360)
    h, w = m.shape
    c = (w / 2, h / 2)
    R = cv2.getRotationMatrix2D(c, ang, 1.0)
    cs, sn = abs(R[0, 0]), abs(R[0, 1])
    nw, nh = int(h * sn + w * cs) + 4, int(h * cs + w * sn) + 4
    R[0, 2] += nw / 2 - c[0]
    R[1, 2] += nh / 2 - c[1]
    img = cv2.warpAffine(np.ascontiguousarray(img), R, (nw, nh), flags=cv2.INTER_LINEAR)
    m = cv2.warpAffine(np.ascontiguousarray(m), R, (nw, nh), flags=cv2.INTER_LINEAR)
    # algo de variación de exposición por foto
    img = np.clip(img.astype(np.float32) * rng.uniform(0.92, 1.08), 0, 255)
    return img, m.astype(np.float32) / 255


def escena(pares, rng, nombre, modo, tipo_fondo, n_pares, n_solos, sesgo):
    bg = fondo(tipo_fondo, rng)
    elegibles = list(range(len(pares)))
    if sesgo == 'blancos':
        elegibles = sorted(elegibles, key=lambda i: -pares[i]['L'] + 3 * pares[i]['croma'])[:22]
    elif sesgo == 'oscuros':
        elegibles = sorted(elegibles, key=lambda i: pares[i]['L'] + 3 * pares[i]['croma'])[:20]
    sel = list(rng.choice(elegibles, n_pares + n_solos, replace=False))
    items = []
    for k, pi in enumerate(sel):
        fotos = pares[pi]['fotos']
        if k < n_pares:
            a, b = rng.choice(len(fotos), 2, replace=False)
            items += [(pi, fotos[a], f'{pares[pi]["id"]}a'), (pi, fotos[b], f'{pares[pi]["id"]}b')]
        else:
            items.append((pi, fotos[int(rng.integers(len(fotos)))], f'{pares[pi]["id"]}solo'))
    order = rng.permutation(len(items))
    etiquetas = np.zeros((H, W), np.int32)
    lienzo = bg.copy()
    sombra_total = np.zeros((H, W), np.float32)
    colocados = []
    largo_base = rng.uniform(0.15, 0.2) * max(W, H)
    for oi in order:
        pi, foto, nom = items[oi]
        img, m = preparar_calcetin(foto, rng, largo_base * rng.uniform(0.85, 1.12))
        h, w = m.shape
        ok = False
        for intento in range(400):
            x = int(rng.integers(20, W - w - 20)) if W - w - 40 > 0 else 0
            y = int(rng.integers(20, H - h - 20)) if H - h - 40 > 0 else 0
            zona = etiquetas[y:y + h, x:x + w] > 0
            mb = m > 0.5
            inter = (zona & mb).sum()
            if modo == 'separados':
                dil = cv2.dilate(mb.astype(np.uint8), np.ones((31, 31), np.uint8)) > 0
                ok = not (zona & dil).any()
            elif modo == 'tocando':
                ok = inter <= 0.03 * mb.sum()
            else:
                ok = inter <= 0.18 * mb.sum()
            if ok:
                break
        if not ok:
            continue
        # sombra suave
        sh = np.zeros((H, W), np.float32)
        dx, dy = int(rng.integers(4, 12)), int(rng.integers(4, 12))
        y1, x1 = min(H, y + dy + h), min(W, x + dx + w)
        sh[y + dy:y1, x + dx:x1] = m[:y1 - y - dy, :x1 - x - dx]
        sombra_total = np.maximum(sombra_total, cv2.GaussianBlur(sh, (0, 0), 9))
        lienzo *= (1 - 0.3 * sombra_total[..., None] * (etiquetas == 0)[..., None])
        sombra_total[:] = 0
        a = m[..., None]
        reg = lienzo[y:y + h, x:x + w]
        lienzo[y:y + h, x:x + w] = reg * (1 - a) + img * a
        etiquetas[y:y + h, x:x + w][m > 0.5] = len(colocados) + 1
        colocados.append((pi, nom))
    # luz desigual, tono y ruido
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    ang = rng.uniform(0, 2 * np.pi)
    grad = 1 + rng.uniform(0.05, 0.25) * (np.cos(ang) * (xx / W - 0.5) + np.sin(ang) * (yy / H - 0.5)) * 2
    vin = 1 - rng.uniform(0, 0.2) * (((xx / W - 0.5) ** 2 + (yy / H - 0.5) ** 2) * 2)
    lienzo *= (grad * vin)[..., None]
    lienzo *= np.array([rng.uniform(0.92, 1.05), 1.0, rng.uniform(0.95, 1.1)], np.float32)
    lienzo += rng.normal(0, 3, lienzo.shape).astype(np.float32)
    foto = np.clip(lienzo, 0, 255).astype(np.uint8)
    if rng.random() < 0.3:
        foto = cv2.GaussianBlur(foto, (0, 0), 0.8)
    return foto, etiquetas, colocados


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--recortes', required=True, help='carpeta con una subcarpeta por pareja')
    ap.add_argument('-o', default=str(Path(__file__).resolve().parent / 'escenas'))
    ap.add_argument('--n', type=int, default=24)
    ap.add_argument('--semilla', type=int, default=1)
    a = ap.parse_args()
    out = Path(a.o)
    out.mkdir(parents=True, exist_ok=True)
    pares = cargar_recortes(a.recortes)
    print(len(pares), 'parejas cargadas')
    rng = np.random.default_rng(a.semilla)
    fondos = ['madera', 'sabana', 'baldosa', 'alfombra']
    modos = ['separados', 'tocando', 'tocando', 'montados']
    sesgos = ['mezcla', 'blancos', 'oscuros', 'mezcla']
    for i in range(a.n):
        nombre = f'esc{a.semilla:02d}_{i:03d}'
        tf, modo, sesgo = fondos[i % 4], modos[(i // 4) % 4], sesgos[(i // 2) % 4]
        foto, etq, col = escena(pares, rng, nombre, modo, tf, int(rng.integers(5, 9)), int(rng.integers(0, 3)), sesgo)
        cv2.imwrite(str(out / f'{nombre}.jpg'), foto, [cv2.IMWRITE_JPEG_QUALITY, 88])
        cv2.imwrite(str(out / f'{nombre}_etq.png'), etq.astype(np.uint16))
        calc = []
        for k, (pi, nom) in enumerate(col):
            ys, xs = np.nonzero(etq == k + 1)
            if len(xs) == 0:
                calc.append({'centro': [0, 0], 'caja': [0, 0, 0, 0], 'nombre': nom})
                continue
            calc.append({'centro': [float(xs.mean() / W), float(ys.mean() / H)],
                         'caja': [float(xs.min() / W), float(ys.min() / H), float(xs.max() / W), float(ys.max() / H)], 'nombre': nom})
        porpar = {}
        for k, (pi, nom) in enumerate(col):
            if not nom.endswith('solo'):
                porpar.setdefault(pi, []).append(k)
        caso = {'id': nombre, 'foto': f'{nombre}.jpg', 'etiquetas': f'{nombre}_etq.png', 'fondo': tf, 'modo': modo, 'sesgo': sesgo,
                'calcetines': calc, 'parejas': [p for p in porpar.values() if len(p) == 2]}
        (out / f'{nombre}.json').write_text(json.dumps(caso, indent=1))
        print(nombre, tf, modo, sesgo, len(col), 'calcetines', len(caso['parejas']), 'parejas')


if __name__ == '__main__':
    main()
