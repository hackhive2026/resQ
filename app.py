"""
RapidAid backend — Flask API for the accident-report capture flow.

Endpoints
---------
POST /api/session/start          -> create a new report, returns report_id
POST /api/upload/scene           -> save one "scene" photo   (multipart: image, report_id)
POST /api/upload/victim          -> save one "victim" photo  (multipart: image, report_id)
POST /api/location               -> save reporter's coordinates for a report
POST /api/finalize               -> lock the report, forward scene photos to the AI
                                     verification service, and return its verdict
GET  /api/session/<report_id>    -> current status + counts for a report

Storage
-------
Everything is written to disk under uploads/<report_id>/ :
    uploads/<report_id>/scene/0001.jpg, 0002.jpg, ...
    uploads/<report_id>/victim/0001.jpg, ...
    uploads/<report_id>/report.json      (metadata: location, timestamps, status)

No database is used — this is intentionally simple so it's easy to swap
uploads/report.json for a real DB later without touching the frontend.

AI verification service
------------------------
Set the AI_SERVICE_URL environment variable to point at the model's
/predict endpoint, e.g.:

    export AI_SERVICE_URL="http://192.168.1.15:8000/predict"

If it's not set, this defaults to http://localhost:8000/predict. If the
service is unreachable, /api/finalize still succeeds — it just records
the error per-photo and reports an overall "FAKE"/unverified verdict
rather than crashing the request.
"""

import json
import os
import uuid
import datetime
from pathlib import Path

import requests
from flask import Flask, request, jsonify, render_template
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}
MAX_CONTENT_LENGTH = 15 * 1024 * 1024  # 15 MB per request, generous for a single photo

# AI verification service — configurable via environment variable so the
# repo never hardcodes someone's LAN IP. See module docstring above.
AI_SERVICE_URL = os.environ.get("AI_SERVICE_URL", "http://localhost:8000/predict")
AI_SERVICE_TIMEOUT = float(os.environ.get("AI_SERVICE_TIMEOUT", "10"))

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def now_iso():
    return datetime.datetime.utcnow().isoformat() + "Z"


def report_dir(report_id: str) -> Path:
    return UPLOAD_DIR / secure_filename(report_id)


def report_meta_path(report_id: str) -> Path:
    return report_dir(report_id) / "report.json"


def load_report(report_id: str):
    path = report_meta_path(report_id)
    if not path.exists():
        return None
    with open(path, "r") as f:
        return json.load(f)


def save_report(report_id: str, data: dict):
    with open(report_meta_path(report_id), "w") as f:
        json.dump(data, f, indent=2)


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def next_index(folder: Path) -> int:
    existing = list(folder.glob("*.jpg")) + list(folder.glob("*.jpeg")) + \
        list(folder.glob("*.png")) + list(folder.glob("*.webp"))
    return len(existing) + 1


def handle_photo_upload(category: str):
    """Shared logic for /api/upload/scene and /api/upload/victim."""
    report_id = request.form.get("report_id", "").strip()
    if not report_id:
        return jsonify(error="report_id is required"), 400

    meta = load_report(report_id)
    if meta is None:
        return jsonify(error="unknown report_id — start a session first"), 404

    if meta.get("status") != "capturing":
        return jsonify(error=f"report is '{meta.get('status')}' and no longer accepts photos"), 409

    if "image" not in request.files:
        return jsonify(error="no image file in request"), 400

    image = request.files["image"]
    if image.filename == "":
        return jsonify(error="empty filename"), 400

    # Browser canvas captures usually arrive as capture.jpg — trust the field, not the name.
    ext = "jpg"
    if "." in image.filename and image.filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS:
        ext = image.filename.rsplit(".", 1)[1].lower()

    folder = report_dir(report_id) / category
    folder.mkdir(parents=True, exist_ok=True)

    idx = next_index(folder)
    filename = f"{idx:04d}.{ext}"
    image.save(folder / filename)

    meta.setdefault("photos", {}).setdefault(category, []).append({
        "file": filename,
        "captured_at": now_iso(),
    })
    save_report(report_id, meta)

    return jsonify(
        ok=True,
        category=category,
        count=len(meta["photos"][category]),
        filename=filename,
    )


