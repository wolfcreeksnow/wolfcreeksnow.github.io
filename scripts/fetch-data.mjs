// Pulls Wolf Creek snow data from public sources and writes data.json.
// Runs in GitHub Actions (Node 20+, built-in fetch). Each source is independent:
// if one fails, the last good copy from the previous data.json is kept.
import { readFile, writeFile } from 'node:fs/promises';

const OUT = new URL('../data.json', import.meta.url);
const UA = 'WolfCreekSnowApp (github.com; unofficial hobby dashboard)';
const SNOTEL = '874:CO:SNTL';                 // Wolf Creek Summit, 10,930 ft
const SKI_POINT = { lat: 37.4722, lon: -106.7931 }; // Wolf Creek Ski Area
const AWDB = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data';
const TZ = 'America/Denver';

async function get(url, type = 'json', tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: type === 'json' ? 'application/geo+json, application/json' : 'text/html' } });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
      return type === 'json' ? await r.json() : await r.text();
    } catch (e) { last = e; await new Promise(res => setTimeout(res, 1500 * (i + 1))); }
  }
  throw last;
}

const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const num = s => { if (s == null) return null; const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : (/trace/i.test(s) ? 0 : null); };
const round = (v, p = 1) => v == null || isNaN(v) ? null : Math.round(v * 10 ** p) / 10 ** p;

// Water year starts Oct 1. Returns { wy, start: Date(UTC midnight Oct 1) }
function waterYear(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const wy = m >= 10 ? y + 1 : y;
  return { wy, start: Date.UTC(wy - 1, 9, 1) };
}
const wyDay = dateStr => { const { start } = waterYear(dateStr); return Math.round((Date.parse(dateStr + 'T00:00:00Z') - start) / 864e5); };

