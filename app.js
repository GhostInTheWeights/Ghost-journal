'use strict';
/* Ghost Journal: trade log, review dashboard and P&L calendar. Data lives in the local server (SQLite). */

const S = { trades: [], settings: null, days: {}, view: 'dashboard', calMonth: null, selDay: null, editing: null, equityChart: null };
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- api ---------- */
async function api(path, opts = {}) {
  const r = await fetch('api/' + path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const jsonOpts = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function loadAll() {
  [S.trades, S.settings, S.days] = await Promise.all([api('trades'), api('settings'), api('days')]);
}

/* ---------- formatting & derived fields ---------- */
const cur = () => S.settings.currency || '$';
function money(v, sign = true) {
  if (v == null || isNaN(v)) return '—';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '−' : sign && v > 0 ? '+' : '') + cur() + s;
}
const cls = v => v > 0 ? 'gain' : v < 0 ? 'loss' : '';
const fmtR = r => r == null ? '—' : (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(2) + 'R';
const num = v => v === '' || v == null ? null : Number(v);
const pad = n => String(n).padStart(2, '0');
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = s => s ? new Date(s).toISOString().replace('.000Z', 'Z') : null;
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDate = iso => new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
const nyHour = iso => +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(iso));
function sessionOf(iso) {
  const h = nyHour(iso);
  return h >= 18 || h < 3 ? 'Asia' : h < 8 ? 'London' : h < 12 ? 'New York AM' : h < 17 ? 'New York PM' : 'Close';
}
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function enrich(t) {
  const dir = t.side === 'sell' ? -1 : 1;
  const fees = num(t.fees) || 0;   // a cost: positive = paid, negative = credit (e.g. positive swap)
  const pnl = num(t.pnl);
  const net = pnl == null ? null : pnl - fees;
  const risk = t.sl != null && t.sl !== '' ? Math.abs(t.entry - t.sl) : 0;
  const r = risk > 0 && t.exit != null && t.exit !== '' ? (t.exit - t.entry) * dir / risk : null;
  const when = t.close_time || t.open_time;
  return { ...t, _net: net, _r: r, _when: when, _date: new Date(when), _session: t.open_time ? sessionOf(t.open_time) : '' };
}

/* ---------- filters ---------- */
function periodRange() {
  const p = $('fPeriod').value, now = new Date(), start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (p === 'week') { const d = (start.getDay() + 6) % 7; start.setDate(start.getDate() - d); return [start, null]; }
  if (p === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1), null];
  if (p === 'year') return [new Date(now.getFullYear(), 0, 1), null];
  if (p === '30' || p === '90') { start.setDate(start.getDate() - (+p - 1)); return [start, null]; }
  if (p === 'custom') {
    const f = $('fFrom').value, t = $('fTo').value;
    return [f ? new Date(f + 'T00:00') : null, t ? new Date(t + 'T23:59:59') : null];
  }
  return [null, null];
}
function filtered({ ignorePeriod = false } = {}) {
  const [from, to] = ignorePeriod ? [null, null] : periodRange();
  const acc = $('fAccount').value, sym = $('fSymbol').value, setup = $('fSetup').value, side = $('fSide').value;
  return S.trades.map(enrich).filter(t =>
    (!from || t._date >= from) && (!to || t._date <= to) && (!acc || t.account === acc) && (!sym || t.symbol === sym) &&
    (!setup || (t.setup || '(no setup)') === setup) && (!side || t.side === side))
    .sort((a, b) => a._date - b._date);
}
function fillSelect(id, values, allLabel) {
  const el = $(id), keep = el.value;
  el.innerHTML = `<option value="">${allLabel}</option>` + values.map(v => `<option>${esc(v)}</option>`).join('');
  if (values.includes(keep)) el.value = keep;
}
function refreshFilterOptions() {
  const uniq = k => [...new Set(S.trades.map(t => t[k]).filter(Boolean))].sort();
  fillSelect('fAccount', uniq('account'), 'All');
  fillSelect('fSymbol', uniq('symbol'), 'All');
  const setups = [...new Set([...S.settings.setups, ...uniq('setup')])];
  if (S.trades.some(t => !t.setup)) setups.push('(no setup)');
  fillSelect('fSetup', setups, 'All');
  $('accountList').innerHTML = uniq('account').map(v => `<option value="${esc(v)}">`).join('');
  $('symbolList').innerHTML = [...new Set([...uniq('symbol'), ...Object.keys(S.settings.contracts || {})])].map(v => `<option value="${esc(v)}">`).join('');
}

