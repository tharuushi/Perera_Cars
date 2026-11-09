import { LocalStore, FirebaseStore } from './store.js';
import { FIREBASE_CONFIG } from './firebase-config.js';

/* ---------- constants ---------- */
const CATS = {
  // 'Oil change' is saved as its own type so oil costs and the oil reminder stay separate.
  expense: ['Fuel', 'Oil change', 'Repair', 'Service', 'Tyres', 'Parts', 'Insurance', 'Licence', 'Wash', 'Driver', 'Other'],
  income: ['Wedding hire', 'Photoshoot', 'Airport hire', 'Normal hire', 'Other'],
};
const TYPE_LABEL = { income: 'Income', expense: 'Expense', oil: 'Oil change' };

/* ---------- prefs (per phone) ---------- */
const PREF_KEY = 'carledger.prefs.v1';
let prefs = { userName: '', oilInterval: 5000 };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) { /* ignore */ }
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } }

/* ---------- state ---------- */
let store;
let data = { cars: [], records: [] };
let auth = { signedIn: false };
let ready = false;
const ui = { carFilter: 'all', carMonth: thisMonth(), repMonth: thisMonth(), repCar: 'all' };

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const kmf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
function money(n, signed = false) {
  n = Number(n) || 0;
  const s = 'Rs ' + nf.format(Math.abs(n));
  if (n < 0) return '-' + s;
  return signed && n > 0 ? '+' + s : s;
}
function today() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function thisMonth() { return today().slice(0, 7); }
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtMonth(m) {
  const d = new Date(m + '-01T00:00:00');
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}
function num(v) { if (v === '' || v == null) return null; const n = parseFloat(String(v).replace(/,/g, '')); return isNaN(n) ? null : n; }
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2200);
}
const carById = id => data.cars.find(c => c.id === id);
const carsSorted = () => [...data.cars].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
const sortRecs = rs => [...rs].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));

function totals(recs) {
  const t = { income: 0, expense: 0, oil: 0, litres: 0 };
  recs.forEach(r => { t[r.type] += Number(r.amount) || 0; if (r.litres) t.litres += Number(r.litres) || 0; });
  t.profit = t.income - t.expense - t.oil;
  return t;
}
function oilStatus(carId) {
  const recs = data.records.filter(r => r.carId === carId);
  const oils = recs.filter(r => r.type === 'oil').sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.odometer || 0) - (a.odometer || 0));
  const last = oils[0];
  const odos = recs.map(r => Number(r.odometer) || 0).filter(Boolean);
  const latestOdo = odos.length ? Math.max(...odos) : null;
  if (!last) return { none: true, latestOdo };
  const nextDue = last.nextDueKm || (last.odometer ? Number(last.odometer) + Number(prefs.oilInterval || 5000) : null);
  const dueIn = nextDue != null && latestOdo != null ? nextDue - latestOdo : null;
  return { last, nextDue, latestOdo, dueIn };
}

/* ---------- routing ---------- */
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [tab, id] = h.split('/');
  if (tab === 'car' && id) return { tab: 'cars', carId: id };
  if (tab === 'reports' || tab === 'settings') return { tab };
  return { tab: 'cars' };
}
window.addEventListener('hashchange', () => { closeSheet(); render(); window.scrollTo(0, 0); });

/* ---------- render ---------- */
function topbar(title, { back = false, right = '' } = {}) {
  const sync = store?.mode === 'cloud' && auth.signedIn
    ? `<span class="sync">${navigator.onLine ? (data.pending ? '⏳ syncing' : '☁️ synced') : '📴 offline'}</span>` : '';
  $('#topbar').innerHTML =
    (back ? `<button class="icon-btn" id="back" aria-label="Back">‹</button>` : `<img class="logo" src="icons/logo.png" alt="">`) +
    `<h1>${esc(title)}</h1>${sync}${right}`;
  if (back) $('#back').onclick = () => (location.hash = '#/cars');
}

