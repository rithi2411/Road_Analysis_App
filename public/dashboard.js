/* Road Scan dashboard */

let map, markers = [];
let segments = [];
let selected = null;

const THRESHOLD = 45; // server also enforces this

function colorFor(score) {
  if (score < 30) return '#22c55e';
  if (score < 45) return '#eab308';
  if (score < 65) return '#f97316';
  return '#ef4444';
}

/* Draw the actual mapped road polyline when we have the geometry, so scores
 * sit exactly on the road instead of a dot that may look off-road. */
let roadLayers = [];
async function renderRoadPolylines() {
  const wayIds = new Set(
    segments.filter((s) => s.id.startsWith('way:')).map((s) => s.id.slice(4))
  );
  roadLayers.forEach((l) => map.removeLayer(l));
  roadLayers = [];
  if (!wayIds.size) return;
  const res = await fetch('/api/roads?ids=' + encodeURIComponent([...wayIds].join(',')));
  const { roads } = await res.json();
  segments.forEach((s) => {
    if (!s.id.startsWith('way:')) return;
    const coords = roads[s.id.slice(4)];
    if (!coords || !coords.length) return;
    const c = colorFor(s.avg);
    roadLayers.push(L.polyline(coords, {
      color: c, weight: 7, opacity: 0.75,
      lineCap: 'round', dashArray: s.confidence === 'low' ? '10 6' : null
    }).addTo(map).bindPopup(popupHtml(s)));
  });
}

function popupHtml(s) {
  const label = s.name || (s.source === 'grid' ? 'Unnamed area (grid cell)' : 'Unnamed road');
  return `<b>${s.quality.toUpperCase()}</b> — score ${s.avg}<br/>` +
    `${label}<br/>readings: ${s.count} from ${s.devices} device(s)<br/>` +
    `<button onclick="window.showReport('${s.id}')">📩 Report to municipality</button>`;
}

function initMap() {
  map = L.map('map').setView([13.08, 80.27], 13); // default view; recentres on data
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap'
  }).addTo(map);
}

function renderMap() {
  markers.forEach((m) => map.removeLayer(m));
  markers = segments.map((s) => {
    const c = colorFor(s.avg);
    // OSM-mapped segments draw as road polylines (renderRoadPolylines);
    // keep a small dot exactly at the measured stretch as a footer marker.
    const isWay = s.id.startsWith('way:');
    const m = L.circleMarker([s.lat, s.lon], {
      radius: isWay ? 4 : Math.min(22, 6 + Math.log2(1 + s.count) * 3),
      color: c, fillColor: c, fillOpacity: isWay ? 0.9 : 0.55, weight: 2
    }).addTo(map).bindPopup(popupHtml(s));
    return m;
  });
  if (segments.length) {
    const lats = segments.map((s) => s.lat), lons = segments.map((s) => s.lon);
    map.fitBounds([
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)]
    ], { padding: [30, 30] });
  }
}

function renderTable() {
  const tb = document.querySelector('#segTable tbody');
  const worst = segments.slice().sort((a, b) => b.avg - a.avg);
  tb.innerHTML = worst.map((s) => `
    <tr style="border-left:4px solid ${colorFor(s.avg)}">
      <td>${s.name || (s.source === 'grid' ? '<span class="muted">(unmapped area)</span>' : '<span class="muted">Unnamed road</span>')}</td>
      <td class="mono">${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}</td>
      <td><b>${s.avg}</b></td>
      <td>${s.quality}</td>
      <td>${s.count}</td>
      <td>${s.devices}</td>
      <td>${s.confidence}</td>
      <td>${s.avg >= THRESHOLD
        ? `<button onclick="window.showReport('${s.id}')">📩 Report</button>`
        : '<span class="muted">ok</span>'}</td>
    </tr>`).join('');
}

async function refreshReports() {
  const res = await fetch('/api/reports');
  const { reports } = await res.json();
  const el = document.getElementById('reportsList');
  if (!reports.length) { el.textContent = 'No reports filed yet.'; return; }
  el.innerHTML = reports.map((r) => `
    <div class="report">
      <b>${r.id}</b> — seg ${r.segmentId} @ ${r.lat}, ${r.lon}<br/>
      score ${r.score} (${r.quality}), ${r.samples} readings • status: <b>${r.status}</b>
      ${r.note ? '<br/>“' + r.note + '”' : ''}
    </div>`).join('');
}

window.showReport = function (segmentId) {
  const s = segments.find((x) => x.id === segmentId);
  if (!s) return;
  selected = s;
  document.getElementById('dlgInfo').innerHTML =
    `Road: <b>${s.name || (s.source === 'grid' ? 'unmapped area' : 'unnamed road')}</b><br/>` +
    `Segment <b>${s.id}</b> at <span class="mono">${s.lat}, ${s.lon}</span><br/>` +
    `Average roughness score <b>${s.avg}</b> (${s.quality}) from ${s.count} readings.`;
  document.getElementById('reportDlg').showModal();
};

document.getElementById('dlgCancel').onclick = () =>
  document.getElementById('reportDlg').close();

document.getElementById('dlgFile').onclick = async () => {
  if (!selected) return;
  const note = document.getElementById('dlgNote').value;
  const contact = document.getElementById('dlgContact').value;
  const res = await fetch('/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ segmentId: selected.id, note, contact })
  });
  const { report } = await res.json();
  document.getElementById('reportDlg').close();

  // Open the user's mail client with a pre-filled report (works with any
  // municipality address you configure). Coordinates + quality included.
  const subject = encodeURIComponent(
    `Road quality complaint ${report.id} — ${report.quality} road condition`);
  const body = encodeURIComponent(
    `To the Municipal Roads Department,\n\n` +
    `A road quality issue has been detected and reported via the Road Scan app.\n\n` +
    `Report ID: ${report.id}\n` +
    `Road: ${report.roadName || 'unnamed road'}\n` +
    `Location (lat, lon): ${report.lat}, ${report.lon}\n` +
    `Google Maps: https://maps.google.com/?q=${report.lat},${report.lon}\n` +
    `Measured roughness score: ${report.score} / 100 (${report.quality})\n` +
    `Number of independent readings: ${report.samples}\n` +
    `${note ? 'Citizen note: ' + note + '\n' : ''}` +
    `${contact ? 'Contact: ' + contact + '\n' : ''}` +
    `\n— Sent via Road Scan crowdsourced road monitoring`);
  window.open(`mailto:municipality@example.gov?subject=${subject}&body=${body}`, '_self');

  refreshReports();
};

async function refresh() {
  const res = await fetch('/api/segments');
  const data = await res.json();
  segments = data.segments;
  renderMap();
  renderTable();
  renderRoadPolylines();
}

initMap();
refresh();
setInterval(refresh, 15000);
refreshReports();
