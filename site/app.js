'use strict';

// Map sources. All free, no account needed.
const TOPO_TILES = ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`);
const SATELLITE_TILES = ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'];
const TERRAIN_TILEJSON = 'https://tiles.mapterhorn.com/tilejson.json';
const GRAY_TILES = (layer) => [`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${layer}/MapServer/tile/{z}/{y}/{x}`];
const DAY_COLORS = 8; // --day-1 … --day-8 in style.css

const app = document.getElementById('app');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const state = { data: null, types: new Map(), filter: 'all', peakOrder: 'visits', maps: [], view: null, scroll: {} };

init();

async function init() {
  try {
    const res = await fetch('data/summitbook.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    state.data = await res.json();
    if (!state.data.entries.length) throw new Error('no tours yet');
  } catch {
    app.innerHTML = `<div class="empty"><h2>Your summit book is empty</h2>
      <p>Connect Strava with <code>uv run summitbook login</code>, then download your tours with
      <code>uv run summitbook update</code>.</p></div>`;
    return;
  }
  const { data } = state;
  data.types.forEach((t) => state.types.set(t.id, { ...t, slot: t.color || 0 }));
  document.getElementById('site-title').textContent = data.title;
  document.getElementById('site-subtitle').textContent = data.subtitle || '';
  document.getElementById('updated').textContent = `Updated ${fmtDate(data.updated.slice(0, 10))} ·`;
  window.addEventListener('hashchange', route);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', route);
  setupLightbox();
  route();
}

function route() {
  if (state.view && state.view !== 'tour') state.scroll[state.view] = scrollY;
  state.maps.forEach((m) => m.remove());
  state.maps = [];
  const preview = location.hash.match(/^#\/preview\/([\w-]+)/);
  if (preview) return renderPreview(preview[1]);
  const tour = location.hash.match(/^#\/tour\/([\w-]+)/);
  if (tour) {
    state.view = 'tour';
    renderTour(tour[1]);
    scrollTo(0, 0);
  } else {
    const wasTour = state.view === 'tour';
    const view = { '#/peaks': 'peaks', '#/adventures': 'adventures' }[location.hash] || 'log';
    state.view = view;
    view === 'adventures' ? renderAdventures() : renderHome(view);
    scrollTo(0, wasTour ? state.scroll[view] || 0 : 0);
  }
}

// Summit book (ski tours, hikes, …) and bike adventures are separate sections.
function inCategory(category) {
  return state.data.entries.filter((e) => e.category === category);
}

function tabsHtml(view) {
  const tab = (hash, name, label) => `<a href="${hash}" ${view === name ? 'aria-current="page"' : ''}>${esc(label)}</a>`;
  return `<nav class="tabs" aria-label="View">
    ${tab('#/', 'log', 'Logbook')}${tab('#/peaks', 'peaks', 'Peaks')}
    ${inCategory('adventure').length ? tab('#/adventures', 'adventures', state.data.adventures_title) : ''}
  </nav>`;
}

// ---------- Home: stats, overview map, logbook / peaks ----------

function renderHome(view) {
  document.title = state.data.title;
  app.innerHTML = `
    <section class="stats" id="stats" aria-label="Totals"></section>
    <section aria-label="Map of all summits">
      <div id="overview-map" class="map map-overview"></div>
      <p class="map-legend" id="legend"></p>
    </section>
    <div class="toolbar">
      <div class="chips" id="chips" role="group" aria-label="Show activity type"></div>
      ${tabsHtml(view)}
    </div>
    <section id="list"></section>`;

  const map = overviewMap(document.getElementById('overview-map'));
  const update = (animate) => {
    const entries = filtered();
    renderStats(entries);
    renderChips(update);
    renderLegend(entries);
    document.getElementById('list').innerHTML = view === 'peaks' ? peaksHtml(entries) : logbookHtml(entries);
    map.show(entries, animate);
  };
  document.getElementById('list').addEventListener('click', (ev) => {
    const sort = ev.target.closest('[data-order]');
    if (sort) {
      state.peakOrder = sort.dataset.order;
      update(false);
      return;
    }
    const btn = ev.target.closest('[data-peak]');
    if (!btn) return;
    document.getElementById('overview-map').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    map.focusPeak(btn.dataset.peak);
  });
  update(false);
}

function filtered() {
  const all = inCategory('summits');
  return state.filter === 'all' ? all : all.filter((e) => e.type === state.filter);
}

function renderStats(entries) {
  const peaks = collectPeaks(entries);
  const visits = entries.reduce((n, e) => n + e.days.reduce((m, d) => m + d.summits.length, 0), 0);
  const highest = [...peaks.values()].filter((p) => p.ele).sort((a, b) => b.ele - a.ele)[0];
  const favorite = [...peaks.values()].sort((a, b) => b.visits.length - a.visits.length)[0];
  const gain = entries.reduce((n, e) => n + e.gain, 0);
  const tile = (label, value, note = '') =>
    `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${note ? `<span class="stat-note" title="${esc(note)}">${esc(note)}</span>` : ''}</div>`;
  document.getElementById('stats').innerHTML = [
    tile('Tours', fmtInt(entries.length)),
    tile('Summits', fmtInt(visits)),
    tile('Different peaks', fmtInt(peaks.size)),
    tile('Highest summit', highest ? fmtM(highest.ele) : '–', highest?.name),
    tile('Most visited', favorite ? `${favorite.visits.length}×` : '–', favorite?.name),
    tile('Elevation gain', fmtM(gain)),
  ].join('');
}

function renderChips(update) {
  const present = new Set(inCategory('summits').map((e) => e.type));
  const types = [...state.types.values()].filter((t) => present.has(t.id));
  const chip = (id, label, dot) =>
    `<button class="chip" type="button" data-type="${id}" aria-pressed="${state.filter === id}">${dot}${esc(label)}</button>`;
  const el = document.getElementById('chips');
  el.innerHTML = (types.length > 1 ? chip('all', 'All', '') : '') +
    types.map((t) => chip(t.id, plural(t.label), `<span class="dot" style="--c:${colorVar(t.id)}"></span>`)).join('');
  el.onclick = (ev) => {
    const btn = ev.target.closest('[data-type]');
    if (!btn || types.length < 2) return;
    state.filter = btn.dataset.type === state.filter ? 'all' : btn.dataset.type;
    update(true);
  };
}

function renderLegend(entries) {
  // One item per color: types sharing a color (e.g. hikes and climbs) are listed together.
  const byColor = new Map();
  new Set(entries.map((e) => e.type)).forEach((t) => {
    const color = colorVar(t);
    byColor.set(color, [...(byColor.get(color) || []), typeOf(t).label]);
  });
  const items = [...byColor].map(([color, labels]) => `<span><span class="dot" style="--c:${color}"></span>${esc(labels.join(' / '))}</span>`);
  if (entries.some((e) => !e.summits.length && e.high_point)) {
    items.push('<span><span class="dot hollow" style="--c:var(--ink-2)"></span>No summit (highest point of the tour)</span>');
  }
  items.push('<span>Bigger dot = visited more often</span>');
  document.getElementById('legend').innerHTML = items.join('');
}

function logbookHtml(entries, noun = 'tour') {
  if (!entries.length) return '<p class="empty">Nothing here yet.</p>';
  const years = new Map();
  entries.forEach((e) => {
    const y = e.date.slice(0, 4);
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(e);
  });
  return [...years].map(([year, list]) => `
    <h2 class="year">${year}<span>${list.length} ${list.length === 1 ? noun : `${noun}s`}</span></h2>
    <ol class="entries">${list.map(entryCard).join('')}</ol>`).join('');
}

function entryCard(e) {
  const photo = e.photos[0];
  const picture = photo
    ? `<img src="${esc(photo.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : e.preview ? `<img src="${esc(e.preview)}" alt="" loading="lazy">` : mountainIcon();
  return `<li><a class="entry" href="#/tour/${e.id}">
    <div class="entry-photo" style="--c:${colorVar(e.type)}">${picture}</div>
    <div class="entry-body">
      ${metaLine(e)}
      <h3 class="entry-title">${headline(e)}</h3>
      ${subline(e)}
      <p class="entry-stats">${statsLine(e)}</p>
    </div></a></li>`;
}

