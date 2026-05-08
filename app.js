const CAT_ICON_CLASS = {
  Food:'ci-food', Transport:'ci-transport', Health:'ci-health',
  Shopping:'ci-shopping', Bills:'ci-bills', Entertainment:'ci-fun', Other:'ci-other'
};

let db, selectedCat = null, currentMonth = new Date(), activeFilter = 'All';

/* ── Theme ─────────────────────────────────────────────────── */
const THEMES = { pearl:{}, slate:{}, sage:{}, pink:{} };

function setTheme(t) {
  t = ({ dark:'slate', light:'pearl', neon:'sage' })[t] || t;
  document.body.dataset.theme = t === 'pearl' ? '' : t;
  if (t === 'pearl') document.body.removeAttribute('data-theme');
  if (THEMES[t] && Object.keys(THEMES[t]).length) {
    Object.entries(THEMES[t]).forEach(([k,v]) => document.documentElement.style.setProperty(k, v));
  } else {
    ['--bg','--surface','--surface2','--border','--accent','--accent-soft','--text','--muted','--danger','--success']
      .forEach(k => document.documentElement.style.removeProperty(k));
    if (t !== 'pearl') document.body.dataset.theme = t;
  }
  document.querySelectorAll('.theme-dot').forEach(d => d.classList.toggle('active', d.dataset.t === t));
  localStorage.setItem('theme', t);
  if (fp) { fp.destroy(); initFlatpickr(); }
}

function loadTheme() {
  const t = localStorage.getItem('theme') || 'pearl';
  setTheme(t);
}

/* ── Flatpickr ─────────────────────────────────────────────── */
let fp = null;
function initFlatpickr() {
  fp = flatpickr('#f-date', {
    dateFormat: 'Y-m-d',
    defaultDate: new Date(),
    maxDate: new Date(),
    disableMobile: false,
    onChange: () => {}
  });
}


function handlesDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ExpenseHandlesDB', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeBackupHandle(handle) {
  const hdb = await handlesDB();
  return new Promise(resolve => {
    const req = hdb.transaction('handles', 'readwrite').objectStore('handles').put(handle, 'backupFile');
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
  });
}

async function getBackupHandle() {
  const hdb = await handlesDB();
  return new Promise(resolve => {
    const req = hdb.transaction('handles').objectStore('handles').get('backupFile');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  });
}

async function writeTextToHandle(handle, text) {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function hasWritePermission(handle) {
  if (!handle || !handle.queryPermission) return false;
  const opts = { mode: 'readwrite' };
  if (await handle.queryPermission(opts) === 'granted') return true;
  return await handle.requestPermission(opts) === 'granted';
}

async function writeBackupToConnectedFile(text) {
  if (!window.showSaveFilePicker) return false;
  const handle = await getBackupHandle();
  if (!handle || !await hasWritePermission(handle)) return false;
  await writeTextToHandle(handle, text);
  updateCloudSyncStatus('Last connected-file backup: ' + new Date().toLocaleString('en-IN'));
  return true;
}

async function connectBackupFile() {
  if (!window.showSaveFilePicker) {
    showToast('Connected file sync is not supported here', true);
    updateCloudSyncStatus('Not supported here. Use Save backup manually.');
    return;
  }
  const all = await getAllExpenses();
  const payload = backupPayload(all);
  const text = JSON.stringify(payload, null, 2);
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'expense_backup_connected.json',
      types: [{ description: 'JSON backup', accept: { 'application/json': ['.json'] } }]
    });
    await writeTextToHandle(handle, text);
    await storeBackupHandle(handle);
    updateCloudSyncStatus('Connected backup file ready');
    showToast('Backup file connected');
  } catch (e) {
    if (e.name !== 'AbortError') showToast('Could not connect backup file', true);
  }
}

async function writeConnectedBackup() {
  const all = await getAllExpenses();
  if (!all.length) { showToast('No data to backup', true); return; }
  const text = JSON.stringify(backupPayload(all), null, 2);
  const ok = await writeBackupToConnectedFile(text);
  if (ok) showToast('Connected backup updated');
  else showToast('Connect a backup file first', true);
}

