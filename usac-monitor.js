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
  const seen = {};          // ascentId -> {u, s}
  const events = [];        // {t, jp, pid, aid}
  const acked = {};         // alertKey -> true
  let lastPoll = null, lastErr = null, firstPoll = true, timer = null, slowSince = 0;

  // Compact climb label: "M/O-15" + boulder 1 -> "M15-1", "F-19+" + boulder 5 -> "F19-5".
  const shortCat = cat => String(cat).replace(/^([A-Za-z])[^-]*-/, '$1').replace(/\+$/, '');

  // Categories whose results are finalized drop out of monitoring.
  const isFinal = st => /finish|official|final|closed|archiv/i.test(String(st || ''));

  async function loadRound() {
    const r = await client.query({ query: roundDoc, variables: { id: Number(roundId) }, fetchPolicy: 'network-only' });
    round = Object.assign({}, r.data.round); routeToJP = {}; jpNames = [];
    round.judge_positions.forEach(j => { jpNames.push(j.name); j.judge_position_routes.forEach(x => { routeToJP[String(x.route ? x.route.id : x.route_id)] = j.name; }); });
    crs = round.category_rounds.map(c => ({ id: c.id, cat: c.category ? c.category.name : c.name, state: c.aasm_state, routes: Object.fromEntries((c.routes || []).map(rt => [String(rt.id), rt.name])) }));
  }

  async function poll() {
    try {
      await loadRound();
      const live = crs.filter(c => !isFinal(c.state));
      const results = await Promise.all(live.map(c => client.query({ query: rankDoc, variables: { id: c.id }, fetchPolicy: 'network-only' }).then(r => ({ c, r }))));
      const asc = [];
      for (const { c, r } of results) {
        let items = r.data.category_round.ranking_items; if (typeof items === 'string') items = JSON.parse(items);
        for (const p of items || []) for (const a of p.ascents || []) {
          asc.push({ id: a.id, crId: c.id, rid: String(a.route_id), pid: a.participant_id, bib: p.bib_number, name: p.name, cat: c.cat, boulder: c.routes[String(a.route_id)] || '?',
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
          title: `Not confirmed: ${a.jp}, bib ${a.bib} (${L(a.crId, a.cat)})`,
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
    const order = { high: 0, med: 1, low: 2 };
    return alerts.sort((a, b) => order[a.sev] - order[b.sev]);
  }

  // ---------- UI ----------
  const host = document.createElement('div'); host.id = 'usac-mon';
  host.innerHTML = `<style>
  #usac-mon{position:fixed;inset:0;z-index:2147483646;background:#f5f6f8;font:14px/1.4 -apple-system,system-ui,sans-serif;color:#1d2433;overflow:auto}
  #usac-mon header{position:sticky;top:0;background:#1d2433;color:#fff;padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  #usac-mon header b{font-size:16px} #usac-mon header .sp{flex:1}
  #usac-mon header input{width:44px;padding:2px 4px} #usac-mon header button{background:#fff;border:0;border-radius:4px;padding:4px 10px;cursor:pointer}
  #usac-mon main{padding:16px;display:grid;grid-template-columns:minmax(280px,2fr) minmax(380px,3fr);gap:16px}
  #usac-mon h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#5b6475;margin:0 0 8px}
  #usac-mon .al{background:#fff;border-left:6px solid #999;border-radius:6px;padding:10px 12px;margin-bottom:8px;box-shadow:0 1px 2px rgba(0,0,0,.08);display:flex;gap:10px}
  #usac-mon .al.high{border-color:#d62d2d} #usac-mon .al.med{border-color:#e8a10c} #usac-mon .al.low{border-color:#8a94a6}
  #usac-mon .al .t{font-weight:600} #usac-mon .al .d{color:#4a5263;font-size:13px} #usac-mon .al button{margin-left:auto;align-self:start;border:1px solid #ccd;background:#fff;border-radius:4px;cursor:pointer}
  #usac-mon .ok{background:#e7f6ec;color:#1e6b38;padding:12px;border-radius:6px}
  #usac-mon table{width:100%;border-collapse:collapse;background:#fff;border-radius:6px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.08)}
  #usac-mon td,#usac-mon th{padding:6px 10px;border-bottom:1px solid #eef0f3;text-align:left} #usac-mon th{background:#fafbfc;font-size:12px;color:#5b6475}
  #usac-mon .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;background:#3bb36b} #usac-mon .dot.high{background:#d62d2d} #usac-mon .dot.med{background:#e8a10c} #usac-mon .dot.low{background:#8a94a6}
  #usac-mon tr.jp td{font-weight:600;background:#fafbfc;border-top:2px solid #e3e6eb} #usac-mon tr.sub td{font-size:13px;color:#4a5263} #usac-mon tr.sub td:first-child{padding-left:28px}
  #usac-mon tr td.idle{background:#fff1d6;color:#8a5300;font-weight:700;box-shadow:inset 3px 0 0 #e8a10c}
  #usac-mon a.cat{color:inherit;text-decoration:none;cursor:pointer} #usac-mon a.cat:hover{color:#2f6fde}
  #usac-mon .err{background:#fde8e8;color:#8a1c1c;padding:8px 12px;border-radius:6px;margin-bottom:8px}
  </style>
  <header><b>Judge Monitor</b><span id="um-round"></span><span class="sp"></span>
   <label>Unconfirmed after <input id="um-stale" type="number" min="1"> min</label>
   <label>Inactive position after <input id="um-inactive" type="number" min="1"> min</label>
   <label><input id="um-sound" type="checkbox" checked> Sound</label>
   <span id="um-status"></span><button id="um-hide">Hide</button><button id="um-stop">Stop</button></header>
  <main><section><h2>Alerts</h2><div id="um-alerts"></div></section><section><h2>Judge positions</h2><div id="um-jps"></div></section></main>`;
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
  const linkify = s => esc(s).replace(/\u0001(\d+)\u0002([^\u0003]*)\u0003/g, (m, id, t) => `<a class="cat" href="${catUrl(id)}" target="_blank" rel="noopener">${t}</a>`);

  let lastAsc = null;
  function render(asc, now) {
    if (asc) lastAsc = asc; asc = lastAsc || [];
    const liveCats = crs.filter(c => !isFinal(c.state)).map(c => catA(c.id, c.cat)), doneCats = crs.filter(c => isFinal(c.state)).map(c => catA(c.id, c.cat));
    $('#um-round').innerHTML = round ? `${esc(round.name)} · watching ${liveCats.length ? liveCats.join(', ') : 'no categories'}` + (doneCats.length ? ` · finalized, not watched: ${doneCats.join(', ')}` : '') : '';
    $('#um-status').textContent = lastPoll ? `Updated ${new Date(lastPoll).toLocaleTimeString()}` : 'Loading…';
    const alerts = computeAlerts(asc, now).filter(a => !acked[a.key]);
    let html = (now - slowSince < 5 * 60e3) ? '<div class="err">Refreshes were delayed. Chrome slows down tabs that are not in front: keep this tab visible (its own window works well).</div>' : '';
    html += lastErr ? `<div class="err">Last refresh failed: ${esc(lastErr)}. Still retrying. If this persists, reload the page (you may have been logged out).</div>` : '';
    html += alerts.length ? alerts.map(a => `<div class="al ${a.sev}"><div><div class="t">${linkify(a.title)}</div><div class="d">${linkify(a.detail)}</div></div><button data-k="${esc(a.key)}">Dismiss</button></div>`).join('')
      : '<div class="ok">All clear. No unconfirmed scores or inactive positions.</div>';
    $('#um-alerts').innerHTML = html;
    host.querySelectorAll('#um-alerts button[data-k]').forEach(b => b.onclick = () => { acked[b.dataset.k] = true; render(null, Date.now()); });
    // One row per position, then a sub-row per live category + boulder judged there.
    const stats = (list, flagIdle) => {
      const last = Math.max(0, ...list.filter(a => a.s !== 'pending').map(a => a.u));
      const pend = list.filter(a => a.s === 'active').length; // highlighted when more than 1
      // Flag a climb that still has climbers to judge but no activity within the inactive limit.
      const idle = flagIdle && list.some(a => a.s === 'pending' || a.s === 'active') && (!last || now - last >= CFG.inactiveMin * 60e3);
      return `<td>${list.filter(a => a.s === 'pending').length}</td><td${pend > 1 ? ' class="idle"' : ''}>${pend}</td>` +
        `<td>${list.filter(a => a.s === 'confirmed').length}</td><td>${list.filter(a => a.s === 'locked').length}</td>` +
        `<td${idle ? ' class="idle"' : ''}>${last ? fmtAgo(now - last) : 'n/a'}</td>`;
    };
    const liveCrs = crs.filter(c => !isFinal(c.state));
    const rows = jpNames.map(jp => {
      const mine = asc.filter(a => a.jp === jp);
      const worst = alerts.filter(a => a.jp === jp).map(a => a.sev).sort()[0];
      let html = `<tr class="jp"><td><span class="dot ${worst || ''}"></span>${esc(jp)}</td>${stats(mine)}</tr>`;
      for (const c of liveCrs) for (const rid in c.routes) {
        if (routeToJP[rid] !== jp) continue;
        html += `<tr class="sub"><td>${catA(c.id, shortCat(c.cat) + '-' + c.routes[rid])}</td>${stats(mine.filter(a => a.rid === rid), true)}</tr>`;
      }
      return html;
    }).join('');
    $('#um-jps').innerHTML = `<table><tr><th>Position / climb</th><th>Not started</th><th>Pending</th><th>Confirmed</th><th>Locked</th><th>Last activity</th></tr>${rows}</table>`;
    const hi = alerts.filter(a => a.sev !== 'low');
    document.title = hi.length ? `(${hi.length}) ⚠ Judge Monitor` : baseTitle;
    const fresh = hi.filter(a => !beeped[a.key]); if (fresh.length) { beep(); fresh.forEach(a => beeped[a.key] = true); }
  }

  window.__usacMon = { show: () => { host.style.display = ''; } };
  await poll();
  timer = setInterval(poll, CFG.pollSec * 1000);
})();
