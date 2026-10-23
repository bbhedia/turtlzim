#!/usr/bin/env python3
"""The Android launcher icons from the web app's own (../web/public/icons). Run once, or after the icon changes: `python3 scripts/make-icons.py`.
Needs Pillow. Writes the mipmap folders of android/app/src/main/res: the legacy square and round icons, and the adaptive icon's foreground
(the full-bleed "maskable" icon: the launcher's mask crops the edge, and the document is inside the part that stays); the adaptive
icon's background is the colour that the maskable icon is made on."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
icons = root.parent / "web/public/icons"
res = root / "android/app/src/main/res"
square = Image.open(icons / "icon-512.png").convert("RGBA")
maskable = Image.open(icons / "icon-maskable-512.png").convert("RGBA")
background = maskable.getpixel((4, 4))[:3]

# dp sizes: the launcher icon is 48dp, the adaptive icon's layers are 108dp
densities = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
for name, scale in densities.items():
    folder = res / f"mipmap-{name}"
    folder.mkdir(parents=True, exist_ok=True)
    launcher = round(48 * scale)
    square.resize((launcher, launcher), Image.LANCZOS).save(folder / "ic_launcher.png")
    # the round one: the maskable icon in a circle
    big = maskable.resize((launcher * 4, launcher * 4), Image.LANCZOS)
    mask = Image.new("L", big.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big.size[0] - 1, big.size[1] - 1), fill=255)
    big.putalpha(mask)
    big.resize((launcher, launcher), Image.LANCZOS).save(folder / "ic_launcher_round.png")
    layer = round(108 * scale)
    maskable.resize((layer, layer), Image.LANCZOS).save(folder / "ic_launcher_foreground.png")

# iOS: one 1024 px icon (the system rounds it: the full-bleed one, with no transparency), and the picture of the launch screen (the icon on the same colour, in the three sizes of its set)
ios = root / "ios/App/App/Assets.xcassets"
if ios.exists():
    maskable.resize((1024, 1024), Image.LANCZOS).convert("RGB").save(ios / "AppIcon.appiconset/AppIcon-512@2x.png")
    splash = Image.new("RGB", (2732, 2732), background)
    icon = square.resize((640, 640), Image.LANCZOS)
    splash.paste(icon, ((2732 - 640) // 2, (2732 - 640) // 2), icon)
    for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
        splash.save(ios / "Splash.imageset" / name, optimize=True)

(res / "values/ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#%02X%02X%02X</color>\n</resources>\n' % background
)
print("icons written; background #%02X%02X%02X" % background)
