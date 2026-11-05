/*
 * Road Scan — recorder PWA logic.
 *
 * Physics of the roughness score:
 *  - DeviceMotion gives us accelerationIncludingGravity. We estimate gravity
 *    with a slow exponential low-pass filter on each axis and subtract it,
 *    leaving dynamic (bump) acceleration in the phone's frame.
 *  - We project that onto the estimated vertical axis (unit gravity vector)
 *    to get vertical jerk/bump amplitude, insensitive to phone orientation.
 *  - Per 1-second window we take RMS of the vertical signal → a 0–100
 *    "roughness" score (calibrated ~ IRI-like proxy: smooth asphalt ≲ 10,
 *    broken/potholed road ≳ 60).
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    score: $('score'), status: $('statusLine'), gps: $('gpsStatus'),
    sensor: $('sensorStatus'), uploads: $('uploadCount'),
    filtered: $('filterCount'), evHz: $('evHz'), diag: $('diag'),
    start: $('startBtn'), stop: $('stopBtn'), spark: $('spark')
  };

  const state = {
    recording: false,
    motionHandler: null,
    geoWatch: null,
    lastFix: null,        // {lat, lon, speed, at}
    hpPrev: 0,            // high-pass filter state
    verticalPrev: 0,      // previous vertical sample (for the HP filter)
    scoreBuf: { dyn: [], hp: [] }, // vertical residual + road-band samples this second
    winGood: 0,           // samples passing sanity this second
    winBad: 0,            // samples rejected this second (spikes / unstable gravity)
    windowScores: [],     // last 120 one-second scores, for chart
    pending: [],          // batched readings awaiting upload
    uploaded: 0,
    filtered: 0,          // total samples rejected locally
    motionEvents: 0,      // raw devicemotion events received
    lastEvTotal: 0,       // for events/sec display
    nullApg: 0,           // events with no usable accelerationIncludingGravity
    fallbackSensor: null, // Generic Sensor API accelerometer (Android fallback)
    deviceId: 'dev-' + Math.random().toString(36).slice(2, 10),
    uploadTimer: null,
    alpha: 0.05           // low-pass factor for gravity estimate (~2 s @ 10Hz)
  };

  // Sanity gates (tuned against 9.81 m/s² gravity and typical vehicle dynamics)
  const G_MIN = 6.5;      // |gravity| much lower ⇒ phone moving oddly / sensors lying
  const G_MAX = 15;       // |gravity| much higher ⇒ fast rotation / bounce / drop
  const SPIKE_MAX = 80;   // m/s² single-sample vertical spike — raised to allow hard pothole impacts
  const FIX_ACC_MAX = 50; // m  — bad GPS fixes anchor readings to the wrong street
  const FIX_MAX_AGE = 10_000; // ms — a fix older than this is too stale to sample
  const SPEED_MIN = 1.0;  // m/s — stationary noise must not enter the dataset
  const SPEED_MAX = 40;   // m/s ≈ 144 km/h

  /* ---------------------------- gravity + scoring ---------------------------- */

  const grav = { x: 0, y: 0, z: 0, init: false };

  /* The actual measurement pipeline for one acceleration sample
   * (frame: device, units m/s², including gravity). Called by both the
   * devicemotion path and the Generic Sensor API fallback. */
  function handleSample(a) {
    if (!a || a.x == null) return;
    if (!grav.init) {
      // Prime the filter with the first reading (assume phone reasonably still)
      grav.x = a.x; grav.y = a.y; grav.z = a.z; grav.init = true;
      return;
    }
    // low-pass gravity estimate, high-pass dynamic signal
    grav.x += state.alpha * (a.x - grav.x);
    grav.y += state.alpha * (a.y - grav.y);
    grav.z += state.alpha * (a.z - grav.z);
    const dx = a.x - grav.x, dy = a.y - grav.y, dz = a.z - grav.z;
    // unit gravity vector = phone's vertical axis
    const gm = Math.hypot(grav.x, grav.y, grav.z);
    if (gm < G_MIN || gm > G_MAX) {
      // Gravity magnitude off from 9.81: phone dropped/flipped/sliding — trust nothing this sample
      state.winBad++;
      state.filtered++;
      return;
    }
    const ux = grav.x / gm, uy = grav.y / gm, uz = grav.z / gm;
    const vertical = dx * ux + dy * uy + dz * uz; // m/s² along gravity axis
    // Soft spike handling: allow large spikes in the HIGH-PASS (road) band
    // but still reject extreme raw spikes. Potholes are impulsive → they survive HP.
    const isExtremeRaw = Math.abs(vertical) > 120;
    if (isExtremeRaw) {
      state.winBad++;
      state.filtered++;
      return;
    }
    state.winGood++;

    // One-pole high-pass (fc ≈ 4 Hz): pothole/road vibration is impulsive at
    // 5–15 Hz; steps, arm swing and slow sway live at 1–2 Hz and are removed,
    // so the score measures road-like energy instead of body motion.
    // y[i] = α·(y[i-1] + x[i] − x[i-1]),  α = e^(−2π·fc/fs) ≈ 0.66 @ 60 Hz, 4 Hz
    const HP_ALPHA = 0.66;
    const hp = HP_ALPHA * (state.hpPrev + vertical - state.verticalPrev);
    state.verticalPrev = vertical;
    state.hpPrev = hp;
    state.scoreBuf.dyn.push(vertical);
    state.scoreBuf.hp.push(hp);
  }

  function feedMotion(e) {
    state.motionEvents++;
    if (!state.canSample) return;
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) { state.nullApg++; return; }
    handleSample({ x: a.x, y: a.y, z: a.z });
  }

  function startFallbackSensor() {
    if (state.fallbackSensor) return;
    if (typeof Accelerometer === 'undefined') return;
    try {
      const s = new Accelerometer({ frequency: 60, referenceFrame: 'device' });
      s.addEventListener('reading', () => {
        state.motionEvents++;
        if (!state.canSample) return;
        handleSample({ x: s.x, y: s.y, z: s.z });
      });
      s.addEventListener('error', () => {
        els.sensor.textContent = 'blocked';
        els.status.textContent = 'Motion sensor blocked by the browser/OS.';
      });
      s.start();
      state.fallbackSensor = s;
      els.sensor.textContent = 'on (fallback)';
      els.status.textContent = 'Using fallback accelerometer (Generic Sensor API).';
    } catch {
      els.sensor.textContent = 'unavailable';
    }
  }

  function watchMotionHealth() {
    // after 4 s without a live stream, panic-switch to the fallback path
    if (state.recording && state.hzNow < 2 && !state.fallbackSensor) {
      startFallbackSensor();
    }
  }

  function windowScore() {
    const dyn = state.scoreBuf.dyn;
    const hp = state.scoreBuf.hp;
    state.scoreBuf.dyn = [];
    state.scoreBuf.hp = [];
    const { winGood, winBad } = state;
    state.winGood = 0;
    state.winBad = 0;
    // Window quality gate: need enough clean samples, and most samples must
    // have passed sanity checks (e.g. phone held still while spinning fails here)
    // Relax gate: allow shorter windows and tolerate more "bad" samples during impacts
    if (dyn.length < 3 || winGood < 3 || winGood / (winGood + winBad) < 0.5) {
      state.diag = `${dyn.length} samples · ${winGood} clean · skipped (tainted)`;
      return null; // tainted window → no reading rather than a corrupted one
    }
    const rmsOf = (arr) => {
      let s = 0;
      for (const v of arr) s += v * v;
      return Math.sqrt(s / arr.length);
    };
    const rawRms = rmsOf(dyn);   // "tremor" band: includes body/arm motion
    const hpRms = rmsOf(hp);     // road band: >4 Hz impulsive energy
    state.diag = `tremor ${rawRms.toFixed(2)} · road ${hpRms.toFixed(3)} m/s²`;

    // Score = road-band RMS mapped to 0–100 (higher = rougher road).
    // Field-calibration constants — documented in README; adjust after a
    // reference drive. pow keeps low end resolution, clips high end at 100.
    return Math.max(0, Math.min(100, Math.round(Math.pow(hpRms, 0.9) * 42)));
  }

  /* ------------------------------- data flow ------------------------------- */

  function pushReading(score) {
    if (!state.lastFix || !state.recording || score == null) return;
    // Fresh and accurate GPS fix required: a stale or sloppy fix anchors the
    // reading to the wrong street → wrong segment → poisoned analysis
    if (Date.now() - state.lastFix.at > FIX_MAX_AGE) return;
    // Speed, when available: skip parked/idle noise and implausible motion
    const s = state.lastFix.speed;
    if (s != null && (s < SPEED_MIN || s > SPEED_MAX)) return;
    state.pending.push({
      lat: state.lastFix.lat,
      lon: state.lastFix.lon,
      t: Date.now(),
      roughness: score,
      speed: state.lastFix.speed
    });
    state.windowScores.push(score);
    if (state.windowScores.length > 120) state.windowScores.shift();
    drawSpark();
  }

  function tickSecondWindows() {
    if (!state.recording) return;
    // events/sec diagnostics (both streams feed motionEvents)
    state.hzNow = state.motionEvents - state.lastEvTotal;
    state.lastEvTotal = state.motionEvents;
    els.evHz.textContent = String(state.hzNow);
    if (state.nullApg > 20 && state.hzNow > 0 &&
        els.sensor.textContent === 'on') {
      els.sensor.textContent = 'no data';
      els.status.textContent = 'Motion events arrive but contain no data — fell back?';
    }
    watchMotionHealth();
    pushReading(windowScore());
    els.score.textContent = state.windowScores.length
      ? String(state.windowScores[state.windowScores.length - 1])
      : '–';
    els.filtered.textContent = String(state.filtered);
    els.diag.textContent = state.diag || '–';
  }

  async function uploadPending() {
    if (!state.pending.length) return;
    const batch = { device: state.deviceId, points: state.pending };
    state.pending = [];
    try {
      const res = await fetch('/api/readings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      state.uploaded += data.added || 0;
      els.uploads.textContent = String(state.uploaded);
      const rej = data.rejected || 0;
      els.status.textContent = rej
        ? `Recording… server rejected ${rej} reading(s) as junk.`
        : 'Recording… readings uploading normally.';
    } catch (e) {
      // keep the data for retry, cap memory
      state.pending = batch.points.concat(state.pending).slice(-2000);
      els.status.textContent = 'Offline — holding readings locally, will retry.';
    }
  }

  /* ------------------------------ chart (canvas) ----------------------------- */

  function drawSpark() {
    const c = els.spark, g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0f172a';
    g.fillRect(0, 0, W, H);
    const data = state.windowScores;
    if (!data.length) return;
    g.beginPath();
    let first = true;
    data.forEach((v, i) => {
      if (v === null || v === undefined) { first = true; return; } // gap → break line
      const x = (i / (data.length - 1 || 1)) * W;
      const y = H - (v / 100) * H;
      if (first) { g.moveTo(x, y); first = false; }
      else { g.lineTo(x, y); }
    });
    g.strokeStyle = '#38bdf8';
    g.lineWidth = 2;
    g.stroke();
  }

  /* ------------------------------- start / stop ------------------------------ */

  async function requestSensors() {
    // iOS 13+ requires an explicit user-gesture permission request.
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const r = await DeviceMotionEvent.requestPermission();
        if (r !== 'granted') throw new Error('motion permission denied');
      } catch (e) {
        els.status.textContent = 'Motion sensor permission denied: ' + e.message;
        return false;
      }
    }
    return true;
  }

  async function start() {
    if (state.recording) return;
    if (!(await requestSensors())) return;

    // GPS
    if ('geolocation' in navigator) {
      state.geoWatch = navigator.geolocation.watchPosition(
        (pos) => {
          // Only accept fixes accurate enough to be on the right street.
          // Sloppy fixes are ignored entirely (kept from overriding a good fix).
          if ((pos.coords.accuracy || 1e9) > FIX_ACC_MAX) {
            els.gps.textContent = '?' + Math.round(pos.coords.accuracy || 0) + 'm';
            return;
          }
          state.lastFix = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            speed: pos.coords.speed,
            at: Date.now()
          };
          els.gps.textContent = '±' + Math.round(pos.coords.accuracy || 0) + 'm';
          const moving = pos.coords.speed == null || pos.coords.speed > 1.0;
          if (!state.recording) { state.recording = true; }
          state.canSample = moving;
        },
        (err) => {
          els.gps.textContent = 'err';
          els.status.textContent = 'GPS error: ' + err.message + ' (allow location access)';
        },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
      );
    } else {
      els.gps.textContent = 'n/a';
    }

    // Motion
    state.motionHandler = feedMotion;
    window.addEventListener('devicemotion', state.motionHandler);

    state.recording = true;
    state.canSample = false;
    state.motionEvents = 0;
    state.lastEvTotal = 0;
    state.hzNow = 0;
    els.start.disabled = true;
    els.stop.disabled = false;
    els.sensor.textContent = 'on';
    els.status.textContent = 'Recording — drive the road at normal speed.';

    // health check: 4 s to produce a live motion stream before switching to
    // the Generic Sensor API fallback
    state.healthTimer = setInterval(() => {
      if (state.recording) watchMotionHealth();
    }, 4000);

    // 1 s scoring window
    state.winTimer = setInterval(tickSecondWindows, 1000);
    // upload every 10 s
    state.uploadTimer = setInterval(uploadPending, 10000);
  }

  function stop() {
    state.recording = false;
    clearInterval(state.winTimer);
    clearInterval(state.uploadTimer);
    clearInterval(state.healthTimer);
    if (state.fallbackSensor) {
      try { state.fallbackSensor.stop(); } catch {}
      state.fallbackSensor = null;
    }
    if (state.motionHandler) window.removeEventListener('devicemotion', state.motionHandler);
    if (state.geoWatch != null) navigator.geolocation.clearWatch(state.geoWatch);
    els.start.disabled = false;
    els.stop.disabled = true;
    els.sensor.textContent = 'off';
    els.gps.textContent = 'off';
    uploadPending(); // flush
    els.status.textContent = 'Stopped. ' + state.uploaded + ' points uploaded this trip.';
  }

  els.start.addEventListener('click', start);
  els.stop.addEventListener('click', stop);
  window.addEventListener('beforeunload', () => {
    if (state.recording) { try { navigator.sendBeacon && navigator.sendBeacon('/api/readings',
      new Blob([JSON.stringify({ device: state.deviceId, points: state.pending })],
        { type: 'application/json' })); } catch {} }
  });
})();