function updateCloudSyncStatus(text) {
  const el = document.getElementById('cloud-sync-status');
  if (el) el.textContent = text;
}

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('install-app-btn');
  if (btn) btn.style.display = 'flex';
});

async function installApp() {
  if (!deferredInstallPrompt) {
    showToast('Use browser menu to install/add to home screen', true);
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

window.prepareImportBackup = prepareImportBackup;
window.connectBackupFile = connectBackupFile;
window.writeConnectedBackup = writeConnectedBackup;
window.installApp = installApp;

function setDateShortcut(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  fp && fp.setDate(d, true);
}

/* ── IndexedDB ─────────────────────────────────────────────── */
function initDB() {
  const req = indexedDB.open('ExpenseDB', 1);
  req.onupgradeneeded = e => {
    const store = e.target.result.createObjectStore('expenses', { keyPath: 'id', autoIncrement: true });
    store.createIndex('date', 'date');
  };
  req.onsuccess = e => { db = e.target.result; };
}

function tx(mode = 'readonly') { return db.transaction('expenses', mode).objectStore('expenses'); }
function getAllExpenses() { return new Promise(res => { const r = tx().getAll(); r.onsuccess = () => res(r.result); }); }

/* ── Form ──────────────────────────────────────────────────── */
function selectCat(btn) {
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  selectedCat = btn.dataset.cat;
  document.getElementById('req-badge').classList.toggle('show', selectedCat === 'Other');
}

async function saveExpense() {
  const date = fp ? fp.selectedDates[0] : null;
  const dateStr = date ? flatpickr.formatDate(date, 'Y-m-d') : '';
  const amount = parseFloat(document.getElementById('f-amount').value);
  const desc = document.getElementById('f-desc').value.trim();

  if (!dateStr) { showToast('Pick a date', true); return; }
  if (!selectedCat) { showToast('Pick a category', true); return; }
  if (!amount || amount <= 0) { showToast('Enter a valid amount', true); return; }
  if (selectedCat === 'Other' && !desc) { showToast('Description is required for Other', true); document.getElementById('f-desc').focus(); return; }

  const req = tx('readwrite').add({ date: dateStr, category: selectedCat, amount, description: desc, createdAt: Date.now() });
  req.onsuccess = async () => {
    showToast('Saved!');
    document.getElementById('f-amount').value = '';
    document.getElementById('f-desc').value = '';
    selectedCat = null;
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById('req-badge').classList.remove('show');
    fp && fp.setDate(dateStr, false);
    await autoBackup();
  };
}



/* ── Backup ─────────────────────────────────────────────────── */
function backupFileName() {
  const stamp = new Date().toISOString().slice(0,19).replace(/[T:]/g, '-');
  return `expense_backup_${stamp}.json`;
}

function backupPayload(expenses) {
  return { version:1, exportedAt: new Date().toISOString(), expenses };
}

async function saveBackupFile(payload, name = backupFileName(), preferConnected = true) {
  const text = JSON.stringify(payload, null, 2);
  if (preferConnected && await writeBackupToConnectedFile(text)) return true;
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'JSON backup', accept: { 'application/json': ['.json'] } }]
      });
      await writeTextToHandle(handle, text);
      await storeBackupHandle(handle);
      updateCloudSyncStatus('Connected backup file ready');
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
    }
  }
  dl('data:application/json;charset=utf-8,' + encodeURIComponent(text), name);
  return true;
}

async function autoBackup() {
  try {
    const all = await getAllExpenses();
    const payload = backupPayload(all);
    localStorage.setItem('expense_auto_backup', JSON.stringify(payload));
    localStorage.setItem('expense_backup_ts', new Date().toISOString());
    const saved = await saveBackupFile(payload);
    showToast(saved ? 'Backup file saved' : 'Backup cancelled');
  } catch(e) {}
}

async function exportBackup() {
  const all = await getAllExpenses();
  if (!all.length) { showToast('No data to backup', true); return; }
  const saved = await saveBackupFile(backupPayload(all), `expense_backup_${today()}.json`);
  showToast(saved ? 'Backup saved!' : 'Backup cancelled');
}

