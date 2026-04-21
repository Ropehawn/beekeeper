#!/usr/bin/env bash
# Build and flash the BeeKeeper ESP32-C6 node firmware.
# Usage:  ./scripts/build-flash.sh [port]
#   default port: /dev/ttyACM0

set -euo pipefail

PORT="${1:-/dev/ttyACM0}"
# SparkFun ESP32-C6 Qwiic Pocket — uses board-specific defaults (Qwiic pins etc)
# Change to "esp32:esp32:esp32c6" for a generic C6 dev module.
FQBN="${FQBN:-esp32:esp32:sparkfun_esp32c6_qwiic_pocket}"
SKETCH_DIR="$(cd "$(dirname "$0")/../esp32-c6-node" && pwd)"

export PATH="${HOME}/.local/bin:${PATH}"

if ! command -v arduino-cli >/dev/null 2>&1; then
  echo "arduino-cli not found. Run scripts/install-arduino-cli.sh first."
  exit 1
fi

if [[ ! -c "${PORT}" ]]; then
  echo "Serial port ${PORT} not found. Is the ESP32-C6 plugged in?"
  exit 1
fi

echo "Compiling ${SKETCH_DIR} for ${FQBN}..."
arduino-cli compile --fqbn "${FQBN}" "${SKETCH_DIR}"

echo "Uploading to ${PORT}..."
# ESP32-C6 native USB flash may need sudo if user isn't in dialout group
if [[ -w "${PORT}" ]]; then
  arduino-cli upload --fqbn "${FQBN}" --port "${PORT}" "${SKETCH_DIR}"
else
  echo "Serial port not writable by current user; using sudo."
  sudo -E env PATH="${PATH}" arduino-cli upload --fqbn "${FQBN}" --port "${PORT}" "${SKETCH_DIR}"
fi

echo ""
echo "Flashed. To watch serial output:"
echo "  sudo cat ${PORT}"
echo "or with a proper terminal:"
echo "  sudo screen ${PORT} 115200   # ctrl-a k to exit"
