# ADP8866 (M1 carrier RGB LEDs) — engineering notes

The M1 enclosure has three RGB LEDs (top status, left side button, right side
button) driven by an Analog Devices ADP8866 9-channel LED driver at I²C
address `0x27` on `/dev/i2c-1` (Tachyon HAT pins 3 and 5).

This file captures the bring-up gotchas. Read it before touching `adp8866.py`.

## Channel map

Per Particle's M1 enclosure docs:

| Location              | R   | G   | B   |
|-----------------------|-----|-----|-----|
| Top status LED        | 2   | 1   | 3   |
| Left side button      | 5   | 4   | 6   |
| Right side button     | 8   | 7   | 9   |

The ADP8866 has 9 sink channels (D1..D9), addressed via `ISC1..ISC9` brightness
registers at `0x23..0x2B` and enabled via `ISCC1`/`ISCC2`.

## Working init sequence

```python
write(0x01, 0x20)   # MDCR.NSTBY = 1 (exit standby; charge pump runs)
write(0x09, 0x01)   # PWR_SEL1: D9 → VOUT (charge pump)
write(0x0A, 0xFF)   # PWR_SEL2: D1..D8 → VOUT (charge pump)

# Per channel:
write(0x23 + (n-1), brightness)   # ISC<n>, 7-bit value 0..0x7F
# Then enable:
#   channels 1..8: ISCC2 (0x1B) bit (n-1) = 1
#   channel 9:     ISCC1 (0x1A) bit 2 = 1   (mask 0x04)
```

## ⚠ Gotcha 1 — `MDCR.NSTBY` is bit 5, not bit 0

Bit 0 of `MDCR` (0x01) is `BL_EN` (backlight enable). `NSTBY` is **bit 5**, mask
`0x20`. Earlier attempts wrote `MDCR = 0x01` thinking that was NSTBY; the chip
stayed in standby, the charge pump never started, and no LEDs lit.

Confirmed by Particle's `particle-adp8866/src/adp8866_regs.h`:

```c
#define ADP8866_MDCR_NSTBY_SHIFT (5)
#define ADP8866_MDCR_BL_EN_SHIFT (0)
```

## ⚠ Gotcha 2 — `SC9_EN` is `ISCC1` bit 2, not bit 0

To enable channel 9 you write `ISCC1 = 0x04`, not `0x01`. Bits 0–1 of `ISCC1`
are `SC_LAW` (sink-current dimming law).

## ⚠ Gotcha 3 — `PWR_SEL` polarity is INVERTED on this carrier

This is the big one and cost us several hours. **Empirically on the M1 carrier
rev shipped with the Tachyon Beekeeper hardware, `PWR_SEL` bit = 1 routes the
channel to the charge-pump output (`VOUT`)**.

That is the OPPOSITE of what Particle's library implies. In their
`select_led_power_source(led, usedChargePump)`:

```c
pwrSel.bits.d9pwr = usedChargePump == false ? 1 : 0;
// implies: bit=1 means VBAT direct, bit=0 means VOUT
```

But on this hardware, writing `PSEL1=0x00, PSEL2=0x00` (the library default)
results in **no visible LEDs**. Writing `PSEL1=0x01, PSEL2=0xFF` lights them.

Theories:
1. The Particle library's inline comment is wrong but the function "works" in
   practice because callers pass `usedChargePump=false` → bit=1, which is the
   actually-correct charge-pump value.
2. The M1 carrier rev wired the LED anodes through the charge-pump output
   while the library was originally written for hardware that wired anodes
   to VBAT direct.

Either way, on **this** hardware, `PSEL bit=1` → VOUT. Always write `0x01`/`0xFF`.

## Hardware confirmed

- Carrier: `M1E Adapter PCBA V1.1` (the Particle docs reference v0.5; this is
  a newer rev)
- All 3 RGB LEDs are physically populated and functional
- The Tachyon SoM's onboard `green` LED at `/sys/class/leds/green/` is NOT
  driven by the ADP8866 — it's a Qualcomm PMIC PWM LED owned by Particle's
  device-OS daemon. We do not touch it.

## Useful registers (subset)

| Reg | Name        | Notes |
|-----|-------------|-------|
| 0x00 | MFDVID     | Returns 0x53 — confirms ADP8866 |
| 0x01 | MDCR       | bit 5 = NSTBY |
| 0x02 | INT_STAT   | Fault flags: ISCOFF, BLOFF, SHORT, TSD, OVP |
| 0x09 | PWR_SEL1   | D9 power source (bit 0). On this carrier: 1=VOUT. |
| 0x0A | PWR_SEL2   | D1..D8 power source. On this carrier: 1=VOUT. |
| 0x1A | ISCC1      | bit 2 = SC9_EN; bits 0–1 = SC_LAW |
| 0x1B | ISCC2      | bits 0–7 = SC1..SC8 enables |
| 0x23..0x2B | ISC1..ISC9 | 7-bit sink current (0..0x7F) |