async function prepareImportBackup() {
  const ok = await showConfirm({
    title: 'Import backup?',
    message: 'Import only a backup file you trust. Existing records are kept and matching records are skipped.',
    actionText: 'Choose file'
  });
  if (ok) document.getElementById('import-file').click();
}

async function importBackup(e) {
  const file = e.target.files[0]; if (!file) return;
  let parsed;
  try { parsed = JSON.parse(await file.text()); } catch { showToast('Invalid file', true); return; }
  const incoming = parsed.expenses || parsed;
  if (!Array.isArray(incoming) || !incoming.length) { showToast('No data in file', true); return; }
  const existing = await getAllExpenses();
  const keys = new Set(existing.map(e => e.createdAt));
  const toAdd = incoming.filter(e => !keys.has(e.createdAt));
  if (!toAdd.length) { showToast('All records already exist'); return; }
  const store = tx('readwrite');
  toAdd.forEach(({ id, ...rest }) => store.add(rest));
  setTimeout(() => { showToast(`Imported ${toAdd.length} record${toAdd.length>1?'s':''}`); renderReport(); renderRecords(); renderExportStats(); }, 200);
  e.target.value = '';
}

/* ── Report ─────────────────────────────────────────────────── */
function changeMonth(dir) {
  currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + dir, 1);
  renderReport();
}

function fmt(n) { return '\u20B9 ' + Math.round(n).toLocaleString('en-IN'); }
function today() { return new Date().toISOString().slice(0,10); }

async function renderReport() {
  const all = await getAllExpenses();
  const y = currentMonth.getFullYear(), m = currentMonth.getMonth();
  const md = all.filter(e => { const d = new Date(e.date); return d.getFullYear()===y && d.getMonth()===m; });

  document.getElementById('month-label').textContent =
    currentMonth.toLocaleDateString('en-IN', { month:'long', year:'numeric' });

  const total = md.reduce((s,e)=>s+e.amount,0);
  const days = new Date(y,m+1,0).getDate();
  document.getElementById('r-total').textContent = fmt(total);
  document.getElementById('r-count').textContent = md.length;
  document.getElementById('r-avg').textContent = fmt(total/days);

  const catTotals = {};
  md.forEach(e => { catTotals[e.category] = (catTotals[e.category]||0) + e.amount; });
  const sorted = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]);
  const maxVal = sorted[0]?.[1] || 1;

  document.getElementById('cat-bars').innerHTML = sorted.length
    ? sorted.map(([cat,val]) => `
        <div class="bar-row">
          <div class="bar-label">
            <span class="bar-label-icon ${CAT_ICON_CLASS[cat]||'ci-other'}"></span>${cat}
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${(val/maxVal*100).toFixed(1)}%"></div></div>
          <div class="bar-amount">${fmt(val)}</div>
        </div>`).join('')
    : '<div class="empty">No expenses this month</div>';

  const list = [...md].sort((a,b)=>new Date(b.date)-new Date(a.date));
  document.getElementById('month-list').innerHTML = list.length ? list.map(expenseHTML).join('') : '<div class="empty">No expenses this month</div>';
}

function expenseHTML(e) {
  const d = new Date(e.date + 'T00:00:00');
  return `<div class="expense-item">
    <div class="exp-icon-wrap"><span class="exp-icon-mask ${CAT_ICON_CLASS[e.category]||'ci-other'}"></span></div>
    <div class="expense-info">
      <div class="expense-cat">${e.category}</div>
      <div class="expense-desc">${e.description||'—'}</div>
    </div>
    <div class="expense-right">
      <div class="expense-amount">${fmt(e.amount)}</div>
      <div class="expense-date">${d.toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</div>
    </div>
    <button class="expense-delete" onclick="deleteExpense(${e.id})">✕</button>
  </div>`;
}

