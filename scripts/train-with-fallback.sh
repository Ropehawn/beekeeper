#!/usr/bin/env bash
set -uo pipefail
cd ~/Claud/beekeeping/training
source venv/bin/activate
LOG=~/Claud/beekeeping/training/train.log

echo "=== Attempt 1: MPS + PYTORCH_ENABLE_MPS_FALLBACK=1 ===" > "$LOG"
PYTORCH_ENABLE_MPS_FALLBACK=1 yolo train model=yolov8n.pt data=Honey-Bee-Detection-Model-4/data.yaml epochs=100 imgsz=640 batch=16 device=mps project=runs name=bees-v1 patience=20 amp=False workers=4 >> "$LOG" 2>&1
EXIT1=$?

if [[ $EXIT1 -eq 0 ]]; then
  ~/bin/notify -t "BeeKeeper" "✅ Training complete (MPS+fallback). Check Claude for results."
  exit 0
fi

# MPS failed — fall through to CPU
echo "" >> "$LOG"
echo "=== MPS+fallback crashed (exit $EXIT1). Falling through to device=cpu ===" >> "$LOG"
~/bin/notify -t "BeeKeeper" "MPS+fallback crashed. Auto-switching to CPU training — slower but stable. ETA 2-4h."
rm -rf ~/Claud/beekeeping/runs/detect/runs/bees-v1

yolo train model=yolov8n.pt data=Honey-Bee-Detection-Model-4/data.yaml epochs=100 imgsz=640 batch=16 device=cpu project=runs name=bees-v1 patience=20 amp=False workers=4 >> "$LOG" 2>&1
EXIT2=$?

if [[ $EXIT2 -eq 0 ]]; then
  ~/bin/notify -t "BeeKeeper" "✅ Training complete (CPU). Check Claude for results."
else
  ~/bin/notify -t "BeeKeeper" "❌ CPU training also failed (exit $EXIT2). Manual intervention needed."
fi
exit $EXIT2
