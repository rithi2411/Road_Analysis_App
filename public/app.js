/*
 * Road Scan — recorder PWA logic.
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
    lastFix: null,
    hpPrev: 0,
    verticalPrev: 0,
    scoreBuf: { dyn: [], hp: [] },
    winGood: 0,
    winBad: 0,
    windowScores: [],
    pending: [],
    uploaded: 0,
    filtered: 0,
    motionEvents: 0,
    lastEvTotal: 0,
    nullApg: 0,
    fallbackSensor: null,
    deviceId: 'dev-' + Math.random().toString(36).slice(2, 10),
    uploadTimer: null,
    alpha: 0.05,
    canSample: true // Default to true so UI works immediately
  };

  const G_MIN = 6.5;
  const G_MAX = 15;
  const SPIKE_MAX = 80;
  const FIX_ACC_MAX = 50;
  const FIX_MAX_AGE = 10_000;
  const SPEED_MIN = 1.0;
  const SPEED_MAX = 40;

  const grav = { x: 0, y: 0, z: 0, init: false };

  function handleSample(a) {
    if (!a || a.x == null) return;
    if (!grav.init) {
      grav.x = a.x; grav.y = a.y; grav.z = a.z; grav.init = true;
      return;
    }
    grav.x += state.alpha * (a.x - grav.x);
    grav.y += state.alpha * (a.y - grav.y);
    grav.z += state.alpha * (a.z - grav.z);
    const dx = a.x - grav.x, dy = a.y - grav.y, dz = a.z - grav.z;
    const gm = Math.hypot(grav.x, grav.y, grav.z);
    if (gm < G_MIN || gm > G_MAX) {
      state.winBad++;
      state.filtered++;
      return;
    }
    const ux = grav.x / gm, uy = grav.y / gm, uz = grav.z / gm;
    const vertical = dx * ux + dy * uy + dz * uz;
    if (Math.abs(vertical) > 120) {
      state.winBad++;
      state.filtered++;
      return;
    }
    state.winGood++;
    const HP_ALPHA = 0.66;
    const hp = HP_ALPHA * (state.hpPrev + vertical - state.verticalPrev);
    state.verticalPrev = vertical;
    state.hpPrev = hp;
    state.scoreBuf.dyn.push(vertical);
    state.scoreBuf.hp.push(hp);
  }

  function feedMotion(e) {
    state.motionEvents++;
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
        handleSample({ x: s.x, y: s.y, z: s.z });
      });
      s.start();
      state.fallbackSensor = s;
      els.sensor.textContent = 'on (fallback)';
    } catch {
      els.sensor.textContent = 'unavailable';
    }
  }

  function windowScore() {
    const dyn = state.scoreBuf.dyn;
    const hp = state.scoreBuf.hp;
    state.scoreBuf.dyn = [];
    state.scoreBuf.hp = [];
    const { winGood, winBad } = state;
    state.winGood = 0; state.winBad = 0;

    if (dyn.length < 3) {
      state.diag = `Waiting for data... (${state.motionEvents} events)`;
      return null;
    }
    if (winGood < 3 || winGood / (winGood + winBad) < 0.4) {
      state.diag = `${dyn.length} samples · too noisy/unstable · skipped`;
      return null;
    }

    const rmsOf = (arr) => {
      let s = 0;
      for (const v of arr) s += v * v;
      return Math.sqrt(s / arr.length);
    };
    const rawRms = rmsOf(dyn);
    const hpRms = rmsOf(hp);
    state.diag = `tremor ${rawRms.toFixed(2)} · road ${hpRms.toFixed(3)} m/s²`;
    return Math.max(0, Math.min(100, Math.round(Math.pow(hpRms, 0.9) * 42)));
  }

  function pushReading(score) {
    state.windowScores.push(score === null ? 0 : score);
    if (state.windowScores.length > 120) state.windowScores.shift();
    drawSpark();

    if (!state.recording || score === null) return;
    
    // Gate for actual storage/upload
    if (!state.lastFix) {
      els.status.textContent = 'Waiting for GPS fix to save data...';
      return;
    }
    if (Date.now() - state.lastFix.at > FIX_MAX_AGE) return;
    const s = state.lastFix.speed;
    if (s != null && (s < SPEED_MIN || s > SPEED_MAX)) return;

    state.pending.push({
      lat: state.lastFix.lat,
      lon: state.lastFix.lon,
      t: Date.now(),
      roughness: score,
      speed: state.lastFix.speed
    });
  }

  function tickSecondWindows() {
    if (!state.recording) return;
    state.hzNow = state.motionEvents - state.lastEvTotal;
    state.lastEvTotal = state.motionEvents;
    els.evHz.textContent = String(state.hzNow);
    
    if (state.recording && state.hzNow < 5 && !state.fallbackSensor) {
      startFallbackSensor();
    }

    pushReading(windowScore());
    const last = state.windowScores[state.windowScores.length - 1];
    els.score.textContent = last > 0 ? String(last) : '–';
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
      if (res.ok) {
        const data = await res.json();
        state.uploaded += data.added || 0;
        els.uploads.textContent = String(state.uploaded);
      }
    } catch (e) {}
  }

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
      const x = (i / (data.length - 1 || 1)) * W;
      const y = H - (v / 100) * H;
      if (first) { g.moveTo(x, y); first = false; }
      else { g.lineTo(x, y); }
    });
    g.strokeStyle = '#38bdf8';
    g.lineWidth = 2;
    g.stroke();
  }

  async function start() {
    if (state.recording) return;
    
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') return;
    }

    if ('geolocation' in navigator) {
      state.geoWatch = navigator.geolocation.watchPosition(
        (pos) => {
          if ((pos.coords.accuracy || 1000) > FIX_ACC_MAX) {
            els.gps.textContent = '±' + Math.round(pos.coords.accuracy) + 'm (weak)';
            return;
          }
          state.lastFix = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            speed: pos.coords.speed,
            at: Date.now()
          };
          els.gps.textContent = '±' + Math.round(pos.coords.accuracy) + 'm';
        },
        null, { enableHighAccuracy: true }
      );
    }

    window.addEventListener('devicemotion', feedMotion);
    state.recording = true;
    state.motionEvents = 0;
    state.lastEvTotal = 0;
    els.start.disabled = true;
    els.stop.disabled = false;
    els.sensor.textContent = 'on';
    els.status.textContent = 'Recording live...';
    state.winTimer = setInterval(tickSecondWindows, 1000);
    state.uploadTimer = setInterval(uploadPending, 10000);
  }

  function stop() {
    state.recording = false;
    clearInterval(state.winTimer);
    clearInterval(state.uploadTimer);
    window.removeEventListener('devicemotion', feedMotion);
    if (state.geoWatch) navigator.geolocation.clearWatch(state.geoWatch);
    els.start.disabled = false;
    els.stop.disabled = true;
    els.sensor.textContent = 'off';
    els.status.textContent = 'Stopped. Points: ' + state.uploaded;
  }

  els.start.addEventListener('click', start);
  els.stop.addEventListener('click', stop);
})();