async function renderRecords() {
  const all = await getAllExpenses();
  const cats = ['All', ...Object.keys(CAT_ICON_CLASS).filter(c => all.some(e=>e.category===c))];
  document.getElementById('filter-row').innerHTML = cats.map(c =>
    `<button class="filter-chip ${c===activeFilter?'active':''}" onclick="setFilter('${c}')">${c}</button>`
  ).join('');
  const filtered = activeFilter==='All' ? all : all.filter(e=>e.category===activeFilter);
  const sorted = [...filtered].sort((a,b)=>new Date(b.date)-new Date(a.date));
  document.getElementById('all-list').innerHTML = sorted.length ? sorted.map(expenseHTML).join('') : '<div class="empty">No records found</div>';
}

function setFilter(cat) { activeFilter = cat; renderRecords(); }

async function renderExportStats() {
  const all = await getAllExpenses();
  const total = all.reduce((s,e)=>s+e.amount,0);
  const months = new Set(all.map(e=>e.date.slice(0,7))).size;
  const lastBackup = localStorage.getItem('expense_backup_ts');
  document.getElementById('export-stats').innerHTML = `
    <div class="stat-box"><div class="s-num">${all.length}</div><div class="s-lbl">Records</div></div>
    <div class="stat-box"><div class="s-num">${fmt(total)}</div><div class="s-lbl">Total</div></div>
    <div class="stat-box"><div class="s-num">${months}</div><div class="s-lbl">Months</div></div>
    <div class="stat-box"><div class="s-num">${lastBackup ? new Date(lastBackup).toLocaleDateString('en-IN',{day:'numeric',month:'short'}) : '—'}</div><div class="s-lbl">Last backup</div></div>`;
}

function dl(href, name) { const a = document.createElement('a'); a.href = href; a.download = name; a.click(); }

async function exportExcel() {
  const all = await getAllExpenses();
  if (!all.length) { showToast('No data', true); return; }
  const data = all.sort((a,b)=>new Date(a.date)-new Date(b.date)).map(e=>({ Date:e.date, Category:e.category, Amount:e.amount, Description:e.description||'' }));
  const catT = {};
  all.forEach(e=>{ catT[e.category]=(catT[e.category]||0)+e.amount; });
  const summary = Object.entries(catT).sort((a,b)=>b[1]-a[1]).map(([cat,amt])=>({ Category:cat, 'Total Amount':amt, Count:all.filter(e=>e.category===cat).length }));
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(data); ws1['!cols'] = [{wch:12},{wch:14},{wch:12},{wch:40}];
  const ws2 = XLSX.utils.json_to_sheet(summary); ws2['!cols'] = [{wch:16},{wch:14},{wch:8}];
  XLSX.utils.book_append_sheet(wb,ws1,'Expenses'); XLSX.utils.book_append_sheet(wb,ws2,'Summary');
  XLSX.writeFile(wb, `expenses_${today()}.xlsx`);
  showToast('Excel downloaded!');
}

async function exportCSV() {
  const all = await getAllExpenses();
  if (!all.length) { showToast('No data', true); return; }
  const rows = [['Date','Category','Amount','Description'], ...all.sort((a,b)=>new Date(a.date)-new Date(b.date)).map(e=>[e.date,e.category,e.amount,e.description||''])];
  dl('data:text/csv;charset=utf-8,' + encodeURIComponent(rows.map(r=>r.map(v=>`"${v}"`).join(',')).join('\n')), `expenses_${today()}.csv`);
  showToast('CSV downloaded!');
}



function showPage(name) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  document.getElementById('nav-'+name).classList.add('active');
  if (name==='report') renderReport();
  if (name==='records') renderRecords();
  if (name==='export') renderExportStats();
}

function showToast(msg, isError=false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast' + (isError?' error':'');
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2400);
}

