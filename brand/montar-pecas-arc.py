"""Monta as pecas da marca Claudearc a partir do simbolo A recortado:
token logo 512/1024 (quadrado creme), icones 32/64/192/512 (quadrado
arredondado creme), foto de perfil do X 400 (circulo creme). A capa do X e
feita em HTML + Edge headless (cover-arc.html) e reduzida aqui."""
import os, sys
from PIL import Image, ImageDraw

AQUI = os.path.dirname(os.path.abspath(__file__))
CREAM = (245, 244, 239, 255)
mark = Image.open(os.path.join(AQUI, "out", "symbol-A-arc-terracotta.png")).convert("RGBA")

def fit(size, frac):
    m = mark.copy(); m.thumbnail((int(size * frac), int(size * frac)), Image.LANCZOS)
    return m

def square(size, frac=0.78):
    im = Image.new("RGBA", (size, size), CREAM)
    m = fit(size, frac); im.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
    return im

def rounded(size, frac=0.74, radius_frac=0.22):
    im = square(size, frac)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * radius_frac), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0)); out.paste(im, (0, 0), mask)
    return out

def circle(size, frac=0.72):
    im = square(size, frac)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0)); out.paste(im, (0, 0), mask)
    return out

pub = os.path.join(AQUI, "..", "public", "brand")
square(1024).convert("RGB").save(os.path.join(AQUI, "token-logo-1024.png"))
square(512).convert("RGB").save(os.path.join(pub, "token-logo-512.png"))
for s in (32, 64, 192, 512):
    # icone: quadrado arredondado; no 32 e 64 o simbolo ocupa mais para nao sumir
    rounded(s, frac=0.86 if s <= 64 else 0.76).save(os.path.join(pub, f"icon-{s}.png"))
circle(400).convert("RGB").save(os.path.join(pub, "x-profile-400.png"))
# a capa vem do Edge (3000x1000) e cai para 1500x500
cover = os.path.join(AQUI, "x-cover-arc-3000x1000.png")
if os.path.exists(cover):
    Image.open(cover).convert("RGB").resize((1500, 500), Image.LANCZOS).save(os.path.join(pub, "x-cover-1500x500.png"))
    Image.open(cover).convert("RGB").save(os.path.join(AQUI, "x-cover-3000x1000.png"))
    print("cover ok")
print("pecas ok")
