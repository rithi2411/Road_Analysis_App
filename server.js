/*
 * Road Analysis App - server
 * Zero-dependency Node.js server:
 *   - serves the PWA (public/)
 *   - POST /api/readings   : ingest batched sensor readings from devices
 *   - GET  /api/segments   : aggregated roughness per road grid cell
 *   - POST /api/reports    : file a report to the municipality for a segment
 *   - GET  /api/reports    : list filed reports
 *   - POST /api/reset      : clear data (prototype only)
 *
 * Data is persisted to data/db.json so it survives restarts.
 *
 * Anti-junk defenses (server side):
 *   - strict per-point validation (range, timestamp skew, speed bounds)
 *   - exact-duplicate rejection per device
 *   - per-device rate limiting (readings/minute)
 *   - robust aggregation: median as the quality signal, trimmed mean for
 *     a secondary average, and only the most recent N scores per segment
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// DATA_DIR is overridable so a persistent disk (e.g. Render) can keep
// db.json + the OSM road cache across deploys/restarts.
const DATA_DIR = path.join(process.env.DATA_DIR || __dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// A bad road, on our 0-100 roughness scale.
const BAD_ROAD_THRESHOLD = 45;

// Anti-junk limits
const MAX_SCORE = 100;                 // roughness scale ceiling
const MAX_SPEED = 40;                  // m/s ≈ 144 km/h — anything faster is bogus
const MAX_T_FUTURE_MS = 5 * 60_000;    // reading timestamp may be ≤5 min in the future
const MAX_T_PAST_MS = 7 * 86_400_000;  // or ≤7 days old
const MAX_SCORES_PER_SEGMENT = 400;    // keep only the most recent N per segment
const DEVICE_RATE_LIMIT = 120;         // readings per device per minute (10s batch of ≤10 pts ⇒ generous)
const DEVICES_MAP_CAP = 50;            // per-segment device-id memory

// OSM map-matching (road snapping)
const SNAP_MAX_METERS = 25;            // reading must be within this of a mapped road
const WAY_STAY_SLACK = 1.4;            // stay on the device's current road if within 25m×1.4
const WAY_STAY_SECONDS = 25;           // …and the device was last seen on it ≤25 s ago
const OSM_TIMEOUT_MS = 15_000;
const OSM_API_TIMEOUT_MS = 45_000;
const OSM_ENDPOINTS = [
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
// Vehicle-relevant road classes (foot paths carry no vehicle roughness signal)
const OSM_HIGHWAYS = 'motorway|trunk|primary|secondary|tertiary|residential|' +
  'unclassified|service|living_street|track|motorway_link|trunk_link|primary_link|' +
  'secondary_link|tertiary_link';

/* ------------------------------ storage ------------------------------ */

let db = { segments: {}, reports: [] };

function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    db = { segments: {}, reports: [] };
  }
}

let saveTimer = null;
function saveDb() {
  if (saveTimer) return; // debounce writes; at most once per 2s
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(db));
    } catch (e) {
      console.error('Failed to save db:', e.message);
    }
  }, 2000);
}

loadDb();

/* --------------------------- ingest + aggregate ---------------------------
 * Segments are actual OSM roads (OpenStreetMap ways) when the road geometry
 * for the area could be fetched; readings snap to the nearest mapped road
 * within SNAP_MAX_METERS (GPS drift or spoofed coordinates off-road is
 * rejected — another junk filter). When OSM is unavailable we fall back to
 * the ~110m grid cell ("cell:lat3,lon3") so ingestion never blocks.
 *
 * For each reading we keep a running aggregate, the most recent scores for
 * median/trimmed-mean, plus a histogram. We store nothing per-device beyond
 * a count.
 */

function segmentKey(lat, lon) {
  return 'cell:' + lat.toFixed(3) + ',' + lon.toFixed(3);
}

/* ---------------------- OSM road cache (Overpass API) ---------------------- */

const roadCache = new Map(); // bucketKey -> { roads: [ {id,name,type,coords,bbox} ], at }
const roadInFlight = new Map(); // bucketKey -> Promise
const endpointCooldown = new Map(); // endpoint -> retryable-after timestamp
const bucketNegative = new Map(); // bucketKey -> retryable-after timestamp (fetch failed)
const ROAD_DIR = path.join(DATA_DIR, 'roads'); // disk cache: one good load lasts forever

