#!/usr/bin/env bash
# Builds a 60-second product walkthrough mp4 for the homepage hero modal.
# Output: attached_assets/marketing/probid-demo-60s.mp4 + .jpg poster
# Re-run after copy/timing changes; the result is committed to source.
set -euo pipefail

W=1280
H=720
FPS=30
SCENE=10  # seconds per scene
OUT_DIR="client/public/marketing"
OUT="$OUT_DIR/probid-demo-60s.mp4"
POSTER="$OUT_DIR/probid-demo-60s-poster.jpg"
mkdir -p "$OUT_DIR"

REGULAR="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
BOLD="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# Brand palette (from client/tailwind.config.js)
BG="0x0a0e1a"
CARD="0x121a2a"
GREEN="0x22c55e"
TEXT="0xe8f0ff"
MUTED="0x94a3b8"

# Each scene: a single ffmpeg pass writing scene_N.mp4 with a step number,
# headline, and subline that gently fade in and out so the result reads as
# a real produced walkthrough rather than a static slideshow.
render_scene() {
  local idx="$1" step="$2" headline="$3" subline="$4" footer="$5"
  local outfile="$OUT_DIR/_scene_${idx}.mp4"
  # Fade window: 0-0.7s in, 0.7-9.3s hold, 9.3-10s out.
  local A="if(lt(t,0.7),t/0.7,if(gt(t,9.3),(10-t)/0.7,1))"
  ffmpeg -y -loglevel error \
    -f lavfi -i "color=c=$BG:s=${W}x${H}:d=${SCENE}:r=${FPS}" \
    -vf "
      drawbox=x=80:y=80:w=${W}-160:h=${H}-160:color=${CARD}@1:t=fill,
      drawbox=x=80:y=80:w=${W}-160:h=6:color=${GREEN}@0.9:t=fill,
      drawtext=fontfile=${BOLD}:text='${step}':fontcolor=${GREEN}:fontsize=36:x=120:y=130:alpha='${A}',
      drawtext=fontfile=${BOLD}:text='${headline}':fontcolor=${TEXT}:fontsize=72:x=(w-text_w)/2:y=h/2-90:alpha='${A}',
      drawtext=fontfile=${REGULAR}:text='${subline}':fontcolor=${MUTED}:fontsize=32:x=(w-text_w)/2:y=h/2+30:alpha='${A}',
      drawtext=fontfile=${REGULAR}:text='${footer}':fontcolor=${MUTED}:fontsize=22:x=(w-text_w)/2:y=h-130:alpha='${A}',
      drawtext=fontfile=${BOLD}:text='ProBid AI':fontcolor=${GREEN}:fontsize=20:x=w-text_w-120:y=130:alpha='${A}'
    " \
    -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p -movflags +faststart \
    "$outfile"
  echo "$outfile"
}

S1=$(render_scene 1 "" "ProBid AI" "Construction estimates in under a minute" "probidcore.net")
S2=$(render_scene 2 "STEP 1" "Snap a photo" "or describe the job in plain English" "Roofing - Masonry - Concrete - 10+ trades")
S3=$(render_scene 3 "STEP 2" "AI builds the estimate" "Materials, labor, and regional pricing - itemized" "Trained on contractor workflows")
S4=$(render_scene 4 "STEP 3" "Total: \$5,700" "Itemized line items - editable - ready to send" "Generated in ~28 seconds")
S5=$(render_scene 5 "STEP 4" "Client-ready PDF" "One-tap export with your branding" "Win the job before the next contractor calls back")
S6=$(render_scene 6 "" "Try ProBid AI free" "3 free roofing estimates - no credit card" "probidcore.net")

# Concatenate the 6 scenes into a single 60s mp4 (no crossfade so duration stays
# exactly 60.0s and the >=90% completion event fires at the right time).
LIST="$OUT_DIR/_concat.txt"
{
  echo "file '$(basename "$S1")'"
  echo "file '$(basename "$S2")'"
  echo "file '$(basename "$S3")'"
  echo "file '$(basename "$S4")'"
  echo "file '$(basename "$S5")'"
  echo "file '$(basename "$S6")'"
} > "$LIST"

ffmpeg -y -loglevel error -f concat -safe 0 -i "$LIST" -c copy "$OUT"

# Poster = first frame of the first scene.
ffmpeg -y -loglevel error -i "$S1" -frames:v 1 -q:v 3 "$POSTER"

# Cleanup intermediate files.
rm -f "$OUT_DIR"/_scene_*.mp4 "$LIST"

DURATION=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$OUT")
SIZE=$(stat -c%s "$OUT")
echo "Built $OUT (${DURATION}s, ${SIZE} bytes)"
echo "Poster: $POSTER"