const DEFAULT_CATEGORIES = ['Food','Transport','Health','Shopping','Bills','Entertainment','Other'];
let monthPicker = null, pieChart = null, barChart = null;
let settings = { decimals:false, autoBackup:true };
function escapeHTML(value) { return String(value).replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch])); }
function escapeAttr(value) { return escapeHTML(value).replace(/'/g, '&#39;'); }
function getCategories() { try { const saved = JSON.parse(localStorage.getItem('expense_categories') || 'null'); return Array.isArray(saved) && saved.length ? saved : DEFAULT_CATEGORIES; } catch { return DEFAULT_CATEGORIES; } }
function saveCategories(cats) { localStorage.setItem('expense_categories', JSON.stringify(cats)); renderCategoryButtons(); renderCategoryManager(); renderRecords(); renderReport(); }
function loadSettings() { try { settings = { ...settings, ...JSON.parse(localStorage.getItem('expense_settings') || '{}') }; } catch {} }
function fmt(n) { const amount = Number(n || 0); return '\u20B9 ' + (settings.decimals ? amount.toLocaleString('en-IN', { minimumFractionDigits:2, maximumFractionDigits:2 }) : Math.round(amount).toLocaleString('en-IN')); }
function initDB() { const req = indexedDB.open('ExpenseDB', 1); req.onupgradeneeded = e => { const store = e.target.result.createObjectStore('expenses', { keyPath: 'id', autoIncrement: true }); store.createIndex('date', 'date'); }; req.onsuccess = e => { db = e.target.result; renderReport(); renderRecords(); renderExportStats(); renderCategoryManager(); }; }
function initFlatpickr() {
  fp = flatpickr('#f-date', {
    dateFormat: 'Y-m-d',
    defaultDate: new Date(),
    maxDate: new Date(),
    disableMobile: false,
    onChange: dates => syncDateShortcutActive(dates[0])
  });
  syncDateShortcutActive(fp.selectedDates[0]);
  initMonthPicker();
}
function setDateShortcut(offsetDays) { const d = new Date(); d.setDate(d.getDate() + offsetDays); fp && fp.setDate(d, true); }
function initMonthPicker() { if (monthPicker) monthPicker.destroy(); const input = document.getElementById('report-month'); if (!input || !window.monthSelectPlugin) return; monthPicker = flatpickr(input, { defaultDate: currentMonth, disableMobile: true, plugins: [new monthSelectPlugin({ shorthand:false, dateFormat:'Y-m', altFormat:'F Y' })], onChange: dates => { if (!dates[0]) return; currentMonth = new Date(dates[0].getFullYear(), dates[0].getMonth(), 1); renderReport(); } }); }
function openMonthPicker() { if (!monthPicker) initMonthPicker(); if (monthPicker) monthPicker.open(); }
function changeMonth(dir) { currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + dir, 1); if (monthPicker) monthPicker.setDate(currentMonth, false); renderReport(); }
function renderCategoryButtons() { const grid = document.getElementById('category-grid'); if (!grid) return; grid.innerHTML = getCategories().map(cat => `<button class="cat-btn ${cat === 'Other' ? 'full-row' : ''}" data-cat="${escapeAttr(cat)}" onclick="selectCat(this)"><span class="cat-icon-mask ${CAT_ICON_CLASS[cat] || 'ci-other'}"></span>${escapeHTML(cat)}</button>`).join(''); }
async function saveExpense() { const date = fp ? fp.selectedDates[0] : null; const dateStr = date ? flatpickr.formatDate(date, 'Y-m-d') : ''; const amount = parseFloat(document.getElementById('f-amount').value); const desc = document.getElementById('f-desc').value.trim(); if (!dateStr) { showToast('Pick a date', true); return; } if (!selectedCat) { showToast('Pick a category', true); return; } if (!amount || amount <= 0) { showToast('Enter a valid amount', true); return; } if (selectedCat === 'Other' && !desc) { showToast('Description is required for Other', true); document.getElementById('f-desc').focus(); return; } const req = tx('readwrite').add({ date: dateStr, category: selectedCat, amount, description: desc, createdAt: Date.now() }); req.onsuccess = async () => { showToast('Saved!'); document.getElementById('f-amount').value = ''; document.getElementById('f-desc').value = ''; document.querySelectorAll('[data-amount]').forEach(b => b.classList.remove('active')); selectedCat = null; document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('selected')); document.getElementById('req-badge').classList.remove('show'); fp && fp.setDate(dateStr, false); if (settings.autoBackup) await autoBackup(); }; }
function showConfirm({ title, message, actionText }) { return new Promise(resolve => { const modal = document.getElementById('confirm-modal'); const cancel = document.getElementById('confirm-cancel'); const ok = document.getElementById('confirm-ok'); document.getElementById('confirm-title').textContent = title; document.getElementById('confirm-message').textContent = message; ok.textContent = actionText || 'Delete'; modal.classList.add('show'); modal.setAttribute('aria-hidden', 'false'); const cleanup = result => { modal.classList.remove('show'); modal.setAttribute('aria-hidden', 'true'); cancel.onclick = ok.onclick = modal.onclick = null; resolve(result); }; cancel.onclick = () => cleanup(false); ok.onclick = () => cleanup(true); modal.onclick = e => { if (e.target === modal) cleanup(false); }; }); }
async function deleteExpense(id) { if (!await showConfirm({ title:'Delete expense?', message:'This record will be removed permanently.', actionText:'Delete' })) return; tx('readwrite').delete(id); setTimeout(() => { renderReport(); renderRecords(); renderExportStats(); }, 150); }
async function clearAllData() { if (!await showConfirm({ title:'Clear all data?', message:'Every expense record will be deleted permanently. Export a fresh JSON backup first, especially before clearing browser cache or site data.', actionText:'Clear data' })) return; tx('readwrite').clear(); localStorage.removeItem('expense_auto_backup'); setTimeout(()=>{ renderReport(); renderRecords(); renderExportStats(); showToast('Cleared'); }, 150); }
function chartColors() { return ['#7c6aff','#38bdf8','#67e8b0','#fbbf24','#fb7185','#c084fc','#94a3b8','#f97316']; }
function renderCharts(sorted) { const pieEl = document.getElementById('pie-chart'), barEl = document.getElementById('bar-chart'); if (!pieEl || !barEl || !window.Chart) return; const labels = sorted.map(([cat]) => cat), values = sorted.map(([, val]) => val), colors = chartColors(); if (pieChart) pieChart.destroy(); if (barChart) barChart.destroy(); const textColor = getComputedStyle(document.body).color; pieChart = new Chart(pieEl, { type:'pie', data:{ labels, datasets:[{ data:values, backgroundColor:colors }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ labels:{ color:textColor } } } } }); barChart = new Chart(barEl, { type:'bar', data:{ labels, datasets:[{ data:values, backgroundColor:colors, borderRadius:8 }] }, options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } }, scales:{ x:{ ticks:{ color:textColor }, grid:{ display:false } }, y:{ ticks:{ color:textColor }, grid:{ color:'rgba(128,128,128,0.18)' } } } } }); }
async function renderReport() { const all = await getAllExpenses(); const y = currentMonth.getFullYear(), m = currentMonth.getMonth(); const md = all.filter(e => { const d = new Date(e.date); return d.getFullYear()===y && d.getMonth()===m; }); document.getElementById('month-label').textContent = currentMonth.toLocaleDateString('en-IN', { month:'long', year:'numeric' }); if (monthPicker) monthPicker.setDate(currentMonth, false); const total = md.reduce((s,e)=>s+e.amount,0), days = new Date(y,m+1,0).getDate(); document.getElementById('r-total').textContent = fmt(total); document.getElementById('r-count').textContent = md.length; document.getElementById('r-avg').textContent = fmt(total/days); const catTotals = {}; md.forEach(e => { catTotals[e.category] = (catTotals[e.category]||0) + e.amount; }); const sorted = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]); const maxVal = sorted[0]?.[1] || 1; renderCharts(sorted); document.getElementById('cat-bars').innerHTML = sorted.length ? sorted.map(([cat,val]) => `<div class="bar-row"><div class="bar-label"><span class="bar-label-icon ${CAT_ICON_CLASS[cat]||'ci-other'}"></span>${escapeHTML(cat)}</div><div class="bar-track"><div class="bar-fill" style="width:${(val/maxVal*100).toFixed(1)}%"></div></div><div class="bar-amount">${fmt(val)}</div></div>`).join('') : '<div class="empty">No expenses this month</div>'; const list = [...md].sort((a,b)=>new Date(b.date)-new Date(a.date)); document.getElementById('month-list').innerHTML = list.length ? list.map(expenseHTML).join('') : '<div class="empty">No expenses this month</div>'; }
function expenseHTML(e) { const d = new Date(e.date + 'T00:00:00'); return `<div class="expense-item"><div class="exp-icon-wrap"><span class="exp-icon-mask ${CAT_ICON_CLASS[e.category]||'ci-other'}"></span></div><div class="expense-info"><div class="expense-cat">${escapeHTML(e.category)}</div><div class="expense-desc">${escapeHTML(e.description || '-')}</div></div><div class="expense-right"><div class="expense-amount">${fmt(e.amount)}</div><div class="expense-date">${d.toLocaleDateString('en-IN',{day:'numeric',month:'short'})}</div></div><button class="expense-delete" onclick="deleteExpense(${e.id})">x</button></div>`; }
async function renderRecords() { const all = await getAllExpenses(); const cats = ['All', ...getCategories().filter(c => all.some(e=>e.category===c))]; document.getElementById('filter-row').innerHTML = cats.map(c => `<button class="filter-chip ${c===activeFilter?'active':''}" onclick="setFilter('${escapeAttr(c)}')">${escapeHTML(c)}</button>`).join(''); const filtered = activeFilter==='All' ? all : all.filter(e=>e.category===activeFilter); const sorted = [...filtered].sort((a,b)=>new Date(b.date)-new Date(a.date)); document.getElementById('all-list').innerHTML = sorted.length ? sorted.map(expenseHTML).join('') : '<div class="empty">No records found</div>'; }
function showPage(name) { document.querySelectorAll('.page').forEach(p=>p.classList.remove('active')); document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active')); document.getElementById('page-'+name).classList.add('active'); document.getElementById('nav-'+name).classList.add('active'); if (name==='report') renderReport(); if (name==='records') renderRecords(); if (name==='export') renderExportStats(); if (name==='settings') renderSettings(); }
function saveSettings() { settings.decimals = document.getElementById('setting-decimals')?.checked || false; settings.autoBackup = document.getElementById('setting-autobackup')?.checked ?? true; localStorage.setItem('expense_settings', JSON.stringify(settings)); renderReport(); renderRecords(); renderExportStats(); }
function renderSettings() { document.getElementById('setting-decimals').checked = !!settings.decimals; document.getElementById('setting-autobackup').checked = settings.autoBackup !== false; renderCategoryManager(); }
function renderCategoryManager() { const wrap = document.getElementById('category-manager'); if (!wrap || !db) return; getAllExpenses().then(all => { const used = new Set(all.map(e => e.category)); wrap.innerHTML = getCategories().map(cat => `<div class="category-pill"><span>${escapeHTML(cat)}</span><button onclick="removeCategory('${escapeAttr(cat)}')" ${used.has(cat) ? 'disabled title="Used by existing records"' : ''}>${used.has(cat) ? 'In use' : 'Remove'}</button></div>`).join(''); }); }
function addCategory() { const input = document.getElementById('new-category'); const name = input.value.trim().replace(/\s+/g, ' '); if (!name) { showToast('Enter a category name', true); return; } const cats = getCategories(); if (cats.some(c => c.toLowerCase() === name.toLowerCase())) { showToast('Category already exists', true); return; } cats.splice(Math.max(cats.length - 1, 0), 0, name); input.value = ''; saveCategories(cats); showToast('Category added'); }
async function removeCategory(cat) { const all = await getAllExpenses(); if (all.some(e => e.category === cat)) { showToast('Category is used by records', true); return; } saveCategories(getCategories().filter(c => c !== cat)); showToast('Category removed'); }
async function resetCategories() { if (!await showConfirm({ title:'Reset categories?', message:'Your category master list will return to the defaults. Existing expense records stay unchanged.', actionText:'Reset' })) return; saveCategories(DEFAULT_CATEGORIES); showToast('Categories reset'); }

async function exportPDF() {
  const all = await getAllExpenses();
  if (!all.length) { showToast('No data', true); return; }
  if (!window.jspdf?.jsPDF) { showToast('PDF library unavailable', true); return; }

  const pdfFmt = n => 'Rs. ' + (settings.decimals
    ? Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits:2, maximumFractionDigits:2 })
    : Math.round(Number(n || 0)).toLocaleString('en-IN'));
  const monthName = key => {
    const [year, month] = key.split('-').map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString('en-IN', { month:'long', year:'numeric' });
  };

  const sorted = [...all].sort((a,b) => new Date(a.date) - new Date(b.date));
  const groups = sorted.reduce((acc, e) => {
    const key = e.date.slice(0, 7);
    (acc[key] ||= []).push(e);
    return acc;
  }, {});

  const doc = new window.jspdf.jsPDF();
  const total = sorted.reduce((s,e)=>s+e.amount,0);
  doc.setFontSize(18);
  doc.text('Expense Report', 14, 18);
  doc.setFontSize(11);
  doc.text(`Generated: ${new Date().toLocaleDateString('en-IN')}`, 14, 27);
  doc.text('Created by Ritesh Yadav', 14, 35);
  doc.text(`Records: ${sorted.length}   Total: ${pdfFmt(total)}`, 14, 43);

  let startY = 52;
  Object.entries(groups).forEach(([monthKey, records], index) => {
    const monthTotal = records.reduce((s,e)=>s+e.amount,0);
    if (index > 0 && startY > 250) { doc.addPage(); startY = 18; }
    doc.setFontSize(13);
    doc.text(`${monthName(monthKey)} - ${pdfFmt(monthTotal)}`, 14, startY);
    const rows = records.map(e => [e.date, e.category, pdfFmt(e.amount), e.description || '-']);
    doc.autoTable({
      startY: startY + 5,
      head: [['Date','Category','Amount','Description']],
      body: rows,
      styles:{ fontSize:9 },
      headStyles:{ fillColor:[124,106,255] }
    });
    startY = doc.lastAutoTable.finalY + 12;
  });

  doc.save(`expenses_${today()}.pdf`);
  showToast('PDF downloaded!');
}


