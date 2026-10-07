"""Build the reading fonts bundled for HTML book exports and the reader.

Run at development time only — the app never fetches a font. It downloads
each family from the google/fonts repository at a pinned commit, prepares it
and writes ``backend/assets/fonts/<id>/`` (the WOFF2 files and the family's
``OFL.txt``) and ``backend/assets/fonts/manifest.json`` (family, category,
files, licence, SHA-256), the single source of truth the backend reads::

    uv run --no-project --with fonttools --with brotli python scripts/build_book_fonts.py

* A family without a Reserved Font Name is cut to Latin, Latin Extended and
  Vietnamese (``fontTools.subset``, every OpenType feature kept) with its
  axes other than weight fixed at their defaults, as WOFF2.
* A family with a Reserved Font Name (Lora, Source Serif 4, Playfair Display)
  is only recompressed as WOFF2, every glyph, axis and table kept: a subset is
  a Modified Version, which may not use that name, while a lossless webfont of
  the whole font is functionally equivalent to it (OFL-FAQ 2.6–2.8). The name
  is read from the family's ``OFL.txt`` and from each font's own copyright
  and licence records (google/fonts' copy of the licence can omit it, as
  Source Serif 4's does).
  Merriweather is left out for that reason: whole, its opsz/wdth/wght font
  is 4.8 MB, too much to embed in a page.

A family is dropped unless every Vietnamese letter is in it after the cut.
"""
from __future__ import annotations

import hashlib
import io
import json
import pathlib
import re
import shutil
import sys
import urllib.parse
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "backend" / "assets" / "fonts"
#: google/fonts, pinned so a rebuild gives the same bytes.
COMMIT = "7085eb89a950e85db5b166b7a58d414544b4140c"
RAW = f"https://raw.githubusercontent.com/google/fonts/{COMMIT}/ofl"
SOURCE = f"https://github.com/google/fonts/tree/{COMMIT}/ofl"

#: (id, family, category, upstream folder, [(upstream file, style, weight)])
FAMILIES = [
    ("literata", "Literata", "serif", "literata",
     [("Literata[opsz,wght].ttf", "normal", None), ("Literata-Italic[opsz,wght].ttf", "italic", None)]),
    ("noto-serif", "Noto Serif", "serif", "notoserif",
     [("NotoSerif[wdth,wght].ttf", "normal", None), ("NotoSerif-Italic[wdth,wght].ttf", "italic", None)]),
    ("lora", "Lora", "serif", "lora",
     [("Lora[wght].ttf", "normal", None), ("Lora-Italic[wght].ttf", "italic", None)]),
    ("eb-garamond", "EB Garamond", "serif", "ebgaramond",
     [("EBGaramond[wght].ttf", "normal", None), ("EBGaramond-Italic[wght].ttf", "italic", None)]),
    ("source-serif-4", "Source Serif 4", "serif", "sourceserif4",
     [("SourceSerif4[opsz,wght].ttf", "normal", None),
      ("SourceSerif4-Italic[opsz,wght].ttf", "italic", None)]),
    ("playfair-display", "Playfair Display", "display", "playfairdisplay",
     [("PlayfairDisplay[wght].ttf", "normal", None),
      ("PlayfairDisplay-Italic[wght].ttf", "italic", None)]),
    ("be-vietnam-pro", "Be Vietnam Pro", "sans", "bevietnampro",
     [("BeVietnamPro-Regular.ttf", "normal", 400), ("BeVietnamPro-Italic.ttf", "italic", 400),
      ("BeVietnamPro-SemiBold.ttf", "normal", 600), ("BeVietnamPro-Bold.ttf", "normal", 700)]),
    ("inter", "Inter", "sans", "inter",
     [("Inter[opsz,wght].ttf", "normal", None), ("Inter-Italic[opsz,wght].ttf", "italic", None)]),
    ("montserrat", "Montserrat", "sans", "montserrat",
     [("Montserrat[wght].ttf", "normal", None), ("Montserrat-Italic[wght].ttf", "italic", None)]),
    ("lexend", "Lexend", "sans", "lexend", [("Lexend[wght].ttf", "normal", None)]),
    ("nunito", "Nunito", "rounded", "nunito",
     [("Nunito[wght].ttf", "normal", None), ("Nunito-Italic[wght].ttf", "italic", None)]),
    ("baloo-2", "Baloo 2", "rounded", "baloo2", [("Baloo2[wght].ttf", "normal", None)]),
    ("patrick-hand", "Patrick Hand", "handwriting", "patrickhand",
     [("PatrickHand-Regular.ttf", "normal", 400)]),
    ("jetbrains-mono", "JetBrains Mono", "mono", "jetbrainsmono",
     [("JetBrainsMono[wght].ttf", "normal", None),
      ("JetBrainsMono-Italic[wght].ttf", "italic", None)]),
]

#: Latin (Basic, Latin-1, Extended-A and -B, Extended Additional — which holds
#: the Vietnamese letters), spacing and combining marks (Vietnamese typed in
#: decomposed form), punctuation and currency signs (the dong among them).
#: Phonetic alphabets and the rarer Latin Extended-C/D blocks are left out.
UNICODES = [
    *range(0x0000, 0x0250), *range(0x02B0, 0x0370), *range(0x1E00, 0x1F00),
    *range(0x2000, 0x2070), *range(0x20A0, 0x20C1), 0x2113, 0x2116, 0x2122,
    *range(0x2190, 0x2194), 0x2212, 0x2215, 0x2219, 0x25CC, 0xFEFF, 0xFFFD,
]

