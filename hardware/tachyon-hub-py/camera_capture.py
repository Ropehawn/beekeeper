#!/usr/bin/env python3
"""
BeeKeeper Camera Capture Daemon

Captures stills from the Tachyon's CSI cameras (Arducam IMX519 per
hardware/HARDWARE_SPEC.md §6.2), uploads them to R2 via the
BeeKeeper API's presigned-URL flow, and indexes them in the
camera_captures table.

Sibling to ble_ingestion_daemon.py — runs under the same systemd-managed
user (particle), shares hub-config.json for hub identity + API key.

Capture cadence (v1):
  - One still per camera every CAPTURE_INTERVAL_SEC (default 300s = 5 min)
  - All daylight hours for now (sun calculation deferred until GNSS ships)
  - Burst mode (10s @ 5fps for varroa scans) is stubbed but disabled —
    enabled once on-device YOLO is ready.

Capture stack (probed at startup, lowest-effort that works wins):
  1. libcamera-still / rpicam-still   (libcamera CLI)
  2. gst-launch-1.0 with libcamerasrc (gstreamer pipeline)
  3. v4l2-ctl + v4l2 device           (raw v4l2)
  4. (no-op)                          — daemon stays alive, no captures

If no capture stack is available, the daemon logs why each cycle and
keeps retrying — useful while the IMX519 dtbo overlay is being enabled
on the boot partition (cameras physically wired but kernel can't see them).

Local buffer:
  /var/lib/beekeeper/photos/<hub-id>/<camera-idx>/<timestamp>.jpg
  Survives network outages; uploaded on next successful API connection.
  Cleaned up locally after successful upload + confirm.
"""

import asyncio
import json
import logging
import os
import shutil
import socket
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ── Config ───────────────────────────────────────────────────────────────────

CONFIG_PATH = Path.home() / "beekeeper-ai" / "hub-config.json"
PHOTOS_DIR  = Path("/var/lib/beekeeper/photos")

# Capture cadence
CAPTURE_INTERVAL_SEC = int(os.environ.get("CAPTURE_INTERVAL_SEC", "300"))   # 5 min
CAPTURE_TIMEOUT_SEC  = 30                                                    # max wall-clock per still
DEFAULT_WIDTH        = 2028
DEFAULT_HEIGHT       = 1520
DEFAULT_FORMAT       = "jpeg"
JPEG_QUALITY         = 85

# Cameras: detect dynamically once a capture stack is up; default 2 (CSI0+CSI1)
NUM_CAMERAS_DEFAULT  = 2

# ── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("camera-daemon")


# ── Capture stack detection ──────────────────────────────────────────────────

class CaptureStack:
    """Abstract base for a camera capture backend."""

    name = "abstract"

    def cameras(self) -> list[int]:
        """List of usable camera indices (e.g. [0, 1] for two CSI ports)."""
        return []

    def capture(self, camera_index: int, dest_path: Path,
                width: int, height: int, format: str) -> bool:
        raise NotImplementedError


class LibcameraStillStack(CaptureStack):
    """libcamera-still / rpicam-still CLI. Pi-style, well-supported."""

    name = "libcamera-still"

    def __init__(self, binary: str):
        self.binary = binary
        self._cameras: list[int] | None = None

    def cameras(self) -> list[int]:
        if self._cameras is not None:
            return self._cameras
        try:
            result = subprocess.run(
                [self.binary, "--list-cameras"],
                capture_output=True, text=True, timeout=10,
            )
            # Lines look like "0 : imx519 [4656x3496] (/base/...)"
            cams: list[int] = []
            for line in result.stdout.splitlines():
                line = line.strip()
                if line and line[0].isdigit() and ":" in line:
                    try:
                        cams.append(int(line.split(":", 1)[0].strip()))
                    except ValueError:
                        pass
            self._cameras = cams
            return cams
        except (subprocess.SubprocessError, FileNotFoundError) as e:
            log.debug(f"{self.name} list-cameras failed: {e}")
            self._cameras = []
            return []

    def capture(self, camera_index, dest_path, width, height, format) -> bool:
        cmd = [
            self.binary,
            "--camera",  str(camera_index),
            "--width",   str(width),
            "--height",  str(height),
            "--quality", str(JPEG_QUALITY),
            "--immediate",
            "--nopreview",
            "-o",        str(dest_path),
        ]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=CAPTURE_TIMEOUT_SEC)
            if r.returncode != 0:
                log.warning(f"{self.name} cam={camera_index} failed: {r.stderr.strip()[:200]}")
                return False
            return dest_path.exists() and dest_path.stat().st_size > 0
        except subprocess.SubprocessError as e:
            log.warning(f"{self.name} cam={camera_index} subprocess error: {e}")
            return False