function setDateShortcut(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const offset = Number(offsetDays || 0);
  d.setDate(d.getDate() + offset);
  const dateStr = window.flatpickr ? flatpickr.formatDate(d, 'Y-m-d') : d.toISOString().slice(0, 10);
  if (fp) fp.setDate(dateStr, true, 'Y-m-d');
  const input = document.getElementById('f-date');
  if (input) input.value = dateStr;
  document.querySelectorAll('[data-date-offset]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.dateOffset) === offset);
  });
}

function syncDateShortcutActive(date) {
  if (!date) {
    document.querySelectorAll('[data-date-offset]').forEach(btn => btn.classList.remove('active'));
    return;
  }

  const selected = new Date(date);
  selected.setHours(0, 0, 0, 0);
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  const diffDays = Math.round((selected - todayDate) / 86400000);
  document.querySelectorAll('[data-date-offset]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.dateOffset) === diffDays);
  });
}

function setAmountShortcut(amount) {
  const value = Number(amount || 0);
  const input = document.getElementById('f-amount');
  if (!input || !value) return;
  input.value = value;
  input.focus();
  document.querySelectorAll('[data-amount]').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.amount) === value);
  });
}

function bindDateShortcuts() {
  document.querySelectorAll('[data-date-offset]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      setDateShortcut(btn.dataset.dateOffset);
    });
  });
}

function bindAmountShortcuts() {
  document.querySelectorAll('[data-amount]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.preventDefault();
      setAmountShortcut(btn.dataset.amount);
    });
  });

  const input = document.getElementById('f-amount');
  input?.addEventListener('input', () => {
    const value = Number(input.value || 0);
    document.querySelectorAll('[data-amount]').forEach(btn => {
      btn.classList.toggle('active', Number(btn.dataset.amount) === value);
    });
  });
}

window.setDateShortcut = setDateShortcut;
window.setAmountShortcut = setAmountShortcut;

initDB();
loadSettings();
loadTheme();
renderCategoryButtons();
initFlatpickr();
bindDateShortcuts();
bindAmountShortcuts();
registerServiceWorker();
updateCloudSyncStatus(window.showSaveFilePicker ? 'Optional: connect a backup file' : 'Connected file sync unsupported here');