function render() {
  const r = route();
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === r.tab));
  const loggedOut = store?.mode === 'cloud' && !auth.signedIn;
  $('#tabs').hidden = loggedOut || !ready;
  $('#fab').hidden = loggedOut || !ready || r.tab === 'settings';
  if (!ready) { topbar('Perera Cars'); $('#view').innerHTML = '<div class="empty">Loading…</div>'; return; }
  if (loggedOut) return renderLogin();
  if (r.carId) return renderCar(r.carId);
  if (r.tab === 'reports') return renderReports();
  if (r.tab === 'settings') return renderSettings();
  renderCars();
}

/* Cars list: car name (register number) only */
function renderCars() {
  topbar('Perera Cars');
  const cars = carsSorted();
  const banner = store.mode === 'local'
    ? `<div class="banner">Local mode: records are saved only on this phone. Add your Firebase settings to sync between phones (see README).</div>` : '';
  $('#view').innerHTML = banner + (cars.length ? '' : `<div class="empty"><div class="big">🚗</div>No cars yet. Add your first car.</div>`) +
    `<div class="list">${cars.map(c => `
      <button class="car-row" data-id="${esc(c.id)}">
        <span class="emoji">🚗</span><span class="name">${esc(c.reg)}</span><span class="chev">›</span>
      </button>`).join('')}
      <button class="add-car" id="add-car">＋ Add car</button>
    </div>
    ${cars.length ? '<p class="empty" style="padding:14px 0;font-size:13px">Tip: press and hold a car to rename it.</p>' : ''}`;
  $('#add-car').onclick = () => carSheet();
  document.querySelectorAll('.car-row').forEach(btn => {
    let timer, long = false;
    const start = () => { long = false; timer = setTimeout(() => { long = true; carSheet(carById(btn.dataset.id)); }, 550); };
    const cancel = () => clearTimeout(timer);
    btn.addEventListener('touchstart', start, { passive: true });
    btn.addEventListener('touchend', cancel);
    btn.addEventListener('touchmove', cancel, { passive: true });
    btn.addEventListener('mousedown', start);
    btn.addEventListener('mouseup', cancel);
    btn.addEventListener('mouseleave', cancel);
    btn.addEventListener('contextmenu', e => e.preventDefault());
    btn.onclick = () => { if (!long) location.hash = '#/car/' + btn.dataset.id; };
  });
}

