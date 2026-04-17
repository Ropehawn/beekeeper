#!/usr/bin/env python3
"""
BeeKeeper Sensor Provisioning — Web UI (v4)

Data model: snapshot + append-only events[]
  - QR code = permanent physical identity
  - MAC = transient radio address
  - Events are the source of truth for history
  - Top-level fields are fast-access snapshot of current state

Usage: python provision_web.py → http://<tachyon-ip>:5050
"""

import asyncio
import base64
import csv
import io
import json
import os
import secrets
import struct
import tempfile
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_file, Response

REGISTRY_PATH = Path.home() / "beekeeper-ai" / "sensor_registry.json"
REGISTRY_BACKUP_DIR = Path.home() / "beekeeper-ai" / "registry_backups"
LABELS_DIR = Path.home() / "beekeeper-ai" / "labels"
FANSTEL_COMPANY_ID = 0x0634

# Standardized event types — do not rename
EVENT_TYPES = {"provisioned", "linked", "relinked", "unlinked"}

app = Flask(__name__)

# ── Timestamps ────────────────────────────────────────────────────────────

def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

# ── Registry: atomic file I/O ─────────────────────────────────────────────

def load_registry():
    if REGISTRY_PATH.exists():
        reg = json.loads(REGISTRY_PATH.read_text())
        return migrate_registry(reg)
    return {"sensors": {}, "qr_codes": []}

def save_registry(reg):
    """Atomic write: temp file → fsync → rename. Keeps one rolling backup."""
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    data = json.dumps(reg, indent=2).encode()

    # Write to temp file in same directory (same filesystem for atomic rename)
    fd, tmp_path = tempfile.mkstemp(dir=REGISTRY_PATH.parent, suffix=".tmp")
    try:
        os.write(fd, data)
        os.fsync(fd)
        os.close(fd)

        # Rolling backup
        if REGISTRY_PATH.exists():
            backup = REGISTRY_BACKUP_DIR / f"registry_{int(time.time())}.json"
            REGISTRY_PATH.rename(backup)
            # Keep only last 20 backups
            backups = sorted(REGISTRY_BACKUP_DIR.glob("registry_*.json"))
            for old in backups[:-20]:
                old.unlink()

        # Atomic rename
        os.rename(tmp_path, REGISTRY_PATH)
    except Exception:
        os.close(fd) if not os.get_inheritable(fd) else None
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise

def migrate_registry(reg):
    """Migrate from v3 shape to v4 shape on load. Idempotent."""
    changed = False

    # v3 qr_codes were objects with {id, created_at, linked} — flatten to ID list
    if reg.get("qr_codes") and isinstance(reg["qr_codes"][0], dict):
        reg["qr_codes"] = [q["id"] if isinstance(q, dict) else q for q in reg["qr_codes"]]
        changed = True

    # Remove dead next_id field
    if "next_id" in reg:
        del reg["next_id"]
        changed = True

    # Migrate each sensor to v4 shape
    for sid, s in reg.get("sensors", {}).items():
        if "events" in s:
            continue  # Already v4

        events = []

        # Reconstruct provisioned event
        prov_at = s.get("provisioned_at") or s.get("linked_at") or now_iso()
        events.append({"type": "provisioned", "at": prov_at})

        # Reconstruct link events from mac_history
        for h in s.get("mac_history", []):
            events.append({"type": "linked", "at": prov_at, "mac": h["mac"]})
            events.append({"type": "relinked", "at": h["until"],
                           "old_mac": h["mac"], "new_mac": s.get("mac", "")})

        # If no mac_history, the initial link
        if not s.get("mac_history") and s.get("mac"):
            linked_at = s.get("linked_at", prov_at)
            events.append({"type": "linked", "at": linked_at, "mac": s["mac"],
                           "rssi": s.get("rssi_at_link") or s.get("rssi_at_provision"),
                           "temp_c": s.get("temp_c_at_link") or s.get("temp_c_at_provision"),
                           "humidity": s.get("humidity_at_link") or s.get("humidity_at_provision")})

        # Sort events chronologically
        events.sort(key=lambda e: e["at"])

        # Build clean v4 record
        reg["sensors"][sid] = {
            "sensor_id": sid,
            "mac": s.get("mac"),
            "provisioned_at": prov_at,
            "linked_at": s.get("relinked_at") or s.get("linked_at"),
            "events": events,
        }
        changed = True

    if changed:
        save_registry(reg)

    return reg

