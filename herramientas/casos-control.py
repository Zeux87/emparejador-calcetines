#!/usr/bin/env python3
"""
casos-control.py — Genera unos pocos casos sintéticos con el formato de banco-reales.js.

Sirven de control: comprueban que el motor con IA arranca y empareja de principio a fin
(modelos, recorte, huellas y parecidos) aunque todavía no haya fotos reales guardadas.

Uso:
    pip install opencv-python numpy
    python herramientas/casos-control.py [--n 2]
    node herramientas/banco-reales.js herramientas/casos-control
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import cv2

AQUI = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=2, help="fotos por tipo de fondo")
    a = ap.parse_args()
    destino = AQUI / "casos-control"
    destino.mkdir(exist_ok=True)
    for fondo in ("madera", "beige"):
        for semilla in range(1, a.n + 1):
            nombre = f"{fondo}{semilla:02d}"
            jpg = destino / f"{nombre}.jpg"
            subprocess.run([sys.executable, str(AQUI / "generar_foto_prueba.py"), "-o", str(jpg),
                            "--semilla", str(semilla), "--fondo", fondo], check=True, stdout=subprocess.DEVNULL)
            alto, ancho = cv2.imread(str(jpg)).shape[:2]
            verdad_json = destino / f"{nombre}_verdad.json"
            verdad = json.loads(verdad_json.read_text(encoding="utf-8"))
            verdad_json.unlink()
            por_pareja = {}
            for i, v in enumerate(verdad):
                if v["pareja"] < 100:  # 100 o más: calcetín sin pareja
                    por_pareja.setdefault(v["pareja"], []).append(i)
            caso = {
                "id": nombre, "foto": jpg.name, "origen": "sintetico", "corregida": False,
                "calcetines": [{"centro": [v["centro"][0] / ancho, v["centro"][1] / alto], "nombre": v["nombre"]}
                               for v in verdad],
                "parejas": [p for p in por_pareja.values() if len(p) == 2],
            }
            (destino / f"{nombre}.json").write_text(json.dumps(caso, ensure_ascii=False, indent=1), encoding="utf-8")
            print("preparado", nombre)


if __name__ == "__main__":
    main()