/* Car detail */
function renderCar(id) {
  const car = carById(id);
  if (!car) { topbar('Car', { back: true }); $('#view').innerHTML = '<div class="empty">This car was deleted.</div>'; return; }
  topbar(car.reg, { back: true, right: `<button class="icon-btn" id="rename" aria-label="Rename">✎</button>` });
  $('#rename').onclick = () => carSheet(car);

  const all = data.records.filter(r => r.carId === id);
  const inMonth = ui.carMonth ? all.filter(r => (r.date || '').startsWith(ui.carMonth)) : all;
  const t = totals(inMonth);
  const shown = sortRecs(ui.carFilter === 'all' ? inMonth : inMonth.filter(r => r.type === ui.carFilter));
  const o = oilStatus(id);

  let oilHtml;
  if (o.none) {
    oilHtml = `<div class="card oil-box"><span class="big">🛢️</span><div><div class="t">No oil change recorded</div><div class="s">Add one with the + button.</div></div></div>`;
  } else {
    const overdue = o.dueIn != null && o.dueIn <= 0;
    const main = o.dueIn == null
      ? (o.nextDue ? `Next oil change at ${kmf.format(o.nextDue)} km` : 'Last oil change ' + fmtDate(o.last.date))
      : overdue ? `Oil change OVERDUE by ${kmf.format(-o.dueIn)} km` : `Oil change due in ${kmf.format(o.dueIn)} km`;
    const sub = [
      'Last: ' + fmtDate(o.last.date) + (o.last.odometer ? ' at ' + kmf.format(o.last.odometer) + ' km' : ''),
      o.nextDue ? 'next at ' + kmf.format(o.nextDue) + ' km' : '',
      o.latestOdo ? 'odometer now ' + kmf.format(o.latestOdo) + ' km' : '',
    ].filter(Boolean).join(' · ');
    oilHtml = `<div class="card oil-box ${overdue ? 'overdue' : ''}"><span class="big">🛢️</span><div><div class="t ${overdue ? 'expense' : ''}">${main}</div><div class="s">${sub}</div></div></div>`;
  }

  const groups = {};
  shown.forEach(r => (groups[r.date] ||= []).push(r));

  $('#view').innerHTML = `
    <div class="toolbar">
      <div class="chips">
        <button class="chip ${ui.carMonth ? 'on' : ''}" data-m="month">Month</button>
        <button class="chip ${!ui.carMonth ? 'on' : ''}" data-m="all">All time</button>
      </div>
      ${ui.carMonth ? `<input type="month" class="mini" id="car-month" value="${ui.carMonth}">` : ''}
    </div>
    <div class="summary">
      <div class="card stat"><div class="label">Income</div><div class="value income">${money(t.income)}</div></div>
      <div class="card stat"><div class="label">Expenses</div><div class="value expense">${money(t.expense)}</div></div>
      <div class="card stat"><div class="label">Oil changes</div><div class="value oil">${money(t.oil)}</div></div>
      <div class="card stat"><div class="label">${t.profit < 0 ? 'Loss' : 'Profit'}</div><div class="value ${t.profit < 0 ? 'expense' : 'income'}">${money(t.profit, true)}</div></div>
      ${t.litres ? `<div class="card stat full"><div class="label">Fuel</div><div class="value">${nf.format(t.litres)} litres</div></div>` : ''}
    </div>
    ${oilHtml}
    <div class="chips" style="margin-bottom:6px">
      ${['all', 'income', 'expense', 'oil'].map(f => `<button class="chip ${ui.carFilter === f ? 'on' : ''}" data-f="${f}">${f === 'all' ? 'All' : TYPE_LABEL[f]}</button>`).join('')}
    </div>
    ${shown.length ? Object.keys(groups).map(d => `<div class="day-head">${fmtDate(d)}</div>` + groups[d].map(recRow).join('')).join('')
      : `<div class="empty">No records ${ui.carMonth ? 'in ' + fmtMonth(ui.carMonth) : 'yet'}.</div>`}
    <div style="margin-top:28px"><button class="btn danger" id="del-car">Delete this car</button></div>`;

  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { ui.carFilter = b.dataset.f; render(); });
  document.querySelectorAll('[data-m]').forEach(b => b.onclick = () => { ui.carMonth = b.dataset.m === 'all' ? '' : (ui.carMonth || thisMonth()); render(); });
  const mi = $('#car-month'); if (mi) mi.onchange = () => { ui.carMonth = mi.value || thisMonth(); render(); };
  document.querySelectorAll('.rec').forEach(b => b.onclick = () => recordSheet({ record: data.records.find(r => r.id === b.dataset.id) }));
  $('#del-car').onclick = async () => {
    if (!confirm(`Delete ${car.reg} and all ${all.length} of its records? This cannot be undone.`)) return;
    await store.deleteCar(id); toast('Car deleted'); location.hash = '#/cars';
  };
}

function recRow(r) {
  const sign = r.type === 'income' ? '+' : '-';
  const bits = [];
  if (r.litres) bits.push(nf.format(r.litres) + ' L');
  if (r.odometer) bits.push(kmf.format(r.odometer) + ' km');
  if (r.type === 'oil' && r.nextDueKm) bits.push('next ' + kmf.format(r.nextDueKm) + ' km');
  if (r.note) bits.push(r.note);
  if (r.by) bits.push('by ' + r.by);
  return `<button class="rec" data-id="${esc(r.id)}">
    <span class="dot ${r.type}"></span>
    <span class="mid"><div class="cat">${esc(r.type === 'oil' ? 'Oil change' : (r.category || TYPE_LABEL[r.type]))}</div>
    ${bits.length ? `<div class="sub">${esc(bits.join(' · '))}</div>` : ''}</span>
    <span class="amt ${r.type}">${sign}${money(r.amount)}</span></button>`;
}

