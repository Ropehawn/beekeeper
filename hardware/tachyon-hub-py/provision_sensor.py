#!/usr/bin/env python3
"""
BeeKeeper Sensor Provisioning Tool

Hold ONE sensor near the Tachyon and run this script. It identifies the
sensor, assigns a sequential ID, generates a QR label, and saves the mapping
to a local registry.

Supported sensor types:
  - Fanstel SC833F (default; Mfr Data company ID 0x0634)
  - BeeKeeper ESP32-C6 node (--c6; Mfr Data company ID 0xFFFF + "BK" sig)

Usage:
  python provision_sensor.py              # auto-assign next SC833F ID
  python provision_sensor.py --id BK-003  # assign specific ID
  python provision_sensor.py --c6         # scan for ESP32-C6 nodes instead
  python provision_sensor.py --list       # show all provisioned sensors
"""

import asyncio
import json
import os
import struct
import sys
import time
from pathlib import Path

REGISTRY_PATH = Path.home() / "beekeeper-ai" / "sensor_registry.json"
LABELS_DIR = Path.home() / "beekeeper-ai" / "labels"
FANSTEL_COMPANY_ID   = 0x0634
BEEKEEPER_COMPANY_ID = 0xFFFF
BEEKEEPER_SIG        = b"BK"

def load_registry():
    if REGISTRY_PATH.exists():
        return json.loads(REGISTRY_PATH.read_text())
    return {"sensors": [], "next_id": 1}

def save_registry(reg):
    REGISTRY_PATH.write_text(json.dumps(reg, indent=2))

def list_sensors(reg):
    if not reg["sensors"]:
        print("No sensors provisioned yet.")
        return
    print(f"\n{'ID':<10} {'MAC':<20} {'UUID':<40} {'Hive':<15} {'Provisioned'}")
    print("-" * 100)
    for s in reg["sensors"]:
        print(f"{s['id']:<10} {s['mac']:<20} {s.get('uuid','?'):<40} {s.get('hive','unassigned'):<15} {s.get('provisioned_at','?')}")
    print()

