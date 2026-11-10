#!/usr/bin/env bash
# 映像フレームを4並列でレンダリング → BGM合成 → mp4に結合
set -euo pipefail
cd "$(dirname "$0")"
TOTAL=900; JOBS=4; STEP=$((TOTAL / JOBS))
rm -rf frames; mkdir -p frames out
for j in $(seq 0 $((JOBS - 1))); do
  node render.mjs $((j * STEP)) $(((j + 1) * STEP)) frames &
done
node audio.mjs out/bgm.wav
wait
ffmpeg -loglevel error -y -framerate 30 -i frames/%05d.jpg -i out/bgm.wav \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -c:a aac -b:a 192k -t 30 -movflags +faststart out/fable-showcase.mp4
echo "done: out/fable-showcase.mp4"