/* Reports */
function renderReports() {
  topbar('Reports');
  const cars = carsSorted();
  const m = ui.repMonth || thisMonth();
  const scope = ui.repCar === 'all' ? data.records : data.records.filter(r => r.carId === ui.repCar);
  const monthRecs = data.records.filter(r => (r.date || '').startsWith(m));

  const rows = cars.map(c => ({ c, t: totals(monthRecs.filter(r => r.carId === c.id)) }));
  const tot = totals(monthRecs);

  // expense by category (selected scope, month)
  const byCat = {};
  scope.filter(r => (r.date || '').startsWith(m) && r.type !== 'income').forEach(r => {
    const k = r.type === 'oil' ? 'Oil change' : (r.category || 'Other');
    byCat[k] = (byCat[k] || 0) + (Number(r.amount) || 0);
  });

  // last 12 months
  const months = [];
  const d = new Date(m + '-01T00:00:00');
  for (let i = 0; i < 12; i++) { months.push(d.getFullYear() + '-' + pad(d.getMonth() + 1)); d.setMonth(d.getMonth() - 1); }
  const monthRows = months.map(mm => ({ mm, t: totals(scope.filter(r => (r.date || '').startsWith(mm))) }));

  $('#view').innerHTML = `
    <div class="field"><label>Month</label><input type="month" id="rep-month" value="${m}"></div>
    <div class="section-title">${fmtMonth(m)}: all cars</div>
    <div class="card table-wrap"><table class="report">
      <tr><th>Car</th><th>Income</th><th>Expense</th><th>Oil</th><th>Profit</th></tr>
      ${rows.map(({ c, t }) => `<tr><td>${esc(c.reg)}</td><td>${nf.format(t.income)}</td><td>${nf.format(t.expense)}</td><td>${nf.format(t.oil)}</td><td class="${t.profit < 0 ? 'expense' : 'income'}">${nf.format(t.profit)}</td></tr>`).join('')}
      <tr class="total"><td>Total</td><td>${nf.format(tot.income)}</td><td>${nf.format(tot.expense)}</td><td>${nf.format(tot.oil)}</td><td class="${tot.profit < 0 ? 'expense' : 'income'}">${nf.format(tot.profit)}</td></tr>
    </table></div>
    <p style="font-size:12px;color:var(--muted);margin:6px 4px">Amounts in Rs (LKR).</p>

    <div class="field" style="margin-top:18px"><label>Show for</label>
      <select id="rep-car"><option value="all">All cars</option>${cars.map(c => `<option value="${esc(c.id)}" ${ui.repCar === c.id ? 'selected' : ''}>${esc(c.reg)}</option>`).join('')}</select>
    </div>

    <div class="section-title">Spending by category: ${fmtMonth(m)}</div>
    <div class="card table-wrap"><table class="report">
      ${Object.keys(byCat).length ? Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${money(v)}</td></tr>`).join('')
        : '<tr><td style="color:var(--muted)">No spending this month</td><td></td></tr>'}
    </table></div>

    <div class="section-title">Last 12 months</div>
    <div class="card table-wrap"><table class="report">
      <tr><th>Month</th><th>Income</th><th>Costs</th><th>Profit</th></tr>
      ${monthRows.map(({ mm, t }) => `<tr><td>${new Date(mm + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })}</td><td>${nf.format(t.income)}</td><td>${nf.format(t.expense + t.oil)}</td><td class="${t.profit < 0 ? 'expense' : 'income'}">${nf.format(t.profit)}</td></tr>`).join('')}
    </table></div>`;
  $('#rep-month').onchange = e => { ui.repMonth = e.target.value || thisMonth(); render(); };
  $('#rep-car').onchange = e => { ui.repCar = e.target.value; render(); };
}

/* Settings */
function renderSettings() {
  topbar('Settings');
  const cloud = store.mode === 'cloud';
  $('#view').innerHTML = `
    ${cloud ? '' : '<div class="banner">Local mode: data is on this phone only. Use Backup to keep a copy.</div>'}
    <div class="section-title">This phone</div>
    <div class="card" style="padding:14px 16px">
      <div class="field"><label>Your name <span class="opt">(shown as "added by" on records)</span></label><input id="p-name" value="${esc(prefs.userName)}" placeholder="e.g. Kasun"></div>
      <div class="field" style="margin:0"><label>Default oil change interval (km)</label><input id="p-oil" inputmode="numeric" value="${esc(prefs.oilInterval)}"></div>
    </div>

    <div class="section-title">Data</div>
    <div class="card settings">
      <button class="item" id="s-backup"><span class="ic">💾</span><span class="tx">Backup<small>Save all cars and records to a file</small></span></button>
      <button class="item" id="s-restore"><span class="ic">♻️</span><span class="tx">Restore<small>Load a backup file. This replaces all current data.</small></span></button>
      <button class="item" id="s-csv"><span class="ic">📄</span><span class="tx">Export to Excel (CSV)<small>All records as a spreadsheet</small></span></button>
    </div>
    <input type="file" id="restore-file" accept=".json,application/json" hidden>

    ${cloud ? `
    <div class="section-title">Account</div>
    <div class="card settings">
      <div class="item"><span class="ic">👤</span><span class="tx">Signed in<small>${esc(auth.email || '')}</small></span></div>
      <button class="item danger" id="s-out"><span class="ic">🚪</span><span class="tx">Sign out</span></button>
    </div>` : ''}
    <p class="empty" style="font-size:12px;padding:18px 0">Perera Cars · ${data.cars.length} cars · ${data.records.length} records · ${cloud ? 'cloud sync' : 'local mode'}</p>`;

  $('#p-name').onchange = e => { prefs.userName = e.target.value.trim(); savePrefs(); toast('Saved'); };
  $('#p-oil').onchange = e => { prefs.oilInterval = num(e.target.value) || 5000; savePrefs(); toast('Saved'); };
  $('#s-backup').onclick = () => {
    const payload = { app: 'perera-cars', version: 1, exportedAt: new Date().toISOString(), cars: data.cars, records: data.records };
    shareFile(`perera-cars-backup-${today()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  };
  $('#s-restore').onclick = () => $('#restore-file').click();
  $('#restore-file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!Array.isArray(d.cars) || !Array.isArray(d.records)) throw new Error('Not a Perera Cars backup');
      if (!confirm(`Restore ${d.cars.length} cars and ${d.records.length} records? Current data will be replaced${cloud ? ' on ALL phones' : ''}.`)) return;
      await store.replaceAll(d); toast('Restored');
    } catch (err) { alert('Could not restore: ' + err.message); }
    e.target.value = '';
  };
  $('#s-csv').onclick = () => {
    const head = ['Date', 'Car', 'Type', 'Category', 'Amount (Rs)', 'Litres', 'Odometer (km)', 'Next oil due (km)', 'Note', 'Added by'];
    const q = v => { v = v ?? ''; v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const lines = [head.join(',')].concat(sortRecs(data.records).reverse().map(r => [
      r.date, carById(r.carId)?.reg || '(deleted)', TYPE_LABEL[r.type], r.type === 'oil' ? 'Oil change' : r.category,
      r.amount, r.litres, r.odometer, r.nextDueKm, r.note, r.by].map(q).join(',')));
    shareFile(`perera-cars-${today()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv');
  };
  if (cloud) $('#s-out').onclick = async () => { if (confirm('Sign out?')) await store.signOut(); };
}

async function shareFile(name, text, type) {
  const file = new File([text], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* Login (cloud mode) */
function renderLogin() {
  topbar('Perera Cars');
  $('#view').innerHTML = `
    <form class="card login" id="login">
      <img src="icons/logo.png" alt="Perera Cars" style="display:block;width:160px;margin:0 auto 10px">
      <h2>Sign in</h2>
      <p style="color:var(--muted);font-size:14px">Use the family account so all phones share the same records.</p>
      <div class="field"><label>Email</label><input id="l-email" type="email" autocomplete="username" required></div>
      <div class="field"><label>Password</label><input id="l-pw" type="password" autocomplete="current-password" required></div>
      <div class="err" id="l-err">${esc(auth.error || '')}</div>
      <button class="btn" type="submit">Sign in</button>
    </form>`;
  $('#login').onsubmit = async e => {
    e.preventDefault();
    const btn = e.target.querySelector('button'); btn.disabled = true; $('#l-err').textContent = '';
    try { await store.signIn($('#l-email').value.trim(), $('#l-pw').value); }
    catch (err) { $('#l-err').textContent = 'Sign in failed: ' + (err.code || err.message); btn.disabled = false; }
  };
}

/* ---------- bottom sheet ---------- */
function openSheet(html) {
  $('#sheet').innerHTML = '<div class="grab"></div>' + html;
  $('#sheet').hidden = false; $('#sheet-backdrop').hidden = false;
  $('#sheet').scrollTop = 0;
}
function closeSheet() { $('#sheet').hidden = true; $('#sheet-backdrop').hidden = true; $('#sheet').innerHTML = ''; }
$('#sheet-backdrop').onclick = closeSheet;

/* Add / rename car */
function carSheet(car) {
  openSheet(`
    <h2>${car ? 'Rename car' : 'Add car'}</h2>
    <form id="car-form">
      <div class="field"><label>Register number</label>
        <input id="c-reg" value="${esc(car?.reg || '')}" placeholder="e.g. CAB-1234" autocapitalize="characters" autocomplete="off" required></div>
      <button class="btn" type="submit">${car ? 'Save' : 'Add car'}</button>
      <button class="btn secondary" type="button" id="c-cancel">Cancel</button>
    </form>`);
  const inp = $('#c-reg'); setTimeout(() => inp.focus(), 50);
  $('#c-cancel').onclick = closeSheet;
  $('#car-form').onsubmit = async e => {
    e.preventDefault();
    const reg = inp.value.trim().toUpperCase();
    if (!reg) return;
    if (data.cars.some(c => c.reg === reg && c.id !== car?.id) && !confirm(reg + ' already exists. Use it anyway?')) return;
    if (car) await store.updateCar(car.id, { reg }); else await store.addCar({ reg });
    closeSheet(); toast(car ? 'Renamed to ' + reg : reg + ' added');
  };
}

/* Quick add / edit record. Type toggle at the top. */
function recordSheet({ record, carId } = {}) {
  const cars = carsSorted();
  if (!cars.length) { toast('Add a car first'); carSheet(); return; }
  const editing = !!record;
  const st = {
    type: record?.type || 'expense',
    carId: record?.carId || carId || cars[0].id,
    category: record?.category || '',
  };

  function draw() {
    const prevVals = {};
    document.querySelectorAll('#rec-form [name]').forEach(el => (prevVals[el.name] = el.value));
    const v = k => prevVals[k] ?? (record?.[k] ?? '');
    const kind = st.type === 'income' ? 'income' : 'expense';
    const cats = [...CATS[kind]];
    // keep an older category (e.g. 'Hire') selectable when editing an old record
    if (record && record.type === st.type && record.type !== 'oil' && record.category && !cats.includes(record.category)) cats.splice(cats.length - 1, 0, record.category);
    if (st.type === 'oil') st.category = 'Oil change';
    else if (!cats.includes(st.category)) st.category = cats[0];
    const showLitres = st.type === 'expense' && st.category === 'Fuel';
    const nextDefault = (() => { const o = num(v('odometer')); return o ? o + Number(prefs.oilInterval || 5000) : ''; })();

    openSheet(`
      <h2>${editing ? 'Edit record' : 'Add record'}</h2>
      <div class="seg">
        ${['income', 'expense'].map(t => `<button type="button" class="${t} ${kind === t ? 'on' : ''}" data-type="${t}">${TYPE_LABEL[t]}</button>`).join('')}
      </div>
      <form id="rec-form">
        <div class="field"><label>Car</label>
          <select id="r-car">${cars.map(c => `<option value="${esc(c.id)}" ${c.id === st.carId ? 'selected' : ''}>${esc(c.reg)}</option>`).join('')}</select></div>
        <div class="field amount"><label>Amount (Rs)</label>
          <input name="amount" inputmode="decimal" placeholder="0" value="${esc(v('amount'))}" required autocomplete="off"></div>
        <div class="field"><label>Category</label><div class="cat-chips">
          ${cats.map(c => `<button type="button" class="chip ${st.category === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div></div>
        <div class="field"><label>Date</label><input name="date" type="date" value="${esc(v('date') || today())}"></div>
        ${showLitres ? `<div class="field"><label>Litres <span class="opt">(optional)</span></label><input name="litres" inputmode="decimal" value="${esc(v('litres'))}"></div>` : ''}
        ${st.type === 'oil' ? `
          <div class="row2">
            <div class="field"><label>Odometer km <span class="opt">(optional)</span></label><input name="odometer" id="r-odo" inputmode="numeric" value="${esc(v('odometer'))}"></div>
            <div class="field"><label>Next due km <span class="opt">(optional)</span></label><input name="nextDueKm" id="r-next" inputmode="numeric" value="${esc(v('nextDueKm'))}" placeholder="${nextDefault}"></div>
          </div>` : `
          <div class="field"><label>Odometer km <span class="opt">(optional)</span></label><input name="odometer" inputmode="numeric" value="${esc(v('odometer'))}"></div>`}
        <div class="field"><label>Note <span class="opt">(optional)</span></label><textarea name="note" placeholder="${st.type === 'oil' ? 'e.g. 5W-30, filter changed' : ''}">${esc(v('note'))}</textarea></div>
        <button class="btn" type="submit">${editing ? 'Save changes' : 'Save'}</button>
        ${editing ? '<button class="btn danger" type="button" id="r-del">Delete record</button>' : ''}
        <button class="btn secondary" type="button" id="r-cancel">Cancel</button>
      </form>`);

    document.querySelectorAll('[data-type]').forEach(b => b.onclick = () => { if (b.dataset.type !== kind) { st.type = b.dataset.type; st.category = ''; } draw(); });
    document.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => {
      st.category = b.dataset.cat;
      st.type = kind === 'income' ? 'income' : (st.category === 'Oil change' ? 'oil' : 'expense');
      draw();
    });
    $('#r-car').onchange = e => (st.carId = e.target.value);
    const odo = $('#r-odo');
    if (odo) odo.oninput = () => { const o = num(odo.value); $('#r-next').placeholder = o ? o + Number(prefs.oilInterval || 5000) : ''; };
    $('#r-cancel').onclick = closeSheet;
    if (editing) $('#r-del').onclick = async () => { if (confirm('Delete this record?')) { await store.deleteRecord(record.id); closeSheet(); toast('Deleted'); } };
    $('#rec-form').onsubmit = async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const amount = num(f.amount);
      if (amount == null || amount < 0) { alert('Please enter an amount'); return; }
      const rec = {
        carId: st.carId, type: st.type, amount, date: f.date || today(),
        category: st.type === 'oil' ? 'Oil change' : st.category,
        litres: showLitres ? num(f.litres) : null,
        odometer: num(f.odometer),
        nextDueKm: st.type === 'oil' ? (num(f.nextDueKm) ?? (num(f.odometer) ? num(f.odometer) + Number(prefs.oilInterval || 5000) : null)) : null,
        note: (f.note || '').trim(),
      };
      if (editing) await store.updateRecord(record.id, rec);
      else await store.addRecord({ ...rec, by: prefs.userName || '' });
      closeSheet(); toast(editing ? 'Saved' : TYPE_LABEL[st.type] + ' saved');
    };
  }
  draw();
  if (!editing) setTimeout(() => $('#rec-form [name=amount]')?.focus(), 80);
}

$('#fab').onclick = () => recordSheet({ carId: route().carId });

/* ---------- boot ---------- */
window.addEventListener('online', render);
window.addEventListener('offline', render);

async function boot() {
  render();
  if (FIREBASE_CONFIG) {
    try {
      store = new FirebaseStore(FIREBASE_CONFIG);
      await store.init();
    } catch (e) {
      console.error(e);
      $('#view').innerHTML = `<div class="empty">Could not load cloud sync. Check your internet connection the first time you open the app.<br><br><button class="btn" onclick="location.reload()">Try again</button></div>`;
      return;
    }
  } else {
    store = new LocalStore();
  }
  store.start(
    d => { data = d; ready = true; render(); },
    a => { auth = a; ready = true; render(); },
  );
}
boot();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
