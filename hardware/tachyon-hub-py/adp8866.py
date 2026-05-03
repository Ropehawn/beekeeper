"""
ADP8866 LED driver for the M1 carrier (3 RGB LEDs over I²C).

Channel map (per Particle M1 enclosure docs):
    Top status LED:      R=2, G=1, B=3
    Left side button:    R=5, G=4, B=6
    Right side button:   R=8, G=7, B=9

⚠ PWR_SEL polarity gotcha (see ADP8866_NOTES.md):
    Empirically on this M1 carrier, PWR_SEL bit=1 routes the channel to
    the charge-pump output (VOUT). That is the OPPOSITE of what the
    Particle particle-adp8866 library implies. We MUST write
    PSEL1=0x01 / PSEL2=0xFF (all bits set) to drive the LEDs.
"""

import smbus2


class ADP8866:
    BUS = 1
    ADDR = 0x27

    # Registers
    REG_ID    = 0x00
    REG_MDCR  = 0x01
    REG_PSEL1 = 0x09   # D9PWR (bit 0): 1 = VOUT/charge pump
    REG_PSEL2 = 0x0A   # D1..D8 PWR (bits 0..7): 1 = VOUT/charge pump
    REG_ISCC1 = 0x1A   # SC9_EN at bit 2 (mask 0x04); SC_LAW at bits 0-1
    REG_ISCC2 = 0x1B   # SC1..SC8 enables at bits 0..7
    REG_ISC_BASE = 0x23  # ISC1 = 0x23, ISC9 = 0x2B

    # Brightness is a 7-bit value (0..127)
    BRIGHTNESS_MAX = 0x7F

    # Logical RGB channel map: location -> (R_channel, G_channel, B_channel)
    CHANNELS = {
        "top":   (2, 1, 3),
        "left":  (5, 4, 6),
        "right": (8, 7, 9),
    }

    def __init__(self, bus_num: int = BUS, addr: int = ADDR):
        self._addr = addr
        self._bus = smbus2.SMBus(bus_num)
        # _brightness[ch] is the current 7-bit value per channel; index 0 unused
        self._brightness = [0] * 10
        chip_id = self._bus.read_byte_data(self._addr, self.REG_ID)
        if chip_id != 0x53:
            raise RuntimeError(
                f"ADP8866 not found at 0x{self._addr:02X} on i2c-{bus_num}: "
                f"REG_ID=0x{chip_id:02X} (expected 0x53)"
            )
        self._init_chip()

    # ── Internal helpers ────────────────────────────────────────────────────
    def _w(self, reg: int, val: int) -> None:
        self._bus.write_byte_data(self._addr, reg, val)

    def _init_chip(self) -> None:
        self._w(self.REG_MDCR,  0x20)   # NSTBY=1, exit standby
        self._w(self.REG_PSEL1, 0x01)   # D9 → charge pump
        self._w(self.REG_PSEL2, 0xFF)   # D1..D8 → charge pump
        self.all_off()

    def _update_enables(self) -> None:
        """Set ISCC1/ISCC2 based on which channels currently have brightness > 0."""
        iscc2 = sum(1 << (ch - 1) for ch in range(1, 9) if self._brightness[ch] > 0)
        iscc1 = 0x04 if self._brightness[9] > 0 else 0x00
        self._w(self.REG_ISCC2, iscc2)
        self._w(self.REG_ISCC1, iscc1)

    @staticmethod
    def _clamp(v: int) -> int:
        if v < 0:
            return 0
        if v > ADP8866.BRIGHTNESS_MAX:
            return ADP8866.BRIGHTNESS_MAX
        return v

    # ── Public API ──────────────────────────────────────────────────────────
    def all_off(self) -> None:
        """Turn off every channel and zero every brightness register."""
        self._brightness = [0] * 10
        self._w(self.REG_ISCC1, 0x00)
        self._w(self.REG_ISCC2, 0x00)
        for ch in range(1, 10):
            self._w(self.REG_ISC_BASE + (ch - 1), 0x00)

    def set_channel(self, channel: int, brightness: int) -> None:
        """Set raw brightness on a single sink channel (1..9)."""
        if not 1 <= channel <= 9:
            raise ValueError(f"channel {channel} out of range (1..9)")
        b = self._clamp(brightness)
        self._brightness[channel] = b
        self._w(self.REG_ISC_BASE + (channel - 1), b)
        self._update_enables()

    def set_rgb(self, location: str, r: int, g: int, b: int) -> None:
        """Set RGB brightness for one of the three logical LEDs.

        Args r, g, b are 0..127. Values outside that range are clamped.
        """
        if location not in self.CHANNELS:
            raise ValueError(
                f"unknown location '{location}' (use 'top', 'left', or 'right')"
            )
        ch_r, ch_g, ch_b = self.CHANNELS[location]
        self._brightness[ch_r] = self._clamp(r)
        self._brightness[ch_g] = self._clamp(g)
        self._brightness[ch_b] = self._clamp(b)
        self._w(self.REG_ISC_BASE + (ch_r - 1), self._brightness[ch_r])
        self._w(self.REG_ISC_BASE + (ch_g - 1), self._brightness[ch_g])
        self._w(self.REG_ISC_BASE + (ch_b - 1), self._brightness[ch_b])
        self._update_enables()

    def off(self, location: str) -> None:
        self.set_rgb(location, 0, 0, 0)

    def all_locations_off(self) -> None:
        for loc in self.CHANNELS:
            self.off(loc)

    # ── Convenience colors (sensible default brightness, not blinding) ──────
    def red(self,   location: str, brightness: int = 80) -> None: self.set_rgb(location, brightness, 0, 0)
    def green(self, location: str, brightness: int = 60) -> None: self.set_rgb(location, 0, brightness, 0)
    def blue(self,  location: str, brightness: int = 80) -> None: self.set_rgb(location, 0, 0, brightness)
    def white(self, location: str, brightness: int = 50) -> None: self.set_rgb(location, brightness, brightness, brightness)
    def amber(self, location: str, brightness: int = 80) -> None: self.set_rgb(location, brightness, brightness // 3, 0)

    def close(self) -> None:
        try:
            self.all_off()
        finally:
            try:
                self._bus.close()
            except Exception:
                pass


# ── Animation helpers (blocking — use sparingly in hot paths) ───────────────

def pulse(driver: ADP8866, location: str, color: tuple, cycles: int = 3,
          period_sec: float = 0.8) -> None:
    """Fade up + down `color` (R, G, B max values) on `location`."""
    import time
    steps = 16
    half = period_sec / 2.0
    for _ in range(cycles):
        for i in range(steps):
            t = (i + 1) / steps
            driver.set_rgb(location, int(color[0] * t), int(color[1] * t), int(color[2] * t))
            time.sleep(half / steps)
        for i in range(steps):
            t = 1.0 - (i + 1) / steps
            driver.set_rgb(location, int(color[0] * t), int(color[1] * t), int(color[2] * t))
            time.sleep(half / steps)
    driver.off(location)


def flash(driver: ADP8866, location: str, color: tuple, duration_sec: float = 0.18) -> None:
    """Briefly set `color` on `location`, then turn it off."""
    import time
    driver.set_rgb(location, *color)
    time.sleep(duration_sec)
    driver.off(location)
