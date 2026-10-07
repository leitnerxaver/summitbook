'use strict';

// Map sources. All free, no account needed.
const TOPO_TILES = ['a', 'b', 'c'].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`);
const SATELLITE_TILES = ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'];
const TERRAIN_TILEJSON = 'https://tiles.mapterhorn.com/tilejson.json';
const GRAY_TILES = (layer) => [`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${layer}/MapServer/tile/{z}/{y}/{x}`];
// Hand-painted maps (Stamen Watercolor, hosted by Stadia Maps; free, the website's address is
// registered in a Stadia account). Without that, the maps fall back to the quiet gray ones.
const STADIA = (style, ext) => [`https://tiles.stadiamaps.com/tiles/${style}/{z}/{x}/{y}.${ext}`];
const STADIA_CREDIT = '© <a href="https://stadiamaps.com/">Stadia Maps</a> © <a href="https://stamen.com/">Stamen Design</a> © <a href="https://openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
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
    return;
  }
  if (location.hash === '#/adventures') { // (links from older versions)
    state.filter = 'adventure';
    history.replaceState(null, '', '#/');
  }
  const wasTour = state.view === 'tour';
  const view = { '#/peaks': 'peaks', '#/stats': 'stats', '#/plans': 'plans', '#/gear': 'gear', '#/about': 'about' }[location.hash] || 'log';
  state.view = view;
  ({ stats: renderStatsPage, plans: renderPlans, gear: renderGear, about: renderAbout }[view] || renderHome)(view);
  scrollTo(0, wasTour ? state.scroll[view] || 0 : 0);
}

// Summit tours (ski tours, hikes, …) and bike adventures.
function inCategory(category) {
  return state.data.entries.filter((e) => e.category === category);
}

function tabsHtml(view) {
  const tab = (hash, name, label) => `<a href="${hash}" ${view === name ? 'aria-current="page"' : ''}>${label}</a>`;
  return `<nav class="tabs" aria-label="View">${tab('#/', 'log', 'Logbook')}${tab('#/peaks', 'peaks', 'Peaks')}${tab('#/stats', 'stats', 'Stats')}${tab('#/plans', 'plans', 'Plans')}${tab('#/gear', 'gear', 'Gear')}${tab('#/about', 'about', 'About')}</nav>`;
}

// ---------- Home: stats, overview map, logbook / peaks ----------

