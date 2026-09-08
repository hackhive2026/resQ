/**
 * RapidAid capture flow.
 *
 * State machine: landing -> capture(scene) -> capture(victim) -> location
 *                -> review -> (upload) -> success
 */

// Define your backend server URL here (e.g., your Render HTTPS URL or Ngrok tunnel)
const API_BASE_URL = "https://resqser.onrender.com/";

const state = {
  reportId: null,
  stream: null,
  facingMode: "environment",
  currentCategory: null, // "scene" | "victim"
  shots: { scene: [], victim: [] }, // { blob, url }
  location: null,
};

const els = {};
document.querySelectorAll("[id]").forEach((el) => (els[el.id] = el));

const CATEGORY_CONFIG = {
  scene: {
    title: "Photograph the scene",
    hint: "Capture wide shots of the whole area — vehicles, road signs, skid marks. Take as many as you need.",
    step: 1,
    nextScreen: () => showCapture("victim"),
  },
  victim: {
    title: "Photograph the injured",
    hint: "Move closer. Capture clear, well-lit photos of each injured person so responders can assess them before arriving.",
    step: 2,
    nextScreen: () => showScreen("screen-location"),
  },
};

// ------------------------------------------------------------------------ //
// Screen management
// ------------------------------------------------------------------------ //

function showScreen(id) {
  document.querySelectorAll("[data-screen]").forEach((s) => s.classList.remove("is-active"));
  const target = document.getElementById(id);
  if (target) {
    target.classList.add("is-active");
  }
  window.scrollTo(0, 0);
}

