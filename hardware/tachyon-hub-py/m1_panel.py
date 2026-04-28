#!/usr/bin/env python3
"""
BeeKeeper M1 Panel Daemon

Reacts to the M1 enclosure user button. Sibling to ble_ingestion_daemon.py
and camera_capture.py.

Status of M1 LEDs:
    The M1 enclosure has 3 RGB LEDs driven by an ADP8866 I²C controller at
    address 0x27 on bus 1. Particle's only published ADP8866 library is
    Device-OS-only (https://github.com/particle-iot/particle-adp8866) and
    won't run on Tachyon Linux. Mainline Linux ships drivers/leds/leds-adp8860.c
    which covers the ADP8866, but the Particle Tachyon kernel build does NOT
    include it (only leds-adp5520 is present in /lib/modules). Until that
    driver is compiled and a device-tree overlay binds it to 0x27, this
    daemon does NOT touch the M1 LEDs. Earlier attempts to drive them by
    raw I²C produced no visible result — see notes in
    ../../hardware/tachyon-hub-py/README.md.

    The /sys/class/leds/{red,green,blue} entries you may see on the system
    are NOT the M1 LEDs — they're the Tachyon SoM's onboard status LED,
    driven by the Qualcomm PMIC PWM and owned by Particle's daemon for
    cloud-connection state. We must not touch them.

User button:
    The M1 user button is wired in parallel with the Tachyon's power button
    input, so it appears at /dev/input/event2 (pmic_pwrkey) and fires
    KEY_POWER. By default systemd-logind catches this and shuts the hub
    down — we deploy a logind drop-in (sudoers.d-style) that sets
    HandlePowerKey=ignore so the daemon can read button presses without
    the OS killing itself.

Click patterns:
    Single click (< 0.6 s)          → log status snapshot to journald
    Double click (two within 0.6 s) → force BLE upload (TODO: IPC into hub-py)
    Long press (≥ 3 s)              → restart beekeeper-hub-py via narrow sudo
    Held ≥ 10 s                     → reserved for re-provision mode
"""

import json
import logging
import os
import select
import subprocess
import sys
import time
from pathlib import Path

# /dev/input/event2 = pmic_pwrkey on the Tachyon — this is where M1 button
# presses surface, because the M1's button shorts the Tachyon power button
# input. Earlier we wrongly listened to event0 (gpio-keys); that's a
# different switch entirely and never fired for the M1 button.
BUTTON_DEVICE = Path("/dev/input/event2")

# Cadence
HEALTH_PROBE_SEC = 15

# Click-pattern timing (seconds)
SHORT_PRESS_MAX = 0.6
DOUBLE_CLICK_GAP = 0.6
LONG_PRESS_THRESHOLD = 3.0
VERY_LONG_PRESS_THRESHOLD = 10.0

# Health classifier inputs
MIN_SENSORS_HEALTHY = 3

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("panel-daemon")


# ── Health probe (used for logging on button press; no LED output yet) ───────

