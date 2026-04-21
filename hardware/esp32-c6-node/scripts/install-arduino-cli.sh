#!/usr/bin/env bash
# Install arduino-cli + ESP32 board support + required libraries.
# Idempotent — safe to re-run.

set -euo pipefail

ARDUINO_CLI="${HOME}/.local/bin/arduino-cli"
mkdir -p "${HOME}/.local/bin"

if ! command -v arduino-cli >/dev/null 2>&1 && [[ ! -x "${ARDUINO_CLI}" ]]; then
  echo "Installing arduino-cli..."
  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
    | BINDIR="${HOME}/.local/bin" sh
fi

export PATH="${HOME}/.local/bin:${PATH}"

echo "arduino-cli version:"
arduino-cli version

# Create config if absent
arduino-cli config init --overwrite >/dev/null 2>&1 || true
arduino-cli config set board_manager.additional_urls \
  https://espressif.github.io/arduino-esp32/package_esp32_index.json

echo "Updating core index..."
arduino-cli core update-index

echo "Installing ESP32 core (this takes a few minutes on first run)..."
arduino-cli core install esp32:esp32

echo "Installing required libraries..."
arduino-cli lib install "Adafruit BME280 Library"
arduino-cli lib install "Adafruit Unified Sensor"
arduino-cli lib install "NimBLE-Arduino"
arduino-cli lib install "HX711 Arduino Library"   # bogde/HX711

echo ""
echo "Done. To verify, run:"
echo "  arduino-cli board listall | grep c6"
