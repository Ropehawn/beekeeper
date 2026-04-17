#!/usr/bin/env bash
# Watches the training PID, iMessages when it exits.
set -uo pipefail
LOG=~/Claud/beekeeping/training/train.log
YOLO_PID=$(pgrep -f "yolo train" | head -1)
if [[ -z "$YOLO_PID" ]]; then
  ~/bin/notify -t "BeeKeeper" "watch-train: no yolo process found"
  exit 1
fi
echo "watching PID $YOLO_PID..."
while kill -0 "$YOLO_PID" 2>/dev/null; do sleep 30; done

# Training exited — summarize
BEST=~/Claud/beekeeping/runs/detect/runs/bees-v1/weights/best.pt
LAST_EPOCH=$(grep -oE "^ *[0-9]+/[0-9]+ " "$LOG" 2>/dev/null | tail -1 | tr -d ' ')
MAP50=$(grep -oE "all.*" "$LOG" 2>/dev/null | tail -1 | awk '{print $5}')
if [[ -f "$BEST" ]]; then
  SIZE=$(ls -lh "$BEST" | awk '{print $5}')
  ~/bin/notify -t "BeeKeeper Training" "✅ Training done. Epoch $LAST_EPOCH. mAP50=$MAP50. best.pt=$SIZE. Exporting ONNX now."
else
  ~/bin/notify -t "BeeKeeper Training" "⚠️ yolo exited but best.pt missing. Check train.log."
fi
