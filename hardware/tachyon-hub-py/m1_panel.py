#!/usr/bin/env python3
"""
BeeKeeper M1 Panel Daemon

Drives the M1 enclosure's front RGB indicator LED + listens to the user
button. Sibling to ble_ingestion_daemon.py and camera_capture.py.

Hardware:
  - Front RGB LED:  Qualcomm PMIC PWM channels, exposed as
                    /sys/class/leds/{red,green,blue}/brightness (0-511).
                    No external chip drama — just sysfs writes.
  - User button:    gpio-keys driver, exposed as /dev/input/event0.
                    Read via evdev. Click patterns map to actions.

LED state mapping (driven by systemd unit + recent journal liveness):

    BLE daemon active + sensors ≥3 + camera daemon active   → solid GREEN  (healthy)
    BLE active + sensors <3 OR camera daemon inactive       → solid AMBER  (degraded)
    BLE active but no recent scans                          → flashing AMBER
    BLE daemon failed/restarting                            → flashing RED
    Daemon hasn't reported its first state yet              → soft cyan pulse (booting)

Button click patterns:

    Single click (< 0.6 s)            → log status to journald, blink ack
    Double click (two within 0.6 s)   → force BLE upload (TODO: signal hub-py)
    Long press (≥ 3 s)                → request graceful restart of beekeeper-hub-py
                                       (systemctl restart, requires sudoers entry)
    Held ≥ 10 s                       → reserved for future re-provision mode

Sudo configuration required for restart action:
    /etc/sudoers.d/beekeeper-panel must allow:
      particle ALL=(root) NOPASSWD: /bin/systemctl restart beekeeper-hub-py
"""

import json
import logging
import os
import select
import struct
import subprocess
import sys
import time
from collections import deque
from pathlib import Path

# evdev is the standard linux input-event library; install via
#   pip install evdev
# or apt: python3-evdev. We import lazily so missing-dep failures don't kill
# the LED side of the daemon.

LED_RED   = Path("/sys/class/leds/red/brightness")
LED_GREEN = Path("/sys/class/leds/green/brightness")
LED_BLUE  = Path("/sys/class/leds/blue/brightness")
LED_MAX   = 511

BUTTON_DEVICE = Path("/dev/input/event0")

# Health probe cadence
HEALTH_PROBE_SEC = 15

# Click-pattern timing (seconds)
SHORT_PRESS_MAX = 0.6
DOUBLE_CLICK_GAP = 0.6
LONG_PRESS_THRESHOLD = 3.0
VERY_LONG_PRESS_THRESHOLD = 10.0

# Healthcheck: minimum sensors visible to call the system "fully healthy"
MIN_SENSORS_HEALTHY = 3

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("panel-daemon")


# ── LED control ──────────────────────────────────────────────────────────────

def _write_led(path: Path, value: int):
    """Best-effort sysfs LED brightness write; logs but never raises."""
    try:
        path.write_text(str(max(0, min(LED_MAX, value))))
    except OSError as e:
        log.warning(f"LED write {path}: {e}")


def set_color(r: int, g: int, b: int):
    """Set R/G/B in 0..LED_MAX. Pure off = (0,0,0)."""
    _write_led(LED_RED, r)
    _write_led(LED_GREEN, g)
    _write_led(LED_BLUE, b)