def _systemctl_active(unit: str) -> bool:
    try:
        r = subprocess.run(
            ["systemctl", "is-active", unit],
            capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip() == "active"
    except subprocess.SubprocessError:
        return False


def _journal_recent_scan_count(unit: str = "beekeeper-hub-py", since: str = "2 min ago") -> int:
    try:
        r = subprocess.run(
            ["journalctl", "-u", unit, "--no-pager", "--since", since],
            capture_output=True, text=True, timeout=5,
        )
        last = ""
        for line in r.stdout.splitlines():
            if "Scan: " in line and "sensors" in line:
                last = line
        if not last:
            return 0
        try:
            return int(last.split("Scan: ", 1)[1].split(" ", 1)[0])
        except (IndexError, ValueError):
            return 0
    except subprocess.SubprocessError:
        return -1


def status_snapshot() -> dict:
    return {
        "ble_daemon":    _systemctl_active("beekeeper-hub-py"),
        "camera_daemon": _systemctl_active("beekeeper-camera-py"),
        "panel_daemon":  True,
        "sensors_last_scan": _journal_recent_scan_count(),
    }


# ── Button click pattern detection ───────────────────────────────────────────

class ButtonHandler:
    """State machine for single/double/long click detection."""

    def __init__(self, on_single, on_double, on_long, on_very_long):
        self.on_single = on_single
        self.on_double = on_double
        self.on_long = on_long
        self.on_very_long = on_very_long
        self.press_t0: float | None = None
        self.last_release_t: float | None = None
        self.pending_single_at: float | None = None
        self.long_fired = False
        self.very_long_fired = False

    def on_press(self, t: float):
        self.press_t0 = t
        self.long_fired = False
        self.very_long_fired = False
        # Second click within window cancels pending single, fires double.
        if self.pending_single_at and (t - (self.last_release_t or 0)) < DOUBLE_CLICK_GAP:
            self.pending_single_at = None
            self.last_release_t = None
            log.info("button: double-click")
            try: self.on_double()
            except Exception as e: log.error(f"on_double: {e}")

    def on_release(self, t: float):
        if self.press_t0 is None:
            return
        held = t - self.press_t0
        self.press_t0 = None

        # If long-press already fired during hold, don't also fire single.
        if self.long_fired or self.very_long_fired:
            return

        if held <= SHORT_PRESS_MAX:
            self.pending_single_at = t + DOUBLE_CLICK_GAP
            self.last_release_t = t

    def tick(self, t: float):
        # Long-press detection while held
        if self.press_t0 is not None:
            held = t - self.press_t0
            if not self.very_long_fired and held >= VERY_LONG_PRESS_THRESHOLD:
                self.very_long_fired = True
                log.info("button: very-long press (≥10s)")
                try: self.on_very_long()
                except Exception as e: log.error(f"on_very_long: {e}")
            elif not self.long_fired and held >= LONG_PRESS_THRESHOLD:
                self.long_fired = True
                log.info("button: long press (≥3s)")
                try: self.on_long()
                except Exception as e: log.error(f"on_long: {e}")

        # Pending single fires after the double-click window expires.
        if self.pending_single_at and t >= self.pending_single_at:
            self.pending_single_at = None
            self.last_release_t = None
            log.info("button: single-click")
            try: self.on_single()
            except Exception as e: log.error(f"on_single: {e}")


# ── Button-triggered actions ─────────────────────────────────────────────────

def action_log_status():
    """Single click — log a status snapshot to journald."""
    snap = status_snapshot()
    log.info(
        f"STATUS  ble={snap['ble_daemon']}  cam={snap['camera_daemon']}  "
        f"sensors_last_scan={snap['sensors_last_scan']}"
    )


def action_force_upload():
    """Double click — placeholder. Full implementation needs IPC into
    beekeeper-hub-py to trigger an immediate upload."""
    log.info("force-upload requested (not yet wired into hub-py)")


def action_restart_hub():
    """Long press — graceful restart of the BLE ingestion daemon. Requires
    sudoers entry (see ./sudoers.d/beekeeper-panel)."""
    log.warning("button: restarting beekeeper-hub-py")
    try:
        r = subprocess.run(
            ["sudo", "-n", "systemctl", "restart", "beekeeper-hub-py"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0:
            log.error(f"restart failed: {r.stderr.strip()[:200]}")
        else:
            log.info("beekeeper-hub-py restart issued")
    except subprocess.SubprocessError as e:
        log.error(f"restart subprocess error: {e}")


def action_reprovision_mode():
    log.info("very-long press — reprovision mode placeholder (not implemented)")


# ── Main loop ────────────────────────────────────────────────────────────────

def open_button():
    if not BUTTON_DEVICE.exists():
        log.warning(f"{BUTTON_DEVICE} not present; button events disabled")
        return None
    try:
        from evdev import InputDevice
        dev = InputDevice(str(BUTTON_DEVICE))
        log.info(f"Button device: {dev.name} at {BUTTON_DEVICE}")
        return dev
    except ImportError:
        log.warning("python evdev not installed; button events disabled")
        return None
    except OSError as e:
        log.warning(f"open {BUTTON_DEVICE}: {e}; button events disabled")
        return None


def run():
    log.info("Starting M1 panel daemon (button-only — LED driver not yet built)")
    button = open_button()
    handler = ButtonHandler(
        on_single=action_log_status,
        on_double=action_force_upload,
        on_long=action_restart_hub,
        on_very_long=action_reprovision_mode,
    )

    poll = select.poll()
    if button:
        poll.register(button.fd, select.POLLIN)

    last_health_log = 0.0
    try:
        while True:
            now = time.monotonic()

            # Periodic background log of system state — useful in journalctl
            # so we can see panel daemon health without pressing the button.
            if now - last_health_log > HEALTH_PROBE_SEC * 4:  # every ~60s
                snap = status_snapshot()
                log.debug(
                    f"health  ble={snap['ble_daemon']}  cam={snap['camera_daemon']}  "
                    f"sensors_last_scan={snap['sensors_last_scan']}"
                )
                last_health_log = now

            if button:
                events = poll.poll(100)
                if events:
                    try:
                        from evdev import ecodes
                        for ev in button.read():
                            if ev.type == ecodes.EV_KEY:
                                if ev.value == 1:
                                    handler.on_press(time.monotonic())
                                elif ev.value == 0:
                                    handler.on_release(time.monotonic())
                    except (BlockingIOError, OSError):
                        pass
            else:
                time.sleep(0.1)

            handler.tick(time.monotonic())

    except KeyboardInterrupt:
        log.info("Shutting down panel daemon")


if __name__ == "__main__":
    run()
