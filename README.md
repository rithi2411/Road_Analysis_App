# 🛣️ Road Analysis App

A crowdsourced road-roughness monitoring system built with phone sensors.

Devices driving over a road measure vertical vibration with the
**accelerometer**, tag each reading with **GPS**, and upload batches to a
shared server. The server **map-matches readings onto actual OpenStreetMap
roads**, aggregates many devices' readings per road, and a **dashboard** maps
road quality. Bad roads can be **reported to the municipality** with location,
road name + quality data in one click.

```
┌────────────┐  POST /api/readings   ┌──────────┐  GET /api/segments  ┌───────────┐
│ Recorder   │ ───────────────────▶ │  Server  │ ──────────────────▶ │ Dashboard │
│ PWA (phone)│   batched readings   │ Node.js  │                      │  (Leaflet)│
└────────────┘                      └──────────┘ ◀──────────────────  └───────────┘
                                     aggregates by         POST /api/reports
                                     grid segment          → municipality report
```

## Run it

```
node server.js
```

Open:

- **Recorder (use on your phone):** https://road-analysis.onrender.com
- **Dashboard (desktop):** https://road-analysis.onrender.com/dashboard.html


## How the roughness score works

1. `DeviceMotion.accelerationIncludingGravity` is sampled continuously
   (fallback: Generic Sensor API `Accelerometer` when `devicemotion` is
   blocked on Android).
2. Gravity is estimated with a slow exponential low-pass filter per axis; the
   rotation-invariant **vertical** component of the residual (dynamic)
   acceleration is extracted.
3. That vertical signal is **high-passed at ≈4 Hz** — pothole/road vibration is
   impulsive (5–15 Hz), while steps, arm swing and sway live below 2 Hz and are
   removed. Hand-waving young cousins no longer pin the meter at 100.
4. Each 1-second window's **road-band RMS** is mapped to **0–100
   roughness** (higher = worse road):
   `score = clamp(round(hpRms^0.9 × 42))` — calibration constants are still
   provisional; field calibration against a reference vehicle is planned.
5. Sampling is skipped while the device GPS speed < 1 m/s (parked/idle noise),
   and readings are batched and uploaded every 10 s (queued + retried offline).
6. Server separates **vehicle readings** (speed ≥ ~2.5 m/s) from
   **pedestrian readings**: only vehicle data drives a road's quality/color;
   walk-only stretches are shown with `pedestrian` confidence.

## Map-matching to real roads (OSM)

Readings are snapped to actual roads before aggregation:

1. The server loads road geometry for the area in ~5.5 km map "buckets" from
   **OpenStreetMap** — first from Overpass API mirrors (with per-endpoint
   cooldowns and 429-aware backoff), falling back to the classic
   **OpenStreetMap API** (`/api/0.6/map`, tiled to respect its 50k-node limit).
2. **Disk cache** (`data/roads/`): once an area loads successfully it is stored
   permanently and re-served instantly even when the map-data endpoints are
   rate-limited or down.
3. Every reading is projected onto the nearest mapped road polyline within
   **30 m**; readings farther off-road are rejected as GPS drift/spoofing
   (another junk filter). Aggregation keys become the OSM way
   (`way:<id>`), with road name/type from OSM tags.
4. If road data can't be loaded at all, ingestion falls back to ~110 m grid
   cells (`cell:<lat>,<lon>`) so the app keeps working offline.

## Anti-junk filtering

- **Device side:** gravity-magnitude sanity (6.5–15 m/s²), spike rejection
  (>50 m/s²), tainted-window discard (<70% clean samples), GPS accuracy
  ≤50 m and fix age ≤10 s, speed bounds 1–40 m/s, live "Rejected" counter.
- **Server side:** strict per-point validation, exact-duplicate rejection,
  per-point rate limiting (120/device/min), median + trimmed-mean aggregation
  so outliers can't corrupt a road's score.

## Report to municipality

The dashboard lists the worst roads. "Report" files a report record
(`POST /api/reports`) and opens a pre-filled email to the municipality
containing: report ID, road name, lat/lon + Google Maps link, roughness score,
number of independent readings, and the citizen's note. Wire
`municipality@example.gov` in `dashboard.js` to a real address.

## Files

| Path | Purpose |
|---|---|
| `server.js` | zero-dependency Node server: ingest, map-matching, robust aggregation, reports, static files (JSON persistence in `data/`) |
| `public/index.html`, `public/app.js` | recorder PWA |
| `public/dashboard.html`, `public/dashboard.js`, `public/style.css` | map dashboard, worst-roads table, report dialog |
| `data/roads/` | persistent OSM road-geometry cache (auto-created) |

## Next steps / ideas

- Speed normalization (same pothole scores differently at 20 vs 60 km/h)
- Per-device calibration factors
- IRI calibration against a known reference or a verified roughness dataset
- Municipality side: admin login, report status updates (acknowledged / fixed), boundaries-based routing to the nearest authority
- Time-decay so old scores fade unless confirmed by recent readings
- Deploy: any Node host (Render/Fly/Railway); put HTTPS in front