function toast(msg) {
  if (!els.toast) return;
  els.toast.textContent = msg;
  els.toast.classList.add("is-visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove("is-visible"), 3200);
}

// ------------------------------------------------------------------------ //
// Session
// ------------------------------------------------------------------------ //

async function startSession() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/session/start`, { method: "POST" });
    const data = await res.json();
    state.reportId = data.report_id;
  } catch (err) {
    toast("Couldn't reach the server. Check your connection and try again.");
    throw err;
  }
}

// ------------------------------------------------------------------------ //
// Camera
// ------------------------------------------------------------------------ //

async function openCamera() {
  stopCamera();
  if (els["camera-error"]) els["camera-error"].hidden = true;

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.facingMode }
    });

    if (els.video) {
      els.video.srcObject = state.stream;
      await els.video.play().catch(() => {});
    }

    // Hide the overlay prompt once camera is running
    if (els["camera-overlay"]) {
      els["camera-overlay"].hidden = true;
    }
  } catch (err) {
    console.error("Camera access failed:", err);
    if (els["camera-error"]) els["camera-error"].hidden = false;
    if (els["camera-overlay"]) els["camera-overlay"].hidden = true;
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  if (els.video) {
    els.video.srcObject = null;
  }
}

function capturePhoto() {
  const video = els.video;
  if (!video || !video.videoWidth) return;

  const canvas = els.canvas;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  canvas.toBlob(
    (blob) => {
      const url = URL.createObjectURL(blob);
      state.shots[state.currentCategory].push({ blob, url });
      renderFilmstrip();
      flashShutter();
    },
    "image/jpeg",
    0.9
  );
}

function flashShutter() {
  if (els["btn-shutter"]) {
    els["btn-shutter"].style.transform = "scale(0.85)";
    setTimeout(() => (els["btn-shutter"].style.transform = ""), 100);
  }
}

function renderFilmstrip() {
  const shots = state.shots[state.currentCategory];
  if (!els.filmstrip) return;
  els.filmstrip.innerHTML = "";
  shots.forEach((shot) => {
    const img = document.createElement("img");
    img.src = shot.url;
    img.className = "filmstrip__thumb";
    img.alt = "Captured photo";
    els.filmstrip.appendChild(img);
  });
  if (els["btn-capture-continue"]) {
    els["btn-capture-continue"].disabled = shots.length === 0;
  }
}

function renderProgressDots(step) {
  document.querySelectorAll(".capture__progress-dot").forEach((dot) => {
    const dotStep = Number(dot.dataset.step);
    dot.classList.toggle("is-done", dotStep < step);
    dot.classList.toggle("is-current", dotStep === step);
  });
}

function showCapture(category) {
  state.currentCategory = category;
  const cfg = CATEGORY_CONFIG[category];
  if (els["capture-title"]) els["capture-title"].textContent = cfg.title;
  if (els["capture-hint"]) els["capture-hint"].textContent = cfg.hint;
  renderProgressDots(cfg.step);
  renderFilmstrip();
  showScreen("screen-capture");
  openCamera();
}

// ------------------------------------------------------------------------ //
// Location
// ------------------------------------------------------------------------ //

function requestLocation() {
  const statusEl = els["location-status"];
  if (!statusEl) return;
  statusEl.textContent = "Getting your location…";
  statusEl.className = "location__status";

  if (!("geolocation" in navigator)) {
    statusEl.textContent = "This browser can't share location. You can still send the report.";
    statusEl.classList.add("is-error");
    if (els["btn-location-continue"]) els["btn-location-continue"].hidden = false;
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.location = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      };
      statusEl.textContent = `Location shared (accurate to ${Math.round(pos.coords.accuracy)} m).`;
      statusEl.classList.add("is-ok");
      if (els["btn-share-location"]) els["btn-share-location"].hidden = true;
      if (els["btn-location-continue"]) els["btn-location-continue"].hidden = false;
    },
    (err) => {
      statusEl.textContent =
        err.code === err.PERMISSION_DENIED
          ? "Location permission was denied. Enable it in your browser settings, then try again."
          : "Couldn't get your location. Try again, or continue without it.";
      statusEl.classList.add("is-error");
      if (els["btn-location-continue"]) els["btn-location-continue"].hidden = false;
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ------------------------------------------------------------------------ //
// Review + upload
// ------------------------------------------------------------------------ //

function renderReview() {
  if (els["summary-scene"]) els["summary-scene"].textContent = state.shots.scene.length;
  if (els["summary-victim"]) els["summary-victim"].textContent = state.shots.victim.length;
  if (els["summary-location"]) {
    els["summary-location"].textContent = state.location
      ? `${state.location.lat.toFixed(5)}, ${state.location.lng.toFixed(5)}`
      : "Not shared";
  }
}

async function uploadOne(category, shot) {
  const form = new FormData();
  form.append("report_id", state.reportId);
  form.append("image", shot.blob, "capture.jpg");
  const res = await fetch(`${API_BASE_URL}/api/upload/${category}`, { method: "POST", body: form });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Upload failed for ${category} photo`);
  }
}