/* ---------- stats ---------- */
function statsOf(ts) {
  const closed = ts.filter(t => t._net != null);
  const wins = closed.filter(t => t._net > 0), losses = closed.filter(t => t._net < 0);
  const gw = wins.reduce((a, t) => a + t._net, 0), gl = -losses.reduce((a, t) => a + t._net, 0);
  const rs = closed.filter(t => t._r != null).map(t => t._r);
  let eq = 0, peak = 0, mdd = 0;
  for (const t of closed) { eq += t._net; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq); }
  const planned = closed.filter(t => t.plan_followed);
  return {
    n: closed.length, wins: wins.length, losses: losses.length, net: gw - gl, gw, gl,
    winRate: closed.length ? wins.length / closed.length : null, pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : null),
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null, nR: rs.length,
    exp: closed.length ? (gw - gl) / closed.length : null,
    avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null,
    mdd, best: closed.length ? Math.max(...closed.map(t => t._net)) : null, worst: closed.length ? Math.min(...closed.map(t => t._net)) : null,
    plan: planned.length ? planned.filter(t => t.plan_followed === 'yes').length / planned.length : null, nPlan: planned.length,
  };
}
function groupBy(ts, keyFn) {
  const m = new Map();
  for (const t of ts) {
    if (t._net == null) continue;
    for (const k of [].concat(keyFn(t))) {
      if (k == null || k === '') continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    }
  }
  return [...m].map(([name, list]) => ({ name, ...statsOf(list) }));
}

/* ---------- tooltip ---------- */
const tip = document.createElement('div'); tip.id = 'tip'; tip.className = 'hidden'; document.body.appendChild(tip);
document.addEventListener('mousemove', e => {
  const el = e.target.closest('[data-tip]');
  if (!el) { tip.classList.add('hidden'); return; }
  tip.innerHTML = el.dataset.tip; tip.classList.remove('hidden');
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8), y = Math.min(e.clientY + 14, innerHeight - tip.offsetHeight - 8);
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
});
const tipFor = g => esc(`<b>${g.name}</b><br>Net ${money(g.net)}<br>${g.n} trades · ${g.winRate == null ? '—' : Math.round(g.winRate * 100) + '% wins'}` +
  `<br>Avg R ${fmtR(g.avgR)} · PF ${g.pf == null ? '—' : g.pf === Infinity ? '∞' : g.pf.toFixed(2)}`);