def check_invariants(reg):
    """Verify snapshot matches latest events. Repair if needed. Returns list of fixes."""
    fixes = []
    for sid, s in reg.get("sensors", {}).items():
        events = s.get("events", [])

        # Find latest link-related event
        link_events = [e for e in events if e["type"] in ("linked", "relinked")]
        if link_events:
            latest_link = link_events[-1]
            expected_mac = latest_link.get("new_mac") or latest_link.get("mac")
            if s.get("mac") != expected_mac:
                fixes.append(f"{sid}: mac {s.get('mac')} → {expected_mac}")
                s["mac"] = expected_mac
            expected_linked_at = latest_link["at"]
            if s.get("linked_at") != expected_linked_at:
                s["linked_at"] = expected_linked_at

        # Ensure sensor_id matches key
        if s.get("sensor_id") != sid:
            s["sensor_id"] = sid

    if fixes:
        save_registry(reg)
    return fixes

# ── Event helpers ─────────────────────────────────────────────────────────

def append_event(sensor, event):
    """Append event and update snapshot atomically."""
    sensor["events"].append(event)

    if event["type"] == "linked":
        sensor["mac"] = event["mac"]
        sensor["linked_at"] = event["at"]
    elif event["type"] == "relinked":
        sensor["mac"] = event["new_mac"]
        sensor["linked_at"] = event["at"]
    elif event["type"] == "unlinked":
        sensor["mac"] = None
        sensor["linked_at"] = None

def generate_id(length=5):
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return ''.join(secrets.choice(alphabet) for _ in range(length))

# ── BLE Scanning ──────────────────────────────────────────────────────────

def run_ble_scan(timeout=12):
    from bleak import BleakScanner
    found = {}

    def callback(device, adv_data):
        for cid, data in adv_data.manufacturer_data.items():
            if cid == FANSTEL_COMPANY_ID and len(data) >= 21 and data[0] == 0x02 and data[1] == 0x15:
                major = struct.unpack('>H', data[18:20])[0]
                minor = struct.unpack('>H', data[20:22])[0]
                key = device.address
                if key not in found or adv_data.rssi > found[key]["rssi"]:
                    found[key] = {
                        "mac": device.address,
                        "rssi": adv_data.rssi,
                        "temp_c": major,
                        "humidity_pct": minor,
                    }

    async def _scan():
        scanner = BleakScanner(detection_callback=callback)
        await scanner.start()
        await asyncio.sleep(timeout)
        await scanner.stop()

    loop = asyncio.new_event_loop()
    loop.run_until_complete(_scan())
    loop.close()
    return sorted(found.values(), key=lambda x: x["rssi"], reverse=True)

# ── QR Label Generation ──────────────────────────────────────────────────