def verify_scene_photos(report_id: str):
    """POST every saved scene photo to the AI service and summarize its verdicts.

    Never raises — network/service errors are captured per-photo so a
    down or misconfigured AI_SERVICE_URL doesn't break /api/finalize.
    """
    scene_folder = report_dir(report_id) / "scene"
    scene_photos = sorted(scene_folder.glob("*.*"))

    evaluations = []
    is_report_real = False
    max_confidence = 0.0

    for photo_path in scene_photos:
        try:
            with open(photo_path, "rb") as f:
                files = {"file": (photo_path.name, f, "image/jpeg")}
                res = requests.post(AI_SERVICE_URL, files=files, timeout=AI_SERVICE_TIMEOUT)
            if res.status_code == 200:
                eval_data = res.json()
                evaluations.append(eval_data)
                if eval_data.get("verdict") == "REAL":
                    is_report_real = True
                max_confidence = max(max_confidence, eval_data.get("confidence", 0))
            else:
                evaluations.append({
                    "file": photo_path.name,
                    "error": f"AI service returned HTTP {res.status_code}",
                    "verdict": "UNKNOWN",
                    "confidence": 0.0,
                })
        except requests.exceptions.RequestException as e:
            evaluations.append({
                "file": photo_path.name,
                "error": str(e),
                "verdict": "UNKNOWN",
                "confidence": 0.0,
            })

    return {
        "overall_verdict": "REAL" if is_report_real else "UNVERIFIED",
        "max_confidence": max_confidence,
        "evaluations": evaluations,
    }


# --------------------------------------------------------------------------- #
# Page
# --------------------------------------------------------------------------- #

@app.route("/")
def index():
    return render_template("index.html")


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #

@app.route("/api/session/start", methods=["POST"])
def session_start():
    report_id = uuid.uuid4().hex[:10]
    report_dir(report_id).mkdir(parents=True, exist_ok=True)
    meta = {
        "report_id": report_id,
        "status": "capturing",
        "created_at": now_iso(),
        "photos": {"scene": [], "victim": []},
        "location": None,
    }
    save_report(report_id, meta)
    return jsonify(report_id=report_id, status=meta["status"])


@app.route("/api/upload/scene", methods=["POST"])
def upload_scene():
    return handle_photo_upload("scene")


@app.route("/api/upload/victim", methods=["POST"])
def upload_victim():
    return handle_photo_upload("victim")


@app.route("/api/location", methods=["POST"])
def save_location():
    data = request.get_json(silent=True) or {}
    report_id = data.get("report_id", "").strip()
    lat = data.get("lat")
    lng = data.get("lng")
    accuracy = data.get("accuracy")

    if not report_id or lat is None or lng is None:
        return jsonify(error="report_id, lat and lng are required"), 400

    meta = load_report(report_id)
    if meta is None:
        return jsonify(error="unknown report_id"), 404

    meta["location"] = {
        "lat": lat,
        "lng": lng,
        "accuracy_m": accuracy,
        "captured_at": now_iso(),
    }
    save_report(report_id, meta)
    return jsonify(ok=True, location=meta["location"])


@app.route("/api/finalize", methods=["POST"])
def finalize():
    data = request.get_json(silent=True) or {}
    report_id = data.get("report_id", "").strip()

    meta = load_report(report_id)
    if meta is None:
        return jsonify(error="unknown report_id"), 404

    scene_count = len(meta.get("photos", {}).get("scene", []))
    victim_count = len(meta.get("photos", {}).get("victim", []))

    if scene_count == 0 or victim_count == 0:
        return jsonify(error="at least one scene photo and one victim photo are required"), 400
    if meta.get("location") is None:
        return jsonify(error="location has not been captured yet"), 400

    ai_result = verify_scene_photos(report_id)

    meta["status"] = "ai_processed"
    meta["finalized_at"] = now_iso()
    meta["ai_verification"] = ai_result
    save_report(report_id, meta)

    return jsonify(
        ok=True,
        report_id=report_id,
        status=meta["status"],
        verdict=ai_result["overall_verdict"],
        max_confidence=ai_result["max_confidence"],
        summary={
            "scene_photos": scene_count,
            "victim_photos": victim_count,
            "location": meta["location"],
        },
    )


@app.route("/api/session/<report_id>", methods=["GET"])
def session_status(report_id):
    meta = load_report(report_id)
    if meta is None:
        return jsonify(error="unknown report_id"), 404
    return jsonify(meta)


if __name__ == "__main__":
    # Bind to 0.0.0.0 so the site is reachable from a phone on the same
    # network as your dev machine — handy since this app is camera/location
    # heavy and you'll want to test on an actual mobile device.
    app.run(host="0.0.0.0", port=5000, debug=True)