/* ---------- dashboard ---------- */
function barsHTML(groups, { sort = true, labelFn } = {}) {
  if (!groups.length) return '<div class="muted">No data yet</div>';
  const list = sort ? [...groups].sort((a, b) => b.net - a.net) : groups;
  const max = Math.max(...list.map(g => Math.abs(g.net)), 1e-9);
  const hasNeg = list.some(g => g.net < 0), hasPos = list.some(g => g.net > 0);
  const zero = hasNeg && hasPos ? 50 : hasNeg ? 100 : 0;
  const span = hasNeg && hasPos ? 50 : 100;
  return `<div class="bars">${list.map(g => {
    const w = Math.abs(g.net) / max * span;
    const left = g.net >= 0 ? zero : zero - w;
    const tipHtml = tipFor(g);
    return `<div class="name" data-tip="${tipHtml}">${esc(labelFn ? labelFn(g) : g.name)}</div>
      <div class="track" data-tip="${tipHtml}"><div class="zero" style="left:${zero}%"></div>
        <div class="bar ${g.net >= 0 ? 'pos' : 'neg'}" style="left:${left}%;width:${Math.max(w, .6)}%"></div></div>
      <div class="val" data-tip="${tipHtml}"><span class="${cls(g.net)}">${money(g.net)}</span><small>${g.n}</small></div>`;
  }).join('')}</div>`;
}
function histHTML(ts) {
  const rs = ts.filter(t => t._r != null).map(t => Math.round(t._r * 100) / 100);   // -0.99999 and -1.00001 are both -1R
  if (rs.length < 2) return '<div class="muted">Add a stop loss to your trades to see R-multiples.</div>';
  const edges = [-Infinity, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3, Infinity];
  const labels = ['<−2', '−2', '−1.5', '−1', '−0.5', '0', '0.5', '1', '1.5', '2', '3+'];
  const counts = labels.map((_, i) => rs.filter(r => r >= edges[i] && r < edges[i + 1]).length);
  const max = Math.max(...counts, 1);
  return `<div class="hist">${counts.map((c, i) => `<div class="col" data-tip="${esc(`<b>${labels[i]}${i < 10 ? ' to ' + labels[i + 1] : ''}R</b><br>${c} trades`)}">
      ${c ? `<span class="c">${c}</span>` : ''}<div class="b" style="height:${c / max * 100}%;background:${edges[i] < 0 ? 'var(--loss)' : 'var(--gain)'}"></div></div>`).join('')}</div>
    <div class="hist-axis">${labels.map(l => `<span>${l}</span>`).join('')}</div>`;
}
function insights(ts, st) {
  const out = [];
  const setups = groupBy(ts, t => t.setup).filter(g => g.n >= 3).sort((a, b) => b.net - a.net);
  if (setups.length) out.push(`Best setup: <b>${esc(setups[0].name)}</b> (${money(setups[0].net)} over ${setups[0].n} trades).`);
  if (setups.length > 1 && setups[setups.length - 1].net < 0) {
    const w = setups[setups.length - 1];
    out.push(`Weakest setup: <b>${esc(w.name)}</b> (${money(w.net)} over ${w.n} trades). Worth reviewing or pausing.`);
  }
  const mist = groupBy(ts, t => t.mistakes || []).sort((a, b) => a.net - b.net);
  if (mist.length && mist[0].net < 0) out.push(`Most expensive mistake: <b>${esc(mist[0].name)}</b>, ${money(mist[0].net)} across ${mist[0].n} trades.`);
  const plan = groupBy(ts, t => t.plan_followed);
  const y = plan.find(g => g.name === 'yes'), n = plan.find(g => g.name === 'no');
  if (y && n) out.push(`When you followed your plan: ${money(y.exp)} per trade. When you didn't: ${money(n.exp)} per trade.`);
  const days = groupBy(ts, t => WEEKDAYS[t._date.getDay()]).filter(g => g.n >= 3).sort((a, b) => b.net - a.net);
  if (days.length > 1) out.push(`Best weekday: <b>${days[0].name}</b> (${money(days[0].net)}); worst: <b>${days[days.length - 1].name}</b> (${money(days[days.length - 1].net)}).`);
  if (st.n && st.avgWin != null && st.avgLoss != null)
    out.push(`Average win ${money(st.avgWin)} vs average loss ${money(st.avgLoss)}. You need a win rate above ${Math.round(Math.abs(st.avgLoss) / (st.avgWin + Math.abs(st.avgLoss)) * 100)}% to break even at that ratio; you have ${Math.round(st.winRate * 100)}%.`);
  return out.length ? `<ul class="insights">${out.map(s => `<li>${s}</li>`).join('')}</ul>` : '<div class="muted">Log a few more trades with setups, mistakes and plan ratings to get insights.</div>';
}
function kpi(label, value, sub = '', klass = '') {
  return `<div class="kpi"><div class="l">${label}</div><div class="v ${klass}">${value}</div><div class="s">${sub}</div></div>`;
}
function renderDashboard() {
  const el = $('view-dashboard'), ts = filtered(), st = statsOf(ts);
  if (!S.trades.length) {
    el.innerHTML = `<div class="empty"><b>Your journal is empty.</b><br>Click <b>+ New trade</b> to log a trade by hand,<br>or <b>Import</b> your closed trades from MetaTrader 5 or a Ghost Charts backtest.</div>`;
    return;
  }
  const bal0 = Number(S.settings.start_balance) || 0;
  const pf = st.pf == null ? '—' : st.pf === Infinity ? '∞' : st.pf.toFixed(2);
  el.innerHTML = `
    <div class="kpis">
      ${kpi('Net P&L', money(st.net), `${st.n} closed trades`, cls(st.net))}
      ${kpi('Win rate', st.winRate == null ? '—' : Math.round(st.winRate * 100) + '%', `${st.wins} wins · ${st.losses} losses`)}
      ${kpi('Profit factor', pf, 'gross profit ÷ gross loss')}
      ${kpi('Average R', fmtR(st.avgR), `${st.nR} trades with a stop`, cls(st.avgR))}
      ${kpi('Expectancy', money(st.exp), 'average per trade', cls(st.exp))}
      ${kpi('Max drawdown', money(-st.mdd), bal0 ? (st.mdd / bal0 * 100).toFixed(1) + '% of starting balance' : '', st.mdd ? 'loss' : '')}
      ${kpi('Avg win / avg loss', `<span class="gain">${money(st.avgWin, false)}</span>`, `<span class="loss">${money(st.avgLoss, false)}</span> average loss`)}
      ${kpi('Followed plan', st.plan == null ? '—' : Math.round(st.plan * 100) + '%', `${st.nPlan} trades rated`)}
    </div>
    <div class="grid2" style="grid-template-columns: 2fr 1fr">
      <div class="card"><h3>Account balance</h3><div class="sub">Starting balance ${money(bal0, false)} plus net P&amp;L of each closed trade, in order</div><div id="equity"></div></div>
      <div class="card"><h3>Insights</h3><div class="sub">From the trades in the current filter</div>${insights(ts, st)}</div>
    </div>
    <div class="grid2">
      <div class="card"><h3>By setup</h3><div class="sub">Net P&amp;L · number of trades</div>${barsHTML(groupBy(ts, t => t.setup || '(no setup)'))}</div>
      <div class="card"><h3>By session</h3><div class="sub">When the trade was opened (New York sessions)</div>${barsHTML(groupBy(ts, t => t._session), { sort: false })}</div>
      <div class="card"><h3>By weekday</h3><div class="sub">Day the trade closed</div>${barsHTML(groupBy(ts, t => WEEKDAYS[t._date.getDay()]).sort((a, b) => WEEKDAYS.indexOf(a.name) - WEEKDAYS.indexOf(b.name)), { sort: false })}</div>
      <div class="card"><h3>Mistakes</h3><div class="sub">Net P&amp;L of trades tagged with each mistake</div>${barsHTML(groupBy(ts, t => t.mistakes || []))}</div>
      <div class="card"><h3>Followed my plan?</h3><div class="sub">Your own rating per trade</div>${barsHTML(groupBy(ts, t => t.plan_followed), { labelFn: g => ({ yes: 'Yes', partly: 'Partly', no: 'No' }[g.name] || g.name) })}</div>
      <div class="card"><h3>Feeling before the trade</h3><div class="sub">Net P&amp;L by emotion</div>${barsHTML(groupBy(ts, t => t.emotion_before))}</div>
      <div class="card"><h3>By symbol</h3><div class="sub">Net P&amp;L · number of trades</div>${barsHTML(groupBy(ts, t => t.symbol))}</div>
      <div class="card"><h3>Long vs short</h3><div class="sub">Net P&amp;L · number of trades</div>${barsHTML(groupBy(ts, t => t.side === 'sell' ? 'Short' : 'Long'))}</div>
      <div class="card"><h3>R-multiple distribution</h3><div class="sub">Result of each trade in units of its initial risk</div>${histHTML(ts)}</div>
    </div>`;
  drawEquity(ts, bal0);
}
function drawEquity(ts, bal0) {
  const box = $('equity');
  if (S.equityChart) { S.equityChart.remove(); S.equityChart = null; }
  const closed = ts.filter(t => t._net != null);
  if (!closed.length) { box.innerHTML = '<div class="muted">No closed trades in this filter</div>'; return; }
  const chart = LightweightCharts.createChart(box, {
    autoSize: true, layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#b2b5be', fontSize: 11 },
    grid: { vertLines: { visible: false }, horzLines: { color: '#262a35' } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true },
    crosshair: { horzLine: { labelBackgroundColor: '#2a2e39' }, vertLine: { labelBackgroundColor: '#2a2e39' } },
    localization: { priceFormatter: p => cur() + p.toLocaleString('en-US', { maximumFractionDigits: 0 }) },
    handleScroll: false, handleScale: false,
  });
  const s = chart.addBaselineSeries({ baseValue: { type: 'price', price: bal0 }, lineWidth: 2,
    topLineColor: '#0ca30c', topFillColor1: 'rgba(12,163,12,.25)', topFillColor2: 'rgba(12,163,12,.02)',
    bottomLineColor: '#d03b3b', bottomFillColor1: 'rgba(208,59,59,.02)', bottomFillColor2: 'rgba(208,59,59,.25)',
    priceLineVisible: false, lastValueVisible: true });
  let eq = bal0, last = 0;
  const data = [{ time: Math.floor(closed[0]._date / 1000) - 3600, value: bal0 }];
  for (const t of closed) {
    let tt = Math.floor(t._date / 1000); if (tt <= last) tt = last + 1; last = tt;
    eq += t._net; data.push({ time: tt, value: Math.round(eq * 100) / 100 });
  }
  if (data[0].time >= data[1].time) data[0].time = data[1].time - 1;
  s.setData(data);
  chart.timeScale().fitContent();
  S.equityChart = chart;
}