def generate_label_image(sensor_id):
    import qrcode
    from PIL import Image, ImageDraw, ImageFont

    LABELS_DIR.mkdir(parents=True, exist_ok=True)

    qr = qrcode.QRCode(version=1, box_size=10, border=2, error_correction=qrcode.constants.ERROR_CORRECT_H)
    qr.add_data(sensor_id)
    qr.make(fit=True)
    qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")

    qr_w, qr_h = qr_img.size
    label_w = max(qr_w, 200)
    label_h = qr_h + 50
    label = Image.new("RGB", (label_w, label_h), "white")
    label.paste(qr_img, ((label_w - qr_w) // 2, 0))

    draw = ImageDraw.Draw(label)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 28)
    except (OSError, IOError):
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), sensor_id, font=font)
    tw = bbox[2] - bbox[0]
    draw.text(((label_w - tw) // 2, qr_h + 8), sensor_id, fill="black", font=font)

    label_path = LABELS_DIR / f"{sensor_id}.png"
    label.save(str(label_path))

    buf = io.BytesIO()
    label.save(buf, format="PNG")
    return str(label_path), base64.b64encode(buf.getvalue()).decode()

def generate_batch_sheet(ids):
    import qrcode
    from PIL import Image, ImageDraw, ImageFont

    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
    except (OSError, IOError):
        font = ImageFont.load_default()

    cell_w, cell_h = 200, 240
    cols = 4
    rows = (len(ids) + cols - 1) // cols
    sheet_w = cols * cell_w + 40
    sheet_h = rows * cell_h + 40
    sheet = Image.new("RGB", (sheet_w, sheet_h), "white")
    draw = ImageDraw.Draw(sheet)

    for i, sid in enumerate(ids):
        col = i % cols
        row = i // cols
        x = 20 + col * cell_w
        y = 20 + row * cell_h

        qr = qrcode.QRCode(version=1, box_size=5, border=2, error_correction=qrcode.constants.ERROR_CORRECT_H)
        qr.add_data(sid)
        qr.make(fit=True)
        qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGB")
        qr_w, qr_h = qr_img.size
        sheet.paste(qr_img, (x + (cell_w - qr_w) // 2, y))

        bbox = draw.textbbox((0, 0), sid, font=font)
        tw = bbox[2] - bbox[0]
        draw.text((x + (cell_w - tw) // 2, y + qr_h + 4), sid, fill="black", font=font)
        draw.rectangle([x + 5, y - 5, x + cell_w - 5, y + cell_h - 10], outline="#ccc")

    buf = io.BytesIO()
    sheet.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()

# ── API Routes ────────────────────────────────────────────────────────────

@app.route("/api/generate-qr", methods=["POST"])
def api_generate_qr():
    data = request.json or {}
    count = min(data.get("count", 10), 50)
    length = data.get("length", 5)

    reg = load_registry()
    existing_ids = set(reg["sensors"].keys()) | set(reg["qr_codes"])

    new_ids = []
    for _ in range(count):
        while True:
            sid = generate_id(length)
            if sid not in existing_ids:
                existing_ids.add(sid)
                new_ids.append(sid)
                break

    labels = {}
    for sid in new_ids:
        _, b64 = generate_label_image(sid)
        labels[sid] = b64
        reg["qr_codes"].append(sid)

    save_registry(reg)
    sheet_b64 = generate_batch_sheet(new_ids)
    return jsonify({"ids": new_ids, "labels": labels, "sheet_b64": sheet_b64, "count": len(new_ids)})

@app.route("/api/qr-codes", methods=["GET"])
def api_qr_codes():
    reg = load_registry()
    result = []
    for qr_id in reg["qr_codes"]:
        linked = qr_id in reg["sensors"]
        entry = {"id": qr_id, "linked": linked}
        if linked:
            s = reg["sensors"][qr_id]
            entry["mac"] = s.get("mac")
        result.append(entry)
    return jsonify({"qr_codes": result})

@app.route("/api/scan", methods=["POST"])
def api_scan():
    timeout = request.json.get("timeout", 12) if request.is_json else 12
    reg = load_registry()
    sensors = run_ble_scan(timeout=timeout)

    seen_macs = {s["mac"].upper() for s in sensors}
    scan_by_mac = {s["mac"].upper(): s for s in sensors}

    discovered = []
    adopted = []

    for s in sensors:
        mac_up = s["mac"].upper()
        # Check if any sensor record owns this MAC
        owner = next((sid for sid, sd in reg["sensors"].items()
                       if (sd.get("mac") or "").upper() == mac_up), None)
        if not owner:
            discovered.append(s)

    for sid, sdata in reg["sensors"].items():
        mac_up = (sdata.get("mac") or "").upper()
        is_online = mac_up in seen_macs
        entry = {"sensor_id": sid, **sdata, "online": is_online}
        if is_online:
            hit = scan_by_mac[mac_up]
            entry["rssi"] = hit["rssi"]
            entry["temp_c"] = hit["temp_c"]
            entry["humidity_pct"] = hit["humidity_pct"]
        else:
            entry["rssi"] = None
            entry["temp_c"] = None
            entry["humidity_pct"] = None
        adopted.append(entry)

    unlinked_qrs = [qid for qid in reg["qr_codes"] if qid not in reg["sensors"]]
    return jsonify({"discovered": discovered, "adopted": adopted, "unlinked_qrs": unlinked_qrs})

@app.route("/api/link", methods=["POST"])
def api_link():
    data = request.json
    qr_id = data.get("qr_id")
    mac = data.get("mac")
    temp = data.get("temp_c")
    humidity = data.get("humidity_pct")
    rssi = data.get("rssi")

    if not qr_id or not mac:
        return jsonify({"error": "qr_id and mac required"}), 400

    reg = load_registry()

    # Invariant: one MAC → one sensor ID
    for sid, sdata in reg["sensors"].items():
        if (sdata.get("mac") or "").upper() == mac.upper() and sid != qr_id:
            return jsonify({"error": "mac_already_linked", "existing_id": sid}), 409

    existing = reg["sensors"].get(qr_id)

    if existing and not data.get("relink"):
        return jsonify({"error": "qr_already_linked", "existing_mac": existing.get("mac")}), 409

    if existing:
        # Relink (battery swap)
        old_mac = existing.get("mac")
        append_event(existing, {
            "type": "relinked", "at": now_iso(),
            "old_mac": old_mac, "new_mac": mac,
        })
        save_registry(reg)
        return jsonify({"sensor": existing, "relinked": True, "old_mac": old_mac})
    else:
        # New link — QR must exist in qr_codes
        if qr_id not in reg["qr_codes"]:
            return jsonify({"error": "qr_code_not_found"}), 404

        sensor = {
            "sensor_id": qr_id,
            "mac": None,
            "provisioned_at": now_iso(),
            "linked_at": None,
            "events": [],
        }
        append_event(sensor, {"type": "provisioned", "at": now_iso()})
        append_event(sensor, {
            "type": "linked", "at": now_iso(), "mac": mac,
            "rssi": rssi, "temp_c": temp, "humidity": humidity,
        })
        reg["sensors"][qr_id] = sensor
        save_registry(reg)
        return jsonify({"sensor": sensor, "relinked": False})

@app.route("/api/unlink", methods=["POST"])
def api_unlink():
    data = request.json
    qr_id = data.get("id")
    reg = load_registry()
    sensor = reg["sensors"].get(qr_id)
    if sensor:
        append_event(sensor, {"type": "unlinked", "at": now_iso()})
        del reg["sensors"][qr_id]
    save_registry(reg)
    return jsonify({"ok": True})

@app.route("/api/sensor/<sensor_id>")
def api_sensor_detail(sensor_id):
    """Get full sensor record including events."""
    reg = load_registry()
    sensor = reg["sensors"].get(sensor_id)
    if not sensor:
        return jsonify({"error": "not found"}), 404
    return jsonify({"sensor": sensor})

@app.route("/api/sensors", methods=["GET"])
def api_sensors():
    reg = load_registry()
    return jsonify({"sensors": reg["sensors"]})

@app.route("/api/export-csv")
def api_export_csv():
    """Export registry as CSV."""
    reg = load_registry()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["sensor_id", "mac", "provisioned_at", "linked_at", "event_count"])
    for sid, s in reg["sensors"].items():
        writer.writerow([
            sid, s.get("mac", ""),
            s.get("provisioned_at", ""), s.get("linked_at", ""),
            len(s.get("events", [])),
        ])
    return Response(
        buf.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename=sensor_registry_{int(time.time())}.csv"},
    )

@app.route("/api/label/<sensor_id>")
def api_label(sensor_id):
    path = LABELS_DIR / f"{sensor_id}.png"
    if not path.exists():
        generate_label_image(sensor_id)
    if path.exists():
        return send_file(str(path), mimetype="image/png")
    return jsonify({"error": "label not found"}), 404

# ── Web UI ────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return HTML_PAGE

HTML_PAGE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BeeKeeper — Sensor Provisioning</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e8e8e8; padding: 20px; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.5em; color: #f5a623; }
  h1 small { font-size: 0.5em; color: #666; }
  .subtitle { color: #888; margin-bottom: 20px; font-size: 0.85em; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .card h2 { font-size: 1.05em; margin-bottom: 12px; color: #f5a623; display: flex; align-items: center; gap: 8px; }
  .cnt { background: #333; color: #ccc; font-size: 0.7em; padding: 2px 8px; border-radius: 10px; font-weight: 400; }
  button { background: #f5a623; color: #000; border: none; padding: 9px 18px; border-radius: 8px; font-size: 0.9em; font-weight: 600; cursor: pointer; transition: all 0.15s; }
  button:hover { background: #ffc107; transform: translateY(-1px); }
  button:disabled { background: #555; color: #888; cursor: not-allowed; transform: none; }
  .sm { padding: 5px 12px; font-size: 0.8em; }
  .sec { background: #333; color: #e8e8e8; }
  .sec:hover { background: #444; }
  .red { background: #c62828; color: #fff; }
  .red:hover { background: #e53935; }
  .grn { background: #2e7d32; color: #fff; }
  .grn:hover { background: #43a047; }
  .row { display: flex; align-items: center; gap: 12px; padding: 12px; background: #222; border-radius: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .info { flex: 1; min-width: 180px; }
  .name { font-weight: 600; }
  .mac { font-family: monospace; font-size: 0.8em; color: #666; }
  .readings { display: flex; gap: 12px; font-size: 0.88em; margin-top: 3px; }
  .t { color: #ff6b6b; } .h { color: #48dbfb; } .r { color: #feca57; font-size: 0.8em; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .dot.on { background: #4caf50; box-shadow: 0 0 6px #4caf50; }
  .dot.off { background: #c62828; box-shadow: 0 0 6px #c62828; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; font-weight: 600; }
  .badge.hive { background: #1565c0; color: #fff; }
  .badge.un { background: #444; color: #999; }
  .badge.new { background: #f5a623; color: #000; animation: pulse 2s infinite; }
  .badge.qr { background: #6a1b9a; color: #fff; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.6} }
  .acts { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; }
  .empty { color: #555; text-align: center; padding: 16px; font-size: 0.9em; }
  .spin { display: inline-block; width: 16px; height: 16px; border: 3px solid #555; border-top-color: #f5a623; border-radius: 50%; animation: sp 0.8s linear infinite; margin-right: 6px; vertical-align: middle; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .mo { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,.75); z-index: 100; align-items: center; justify-content: center; }
  .mo.on { display: flex; }
  .md { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 24px; max-width: 500px; width: 92%; max-height: 90vh; overflow-y: auto; }
  .md h3 { margin-bottom: 16px; color: #f5a623; }
  .md label { display: block; color: #888; font-size: 0.85em; margin-bottom: 4px; }
  .md input { width: 100%; padding: 10px; background: #222; border: 1px solid #444; border-radius: 6px; color: #e8e8e8; font-size: 0.95em; margin-bottom: 12px; }
  .md input:focus { border-color: #f5a623; outline: none; }
  .btnr { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .sheet-preview { text-align: center; margin: 12px 0; }
  .sheet-preview img { max-width: 100%; background: #fff; border-radius: 8px; padding: 8px; }
  .qr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; margin-top: 12px; }
  .qr-item { background: #222; border-radius: 8px; padding: 8px; text-align: center; cursor: pointer; border: 2px solid transparent; transition: all 0.15s; }
  .qr-item:hover { border-color: #f5a623; }
  .qr-item.selected { border-color: #f5a623; background: #2a2000; }
  .qr-item.linked { opacity: 0.4; cursor: not-allowed; }
  .qr-item img { width: 80px; height: 80px; background: #fff; border-radius: 4px; }
  .qr-item .qid { font-family: monospace; font-size: 0.85em; margin-top: 4px; font-weight: 600; }
  .hint { color: #666; font-size: 0.8em; margin-top: 6px; }
  .topbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .count-row { display: flex; gap: 16px; font-size: 0.85em; color: #888; }
  .count-row span { color: #f5a623; font-weight: 600; }
  .evt { font-size: 0.78em; color: #888; padding: 3px 0; border-bottom: 1px solid #1a1a1a; display: flex; gap: 8px; }
  .evt .etype { color: #f5a623; min-width: 80px; font-weight: 500; }
  .evt .etime { color: #555; min-width: 140px; }
  .evt-panel { max-height: 200px; overflow-y: auto; margin-top: 8px; }
  .search-box { width: 100%; padding: 8px 12px; background: #222; border: 1px solid #333; border-radius: 6px; color: #e8e8e8; font-size: 0.9em; margin-bottom: 12px; }
  .search-box:focus { border-color: #f5a623; outline: none; }
  .search-box::placeholder { color: #555; }
</style>
</head>
<body>

<h1>BeeKeeper <small>Sensor Provisioning v4</small></h1>
<p class="subtitle">Generate QR stickers, discover BLE sensors, link them together</p>

<!-- QR CODES -->
<div class="card">
  <div class="topbar">
    <h2 style="margin:0;">QR Stickers</h2>
    <div style="display:flex;gap:8px;">
      <button class="sec sm" onclick="location.href='/api/export-csv'">Export CSV</button>
      <button onclick="openGenerate()">Generate New Batch</button>
    </div>
  </div>
  <p class="hint">Generate QR codes, print them, stick on sensor cases. Each becomes a permanent sensor ID.</p>
  <div id="qrList"></div>
</div>

<!-- SCAN + DISCOVER -->
<div class="card">
  <div class="topbar">
    <h2 style="margin:0;">BLE Sensors</h2>
    <button onclick="startScan()" id="scanBtn">Scan</button>
  </div>
  <p class="hint">Discovered sensors appear below. Link them to a QR sticker to adopt.</p>
  <div id="discoveredList" style="margin-top:12px;"></div>
</div>

<!-- ADOPTED / LINKED -->
<div class="card">
  <div class="topbar">
    <h2 style="margin:0;">Linked Sensors <span class="cnt" id="adoptedCount">0</span></h2>
  </div>
  <input type="text" class="search-box" id="searchBox" placeholder="Search by sensor ID or MAC..." oninput="filterAdopted()">
  <div id="adoptedList"><p class="empty">No sensors linked yet.</p></div>
</div>

<!-- GENERATE MODAL -->
<div class="mo" id="genModal">
  <div class="md">
    <h3>Generate QR Stickers</h3>
    <label>How many?</label>
    <input type="number" id="genCount" value="10" min="1" max="50">
    <label>ID length (characters)</label>
    <input type="number" id="genLength" value="5" min="4" max="8">
    <div class="btnr">
      <button class="sec" onclick="closeM('genModal')">Cancel</button>
      <button onclick="submitGenerate()">Generate</button>
    </div>
  </div>
</div>

<!-- LINK MODAL -->
<div class="mo" id="linkModal">
  <div class="md">
    <h3>Link Sensor to QR Code</h3>
    <label>Discovered Sensor</label>
    <input type="text" id="linkMac" readonly style="color:#777;">
    <input type="text" id="linkReading" readonly style="color:#777;">
    <label>Select QR Code to assign</label>
    <div class="qr-grid" id="linkQrGrid"></div>
    <div class="btnr" style="margin-top:16px;">
      <button class="sec" onclick="closeM('linkModal')">Cancel</button>
      <button class="grn" onclick="submitLink()" id="linkBtn" disabled>Link Sensor</button>
    </div>
  </div>
</div>

<!-- RELINK MODAL -->
<div class="mo" id="relinkModal">
  <div class="md">
    <h3>Re-link Sensor (Battery Swap)</h3>
    <p style="color:#888;font-size:0.9em;margin-bottom:12px;">Select the sensor ID printed on the QR sticker. The new MAC will be assigned to it.</p>
    <label>New MAC</label>
    <input type="text" id="relinkMac" readonly style="color:#777;">
    <label>Select existing sensor ID</label>
    <div class="qr-grid" id="relinkQrGrid"></div>
    <div class="btnr" style="margin-top:16px;">
      <button class="sec" onclick="closeM('relinkModal')">Cancel</button>
      <button class="grn" onclick="submitRelink()" id="relinkBtn" disabled>Re-link</button>
    </div>
  </div>
</div>

<!-- LABEL MODAL -->
<div class="mo" id="labelModal">
  <div class="md" style="text-align:center;">
    <h3 id="labelTitle">Sensor Label</h3>
    <div class="sheet-preview"><img id="labelImg" src="" alt="QR Label" style="max-width:220px;"></div>
    <p id="labelInfo" style="color:#888;font-size:0.85em;"></p>
    <div class="btnr" style="justify-content:center;">
      <button onclick="printSingleLabel()">Print</button>
      <button class="sec" onclick="closeM('labelModal')">Close</button>
    </div>
  </div>
</div>

<!-- EVENT LOG MODAL -->
<div class="mo" id="evtModal">
  <div class="md" style="max-width:550px;">
    <h3>Event Log — <span id="evtSensorId"></span></h3>
    <div id="evtList" class="evt-panel"></div>
    <div class="btnr" style="margin-top:12px;">
      <button class="sec" onclick="closeM('evtModal')">Close</button>
    </div>
  </div>
</div>

<!-- SHEET MODAL -->
<div class="mo" id="sheetModal">
  <div class="md" style="max-width:700px;">
    <h3>Print QR Stickers</h3>
    <div class="sheet-preview"><img id="sheetImg" src=""></div>
    <div class="btnr" style="justify-content:center;">
      <button onclick="printSheet()">Print</button>
      <button class="sec" onclick="closeM('sheetModal')">Close</button>
    </div>
  </div>
</div>

<script>
let lastDiscovered = [];
let lastUnlinkedQrs = [];
let lastAdopted = [];
let selectedLinkQr = null;
let selectedRelinkQr = null;
let linkTarget = null;
let relinkTarget = null;

// ── Scan ──
async function startScan() {
  const btn = document.getElementById('scanBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>Scanning...';
  try {
    const r = await fetch('/api/scan', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'});
    const d = await r.json();
    lastUnlinkedQrs = d.unlinked_qrs;
    renderDiscovered(d.discovered);
    lastAdopted = d.adopted;
    renderAdopted(d.adopted);
  } catch(e) { alert('Scan failed: '+e.message); }
  btn.disabled = false;
  btn.textContent = 'Scan';
}

function renderDiscovered(sensors) {
  const el = document.getElementById('discoveredList');
  if (!sensors.length) {
    el.innerHTML = '<p class="empty">No new sensors found.</p>';
    lastDiscovered = [];
    return;
  }
  lastDiscovered = sensors;
  el.innerHTML = sensors.map((s,i) => `
    <div class="row">
      <span class="badge new">NEW</span>
      <div class="info">
        <div class="mac">${s.mac}</div>
        <div class="readings">
          <span class="t">${s.temp_c}°C</span>
          <span class="h">${s.humidity_pct}% RH</span>
          <span class="r">${s.rssi} dBm</span>
        </div>
      </div>
      <div class="acts">
        <button class="grn sm" onclick="openLink(${i})">Link to QR</button>
        <button class="sec sm" onclick="openRelink(${i})">Re-link</button>
      </div>
    </div>`).join('');
}

function renderAdopted(sensors) {
  const el = document.getElementById('adoptedList');
  document.getElementById('adoptedCount').textContent = sensors.length;
  if (!sensors.length) { el.innerHTML = '<p class="empty">No sensors linked yet.</p>'; return; }
  el.innerHTML = sensors.map(s => {
    const readings = s.online
      ? `<span class="t">${s.temp_c}°C</span><span class="h">${s.humidity_pct}%</span><span class="r">${s.rssi}dBm</span>`
      : `<span style="color:#555">offline</span>`;
    const evtCount = (s.events||[]).length;
    return `<div class="row" data-sid="${s.sensor_id}" data-mac="${s.mac||''}">
      <div class="dot ${s.online?'on':'off'}"></div>
      <div class="info">
        <div class="name"><span class="badge qr">${s.sensor_id}</span></div>
        <div class="mac">${s.mac || '(no MAC)'}</div>
        <div class="readings">${readings}</div>
      </div>
      <div class="acts">
        <button class="sec sm" onclick="showLabel('${s.sensor_id}')">Label</button>
        <button class="sec sm" onclick="showEvents('${s.sensor_id}')">${evtCount} events</button>
        <button class="red sm" onclick="unlinkSensor('${s.sensor_id}')">Unlink</button>
      </div>
    </div>`;
  }).join('');
}

function filterAdopted() {
  const q = document.getElementById('searchBox').value.toLowerCase();
  if (!q) { renderAdopted(lastAdopted); return; }
  const filtered = lastAdopted.filter(s =>
    (s.sensor_id||'').toLowerCase().includes(q) ||
    (s.mac||'').toLowerCase().includes(q)
  );
  renderAdopted(filtered);
}

// ── QR Codes ──
async function loadQrCodes() {
  const r = await fetch('/api/qr-codes');
  const d = await r.json();
  const el = document.getElementById('qrList');
  if (!d.qr_codes.length) {
    el.innerHTML = '<p class="empty">No QR codes generated yet.</p>';
    return;
  }
  const linked = d.qr_codes.filter(q=>q.linked).length;
  const free = d.qr_codes.length - linked;
  el.innerHTML = `<div class="count-row" style="margin-bottom:8px;"><span>${d.qr_codes.length}</span> total | <span>${linked}</span> linked | <span>${free}</span> available</div>` +
    '<div class="qr-grid">' + d.qr_codes.map(q => `
      <div class="qr-item ${q.linked?'linked':''}" onclick="${q.linked?'':`showLabel('${q.id}')`}">
        <img src="/api/label/${q.id}" alt="${q.id}">
        <div class="qid">${q.id}</div>
        ${q.linked ? '<div style="color:#4caf50;font-size:0.7em;">linked</div>' : '<div style="color:#888;font-size:0.7em;">available</div>'}
      </div>`).join('') + '</div>';
}

function openGenerate() { document.getElementById('genModal').classList.add('on'); }

async function submitGenerate() {
  const count = parseInt(document.getElementById('genCount').value) || 10;
  const length = parseInt(document.getElementById('genLength').value) || 5;
  closeM('genModal');
  const r = await fetch('/api/generate-qr', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({count, length})});
  const d = await r.json();
  loadQrCodes();
  document.getElementById('sheetImg').src = 'data:image/png;base64,' + d.sheet_b64;
  document.getElementById('sheetModal').classList.add('on');
}

// ── Link ──
function openLink(idx) {
  linkTarget = lastDiscovered[idx];
  selectedLinkQr = null;
  document.getElementById('linkMac').value = linkTarget.mac;
  document.getElementById('linkReading').value = `${linkTarget.temp_c}°C / ${linkTarget.humidity_pct}% RH`;
  document.getElementById('linkBtn').disabled = true;
  const grid = document.getElementById('linkQrGrid');
  if (!lastUnlinkedQrs.length) {
    grid.innerHTML = '<p class="empty">No available QR codes. Generate a batch first.</p>';
  } else {
    grid.innerHTML = lastUnlinkedQrs.map(id => `
      <div class="qr-item" onclick="selectLinkQr(this,'${id}')" data-id="${id}">
        <img src="/api/label/${id}" alt="${id}">
        <div class="qid">${id}</div>
      </div>`).join('');
  }
  document.getElementById('linkModal').classList.add('on');
}

function selectLinkQr(el, id) {
  document.querySelectorAll('#linkQrGrid .qr-item').forEach(e=>e.classList.remove('selected'));
  el.classList.add('selected');
  selectedLinkQr = id;
  document.getElementById('linkBtn').disabled = false;
}

async function submitLink() {
  if (!selectedLinkQr || !linkTarget) return;
  const resp = await fetch('/api/link', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({qr_id: selectedLinkQr, mac: linkTarget.mac,
      temp_c: linkTarget.temp_c, humidity_pct: linkTarget.humidity_pct, rssi: linkTarget.rssi})
  });
  const d = await resp.json();
  closeM('linkModal');
  if (d.error) { alert(d.error === 'mac_already_linked' ? `MAC already linked to ${d.existing_id}` : d.error); return; }
  startScan();
  loadQrCodes();
}

// ── Re-link ──
function openRelink(idx) {
  relinkTarget = lastDiscovered[idx];
  selectedRelinkQr = null;
  document.getElementById('relinkMac').value = relinkTarget.mac;
  document.getElementById('relinkBtn').disabled = true;
  fetch('/api/sensors').then(r=>r.json()).then(d => {
    const grid = document.getElementById('relinkQrGrid');
    const sids = Object.keys(d.sensors);
    if (!sids.length) { grid.innerHTML = '<p class="empty">No existing sensors to re-link.</p>'; return; }
    grid.innerHTML = sids.map(id => `
      <div class="qr-item" onclick="selectRelinkQr(this,'${id}')" data-id="${id}">
        <img src="/api/label/${id}" alt="${id}">
        <div class="qid">${id}</div>
      </div>`).join('');
  });
  document.getElementById('relinkModal').classList.add('on');
}

function selectRelinkQr(el, id) {
  document.querySelectorAll('#relinkQrGrid .qr-item').forEach(e=>e.classList.remove('selected'));
  el.classList.add('selected');
  selectedRelinkQr = id;
  document.getElementById('relinkBtn').disabled = false;
}

async function submitRelink() {
  if (!selectedRelinkQr || !relinkTarget) return;
  const r = await fetch('/api/link', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({qr_id: selectedRelinkQr, mac: relinkTarget.mac,
      temp_c: relinkTarget.temp_c, humidity_pct: relinkTarget.humidity_pct, rssi: relinkTarget.rssi,
      relink: true})});
  const d = await r.json();
  closeM('relinkModal');
  if (d.relinked) alert(`Re-linked! Old MAC: ${d.old_mac} → New: ${relinkTarget.mac}`);
  startScan();
  loadQrCodes();
}

// ── Unlink ──
async function unlinkSensor(id) {
  if (!confirm(`Unlink ${id}? This removes the MAC binding.`)) return;
  await fetch('/api/unlink', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id})});
  startScan();
  loadQrCodes();
}

// ── Event Log ──
async function showEvents(sensorId) {
  document.getElementById('evtSensorId').textContent = sensorId;
  const r = await fetch(`/api/sensor/${sensorId}`);
  const d = await r.json();
  const events = d.sensor?.events || [];
  const el = document.getElementById('evtList');
  if (!events.length) { el.innerHTML = '<p class="empty">No events.</p>'; }
  else {
    el.innerHTML = events.map(e => {
      let detail = '';
      if (e.type === 'linked') detail = `MAC: ${e.mac} (${e.temp_c}°C, ${e.humidity}%)`;
      else if (e.type === 'relinked') detail = `${e.old_mac} → ${e.new_mac}`;
      else if (e.type === 'unlinked') detail = 'MAC removed';
      return `<div class="evt"><span class="etype">${e.type}</span><span class="etime">${e.at}</span><span>${detail}</span></div>`;
    }).join('');
  }
  document.getElementById('evtModal').classList.add('on');
}

// ── Label / Print ──
function showLabel(id) {
  document.getElementById('labelImg').src = `/api/label/${id}`;
  document.getElementById('labelTitle').textContent = id;
  document.getElementById('labelInfo').textContent = id;
  document.getElementById('labelModal').classList.add('on');
}

function printSingleLabel() {
  const img = document.getElementById('labelImg').src;
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(`<html><body style="text-align:center;margin:40px;"><img src="${img}" style="max-width:300px;"><script>setTimeout(()=>window.print(),400)<\/script></body></html>`);
  } else { window.open(img, '_blank'); }
}

function printSheet() {
  const img = document.getElementById('sheetImg').src;
  const win = window.open('', '_blank');
  if (win) {
    win.document.write(`<html><body style="text-align:center;margin:20px;"><img src="${img}" style="max-width:100%;"><script>setTimeout(()=>window.print(),400)<\/script></body></html>`);
  } else { window.location.href = img; }
}

function closeM(id) { document.getElementById(id).classList.remove('on'); }

// ── Init ──
loadQrCodes();
// Load adopted sensors (without scan — just registry, all offline)
fetch('/api/sensors').then(r=>r.json()).then(d => {
  lastAdopted = Object.entries(d.sensors).map(([sid, s]) => ({
    ...s, sensor_id: sid, online: false, rssi: null, temp_c: null, humidity_pct: null
  }));
  renderAdopted(lastAdopted);
});
</script>
</body>
</html>
"""

if __name__ == "__main__":
    LABELS_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY_BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    # Load and migrate registry
    reg = load_registry()

    # Run invariant check on startup
    fixes = check_invariants(reg)
    if fixes:
        print(f"  Invariant repairs: {fixes}")

    print(f"BeeKeeper Sensor Provisioning v4")
    print(f"  Registry: {REGISTRY_PATH}")
    print(f"  Backups:  {REGISTRY_BACKUP_DIR}")
    print(f"  Labels:   {LABELS_DIR}")
    print(f"  Open:     http://192.168.1.146:5050")
    app.run(host="0.0.0.0", port=5050, debug=False)