async function sendReport() {
  const allShots = [
    ...state.shots.scene.map((s) => ({ category: "scene", shot: s })),
    ...state.shots.victim.map((s) => ({ category: "victim", shot: s })),
  ];

  if (allShots.length === 0) {
    toast("Add at least one photo before sending.");
    return;
  }

  if (els["btn-send"]) els["btn-send"].disabled = true;
  if (els["upload-progress"]) els["upload-progress"].hidden = false;

  try {
    // 1. Location first
    if (state.location) {
      await fetch(`${API_BASE_URL}/api/location`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report_id: state.reportId,
          lat: state.location.lat,
          lng: state.location.lng,
          accuracy: state.location.accuracy,
        }),
      });
    }

    // 2. Photos
    for (let i = 0; i < allShots.length; i++) {
      const { category, shot } = allShots[i];
      if (els["upload-progress-label"]) {
        els["upload-progress-label"].textContent = `Uploading photo ${i + 1} of ${allShots.length}…`;
      }
      if (els["upload-progress-fill"]) {
        els["upload-progress-fill"].style.width = `${Math.round(((i) / allShots.length) * 100)}%`;
      }
      await uploadOne(category, shot);
    }

    if (els["upload-progress-fill"]) els["upload-progress-fill"].style.width = "100%";
    if (els["upload-progress-label"]) els["upload-progress-label"].textContent = "Handing off to the response team…";

    // 3. Finalize
    const res = await fetch(`${API_BASE_URL}/api/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ report_id: state.reportId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not finalize the report");

    els["case-id"].textContent = state.reportId;

    const banner = document.getElementById("ai-verdict-banner");
    if (banner && data.verdict) {
      const isReal = data.verdict === "REAL";
      banner.innerHTML = `
        <div style="background: ${isReal ? '#1F8A5F' : '#E8420C'}; color: #fff; padding: 14px; border-radius: 6px; text-align: center;">
          <h3 style="margin: 0; font-family: var(--font-display); font-size: 1.3rem;">
            ${isReal ? '🚨 ACCIDENT VERIFIED (REAL)' : '⚠️ VERIFIED (FAKE ALERT)'}
          </h3>
          <p style="margin: 4px 0 0; font-size: 0.9rem;">Confidence: <strong>${data.max_confidence}%</strong></p>
        </div>`;
    }

    showScreen("screen-success");
  } catch (err) {
    toast(err.message || "Something went wrong while sending. Please try again.");
  } finally {
    if (els["btn-send"]) els["btn-send"].disabled = false;
    if (els["upload-progress"]) els["upload-progress"].hidden = true;
    if (els["upload-progress-fill"]) els["upload-progress-fill"].style.width = "0%";
  }
}

function resetState() {
  Object.values(state.shots.scene).forEach((s) => URL.revokeObjectURL(s.url));
  Object.values(state.shots.victim).forEach((s) => URL.revokeObjectURL(s.url));
  state.reportId = null;
  state.shots = { scene: [], victim: [] };
  state.location = null;
  if (els["btn-share-location"]) els["btn-share-location"].hidden = false;
  if (els["btn-location-continue"]) els["btn-location-continue"].hidden = true;
  if (els["location-status"]) {
    els["location-status"].textContent = "";
    els["location-status"].className = "location__status";
  }
}

// ------------------------------------------------------------------------ //
// Wire up events
// ------------------------------------------------------------------------ //

if (els["btn-start"]) {
  els["btn-start"].addEventListener("click", async () => {
    els["btn-start"].disabled = true;
    els["btn-start"].textContent = "Starting…";
    try {
      await startSession();
      showCapture("scene");
    } finally {
      els["btn-start"].disabled = false;
      els["btn-start"].textContent = "Report an accident";
    }
  });
}

if (els["btn-allow-camera"]) {
  els["btn-allow-camera"].addEventListener("click", openCamera);
}

if (els["btn-shutter"]) {
  els["btn-shutter"].addEventListener("click", capturePhoto);
}

if (els["btn-switch-camera"]) {
  els["btn-switch-camera"].addEventListener("click", () => {
    state.facingMode = state.facingMode === "environment" ? "user" : "environment";
    openCamera();
  });
}

if (els["btn-retry-camera"]) {
  els["btn-retry-camera"].addEventListener("click", openCamera);
}

if (els["btn-capture-continue"]) {
  els["btn-capture-continue"].addEventListener("click", () => {
    stopCamera();
    CATEGORY_CONFIG[state.currentCategory].nextScreen();
  });
}

if (els["btn-share-location"]) {
  els["btn-share-location"].addEventListener("click", requestLocation);
}

if (els["btn-location-continue"]) {
  els["btn-location-continue"].addEventListener("click", () => {
    renderReview();
    showScreen("screen-review");
  });
}

if (els["btn-back-to-capture"]) {
  els["btn-back-to-capture"].addEventListener("click", () => showCapture("scene"));
}

if (els["btn-send"]) {
  els["btn-send"].addEventListener("click", sendReport);
}

if (els["btn-new-report"]) {
  els["btn-new-report"].addEventListener("click", () => {
    resetState();
    showScreen("screen-landing");
  });
}

document.addEventListener("visibilitychange", () => {
  const captureEl = document.getElementById("screen-capture");
  if (document.hidden) {
    stopCamera();
  } else if (captureEl && captureEl.classList.contains("is-active")) {
    openCamera();
  }
});