class GstreamerStack(CaptureStack):
    """gst-launch-1.0 with libcamerasrc. Fallback when the CLI tools are absent."""

    name = "gstreamer-libcamerasrc"

    def cameras(self) -> list[int]:
        # Without --list-cameras we can't easily enumerate. Assume 2 if libcamera plugin exists.
        try:
            r = subprocess.run(
                ["gst-inspect-1.0", "libcamerasrc"],
                capture_output=True, text=True, timeout=5,
            )
            if r.returncode == 0:
                return list(range(NUM_CAMERAS_DEFAULT))
        except (subprocess.SubprocessError, FileNotFoundError):
            pass
        return []

    def capture(self, camera_index, dest_path, width, height, format) -> bool:
        # libcamerasrc supports camera-name; index is positional via 0,1 IDs in order.
        # We use a one-shot pipeline: source → JPEG encode → filesink.
        pipeline = (
            f"libcamerasrc camera-name=\"{camera_index}\" num-buffers=1 ! "
            f"video/x-raw,width={width},height={height},format=NV12 ! "
            "videoconvert ! jpegenc quality={q} ! filesink location={dst}"
        ).format(q=JPEG_QUALITY, dst=dest_path)
        try:
            r = subprocess.run(
                ["gst-launch-1.0", "-q"] + pipeline.split(),
                capture_output=True, text=True, timeout=CAPTURE_TIMEOUT_SEC,
            )
            if r.returncode != 0:
                log.warning(f"{self.name} cam={camera_index} failed: {r.stderr.strip()[:200]}")
                return False
            return dest_path.exists() and dest_path.stat().st_size > 0
        except subprocess.SubprocessError as e:
            log.warning(f"{self.name} cam={camera_index} subprocess error: {e}")
            return False


def detect_stack() -> CaptureStack | None:
    """Pick the first capture stack that reports any cameras."""
    for binary in ("libcamera-still", "rpicam-still"):
        if shutil.which(binary):
            stack = LibcameraStillStack(binary)
            if stack.cameras():
                log.info(f"Capture stack: {stack.name} (binary={binary}, cameras={stack.cameras()})")
                return stack
    if shutil.which("gst-launch-1.0"):
        stack = GstreamerStack()
        if stack.cameras():
            log.info(f"Capture stack: {stack.name} (cameras={stack.cameras()})")
            return stack
    log.warning(
        "No capture stack found — install libcamera-tools / rpicam-apps OR "
        "the IMX519 dtbo overlay is not yet enabled. Daemon will keep retrying."
    )
    return None


# ── HTTP helpers ─────────────────────────────────────────────────────────────

def _http_post_json(url: str, headers: dict, payload: dict, timeout=30) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def _http_put_file(url: str, file_path: Path, mime: str, timeout=120) -> int:
    """Upload file to a presigned PUT URL. Returns HTTP status."""
    data = file_path.read_bytes()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": mime, "Content-Length": str(len(data))},
        method="PUT",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        log.warning(f"R2 PUT failed: HTTP {e.code} — {e.read().decode(errors='replace')[:200]}")
        return e.code


# ── Daemon ───────────────────────────────────────────────────────────────────