# Symbolic colors (full saturation; fade by halving etc.)
GREEN  = (0, LED_MAX, 0)
AMBER  = (LED_MAX, LED_MAX // 3, 0)   # red + small green
RED    = (LED_MAX, 0, 0)
CYAN   = (0, LED_MAX, LED_MAX)
WHITE  = (LED_MAX, LED_MAX, LED_MAX)
OFF    = (0, 0, 0)
DIM_CYAN = (0, LED_MAX // 4, LED_MAX // 4)


# ── Health probe ─────────────────────────────────────────────────────────────

def _systemctl_active(unit: str) -> bool:
    """True if `systemctl is-active <unit>` returns 'active'."""
    try:
        r = subprocess.run(
            ["systemctl", "is-active", unit],
            capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip() == "active"
    except subprocess.SubprocessError:
        return False


def _journal_recent_scan_count(unit: str = "beekeeper-hub-py", since: str = "2 min ago") -> int:
    """How many scans the BLE daemon has logged in the last <since> minutes,
    and the count of distinct sensors it last saw. Returns -1 on failure."""
    try:
        r = subprocess.run(
            ["journalctl", "-u", unit, "--no-pager", "--since", since],
            capture_output=True, text=True, timeout=5,
        )
        last_scan_line = ""
        for line in r.stdout.splitlines():
            if "Scan: " in line and "sensors" in line:
                last_scan_line = line
        if not last_scan_line:
            return 0
        # "Scan: 5 sensors (SC833F=4, C6=1) — ..."
        # Extract the integer after "Scan: "
        try:
            tail = last_scan_line.split("Scan: ", 1)[1]
            n = int(tail.split(" ", 1)[0])
            return n
        except (IndexError, ValueError):
            return 0
    except subprocess.SubprocessError:
        return -1


class HealthState:
    HEALTHY    = "healthy"
    DEGRADED   = "degraded"
    SCAN_STALE = "scan_stale"
    DOWN       = "down"
    BOOTING    = "booting"


def probe_health() -> str:
    """Classify the system into one of HealthState values."""
    ble_alive    = _systemctl_active("beekeeper-hub-py")
    camera_alive = _systemctl_active("beekeeper-camera-py")  # optional
    if not ble_alive:
        return HealthState.DOWN

    sensor_count = _journal_recent_scan_count("beekeeper-hub-py", since="2 min ago")
    if sensor_count == 0:
        return HealthState.SCAN_STALE  # alive but not scanning yet
    if sensor_count >= MIN_SENSORS_HEALTHY and camera_alive:
        return HealthState.HEALTHY
    return HealthState.DEGRADED  # alive, partially working


# ── LED state machine driven by health ───────────────────────────────────────

class LedDriver:
    """Maintains the current LED state and drives sysfs writes as a function
    of (a) health classification (b) blinking phase (c) any short-lived
    overrides like button-ack flashes."""

    def __init__(self):
        self.state = HealthState.BOOTING
        self.phase_t0 = time.monotonic()
        self.override_until: float = 0.0
        self.override_color: tuple[int, int, int] | None = None

    def set_state(self, state: str):
        if state != self.state:
            log.info(f"LED state: {self.state} → {state}")
        self.state = state
        self.phase_t0 = time.monotonic()

    def set_override(self, color: tuple[int, int, int], duration_sec: float):
        self.override_until = time.monotonic() + duration_sec
        self.override_color = color

    def tick(self):
        """Update the LED hardware to reflect current state."""
        now = time.monotonic()

        if now < self.override_until and self.override_color is not None:
            set_color(*self.override_color)
            return

        elapsed = now - self.phase_t0
        # 1Hz blink phase
        blink_on = (int(elapsed * 2) % 2) == 0  # 4Hz toggle = 2Hz visible

        if self.state == HealthState.HEALTHY:
            set_color(*GREEN)
        elif self.state == HealthState.DEGRADED:
            set_color(*AMBER)
        elif self.state == HealthState.SCAN_STALE:
            set_color(*AMBER if blink_on else OFF)
        elif self.state == HealthState.DOWN:
            set_color(*RED if blink_on else OFF)
        elif self.state == HealthState.BOOTING:
            # Pulse: half-bright cyan, gentle
            set_color(*DIM_CYAN if blink_on else OFF)
        else:
            set_color(*OFF)


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
        # If a pending single is waiting, this might be a double — cancel single
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

        if self.very_long_fired or held >= VERY_LONG_PRESS_THRESHOLD:
            return  # already fired during hold
        if self.long_fired or held >= LONG_PRESS_THRESHOLD:
            return  # already fired during hold

        if held <= SHORT_PRESS_MAX:
            # Defer the single-click action: maybe a double is coming.
            self.pending_single_at = t + DOUBLE_CLICK_GAP
            self.last_release_t = t
        # else: held longer than a short click but not long enough for "long"
        # (between 0.6s and 3s) — we ignore for now.

    def tick(self, t: float):
        # Long-press while held detection
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

        # Pending-single fires after the double-click window expires with no
        # second press.
        if self.pending_single_at and t >= self.pending_single_at:
            self.pending_single_at = None
            self.last_release_t = None
            log.info("button: single-click")
            try: self.on_single()
            except Exception as e: log.error(f"on_single: {e}")


# ── Action handlers (button-triggered) ───────────────────────────────────────

def action_log_status(led: LedDriver):
    """Single click — log a status snapshot + 3 green blinks ack."""
    state = probe_health()
    sensors = _journal_recent_scan_count()
    log.info(
        f"STATUS  state={state}  sensors_last_scan={sensors}  "
        f"ble_active={_systemctl_active('beekeeper-hub-py')}  "
        f"cam_active={_systemctl_active('beekeeper-camera-py')}"
    )
    led.set_override(GREEN, 0.4)


def action_force_upload(led: LedDriver):
    """Double click — placeholder. Full implementation needs an IPC channel
    into beekeeper-hub-py to trigger an immediate upload_readings() call."""
    log.info("force-upload requested (not yet wired into hub-py)")
    led.set_override(WHITE, 0.4)


def action_restart_hub(led: LedDriver):
    """Long press — graceful restart of the BLE ingestion daemon. Requires
    sudoers entry; if the call fails we just blink red briefly."""
    log.warning("button: requesting restart of beekeeper-hub-py")
    led.set_override(AMBER, 1.0)
    try:
        r = subprocess.run(
            ["sudo", "-n", "systemctl", "restart", "beekeeper-hub-py"],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0:
            log.error(f"restart failed: {r.stderr.strip()[:200]}")
            led.set_override(RED, 1.0)
        else:
            log.info("beekeeper-hub-py restart issued")
    except subprocess.SubprocessError as e:
        log.error(f"restart subprocess error: {e}")


def action_reprovision_mode(led: LedDriver):
    log.info("very-long press — reprovision mode placeholder (not implemented)")
    # Cyan blink briefly to acknowledge
    led.set_override(CYAN, 1.0)


# ── Main loop ────────────────────────────────────────────────────────────────

def open_button():
    """Try to open the button input device. Returns evdev InputDevice or None."""
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
    log.info("Starting M1 panel daemon")
    led = LedDriver()
    button = open_button()
    handler = ButtonHandler(
        on_single=lambda: action_log_status(led),
        on_double=lambda: action_force_upload(led),
        on_long=lambda: action_restart_hub(led),
        on_very_long=lambda: action_reprovision_mode(led),
    )

    last_health_probe = 0.0
    poll = select.poll()
    if button:
        poll.register(button.fd, select.POLLIN)

    try:
        while True:
            now = time.monotonic()

            # Health probe (cadenced) — also re-classify on every tick so
            # button overrides don't get re-applied indefinitely.
            if now - last_health_probe > HEALTH_PROBE_SEC:
                state = probe_health()
                led.set_state(state)
                last_health_probe = now

            # Button events (non-blocking, 100ms tick)
            if button:
                events = poll.poll(100)
                if events:
                    try:
                        from evdev import categorize, ecodes
                        for ev in button.read():
                            if ev.type == ecodes.EV_KEY:
                                if ev.value == 1:   # KEY_DOWN
                                    handler.on_press(time.monotonic())
                                elif ev.value == 0: # KEY_UP
                                    handler.on_release(time.monotonic())
                    except (BlockingIOError, OSError):
                        pass
            else:
                time.sleep(0.1)

            handler.tick(time.monotonic())
            led.tick()
    except KeyboardInterrupt:
        log.info("Shutting down — turning LED off")
        set_color(0, LED_MAX // 4, LED_MAX // 4)  # leave dim cyan
    except Exception as e:
        log.error(f"Fatal: {type(e).__name__}: {e}")
        set_color(*RED)
        raise


if __name__ == "__main__":
    run()