def generate_label(sensor_id, mac, uuid_short):
    """Generate a QR code label PNG."""
    import qrcode
    from PIL import Image, ImageDraw, ImageFont

    LABELS_DIR.mkdir(exist_ok=True)

    # QR data: JSON with sensor info for easy scanning later
    qr_data = json.dumps({"id": sensor_id, "mac": mac, "uuid": uuid_short})

    qr = qrcode.QRCode(version=1, box_size=8, border=2)
    qr.add_data(qr_data)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")

    # Create label: QR + text below
    qr_w, qr_h = qr_img.size
    label_w = max(qr_w, 280)
    label_h = qr_h + 70
    label = Image.new("RGB", (label_w, label_h), "white")

    # Center QR
    label.paste(qr_img, ((label_w - qr_w) // 2, 0))

    draw = ImageDraw.Draw(label)
    # Use default font (no TTF dependency)
    try:
        font_lg = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
        font_sm = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 12)
    except (OSError, IOError):
        font_lg = ImageFont.load_default()
        font_sm = font_lg

    # Sensor ID — big and bold
    id_bbox = draw.textbbox((0, 0), sensor_id, font=font_lg)
    id_w = id_bbox[2] - id_bbox[0]
    draw.text(((label_w - id_w) // 2, qr_h + 5), sensor_id, fill="black", font=font_lg)

    # MAC — small below
    mac_short = mac[-8:]  # last 4 octets
    mac_bbox = draw.textbbox((0, 0), mac_short, font=font_sm)
    mac_w = mac_bbox[2] - mac_bbox[0]
    draw.text(((label_w - mac_w) // 2, qr_h + 35), mac_short, fill="gray", font=font_sm)

    label_path = LABELS_DIR / f"{sensor_id}.png"
    label.save(str(label_path))
    return label_path

async def scan_for_c6(timeout=10):
    """Scan for BeeKeeper ESP32-C6 nodes, return list sorted by RSSI."""
    from bleak import BleakScanner

    found = {}

    def callback(device, adv_data):
        for cid, data in adv_data.manufacturer_data.items():
            if cid != BEEKEEPER_COMPANY_ID or len(data) < 17:
                continue
            if data[0:2] != BEEKEEPER_SIG:
                continue
            proto_ver = data[2]
            node_type = data[3]
            flags     = data[16]
            # Decode minimum useful info for the picker UI: temp + flags
            temp_c = None
            if flags & 0x01:  # BME present
                temp_raw = struct.unpack_from("<h", data, 4)[0]
                if temp_raw != 0x7FFF:
                    temp_c = temp_raw / 100.0
            key = device.address
            if key not in found or adv_data.rssi > found[key]["rssi"]:
                found[key] = {
                    "mac":       device.address,
                    "rssi":      adv_data.rssi,
                    "proto_ver": proto_ver,
                    "node_type": node_type,
                    "flags":     flags,
                    "temp_c":    temp_c,
                    "vendor":    "tachyon_ble_beekeeper_c6",
                }

    print(f"Scanning for BeeKeeper C6 nodes ({timeout}s)...")
    print("Hold the C6 you want to provision CLOSE to the Tachyon.\n")

    scanner = BleakScanner(detection_callback=callback)
    await scanner.start()
    await asyncio.sleep(timeout)
    await scanner.stop()

    return sorted(found.values(), key=lambda x: x["rssi"], reverse=True)


async def scan_for_fanstel(timeout=10):
    """Scan for Fanstel SC833F sensors, return list sorted by RSSI (strongest first)."""
    from bleak import BleakScanner

    found = {}

    def callback(device, adv_data):
        for cid, data in adv_data.manufacturer_data.items():
            if cid == FANSTEL_COMPANY_ID and len(data) >= 21 and data[0] == 0x02 and data[1] == 0x15:
                uuid = data[2:18].hex()
                uuid_fmt = f"{uuid[:8]}-{uuid[8:12]}-{uuid[12:16]}-{uuid[16:20]}-{uuid[20:]}"
                major = struct.unpack('>H', data[18:20])[0]
                minor = struct.unpack('>H', data[20:22])[0]
                tx_power = struct.unpack('b', bytes([data[22]]))[0]

                key = device.address
                # Keep strongest RSSI reading
                if key not in found or adv_data.rssi > found[key]["rssi"]:
                    found[key] = {
                        "mac": device.address,
                        "uuid": uuid_fmt,
                        "rssi": adv_data.rssi,
                        "temp_c": major,
                        "humidity_pct": minor,
                        "tx_power": tx_power,
                    }

    print(f"Scanning for Fanstel SC833F sensors ({timeout}s)...")
    print("Hold the sensor you want to provision CLOSE to the Tachyon.\n")

    scanner = BleakScanner(detection_callback=callback)
    await scanner.start()
    await asyncio.sleep(timeout)
    await scanner.stop()

    return sorted(found.values(), key=lambda x: x["rssi"], reverse=True)

async def main():
    reg = load_registry()

    # Handle --list
    if "--list" in sys.argv:
        list_sensors(reg)
        return

    # Handle --id
    custom_id = None
    if "--id" in sys.argv:
        idx = sys.argv.index("--id")
        if idx + 1 < len(sys.argv):
            custom_id = sys.argv[idx + 1]

    # Mode: SC833F (default) vs C6 (--c6)
    is_c6 = "--c6" in sys.argv

    # Scan for the requested sensor type.
    if is_c6:
        sensors = await scan_for_c6(timeout=10)
        if not sensors:
            print("No BeeKeeper C6 nodes found. Check power and BLE advertising and try again.")
            return
        print(f"Found {len(sensors)} BeeKeeper C6 node(s):\n")
        print(f"  {'#':<4} {'MAC':<20} {'RSSI':<8} {'Proto':<7} {'Temp':<8} {'Flags'}")
        print(f"  {'-'*65}")
        for i, s in enumerate(sensors):
            already = "  *** ALREADY PROVISIONED" if any(
                x["mac"] == s["mac"] for x in reg["sensors"]
            ) else ""
            temp_str = f"{s['temp_c']:.1f}°C" if s.get("temp_c") is not None else "  --  "
            print(f"  {i+1:<4} {s['mac']:<20} {s['rssi']:<8} v0x{s['proto_ver']:02X}   {temp_str:<8} 0x{s['flags']:02X}{already}")
    else:
        sensors = await scan_for_fanstel(timeout=10)
        if not sensors:
            print("No Fanstel SC833F sensors found. Check battery and try again.")
            return
        print(f"Found {len(sensors)} Fanstel sensor(s):\n")
        print(f"  {'#':<4} {'MAC':<20} {'RSSI':<8} {'Temp':<8} {'Hum':<8} {'UUID (last 4)'}")
        print(f"  {'-'*65}")
        for i, s in enumerate(sensors):
            already = "  *** ALREADY PROVISIONED" if any(
                x["mac"] == s["mac"] or x.get("uuid") == s["uuid"] for x in reg["sensors"]
            ) else ""
            print(f"  {i+1:<4} {s['mac']:<20} {s['rssi']:<8} {s['temp_c']}°C{'':<4} {s['humidity_pct']}%{'':<5} ...{s['uuid'][-4:]}{already}")

    # Auto-select strongest (closest)
    target = sensors[0]
    print(f"\nStrongest signal: {target['mac']} (RSSI {target['rssi']} dBm)")

    # Check if already provisioned
    existing = next(
        (x for x in reg["sensors"]
         if x["mac"] == target["mac"]
         or (not is_c6 and x.get("uuid") == target.get("uuid"))),
        None,
    )
    if existing:
        print(f"This sensor is already provisioned as {existing['id']}.")
        print(f"  MAC: {existing['mac']}")
        if existing.get("uuid"):
            print(f"  UUID: {existing.get('uuid','?')}")
        resp = input("Re-provision with new ID? [y/N]: ").strip().lower()
        if resp != "y":
            return
        reg["sensors"] = [
            x for x in reg["sensors"]
            if x["mac"] != target["mac"]
            and (is_c6 or x.get("uuid") != target.get("uuid"))
        ]

    # Assign ID
    if custom_id:
        sensor_id = custom_id
    else:
        prefix = "C6" if is_c6 else "BK"
        sensor_id = f"{prefix}-{reg['next_id']:03d}"
        reg["next_id"] += 1

    # Save
    entry = {
        "id": sensor_id,
        "mac": target["mac"],
        "vendor": target.get("vendor",
                             "tachyon_ble_beekeeper_c6" if is_c6 else "tachyon_ble_sc833f"),
        "rssi_at_provision": target["rssi"],
        "provisioned_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "hive": "unassigned",
    }
    if is_c6:
        entry["proto_ver_at_provision"] = target["proto_ver"]
        entry["flags_at_provision"]     = target["flags"]
        if target.get("temp_c") is not None:
            entry["temp_c_at_provision"] = target["temp_c"]
    else:
        entry["uuid"] = target["uuid"]
        entry["temp_c_at_provision"]      = target["temp_c"]
        entry["humidity_at_provision"]    = target["humidity_pct"]
    reg["sensors"].append(entry)
    save_registry(reg)

    # Generate label (C6 has no UUID; pass last 4 of MAC)
    uuid_for_label = target.get("uuid", target["mac"].replace(":", ""))[-4:]
    label_path = generate_label(sensor_id, target["mac"], uuid_for_label)

    print(f"\n✅ Provisioned: {sensor_id}")
    print(f"   MAC:  {target['mac']}")
    if is_c6:
        print(f"   Proto: v0x{target['proto_ver']:02X}  Flags: 0x{target['flags']:02X}")
        if target.get("temp_c") is not None:
            print(f"   Temp:  {target['temp_c']:.2f}°C")
    else:
        print(f"   UUID: {target['uuid']}")
        print(f"   Temp: {target['temp_c']}°C  Humidity: {target['humidity_pct']}%")
    print(f"   Label saved: {label_path}")
    print(f"\n   Print the label and stick it on the sensor case.")
    print(f"   Later, assign to a hive: python provision_sensor.py --assign {sensor_id} 'Hive 1'")

if __name__ == "__main__":
    asyncio.run(main())
