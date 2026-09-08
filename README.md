# RapidAid — accident report capture

A mobile-and-desktop web app for a bystander to photograph an accident
scene, photograph the injured, share their location, and send everything
to a response team. On send, the backend forwards the scene photos to an
AI verification service and shows the resulting verdict.

## Run it

```bash
pip install -r requirements.txt
python3 app.py
```

Open **http://localhost:5000** on your computer, or **http://<your-computer's-LAN-IP>:5000**
on your phone (same Wi‑Fi network) — you'll want a real phone for testing
the camera and GPS.

Browsers only grant camera/location access on **https://** or **localhost**,
so testing over your phone's browser on plain http from another device on
your LAN will trigger a permission block. For real device testing beyond
localhost, tunnel it with `ngrok http 5000` or deploy behind HTTPS.

## AI verification service

`/api/finalize` forwards each scene photo to an external AI model over
HTTP. Point it at your model's `/predict` endpoint with an environment
variable — **never hardcode an IP in `app.py`**, since it'll be wrong on
every machine but yours:

```bash
export AI_SERVICE_URL="http://192.168.1.15:8000/predict"
python3 app.py
```

If `AI_SERVICE_URL` isn't set, it defaults to `http://localhost:8000/predict`.
If the service is unreachable or errors, `/api/finalize` still succeeds —
the report is saved with an "UNVERIFIED" verdict and the per-photo error
recorded in `report.json`, rather than the request failing outright.

The AI service is expected to accept a multipart `file` upload and return
JSON shaped like:

```json
{ "verdict": "REAL", "confidence": 87.5 }
```

## How the flow works

1. **Report an accident** → `POST /api/session/start` creates a `report_id`.
2. **Scene photos** → camera opens (`getUserMedia`), each shutter press adds
   a thumbnail; "Continue" is disabled until at least one photo exists.
3. **Victim photos** → same capture screen, second category.
4. **Location** → `navigator.geolocation.getCurrentPosition` requests
   permission and reads coordinates.
5. **Review & send** → each photo is POSTed to `/api/upload/scene` or
   `/api/upload/victim` (multipart), location to `/api/location`, then
   `/api/finalize` locks the report, calls the AI service, and returns
   a verdict + confidence shown on the success screen.

## Where things are stored

```
uploads/<report_id>/scene/0001.jpg
uploads/<report_id>/victim/0001.jpg
uploads/<report_id>/report.json   <- location, timestamps, status, AI verdicts
```

No database — `report.json` is the single source of truth per report,
so it's a straightforward swap to Postgres/S3 later. The `uploads/`
folder is git-ignored; it's created automatically on first run.

## Next steps (beyond this build)

- Add authentication/rate limiting before this goes anywhere public —
  right now anyone can POST to these endpoints.
- Add resumable/retrying uploads for poor-signal areas (common at accident
  scenes).
- Compress images client-side before upload if cellular data is a concern.
- Replace the synchronous per-photo AI calls in `/api/finalize` with an
  async queue if the model is slow, so the request doesn't block on it.