// Fixed square buckets (~5.5 km) — batches near each other share one fetch
const BUCKET_DEG = 0.05;
const BUCKET_MARGIN_DEG = 0.005;
const ROAD_NEGATIVE_TTL_MS = 2 * 60_000;   // after a failed fetch, don't retry this bucket for 2 min
const ROAD_STALE_TTL_MS = 86_400_000;      // fresh for a day, older still usable if OSM is down
const ROAD_REFRESH_MS = 6 * 3_600_000;     // re-warm a cached bucket at most every 6 h

function bucketOf(v) {
  return Math.floor(v / BUCKET_DEG);
}

function bucketBbox(iLat, iLon) {
  return {
    minLat: iLat * BUCKET_DEG - BUCKET_MARGIN_DEG,
    maxLat: (iLat + 1) * BUCKET_DEG + BUCKET_MARGIN_DEG,
    minLon: iLon * BUCKET_DEG - BUCKET_MARGIN_DEG,
    maxLon: (iLon + 1) * BUCKET_DEG + BUCKET_MARGIN_DEG
  };
}

/* Disk cache: roads rarely change; once an area loads successfully we never
 * have to hit Overpass for it again (survives restarts and rate-limit storms). */
function roadFilePath(key) {
  const safe = key.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(ROAD_DIR, safe + '.json');
}

function roadFileSave(key, roads) {
  try {
    if (!fs.existsSync(ROAD_DIR)) fs.mkdirSync(ROAD_DIR, { recursive: true });
    fs.writeFileSync(roadFilePath(key), JSON.stringify(roads));
  } catch (e) {
    console.error('road cache save failed:', e.message);
  }
}

function roadFileLoad(key) {
  try {
    const roads = JSON.parse(fs.readFileSync(roadFilePath(key), 'utf8'));
    return Array.isArray(roads) && roads.length ? { roads, at: Date.now() } : null;
  } catch {
    return null;
  }
}

function osmQuery(bbox) {
  return '[out:json][timeout:25];' +
    `way["highway"~"^(${OSM_HIGHWAYS})$"]` +
    `(${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon});` +
    'out geom;';
}

/* One attempt against one Overpass endpoint. Throws on failure. */
async function tryEndpoint(endpoint, bbox) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(osmQuery(bbox)),
    signal: AbortSignal.timeout(OSM_TIMEOUT_MS)
  });
  if (!res.ok) throw new Error('overpass HTTP ' + res.status);
  const json = await res.json();
  return waysToRoads(json.elements || []);
}

/* Global geometry index (way id → coords) so the dashboard can draw the
 * actual mapped road polylines instead of floating dots. */
const wayIndex = new Map();
function indexRoads(roads) {
  for (const r of roads) {
    if (!wayIndex.has(String(r.id))) {
      wayIndex.set(String(r.id), r.coords.map(([lat, lon]) => [+lat.toFixed(5), +lon.toFixed(5)]));
    }
  }
}

/* Fallback data source: the classic OSM API ("map?bbox=" returning XML).
 * Same underlying OpenStreetMap data, different infrastructure — works even
 * when every Overpass mirror rate-limits us. */