/* ---------- journal table ---------- */
function renderJournal() {
  const el = $('view-journal'), ts = filtered().reverse();
  if (!ts.length) {
    el.innerHTML = `<div class="empty">${S.trades.length ? 'No trades match the filters.' : '<b>No trades yet.</b><br>Click <b>+ New trade</b> or use <b>Import</b>.'}</div>`;
    return;
  }
  el.innerHTML = `<div class="tbl-wrap"><table><thead><tr>
    <th>Opened</th><th>Symbol</th><th>Side</th><th>Setup</th><th>Session</th><th class="r">Lots</th><th class="r">Entry</th><th class="r">Exit</th>
    <th class="r">Net P&amp;L</th><th class="r">R</th><th>Plan</th><th>Mistakes</th><th>Account</th><th></th></tr></thead><tbody>
    ${ts.map(t => `<tr data-id="${t.id}">
      <td>${fmtDate(t.open_time)}</td><td><b>${esc(t.symbol)}</b></td>
      <td><span class="pill ${t.side}">${t.side === 'sell' ? 'Short' : 'Long'}</span></td>
      <td>${esc(t.setup) || '<span class="muted">—</span>'}</td><td class="muted">${t._session}</td>
      <td class="r">${t.lots ?? ''}</td><td class="r">${t.entry ?? ''}</td><td class="r">${t.exit ?? '<span class="muted">open</span>'}</td>
      <td class="r ${cls(t._net)}">${money(t._net)}</td><td class="r ${cls(t._r)}">${fmtR(t._r)}</td>
      <td>${{ yes: '✓', partly: '½', no: '✗' }[t.plan_followed] || '<span class="muted">—</span>'}</td>
      <td>${(t.mistakes || []).map(m => `<span class="pill warn">${esc(m)}</span>`).join(' ')}</td>
      <td class="muted">${esc(t.account)}</td><td>${(t.images || []).length ? '📷' : ''}${t.notes ? ' 📝' : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}
$('view-journal').addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr) openForm(S.trades.find(t => t.id == tr.dataset.id)); });