#: Every precomposed Vietnamese letter, upper and lower case.
VIETNAMESE = sorted(set(
    "ÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚÝàáâãèéêìíòóôõùúýĂăĐđĨĩŨũƠơƯư"
    + "".join(chr(c) for c in range(0x1EA0, 0x1EFA))))


#: "Reserved Font Name(s) "A" and "B"" in a licence or a font's name table.
_RFN = re.compile(r"Reserved\s+Font\s+Names?\s+((?:[\"'“‘][^\"'”’]+[\"'”’][\s,]*(?:and\s+)?)+)",
                  re.IGNORECASE)
_QUOTED = re.compile(r"[\"'“‘]([^\"'”’]+)[\"'”’]")


def reserved_names(text: str) -> list:
    """Every Reserved Font Name ``text`` declares, in order."""
    return [name.strip() for group in _RFN.findall(text) for name in _QUOTED.findall(group)]


def font_reserved_names(data: bytes) -> list:
    """The Reserved Font Names a font declares in its copyright (name ID 0) and
    licence (ID 13) records."""
    names = TTFont(io.BytesIO(data))["name"]
    return reserved_names(" ".join(str(names.getDebugName(i) or "") for i in (0, 13)))


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as response:  # noqa: S310 — pinned https URL
        return response.read()


def prepare(raw: bytes, *, reserved: bool) -> bytes:
    # Not re-stamped on save, so a rebuild at the pinned commit gives the same bytes.
    font = TTFont(io.BytesIO(raw), recalcTimestamp=False)
    if not reserved:
        if "fvar" in font:
            # Keep the weight axis (one file for every weight); fix the rest.
            pinned = {a.axisTag: None for a in font["fvar"].axes if a.axisTag != "wght"}
            if pinned:
                # Saved and read back: the subsetter cannot read the
                # instancer's partly loaded variation table.
                staged = io.BytesIO()
                instancer.instantiateVariableFont(font, pinned).save(staged)
                font = TTFont(io.BytesIO(staged.getvalue()), recalcTimestamp=False)
        options = subset.Options()
        options.flavor = "woff2"
        options.layout_features = ["*"]
        options.name_IDs = ["*"]
        options.name_languages = ["*"]
        options.name_legacy = True
        options.notdef_outline = True
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=UNICODES)
        subsetter.subset(font)
    font.flavor = "woff2"
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


def vietnamese_missing(data: bytes) -> list:
    cmap = TTFont(io.BytesIO(data)).getBestCmap()
    return [c for c in VIETNAMESE if ord(c) not in cmap]


def axis_range(data: bytes):
    font = TTFont(io.BytesIO(data))
    if "fvar" not in font:
        return None
    return {a.axisTag: [a.minValue, a.maxValue] for a in font["fvar"].axes}


def main() -> int:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    families, dropped = [], []
    for fid, name, category, folder, files in FAMILIES:
        folder_out = OUT / fid
        folder_out.mkdir()
        licence = fetch(f"{RAW}/{folder}/OFL.txt").decode("utf-8-sig").replace("\r\n", "\n")
        raws = [fetch(f"{RAW}/{folder}/{urllib.parse.quote(upstream)}") for upstream, _, _ in files]
        found = reserved_names(licence) + [n for raw in raws for n in font_reserved_names(raw)]
        reserved = ", ".join(dict.fromkeys(found)) or None
        entries, missing = [], []
        for (upstream, style, weight), raw in zip(files, raws):
            data = prepare(raw, reserved=bool(reserved))
            missing += vietnamese_missing(data)
            axes = axis_range(data)
            wght = (axes or {}).get("wght")
            stem = upstream.split("[")[0].removesuffix(".ttf")
            file_name = f"{stem}.woff2"
            (folder_out / file_name).write_bytes(data)
            entries.append({
                "file": f"{fid}/{file_name}",
                "style": style,
                "weight": [int(wght[0]), int(wght[1])] if wght else [weight, weight],
                "axes": sorted(axes) if axes else [],
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "upstream": upstream,
            })
        if missing:
            shutil.rmtree(folder_out)
            dropped.append((name, "".join(sorted(set(missing)))))
            continue
        (folder_out / "OFL.txt").write_bytes(licence.encode("utf-8"))
        families.append({
            "id": fid,
            "family": name,
            "category": category,
            "license": "OFL-1.1",
            "license_file": f"{fid}/OFL.txt",
            "license_sha256": hashlib.sha256(licence.encode("utf-8")).hexdigest(),
            "reserved_font_name": reserved,
            "prepared": "recompressed" if reserved else "subset",
            "source": f"{SOURCE}/{folder}",
            "files": entries,
        })
        print(f"{name:18} {sum(e['bytes'] for e in entries) / 1024:8.1f} KiB  "
              + "  ".join(f"{e['file'].split('/')[1]} {e['bytes'] / 1024:.0f}" for e in entries))
    manifest = {
        "version": 1,
        "source": f"https://github.com/google/fonts/tree/{COMMIT}",
        "subset": "Latin, Latin Extended, Vietnamese",
        "families": families,
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n",
                                       encoding="utf-8", newline="\n")
    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"{len(families)} families, {total / 1024:.1f} KiB in all")
    for name, letters in dropped:
        print(f"dropped {name}: no {letters}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
