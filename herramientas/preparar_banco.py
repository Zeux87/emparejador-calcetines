#!/usr/bin/env python3
"""
preparar_banco.py — Genera fotos sintéticas y las deja listas para banco-pruebas.js.

Uso:
    pip install opencv-python numpy
    python herramientas/preparar_banco.py [--n 12]

Crea herramientas/banco/*.rgba (imagen ya reducida a 1600 px, como hace la app)
y *_verdad.json con las parejas reales.
"""
import argparse
import json
import struct
import subprocess
import sys
from pathlib import Path

import cv2

AQUI = Path(__file__).resolve().parent
MAX_LADO = 1600


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=12, help="fotos por tipo de fondo")
    a = ap.parse_args()
    destino = AQUI / "banco"
    destino.mkdir(exist_ok=True)
    for fondo in ("madera", "beige"):
        for semilla in range(1, a.n + 1):
            nombre = f"{fondo}{semilla:02d}"
            jpg = destino / f"{nombre}.jpg"
            subprocess.run([sys.executable, str(AQUI / "generar_foto_prueba.py"), "-o", str(jpg),
                            "--semilla", str(semilla), "--fondo", fondo], check=True, stdout=subprocess.DEVNULL)
            im = cv2.imread(str(jpg))
            h, w = im.shape[:2]
            s = min(1.0, MAX_LADO / max(h, w))
            if s < 1:
                im = cv2.resize(im, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
            h, w = im.shape[:2]
            rgba = cv2.cvtColor(im, cv2.COLOR_BGR2RGBA)
            (destino / f"{nombre}.rgba").write_bytes(struct.pack("<II", w, h) + rgba.tobytes())
            verdad_jpg = destino / f"{nombre}_verdad.json"
            verdad = json.loads(verdad_jpg.read_text(encoding="utf-8"))
            for v in verdad:
                v["centro"] = [c * s for c in v["centro"]]
            verdad_jpg.write_text(json.dumps(verdad, ensure_ascii=False), encoding="utf-8")
            print("preparada", nombre)


if __name__ == "__main__":
    main()