class CameraCaptureDaemon:
    def __init__(self):
        self.config = json.loads(CONFIG_PATH.read_text())
        self.api_url = self.config["apiUrl"]
        self.api_key = self.config["apiKey"]
        self.hub_id  = self.config["hubId"]
        self.stack: CaptureStack | None = None
        log.info(f"Hub: {self.config.get('hubName', '?')} ({self.hub_id})")
        log.info(f"API: {self.api_url}")
        log.info(f"Capture interval: {CAPTURE_INTERVAL_SEC}s, "
                 f"resolution: {DEFAULT_WIDTH}x{DEFAULT_HEIGHT} {DEFAULT_FORMAT}")

        PHOTOS_DIR.mkdir(parents=True, exist_ok=True)

    # ── Capture cycle ────────────────────────────────────────────────────────

    def capture_one(self, camera_index: int) -> Path | None:
        """Capture a still from one camera; return local file path on success."""
        if not self.stack:
            return None
        captured_at = datetime.now(timezone.utc)
        local_dir = PHOTOS_DIR / self.hub_id / str(camera_index)
        local_dir.mkdir(parents=True, exist_ok=True)
        ts = captured_at.strftime("%Y%m%dT%H%M%SZ")
        local_path = local_dir / f"{ts}.jpg"
        ok = self.stack.capture(
            camera_index, local_path,
            DEFAULT_WIDTH, DEFAULT_HEIGHT, DEFAULT_FORMAT,
        )
        if not ok:
            return None
        size = local_path.stat().st_size
        log.info(f"Captured cam={camera_index} → {local_path.name} ({size:,} bytes)")
        return local_path

    # ── Upload (presigned URL flow, mirrors apps/api/src/routes/hubs.ts) ─────

    def upload_one(self, camera_index: int, local_path: Path) -> bool:
        """
        Three-step upload matching frame_photos R2 flow:
          1. POST /upload-url → get id + storageKey + presigned uploadUrl
          2. PUT bytes directly to R2
          3. POST /confirm    → API HEADs the object and writes file_size_bytes
        Local file is kept until confirm succeeds; deleted after.
        """
        captured_at = datetime.fromtimestamp(local_path.stat().st_mtime, tz=timezone.utc)
        size = local_path.stat().st_size

        # Step 1: get upload URL
        try:
            r = _http_post_json(
                f"{self.api_url}/api/v1/hubs/photos/upload-url",
                {"X-Hub-Key": self.api_key},
                {
                    "cameraIndex":  camera_index,
                    "capturedAt":   captured_at.isoformat().replace("+00:00", "Z"),
                    "width":        DEFAULT_WIDTH,
                    "height":       DEFAULT_HEIGHT,
                    "format":       DEFAULT_FORMAT,
                    "capturePhase": "scheduled",
                    "meta": {
                        "stack":    self.stack.name if self.stack else "unknown",
                        "hostname": socket.gethostname(),
                    },
                },
            )
        except Exception as e:
            log.warning(f"upload-url failed for cam={camera_index}: {e}")
            return False

        capture_id = r["id"]
        upload_url = r["uploadUrl"]

        # Step 2: PUT bytes to R2
        status = _http_put_file(upload_url, local_path, "image/jpeg")
        if status >= 300:
            log.warning(f"R2 PUT for capture {capture_id} returned HTTP {status}")
            return False

        # Step 3: confirm
        try:
            r = _http_post_json(
                f"{self.api_url}/api/v1/hubs/photos/confirm",
                {"X-Hub-Key": self.api_key},
                {"id": capture_id},
            )
        except Exception as e:
            log.warning(f"confirm failed for capture {capture_id}: {e}")
            # Local file kept — confirm can be retried next cycle
            return False

        log.info(f"Uploaded cam={camera_index} ({size:,} B) → capture {capture_id[:8]}…")
        local_path.unlink(missing_ok=True)
        return True

    # ── Drain backlog of un-uploaded local files ─────────────────────────────

    def drain_backlog(self):
        """If a previous cycle's uploads failed (network blip), retry them.
        We try at most 5 per cycle so a big backlog doesn't starve fresh captures."""
        backlog: list[tuple[int, Path]] = []
        hub_dir = PHOTOS_DIR / self.hub_id
        if not hub_dir.exists():
            return
        for cam_dir in sorted(hub_dir.iterdir()):
            if not cam_dir.is_dir() or not cam_dir.name.isdigit():
                continue
            cam_index = int(cam_dir.name)
            for f in sorted(cam_dir.glob("*.jpg")):
                backlog.append((cam_index, f))

        if not backlog:
            return
        log.info(f"Backlog: {len(backlog)} pending uploads")
        for cam_index, f in backlog[:5]:
            self.upload_one(cam_index, f)

    # ── Main loop ────────────────────────────────────────────────────────────

    def run(self):
        log.info("Starting camera capture daemon")
        # Initial stack probe — daemon stays alive even if it returns None;
        # we re-probe each cycle in case dtbo activation happens later.
        self.stack = detect_stack()

        while True:
            try:
                # Re-probe if no stack yet (overlays might have just been enabled)
                if not self.stack:
                    self.stack = detect_stack()

                if self.stack:
                    for cam in self.stack.cameras():
                        local_path = self.capture_one(cam)
                        if local_path:
                            self.upload_one(cam, local_path)

                # Always try to drain any leftover local files.
                self.drain_backlog()

            except KeyboardInterrupt:
                log.info("Shutting down camera daemon")
                break
            except Exception as e:
                log.error(f"Error in main loop: {type(e).__name__}: {e}")

            time.sleep(CAPTURE_INTERVAL_SEC)


if __name__ == "__main__":
    CameraCaptureDaemon().run()
