#!/usr/bin/env python3
"""
BeeKeeper M1 Panel Daemon

Reacts to the M1 enclosure user button and drives the three RGB status LEDs
on the M1 carrier (ADP8866 at I²C address 0x27 on bus 1).

Sibling to ble_ingestion_daemon.py and camera_capture.py.

LED states:
    startup           → blue pulse on top
    healthy / running → top steady green
    button press      → quick white flash on a side LED
    error fallback    → top steady red

User button:
    The M1 user button is wired in parallel with the Tachyon's power button
    input, so it appears at /dev/input/event2 (pmic_pwrkey) and fires
    KEY_POWER. By default systemd-logind catches this and shuts the hub
    down — we deploy a logind drop-in (see ./logind.conf.d/) that sets
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


# ── LED driver wrapper ───────────────────────────────────────────────────────

# Module-level singleton so click handlers can flash without passing state.
_leds = None


def init_leds():
    """Bring up the ADP8866 driver. Returns the driver or None if unavailable."""
    global _leds
    try:
        from adp8866 import ADP8866
    except ImportError as e:
        log.warning(f"adp8866 module not importable: {e} — LEDs disabled")
        return None
    try:
        _leds = ADP8866()
        log.info("ADP8866 LED driver initialized at /dev/i2c-1 0x27")
        return _leds
    except Exception as e:
        log.warning(f"ADP8866 init failed: {e} — LEDs disabled")
        _leds = None
        return None


def led_state_startup():
    """Three blue pulses on the top LED to indicate boot."""
    if _leds is None:
        return
    try:
        from adp8866 import pulse
        pulse(_leds, "top", color=(0, 0, 80), cycles=3, period_sec=0.8)
    except Exception as e:
        log.warning(f"led_state_startup: {e}")


def led_state_healthy():
    """Top LED steady green — daemon is up, backend services are alive."""
    if _leds is None:
        return
    try:
        _leds.green("top", brightness=40)
    except Exception as e:
        log.warning(f"led_state_healthy: {e}")


def led_state_error():
    """Top LED steady red — something is wrong."""
    if _leds is None:
        return
    try:
        _leds.red("top", brightness=80)
    except Exception as e:
        log.warning(f"led_state_error: {e}")


def led_flash_side(side: str, color: tuple = (50, 50, 50), duration: float = 0.18):
    """Briefly flash one of the side LEDs ('left' or 'right'). After the
    flash, restore the healthy state on the top LED so we're not stuck in
    a transient state if the side LED affected anything else."""
    if _leds is None:
        return
    try:
        from adp8866 import flash
        flash(_leds, side, color, duration_sec=duration)
    except Exception as e:
        log.warning(f"led_flash_side: {e}")


# ── Health probe ─────────────────────────────────────────────────────────────

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


def is_system_healthy(snap: dict) -> bool:
    """Heuristic: BLE daemon up AND scans happening recently."""
    return bool(snap.get("ble_daemon")) and snap.get("sensors_last_scan", 0) > 0


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
    """Single click — log a status snapshot to journald, flash LEFT side LED."""
    led_flash_side("left", color=(50, 50, 50))
    snap = status_snapshot()
    log.info(
        f"STATUS  ble={snap['ble_daemon']}  cam={snap['camera_daemon']}  "
        f"sensors_last_scan={snap['sensors_last_scan']}"
    )


def action_force_upload():
    """Double click — placeholder. Flash RIGHT side LED so the user sees the
    click was registered. Full implementation needs IPC into beekeeper-hub-py
    to trigger an immediate upload."""
    led_flash_side("right", color=(0, 50, 80))
    log.info("force-upload requested (not yet wired into hub-py)")


def action_restart_hub():
    """Long press — graceful restart of the BLE ingestion daemon. Flashes
    BOTH side LEDs amber. Requires sudoers entry (see ./sudoers.d/beekeeper-panel)."""
    if _leds is not None:
        try:
            _leds.amber("left", brightness=80)
            _leds.amber("right", brightness=80)
            time.sleep(0.4)
            _leds.off("left")
            _leds.off("right")
        except Exception as e:
            log.warning(f"led restart-feedback: {e}")
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
    """Very-long press — reprovision mode placeholder. Pulses BLUE on both
    sides so the user sees the mode was triggered."""
    if _leds is not None:
        try:
            from adp8866 import pulse
            pulse(_leds, "left",  color=(0, 0, 90), cycles=2, period_sec=0.6)
            pulse(_leds, "right", color=(0, 0, 90), cycles=2, period_sec=0.6)
        except Exception as e:
            log.warning(f"led reprovision-feedback: {e}")
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
    log.info("Starting M1 panel daemon (button + LED status)")

    # Bring up LEDs as the very first thing the user sees
    init_leds()
    led_state_startup()

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

    last_health_check = 0.0
    last_health_state = None  # "healthy" | "error" | None

    # Set initial state right after startup pulse
    _initial_snap = status_snapshot()
    if is_system_healthy(_initial_snap):
        led_state_healthy()
        last_health_state = "healthy"
    else:
        led_state_error()
        last_health_state = "error"

    try:
        while True:
            now = time.monotonic()

            # Periodic health check — re-evaluate healthy/error state
            if now - last_health_check > HEALTH_PROBE_SEC * 4:  # every ~60s
                snap = status_snapshot()
                healthy = is_system_healthy(snap)
                new_state = "healthy" if healthy else "error"
                if new_state != last_health_state:
                    if healthy:
                        led_state_healthy()
                    else:
                        led_state_error()
                    log.info(f"health state: {last_health_state} → {new_state}")
                    last_health_state = new_state
                else:
                    # keep the LED freshly painted in case anything bumped it
                    if healthy:
                        led_state_healthy()
                    else:
                        led_state_error()
                last_health_check = now
                log.debug(
                    f"health  ble={snap['ble_daemon']}  cam={snap['camera_daemon']}  "
                    f"sensors_last_scan={snap['sensors_last_scan']}"
                )

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
    finally:
        if _leds is not None:
            try:
                _leds.close()
            except Exception:
                pass


if __name__ == "__main__":
    run()
