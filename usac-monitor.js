/* USAC Judge Monitor — read-only. Run inside a logged-in usac.results.info admin tab.
   Never writes scores: it only runs the site's own read queries. */
(async function () {
  if (window.__usacMon) { window.__usacMon.show(); return; }
  const CFG = { pollSec: 15, staleMin: 8, dupWindowMin: 5, inactiveMin: 10 };

  // ---------- find the app's Vue router + Apollo client ----------
  let root = null;
  document.querySelectorAll('*').forEach(el => { const v = el.__vue__; if (!root && v && v.$router && v.$apollo && v.$apollo.provider) root = v; });
  if (!root) { alert('Judge Monitor: open any usac.results.info admin page first.'); return; }
  const client = root.$apollo.provider.defaultClient;

  async function findDoc(path, test) {
    const m = root.$router.match(path); let hit = null;
    async function scan(o, d) {
      if (!o || d > 5 || hit) return;
      if (typeof o === 'function' && !o.cid) { try { const mod = await o(); o = mod.default || mod; } catch (e) { return; } }
      o = o.options || o;
      const ap = o.apollo || {};
      for (const k in ap) { const q = ap[k] && (ap[k].query || ap[k]); if (q && q.loc && test(k, q.loc.source.body)) { hit = q; return; } }
      const cs = o.components || {}; for (const n in cs) await scan(cs[n], d + 1);
    }
    for (const r of m.matched) await scan(r.components.default, 0);
    return hit;
  }

  // ---------- figure out which round ----------
  let crId = (location.pathname.match(/category_rounds\/(\d+)/) || [])[1];
  let roundId = (location.pathname.match(/jam_format\/(\d+)/) || [])[1];
  const crDoc = await findDoc('/admin/category_rounds/1/results', (k, b) => /query AdminCaRoundQuery/.test(b));
  const rankDoc = await findDoc('/admin/category_rounds/1/results', (k, b) => /query AdminCatRoundRankingQuery/.test(b));
  const roundDoc = await findDoc('/admin/events/1/round_setup/1/jam_format/1', (k, b) => /query RoundQuery/.test(b) && /judge_position_routes/.test(b));
  if (!rankDoc || !roundDoc || !crDoc) { alert('Judge Monitor: could not load the site\'s queries (site may have changed).'); return; }
  if (!roundId) {
    if (!crId) crId = prompt('Judge Monitor: paste any category-round ID from this round (the number in /admin/category_rounds/NNNN/results):');
    if (!crId) return;
    const r = await client.query({ query: crDoc, variables: { id: Number(crId) }, fetchPolicy: 'network-only' });
    roundId = r.data.category_round.round.id;
  }

  // ---------- state ----------
  let round = null, routeToJP = {}, jpNames = [], crs = [];
  let catInfo = {};   // category-round id -> { total registered, dns }
  const seen = {};          // ascentId -> {u, s}
  const events = [];        // {t, jp, pid, aid}
  const acked = {};         // alertKey -> true
  let lastPoll = null, lastErr = null, firstPoll = true, timer = null, slowSince = 0;

  // Compact climb label: "M/O-15" + boulder 1 -> "M15-1", "F-19+" + boulder 5 -> "F19-5".
  const shortCat = cat => String(cat).replace(/^([A-Za-z])[^-]*-/, '$1').replace(/\+$/, '');

  // Categories whose results are finalized drop out of monitoring.
  // Only categories that are climbing right now are watched. Category states on the site:
  // pending (not started yet) -> active (climbing) -> finished (finalized).
  const isFinal = st => /finish|official|final|closed|archiv/i.test(String(st || ''));
  const isLive = st => st === 'active';

  async function loadRound() {
    const r = await client.query({ query: roundDoc, variables: { id: Number(roundId) }, fetchPolicy: 'network-only' });
    round = Object.assign({}, r.data.round); routeToJP = {}; jpNames = [];
    round.judge_positions.forEach(j => { jpNames.push(j.name); j.judge_position_routes.forEach(x => { routeToJP[String(x.route ? x.route.id : x.route_id)] = j.name; }); });
    crs = round.category_rounds.map(c => ({ id: c.id, cat: c.category ? c.category.name : c.name, state: c.aasm_state, maxTries: c.max_tries || round.max_tries || null, routes: Object.fromEntries((c.routes || []).map(rt => [String(rt.id), rt.name])) }));
  }

  async function poll() {
    try {
      await loadRound();
      const live = crs.filter(c => isLive(c.state));
      const results = await Promise.all(live.map(c => client.query({ query: rankDoc, variables: { id: c.id }, fetchPolicy: 'network-only' }).then(r => ({ c, r }))));
      const asc = [];
      for (const { c, r } of results) {
        let items = r.data.category_round.ranking_items; if (typeof items === 'string') items = JSON.parse(items);
        catInfo[c.id] = { total: (items || []).length, dns: (items || []).filter(p => /\bDNS\b/.test(String(p.score || ''))).length };
        for (const p of items || []) for (const a of p.ascents || []) {
          asc.push({ id: a.id, dns: /\bDNS\b/.test(String(p.score || '')), out: /\bDNS\b/.test(String(p.score || '')), dsq: /\bDSQ\b/.test(String(p.score || '')), maxTries: c.maxTries, crId: c.id, rid: String(a.route_id), pid: a.participant_id, bib: p.bib_number, name: p.name, cat: c.cat, boulder: c.routes[String(a.route_id)] || '?',
            jp: routeToJP[String(a.route_id)] || '?', s: a.aasm_state, u: new Date(a.updated_at).getTime(), top: a.top, zone: a.zone, low: a.low_zone, tt: a.top_tries, zt: a.zone_tries, lt: a.low_zone_tries });
        }
      }
      const now = Date.now();
      for (const a of asc) {
        const prev = seen[a.id];
        // Score signature: changes only when a result is entered, not when a judge
        // opens an athlete (pending -> active) or confirms (active -> confirmed).
        const sig = [a.top, a.tt, a.zone, a.zt, a.low, a.lt].join('|');
        if (a.s !== 'pending' && (!prev || prev.u !== a.u)) {
          // On the first poll, seed history from updated_at so recent activity counts.
          if (!firstPoll || now - a.u < CFG.dupWindowMin * 60e3)
            events.push({ t: firstPoll ? a.u : now, su: a.u, live: !firstPoll, scored: !!prev && prev.sig !== sig, jp: a.jp, pid: a.pid, aid: a.id });
        }
        seen[a.id] = { u: a.u, s: a.s, sig };
      }
      while (events.length && now - events[0].t > 60 * 60e3) events.shift();
      if (lastPoll && now - lastPoll > 45e3) slowSince = now;
      firstPoll = false; lastPoll = now; lastErr = null;
      render(asc, now);
    } catch (e) { lastErr = e.message || String(e); render(null, Date.now()); }
  }

  const L = (id, text) => `\u0001${id}\u0002${text}\u0003`;
  const B = (id, bib) => `\u0004${id}\u0005${bib}\u0006`;
  // A climb is "topped" when every non-DNS climber in that category has topped it.
  // A JP is "done" when every climb there is either fully topped or in a finalized category,
  // and no not-yet-started category has a climb there.
  function doneState(asc) {
    const topped = new Set(), jpDone = new Set();
    for (const c of crs.filter(c => isLive(c.state))) for (const rid in c.routes) {
      const cl = asc.filter(a => a.crId === c.id && a.rid === rid && !a.dns);
      if (cl.length && cl.every(a => a.top)) topped.add(c.id + ':' + rid);
    }
    const sessionOn = crs.some(c => isLive(c.state));
    for (const jp of jpNames) {
      let used = 0, ok = true;
      for (const c of crs) for (const rid in c.routes) {
        if (routeToJP[rid] !== jp) continue;
        used++;
        if (isFinal(c.state)) continue;                                  // finalized: done
        if (!isLive(c.state) || !topped.has(c.id + ':' + rid)) ok = false; // not started, or still climbing
      }
      // Finished: every climb here is topped or finalized, while a session is still running.
      if (ok && used && sessionOn) jpDone.add(jp);
    }
    return { topped, jpDone };
  }
  // Per-climb people counts. Total and DNS come from the category's registration list;
  // Not started / Remaining / Done come from each non-DNS climber's record on this climb.
  // Total should equal Not started + Remaining + Done + DNS; if not, something is off.
  //   Done:        topped, locked, DSQ, or out of attempts (top_tries = attempts used)
  //   Not started: not done and never opened on this climb
  //   Remaining:   not done, already started, can still make attempts
  const isDone = a => a.top || a.s === 'locked' || a.dsq || (a.maxTries && (a.tt || 0) >= a.maxTries);
  function climbCounts(asc, crId, rid) {
    const ppl = asc.filter(a => a.crId === crId && a.rid === rid && !a.out);
    const k = { total: (catInfo[crId] || {}).total || 0, dns: (catInfo[crId] || {}).dns || 0,
      done: ppl.filter(isDone).length,
      notStarted: ppl.filter(a => !isDone(a) && a.s === 'pending').length,
      remaining: ppl.filter(a => !isDone(a) && a.s !== 'pending').length };
    k.ok = k.total === k.notStarted + k.remaining + k.done + k.dns;
    return k;
  }
  function fmtAgo(ms) { const m = Math.floor(ms / 60e3); return m < 1 ? '<1 min' : m + ' min'; }
  function score(a) { return [a.top ? 'T' + a.tt : null, a.zone ? 'Z' + a.zt : null, a.low ? 'LZ' + a.lt : null].filter(Boolean).join(' ') || 'no zone yet'; }

  function computeAlerts(asc, now) {
    const alerts = [];
    const byPid = {}; asc.forEach(a => (byPid[a.pid] = byPid[a.pid] || []).push(a));
    // (2) Unconfirmed scores
    for (const a of asc) {
      if (a.s !== 'active') continue;
      const age = now - a.u;
      const movedOn = (byPid[a.pid] || []).some(o => o.id !== a.id && o.s !== 'pending' && o.u > a.u + 30e3);
      if (movedOn || age > CFG.staleMin * 60e3) {
        alerts.push({ key: 'unc-' + a.id + '-' + a.u, sev: movedOn ? 'high' : 'med', jp: a.jp,
          title: `Not confirmed: ${a.jp}, ${B(a.crId, a.bib)} (${L(a.crId, a.cat)})`,
          detail: `${a.name}, boulder ${a.boulder}: ${score(a)}. Last change ${fmtAgo(age)} ago` + (movedOn ? '. Athlete has since been scored on another boulder.' : '.') });
      }
    }
    // Inactive judge position: a position that still has climbers left to judge has had
    // no score activity for inactiveMin minutes while the session is underway elsewhere.
    // Often means its judge is logged into the wrong position (or stepped away).
    const lim = CFG.inactiveMin * 60e3;
    const lastAt = jp => Math.max(0, ...asc.filter(a => a.jp === jp && a.s !== 'pending').map(a => a.u));
    const underway = jpNames.some(jp => now - lastAt(jp) < lim);
    if (underway) for (const jp of jpNames) {
      const mine = asc.filter(a => a.jp === jp);
      const workLeft = mine.some(a => a.s === 'pending' || a.s === 'active');
      const last = lastAt(jp);
      if (workLeft && now - last >= lim) alerts.push({ key: 'inactive-' + jp + '-' + last, sev: 'med', jp,
        title: `Inactive judge position: ${jp}`,
        detail: last ? `No scores entered for ${fmtAgo(now - last)}, but climbers are still waiting to be judged here. Check the judge is on the right position.`
                     : `No scores entered yet this session, while other positions are active. Check that someone is judging ${jp}.` });
    }
    // Everyone topped (per climb) and JP finished (every climb at the position is done).
    const { topped, jpDone } = doneState(asc);
    for (const jp of jpNames) if (jpDone.has(jp)) alerts.push({ key: 'jpdone-' + jp, sev: 'done', jp,
      title: `JP finished: ${jp}`,
      detail: `Every climb here is either fully topped (DNS excluded) or in a finalized category, and no unstarted category uses this position. The ${jp} volunteers can be released.` });
    for (const c of crs.filter(c => isLive(c.state))) for (const rid in c.routes) {
      const jp = routeToJP[rid] || '?';
      if (!topped.has(c.id + ':' + rid) || jpDone.has(jp)) continue;   // JP-finished alert covers it
      const n = asc.filter(a => a.crId === c.id && a.rid === rid && !a.dns).length;
      alerts.push({ key: 'topped-' + c.id + '-' + rid, sev: 'info', jp,
        title: `Everyone topped: ${jp}, ${L(c.id, shortCat(c.cat) + '-' + c.routes[rid])}`,
        detail: `All ${n} ${c.cat} climbers have topped boulder ${c.routes[rid]} (DNS excluded).` });
    }
    // Counts don't add up for a climb: Total != Not started + Remaining + Done + DNS.
    for (const c of crs.filter(c => isLive(c.state))) for (const rid in c.routes) {
      const k = climbCounts(asc, c.id, rid), jp = routeToJP[rid] || '?';
      if (!k.ok) alerts.push({ key: 'math-' + c.id + '-' + rid + '-' + [k.total, k.notStarted, k.remaining, k.done, k.dns].join('.'), sev: 'med', jp,
        title: `Counts don't add up: ${jp}, ${L(c.id, shortCat(c.cat) + '-' + c.routes[rid])}`,
        detail: `${c.cat} has ${k.total} registered, but this climb shows ${k.notStarted} not started + ${k.remaining} remaining + ${k.done} done + ${k.dns} DNS = ${k.notStarted + k.remaining + k.done + k.dns}. A climber may be missing from (or duplicated on) this boulder.` });
    }
    const order = { high: 0, med: 1, low: 2, done: 3, info: 4 };
    return alerts.sort((a, b) => order[a.sev] - order[b.sev]);
  }

  // ---------- UI ----------
  const host = document.createElement('div'); host.id = 'usac-mon';
  host.innerHTML = `<style>
  #usac-mon{position:fixed;inset:0;z-index:2147483646;background:#f5f6f8;font:13px/1.25 -apple-system,system-ui,sans-serif;color:#1d2433;overflow:auto}
  #usac-mon header{position:sticky;top:0;z-index:1;background:#1d2433;color:#fff;padding:5px 12px;display:flex;gap:4px 14px;align-items:center;flex-wrap:wrap;font-size:12px}
  #usac-mon header b{font-size:14px} #usac-mon header .sp{flex:1}
  #usac-mon header input{width:38px;padding:0 3px;font-size:12px} #usac-mon header button{background:#fff;border:0;border-radius:3px;padding:2px 8px;cursor:pointer;font-size:12px}
  #usac-mon main{padding:8px 12px;display:grid;grid-template-columns:auto minmax(260px,1fr);gap:12px;align-items:start}
  #usac-mon h2{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#5b6475;margin:0 0 4px}
  #usac-mon .al{background:#fff;border-left:5px solid #999;border-radius:5px;padding:6px 10px;margin-bottom:6px;box-shadow:0 1px 2px rgba(0,0,0,.08);display:flex;gap:8px}
  #usac-mon .al.high{border-color:#d62d2d} #usac-mon .al.med{border-color:#e8a10c} #usac-mon .al.low{border-color:#8a94a6} #usac-mon .al.info{border-color:#2f6fde} #usac-mon .al.done{border-color:#3bb36b;background:#f1faf4}
  #usac-mon .al .t{font-weight:600} #usac-mon .al .d{color:#4a5263;font-size:12px} #usac-mon .al button{margin-left:auto;align-self:start;border:1px solid #ccd;background:#fff;border-radius:3px;cursor:pointer;font-size:11px}
  #usac-mon .ok{background:#e7f6ec;color:#1e6b38;padding:8px 10px;border-radius:5px}
  #usac-mon table{width:auto;border-collapse:collapse;background:#fff;border-radius:5px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.08)}
  #usac-mon td,#usac-mon th{padding:1px 8px;border-bottom:1px solid #f0f2f5;text-align:left;white-space:nowrap} #usac-mon th{background:#fafbfc;font-size:11px;color:#5b6475;padding:3px 8px}
  #usac-mon .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:#3bb36b} #usac-mon .dot.high{background:#d62d2d} #usac-mon .dot.med{background:#e8a10c} #usac-mon .dot.low{background:#8a94a6}
  #usac-mon tr.jp td{font-weight:600;background:#f3f5f8;border-top:1px solid #dfe3e9;padding-top:2px;padding-bottom:2px} #usac-mon tr.sub td{font-size:12px;color:#4a5263} #usac-mon tr.sub td:first-child{padding-left:22px}
  #usac-mon td:nth-child(n+2):nth-child(-n+8),#usac-mon th:nth-child(n+2):nth-child(-n+8){text-align:center}
  #usac-mon td.split,#usac-mon th.split{border-left:2px solid #c9ced6}
  #usac-mon tr.done td{color:#b3b9c4;background:#fafafa} #usac-mon tr.done td.idle{background:#fafafa;color:#b3b9c4;box-shadow:none;font-weight:inherit}
  #usac-mon tr td[data-hl]{background:#fff1d6;color:#8a5300;font-weight:700}
  #usac-mon tr.done td[data-hl]{background:#fafafa;color:#b3b9c4;font-weight:inherit}
  #usac-mon tr td.idle{background:#fff1d6;color:#8a5300;font-weight:700;box-shadow:inset 3px 0 0 #e8a10c}
  #usac-mon a.cat{color:inherit;text-decoration:none;cursor:pointer} #usac-mon a.cat:hover{color:#2f6fde}
  #usac-mon .err{background:#fde8e8;color:#8a1c1c;padding:6px 10px;border-radius:5px;margin-bottom:6px}
  </style>
  <header><b>Judge Monitor</b><span id="um-round"></span><span class="sp"></span>
   <label>Unconfirmed after <input id="um-stale" type="number" min="1"> min</label>
   <label>Inactive position after <input id="um-inactive" type="number" min="1"> min</label>
   <label><input id="um-sound" type="checkbox" checked> Sound</label>
   <span id="um-status"></span><button id="um-hide">Hide</button><button id="um-stop">Stop</button></header>
  <main><section><h2>Judge positions</h2><div id="um-jps"></div></section><section><h2>Alerts</h2><div id="um-alerts"></div></section></main>`;
  document.body.appendChild(host);
  const $ = s => host.querySelector(s);
  $('#um-inactive').value = CFG.inactiveMin; $('#um-inactive').onchange = e => { CFG.inactiveMin = Math.max(1, +e.target.value || 10); poll(); };
  $('#um-stale').value = CFG.staleMin; $('#um-stale').onchange = e => { CFG.staleMin = Math.max(1, +e.target.value || 8); poll(); };
  $('#um-hide').onclick = () => { host.style.display = 'none'; };
  $('#um-stop').onclick = () => { clearInterval(timer); host.remove(); delete window.__usacMon; document.title = baseTitle; };
  const baseTitle = document.title;
  let beeped = {};
  function beep() {
    if (!$('#um-sound').checked) return;
    try { const ac = new (window.AudioContext || window.webkitAudioContext)(); [0, 0.25].forEach(d => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 880; o.connect(g); g.connect(ac.destination); g.gain.value = 0.15; o.start(ac.currentTime + d); o.stop(ac.currentTime + d + 0.15); }); } catch (e) {}
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Category links: open that category's scoring page in a new tab.
  const catUrl = id => `/admin/category_rounds/${id}/results`;
  const catA = (id, text) => `<a class="cat" href="${catUrl(id)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  const linkify = s => esc(s).replace(/\u0001(\d+)\u0002([^\u0003]*)\u0003/g, (m, id, t) => `<a class="cat" href="${catUrl(id)}" target="_blank" rel="noopener">${t}</a>`)
    .replace(/\u0004(\d+)\u0005([^\u0006]*)\u0006/g, (m, id, b) => `<a class="cat bib" href="${catUrl(id)}" target="_blank" data-bib="${b}">bib ${b}</a>`);

  let lastAsc = null;
  function render(asc, now) {
    if (asc) lastAsc = asc; asc = lastAsc || [];
    const pick = f => crs.filter(c => f(c.state)).map(c => catA(c.id, c.cat));
    const liveCats = pick(isLive), doneCats = pick(isFinal), waitCats = pick(st => !isLive(st) && !isFinal(st));
    $('#um-round').innerHTML = round ? `${esc(round.name)} · watching ${liveCats.length ? liveCats.join(', ') : 'no categories (none are active yet)'}` +
      (waitCats.length ? ` · not started: ${waitCats.join(', ')}` : '') + (doneCats.length ? ` · finalized: ${doneCats.join(', ')}` : '') : '';
    $('#um-status').textContent = lastPoll ? `Updated ${new Date(lastPoll).toLocaleTimeString()}` : 'Loading…';
    const alerts = computeAlerts(asc, now).filter(a => !acked[a.key]);
    let html = (now - slowSince < 5 * 60e3) ? '<div class="err">Refreshes were delayed. Chrome slows down tabs that are not in front: keep this tab visible (its own window works well).</div>' : '';
    html += lastErr ? `<div class="err">Last refresh failed: ${esc(lastErr)}. Still retrying. If this persists, reload the page (you may have been logged out).</div>` : '';
    html += alerts.length ? alerts.map(a => `<div class="al ${a.sev}"><div><div class="t">${linkify(a.title)}</div><div class="d">${linkify(a.detail)}</div></div><button data-k="${esc(a.key)}">Dismiss</button></div>`).join('')
      : '<div class="ok">All clear. No unconfirmed scores or inactive positions.</div>';
    $('#um-alerts').innerHTML = html;
    host.querySelectorAll('#um-alerts button[data-k]').forEach(b => b.onclick = () => { acked[b.dataset.k] = true; render(null, Date.now()); });
    // One row per position, then a sub-row per live category + boulder judged there.
    const stats = (list, k, flagIdle) => {
      const last = Math.max(0, ...list.filter(a => a.s !== 'pending').map(a => a.u));
      const pend = list.filter(a => a.s === 'active').length; // highlighted when more than 1
      // Flag a climb that still has climbers to judge but no activity within the inactive limit.
      const idle = flagIdle && list.some(a => a.s === 'pending' || a.s === 'active') && (!last || now - last >= CFG.inactiveMin * 60e3);
      return `<td${k.ok ? '' : ' data-hl'}>${k.total}</td><td>${k.notStarted}</td><td>${k.remaining}</td><td>${k.done}</td><td>${k.dns}</td>` +
        `<td class="split"${pend > 1 ? ' data-hl' : ''}>${pend}</td><td>${list.filter(a => a.s === 'confirmed').length}</td>` +
        `<td${idle ? ' class="idle"' : ''}>${last ? fmtAgo(now - last) : 'n/a'}</td>`;
    };
    const liveCrs = crs.filter(c => isLive(c.state));
    const { topped, jpDone } = doneState(asc);
    const rows = jpNames.map(jp => {
      const mine = asc.filter(a => a.jp === jp);
      const worst = alerts.filter(a => a.jp === jp && ['high', 'med', 'low'].includes(a.sev)).map(a => a.sev).sort((x, y) => ({ high: 0, med: 1, low: 2 })[x] - ({ high: 0, med: 1, low: 2 })[y])[0];
      const sum = { total: 0, notStarted: 0, remaining: 0, done: 0, dns: 0, ok: true }; let subs = '';
      for (const c of liveCrs) for (const rid in c.routes) {
        if (routeToJP[rid] !== jp) continue;
        const k = climbCounts(asc, c.id, rid);
        for (const f of ['total', 'notStarted', 'remaining', 'done', 'dns']) sum[f] += k[f];
        sum.ok = sum.ok && k.ok;
        subs += `<tr class="sub${topped.has(c.id + ':' + rid) ? ' done' : ''}"><td>${catA(c.id, shortCat(c.cat) + '-' + c.routes[rid])}</td>${stats(mine.filter(a => a.rid === rid), k, true)}</tr>`;
      }
      return `<tr class="jp${jpDone.has(jp) ? ' done' : ''}"><td><span class="dot ${worst || ''}"></span>${esc(jp)}</td>${stats(mine, sum)}</tr>` + subs;
    }).join('');
    $('#um-jps').innerHTML = `<table><tr><th>Position / climb</th><th>Total</th><th>Not started</th><th>Remaining</th><th>Done</th><th>DNS</th><th class="split">Pending</th><th>Confirmed</th><th>Last activity</th></tr>${rows}</table>`;
    const hi = alerts.filter(a => a.sev === 'high' || a.sev === 'med');
    document.title = hi.length ? `(${hi.length}) ⚠ Judge Monitor` : baseTitle;
    const fresh = hi.filter(a => !beeped[a.key]); if (fresh.length) { beep(); fresh.forEach(a => beeped[a.key] = true); }
  }

  // Bib links: open the category's results page in a new tab and search for that bib.
  // Same site, so we can fill the page's own "Search by bib number or name" box.
  host.addEventListener('click', e => {
    const a = e.target.closest('a.bib'); if (!a) return;
    e.preventDefault();
    const w = window.open(a.href, '_blank'); if (!w) { location.href = a.href; return; }
    const bib = a.dataset.bib, t0 = Date.now();
    const tick = setInterval(() => {
      try {
        const inp = [...w.document.querySelectorAll('input')].find(i => /bib/i.test(i.placeholder || ''));
        const ready = inp && w.document.querySelectorAll('table tbody tr').length > 0;
        if (ready) {
          Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(inp, bib);
          inp.dispatchEvent(new w.Event('input', { bubbles: true }));
          clearInterval(tick);
        }
      } catch (err) {}
      if (Date.now() - t0 > 20000) clearInterval(tick);
    }, 300);
  });

  window.__usacMon = { show: () => { host.style.display = ''; } };
  await poll();
  timer = setInterval(poll, CFG.pollSec * 1000);
})();