function peaksHtml(entries) {
  const byHeight = (a, b) => (b.ele ?? -1) - (a.ele ?? -1) || a.name.localeCompare(b.name);
  const byVisits = (a, b) => b.visits.length - a.visits.length || byHeight(a, b);
  const peaks = [...collectPeaks(entries).values()].sort(state.peakOrder === 'visits' ? byVisits : byHeight);
  if (!peaks.length) return '<p class="empty">No summits yet.</p>';
  const order = (key, label) => `<button type="button" data-order="${key}" aria-pressed="${state.peakOrder === key}">${label}</button>`;
  const rows = peaks.map((p) => `<tr>
      <td><button class="peak-link" type="button" data-peak="${p.id}">${esc(p.name)}</button></td>
      <td class="num">${p.ele ? fmtM(p.ele) : '–'}</td>
      <td class="num">${p.visits.length}×</td>
      <td class="dates">${p.visits.map((v) => `<a href="#/tour/${v.entry.id}">${fmtDate(v.date)}</a>`).join(', ')}</td>
    </tr>`).join('');
  return `<div class="seg peak-order" role="group" aria-label="Sort peaks">${order('visits', 'Most visited')}${order('height', 'Highest')}</div>
    <div class="table-wrap"><table class="peaks">
    <thead><tr><th scope="col">Peak</th><th scope="col" class="num">Height</th><th scope="col" class="num">Visits</th><th scope="col">Dates</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ---------- Bike adventures: totals, a map of all routes, the list ----------

function renderAdventures() {
  const entries = inCategory('adventure');
  const title = state.data.adventures_title;
  document.title = `${title} · ${state.data.title}`;
  const sum = (key) => entries.reduce((n, e) => n + e[key], 0);
  const longest = [...entries].sort((a, b) => b.days_total - a.days_total)[0];
  const tile = (label, value, note = '') =>
    `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span>${note ? `<span class="stat-note" title="${esc(note)}">${esc(note)}</span>` : ''}</div>`;
  app.innerHTML = `
    <section class="stats" aria-label="Totals">
      ${tile(title, fmtInt(entries.length))}
      ${tile('Days on the road', fmtInt(sum('days_total')))}
      ${tile('Distance', `${fmtInt(Math.round(sum('distance') / 1000))} km`)}
      ${tile('Elevation gain', fmtM(sum('gain')))}
      ${longest ? tile('Longest', `${longest.days_total} days`, titleText(longest)) : ''}
    </section>
    <section aria-label="Map of all ${esc(title.toLowerCase())}">
      <div id="overview-map" class="map map-overview"></div>
      <p class="map-legend">Click a route to see the trip.</p>
    </section>
    <div class="toolbar"><div></div>${tabsHtml('adventures')}</div>
    <section id="list">${logbookHtml(entries, 'adventure')}</section>`;
  routesMap(document.getElementById('overview-map'), entries);
}

function routesMap(container, entries) {
  const map = new maplibregl.Map({
    container, style: overviewStyle(), center: [11.4, 47.1], zoom: 4,
    cooperativeGestures: true, attributionControl: { compact: true },
  });
  state.maps.push(map);
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.FullscreenControl(), 'top-right');
  const popup = new maplibregl.Popup({ maxWidth: '280px' });
  const routes = fetch('data/adventures.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({}));

  map.on('load', async () => {
    const lines = await routes;
    const shown = entries.filter((e) => lines[e.id]?.length);
    const features = shown.map((e, i) => ({
      type: 'Feature', id: i, properties: { i },
      geometry: { type: 'MultiLineString', coordinates: lines[e.id] },
    }));
    map.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features } });
    const round = { 'line-join': 'round', 'line-cap': 'round' };
    const hover = (a, b) => ['case', ['boolean', ['feature-state', 'hover'], false], a, b];
    map.addLayer({ id: 'routes-casing', type: 'line', source: 'routes', layout: round, paint: { 'line-color': cssVar('--surface'), 'line-width': hover(8, 5.5) } });
    map.addLayer({ id: 'routes', type: 'line', source: 'routes', layout: round, paint: { 'line-color': cssVar('--series-3'), 'line-width': hover(5, 3) } });
    map.addLayer({ id: 'routes-hit', type: 'line', source: 'routes', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16 } });

    let hovered = null;
    const setHover = (id) => {
      if (hovered !== null) map.setFeatureState({ source: 'routes', id: hovered }, { hover: false });
      hovered = id;
      if (id !== null) map.setFeatureState({ source: 'routes', id }, { hover: true });
      map.getCanvas().style.cursor = id === null ? '' : 'pointer';
    };
    map.on('mousemove', 'routes-hit', (ev) => setHover(ev.features[0].id));
    map.on('mouseleave', 'routes-hit', () => setHover(null));
    map.on('click', 'routes-hit', (ev) => {
      const e = shown[ev.features[0].properties.i];
      popup.setLngLat(ev.lngLat)
        .setHTML(`<strong>${esc(titleText(e))}</strong><br>${fmtRange(e.date, e.end_date)} · ${e.days_total} days<br>
          ${fmtInt(Math.round(e.distance / 1000))} km · ↑ ${fmtM(e.gain)}<ul><li><a href="#/tour/${e.id}">Open the trip →</a></li></ul>`)
        .addTo(map);
    });

    const coords = features.flatMap((f) => f.geometry.coordinates.flat());
    if (coords.length) {
      const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(bounds, { padding: 40, duration: 0 });
    }
  });
}

// ---------- Tour page: 3D map, days, summits, photos ----------

function renderTour(id) {
  const found = state.data.entries.find((e) => String(e.id) === id);
  if (!found) {
    app.innerHTML = '<a class="back" href="#/">← All tours</a><p class="empty">This tour isn\'t in the summit book.</p>';
    return;
  }
  const e = found;
  const adventure = e.category === 'adventure';
  const list = inCategory(e.category);
  const i = list.indexOf(e);
  const newer = list[i - 1];
  const older = list[i + 1];
  const hasMap = e.days.some((d) => d.track);
  document.title = `${titleText(e)} · ${state.data.title}`;
  const tile = (label, value) =>
    `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></div>`;

  app.innerHTML = `
    <a class="back" href="${adventure ? '#/adventures' : '#/'}">← ${adventure ? `All ${esc(state.data.adventures_title.toLowerCase())}` : 'All tours'}</a>
    <header class="tour-head">
      ${metaLine(e)}
      <h1>${headline(e)}</h1>
      ${subline(e)}
      ${e.multi ? '' : stravaLink(e.days[0])}
    </header>
    <section class="stats" aria-label="Tour stats">
      ${e.multi ? tile('Days', e.days_total) : ''}
      ${tile('Distance', fmtKm(e.distance))}
      ${tile('Elevation gain', fmtM(e.gain))}
      ${tile('Moving time', fmtDuration(e.moving_time))}
      ${e.elev_high != null ? tile('Highest point', fmtM(e.elev_high)) : ''}
    </section>
    ${hasMap ? `
      <section aria-label="3D map of the route">
        <div id="tour-map" class="map map-tour"></div>
        <div class="map-tools">
          <div class="seg" role="group" aria-label="Map style">
            <button type="button" data-base="satellite" aria-pressed="true">Satellite</button>
            <button type="button" data-base="topo" aria-pressed="false">Topo map</button>
          </div>
          <button class="btn" type="button" id="spin" aria-pressed="false">Fly around</button>
        </div>
      </section>` : ''}
    ${e.multi ? `
      <h2 class="section-title">Days</h2>
      <ol class="days">${e.days.map((d, n) => dayCard(e, d, n)).join('')}</ol>` : ''}
    ${e.summits.length ? `
      <h2 class="section-title">${e.summits.length === 1 ? 'Summit' : 'Summits'}</h2>
      <ul class="summit-list">${e.summits.map((s, n) => `
        <li><button class="chip" type="button" data-summit="${n}" ${hasMap ? '' : 'disabled'}>
          <span class="dot" style="--c:${summitColor(e, s)}"></span>${esc(s.name)}${s.ele ? ` <span class="ele">${fmtM(s.ele)}</span>` : ''}
        </button></li>`).join('')}
      </ul>` : ''}
    ${e.photos.length ? `
      <h2 class="section-title">Photos</h2>
      <div class="photos">${e.photos.map((p, n) => `
        <button class="photo" type="button" data-photo="${n}" aria-label="Open photo ${n + 1}${p.caption ? `: ${esc(p.caption)}` : ''}">
          <img src="${esc(p.thumb)}" alt="${esc(p.caption)}" loading="lazy" referrerpolicy="no-referrer">
        </button>`).join('')}
      </div>` : ''}
    <nav class="pager" aria-label="More tours">
      ${older ? `<a class="older" href="#/tour/${older.id}"><small>← Older</small>${esc(titleText(older))}</a>` : ''}
      ${newer ? `<a class="newer" href="#/tour/${newer.id}"><small>Newer →</small>${esc(titleText(newer))}</a>` : ''}
    </nav>`;

  app.querySelectorAll('[data-photo]').forEach((btn) =>
    btn.addEventListener('click', () => openLightbox(e.photos, Number(btn.dataset.photo))));
  if (hasMap) tourMap(document.getElementById('tour-map'), e);
}

function dayCard(e, d, n) {
  const title = d.summits.length ? summitNames(d.summits) : esc(d.name);
  return `<li class="day" style="--c:${dayColor(e, d.day)}">
    <p class="meta"><span class="dot"></span><strong>Day ${d.day}</strong><span>·</span>
      <time datetime="${d.date}">${fmtWeekday(d.date)}</time><span>·</span><span>${esc(typeOf(d.type).label)}</span></p>
    <h3 class="day-title">${title}</h3>
    ${d.summits.length ? `<p class="entry-name">${esc(d.name)}</p>` : ''}
    <p class="entry-stats">${statsLine(d)}</p>
    <p class="day-links">
      ${d.track ? `<button class="link-btn" type="button" data-day="${n}">Show on map</button><span class="sep">·</span>` : ''}
      ${stravaLink(d)}
    </p>
  </li>`;
}

// A picture of the 3D map for tours without photos: `summitbook previews` opens this page in a
// browser without a screen, waits until window.summitbookPreviewReady, and saves a screenshot.
function renderPreview(id) {
  const e = state.data.entries.find((x) => String(x.id) === id);
  document.body.classList.add('preview');
  app.innerHTML = `<div id="tour-map" class="map map-preview"></div>
    <p class="preview-credit">Imagery © Esri, Maxar, Earthstar Geographics · Terrain © Mapterhorn</p>`;
  if (e) tourMap(document.getElementById('tour-map'), e, { preview: true });
}

function tourMap(container, e, { preview = false } = {}) {
  const style = baseStyle('satellite');
  style.sources.dem = { type: 'raster-dem', url: TERRAIN_TILEJSON, tileSize: 512, encoding: 'terrarium' };
  style.terrain = { source: 'dem', exaggeration: 1 };
  const first = e.summits[0] || (e.high_point && { lat: e.high_point[0], lon: e.high_point[1] });

  const map = new maplibregl.Map({
    container, style,
    center: first ? [first.lon, first.lat] : [11.4, 47.2], zoom: 12,
    maxPitch: 80, cooperativeGestures: !preview, interactive: !preview,
    attributionControl: preview ? false : { compact: true }, fadeDuration: preview ? 0 : 300,
  });
  state.maps.push(map);
  if (!preview) {
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new maplibregl.FullscreenControl(), 'top-right');
  }
  const tracks = Promise.all(e.days.map((d) =>
    d.track ? fetch(`data/tracks/${d.id}.json`).then((r) => r.json()).catch(() => null) : null));
  const dayBounds = [];

  const marker = (lngLat, html, color, onClick) => {
    const el = document.createElement('div');
    el.className = 'summit-marker';
    el.style.setProperty('--c', color);
    el.innerHTML = `<span class="label">${html}</span><span class="stem"></span><span class="tip"></span>`;
    if (onClick) el.addEventListener('click', onClick);
    new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(lngLat).addTo(map);
  };
  const dayBadge = (lngLat, n, color, onClick) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'day-badge';
    el.style.setProperty('--c', color);
    el.textContent = n;
    el.setAttribute('aria-label', `Show day ${n}`);
    el.addEventListener('click', onClick);
    new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(lngLat).addTo(map);
  };
  // The camera looks from where the tour starts towards its highest summit, like the view from the valley.
  let bearing = -20;
  const aim = (from, to) => {
    if (!from || !to || (from[0] === to.lon && from[1] === to.lat)) return;
    const [l1, p1, l2, p2] = [from[0], from[1], to.lon, to.lat].map((d) => (d * Math.PI) / 180);
    const y = Math.sin(l2 - l1) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1);
    bearing = (Math.atan2(y, x) * 180) / Math.PI;
  };
  let pitch = 60;
  const camera = (bounds) => {
    const cam = map.cameraForBounds(bounds, { padding: 60, bearing });
    // The tilted camera squashes the route front-to-back, so it can come a bit closer than a flat fit.
    return cam && { center: cam.center, zoom: cam.zoom + 0.25, bearing, pitch };
  };
  // Show the route from above first, and tilt into 3D once the terrain has loaded: the camera
  // needs the ground height at the center, otherwise it ends up far too low.
  const intro = (bounds) => {
    const view = camera(bounds);
    if (!view) return;
    map.jumpTo({ ...view, pitch: 0 });
    let done = false;
    const tilt = () => {
      if (done) return;
      done = true;
      reduceMotion ? map.jumpTo({ pitch: view.pitch }) : map.easeTo({ pitch: view.pitch, duration: 2500 });
    };
    map.once('idle', tilt);
    setTimeout(tilt, 6000);
  };
  const fit = (bounds) => {
    stopSpin();
    const view = camera(bounds);
    if (view) reduceMotion ? map.jumpTo(view) : map.flyTo({ ...view, duration: 2000 });
  };
  const flyTo = (s) => {
    stopSpin();
    map.flyTo({ center: [s.lon, s.lat], zoom: 14.6, pitch: 65, bearing, duration: reduceMotion ? 0 : 2500 });
  };

  map.on('load', async () => {
    try {
      map.setSky({ 'sky-color': '#7fb2e5', 'horizon-color': '#dce8f2', 'fog-color': '#dce8f2', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85 });
    } catch { /* older browsers: no sky, no problem */ }
    const all = await tracks;
    let total = null;
    let start = null;
    let end = null;
    const badged = new Set();
    all.forEach((points, n) => {
      if (!points?.length) return;
      const day = e.days[n].day;
      const color = dayColor(e, day);
      const coords = points.map((p) => [p[1], p[0]]);
      start ??= coords[0];
      end = coords[coords.length - 1];
      map.addSource(`day-${n}`, { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } } });
      map.addLayer({ id: `day-${n}-casing`, type: 'line', source: `day-${n}`, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.85 } });
      map.addLayer({ id: `day-${n}`, type: 'line', source: `day-${n}`, layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': color, 'line-width': 4 } });
      const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      dayBounds[n] = b;
      total = total ? total.extend(b) : new maplibregl.LngLatBounds(b.getSouthWest(), b.getNorthEast());
      if (e.multi) {
        // Label each day a quarter of the way along its route, so days from the same hut don't overlap.
        // Long trips only get every 5th day labelled, plus the first and last.
        const labelled = e.days_total <= DAY_COLORS || day === 1 || day % 5 === 0 || day === e.days_total;
        if (labelled && !badged.has(day)) dayBadge(coords[Math.floor(coords.length / 4)], day, color, () => fit(b));
        badged.add(day);
      } else {
        map.addSource('start', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Point', coordinates: coords[0] } } });
        map.addLayer({ id: 'start', type: 'circle', source: 'start', paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': color, 'circle-stroke-width': 3 } });
      }
    });

    const peaks = e.summits.length
      ? e.summits
      : e.high_point ? [{ lat: e.high_point[0], lon: e.high_point[1], ele: e.high_point[2], name: 'Highest point' }] : [];
    peaks.forEach((s) => marker([s.lon, s.lat], `${esc(s.name)}${s.ele ? ` <small>${fmtM(s.ele)}</small>` : ''}`,
      s.id ? summitColor(e, s) : dayColor(e, 1), () => flyTo(s)));
    // Mountain tours: look from the start towards the highest summit. Journeys from A to B
    // (e.g. a bike tour): look along the way, a bit less tilted so long routes stay in view.
    const km = (a, b) => (a && b ? new maplibregl.LngLat(...a).distanceTo(new maplibregl.LngLat(...b)) / 1000 : 0);
    if (km(start, end) > 10) {
      aim(start, { lon: end[0], lat: end[1] });
      pitch = 45;
    } else {
      aim(start, [...peaks].sort((a, b) => (b.ele ?? 0) - (a.ele ?? 0))[0]);
    }
    if (preview) {
      let failed = false;
      map.on('error', () => { failed = true; }); // e.g. a map piece that didn't download
      // Summit tours: close up on the highest summit. Others (couloirs, bike trips): the whole route.
      const top = [...e.summits].sort((a, b) => (b.ele ?? 0) - (a.ele ?? 0))[0];
      const view = top && e.category === 'summits'
        ? { center: [top.lon, top.lat], zoom: 13.4, bearing, pitch: 62 }
        : total && camera(total);
      const settled = () => new Promise((resolve) => { map.once('idle', resolve); setTimeout(resolve, 20000); });
      if (view) {
        map.jumpTo({ ...view, pitch: 0 }); // flat first, so the terrain under the center loads
        await settled();
        map.jumpTo(view);
        await settled();
      }
      if (failed || !map.areTilesLoaded()) window.summitbookPreviewFailed = true;
      else window.summitbookPreviewReady = true;
      return;
    }
    if (total) intro(total);
  });

  app.querySelectorAll('[data-summit]').forEach((btn) =>
    btn.addEventListener('click', () => {
      container.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      flyTo(e.summits[Number(btn.dataset.summit)]);
    }));
  app.querySelectorAll('[data-day]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const b = dayBounds[Number(btn.dataset.day)];
      if (!b) return;
      container.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      fit(b);
    }));
  app.querySelectorAll('[data-base]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const base = btn.dataset.base;
      ['satellite', 'topo'].forEach((b) => map.setLayoutProperty(b, 'visibility', b === base ? 'visible' : 'none'));
      app.querySelectorAll('[data-base]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    }));

  if (preview) return;

  // "Fly around": slowly circle the camera around the tour.
  const spinBtn = document.getElementById('spin');
  let spinning = false;
  const spin = () => spinning && map.easeTo({ bearing: map.getBearing() + 40, duration: 4000, easing: (t) => t });
  function stopSpin() {
    spinning = false;
    spinBtn.setAttribute('aria-pressed', 'false');
    spinBtn.textContent = 'Fly around';
  }
  map.on('moveend', spin);
  spinBtn.addEventListener('click', () => {
    if (spinning) return stopSpin();
    spinning = true;
    spinBtn.setAttribute('aria-pressed', 'true');
    spinBtn.textContent = 'Stop';
    spin();
  });
  ['mousedown', 'touchstart', 'wheel'].forEach((ev) => container.addEventListener(ev, () => spinning && stopSpin(), { passive: true }));
}

// ---------- Overview map ----------

function overviewMap(container) {
  const map = new maplibregl.Map({
    container, style: overviewStyle(), center: [11.4, 47.1], zoom: 6,
    cooperativeGestures: true, attributionControl: { compact: true },
  });
  state.maps.push(map);
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.FullscreenControl(), 'top-right');

  let ready = false;
  let pending = null;
  let places = new Map();
  const popup = new maplibregl.Popup({ offset: 10, maxWidth: '280px' });

  const show = (entries, animate) => {
    if (!ready) {
      pending = [entries, animate];
      return;
    }
    places = new Map();
    collectPeaks(entries).forEach((p) =>
      places.set(`p${p.id}`, { lat: p.lat, lon: p.lon, summit: true, type: p.visits[0].entry.type, title: p.name, ele: p.ele, visits: p.visits }));
    entries.filter((e) => !e.summits.length && e.high_point).forEach((e) =>
      places.set(`e${e.id}`, { lat: e.high_point[0], lon: e.high_point[1], summit: false, type: e.type, title: titleText(e), ele: e.high_point[2], visits: [{ entry: e, date: e.date }] }));

    const features = [...places].map(([key, p]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { key, summit: p.summit, visits: p.visits.length, color: cssVar(colorVar(p.type, true)) },
    }));
    map.getSource('places').setData({ type: 'FeatureCollection', features });
    popup.remove();
    // Start on the area with most of the summits; far-away ones (other continents) are a zoom-out away.
    const home = homeRegion(features.map((f) => f.geometry.coordinates));
    if (home.length) {
      const bounds = home.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(home[0], home[0]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 12, duration: animate && !reduceMotion ? 1200 : 0 });
    }
  };

  const openPopup = (key) => {
    const p = places.get(key);
    if (!p) return;
    const visits = p.visits.map(({ entry, date }) =>
      `<li><a href="#/tour/${entry.id}">${fmtDate(date)}</a> · ${entry.multi ? esc(entry.title) : esc(typeOf(entry.type).label)}</li>`).join('');
    popup.setLngLat([p.lon, p.lat])
      .setHTML(`<strong>${esc(p.title)}</strong>${p.ele ? ` ${fmtM(p.ele)}` : ''}${p.summit ? '' : '<br><small>Highest point, no summit</small>'}<ul>${visits}</ul>`)
      .addTo(map);
  };

  map.on('load', () => {
    map.addSource('places', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'places', type: 'circle', source: 'places',
      layout: { 'circle-sort-key': ['-', 0, ['get', 'visits']] }, // big dots below small ones
      paint: {
        'circle-radius': ['+', 3, ['*', 2.2, ['sqrt', ['get', 'visits']]]], // bigger = visited more often
        'circle-color': ['case', ['get', 'summit'], ['get', 'color'], '#ffffff'],
        'circle-stroke-color': ['case', ['get', 'summit'], '#ffffff', ['get', 'color']],
        'circle-stroke-width': ['case', ['get', 'summit'], 2, 3],
      },
    });
    map.on('click', 'places', (ev) => openPopup(ev.features[0].properties.key));
    map.on('mouseenter', 'places', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'places', () => { map.getCanvas().style.cursor = ''; });
    ready = true;
    if (pending) show(...pending);
  });

  return {
    show,
    focusPeak(id) {
      const p = places.get(`p${id}`);
      if (!p) return;
      map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 12), duration: reduceMotion ? 0 : 1500 });
      openPopup(`p${id}`);
    },
  };
}

// Overview: a quiet gray map with shaded mountains, so the colored markers stand out.
function overviewStyle() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const tone = dark ? 'Dark' : 'Light';
  return {
    version: 8,
    sources: {
      base: { type: 'raster', tiles: GRAY_TILES(`World_${tone}_Gray_Base`), tileSize: 256, maxzoom: 16 },
      labels: {
        type: 'raster', tiles: GRAY_TILES(`World_${tone}_Gray_Reference`), tileSize: 256, maxzoom: 16,
        attribution: 'Basemap © Esri, HERE, Garmin, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
      relief: { type: 'raster-dem', url: TERRAIN_TILEJSON, tileSize: 512, encoding: 'terrarium' },
    },
    layers: [
      { id: 'base', type: 'raster', source: 'base' },
      {
        id: 'relief', type: 'hillshade', source: 'relief',
        paint: {
          'hillshade-exaggeration': dark ? 0.45 : 0.35,
          'hillshade-shadow-color': dark ? '#000000' : '#5b5546',
          'hillshade-highlight-color': dark ? '#3a3a37' : '#ffffff',
          'hillshade-accent-color': dark ? '#000000' : '#5b5546',
        },
      },
      { id: 'labels', type: 'raster', source: 'labels' },
    ],
  };
}

// The points within 800 km of the middle of all points (if that's most of them).
function homeRegion(points) {
  if (points.length < 3) return points;
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const middle = new maplibregl.LngLat(median(points.map((p) => p[0])), median(points.map((p) => p[1])));
  const near = points.filter((p) => middle.distanceTo(new maplibregl.LngLat(...p)) < 800_000);
  return near.length >= points.length / 2 ? near : points;
}

function baseStyle(base) {
  return {
    version: 8,
    sources: {
      topo: {
        type: 'raster', tiles: TOPO_TILES, tileSize: 256, maxzoom: 17,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM · style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
      },
      satellite: {
        type: 'raster', tiles: SATELLITE_TILES, tileSize: 256, maxzoom: 19,
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      },
    },
    layers: ['topo', 'satellite'].map((id) => ({
      id, type: 'raster', source: id, layout: { visibility: id === base ? 'visible' : 'none' },
    })),
  };
}

// ---------- Photo viewer ----------

let lightboxPhotos = [];
let lightboxIndex = 0;

function setupLightbox() {
  const box = document.getElementById('lightbox');
  box.querySelector('.lb-close').addEventListener('click', () => box.close());
  box.querySelector('.lb-prev').addEventListener('click', () => showPhoto(lightboxIndex - 1));
  box.querySelector('.lb-next').addEventListener('click', () => showPhoto(lightboxIndex + 1));
  box.addEventListener('click', (ev) => { if (ev.target === box) box.close(); });
  box.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft') showPhoto(lightboxIndex - 1);
    if (ev.key === 'ArrowRight') showPhoto(lightboxIndex + 1);
  });
}

function openLightbox(photos, index) {
  lightboxPhotos = photos;
  const box = document.getElementById('lightbox');
  box.querySelectorAll('.lb-prev, .lb-next').forEach((b) => { b.hidden = photos.length < 2; });
  showPhoto(index);
  box.showModal();
}

function showPhoto(index) {
  const n = lightboxPhotos.length;
  lightboxIndex = (index + n) % n;
  const p = lightboxPhotos[lightboxIndex];
  const img = document.getElementById('lb-img');
  img.src = p.full;
  img.alt = p.caption || `Photo ${lightboxIndex + 1} of ${n}`;
  document.getElementById('lb-caption').textContent = p.caption || (n > 1 ? `${lightboxIndex + 1} / ${n}` : '');
}

// ---------- Helpers ----------

// Every peak with its visits: { entry, date } for each day it was reached.
function collectPeaks(entries) {
  const peaks = new Map();
  entries.forEach((e) => [...e.days].reverse().forEach((d) => d.summits.forEach((s) => {
    if (!peaks.has(s.id)) peaks.set(s.id, { ...s, visits: [] });
    peaks.get(s.id).visits.push({ entry: e, date: d.date });
  })));
  return peaks; // entries are newest first, so visits[0] is the latest visit
}

// The big title: your own / multi-day title, else the summits, else the Strava name.
function headline(e) {
  return e.titled || !e.summits.length ? esc(e.title) : summitNames(e.summits);
}

// The line under it: the summits (if the title isn't them), else the Strava name.
function subline(e) {
  if (e.titled) return e.summits.length ? `<p class="entry-name">▲ ${summitNames(e.summits)}</p>` : '';
  return e.summits.length ? `<p class="entry-name">${esc(e.title)}</p>` : '';
}

function summitNames(summits) {
  return summits.map((s) => `${esc(s.name)}${s.ele ? ` <span class="ele">${fmtM(s.ele)}</span>` : ''}`).join('<span class="sep"> · </span>');
}

function titleText(e) {
  return e.titled || !e.summits.length ? e.title : e.summits.map((s) => s.name).join(' · ');
}

function metaLine(e) {
  const parts = [`<span>${esc(typeOf(e.type).label)}</span>`, `<time datetime="${e.date}">${fmtRange(e.date, e.end_date)}</time>`];
  if (e.multi) parts.push(`<span>${e.days_total} days</span>`);
  if (e.photos.length) parts.push(`<span>${e.photos.length} ${e.photos.length === 1 ? 'photo' : 'photos'}</span>`);
  return `<p class="meta"><span class="dot" style="--c:${colorVar(e.type)}"></span>${parts.join('<span>·</span>')}</p>`;
}

function statsLine(e) {
  return [fmtKm(e.distance), `↑ ${fmtM(e.gain)}`, e.moving_time ? fmtDuration(e.moving_time) : '']
    .filter(Boolean).join(' <span class="sep">·</span> ');
}

function stravaLink(day) {
  if (day.source === 'file') return '<span class="imported">Imported from a GPX/FIT file</span>';
  return `<a class="strava-link" href="https://www.strava.com/activities/${day.id}" target="_blank" rel="noopener">View on Strava</a>`;
}

function mountainIcon() {
  return '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M2 27 12 9l5 8 4-5 9 15z"/></svg>';
}

function typeOf(id) {
  return state.types.get(id) || { id, label: id, slot: 0 };
}

// Colors: by activity type, or by day on multi-day trips. bare=true gives the CSS variable
// name (for reading the actual color), otherwise var(--…) for use in styles.
function colorVar(type, bare = false) {
  const slot = typeOf(type).slot;
  const name = slot >= 1 && slot <= 3 ? `--series-${slot}` : '--other';
  return bare ? name : `var(${name})`;
}

// Each day of a trip in its own color. Long trips (more days than colors) go from light on
// the first day to dark on the last instead, so the progress along the way stays readable.
function dayColor(e, day) {
  if (!e.multi) return cssVar(colorVar(e.type, true));
  if (e.days_total <= DAY_COLORS) return cssVar(`--day-${day}`);
  return mixColors(cssVar('--ramp-from'), cssVar('--ramp-to'), (day - 1) / Math.max(e.days_total - 1, 1));
}

function summitColor(e, summit) {
  const d = e.days.find((x) => x.summits.some((s) => s.id === summit.id));
  return dayColor(e, d ? d.day : 1);
}

function mixColors(a, b, t) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function plural(label) {
  return label.endsWith('s') ? label : `${label}s`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const fmtInt = (n) => n.toLocaleString('en-US');
const fmtM = (m) => `${Math.round(m).toLocaleString('en-US')} m`;
const fmtKm = (m) => (m >= 100000 ? `${fmtInt(Math.round(m / 1000))} km` : `${(m / 1000).toFixed(1)} km`);
function fmtDuration(s) {
  const h = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(min).padStart(2, '0')} h` : `${min} min`;
}
const asDate = (iso) => new Date(`${iso}T12:00:00`);
function fmtDate(iso) {
  return asDate(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtWeekday(iso) {
  return asDate(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
function fmtRange(a, b) {
  if (!b || a === b) return fmtDate(a);
  if (a.slice(0, 7) === b.slice(0, 7)) return `${asDate(a).getDate()}–${fmtDate(b)}`;
  if (a.slice(0, 4) === b.slice(0, 4)) return `${asDate(a).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${fmtDate(b)}`;
  return `${fmtDate(a)} – ${fmtDate(b)}`;
}