/* ---------- calendar ---------- */
function renderCalendar() {
  const el = $('view-calendar');
  const ts = filtered({ ignorePeriod: true }).filter(t => t._net != null);
  if (!S.calMonth) { const last = ts.length ? ts[ts.length - 1]._date : new Date(); S.calMonth = new Date(last.getFullYear(), last.getMonth(), 1); }
  const m0 = S.calMonth, y = m0.getFullYear(), mo = m0.getMonth();
  const byDay = new Map();
  for (const t of ts) { const k = dayKey(t._date); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(t); }
  const start = new Date(y, mo, 1); start.setDate(1 - ((start.getDay() + 6) % 7));
  const monthNets = [...byDay].filter(([k]) => k.startsWith(`${y}-${pad(mo + 1)}`)).map(([, l]) => l.reduce((a, t) => a + t._net, 0));
  const maxAbs = Math.max(...monthNets.map(Math.abs), 1);
  const monthNet = monthNets.reduce((a, b) => a + b, 0), monthN = [...byDay].filter(([k]) => k.startsWith(`${y}-${pad(mo + 1)}`)).reduce((a, [, l]) => a + l.length, 0);
  let cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="dow">${d}</div>`).join('') + '<div class="dow wkh">Week</div>';
  const d = new Date(start);
  for (let w = 0; w < 6; w++) {
    let wkNet = 0, wkN = 0;
    for (let i = 0; i < 7; i++) {
      const k = dayKey(d), list = byDay.get(k) || [], net = list.reduce((a, t) => a + t._net, 0);
      wkNet += net; wkN += list.length;
      const a = list.length ? 0.12 + 0.5 * Math.min(1, Math.abs(net) / maxAbs) : 0;
      const bg = list.length ? (net >= 0 ? `rgba(12,163,12,${a})` : `rgba(208,59,59,${a})`) : '';
      const tipHtml = list.length ? esc(`<b>${d.toDateString()}</b><br>Net ${money(net)}<br>${list.length} trade${list.length > 1 ? 's' : ''} · ${list.filter(t => t._net > 0).length} wins`) : '';
      cells += `<div class="day ${d.getMonth() !== mo ? 'out' : ''} ${S.selDay === k ? 'sel' : ''}" data-day="${k}" style="${bg ? 'background:' + bg : ''}" ${tipHtml ? `data-tip="${tipHtml}"` : ''}>
        <div class="d">${d.getDate()}</div>${S.days[k] ? '<span class="note-dot" title="Has notes"></span>' : ''}
        ${list.length ? `<div class="p">${money(net)}</div><div class="n">${list.length} trade${list.length > 1 ? 's' : ''}</div>` : ''}</div>`;
      d.setDate(d.getDate() + 1);
    }
    cells += `<div class="wk">${wkN ? `<div class="${cls(wkNet)}">${money(wkNet)}</div><div class="muted">${wkN} trades</div>` : ''}</div>`;
    if (d.getMonth() !== mo && w >= 3) break;
  }
  el.innerHTML = `<div class="cal-head"><button class="btn ghost" id="calPrev">‹</button><h2>${m0.toLocaleString('en-GB', { month: 'long', year: 'numeric' })}</h2>
      <button class="btn ghost" id="calNext">›</button><button class="btn ghost" id="calToday">Today</button><div class="grow"></div>
      <span>Month: <b class="${cls(monthNet)}">${money(monthNet)}</b> <span class="muted">· ${monthN} trades</span></span></div>
    <div class="cal-layout"><div class="cal">${cells}</div><div class="daypanel" id="dayPanel"></div></div>`;
  $('calPrev').onclick = () => { S.calMonth = new Date(y, mo - 1, 1); renderCalendar(); };
  $('calNext').onclick = () => { S.calMonth = new Date(y, mo + 1, 1); renderCalendar(); };
  $('calToday').onclick = () => { const n = new Date(); S.calMonth = new Date(n.getFullYear(), n.getMonth(), 1); S.selDay = dayKey(n); renderCalendar(); };
  el.querySelectorAll('.day').forEach(c => c.onclick = () => { S.selDay = c.dataset.day; renderCalendar(); });
  renderDayPanel(byDay);
}
function renderDayPanel(byDay) {
  const p = $('dayPanel'), k = S.selDay || dayKey(new Date());
  const list = byDay.get(k) || [], net = list.reduce((a, t) => a + t._net, 0);
  p.innerHTML = `<h3>${new Date(k + 'T12:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h3>
    ${list.length ? `<div>Net <b class="${cls(net)}">${money(net)}</b> · ${list.length} trade${list.length > 1 ? 's' : ''}</div>` : '<div class="muted">No trades this day</div>'}
    <div class="tlist">${list.map(t => `<div data-id="${t.id}"><span>${esc(t.symbol)} ${t.side === 'sell' ? 'short' : 'long'} · ${esc(t.setup || '')}</span><span class="${cls(t._net)}">${money(t._net)}</span></div>`).join('')}</div>
    <label class="muted">Day notes: plan, mood, lessons</label>
    <textarea id="dayNotes" rows="9" placeholder="Pre-market plan, news, how I felt, what I learned…">${esc(S.days[k] || '')}</textarea>
    <div style="margin-top:8px;display:flex;gap:8px"><button class="btn primary" id="saveDay">Save notes</button><span id="daySaved" class="muted"></span></div>`;
  p.querySelectorAll('.tlist div').forEach(r => r.onclick = () => openForm(S.trades.find(t => t.id == r.dataset.id)));
  $('saveDay').onclick = async () => {
    const notes = $('dayNotes').value;
    await api('days/' + k, jsonOpts('PUT', { notes }));
    if (notes.trim()) S.days[k] = notes; else delete S.days[k];
    $('daySaved').textContent = 'Saved'; setTimeout(renderCalendar, 600);
  };
}

/* ---------- settings ---------- */
function renderSettings() {
  const s = S.settings;
  $('view-settings').innerHTML = `<div class="settings">
    <div class="card"><h3>Account</h3><div class="sub">Used for the balance chart and drawdown %</div>
      <label>Starting balance <input id="setBal" type="number" step="any" value="${s.start_balance}"></label>
      <label>Currency symbol <input id="setCur" value="${esc(s.currency)}"></label>
      <label>MT5 server time offset from UTC (hours) <input id="setOff" type="number" step="0.5" value="${s.mt5_offset_hours}"></label>
      <p class="muted">Exness servers run on UTC (0). Many other brokers use UTC+2 or UTC+3.</p></div>
    <div class="card"><h3>Your setups</h3><div class="sub">One per line, shown in the trade form</div>
      <label><textarea id="setSetups" rows="9">${esc(s.setups.join('\n'))}</textarea></label></div>
    <div class="card"><h3>Mistake tags</h3><div class="sub">One per line</div>
      <label><textarea id="setMist" rows="9">${esc(s.mistakes.join('\n'))}</textarea></label></div>
    <div class="card"><h3>Emotions</h3><div class="sub">One per line</div>
      <label><textarea id="setEmo" rows="9">${esc(s.emotions.join('\n'))}</textarea></label></div>
    <div class="card"><h3>Contract sizes</h3><div class="sub">Used to work out P&amp;L when you leave it blank. SYMBOL = units per lot</div>
      <label><textarea id="setCon" rows="9">${esc(Object.entries(s.contracts).map(([k, v]) => `${k} = ${v}`).join('\n'))}</textarea></label></div>
  </div><div style="margin-top:14px"><button class="btn primary" id="saveSettings">Save settings</button></div>`;
  const lines = id => $(id).value.split('\n').map(x => x.trim()).filter(Boolean);
  $('saveSettings').onclick = async () => {
    const contracts = {};
    for (const l of lines('setCon')) { const [k, v] = l.split('=').map(x => x.trim()); if (k && +v > 0) contracts[k.toUpperCase()] = +v; }
    S.settings = await api('settings', jsonOpts('PUT', {
      start_balance: +$('setBal').value || 0, currency: $('setCur').value || '$', mt5_offset_hours: +$('setOff').value || 0,
      setups: lines('setSetups'), mistakes: lines('setMist'), emotions: lines('setEmo'), contracts }));
    toast('Settings saved'); refreshFilterOptions();
  };
}

/* ---------- trade form ---------- */
const form = $('tradeForm');
let formImages = [], formMistakes = new Set(), formPlan = '', formRating = 0;
function openForm(t) {
  S.editing = t || null;
  form.reset();
  $('formTitle').textContent = t ? `${t.symbol} ${t.side === 'sell' ? 'short' : 'long'} · ${fmtDate(t.open_time)}` : 'New trade';
  $('delBtn').classList.toggle('hidden', !t);
  $('setupSel').innerHTML = '<option value="">—</option>' + [...new Set([...S.settings.setups, ...(t && t.setup ? [t.setup] : [])])].map(s => `<option>${esc(s)}</option>`).join('');
  document.querySelectorAll('.emoSel').forEach(sel => sel.innerHTML = '<option value="">—</option>' + S.settings.emotions.map(s => `<option>${esc(s)}</option>`).join(''));
  const v = t || { side: 'buy', account: localStorage.getItem('gj_lastAccount') || '', open_time: new Date().toISOString() };
  for (const el of form.elements) {
    if (!el.name) continue;
    const val = v[el.name];
    if (el.type === 'datetime-local') el.value = toLocalInput(val);
    else if (val != null) el.value = val;
  }
  if (t && t.emotion_before && ![...form.emotion_before.options].some(o => o.value === t.emotion_before)) form.emotion_before.add(new Option(t.emotion_before));
  if (t && t.emotion_after && ![...form.emotion_after.options].some(o => o.value === t.emotion_after)) form.emotion_after.add(new Option(t.emotion_after));
  if (t) { form.emotion_before.value = t.emotion_before || ''; form.emotion_after.value = t.emotion_after || ''; }
  formImages = [...(v.images || [])]; formMistakes = new Set(v.mistakes || []); formPlan = v.plan_followed || ''; formRating = v.rating || 0;
  renderChips(); renderPlan(); renderStars(); renderShots(); updateHint();
  $('modal').classList.remove('hidden');
  (t ? form.notes : form.symbol).focus();
}
function closeModals() { document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); }
function renderChips() {
  const all = [...new Set([...S.settings.mistakes, ...formMistakes])];
  $('mistakeChips').innerHTML = all.map(m => `<button type="button" class="${formMistakes.has(m) ? 'on' : ''}">${esc(m)}</button>`).join('');
  $('mistakeChips').querySelectorAll('button').forEach((b, i) => b.onclick = () => { formMistakes.has(all[i]) ? formMistakes.delete(all[i]) : formMistakes.add(all[i]); renderChips(); });
}
function renderPlan() { $('planSeg').querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.v === formPlan); b.onclick = () => { formPlan = formPlan === b.dataset.v ? '' : b.dataset.v; renderPlan(); }; }); }
function renderStars() {
  $('stars').innerHTML = [1, 2, 3, 4, 5].map(i => `<button type="button" class="${i <= formRating ? 'on' : ''}" title="${i}/5">★</button>`).join('');
  $('stars').querySelectorAll('button').forEach((b, i) => b.onclick = () => { formRating = formRating === i + 1 ? 0 : i + 1; renderStars(); });
}
function renderShots() {
  $('shots').innerHTML = formImages.map((n, i) => `<div class="shot"><img src="data/images/${encodeURIComponent(n)}" data-i="${i}"><button type="button" data-rm="${i}" title="Remove">✕</button></div>`).join('')
    || '<span class="muted" style="padding:16px">Paste a chart screenshot here with Ctrl+V</span>';
}
$('shots').addEventListener('click', e => {
  if (e.target.dataset.rm != null) { formImages.splice(+e.target.dataset.rm, 1); renderShots(); }
  else if (e.target.tagName === 'IMG') { $('lightbox').querySelector('img').src = e.target.src; $('lightbox').classList.remove('hidden'); }
});
async function uploadImages(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try { const { name } = await api('images', { method: 'POST', headers: { 'Content-Type': f.type }, body: f }); formImages.push(name); }
    catch (e) { toast('Image upload failed: ' + e.message); }
  }
  renderShots();
}
document.addEventListener('paste', e => {
  if ($('modal').classList.contains('hidden')) return;
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); uploadImages(files); }
});
$('imgFile').onchange = e => { uploadImages([...e.target.files]); e.target.value = ''; };
['dragover', 'dragleave', 'drop'].forEach(ev => $('shots').addEventListener(ev, e => {
  e.preventDefault(); $('shots').classList.toggle('drag', ev === 'dragover');
  if (ev === 'drop') uploadImages([...e.dataTransfer.files]);
}));

function formValues() {
  const f = form.elements, g = n => f[n].value.trim();
  const t = {
    account: g('account'), symbol: g('symbol').toUpperCase(), side: g('side'), lots: num(g('lots')),
    open_time: fromLocalInput(g('open_time')), close_time: fromLocalInput(g('close_time')),
    entry: num(g('entry')), exit: num(g('exit')), sl: num(g('sl')), tp: num(g('tp')), exit_reason: g('exit_reason'),
    pnl: num(g('pnl')), fees: num(g('fees')) || 0, timeframe: g('timeframe'), setup: g('setup'),
    emotion_before: g('emotion_before'), emotion_after: g('emotion_after'), notes: f.notes.value,
    mistakes: [...formMistakes], plan_followed: formPlan, rating: formRating, images: formImages,
  };
  return t;
}
function autoPnl(t) {
  const c = S.settings.contracts?.[t.symbol];
  if (t.pnl != null || t.exit == null || t.entry == null || !t.lots || !c) return null;
  return Math.round((t.exit - t.entry) * (t.side === 'sell' ? -1 : 1) * t.lots * c * 100) / 100;
}
function updateHint() {
  const t = formValues(), parts = [];
  const auto = autoPnl(t);
  if (auto != null) parts.push(`P&L will be saved as ${money(auto)} (${t.lots} lots × ${S.settings.contracts[t.symbol]} per lot).`);
  else if (t.pnl == null && t.exit != null && !S.settings.contracts?.[t.symbol]) parts.push(`Enter the P&L, or add ${t.symbol || 'this symbol'}'s contract size in Settings to calculate it.`);
  const e = enrich({ ...t, pnl: t.pnl ?? auto });
  if (e._r != null) parts.push(`Result: ${fmtR(e._r)}`);
  if (t.sl != null && t.tp != null && t.entry != null && t.sl !== t.entry) parts.push(`Planned reward:risk ${(Math.abs(t.tp - t.entry) / Math.abs(t.entry - t.sl)).toFixed(2)}`);
  $('calcHint').textContent = parts.join(' · ');
}
form.addEventListener('input', updateHint);
form.onsubmit = async e => {
  e.preventDefault();
  const t = formValues();
  if (t.pnl == null) t.pnl = autoPnl(t);
  if (t.close_time && t.open_time && t.close_time < t.open_time) return toast('Close time is before open time');
  const base = S.editing ? { ...S.editing } : { source: 'manual' };
  const merged = { ...base, ...t };
  delete merged.id;
  if (S.editing) await api('trades/' + S.editing.id, jsonOpts('PUT', merged));
  else await api('trades', jsonOpts('POST', merged));
  try { localStorage.setItem('gj_lastAccount', t.account); } catch { /* storage unavailable */ }
  closeModals(); await refresh(); toast('Trade saved');
};
$('delBtn').onclick = async () => {
  if (!S.editing || !confirm('Delete this trade and its screenshots? This cannot be undone.')) return;
  await api('trades/' + S.editing.id, { method: 'DELETE' });
  closeModals(); await refresh(); toast('Trade deleted');
};

/* ---------- imports ---------- */
$('importBtn').onclick = e => { e.stopPropagation(); $('importMenu').classList.toggle('hidden'); };
document.addEventListener('click', () => $('importMenu').classList.add('hidden'));
$('impMt5').onclick = () => { $('mt5Msg').textContent = ''; $('mt5Modal').classList.remove('hidden'); };
$('mt5Go').onclick = async () => {
  $('mt5Go').disabled = true; $('mt5Msg').textContent = 'Importing…';
  try {
    const r = await api('import/mt5', jsonOpts('POST', { days: +$('mt5Days').value }));
    $('mt5Msg').innerHTML = `<b>${r.added}</b> new trades imported from ${esc(r.account)}${r.skipped ? `, ${r.skipped} already in your journal` : ''}.`;
    await refresh();
  } catch (err) { $('mt5Msg').textContent = err.message; }
  $('mt5Go').disabled = false;
};
$('impCsv').onclick = () => $('csvFile').click();
$('csvFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const r = await api('import/csv', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await f.text() });
    toast(`${r.added} backtest trades imported${r.skipped ? `, ${r.skipped} already there` : ''}`); await refresh();
  } catch (err) { alert(err.message); }
};

/* ---------- shell ---------- */
document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModals);
document.querySelectorAll('.modal').forEach(m => m.addEventListener('mousedown', e => { if (e.target === m) closeModals(); }));
$('lightbox').onclick = () => $('lightbox').classList.add('hidden');
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (!$('lightbox').classList.contains('hidden')) $('lightbox').classList.add('hidden'); else closeModals(); }
});
$('newBtn').onclick = () => openForm(null);
$('tabs').onclick = e => { const b = e.target.closest('button'); if (b) setView(b.dataset.view); };
function setView(v) {
  S.view = v;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('hidden', s.id !== 'view-' + v));
  $('filters').classList.toggle('hidden', v === 'settings');
  render();
  try { localStorage.setItem('gj_view', v); } catch { /* storage unavailable */ }
}
function render() {
  const n = filtered().length;
  $('fCount').textContent = S.trades.length ? `${n} of ${S.trades.length} trades` : '';
  ({ dashboard: renderDashboard, journal: renderJournal, calendar: renderCalendar, settings: renderSettings })[S.view]();
}
['fPeriod', 'fFrom', 'fTo', 'fAccount', 'fSymbol', 'fSetup', 'fSide'].forEach(id => $(id).addEventListener('change', () => {
  $('fCustom').classList.toggle('hidden', $('fPeriod').value !== 'custom'); render();
}));
let toastT;
function toast(msg) { const el = $('toast'); el.textContent = msg; el.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 2600); }
async function refresh() { await loadAll(); refreshFilterOptions(); render(); }

(async () => {
  try { await refresh(); }
  catch {
    document.body.innerHTML = '<p style="padding:30px">Start Ghost Journal with <code>start.bat</code> (or <code>python server.py</code>) and open http://localhost:8766.</p>';
    return;
  }
  let v = 'dashboard'; try { v = localStorage.getItem('gj_view') || v; } catch { /* storage unavailable */ }
  setView(v);
})();
