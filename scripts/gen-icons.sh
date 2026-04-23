#!/bin/bash
# Regenerate the app icon family (icon.svg, icon-192, icon-512, apple-touch-icon).
# Requires: rsvg-convert (brew install librsvg).
set -e
OUT="$(cd "$(dirname "$0")/.." && pwd)/public"
ACCENT="#6B9BD1"
LETTER="C"

cat > "$OUT/icon.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect x="0" y="0" width="1024" height="1024" rx="225" ry="225" fill="${ACCENT}"/>
  <text x="512" y="512"
        text-anchor="middle"
        dominant-baseline="central"
        font-family="ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
        font-weight="800"
        font-size="720"
        fill="#ffffff">${LETTER}</text>
</svg>
SVG

rsvg-convert -w 192 -h 192 "$OUT/icon.svg" -o "$OUT/icon-192.png"
rsvg-convert -w 512 -h 512 "$OUT/icon.svg" -o "$OUT/icon-512.png"
rsvg-convert -w 180 -h 180 "$OUT/icon.svg" -o "$OUT/apple-touch-icon.png"
echo "wrote icons to $OUT"
