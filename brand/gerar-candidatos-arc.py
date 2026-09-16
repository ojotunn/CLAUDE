"""Gera a leva de simbolos para a era Argus/Arc do Claudeploy pelo Gemini
(mesmo gerador do agent-arena) e monta a prancha. Mesma familia do simbolo
atual (robo dentro da moeda, terracota #D97757 no creme #F5F4EF), so muda o
tema: Argus (o gigante de cem olhos), o arco (Arc), o portal, o dolar."""
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

AQUI = os.path.dirname(os.path.abspath(__file__))
GERADOR = os.path.join(AQUI, "..", "..", "agent-arena", "scripts", "gerar-gemini.py")
SAIDA = os.path.join(AQUI, "candidates-arc")
os.makedirs(SAIDA, exist_ok=True)

ESTILO = (
    "Flat vector logo mark. One single solid terracotta color (#D97757) on a plain flat cream background (#F5F4EF). "
    "Thick uniform rounded strokes, simple geometry, no gradients, no shadows, no texture, no outline around the canvas, "
    "no text, no letters, no numbers. Centered, generous margins, the mark fills about 60% of the square. "
    "Minimal and friendly, like an app icon. The robot head is a rounded rectangle with two round eyes, two small side ears and a short antenna with a ball on top."
)

CONCEITOS = {
    "A": "A thick coin ring. Inside the ring, one large stylized eye (almond shape with a round iris). The pupil of the eye is the small robot head. Argus, the giant with many eyes, watching.",
    "B": "A wide flat arc, like a bridge, spanning the lower half. The robot head stands on top of the arc at its highest point. A small plain coin (thick ring) floats above the robot head.",
    "C": "A large coin (thick ring) rising behind a horizontal arc, like a sun over a bridge; only the top two thirds of the coin are visible above the arc. The robot head is drawn on the visible face of the coin.",
    "D": "A ring made of twelve small circles arranged evenly around a center, like many eyes forming a coin edge. The robot head sits in the center of the ring.",
    "E": "The robot head with two short rounded arms raised up, holding a coin (thick ring with a dollar sign inside) above its head.",
    "F": "One thick continuous arc stroke that almost closes into a circle, leaving a gap at the top right, like the letter C rotated. The robot head sits inside the arc.",
    "G": "A stylized peacock feather eye: an oval eye shape with two concentric rings around it, and the robot head in the very center as the pupil. Argus's eyes on the peacock.",
    "H": "The robot head inside a thick coin ring, with three small rounded flame shapes below the head like a rocket taking off, all drawn in the same single color.",
    "I": "An arched doorway (a portal shape: a rectangle with a rounded top, drawn as a thick outline). The robot head peeks out from inside the portal, showing only the top half of the head and the antenna.",
    "J": "Two concentric thick arcs over the robot head, like a small rainbow or a dome, both arcs open at the bottom. The robot head sits under the dome, centered.",
}

def gerar(chave):
    destino = os.path.join(SAIDA, f"{chave}.png")
    env = dict(os.environ, GEMINI_RAZAO="1:1", GEMINI_TAMANHO="2K", GEMINI_MODEL=os.environ.get("GEMINI_MODEL", "gemini-3-pro-image"))
    prompt = ESTILO + " " + CONCEITOS[chave]
    with open(os.path.join(SAIDA, f"{chave}.log"), "w", encoding="utf-8") as log:
        log.write(prompt + "\n\n")
        r = subprocess.run([sys.executable, GERADOR, destino, prompt], env=env, capture_output=True, text=True, timeout=900)
        log.write(r.stdout + r.stderr)
    return chave, r.returncode, os.path.exists(destino)

if __name__ == "__main__":
    quais = sys.argv[1:] or list(CONCEITOS)
    with ThreadPoolExecutor(max_workers=5) as ex:
        for chave, rc, ok in ex.map(gerar, quais):
            print(chave, "ok" if ok else f"FALHOU rc={rc}", flush=True)