const OSM_API_ENDPOINT = 'https://api.openstreetmap.org/api/0.6/map';
const HIGHWAY_SET = new Set(OSM_HIGHWAYS.split('|'));
const XML_ESC = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
function xmlDecode(s) {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ESC[m]);
}
function attr(tagText, name) {
  const m = tagText.match(new RegExp(`${name}="([^"]*)"`));
  return m ? xmlDecode(m[1]) : null;
}
function waysToRoads(elements) {
  const roads = [];
  for (const el of elements) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
    const coords = el.geometry
      .filter((g) => g && isFinite(g.lat) && isFinite(g.lon))
      .map((g) => [g.lat, g.lon]);
    if (coords.length < 2) continue;
    const lats = coords.map((c) => c[0]), lons = coords.map((c) => c[1]);
    roads.push({
      id: el.id,
      name: (el.tags && (el.tags.name || el.tags.ref)) || null,
      type: (el.tags && el.tags.highway) || 'road',
      coords,
      bbox: { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) }
    });
  }
  return roads;
}
function parseOsmApiXml(xml, bbox) {
  // nodes: id → [lat, lon]
  const nodes = new Map();
  const nodeRe = /<node\s([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g;
  let m;
  while ((m = nodeRe.exec(xml))) {
    const id = attr(m[1], 'id');
    const lat = parseFloat(attr(m[1], 'lat'));
    const lon = parseFloat(attr(m[1], 'lon'));
    if (id && isFinite(lat) && isFinite(lon)) nodes.set(id, [lat, lon]);
  }
  const roads = [];
  const wayRe = /<way\s([^>]*?)>([\s\S]*?)<\/way>/g;
  while ((m = wayRe.exec(xml))) {
    const attrs = m[1], body = m[2];
    const type = (body.match(/<tag k="highway" v="([^"]*)"/) || [])[1];
    if (!type || !HIGHWAY_SET.has(type)) continue; // highways only (matches Overpass filter)
    const id = attr(attrs, 'id');
    const refs = [];
    const ndRe = /<nd ref="([^"]*)"\s*\/>/g;
    let nd;
    while ((nd = ndRe.exec(body))) refs.push(nd[1]);
    const coords = refs.map((r) => nodes.get(r)).filter(Boolean);
    if (coords.length < 2) continue;
    const lats = coords.map((c) => c[0]), lons = coords.map((c) => c[1]);
    // keep ways intersecting the requested bbox (API clips, doesn't omit)
    const rBbox = { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) };
    if (rBbox.maxLat < bbox.minLat || rBbox.minLat > bbox.maxLat ||
        rBbox.maxLon < bbox.minLon || rBbox.minLon > bbox.maxLon) continue;
    const nameTag = (body.match(/<tag k="name" v="([^"]*)"/) || [])[1];
    const refTag = (body.match(/<tag k="ref" v="([^"]*)"/) || [])[1];
    roads.push({
      id,
      name: (nameTag && xmlDecode(nameTag)) || (refTag && xmlDecode(refTag)) || null,
      type,
      coords,
      bbox: rBbox
    });
  }
  return roads;
}
async function tryOsmApi(bbox) {
  // Subdivide the bucket into small tiles — the main API caps queries at 50k
  // nodes (≈0.02–0.03° span in a city).
  const spanLat = bbox.maxLat - bbox.minLat;
  const spanLon = bbox.maxLon - bbox.minLon;
  const tiles = Math.max(1, Math.ceil(Math.max(spanLat, spanLon) / 0.022));
  const latStep = spanLat / tiles, lonStep = spanLon / tiles;

  const jobs = [];
  for (let i = 0; i < tiles; i++) {
    for (let j = 0; j < tiles; j++) {
      const bb = {
        minLat: bbox.minLat + i * latStep, maxLat: bbox.minLat + (i + 1) * latStep,
        minLon: bbox.minLon + j * lonStep, maxLon: bbox.minLon + (j + 1) * lonStep
      };
      jobs.push(bb);
    }
  }

  // modest parallelism: a few lanes
  const LANES = 3;
  const results = [];
  let cursor = 0;
  async function lane() {
    while (cursor < jobs.length) {
      const bb = jobs[cursor++];
      const url = `${OSM_API_ENDPOINT}?bbox=${bb.minLon},${bb.minLat},${bb.maxLon},${bb.maxLat}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`osm-api HTTP ${res.status} ${t.slice(0, 100)}`);
      }
      results.push(...parseOsmApiXml(await res.text(), bb));
    }
  }
  await Promise.all(Array.from({ length: Math.min(LANES, jobs.length) }, lane));

  // overlap from tile corners can duplicate ways — merge by id
  const byId = new Map();
  for (const r of results) {
    if (!byId.has(r.id)) byId.set(r.id, r);
  }
  return [...byId.values()];
}

async function fetchOsmRoads(bbox) {
  const now = Date.now();
  let lastErr;
  for (const endpoint of OSM_ENDPOINTS) {
    const until = endpointCooldown.get(endpoint) || 0;
    if (now < until) continue; // recently failed — skip, don't hammer
    try {
      return await tryEndpoint(endpoint, bbox);
    } catch (e) {
      // 429 (quota/rate limit) cools down longer than hard failures
      endpointCooldown.set(endpoint, Date.now() + (String(e).includes('429') ? 90_000 : 20_000));
      lastErr = e;
    }
  }
  // Independent infrastructure fallback — the main OSM API
  try {
    return await tryOsmApi(bbox);
  } catch (e) {
    endpointCooldown.set('osm-api', Date.now() + 60_000);
    lastErr = e;
  }
  throw lastErr || new Error('all map data endpoints cooling down');
}

/* Load (or refresh) road geometry for one bucket.
 * Freshness order: memory fresh > memory stale / disk while chasing a refresh >
 * fetch failure falls back to stale-or-disk > else null (grid fallback). */
async function loadBucketRoads(key, i, j) {
  const cached = roadCache.get(key);
  const age = cached ? Date.now() - cached.at : Infinity;

  // Fresh in memory → serve it; occasionally re-warm in the background
  if (cached && age < ROAD_STALE_TTL_MS) {
    if (age > ROAD_REFRESH_MS && !roadInFlight.has(key)) {
      const p = fetchOsmRoads(bucketBbox(i, j))
        .then((roads) => {
          indexRoads(roads);
          roadCache.set(key, { roads, at: Date.now() });
        })
        .catch(() => {})            // a failed refresh still leaves good cached roads
        .finally(() => roadInFlight.delete(key));
      roadInFlight.set(key, p);
      void p;
    }
    indexRoads(cached.roads);
    return cached.roads;
  }

  // A foreground load is already running (first-ever load or stale refresh)
  if (roadInFlight.has(key)) return roadInFlight.get(key);

  let stale = cached || roadFileLoad(key);       // serve-while-error fallback
  const now = Date.now();

  // Disk-backed data younger than the TTL serves directly, no network needed
  if (stale && now - (stale.at || 0) < ROAD_STALE_TTL_MS * 0.5) {
    indexRoads(stale.roads);
    roadCache.set(key, stale);
    return stale.roads;
  }

  if (!stale && now < (bucketNegative.get(key) || 0)) return null; // failed recently; back off

  const job = (async () => {
    try {
      const roads = await fetchOsmRoads(bucketBbox(i, j));
      indexRoads(roads);
      roadCache.set(key, { roads, at: Date.now() });
      roadFileSave(key, roads);
      bucketNegative.delete(key);
      return roads;
    } catch (e) {
      console.error(`OSM bucket ${key} failed:`, e && e.message);
      bucketNegative.set(key, Date.now() + ROAD_NEGATIVE_TTL_MS);
      const use = stale ? stale.roads : null;
      if (use) {
        indexRoads(use);
        roadCache.set(key, stale); // promote disk data to memory so we stop re-reading the file
      }
      return use;
    }
  })();

  const wrapped = job.finally(() => roadInFlight.delete(key));
  roadInFlight.set(key, wrapped);
  return wrapped;
}

/* Road geometries for every map bucket the batch touches.
 * Returns null only if nothing at all could be loaded (→ grid fallback). */
async function roadsForBatch(points) {
  const pts = (points || []).filter((p) => isFinite(Number(p.lat)) && isFinite(Number(p.lon)));
  if (!pts.length) return null;

  const lats = pts.map((p) => Number(p.lat)), lons = pts.map((p) => Number(p.lon));
  const i0 = bucketOf(Math.min(...lats)), i1 = bucketOf(Math.max(...lats));
  const j0 = bucketOf(Math.min(...lons)), j1 = bucketOf(Math.max(...lons));

  const buckets = [];
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) buckets.push([i, j]);
  }

  const results = await Promise.all(
    buckets.map(([i, j]) => loadBucketRoads(`b:${i}:${j}`, i, j))
  );

  if (!results.some(Boolean)) return null;

  const roads = [];
  for (const r of results) {
    if (Array.isArray(r)) roads.push(...r);
  }
  return roads.length ? roads : null;
}

/* --------------------------- snapping (projection) -------------------------- */

function distMeters(p1, p2) {
  const m = projMeters((p1[0] + p2[0]) / 2);
  const dx = (p2[1] - p1[1]) * m.x;
  const dy = (p2[0] - p1[0]) * m.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function slicePolyline(coords, startM, endM) {
  if (!coords || coords.length < 2) return coords || [];
  let cum = 0;
  const pts = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const len = distMeters(p1, p2);
    const segStart = cum;
    const segEnd = cum + len;
    if (segEnd >= startM && segStart <= endM) {
      let tStart = 0, tEnd = 1;
      if (startM > segStart && len > 0) tStart = (startM - segStart) / len;
      if (endM < segEnd && len > 0) tEnd = (endM - segStart) / len;
      const latA = p1[0] + (p2[0] - p1[0]) * tStart;
      const lonA = p1[1] + (p2[1] - p1[1]) * tStart;
      const latB = p1[0] + (p2[0] - p1[0]) * tEnd;
      const lonB = p1[1] + (p2[1] - p1[1]) * tEnd;
      if (pts.length === 0) pts.push([+latA.toFixed(5), +lonA.toFixed(5)]);
      pts.push([+latB.toFixed(5), +lonB.toFixed(5)]);
    }
    cum = segEnd;
    if (cum >= endM) break;
  }
  return pts.length >= 2 ? pts : coords;
}

/* Equirectangular metres-per-degree scaled by the segment's latitude */
function projMeters(lat) {
  return { x: Math.cos((lat * Math.PI) / 180) * 111320, y: 110574 };
}

/* Squared distance in metres from point [lat,lon] to segment a→b, plus the
 * projection factor t∈[0,1] for the closest point. */
function distSqToSeg(p, a, b) {
  const m = projMeters((p[0] + a[0] + b[0]) / 3);
  const px = (p[1] - a[1]) * m.x, py = (p[0] - a[0]) * m.y;
  const bx = (b[1] - a[1]) * m.x, by = (b[0] - a[0]) * m.y;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  const dx = px - t * bx, dy = py - t * by;
  return { d2: dx * dx + dy * dy, t };
}

/* Snap a point to the nearest road, with stay-on-road hysteresis:
 * while a device keeps driving, consecutive readings prefer the road the
 * device was last seen on (within WAY_STAY slack/time), instead of flickering
 * onto parallel paths or side roads at intersections. Returns
 * { road, lat, lon } with the projected point ON the road, or null. */
const deviceLastWay = new Map(); // device -> { wayId, at }
function snapPointPref(lat, lon, roads, preferredWayId) {
  const p = [lat, lon];
  let bestOther = null;
  let bestStay = null;
  const consider = (r) => {
    const c = r.coords;
    let distAlong = 0;
    for (let i = 0; i < c.length - 1; i++) {
      const segLen = distMeters(c[i], c[i + 1]);
      const { d2, t } = distSqToSeg(p, c[i], c[i + 1]);
      const distOnWay = distAlong + t * segLen;
      const rec = {
        d2, road: r,
        lat: c[i][0] + (c[i + 1][0] - c[i][0]) * t,
        lon: c[i][1] + (c[i + 1][1] - c[i][1]) * t,
        distOnWay
      };
      if (String(r.id) === String(preferredWayId)) {
        if (!bestStay || d2 < bestStay.d2) bestStay = rec;
      } else if (!bestOther || d2 < bestOther.d2) {
        bestOther = rec;
      }
      distAlong += segLen;
    }
  };

  for (const r of roads) {
    if (String(r.id) !== String(preferredWayId)) {
      // quick bbox reject for non-preferred roads
      if (lat < r.bbox.minLat - 0.001 || lat > r.bbox.maxLat + 0.001 ||
          lon < r.bbox.minLon - 0.001 || lon > r.bbox.maxLon + 0.001) continue;
    }
    consider(r);
  }

  const maxD2 = SNAP_MAX_METERS * SNAP_MAX_METERS;
  if (bestStay && bestStay.d2 <= maxD2 * WAY_STAY_SLACK * WAY_STAY_SLACK) return bestStay;
  if (bestOther && bestOther.d2 <= maxD2) return bestOther;
  return null;
}

function snapPoint(lat, lon, roads) {
  return snapPointPref(lat, lon, roads, null);
}

/* ------------------------------ ingest per point ------------------------------ */

/* Per-device flood control: sliding minute bucket, enforced per point. */
const deviceRate = {};
function allowDevicePoint(device) {
  const now = Date.now();
  let r = deviceRate[device];
  if (!r || now > r.resetAt) {
    r = deviceRate[device] = { count: 0, resetAt: now + 60_000 };
  }
  if (r.count >= DEVICE_RATE_LIMIT) return false;
  r.count += 1;
  return true;
}

/* Exact-duplicate filter: same device posting an identical point twice.
 * Keeps a bounded signature set per device. */
const deviceSeen = {};
function isDuplicate(device, p) {
  const sig = `${p.lat.toFixed(5)}|${p.lon.toFixed(5)}|${p.t}`;
  let set = deviceSeen[device];
  if (!set) {
    set = deviceSeen[device] = new Set();
  } else if (set.size > 2000) {
    set.clear(); // bounded memory: drop history if a spammer explodes it
  }
  if (set.has(sig)) return true;
  set.add(sig);
  return false;
}

function validPoint(p) {
  const lat = Number(p.lat), lon = Number(p.lon), rough = Number(p.roughness);
  const t = Number(p.t);
  const speed = p.speed == null ? null : Number(p.speed);

  if (!isFinite(lat) || !isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  if (!isFinite(rough) || rough < 0 || rough > MAX_SCORE) return false;  // roughness must be a sane 0-100 value

  // Timestamp: reject clocks drifting too far either way
  const now = Date.now();
  if (!isFinite(t) || t > now + MAX_T_FUTURE_MS || t < now - MAX_T_PAST_MS) return false;

  // Speed, when the device can measure it: parked (<1 m/s) or >144 km/h is junk
  if (speed != null && (!isFinite(speed) || speed < 1 || speed > MAX_SPEED)) return false;

  return true;
}

function ingestBatch(batch, roads) {
  if (!batch || !Array.isArray(batch.points)) return { added: 0, rejected: 0, offRoad: 0, reason: 'bad-batch' };
  const device = String(batch.device || 'anon').slice(0, 64);

  let added = 0, rejected = 0, offRoad = 0;
  for (const p of batch.points) {
    if (!validPoint(p)) { rejected++; continue; }
    if (isDuplicate(device, p)) { rejected++; continue; }
    if (!allowDevicePoint(device)) { rejected++; continue; }

    // Map-match to a real OSM road when geometry is available; a device
    // under way stays on its current road (hysteresis) instead of flickering
    // onto parallel roads/side paths. Readings nowhere near a road are GPS
    // drift or spoofed coords → reject.
    const lat = Number(p.lat), lon = Number(p.lon);
    const last = deviceLastWay.get(device);
    const preferId = last && Date.now() - last.at <= WAY_STAY_SECONDS * 1000 ? last.wayId : null;
    const match = roads && roads.length ? snapPointPref(lat, lon, roads, preferId) : null;
    if (roads && roads.length && !match) { offRoad++; continue; }
    if (match) {
      deviceLastWay.set(device, { wayId: match.road.id, at: Date.now() });
      if (deviceLastWay.size > 5000) deviceLastWay.delete(deviceLastWay.keys().next().value);
    }

    const subIndex = match ? Math.floor((match.distOnWay || 0) / 100) : 0;
    const key = match ? 'way:' + match.road.id + ':s' + subIndex : segmentKey(lat, lon);
    const atLat = match ? match.lat : lat;
    const atLon = match ? match.lon : lon;
    const rangeLabel = `${subIndex * 100}–${(subIndex + 1) * 100}m`;
    const baseName = match && match.road.name ? match.road.name : null;
    const segName = baseName ? `${baseName} (${rangeLabel})` : null;
    let seg = db.segments[key];
    if (!seg) {
      seg = db.segments[key] = {
        id: key,
        name: segName,
        type: match ? match.road.type : null,
        source: match ? 'osm' : 'grid',
        lat: Number(atLat.toFixed(5)),
        lon: Number(atLon.toFixed(5)),
        count: 0,
        sum: 0,
        max: 0,
        scores: [],
        hist: {},          // score-bucket -> number of readings
        devices: {},       // anonymised device ids (counts only)
        lastSeen: 0
      };
    }
    if (match && match.road.name && !seg.name) seg.name = match.road.name;
    if (!seg.scores) seg.scores = [];
    if (!seg.scoresV) seg.scoresV = []; // vehicle-speed readings (calibrated signal)
    if (!seg.scoresW) seg.scoresW = []; // walking-speed readings (kept, never trusted for quality)
    if (!seg.walk) seg.walk = 0;

    // Running centroid so the marker sits on the driven stretch of the road.
    seg.lat = (seg.lat * seg.count + atLat) / (seg.count + 1);
    seg.lon = (seg.lon * seg.count + atLon) / (seg.count + 1);
    seg.count += 1;
    seg.sum += Number(p.roughness);

    // Vehicle vs pedestrian split: phone speed (when measured) below ~2.5 m/s
    // means walking — motion is dominated by arm/step impulses, which saturate
    // the score scale. They are stored but never feed the quality score.
    const spd = p.speed == null ? null : Number(p.speed);
    const isPed = spd != null && spd < 2.5;
    seg.scores.push(Number(p.roughness));
    if (isPed) {
      seg.scoresW.push(Number(p.roughness));
      seg.walk += 1;
    } else {
      seg.scoresV.push(Number(p.roughness));
    }
    const scoreSet = isPed ? seg.scoresW : seg.scoresV;
    const MAX_KEEP = MAX_SCORES_PER_SEGMENT;
    if (scoreSet.length > MAX_KEEP) scoreSet.splice(0, scoreSet.length - MAX_KEEP);
    if (seg.scores.length > MAX_KEEP) seg.scores.splice(0, seg.scores.length - MAX_KEEP);
    seg.max = Math.max(seg.max, Number(p.roughness));
    seg.hist[Math.min(19, Math.floor(Number(p.roughness) / 5))] =
      (seg.hist[Math.min(19, Math.floor(Number(p.roughness) / 5))] || 0) + 1;
    if (batch.device) {
      seg.devices[device] = 1;
      const ids = Object.keys(seg.devices);
      if (ids.length > DEVICES_MAP_CAP) delete seg.devices[ids[0]];
    }
    seg.lastSeen = Math.max(seg.lastSeen, Number(p.t) || 0);
    added++;
  }
  if (added) saveDb();
  return { added, rejected, offRoad };
}

/* Robust statistics over a segment's recent scores */
function median(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/* Trimmed mean: drop the lowest and highest 10% before averaging,
 * so a couple of extreme readings can't drag the value. Needs ≥10 points. */
function trimmedMean(nums) {
  if (nums.length < 10) return nums.reduce((s, x) => s + x, 0) / nums.length;
  const a = nums.slice().sort((x, y) => x - y);
  const cut = Math.floor(a.length * 0.1);
  const kept = a.slice(cut, a.length - cut);
  return kept.reduce((s, x) => s + x, 0) / kept.length;
}

function serializeSegments() {
  return Object.values(db.segments).map((s) => {
    const veh = (s.scoresV || []).filter((x) => x != null);
    const ped = (s.scoresW || []).filter((x) => x != null);
    // quality comes from vehicle readings when we have ≥3; walking readings
    // are displayed separately and never drive the score/color
    let recent, pedFlag = false;
    if (veh.length >= 3) recent = veh;
    else if (ped.length >= 3) { recent = ped; pedFlag = true; }
    else recent = veh.length >= 1 ? veh : (s.scores && s.scores.length ? s.scores : [s.sum / s.count]);
    const med = median(recent);
    const tMean = trimmedMean(recent);
    // simple "independent devices" proxy; good enough for a prototype
    const deviceCount = Object.keys(s.devices).length;
    const confidence = pedFlag ? 'pedestrian' :
      deviceCount >= 3 ? 'high' : deviceCount >= 2 ? 'medium' : 'low';
    const source = s.source || (s.id.startsWith('way:') ? 'osm' : 'grid');
    return {
      id: s.id,
      name: s.name || null,
      type: s.type || null,
      source,
      lat: +s.lat.toFixed(5),
      lon: +s.lon.toFixed(5),
      count: s.count,
      vehicle: veh.length,
      walk: s.walk || 0,
      avg: +tMean.toFixed(1),
      median: +med.toFixed(1),
      max: +s.max.toFixed(1),
      devices: deviceCount,
      confidence,
      lastSeen: s.lastSeen,
      quality: qualityLabel(med)
    };
  });
}

function qualityLabel(score) {
  if (score < 15) return 'excellent';
  if (score < 30) return 'good';
  if (score < 45) return 'fair';
  if (score < 65) return 'poor';
  return 'very bad';
}

/* --------------------------------- server --------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req, cb) {
  let data = '';
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 1_000_000) { req.destroy(); return; } // 1 MB cap
    data += chunk;
  });
  req.on('end', () => {
    try { cb(null, JSON.parse(data || '{}')); }
    catch (e) { cb(e); }
  });
  req.on('error', (e) => cb(e));
}

function serveStatic(req, res, urlPath) {
  let file = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/readings' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJson(res, 400, { error: 'invalid json' });
      (async () => {
        let roads = null;
        try { roads = await roadsForBatch(body.points); }
        catch (e) {
          console.error('OSM road fetch failed:', e && e.message);
          roads = null; // OSM down → grid-cell fallback, ingestion continues
        }
        sendJson(res, 200, { ok: true, ...ingestBatch(body, roads) });
      })();
    });
  }

  if (url.pathname === '/api/roads' && req.method === 'GET') {
    // geometry for specific OSM ways / sub-segments, for drawing on the dashboard
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 500);
    const roads = {};
    for (const fullId of ids) {
      const parts = fullId.split(':');
      const wayId = parts[0];
      const coords = wayIndex.get(wayId);
      if (!coords || !coords.length) continue;
      if (parts.length > 1 && parts[1].startsWith('s')) {
        const subIndex = parseInt(parts[1].slice(1), 10);
        if (!isNaN(subIndex)) {
          roads[fullId] = slicePolyline(coords, subIndex * 100, (subIndex + 1) * 100);
          continue;
        }
      }
      roads[fullId] = coords;
    }
    return sendJson(res, 200, { roads });
  }

  if (url.pathname === '/api/segments' && req.method === 'GET') {
    const minCount = Number(url.searchParams.get('minCount')) || 1;
    const segs = serializeSegments().filter((s) => s.count >= minCount);
    return sendJson(res, 200, { threshold: BAD_ROAD_THRESHOLD, segments: segs });
  }

  if (url.pathname === '/api/reports' && req.method === 'POST') {
    return readBody(req, (err, body) => {
      if (err) return sendJson(res, 400, { error: 'invalid json' });
      const seg = db.segments[body.segmentId];
      if (!seg) return sendJson(res, 404, { error: 'unknown segment' });
      const recent = seg.scores && seg.scores.length ? seg.scores : [seg.sum / seg.count];
      const avg = +median(recent).toFixed(1);
      const report = {
        id: 'RPT-' + Date.now().toString(36).toUpperCase(),
        segmentId: seg.id,
        roadName: seg.name || null,
        lat: +seg.lat.toFixed(5),
        lon: +seg.lon.toFixed(5),
        score: avg,
        quality: qualityLabel(avg),
        samples: seg.count,
        note: String(body.note || '').slice(0, 500),
        contact: String(body.contact || '').slice(0, 200),
        status: 'submitted',
        createdAt: Date.now()
      };
      db.reports.unshift(report);
      saveDb();
      sendJson(res, 200, { ok: true, report });
    });
  }

  if (url.pathname === '/api/reports' && req.method === 'GET') {
    return sendJson(res, 200, { reports: db.reports });
  }

  if (url.pathname === '/api/reset' && req.method === 'POST') {
    db = { segments: {}, reports: [] };
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Road Analysis server running at http://localhost:${PORT}`);
  console.log(`  Recorder PWA:  http://localhost:${PORT}/`);
  console.log(`  Dashboard:     http://localhost:${PORT}/dashboard.html`);
});
