# Font licences

This directory redistributes two typefaces. Both are under the **SIL Open Font
License 1.1**, which permits bundling them with software but requires that each
copy carry the copyright notice and the licence text. That is what the two
`OFL-*.txt` files beside this one are for — they are not optional, and they must
travel with the `.woff2` files if you fork or re-host this project.

| File | Typeface | Copyright | Licence |
|---|---|---|---|
| `archivo-latin-var.woff2` | Archivo (variable, 200–700) | 2020 The Archivo Project Authors — <https://github.com/Omnibus-Type/Archivo> | [OFL-Archivo.txt](OFL-Archivo.txt) |
| `jetbrains-mono-latin-400.woff2`, `jetbrains-mono-latin-500.woff2` | JetBrains Mono | 2020 The JetBrains Mono Project Authors — <https://github.com/JetBrains/JetBrainsMono> | [OFL-JetBrainsMono.txt](OFL-JetBrainsMono.txt) |

## What was changed

These are **subsets**, not the original files: only the latin range
(`U+0000-00FF` plus common punctuation and symbols) is included, which is what
takes the three files to ~115 KB in total instead of ~700 KB. Subsetting is a
Modified Version under the OFL, which is expressly permitted. Neither font has
been renamed, and neither reserves a Font Name, so no name change is required.

The originals are unmodified in every other respect. If you want the full
character set, take it from the upstream projects linked above rather than
un-subsetting these.

## Why self-hosted at all

The course makes no external requests — no CDN, no Google Fonts, no analytics.
Serving the fonts ourselves is what makes that true. See `css/tokens.css` for
the `@font-face` rules and `README.md` for the reasoning.
