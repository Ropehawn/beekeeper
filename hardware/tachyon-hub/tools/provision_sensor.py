#!/usr/bin/env python3
"""
BeeKeeper Sensor Provisioning Tool

Hold ONE SC833F sensor near the Tachyon and run this script.
It identifies the sensor, assigns a sequential ID, generates a QR label,
and saves the mapping to a local registry.

Usage:
  python provision_sensor.py              # auto-assign next ID
  python provision_sensor.py --id BK-003  # assign specific ID
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
FANSTEL_COMPANY_ID = 0x0634

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

    # Scan
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
    existing = next((x for x in reg["sensors"] if x["mac"] == target["mac"] or x.get("uuid") == target["uuid"]), None)
    if existing:
        print(f"This sensor is already provisioned as {existing['id']}.")
        print(f"  MAC: {existing['mac']}, UUID: {existing.get('uuid','?')}")
        resp = input("Re-provision with new ID? [y/N]: ").strip().lower()
        if resp != "y":
            return
        reg["sensors"] = [x for x in reg["sensors"] if x.get("uuid") != target["uuid"] and x["mac"] != target["mac"]]

    # Assign ID
    if custom_id:
        sensor_id = custom_id
    else:
        sensor_id = f"BK-{reg['next_id']:03d}"
        reg["next_id"] += 1

    # Save
    entry = {
        "id": sensor_id,
        "mac": target["mac"],
        "uuid": target["uuid"],
        "temp_c_at_provision": target["temp_c"],
        "humidity_at_provision": target["humidity_pct"],
        "rssi_at_provision": target["rssi"],
        "provisioned_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "hive": "unassigned",
    }
    reg["sensors"].append(entry)
    save_registry(reg)

    # Generate label
    label_path = generate_label(sensor_id, target["mac"], target["uuid"][-4:])

    print(f"\n✅ Provisioned: {sensor_id}")
    print(f"   MAC:  {target['mac']}")
    print(f"   UUID: {target['uuid']}")
    print(f"   Temp: {target['temp_c']}°C  Humidity: {target['humidity_pct']}%")
    print(f"   Label saved: {label_path}")
    print(f"\n   Print the label and stick it on the sensor case.")
    print(f"   Later, assign to a hive: python provision_sensor.py --assign {sensor_id} 'Hive 1'")

if __name__ == "__main__":
    asyncio.run(main())