// ---------- 1. Official Wolf Creek snow report (scraped) ----------
export function parseReport(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|span|td|th|dt|dd|strong|b|label)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#8221;|&#8243;|&rdquo;|&quot;|&#34;|″|”/g, '"').replace(/&#176;|&deg;/g, '°')
    .replace(/&#8217;|&rsquo;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#\d+;/g, ' ');
  const lines = text.split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const idx = re => lines.findIndex(l => re.test(l));
  const after = (re, n = 1) => { const i = idx(re); return i < 0 ? null : lines[i + n] ?? null; };
  const inline = re => { const i = idx(re); if (i < 0) return null; const v = lines[i].replace(re, '').replace(/^[:\s-]+/, '').trim(); return v || lines[i + 1] || null; };

  // "Snowfall in the last..." block: 24 hours / 48 hours / 72 hours / 7 days
  const start = idx(/Snowfall in the last/i);
  const block = start >= 0 ? lines.slice(start, start + 14) : lines;
  const inBlock = re => { const i = block.findIndex(l => re.test(l)); return i < 0 ? null : num(block[i + 1]); };

  const r = {
    updated: inline(/^Updated:?/i),
    patroller: inline(/^Ski Patroller:?/i),
    summit: num(after(/^Summit Snow Depth/i)),
    midway: num(after(/^Midway Snow Depth/i)),
    latestStorm: num(after(/^Latest Storm/i)),
    ytd: num(after(/^Snowfall YTD/i)),
    h24: inBlock(/^24 hours?$/i), h48: inBlock(/^48 hours?$/i), h72: inBlock(/^72 hours?$/i), d7: inBlock(/^7 days?$/i),
    skies: after(/^Current Skies$/i),
    temp: num(after(/^Temperature$/i)),
    high: num(after(/^Yesterday'?s High/i)),
    low: num(after(/^Last Night'?s Low/i)),
    forecast: after(/^Forecast$/i),
    road: after(/^Road Conditions$/i),
    surface: after(/^Surface Conditions$/i),
    pctOpen: num(after(/^Percentage Open$/i)),
    acres: num(after(/^Skiable Acres$/i) ?? after(/^Skiiable Acres$/i)),
    lifts: num(after(/^Number of Lifts$/i) ?? after(/^Lifts Open$/i)),
    terrain: num(after(/^Terrain Open$/i)),
    pick: after(/^Pick of the Hill$/i),
    hikeTo: ['Waterfall Area', 'Alberta Peak Area', 'Knife Ridge', 'Horseshoe Bowl Area']
      .map(name => ({ name, status: after(new RegExp('^' + name.replace('Waterfall', 'Wate?r ?fall').replace('Horseshoe', 'Hor(se)?shoe') + '$', 'i')) }))
      .filter(a => a.status && a.status.length < 20),
  };
  if (r.summit == null && r.h24 == null && r.ytd == null) throw new Error('Snow report layout not recognised');
  return r;
}

async function fetchReport() {
  const html = await get('https://wolfcreekski.com/wcs-snow-report/', 'text');
  return { ...parseReport(html), url: 'https://wolfcreekski.com/wcs-snow-report/' };
}

// ---------- 2. SNOTEL 874 Wolf Creek Summit ----------
function seriesFromAwdb(json, code) {
  const st = (Array.isArray(json) ? json : [json]).find(s => s?.data);
  const el = st?.data?.find(d => d.stationElement?.elementCode === code);
  return el?.values ?? [];
}

async function fetchSnotel() {
  const today = ymd(new Date());
  const { wy } = waterYear(today);
  const begin5 = `${wy - 6}-10-01`;
  const q = (p) => AWDB + '?' + new URLSearchParams({ stationTriplets: SNOTEL, ...p });

  const daily = await get(q({ elements: 'WTEQ,SNWD,TOBS,TMAX,TMIN', duration: 'DAILY', beginDate: begin5, endDate: today, centralTendencyType: 'MEDIAN', periodRef: 'END' }));
  const SIZE = 366;
  const blank = () => Array(SIZE).fill(null);
  const cur = { swe: blank(), depth: blank(), sweMedian: blank(), depthMedian: blank() };
  const last = { swe: blank(), depth: blank() };
  const hist = { swe: Array.from({ length: SIZE }, () => []), depth: Array.from({ length: SIZE }, () => []) };

  const put = (code, key) => {
    for (const v of seriesFromAwdb(daily, code)) {
      const d = String(v.date).slice(0, 10); const i = wyDay(d); const y = waterYear(d).wy;
      if (i < 0 || i >= SIZE) continue;
      if (y === wy) cur[key][i] = v.value ?? null;
      // normals repeat every year; take them from any season so the curve runs to summer
      if (v.median != null && (y === wy || cur[key + 'Median'][i] == null)) cur[key + 'Median'][i] = v.median;
      if (y === wy - 1) last[key][i] = v.value ?? null;
      if (y >= wy - 5 && y <= wy - 1 && v.value != null) hist[key][i].push(v.value);
    }
  };
  put('WTEQ', 'swe'); put('SNWD', 'depth');
  const avg = a => a.length >= 3 ? round(a.reduce((s, x) => s + x, 0) / a.length, 1) : null;
  const avg5 = { swe: hist.swe.map(avg), depth: hist.depth.map(avg) };

  // latest daily values
  let li = -1; for (let i = SIZE - 1; i >= 0; i--) if (cur.depth[i] != null || cur.swe[i] != null) { li = i; break; }
  const temps = Object.fromEntries(['TOBS', 'TMAX', 'TMIN'].map(c => { const s = seriesFromAwdb(daily, c); return [c, s.at(-1)?.value ?? null]; }));

  // hourly depth for the last 4 days -> sensor new-snow estimate
  const hourly = await get(q({ elements: 'SNWD,WTEQ,TOBS', duration: 'HOURLY', beginDate: ymd(new Date(Date.now() - 4 * 864e5)) + ' 00:00', endDate: today + ' 23:59' }));
  const hd = seriesFromAwdb(hourly, 'SNWD').filter(v => v.value != null).map(v => ({ t: v.date, depth: v.value }));
  const hs = seriesFromAwdb(hourly, 'WTEQ').filter(v => v.value != null).map(v => ({ t: v.date, swe: v.value }));
  const ht = seriesFromAwdb(hourly, 'TOBS').filter(v => v.value != null);
  const change = (arr, key, hours) => {
    if (!arr.length) return null;
    const lastT = Date.parse(arr.at(-1).t.replace(' ', 'T'));
    const win = arr.filter(x => Date.parse(x.t.replace(' ', 'T')) >= lastT - hours * 36e5);
    const lo = Math.min(...win.map(x => x[key]));
    return round(Math.max(0, arr.at(-1)[key] - lo), 1);
  };

  return {
    station: 'Wolf Creek Summit (SNOTEL 874)', elevation: 10930, wy,
    latest: {
      date: li >= 0 ? new Date(Date.UTC(wy - 1, 9, 1) + li * 864e5).toISOString().slice(0, 10) : null,
      swe: cur.swe[li] ?? null, depth: cur.depth[li] ?? null,
      sweMedian: cur.sweMedian[li] ?? null, depthMedian: cur.depthMedian[li] ?? null,
      sweAvg5: avg5.swe[li] ?? null, sweLast: last.swe[li] ?? null,
      pctMedian: cur.sweMedian[li] ? Math.round(100 * cur.swe[li] / cur.sweMedian[li]) : null,
      tempObs: temps.TOBS, tempMax: temps.TMAX, tempMin: temps.TMIN,
    },
    sensor: {
      asOf: hd.at(-1)?.t ?? null, depthNow: hd.at(-1)?.depth ?? null,
      depthGain24: change(hd, 'depth', 24), depthGain72: change(hd, 'depth', 72),
      sweGain24: change(hs, 'swe', 24), tempNow: ht.at(-1)?.value ?? null,
      hourly: hd.slice(-96),
    },
    season: { current: cur, last, avg5 },
  };
}

// ---------- 3. NWS forecast for the ski area ----------
async function fetchForecast() {
  const pt = await get(`https://api.weather.gov/points/${SKI_POINT.lat},${SKI_POINT.lon}`);
  const [fc, grid] = await Promise.all([get(pt.properties.forecast), get(pt.properties.forecastGridData)]);
  const periods = fc.properties.periods.map(p => ({
    name: p.name, start: p.startTime, isDay: p.isDaytime, temp: p.temperature, unit: p.temperatureUnit,
    wind: `${p.windDirection} ${p.windSpeed}`.trim(), short: p.shortForecast, detail: p.detailedForecast,
    pop: p.probabilityOfPrecipitation?.value ?? null,
  }));
  // snowfallAmount: [{validTime: "2026-11-18T12:00:00+00:00/PT6H", value: mm}]
  const toIn = mm => mm / 25.4;
  const days = {};
  for (const v of grid.properties.snowfallAmount?.values ?? []) {
    const [startIso, dur] = v.validTime.split('/');
    const hrs = (dur.match(/(\d+)H/)?.[1] ?? 0) * 1 + (dur.match(/(\d+)D/)?.[1] ?? 0) * 24 || 1;
    // spread evenly over the hours so totals land on the right local day
    const per = toIn(v.value ?? 0) / hrs;
    for (let h = 0; h < hrs; h++) { const d = ymd(new Date(Date.parse(startIso) + h * 36e5)); days[d] = (days[d] ?? 0) + per; }
  }
  const today = ymd(new Date());
  const daily = Object.keys(days).sort().filter(d => d >= today).slice(0, 7).map(d => ({ date: d, snow: round(days[d], 1) }));
  return {
    office: `${pt.properties.gridId} ${pt.properties.gridX},${pt.properties.gridY}`,
    gridElevationFt: grid.properties.elevation?.value ? Math.round(grid.properties.elevation.value * 3.28084) : null,
    updated: fc.properties.updateTime ?? fc.properties.updated, periods, daily,
    total7: round(daily.reduce((s, d) => s + (d.snow ?? 0), 0), 1),
    link: `https://forecast.weather.gov/MapClick.php?lat=${SKI_POINT.lat}&lon=${SKI_POINT.lon}`,
  };
}

// ---------- 4. CAIC avalanche danger (via avalanche.org) ----------
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inGeom = (pt, g) => g?.type === 'Polygon' ? inRing(pt, g.coordinates[0])
  : g?.type === 'MultiPolygon' ? g.coordinates.some(p => inRing(pt, p[0])) : false;

async function fetchAvalanche() {
  const fc = await get('https://api.avalanche.org/v2/public/products/map-layer/CAIC');
  const pt = [SKI_POINT.lon, SKI_POINT.lat];
  const f = fc.features?.find(x => inGeom(pt, x.geometry))
    ?? fc.features?.find(x => /san juan/i.test(x.properties?.name ?? ''));
  if (!f) throw new Error('No CAIC zone found for Wolf Creek');
  const p = f.properties;
  return {
    zone: p.name, level: p.danger_level ?? null, danger: p.danger ?? null, advice: p.travel_advice ?? null,
    start: p.start_date ?? null, end: p.end_date ?? null, offSeason: !!p.off_season,
    link: p.link || 'https://avalanche.state.co.us/',
  };
}

// ---------- run ----------
import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

export async function main() {
let prev = {};
try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
const out = { generated: new Date().toISOString(), errors: {} };
const jobs = { report: fetchReport, snotel: fetchSnotel, forecast: fetchForecast, avalanche: fetchAvalanche };
await Promise.all(Object.entries(jobs).map(async ([k, fn]) => {
  try { out[k] = await fn(); out[k].fetched = out.generated; }
  catch (e) { console.error(`[${k}]`, e.message); out.errors[k] = e.message; out[k] = prev[k] ? { ...prev[k], stale: true } : null; }
}));
await writeFile(OUT, JSON.stringify(out));
console.log('wrote data.json', Object.keys(jobs).map(k => `${k}:${out.errors[k] ? 'FAIL' : 'ok'}`).join(' '));
}