function renderHome(view) {
  document.title = state.data.title;
  app.innerHTML = `
    <div class="toolbar">
      ${tabsHtml(view)}
      <div class="chips" id="chips" role="group" aria-label="Show"></div>
    </div>
    <section class="stats" id="stats" aria-label="Totals"></section>
    <section class="map-frame" aria-label="${view === 'peaks' ? 'Map of all summits' : 'Map of all tracks'}">
      <div id="overview-map" class="map map-overview"></div>
    </section>
    <p class="map-legend" id="legend"></p>
    <section id="list"></section>`;

  const map = overviewMap(document.getElementById('overview-map'));
  const list = document.getElementById('list');
  const update = (animate) => {
    const entries = filtered();
    renderStats(entries);
    renderChips(update);
    renderLegend(entries, view);
    list.innerHTML = view === 'peaks' ? peaksHtml(entries) : logbookHtml(entries);
    map.show(entries, animate, view);
  };
  list.addEventListener('click', (ev) => {
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
  if (state.filter === 'all') return state.data.entries;
  if (state.filter === 'adventure') return inCategory('adventure');
  return inCategory('summits').filter((e) => e.type === state.filter);
}

function statTile(label, value, note = '') {
  return `<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span>${note ? `<span class="stat-note" title="${esc(note)}">${esc(note)}</span>` : ''}</div>`;
}

function renderStats(entries) {
  const el = document.getElementById('stats');
  if (state.filter === 'adventure') {
    const sum = (key) => entries.reduce((n, e) => n + e[key], 0);
    const longest = [...entries].sort((a, b) => b.days_total - a.days_total)[0];
    el.innerHTML = [
      statTile(esc(state.data.adventures_title), fmtInt(entries.length)),
      statTile('Days on the road', fmtInt(sum('days_total'))),
      statTile('Distance', `${fmtInt(Math.round(sum('distance') / 1000))} km`),
      statTile('Elevation gain', fmtM(sum('gain'))),
      longest ? statTile('Longest', `${longest.days_total} days`, titleText(longest)) : '',
    ].join('');
    return;
  }
  const peaks = collectPeaks(entries);
  const visits = [...peaks.values()].reduce((n, p) => n + p.visits.length, 0);
  const highest = [...peaks.values()].filter((p) => p.ele).sort((a, b) => b.ele - a.ele)[0];
  const favorite = [...peaks.values()].sort((a, b) => b.visits.length - a.visits.length)[0];
  el.innerHTML = [
    statTile('Tours', fmtInt(entries.length)),
    statTile('Summits', fmtInt(visits)),
    statTile('Different peaks', fmtInt(peaks.size)),
    statTile('Highest summit', highest ? fmtM(highest.ele) : '–', highest?.name),
    statTile('Most visited', favorite ? `${favorite.visits.length}×` : '–', favorite?.name),
    statTile('Elevation gain', fmtM(entries.reduce((n, e) => n + e.gain, 0))),
  ].join('');
}

function renderChips(update) {
  const present = new Set(inCategory('summits').map((e) => e.type));
  const dot = (color) => `<span class="dot" style="--c:${color}"></span>`;
  const chips = [['all', 'All', '']];
  [...state.types.values()].filter((t) => present.has(t.id)).forEach((t) => chips.push([t.id, plural(t.label), dot(colorVar(t.id))]));
  if (inCategory('adventure').length) chips.push(['adventure', state.data.adventures_title, dot('var(--series-3)')]);
  const el = document.getElementById('chips');
  el.innerHTML = chips.map(([id, label, mark]) =>
    `<button class="chip" type="button" data-type="${id}" aria-pressed="${state.filter === id}">${mark}${esc(label)}</button>`).join('');
  el.onclick = (ev) => {
    const btn = ev.target.closest('[data-type]');
    if (!btn) return;
    state.filter = btn.dataset.type;
    update(true);
  };
}

function renderLegend(entries, view) {
  // One item per color: types sharing a color (e.g. hikes and climbs) are listed together.
  const byColor = new Map();
  entries.forEach((e) => {
    const label = e.category === 'adventure' ? state.data.adventures_title : typeOf(e.type).label;
    const color = colorVar(e.type);
    byColor.set(color, new Set([...(byColor.get(color) || []), label]));
  });
  const items = [...byColor].map(([color, labels]) => `<span><span class="dot" style="--c:${color}"></span>${esc([...labels].join(' / '))}</span>`);
  if (view === 'peaks') {
    if (entries.some((e) => !e.summits.length && e.high_point)) {
      items.push('<span><span class="dot hollow" style="--c:var(--ink-2)"></span>No summit (highest point of the tour)</span>');
    }
    items.push('<span>Bigger dot = visited more often</span>');
    document.getElementById('legend').innerHTML = items.join('');
    return;
  }
  // Logbook map: one sample line per family (color and line style), thick = summit book tours.
  const sample = (f) => {
    const color = `var(--series-${f})`;
    const dash = { 2: 'stroke-dasharray="0.1 4" stroke-linecap="round"', 4: 'stroke-dasharray="6 4"' }[f] || '';
    const stripe = f === 3 ? '<line x1="2" y1="6" x2="30" y2="6" stroke="#fffaf0" stroke-width="1"/>' : '';
    return `<svg class="line-sample" viewBox="0 0 32 12" aria-hidden="true"><line x1="2" y1="6" x2="30" y2="6" stroke="${color}" stroke-width="${f === 2 ? 3 : 3}" ${dash}/>${stripe}</svg>`;
  };
  document.getElementById('legend').innerHTML = [1, 2, 3, 4].map((f) => `<span>${sample(f)}${FAMILIES[f]}</span>`).join('')
    + '<span>Thick: summit book tours · thin: all other activities · click a line to open it</span>';
}

function logbookHtml(entries) {
  if (!entries.length) return '<p class="empty">Nothing here yet.</p>';
  const years = new Map();
  entries.forEach((e) => {
    const y = e.date.slice(0, 4);
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(e);
  });
  return [...years].map(([year, list]) => `
    <h2 class="year">${year}<span>${list.length} ${list.length === 1 ? 'tour' : 'tours'}</span></h2>
    <ol class="entries">${list.map(entryCard).join('')}</ol>`).join('');
}

function entryCard(e) {
  const photo = e.photos[0];
  const picture = photo ? photoImg(photo.thumb, photo.focus) : e.preview ? photoImg(e.preview) : mountainIcon();
  return `<li><a class="entry" href="#/tour/${e.id}">
    <figure class="polaroid" style="--tilt:${tilt(e.id)}deg; --c:${colorVar(e.type)}">${picture}</figure>
    <div class="entry-body">
      ${metaLine(e)}
      <h3 class="entry-title">${headline(e)}</h3>
      ${subline(e)}
      ${e.note ? `<p class="entry-note">${esc(noteText(e.note))}</p>` : ''}
      <p class="entry-stats">${statsLine(e)}</p>
    </div></a></li>`;
}

// Your note as plain text (for the short line in the logbook).
function noteText(html) {
  const div = document.createElement('div');
  div.innerHTML = html; // (made safe by summitbook)
  return [...div.querySelectorAll('p, li')].map((n) => n.textContent.trim()).filter(Boolean).join(' · ');
}

// A photo, cropped around its best part (the "focus" found when downloading it).
function photoImg(src, focus, alt = '') {
  const position = focus ? ` style="object-position:${focus[0]}% ${focus[1]}%"` : '';
  return `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer"${position}>`;
}

// A small tilt that stays the same for each tour, like prints stuck into a book.
function tilt(key) {
  let hash = 0;
  for (const c of String(key)) hash = (hash * 31 + c.charCodeAt(0)) % 997;
  return ((hash % 7) - 3) * 0.6;
}

function peaksHtml(entries) {
  const byHeight = (a, b) => (b.ele ?? -1) - (a.ele ?? -1) || a.name.localeCompare(b.name);
  const byVisits = (a, b) => b.visits.length - a.visits.length || byHeight(a, b);
  const peaks = [...collectPeaks(entries).values()].sort(state.peakOrder === 'visits' ? byVisits : byHeight);
  if (!peaks.length) return '<p class="empty">No summits here.</p>';
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

// ---------- Plans: your notes for future tours (from plans.md) ----------

async function renderPlans() {
  document.title = `Plans · ${state.data.title}`;
  app.innerHTML = `<div class="toolbar">${tabsHtml('plans')}</div><section class="plans" id="plans"></section>`;
  let plans = [];
  try {
    plans = await (await fetch('data/plans.json', { cache: 'no-cache' })).json();
  } catch { /* no plans yet */ }
  const el = document.getElementById('plans');
  if (!el) return; // already on another page
  el.innerHTML = plans.length
    ? plans.map((p, i) => `<article class="postit" style="--tilt:${tilt(p.title)}deg; --paper:var(--postit-${(i % 4) + 1})">
        <h2>${esc(p.title)}</h2>${p.html}</article>`).join('') // (p.html is made safe by summitbook)
    : `<div class="empty"><h2>No plans yet</h2><p>Write your ideas for future tours into <code>plans.md</code>,
        then run <code>uv run summitbook publish</code>.</p></div>`;
}

// ---------- Stats: all your activities, per kind and per year, and your records ----------

async function renderStatsPage() {
  document.title = `Stats · ${state.data.title}`;
  app.innerHTML = `<div class="toolbar">${tabsHtml('stats')}</div><section class="statpage" id="statpage"></section>`;
  const all = await loadEverything();
  const el = document.getElementById('statpage');
  if (!el) return; // already on another page
  if (!all.length) {
    el.innerHTML = '<p class="empty">No activities yet.</p>';
    return;
  }
  const families = [1, 2, 3, 4, 0].filter((f) => all.some((a) => family(a.type) === f));
  const totals = (list) => ({
    count: list.length,
    km: list.reduce((n, a) => n + a.distance, 0) / 1000,
    gain: list.reduce((n, a) => n + a.gain, 0),
    hours: list.reduce((n, a) => n + a.moving_time, 0) / 3600,
  });
  const row = (label, t, mark = '') => `<tr><td>${mark}${label}</td><td class="num">${fmtInt(t.count)}</td>
    <td class="num">${fmtInt(Math.round(t.km))} km</td><td class="num">${fmtM(t.gain)}</td><td class="num">${fmtInt(Math.round(t.hours))} h</td></tr>`;
  const legend = families.map((f) => `<span><span class="dot" style="--c:var(--${f ? `series-${f}` : 'other'})"></span>${FAMILIES[f]}</span>`).join('');

  el.innerHTML = `
    <h2 class="section-title">Everything you did</h2>
    <div class="table-wrap"><table class="peaks totals">
      <thead><tr><th scope="col">Kind</th><th scope="col" class="num">Activities</th><th scope="col" class="num">Distance</th>
        <th scope="col" class="num">Elevation gain</th><th scope="col" class="num">Moving time</th></tr></thead>
      <tbody>${families.map((f) => row(FAMILIES[f], totals(all.filter((a) => family(a.type) === f)),
        `<span class="dot" style="--c:var(--${f ? `series-${f}` : 'other'})"></span> `)).join('')}</tbody>
      <tfoot>${row('All together', totals(all))}</tfoot>
    </table></div>
    <h2 class="section-title">Per year</h2>
    <p class="map-legend">${legend}</p>
    <h3 class="chart-title">Elevation gain</h3><div class="chart" id="chart-gain"></div>
    <h3 class="chart-title">Distance</h3><div class="chart" id="chart-km"></div>
    <h2 class="section-title">Records</h2>
    <ul class="records">${records(all)}</ul>`;

  const draw = () => {
    yearBars(document.getElementById('chart-gain'), all, families, (a) => a.gain, fmtM);
    yearBars(document.getElementById('chart-km'), all, families, (a) => a.distance / 1000, (v) => `${fmtInt(Math.round(v))} km`);
  };
  draw();
  const redraw = () => (el.isConnected ? draw() : removeEventListener('resize', redraw));
  addEventListener('resize', redraw);
}

// Stacked bars per year, one segment per kind of activity (in the families' colors).
function yearBars(el, all, families, value, format) {
  const years = [...new Set(all.map((a) => a.date.slice(0, 4)))].sort();
  const data = years.map((year) => {
    const ofYear = all.filter((a) => a.date.startsWith(year));
    return { year, parts: families.map((f) => ({ f, v: ofYear.filter((a) => family(a.type) === f).reduce((n, a) => n + value(a), 0) })) };
  });
  const width = Math.max(el.clientWidth, 280);
  const height = 230;
  const pad = { left: 74, right: 8, top: 12, bottom: 26 };
  const most = Math.max(...data.map((d) => d.parts.reduce((n, p) => n + p.v, 0)), 1);
  const step = niceStep(most / 4);
  const top = Math.ceil(most / step) * step;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const y = (v) => pad.top + plotH - (v / top) * plotH;
  const slot = plotW / years.length;
  const barW = Math.min(52, slot * 0.62);

  const grid = [];
  for (let v = 0; v <= top + 0.001; v += step) {
    grid.push(`<line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="axis" x="${pad.left - 8}" y="${y(v) + 4}" text-anchor="end">${format(v)}</text>`);
  }
  const bars = data.map((d, i) => {
    const x = pad.left + slot * i + (slot - barW) / 2;
    let base = 0;
    const shown = d.parts.filter((p) => p.v > 0);
    const segments = shown.map((p, k) => {
      const [y0, y1] = [y(base), y(base + p.v)];
      base += p.v;
      const h = Math.max(y0 - y1 - 2, 0.5); // a 2px gap between segments
      const color = `var(--${p.f ? `series-${p.f}` : 'other'})`;
      const tip = `${d.year} · ${FAMILIES[p.f]}: ${format(p.v)}`;
      const r = k === shown.length - 1 ? Math.min(4, h / 2, barW / 2) : 0; // rounded at the top end only
      const path = `M${x} ${y0}V${y0 - h + r}${r ? `Q${x} ${y0 - h} ${x + r} ${y0 - h}` : ''}H${x + barW - r}${r ? `Q${x + barW} ${y0 - h} ${x + barW} ${y0 - h + r}` : ''}V${y0}Z`;
      return `<path class="bar" d="${path}" style="fill:${color}" data-tip="${esc(tip)}"/>`;
    }).join('');
    const label = years.length <= 14 || i % 2 === 0 ? `<text class="axis" x="${x + barW / 2}" y="${height - 6}" text-anchor="middle">${d.year}</text>` : '';
    return segments + label;
  }).join('');

  el.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"
      aria-label="${esc(format(most))} in the biggest year; the table above has all totals">${grid.join('')}${bars}</svg>
    <div class="profile-tip" hidden></div>`;
  const tip = el.querySelector('.profile-tip');
  el.querySelectorAll('.bar').forEach((bar) => {
    bar.addEventListener('pointerenter', () => {
      const box = bar.getBBox();
      tip.textContent = bar.dataset.tip;
      tip.style.left = `${Math.min(Math.max(box.x + box.width / 2, 90), width - 90)}px`;
      tip.style.top = `${box.y - 6}px`;
      tip.hidden = false;
    });
    bar.addEventListener('pointerleave', () => { tip.hidden = true; });
  });
}

function records(all) {
  const best = (list, key) => list.reduce((b, a) => (!b || a[key] > b[key] ? a : b), null);
  const link = (a) => (a.entry ? `#/tour/${a.entry}` : a.source === 'file' ? null : `https://www.strava.com/activities/${a.id}`);
  const item = (label, value, a) => {
    if (!a) return '';
    const href = link(a);
    const what = `${esc(a.name)} · ${fmtDate(a.date)}`;
    return `<li><span class="record-value">${value}</span><span class="record-label">${label}</span>
      <span class="record-what">${href ? `<a href="${href}"${href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${what}</a>` : what}</span></li>`;
  };
  const rides = all.filter((a) => family(a.type) === 3);
  const runs = all.filter((a) => family(a.type) === 4);
  const climbs = all.filter((a) => !['AlpineSki', 'Snowboard'].includes(a.type));
  const items = [
    item('Longest ride', fmtKm(best(rides, 'distance')?.distance || 0), best(rides, 'distance')),
    item('Longest run', fmtKm(best(runs, 'distance')?.distance || 0), best(runs, 'distance')),
    // (not counting days on ski lifts: there the climbing isn't yours)
    item('Most elevation in one go', fmtM(best(climbs, 'gain')?.gain || 0), best(climbs, 'gain')),
    item('Longest day out', fmtDuration(best(all, 'moving_time')?.moving_time || 0), best(all, 'moving_time')),
  ];
  // From the summit book: summits and multi-day trips
  const entries = state.data.entries;
  const busiestDay = entries.flatMap((e) => e.days.map((d) => ({ e, d }))).reduce((b, x) => (!b || x.d.summits.length > b.d.summits.length ? x : b), null);
  if (busiestDay?.d.summits.length) {
    items.push(`<li><span class="record-value">${busiestDay.d.summits.length}</span><span class="record-label">Most summits in one day</span>
      <span class="record-what"><a href="#/tour/${busiestDay.e.id}">${esc(busiestDay.d.name)} · ${fmtDate(busiestDay.d.date)}</a></span></li>`);
  }
  const longest = entries.reduce((b, e) => (!b || e.days_total > b.days_total ? e : b), null);
  if (longest?.multi) {
    items.push(`<li><span class="record-value">${longest.days_total} days</span><span class="record-label">Longest trip</span>
      <span class="record-what"><a href="#/tour/${longest.id}">${esc(titleText(longest))} · ${fmtRange(longest.date, longest.end_date)}</a></span></li>`);
  }
  const peaks = [...collectPeaks(entries).values()];
  const highest = peaks.filter((p) => p.ele).sort((a, b) => b.ele - a.ele)[0];
  const favorite = peaks.sort((a, b) => b.visits.length - a.visits.length)[0];
  if (highest) {
    items.push(`<li><span class="record-value">${fmtM(highest.ele)}</span><span class="record-label">Highest summit</span>
      <span class="record-what"><a href="#/tour/${highest.visits.at(-1).entry.id}">${esc(highest.name)} · ${fmtDate(highest.visits.at(-1).date)}</a></span></li>`);
  }
  if (favorite) {
    items.push(`<li><span class="record-value">${favorite.visits.length}×</span><span class="record-label">Most visited</span>
      <span class="record-what"><a href="#/peaks">${esc(favorite.name)}</a></span></li>`);
  }
  const perYear = new Map();
  all.forEach((a) => perYear.set(a.date.slice(0, 4), (perYear.get(a.date.slice(0, 4)) || 0) + 1));
  const [year, count] = [...perYear].sort((a, b) => b[1] - a[1])[0] || [];
  if (year) items.push(`<li><span class="record-value">${count}</span><span class="record-label">Activities in your busiest year</span><span class="record-what">${year}</span></li>`);
  return items.join('');
}

// ---------- Gear: your packing lists (from gear.md), with tick boxes ----------

async function renderGear() {
  document.title = `Gear · ${state.data.title}`;
  app.innerHTML = `<div class="toolbar">${tabsHtml('gear')}<div class="chips" id="gear-chips" role="group" aria-label="Kind of trip"></div></div>
    <section class="gear" id="gear"></section>`;
  let lists = [];
  try {
    lists = await (await fetch('data/gear.json', { cache: 'no-cache' })).json();
  } catch { /* no gear lists yet */ }
  const chips = document.getElementById('gear-chips');
  if (!chips) return; // already on another page
  if (!lists.some((l) => l.title === state.gear)) state.gear = lists[0]?.title;

  const show = () => {
    chips.innerHTML = lists.map((l) =>
      `<button class="chip" type="button" data-list="${esc(l.title)}" aria-pressed="${state.gear === l.title}">${esc(l.title)}</button>`).join('');
    const list = lists.find((l) => l.title === state.gear);
    const el = document.getElementById('gear');
    if (!list?.html) {
      el.innerHTML = `<div class="empty"><h2>Nothing on this list yet</h2>
        <p>Write your ${esc((list?.title || 'gear').toLowerCase())} list into <code>gear.md</code>${list ? `, under <code>## ${esc(list.title)}</code>` : ''},
        then run <code>uv run summitbook publish</code>.</p></div>`;
      return;
    }
    el.innerHTML = `<article class="checklist">${list.html}</article>
      <button class="btn untick" type="button">Untick all</button>`; // (list.html is made safe by summitbook)
    // Tick boxes, remembered in this browser (for packing).
    const key = `gear:${list.title}`;
    const ticked = new Set(remember(key) || []);
    el.querySelectorAll('.checklist li').forEach((li, i) => {
      li.innerHTML = `<label><input type="checkbox" ${ticked.has(i) ? 'checked' : ''}><span>${li.innerHTML}</span></label>`;
      li.querySelector('input').addEventListener('change', (ev) => {
        ev.target.checked ? ticked.add(i) : ticked.delete(i);
        remember(key, [...ticked]);
      });
    });
    el.querySelector('.untick').addEventListener('click', () => {
      remember(key, []);
      show();
    });
  };
  chips.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-list]');
    if (!btn) return;
    state.gear = btn.dataset.list;
    show();
  });
  show();
}

// Small things this browser remembers (gear ticks). Never essential: it may not be allowed.
function remember(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* private window, blocked storage: just don't remember */ }
  return null;
}

// ---------- About me (from about.md) ----------

async function renderAbout() {
  document.title = `About · ${state.data.title}`;
  app.innerHTML = `<div class="toolbar">${tabsHtml('about')}</div><article class="about" id="about"></article>`;
  let html = '';
  try {
    html = await (await fetch('data/about.json', { cache: 'no-cache' })).json();
  } catch { /* nothing written yet */ }
  const el = document.getElementById('about');
  if (!el) return;
  el.innerHTML = html // (made safe by summitbook)
    || `<div class="empty"><h2>Nothing here yet</h2><p>Write about yourself in <code>about.md</code>,
        then run <code>uv run summitbook publish</code>.</p></div>`;
}

// ---------- Elevation profile (tour page) ----------

async function elevationProfile(el, e, tracksPromise, map) {
  const tracks = await tracksPromise;
  if (!el.isConnected) return;
  const points = [];
  let km = 0;
  tracks.forEach((track, n) => {
    let previous = null;
    (track || []).forEach(([lat, lon, ele]) => {
      const here = new maplibregl.LngLat(lon, lat);
      if (previous) km += previous.distanceTo(here) / 1000;
      previous = here;
      if (ele != null) points.push({ km, ele, lat, lon, n });
    });
  });
  if (points.length < 2) {
    el.closest('section').remove(); // no heights recorded
    return;
  }
  const draw = () => drawProfile(el, e, points, map);
  draw();
  const redraw = () => (el.isConnected ? draw() : removeEventListener('resize', redraw));
  addEventListener('resize', redraw);
}

function drawProfile(el, e, points, map) {
  const width = Math.max(el.clientWidth, 280);
  const height = width < 520 ? 170 : 220;
  const pad = { left: 54, right: 12, top: 26, bottom: 26 };
  const total = points.at(-1).km || 1;
  const heights = points.map((p) => p.ele);
  const low = Math.min(...heights);
  const high = Math.max(...heights);
  const step = niceStep((high - low || 100) / 4);
  const bottom = Math.floor(low / step) * step;
  const top = Math.ceil(high / step) * step;
  const x = (km) => pad.left + (km / total) * (width - pad.left - pad.right);
  const y = (ele) => pad.top + (1 - (ele - bottom) / (top - bottom || 1)) * (height - pad.top - pad.bottom);
  const color = (p) => dayColor(e, e.days[p.n].day);

  // One line (and soft area) per day, each in its day's color.
  const days = [];
  points.forEach((p) => (days.at(-1)?.[0].n === p.n ? days.at(-1).push(p) : days.push([p])));
  const shapes = days.map((day) => {
    const line = day.map((p, i) => `${i ? 'L' : 'M'}${x(p.km).toFixed(1)} ${y(p.ele).toFixed(1)}`).join('');
    const area = `${line}L${x(day.at(-1).km).toFixed(1)} ${y(bottom)}L${x(day[0].km).toFixed(1)} ${y(bottom)}Z`;
    return `<path class="area" d="${area}" fill="${color(day[0])}"/><path class="line" d="${line}" stroke="${color(day[0])}"/>`;
  }).join('');
  const dayLabels = e.multi ? days.map((day) => {
    const n = e.days[day[0].n].day;
    const labelled = e.days_total <= DAY_COLORS || n === 1 || n % 5 === 0;
    return labelled ? `<text class="day-label" x="${x(day[0].km) + 3}" y="${pad.top - 9}">Day ${n}</text>` : '';
  }).join('') : '';

  // Summits: a small triangle where the route reached them. Names (if there are only a few)
  // go to the highest first; a name that would overlap one already written is left out.
  const named = [];
  const marks = [...e.summits].sort((a, b) => (b.ele ?? 0) - (a.ele ?? 0)).map((s) => {
    const p = points.reduce((best, q) => ((q.lat - s.lat) ** 2 + (q.lon - s.lon) ** 2 < (best.lat - s.lat) ** 2 + (best.lon - s.lon) ** 2 ? q : best));
    const [px, py] = [x(p.km), y(p.ele)];
    const half = s.name.length * 3.6 + 6;
    const fits = e.summits.length <= 4 && named.every(([nx, nh]) => Math.abs(px - nx) > half + nh);
    if (fits) named.push([px, half]);
    const label = fits ? `<text class="summit-name" x="${px}" y="${py - 12}" text-anchor="middle">${esc(s.name)}</text>` : '';
    return `<path class="summit" d="M${px - 5} ${py - 2}L${px} ${py - 9}L${px + 5} ${py - 2}Z"><title>${esc(s.name)}</title></path>${label}`;
  }).join('');

  const ticks = [];
  for (let ele = bottom; ele <= top + 0.1; ele += step) {
    ticks.push(`<line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${y(ele)}" y2="${y(ele)}"/>
      <text class="axis" x="${pad.left - 8}" y="${y(ele) + 4}" text-anchor="end">${fmtM(ele)}</text>`);
  }
  const kmStep = niceStep(total / (width < 520 ? 4 : 7));
  for (let k = 0; k <= total + 0.001; k += kmStep) {
    ticks.push(`<text class="axis" x="${x(k)}" y="${height - 6}" text-anchor="middle">${fmtInt(+k.toFixed(1))} km</text>`);
  }

  el.innerHTML = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"
      aria-label="Elevation profile: from ${fmtM(low)} to ${fmtM(high)} over ${fmtKm(total * 1000)}">
      ${ticks.join('')}${shapes}${dayLabels}${marks}
      <line class="cross" y1="${pad.top}" y2="${y(bottom)}" visibility="hidden"/>
      <circle class="dot" r="5" visibility="hidden"/>
      <rect class="hit" x="${pad.left}" y="0" width="${width - pad.left - pad.right}" height="${height}"/>
    </svg><div class="profile-tip" hidden></div>`;

  // Pointing along the profile: the height there, and the same spot on the 3D map.
  const svg = el.querySelector('svg');
  const [cross, dot, tip] = [svg.querySelector('.cross'), svg.querySelector('.dot'), el.querySelector('.profile-tip')];
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
    map?.hidePoint();
  };
  svg.querySelector('.hit').addEventListener('pointermove', (ev) => {
    const km = ((ev.offsetX - pad.left) / (width - pad.left - pad.right)) * total;
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      points[mid].km < km ? (lo = mid + 1) : (hi = mid);
    }
    const p = points[lo];
    const [px, py] = [x(p.km), y(p.ele)];
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', px);
    dot.setAttribute('cy', py);
    dot.setAttribute('fill', color(p));
    dot.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.textContent = `${fmtM(p.ele)} · ${fmtKm(p.km * 1000)}${e.multi ? ` · day ${e.days[p.n].day}` : ''}`;
    tip.style.left = `${Math.min(Math.max(px, 70), width - 70)}px`;
    tip.style.top = `${py - 14}px`;
    map?.showPoint([p.lon, p.lat]);
  });
  svg.querySelector('.hit').addEventListener('pointerleave', hide);
}

// A round step for axis ticks: 1, 2, 2.5 or 5 times a power of ten.
function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw);
}

// ---------- Tour page: 3D map, days, summits, photos ----------

function renderTour(id) {
  const found = state.data.entries.find((e) => String(e.id) === id);
  if (!found) {
    app.innerHTML = '<a class="back" href="#/">← Back to the logbook</a><p class="empty">This tour isn\'t in the summit book.</p>';
    return;
  }
  const e = found;
  const list = state.data.entries;
  const i = list.indexOf(e);
  const newer = list[i - 1];
  const older = list[i + 1];
  const hasMap = e.days.some((d) => d.track);
  document.title = `${titleText(e)} · ${state.data.title}`;
  const tile = (label, value) =>
    `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></div>`;

  app.innerHTML = `
    <a class="back" href="#/">← Back to the logbook</a>
    <header class="tour-head">
      ${metaLine(e)}
      <h1>${headline(e)}</h1>
      ${subline(e)}
      ${e.multi ? '' : stravaLink(e.days[0])}
    </header>
    ${e.note ? `<section class="journal" aria-label="Your notes">${e.note}</section>` : ''}
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
            <button type="button" data-base="paint" aria-pressed="false">Painted</button>
          </div>
          <button class="btn" type="button" id="spin" aria-pressed="false">Fly around</button>
        </div>
      </section>
      <section class="profile-wrap" aria-label="Elevation profile">
        <h2 class="section-title">Elevation profile</h2>
        <div id="profile" class="profile"></div>
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
        <button class="photo polaroid" type="button" data-photo="${n}" style="--tilt:${tilt(p.thumb)}deg"
          aria-label="Open photo ${n + 1}${p.caption ? `: ${esc(p.caption)}` : ''}">${photoImg(p.thumb, p.focus, p.caption)}</button>`).join('')}
      </div>` : ''}
    <nav class="pager" aria-label="More tours">
      ${older ? `<a class="older" href="#/tour/${older.id}"><small>← Older</small>${esc(titleText(older))}</a>` : ''}
      ${newer ? `<a class="newer" href="#/tour/${newer.id}"><small>Newer →</small>${esc(titleText(newer))}</a>` : ''}
    </nav>`;

  app.querySelectorAll('[data-photo]').forEach((btn) =>
    btn.addEventListener('click', () => openLightbox(e.photos, Number(btn.dataset.photo))));
  if (hasMap) {
    const tracks = loadTracks(e);
    const map = tourMap(document.getElementById('tour-map'), e, { tracks });
    elevationProfile(document.getElementById('profile'), e, tracks, map);
  }
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

function tourMap(container, e, { preview = false, tracks = loadTracks(e) } = {}) {
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
  const selectDay = (n) => {
    if (dayBounds[n]) fit(dayBounds[n]);
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
      if (e.multi && !preview) {
        map.addLayer({ id: `day-${n}-hit`, type: 'line', source: `day-${n}`, paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16 } });
        map.on('click', `day-${n}-hit`, () => selectDay(n));
        map.on('mouseenter', `day-${n}-hit`, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', `day-${n}-hit`, () => { map.getCanvas().style.cursor = ''; });
      }
      const b = coords.reduce((acc, c) => acc.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      dayBounds[n] = b;
      total = total ? total.extend(b) : new maplibregl.LngLatBounds(b.getSouthWest(), b.getNorthEast());
      if (e.multi) {
        // Label each day a quarter of the way along its route, so days from the same hut don't overlap.
        // Long trips only get every 5th day labelled, plus the first and last.
        const labelled = e.days_total <= DAY_COLORS || day === 1 || day % 5 === 0 || day === e.days_total;
        if (labelled && !badged.has(day)) dayBadge(coords[Math.floor(coords.length / 4)], day, color, () => selectDay(n));
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
      container.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      selectDay(Number(btn.dataset.day));
    }));
  app.querySelectorAll('[data-base]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const base = btn.dataset.base;
      ['satellite', 'topo', 'paint'].forEach((b) => map.setLayoutProperty(b, 'visibility', b === base ? 'visible' : 'none'));
      app.querySelectorAll('[data-base]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    }));
  paintedOrGray(map, ['paint'], ['satellite'], () => {
    app.querySelector('[data-base="paint"]')?.remove();
    app.querySelector('[data-base="satellite"]')?.setAttribute('aria-pressed', 'true');
  });

  // A point on the map that follows your finger/mouse on the elevation profile.
  const pointEl = document.createElement('div');
  pointEl.className = 'profile-point';
  const point = new maplibregl.Marker({ element: pointEl });
  const api = {
    showPoint(lngLat) { point.setLngLat(lngLat).addTo(map); },
    hidePoint() { point.remove(); },
  };
  if (preview) return api;

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
  return api;
}

function loadTracks(e) {
  return Promise.all(e.days.map((d) =>
    d.track ? fetch(`data/tracks/${d.id}.json`).then((r) => r.json()).catch(() => null) : null));
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
  state.routes ??= fetch('data/routes.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => ({}));

  let ready = false;
  let pending = null;
  let places = new Map();
  let tracks = [];
  let others = [];
  let hovered = null;
  // Clicking a peak or a track opens a post-it note.
  const popup = new maplibregl.Popup({ offset: 12, maxWidth: '260px', className: 'postit' });
  paintedOrGray(map, ['paint', 'paint-labels'], ['base', 'labels']);

  const fitTo = (points, animate, everything = false) => {
    // Start on the area with most of the tours; far-away ones (other continents) are a zoom-out away.
    const home = everything ? points : homeRegion(points);
    if (!home.length) return;
    const bounds = home.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(home[0], home[0]));
    map.fitBounds(bounds, { padding: 50, maxZoom: 12, duration: animate && !reduceMotion ? 1200 : 0 });
  };

  const showPeaks = (entries, animate) => {
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
    fitTo(features.map((f) => f.geometry.coordinates), animate);
  };

  const showTracks = async (entries, animate) => {
    const [lines, everything] = await Promise.all([state.routes, loadEverything()]);
    tracks = entries.filter((e) => lines[e.id]?.length);
    const features = tracks.map((e, i) => ({
      type: 'Feature', id: i,
      properties: { i, color: cssVar(colorVar(e.type, true)), family: family(e.type) },
      geometry: { type: 'MultiLineString', coordinates: lines[e.id] },
    }));
    map.getSource('tracks').setData({ type: 'FeatureCollection', features });
    // Everything else you did (runs, rides, hikes without a summit, …), in the families the chip shows.
    const families = state.filter === 'all' ? null
      : new Set(state.filter === 'adventure' ? [3] : [family(state.filter)]);
    others = everything.filter((a) => !a.entry && a.line.length > 1 && (!families || families.has(family(a.type))));
    map.getSource('others').setData({
      type: 'FeatureCollection',
      features: others.map((a, i) => ({
        type: 'Feature', properties: { i, color: cssVar(colorVar(a.type, true)), family: family(a.type) },
        geometry: { type: 'LineString', coordinates: a.line },
      })),
    });
    // Bike adventures: the whole routes. Otherwise: where most tours start (one point per tour).
    const bikes = state.filter === 'adventure';
    fitTo(bikes ? features.flatMap((f) => f.geometry.coordinates.flat()) : features.map((f) => f.geometry.coordinates[0][0]), animate, bikes);
  };

  const show = (entries, animate, mode) => {
    if (!ready) {
      pending = [entries, animate, mode];
      return;
    }
    popup.remove();
    const peaks = mode === 'peaks';
    map.setLayoutProperty('places', 'visibility', peaks ? 'visible' : 'none');
    ['others', 'others-run', 'others-hike', 'others-hit', 'tracks-casing', 'tracks', 'tracks-run', 'tracks-stripe', 'tracks-hit']
      .forEach((id) => map.setLayoutProperty(id, 'visibility', peaks ? 'none' : 'visible'));
    peaks ? showPeaks(entries, animate) : showTracks(entries, animate);
  };

  const openPeak = (key) => {
    const p = places.get(key);
    if (!p) return;
    const visits = p.visits.map(({ entry, date }) =>
      `<li><a href="#/tour/${entry.id}">${fmtDate(date)}</a> · ${entry.multi ? esc(entry.title) : esc(typeOf(entry.type).label)}</li>`).join('');
    popup.setLngLat([p.lon, p.lat])
      .setHTML(`<strong>${esc(p.title)}</strong>${p.ele ? ` <span class="ele">${fmtM(p.ele)}</span>` : ''}
        ${p.summit ? `<p>${p.visits.length === 1 ? 'Once' : `${p.visits.length} times`} up here</p>` : '<p>Highest point, no summit</p>'}<ul>${visits}</ul>`)
      .addTo(map);
  };

  const openTrack = (i, lngLat) => {
    const e = tracks[i];
    popup.setLngLat(lngLat)
      .setHTML(`<strong>${esc(titleText(e))}</strong><p>${fmtRange(e.date, e.end_date)} · ${esc(e.category === 'adventure' ? state.data.adventures_title : typeOf(e.type).label)}</p>
        <p>${statsLine(e)}</p><ul><li><a href="#/tour/${e.id}">Open the tour →</a></li></ul>`)
      .addTo(map);
  };

  const openOther = (i, lngLat) => {
    const a = others[i];
    const link = a.source === 'file' ? '<p>Imported from a GPX/FIT file</p>'
      : `<ul><li><a href="https://www.strava.com/activities/${a.id}" target="_blank" rel="noopener">View on Strava →</a></li></ul>`;
    popup.setLngLat(lngLat)
      .setHTML(`<strong>${esc(a.name)}</strong><p>${fmtDate(a.date)} · ${esc(typeOf(a.type).label)}</p><p>${statsLine(a)}</p>${link}`)
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
    const round = { 'line-join': 'round', 'line-cap': 'round' };
    const hover = (a, b) => ['case', ['boolean', ['feature-state', 'hover'], false], a, b];
    const is = (f) => ['==', ['get', 'family'], f];
    const isnt = (...fs) => ['all', ...fs.map((f) => ['!=', ['get', 'family'], f])];
    // Thin lines: all your other activities. Hikes dotted like footpaths, runs dashed.
    map.addSource('others', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const thin = { 'line-color': ['get', 'color'], 'line-width': 1.6, 'line-opacity': 0.8 };
    map.addLayer({ id: 'others', type: 'line', source: 'others', filter: isnt(2, 4), layout: round, paint: thin });
    map.addLayer({ id: 'others-run', type: 'line', source: 'others', filter: is(4), paint: { ...thin, 'line-dasharray': [3, 2] } });
    map.addLayer({ id: 'others-hike', type: 'line', source: 'others', filter: is(2), layout: round, paint: { ...thin, 'line-width': 2, 'line-dasharray': [0.1, 2] } });
    map.addLayer({ id: 'others-hit', type: 'line', source: 'others', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 10 } });
    // Thick lines: the summit book's tours. Trail runs dashed, bike trips with a stripe like a road.
    map.addSource('tracks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'tracks-casing', type: 'line', source: 'tracks', layout: round, paint: { 'line-color': '#fffaf0', 'line-width': hover(7, 5), 'line-opacity': 0.9 } });
    map.addLayer({ id: 'tracks', type: 'line', source: 'tracks', filter: isnt(4), layout: round, paint: { 'line-color': ['get', 'color'], 'line-width': hover(4.5, 3) } });
    map.addLayer({ id: 'tracks-run', type: 'line', source: 'tracks', filter: is(4), paint: { 'line-color': ['get', 'color'], 'line-width': hover(4.5, 3), 'line-dasharray': [2.2, 1.4] } });
    map.addLayer({ id: 'tracks-stripe', type: 'line', source: 'tracks', filter: is(3), layout: round, paint: { 'line-color': '#fffaf0', 'line-width': hover(1.4, 1) } });
    map.addLayer({ id: 'tracks-hit', type: 'line', source: 'tracks', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 14 } });

    map.on('click', 'places', (ev) => openPeak(ev.features[0].properties.key));
    map.on('click', 'tracks-hit', (ev) => openTrack(ev.features[0].properties.i, ev.lngLat));
    map.on('click', 'others-hit', (ev) => {
      if (map.queryRenderedFeatures(ev.point, { layers: ['tracks-hit'] }).length) return; // a tour is on top
      openOther(ev.features[0].properties.i, ev.lngLat);
    });
    map.on('mouseenter', 'others-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'others-hit', () => { map.getCanvas().style.cursor = ''; });
    const setHover = (id) => {
      if (hovered !== null) map.setFeatureState({ source: 'tracks', id: hovered }, { hover: false });
      hovered = id;
      if (id !== null) map.setFeatureState({ source: 'tracks', id }, { hover: true });
    };
    map.on('mousemove', 'tracks-hit', (ev) => { setHover(ev.features[0].id); map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'tracks-hit', () => { setHover(null); map.getCanvas().style.cursor = ''; });
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
      openPeak(`p${id}`);
    },
  };
}

// Overview: a hand-painted watercolor map with shaded mountains (or, if that isn't available,
// a quiet gray one), toned down a little so the colored tracks and dots stand out.
function overviewStyle() {
  return {
    version: 8,
    sources: {
      paint: { type: 'raster', tiles: STADIA('stamen_watercolor', 'jpg'), tileSize: 256, maxzoom: 16, attribution: STADIA_CREDIT },
      'paint-labels': { type: 'raster', tiles: STADIA('stamen_terrain_labels', 'png'), tileSize: 256, maxzoom: 18 },
      base: { type: 'raster', tiles: GRAY_TILES('World_Light_Gray_Base'), tileSize: 256, maxzoom: 16 },
      labels: {
        type: 'raster', tiles: GRAY_TILES('World_Light_Gray_Reference'), tileSize: 256, maxzoom: 16,
        attribution: 'Basemap © Esri, HERE, Garmin, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
      relief: { type: 'raster-dem', url: TERRAIN_TILEJSON, tileSize: 512, encoding: 'terrarium' },
    },
    layers: [
      { id: 'paint', type: 'raster', source: 'paint', paint: { 'raster-saturation': -0.25, 'raster-contrast': -0.05 } },
      { id: 'base', type: 'raster', source: 'base', layout: { visibility: 'none' } },
      {
        id: 'relief', type: 'hillshade', source: 'relief',
        paint: {
          'hillshade-exaggeration': 0.35,
          'hillshade-shadow-color': '#5b5546',
          'hillshade-highlight-color': '#ffffff',
          'hillshade-accent-color': '#5b5546',
        },
      },
      { id: 'paint-labels', type: 'raster', source: 'paint-labels', paint: { 'raster-opacity': 0.85 } },
      { id: 'labels', type: 'raster', source: 'labels', layout: { visibility: 'none' } },
    ],
  };
}

// If the painted tiles aren't allowed (the address isn't registered at Stadia yet), switch the
// map to the gray layers once. onFallback: e.g. hide the "Painted" button.
function paintedOrGray(map, painted, gray, onFallback = () => {}) {
  let done = false;
  map.on('error', (ev) => {
    if (done || !painted.includes(ev.sourceId)) return;
    done = true;
    painted.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', 'none'));
    gray.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', 'visible'));
    onFallback();
  });
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
      paint: { type: 'raster', tiles: STADIA('stamen_watercolor', 'jpg'), tileSize: 256, maxzoom: 16, attribution: STADIA_CREDIT },
    },
    layers: ['topo', 'satellite', 'paint'].map((id) => ({
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

// Every peak with its visits: { entry, date }. Within a trip, reaching a summit on back-to-back
// days (you slept up there, e.g. at a hut) is one visit; a later day with a gap is another.
function collectPeaks(entries) {
  const peaks = new Map();
  entries.forEach((e) => {
    const days = new Map(); // summit id -> day numbers it was reached on
    e.days.forEach((d) => d.summits.forEach((s) => {
      if (!peaks.has(s.id)) peaks.set(s.id, { ...s, visits: [] });
      days.set(s.id, [...(days.get(s.id) || []), d]);
    }));
    days.forEach((reached, id) => {
      reached.sort((a, b) => b.day - a.day); // newest first, like the entries
      const visits = reached.filter((d, i) => i === reached.length - 1 || reached[i + 1].day < d.day - 1);
      visits.forEach((d) => peaks.get(id).visits.push({ entry: e, date: d.date }));
    });
  });
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

// Which family an activity belongs to (and its color): 1 skiing, 2 hiking, 3 cycling, 4 running, 0 other.
function family(type) {
  const slot = typeOf(type).slot;
  return slot >= 1 && slot <= 4 ? slot : 0;
}

const FAMILIES = { 1: 'Skiing', 2: 'Hiking & climbing', 3: 'Cycling', 4: 'Running', 0: 'Other' };

// All your activities (runs, rides, …: for the map and the stats), loaded once.
function loadEverything() {
  state.everything ??= fetch('data/everything.json', { cache: 'no-cache' }).then((r) => r.json()).catch(() => []);
  return state.everything;
}

function typeOf(id) {
  return state.types.get(id) || { id, label: id, slot: 0 };
}

// Colors: by activity type, or by day on multi-day trips. bare=true gives the CSS variable
// name (for reading the actual color), otherwise var(--…) for use in styles.
function colorVar(type, bare = false) {
  const slot = typeOf(type).slot;
  const name = slot >= 1 && slot <= 4 ? `--series-${slot}` : '--other';
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
