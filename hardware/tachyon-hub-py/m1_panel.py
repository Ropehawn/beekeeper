#!/usr/bin/env python3
"""
BeeKeeper M1 Panel Daemon — LED-only status indicator.

Drives the top RGB status LED on the M1 carrier (ADP8866 at I²C 0x27 on
bus 1) to indicate Tachyon hub health. Does NOT interact with the M1 user
button — that button is hardwired as a physical extension of the Tachyon
SoM power-key path and has no userspace event semantics on this hardware.

LED states (top LED only):
    startup           → blue blink (3 cycles)
    healthy           → solid green
    hub_down          → solid red       (beekeeper-hub-py.service inactive)
    ble_down          → red blink       (hci0 down, or no recent scans)
    stale_upload      → solid amber     (scans ok but no uploads recently)
"""

from __future__ import annotations

import logging
import re
import subprocess
import time
from datetime import datetime, timedelta, timezone

from adp8866 import ADP8866

# ── Tunables ─────────────────────────────────────────────────────────────────

# How often to re-evaluate health state. The LED loop ticks faster (for blink
# animations) but only repaints on state change.
HEALTH_RECHECK_SEC = 30

# Main loop cadence — also the blink half-period, so 0.5s = 1 Hz blink.
LOOP_INTERVAL_SEC = 0.5

# What counts as "recent" for the BLE scan and upload log lines.
SCAN_RECENT_SEC   = 120     # daemon scans roughly every 60s
UPLOAD_RECENT_SEC = 600     # daemon uploads roughly every 300s

# Visible brightness levels (0..127 ISC raw scale; 127 = max).
B_STARTUP_PULSE = 127
B_HEALTHY       = 90
B_HUB_DOWN      = 110
B_BLE_DOWN      = 110
B_STALE         = 110

# Wait this long after starting before talking to the chip — gives the M1
# carrier rail time to settle on a cold boot.
INIT_SETTLE_SEC = 1.0

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("m1-status-led")


# ── Health checks ────────────────────────────────────────────────────────────

def _systemctl_active(unit: str) -> bool:
    try:
        r = subprocess.run(
            ["systemctl", "is-active", unit],
            capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip() == "active"
    except subprocess.SubprocessError:
        return False


def _hci0_up_running() -> bool:
    """True iff `hciconfig hci0` reports both 'UP' and 'RUNNING'."""
    try:
        r = subprocess.run(
            ["hciconfig", "hci0"],
            capture_output=True, text=True, timeout=5,
        )
        out = r.stdout
        return "UP RUNNING" in out
    except (subprocess.SubprocessError, FileNotFoundError):
        return False


def _journal_last_event(unit: str, pattern: str, since_sec: int) -> bool:
    """True iff `unit` has a journal line matching `pattern` within the last
    `since_sec` seconds. Cheap polling — runs once per health re-check."""
    since_ts = datetime.now(timezone.utc) - timedelta(seconds=since_sec)
    since_arg = since_ts.strftime("%Y-%m-%d %H:%M:%S UTC")
    try:
        r = subprocess.run(
            ["journalctl", "-u", unit, "--no-pager", "--since", since_arg],
            capture_output=True, text=True, timeout=5,
        )
        return re.search(pattern, r.stdout) is not None
    except subprocess.SubprocessError:
        return False


def evaluate_health() -> str:
    """Return current health state — one of:
        'healthy' | 'hub_down' | 'ble_down' | 'stale_upload'
    """
    if not _systemctl_active("beekeeper-hub-py"):
        return "hub_down"
    if not _hci0_up_running():
        return "ble_down"
    # Daemon up + radio up; check it's actually doing work.
    if not _journal_last_event("beekeeper-hub-py", r"\bScan:", SCAN_RECENT_SEC):
        return "ble_down"
    if not _journal_last_event("beekeeper-hub-py", r"Uploaded \d+ readings", UPLOAD_RECENT_SEC):
        return "stale_upload"
    return "healthy"


# ── LED rendering ────────────────────────────────────────────────────────────

class LedRenderer:
    """Owns the top LED's visible state. Only writes to the chip when the
    rendered (state, frame) tuple actually changes — avoids hammering the
    I²C bus when the state is steady."""

    def __init__(self, leds: ADP8866):
        self.leds = leds
        self._last_paint = None   # (state, frame) tuple of what's currently shown

    def render(self, state: str, tick: int) -> None:
        # frame=0 always for steady states; frame alternates 0/1 for blinkers
        if state in ("ble_down",):
            frame = tick % 2
        else:
            frame = 0

        key = (state, frame)
        if key == self._last_paint:
            return
        self._last_paint = key

        try:
            if state == "healthy":
                self.leds.green("top", brightness=B_HEALTHY)
            elif state == "hub_down":
                self.leds.red("top", brightness=B_HUB_DOWN)
            elif state == "stale_upload":
                self.leds.amber("top", brightness=B_STALE)
            elif state == "ble_down":
                if frame == 0:
                    self.leds.red("top", brightness=B_BLE_DOWN)
                else:
                    self.leds.off("top")
            else:
                self.leds.off("top")
        except Exception as e:
            log.warning(f"render({state}): {e}")


def show_startup(leds: ADP8866) -> None:
    """Three blue blinks on the top LED to indicate boot."""
    try:
        for _ in range(3):
            leds.blue("top", brightness=B_STARTUP_PULSE)
            time.sleep(0.4)
            leds.off("top")
            time.sleep(0.3)
    except Exception as e:
        log.warning(f"startup blink: {e}")


# ── Main loop ────────────────────────────────────────────────────────────────

def init_leds() -> ADP8866 | None:
    time.sleep(INIT_SETTLE_SEC)
    try:
        leds = ADP8866()
        log.info("ADP8866 LED driver initialized at /dev/i2c-1 0x27")
        return leds
    except Exception as e:
        log.warning(f"ADP8866 init failed: {e} — LEDs disabled")
        return None


def run() -> None:
    log.info("Starting M1 status-LED daemon (no button interaction)")

    leds = init_leds()
    if leds is not None:
        show_startup(leds)
    renderer = LedRenderer(leds) if leds is not None else None

    state = None
    last_check = 0.0
    tick = 0

    try:
        while True:
            now = time.monotonic()

            # Re-evaluate health periodically (cheap snapshot of system state)
            if last_check == 0.0 or (now - last_check) >= HEALTH_RECHECK_SEC:
                new_state = evaluate_health()
                if new_state != state:
                    log.info(f"state: {state} → {new_state}")
                    state = new_state
                last_check = now

            # Repaint every tick — renderer skips no-op writes itself
            if renderer is not None and state is not None:
                renderer.render(state, tick)

            tick += 1
            time.sleep(LOOP_INTERVAL_SEC)

    except KeyboardInterrupt:
        log.info("Shutting down M1 status-LED daemon")
    finally:
        if leds is not None:
            try:
                leds.close()
            except Exception:
                pass


if __name__ == "__main__":
    run()
