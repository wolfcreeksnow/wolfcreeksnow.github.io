// Weekly check-up for the Wolf Creek Snow Update app.
// Looks at the live site, the snow data, each data source and how often the updater ran,
// then sends a short report to the owner's phone (ntfy topic in the NTFY_TOPIC secret).
const SITE = process.env.SITE_URL || 'https://wolfcreeksnow.github.io/';
const REPO = process.env.GITHUB_REPOSITORY;
const GH = process.env.GITHUB_TOKEN;
const HOUR = 36e5;

const problems = [], notes = [];

async function get(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) });
  return r;
}

// 1. Site loads and is the real app (not an error page)
try {
  const r = await get(SITE + '?healthcheck=' + Date.now());
  const html = await r.text();
  if (!r.ok) problems.push(`Site returned error ${r.status}`);
  else if (!html.includes('WOLF CREEK SNOW UPDATE')) problems.push('Site loaded but the app page looks wrong');
  else notes.push('Site loads');
} catch (e) { problems.push('Site unreachable: ' + e.message); }

// 2. Backup file is there
try { const r = await get(SITE + 'sw.js'); if (!r.ok) problems.push(`Backup file missing (${r.status})`); } catch (e) { problems.push('Backup file unreachable'); }

// 3. Snow data is fresh and every source is working
let d = null;
try {
  const r = await get(SITE + 'data.json?t=' + Date.now());
  d = await r.json();
} catch (e) { problems.push('Snow data could not be read: ' + e.message); }
if (d) {
  const age = (Date.now() - Date.parse(d.generated)) / HOUR;
  if (!(age < 3)) problems.push(`Snow data is ${Math.round(age)} hours old`);
  else notes.push(`Data ${Math.round(age * 60)} min old`);
  const names = { report: 'Ski patrol report', snotel: 'SNOTEL snowpack', forecast: 'NWS forecast', avalanche: 'Avalanche forecast', road: 'CDOT road status' };
  for (const [k, label] of Object.entries(names)) {
    if (d.errors?.[k]) problems.push(`${label} failing: ${String(d.errors[k]).slice(0, 80)}`);
    else if (!d[k]) problems.push(`${label} missing`);
  }
  if (d.report?.updated) {
    const t = Date.parse(d.report.updated.replace(' - ', ' ') + ' GMT-0700');
    const days = (Date.now() - t) / (24 * HOUR);
    if (days > 3) notes.push(`Patrol report last posted ${d.report.updated} (normal if the resort is closed)`);
  }
}

// 4. How reliably the 30-minute updater ran this past week
if (GH && REPO) {
  try {
    const since = new Date(Date.now() - 7 * 24 * HOUR).toISOString();
    const r = await get(`https://api.github.com/repos/${REPO}/actions/workflows/update-data.yml/runs?per_page=100&created=>=${since}`, { headers: { Authorization: `Bearer ${GH}`, Accept: 'application/vnd.github+json' } });
    const runs = (await r.json()).workflow_runs || [];
    const failed = runs.filter(x => x.conclusion === 'failure').length;
    const times = runs.map(x => Date.parse(x.created_at)).sort((a, b) => a - b);
    let gap = 0; for (let i = 1; i < times.length; i++) gap = Math.max(gap, (times[i] - times[i - 1]) / HOUR);
    if (times.length) gap = Math.max(gap, (Date.now() - times[times.length - 1]) / HOUR);
    notes.push(`Updater ran ${runs.length}x this week (ideal ~336)`);
    if (failed) problems.push(`Updater failed ${failed} time${failed > 1 ? 's' : ''} this week`);
    if (runs.length < 100) problems.push(`Updater ran only ${runs.length} times (longest gap ${Math.round(gap)} hrs) - GitHub's scheduler is skipping runs`);
  } catch (e) { notes.push("Couldn't read updater history"); }
}

// 5. Report
const ok = problems.length === 0;
const title = ok ? 'Wolf Creek app: all good' : `Wolf Creek app: ${problems.length} issue${problems.length > 1 ? 's' : ''}`;
const body = (ok ? '' : problems.map(p => '- ' + p).join('\n') + '\n\n') + notes.join(' / ');
console.log(title + '\n' + body);
if (process.env.NTFY_TOPIC) {
  await fetch('https://ntfy.sh/' + process.env.NTFY_TOPIC, {
    method: 'POST', body,
    headers: { Title: title, Tags: ok ? 'white_check_mark' : 'warning', Priority: ok ? '2' : '4', Click: SITE },
  });
}
