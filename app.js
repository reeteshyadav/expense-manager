const CAT_ICON_CLASS = {
  Food: "ci-food",
  Transport: "ci-transport",
  Health: "ci-health",
  Grocery: "ci-grocery",
  Shopping: "ci-shopping",
  Bills: "ci-bills",
  Entertainment: "ci-fun",
  Household: "ci-household",
  Personal: "ci-personal",
  Other: "ci-other",
};

let db,
  selectedCat = null,
  currentMonth = new Date(),
  activeFilter = "All";

/* ── Theme ─────────────────────────────────────────────────── */
const THEMES = { pearl: {}, slate: {}, midnight: {}, pink: {} };

function setTheme(t) {
  t = { dark: "slate", light: "pearl", neon: "midnight" }[t] || t;
  document.body.dataset.theme = t === "pearl" ? "" : t;
  if (t === "pearl") document.body.removeAttribute("data-theme");
  if (THEMES[t] && Object.keys(THEMES[t]).length) {
    Object.entries(THEMES[t]).forEach(([k, v]) =>
      document.documentElement.style.setProperty(k, v),
    );
  } else {
    [
      "--bg",
      "--surface",
      "--surface2",
      "--border",
      "--accent",
      "--accent-soft",
      "--text",
      "--muted",
      "--danger",
      "--success",
    ].forEach((k) => document.documentElement.style.removeProperty(k));
    if (t !== "pearl") document.body.dataset.theme = t;
  }
  document
    .querySelectorAll(".theme-dot")
    .forEach((d) => d.classList.toggle("active", d.dataset.t === t));
  localStorage.setItem("theme", t);
  if (fp) {
    fp.destroy();
    initFlatpickr();
  }
}

function loadTheme() {
  const saved = localStorage.getItem("theme") || "pearl";
  const t = saved === "sage" ? "midnight" : saved;
  setTheme(t);
}

/* ── Flatpickr ─────────────────────────────────────────────── */
let fp = null;
function initFlatpickr() {
  fp = flatpickr("#f-date", {
    dateFormat: "Y-m-d",
    defaultDate: new Date(),
    maxDate: new Date(),
    disableMobile: false,
    onChange: () => {},
  });
}

async function writeTextToHandle(handle, text) {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

function updateCloudSyncStatus(text) {
  const el = document.getElementById("cloud-sync-status");
  if (el) el.textContent = text;
  const auth = document.getElementById("auth-status");
  if (auth) auth.textContent = text;
}

let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById("install-app-btn");
  if (btn) btn.style.display = "flex";
});

async function installApp() {
  if (!deferredInstallPrompt) {
    showToast("Use browser menu to install/add to home screen", true);
    return;
  }
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

window.prepareImportBackup = prepareImportBackup;
window.installApp = installApp;

function setDateShortcut(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  fp && fp.setDate(d, true);
}

/* ── IndexedDB ─────────────────────────────────────────────── */
function newExpenseId() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function createdAtIso(expense) {
  if (expense.created_at) return expense.created_at;
  if (expense.createdAt) return new Date(expense.createdAt).toISOString();
  return nowIso();
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function initDB() {
  const req = indexedDB.open("ExpenseDB", 2);
  req.onupgradeneeded = (e) => {
    const database = e.target.result;
    const store = database.objectStoreNames.contains("expenses")
      ? e.target.transaction.objectStore("expenses")
      : database.createObjectStore("expenses", {
          keyPath: "id",
          autoIncrement: true,
        });
    if (!store.indexNames.contains("date")) store.createIndex("date", "date");
    if (!store.indexNames.contains("updated_at"))
      store.createIndex("updated_at", "updated_at");
    if (!store.indexNames.contains("synced"))
      store.createIndex("synced", "synced");
  };
  req.onsuccess = async (e) => {
    db = e.target.result;
    await migrateLocalExpenses();
    await initCloudSync();
    await refreshViews();
  };
  req.onerror = () => showToast("Could not open local database", true);
}

function tx(mode = "readonly") {
  return db.transaction("expenses", mode).objectStore("expenses");
}

function normalizeExpense(expense, defaults = {}) {
  const stamp =
    expense.updated_at ||
    expense.created_at ||
    (expense.createdAt ? new Date(expense.createdAt).toISOString() : nowIso());
  return {
    ...expense,
    id: expense.id || newExpenseId(),
    amount: Number(expense.amount || 0),
    description: expense.description || "",
    created_at: createdAtIso(expense),
    updated_at: stamp,
    deleted: Boolean(expense.deleted),
    synced: expense.synced ?? defaults.synced ?? false,
  };
}

async function getAllExpenses(options = {}) {
  if (!db) return [];
  const rows = await idbReq(tx().getAll());
  const normalized = rows.map((row) => normalizeExpense(row, { synced: true }));
  return options.includeDeleted
    ? normalized
    : normalized.filter((row) => !row.deleted);
}

async function putLocalExpense(expense) {
  const row = normalizeExpense(expense);
  await idbReq(tx("readwrite").put(row));
  return row;
}

async function markExpenseSynced(id) {
  const row = await idbReq(tx().get(id));
  if (!row) return;
  row.synced = true;
  await idbReq(tx("readwrite").put(row));
}

async function migrateLocalExpenses() {
  const rows = await idbReq(tx().getAll());
  const transaction = db.transaction("expenses", "readwrite");
  const writes = transaction.objectStore("expenses");
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  for (const row of rows) {
    const needsUuid = typeof row.id !== "string";
    const migrated = normalizeExpense(row, { synced: false });
    if (needsUuid) {
      migrated.legacyId = row.id;
      migrated.id = newExpenseId();
      migrated.synced = false;
      writes.delete(row.id);
      writes.add(migrated);
    } else if (
      row.synced === undefined ||
      row.deleted === undefined ||
      !row.updated_at ||
      !row.created_at
    ) {
      writes.put({ ...migrated, synced: row.synced ?? false });
    }
  }
  await done;
}

/* ── Form ──────────────────────────────────────────────────── */
function selectCat(btn) {
  document
    .querySelectorAll(".cat-btn")
    .forEach((b) => b.classList.remove("selected"));
  btn.classList.add("selected");
  selectedCat = btn.dataset.cat;
  document
    .getElementById("req-badge")
    .classList.toggle("show", selectedCat === "Other");
  renderDescriptionShortcuts();
}

async function saveExpense() {
  const date = fp ? fp.selectedDates[0] : null;
  const dateStr = date ? flatpickr.formatDate(date, "Y-m-d") : "";
  const amount = parseFloat(document.getElementById("f-amount").value);
  const desc = document.getElementById("f-desc").value.trim();

  if (!dateStr) {
    showToast("Pick a date", true);
    return;
  }
  if (!selectedCat) {
    showToast("Pick a category", true);
    return;
  }
  if (!amount || amount <= 0) {
    showToast("Enter a valid amount", true);
    return;
  }
  if (selectedCat === "Other" && !desc) {
    showToast("Description is required for Other", true);
    document.getElementById("f-desc").focus();
    return;
  }

  const req = tx("readwrite").add({
    date: dateStr,
    category: selectedCat,
    amount,
    description: desc,
    createdAt: Date.now(),
  });
  req.onsuccess = async () => {
    showToast("Saved!");
    document.getElementById("f-amount").value = "";
    document.getElementById("f-desc").value = "";
    selectedCat = null;
    document
      .querySelectorAll(".cat-btn")
      .forEach((b) => b.classList.remove("selected"));
    document.getElementById("req-badge").classList.remove("show");
    fp && fp.setDate(dateStr, false);
  };
}

/* ── Backup ─────────────────────────────────────────────────── */
function backupFileName() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return `expense_backup_${stamp}.json`;
}

function backupPayload(expenses) {
  return { version: 1, exportedAt: new Date().toISOString(), expenses };
}

async function saveBackupFile(payload, name = backupFileName()) {
  const text = JSON.stringify(payload, null, 2);
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [
          {
            description: "JSON backup",
            accept: { "application/json": [".json"] },
          },
        ],
      });
      await writeTextToHandle(handle, text);
      return true;
    } catch (e) {
      if (e.name === "AbortError") return false;
    }
  }
  dl("data:application/json;charset=utf-8," + encodeURIComponent(text), name);
  return true;
}

async function exportBackup() {
  const all = await getAllExpenses();
  if (!all.length) {
    showToast("No data to backup", true);
    return;
  }
  const saved = await saveBackupFile(
    backupPayload(all),
    `expense_backup_${today()}.json`,
  );
  if (saved)
    localStorage.setItem("expense_backup_ts", new Date().toISOString());
  showToast(saved ? "Backup saved!" : "Backup cancelled");
}

async function prepareImportBackup() {
  const ok = await showConfirm({
    title: "Import backup?",
    message:
      "Import only a backup file you trust. Existing records are kept and matching records are skipped.",
    actionText: "Choose file",
  });
  if (ok) document.getElementById("import-file").click();
}

async function importBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    showToast("Invalid file", true);
    return;
  }
  const incoming = parsed.expenses || parsed;
  if (!Array.isArray(incoming) || !incoming.length) {
    showToast("No data in file", true);
    return;
  }
  const existing = await getAllExpenses({ includeDeleted: true });
  const keys = new Set(
    existing.map(
      (e) =>
        e.id ||
        e.createdAt ||
        `${e.date}|${e.category}|${e.amount}|${e.description || ""}`,
    ),
  );
  const toAdd = incoming
    .map((row) =>
      normalizeExpense({
        ...row,
        id: typeof row.id === "string" ? row.id : newExpenseId(),
        synced: false,
      }),
    )
    .filter(
      (e) =>
        !keys.has(e.id) &&
        !keys.has(e.createdAt) &&
        !keys.has(`${e.date}|${e.category}|${e.amount}|${e.description || ""}`),
    );
  if (!toAdd.length) {
    showToast("All records already exist");
    return;
  }
  const store = tx("readwrite");
  toAdd.forEach((row) => store.put(row));
  setTimeout(async () => {
    showToast(`Imported ${toAdd.length} record${toAdd.length > 1 ? "s" : ""}`);
    await refreshViews();
    window.cloudSync?.queueSync("import");
  }, 200);
  e.target.value = "";
}

/* ── Report ─────────────────────────────────────────────────── */
function changeMonth(dir) {
  currentMonth = new Date(
    currentMonth.getFullYear(),
    currentMonth.getMonth() + dir,
    1,
  );
  renderReport();
}

function fmt(n) {
  return (
    "\u20B9 " +
    Number(n || 0).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

async function renderReport() {
  const all = await getAllExpenses();
  const y = currentMonth.getFullYear(),
    m = currentMonth.getMonth();
  const md = all.filter((e) => {
    const d = new Date(e.date);
    return d.getFullYear() === y && d.getMonth() === m;
  });

  document.getElementById("month-label").textContent =
    currentMonth.toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
    });

  const total = md.reduce((s, e) => s + e.amount, 0);
  const days = new Date(y, m + 1, 0).getDate();
  document.getElementById("r-total").textContent = fmt(total);
  document.getElementById("r-count").textContent = md.length;
  document.getElementById("r-avg").textContent = fmt(total / days);

  const catTotals = {};
  md.forEach((e) => {
    catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
  });
  const sorted = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const maxVal = sorted[0]?.[1] || 1;

  document.getElementById("cat-bars").innerHTML = sorted.length
    ? sorted
        .map(
          ([cat, val]) => `
        <div class="bar-row">
          <div class="bar-label">
            <span class="bar-label-icon ${CAT_ICON_CLASS[cat] || "ci-other"}"></span>${cat}
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${((val / maxVal) * 100).toFixed(1)}%"></div></div>
          <div class="bar-amount">${fmt(val)}</div>
        </div>`,
        )
        .join("")
    : '<div class="empty">No expenses this month</div>';

  const list = [...md].sort((a, b) => new Date(b.date) - new Date(a.date));
  document.getElementById("month-list").innerHTML = list.length
    ? list.map(expenseHTML).join("")
    : '<div class="empty">No expenses this month</div>';
}

function expenseHTML(e) {
  const d = new Date(e.date + "T00:00:00");
  return `<div class="expense-item">
    <div class="exp-icon-wrap"><span class="exp-icon-mask ${CAT_ICON_CLASS[e.category] || "ci-other"}"></span></div>
    <div class="expense-info">
      <div class="expense-cat">${e.category}</div>
      <div class="expense-desc">${e.description || "—"}</div>
    </div>
    <div class="expense-right">
      <div class="expense-amount">${fmt(e.amount)}</div>
      <div class="expense-date">${d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</div>
    </div>
    <button class="expense-delete" onclick="deleteExpense('${escapeAttr(e.id)}')">✕</button>
  </div>`;
}

async function renderRecords() {
  const all = await getAllExpenses();
  const cats = [
    "All",
    ...Object.keys(CAT_ICON_CLASS).filter((c) =>
      all.some((e) => e.category === c),
    ),
  ];
  document.getElementById("filter-row").innerHTML = cats
    .map(
      (c) =>
        `<button class="filter-chip ${c === activeFilter ? "active" : ""}" onclick="setFilter('${c}')">${c}</button>`,
    )
    .join("");
  const filtered =
    activeFilter === "All"
      ? all
      : all.filter((e) => e.category === activeFilter);
  const sorted = [...filtered].sort(
    (a, b) => new Date(b.date) - new Date(a.date),
  );
  document.getElementById("all-list").innerHTML = sorted.length
    ? sorted.map(expenseHTML).join("")
    : '<div class="empty">No records found</div>';
}

function setFilter(cat) {
  activeFilter = cat;
  renderRecords();
}

async function renderExportStats() {
  const all = await getAllExpenses();
  const total = all.reduce((s, e) => s + e.amount, 0);
  const months = new Set(all.map((e) => e.date.slice(0, 7))).size;
  const lastBackup = localStorage.getItem("expense_backup_ts");
  document.getElementById("export-stats").innerHTML = `
    <div class="stat-box"><div class="s-num">${all.length}</div><div class="s-lbl">Records</div></div>
    <div class="stat-box"><div class="s-num">${fmt(total)}</div><div class="s-lbl">Total</div></div>
    <div class="stat-box"><div class="s-num">${months}</div><div class="s-lbl">Months</div></div>
    <div class="stat-box"><div class="s-num">${lastBackup ? new Date(lastBackup).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—"}</div><div class="s-lbl">Last backup</div></div>`;
}

function dl(href, name) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
}

async function exportExcel() {
  const all = await getAllExpenses();
  if (!all.length) {
    showToast("No data", true);
    return;
  }
  const data = all
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((e) => ({
      Date: e.date,
      Category: e.category,
      Amount: e.amount,
      Description: e.description || "",
    }));
  const catT = {};
  all.forEach((e) => {
    catT[e.category] = (catT[e.category] || 0) + e.amount;
  });
  const summary = Object.entries(catT)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => ({
      Category: cat,
      "Total Amount": amt,
      Count: all.filter((e) => e.category === cat).length,
    }));
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(data);
  ws1["!cols"] = [{ wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 40 }];
  const ws2 = XLSX.utils.json_to_sheet(summary);
  ws2["!cols"] = [{ wch: 16 }, { wch: 14 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, ws1, "Expenses");
  XLSX.utils.book_append_sheet(wb, ws2, "Summary");
  XLSX.writeFile(wb, `expenses_${today()}.xlsx`);
  showToast("Excel downloaded!");
}

async function exportCSV() {
  const all = await getAllExpenses();
  if (!all.length) {
    showToast("No data", true);
    return;
  }
  const rows = [
    ["Date", "Category", "Amount", "Description"],
    ...all
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map((e) => [e.date, e.category, e.amount, e.description || ""]),
  ];
  dl(
    "data:text/csv;charset=utf-8," +
      encodeURIComponent(
        rows.map((r) => r.map((v) => `"${v}"`).join(",")).join("\n"),
      ),
    `expenses_${today()}.csv`,
  );
  showToast("CSV downloaded!");
}

function showPage(name) {
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document
    .querySelectorAll(".nav-btn")
    .forEach((b) => b.classList.remove("active"));
  document.getElementById("page-" + name).classList.add("active");
  document.getElementById("nav-" + name).classList.add("active");
  if (name === "report") renderReport();
  if (name === "records") renderRecords();
  if (name === "export") renderExportStats();
}

function showToast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2400);
}

const DEFAULT_CATEGORIES = [
  "Food",
  "Grocery",
  "Transport",
  "Bills",
  "Health",
  "Shopping",
  "Household",
  "Personal",
  "Entertainment",
  "Other",
];
const DEFAULT_DESC_SHORTCUTS = {
  Food: [
    "Office lunch",
    "Zomato",
    "Swiggy",
    "Dinner",
    "Dominos",
    "Burger King",
    "McD",
    "Tea/snacks",
  ],
  Grocery: [
    "Vegetables",
    "Fruits",
    "Milk",
    "Bread",
    "Eggs",
    "Rice",
    "Dal",
    "Monthly grocery",
  ],
  Transport: [
    "Uber",
    "Metro",
    "Bike petrol",
    "Auto",
    "Bus",
    "Train",
    "Parking",
    "Toll",
  ],
  Bills: [
    "Electricity",
    "Mobile recharge",
    "Internet",
    "Gas cylinder",
    "Water bill",
    "Rent",
    "DTH",
  ],
  Health: [
    "Medicine",
    "Doctor visit",
    "Lab test",
    "Pharmacy",
    "Gym",
    "Health insurance",
  ],
  Shopping: ["Amazon", "Flipkart", "Clothes", "Shoes", "Electronics", "Gift"],
  Household: [
    "Cleaning supplies",
    "Laundry",
    "Repair",
    "Kitchen items",
    "Home decor",
  ],
  Personal: ["Haircut", "Salon", "Skincare", "Subscription", "Stationery"],
  Entertainment: ["Movie", "OTT", "Cafe", "Game", "Weekend outing"],
  Other: ["Miscellaneous", "Cash expense", "Family", "Donation"],
};
const FONT_SIZES = ["Small", "Normal", "Large", "XL"];
let monthPicker = null,
  pieChart = null,
  barChart = null;
function escapeHTML(value) {
  return String(value).replace(
    /[&<>"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch],
  );
}
function escapeAttr(value) {
  return escapeHTML(value).replace(/'/g, "&#39;");
}
function getCategories() {
  return DEFAULT_CATEGORIES;
}
function getDescriptionShortcuts() {
  try {
    const saved = JSON.parse(
      localStorage.getItem("expense_desc_shortcuts") || "{}",
    );
    return {
      ...DEFAULT_DESC_SHORTCUTS,
      ...(saved && typeof saved === "object" ? saved : {}),
    };
  } catch {
    return DEFAULT_DESC_SHORTCUTS;
  }
}
function saveDescriptionShortcuts(shortcuts) {
  localStorage.setItem("expense_desc_shortcuts", JSON.stringify(shortcuts));
  renderDescriptionShortcuts();
  renderShortcutManager();
}
function fmt(n) {
  return (
    "\u20B9 " +
    Number(n || 0).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}
async function refreshViews() {
  await renderReport();
  await renderRecords();
  await renderExportStats();
  renderShortcutManager();
  renderAuthUI();
}
async function initCloudSync() {
  if (!window.cloudSync) return;
  await window.cloudSync.init({
    readAll: getAllExpenses,
    upsertLocal: putLocalExpense,
    markSynced: markExpenseSynced,
    render: refreshViews,
    onStatus: updateCloudSyncStatus,
    onSessionChange: renderAuthUI,
  });
}
function initFlatpickr() {
  fp = flatpickr("#f-date", {
    dateFormat: "Y-m-d",
    defaultDate: new Date(),
    maxDate: new Date(),
    disableMobile: false,
    onChange: (dates) => syncDateShortcutActive(dates[0]),
  });
  syncDateShortcutActive(fp.selectedDates[0]);
  initMonthPicker();
}
function setDateShortcut(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  fp && fp.setDate(d, true);
}
function initMonthPicker() {
  if (monthPicker) monthPicker.destroy();
  const input = document.getElementById("report-month");
  if (!input || !window.monthSelectPlugin) return;
  monthPicker = flatpickr(input, {
    defaultDate: currentMonth,
    disableMobile: true,
    plugins: [
      new monthSelectPlugin({
        shorthand: false,
        dateFormat: "Y-m",
        altFormat: "F Y",
      }),
    ],
    onChange: (dates) => {
      if (!dates[0]) return;
      currentMonth = new Date(dates[0].getFullYear(), dates[0].getMonth(), 1);
      renderReport();
    },
  });
}
function openMonthPicker() {
  if (!monthPicker) initMonthPicker();
  if (monthPicker) monthPicker.open();
}
function changeMonth(dir) {
  currentMonth = new Date(
    currentMonth.getFullYear(),
    currentMonth.getMonth() + dir,
    1,
  );
  if (monthPicker) monthPicker.setDate(currentMonth, false);
  renderReport();
}
function renderCategoryButtons() {
  const grid = document.getElementById("category-grid");
  if (!grid) return;
  grid.innerHTML = getCategories()
    .map(
      (cat) =>
        `<button class="cat-btn ${cat === "Other" ? "full-row" : ""}" data-cat="${escapeAttr(cat)}" onclick="selectCat(this)"><span class="cat-icon-mask ${CAT_ICON_CLASS[cat] || "ci-other"}"></span>${escapeHTML(cat)}</button>`,
    )
    .join("");
  renderDescriptionShortcuts();
}
function renderDescriptionShortcuts() {
  const wrap = document.getElementById("desc-shortcuts");
  if (!wrap) return;
  const shortcuts = selectedCat
    ? getDescriptionShortcuts()[selectedCat] || []
    : [];
  wrap.innerHTML = shortcuts.length
    ? shortcuts
        .map(
          (text) =>
            `<button type="button" data-desc="${escapeAttr(text)}">${escapeHTML(text)}</button>`,
        )
        .join("")
    : '<span class="shortcut-empty">Pick a category for shortcuts</span>';
}
function setDescriptionShortcut(text) {
  const input = document.getElementById("f-desc");
  if (!input) return;
  input.value = text;
  input.focus();
  document.querySelectorAll("[data-desc]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.desc === text);
  });
}
async function saveExpense() {
  const date = fp ? fp.selectedDates[0] : null;
  const dateStr = date ? flatpickr.formatDate(date, "Y-m-d") : "";
  const amount = parseFloat(document.getElementById("f-amount").value);
  const desc = document.getElementById("f-desc").value.trim();
  if (!dateStr) {
    showToast("Pick a date", true);
    return;
  }
  if (!selectedCat) {
    showToast("Pick a category", true);
    return;
  }
  if (!amount || amount <= 0) {
    showToast("Enter a valid amount", true);
    return;
  }
  if (selectedCat === "Other" && !desc) {
    showToast("Description is required for Other", true);
    document.getElementById("f-desc").focus();
    return;
  }
  const stamp = nowIso();
  await putLocalExpense({
    id: newExpenseId(),
    date: dateStr,
    category: selectedCat,
    amount,
    description: desc,
    created_at: stamp,
    updated_at: stamp,
    deleted: false,
    synced: false,
  });
  showToast("Saved locally");
  document.getElementById("f-amount").value = "";
  document.getElementById("f-desc").value = "";
  document
    .querySelectorAll("[data-amount],[data-desc]")
    .forEach((b) => b.classList.remove("active"));
  selectedCat = null;
  document
    .querySelectorAll(".cat-btn")
    .forEach((b) => b.classList.remove("selected"));
  document.getElementById("req-badge").classList.remove("show");
  renderDescriptionShortcuts();
  fp && fp.setDate(dateStr, false);
  await refreshViews();
  window.cloudSync?.queueSync("save");
}
function showConfirm({ title, message, actionText }) {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const cancel = document.getElementById("confirm-cancel");
    const ok = document.getElementById("confirm-ok");
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-message").textContent = message;
    ok.textContent = actionText || "Delete";
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    const cleanup = (result) => {
      modal.classList.remove("show");
      modal.setAttribute("aria-hidden", "true");
      cancel.onclick = ok.onclick = modal.onclick = null;
      resolve(result);
    };
    cancel.onclick = () => cleanup(false);
    ok.onclick = () => cleanup(true);
    modal.onclick = (e) => {
      if (e.target === modal) cleanup(false);
    };
  });
}
async function deleteExpense(id) {
  if (
    !(await showConfirm({
      title: "Delete expense?",
      message: "This record will be removed from visible records.",
      actionText: "Delete",
    }))
  )
    return;
  const row = await idbReq(tx().get(id));
  if (!row) return;
  row.deleted = true;
  row.synced = false;
  row.updated_at = nowIso();
  await idbReq(tx("readwrite").put(row));
  await refreshViews();
  window.cloudSync?.queueSync("delete");
  showToast("Deleted locally");
}
async function clearAllData() {
  if (
    !(await showConfirm({
      title: "Clear all data?",
      message:
        "Visible records will be deleted locally and synced as deleted after sign-in. Export a fresh JSON backup first.",
      actionText: "Clear data",
    }))
  )
    return;
  const all = await getAllExpenses();
  const stamp = nowIso();
  const store = tx("readwrite");
  all.forEach((row) =>
    store.put({ ...row, deleted: true, synced: false, updated_at: stamp }),
  );
  localStorage.removeItem("expense_auto_backup");
  setTimeout(async () => {
    await refreshViews();
    window.cloudSync?.queueSync("clear");
    showToast("Cleared locally");
  }, 150);
}
function chartColors() {
  return [
    "#7c6aff",
    "#38bdf8",
    "#67e8b0",
    "#fbbf24",
    "#fb7185",
    "#c084fc",
    "#94a3b8",
    "#f97316",
  ];
}
function renderCharts(sorted) {
  const pieEl = document.getElementById("pie-chart"),
    barEl = document.getElementById("bar-chart");
  if (!pieEl || !barEl || !window.Chart) return;
  const labels = sorted.map(([cat]) => cat),
    values = sorted.map(([, val]) => val),
    colors = chartColors();
  if (pieChart) pieChart.destroy();
  if (barChart) barChart.destroy();
  const textColor = getComputedStyle(document.body).color;
  pieChart = new Chart(pieEl, {
    type: "pie",
    data: { labels, datasets: [{ data: values, backgroundColor: colors }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: textColor } } },
    },
  });
  barChart = new Chart(barEl, {
    type: "bar",
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: colors, borderRadius: 8 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: textColor }, grid: { display: false } },
        y: {
          ticks: { color: textColor },
          grid: { color: "rgba(128,128,128,0.18)" },
        },
      },
    },
  });
}
async function renderReport() {
  const all = await getAllExpenses();
  const y = currentMonth.getFullYear(),
    m = currentMonth.getMonth();
  const md = all.filter((e) => {
    const d = new Date(e.date);
    return d.getFullYear() === y && d.getMonth() === m;
  });
  document.getElementById("month-label").textContent =
    currentMonth.toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
    });
  if (monthPicker) monthPicker.setDate(currentMonth, false);
  const total = md.reduce((s, e) => s + e.amount, 0),
    days = new Date(y, m + 1, 0).getDate();
  document.getElementById("r-total").textContent = fmt(total);
  document.getElementById("r-count").textContent = md.length;
  document.getElementById("r-avg").textContent = fmt(total / days);
  const catTotals = {};
  md.forEach((e) => {
    catTotals[e.category] = (catTotals[e.category] || 0) + e.amount;
  });
  const sorted = Object.entries(catTotals).sort((a, b) => b[1] - a[1]);
  const maxVal = sorted[0]?.[1] || 1;
  renderCharts(sorted);
  document.getElementById("cat-bars").innerHTML = sorted.length
    ? sorted
        .map(
          ([cat, val]) =>
            `<div class="bar-row"><div class="bar-label"><span class="bar-label-icon ${CAT_ICON_CLASS[cat] || "ci-other"}"></span>${escapeHTML(cat)}</div><div class="bar-track"><div class="bar-fill" style="width:${((val / maxVal) * 100).toFixed(1)}%"></div></div><div class="bar-amount">${fmt(val)}</div></div>`,
        )
        .join("")
    : '<div class="empty">No expenses this month</div>';
  const list = [...md].sort((a, b) => new Date(b.date) - new Date(a.date));
  document.getElementById("month-list").innerHTML = list.length
    ? list.map(expenseHTML).join("")
    : '<div class="empty">No expenses this month</div>';
}
function expenseHTML(e) {
  return `<div class="expense-item"><div class="exp-icon-wrap"><span class="exp-icon-mask ${CAT_ICON_CLASS[e.category] || "ci-other"}"></span></div><div class="expense-info"><div class="expense-cat">${escapeHTML(e.category)}</div><div class="expense-desc">${escapeHTML(e.description || "-")}</div></div><div class="expense-right"><div class="expense-amount">${fmt(e.amount)}</div></div><button class="expense-delete" onclick="deleteExpense('${escapeAttr(e.id)}')">x</button></div>`;
}
function recordDateHeading(dateKey) {
  const d = new Date(dateKey + "T00:00:00");
  return d.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
async function renderRecords() {
  const all = await getAllExpenses();
  const cats = [
    "All",
    ...getCategories().filter((c) => all.some((e) => e.category === c)),
  ];
  document.getElementById("filter-row").innerHTML = cats
    .map(
      (c) =>
        `<button class="filter-chip ${c === activeFilter ? "active" : ""}" onclick="setFilter('${escapeAttr(c)}')">${escapeHTML(c)}</button>`,
    )
    .join("");
  const filtered =
    activeFilter === "All"
      ? all
      : all.filter((e) => e.category === activeFilter);
  const sorted = [...filtered].sort(
    (a, b) => new Date(b.date) - new Date(a.date),
  );
  const groups = sorted.reduce((acc, expense) => {
    (acc[expense.date] ||= []).push(expense);
    return acc;
  }, {});
  document.getElementById("all-list").innerHTML = sorted.length
    ? Object.entries(groups)
        .map(([date, items]) => {
          const total = items.reduce(
            (sum, item) => sum + Number(item.amount || 0),
            0,
          );
          return `<section class="record-day"><div class="record-day-head"><span>${recordDateHeading(date)}</span><strong>${fmt(total)}</strong></div><div class="record-day-list">${items.map(expenseHTML).join("")}</div></section>`;
        })
        .join("")
    : '<div class="empty">No records found</div>';
}
function showPage(name) {
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document
    .querySelectorAll(".nav-btn")
    .forEach((b) => b.classList.remove("active"));
  document.getElementById("page-" + name).classList.add("active");
  document.getElementById("nav-" + name).classList.add("active");
  if (name === "report") renderReport();
  if (name === "records") renderRecords();
  if (name === "export") renderExportStats();
  if (name === "settings") renderSettings();
}
function renderSettings() {
  renderShortcutCategoryOptions();
  renderShortcutManager();
  renderFontSize();
}
function renderAuthUI() {
  const form = document.getElementById("auth-form");
  const signedIn = document.getElementById("auth-signed-in");
  const status = document.getElementById("auth-status");
  const greeting = document.getElementById("profile-greeting");
  const meta = document.getElementById("profile-meta");
  if (!form || !signedIn || !status) return;
  const session = window.cloudSync?.getSession?.();
  const profile = window.cloudSync?.getProfile?.();
  const configured = window.cloudSync?.isConfigured?.();
  // form.style.display = Boolean(session) ? "block" : "none";
  signedIn.hidden = !session;
  if (!configured) {
    status.textContent = "Cloud sync not configured";
  } else if (session?.user?.email) {
    status.textContent = `Signed in as ${session.user.email}`;
    form.style.display = "none";
  } else {
    status.textContent = "Sign in with an approved account";
  }
  if (greeting)
    greeting.textContent = profile?.full_name
      ? `Hey ${profile.full_name}!`
      : "Hey!";
  if (meta)
    meta.textContent = profile?.phone
      ? `${session?.user?.email || profile.email} · ${profile.phone}`
      : session?.user?.email || "";

  document.getElementById("auth-email").value = null;
  document.getElementById("auth-password").value = null;
}
async function authCredentials() {
  const email = document.getElementById("auth-email")?.value.trim();
  const password = document.getElementById("auth-password")?.value;
  if (!email || !password) throw new Error("Email and password are required");
  if (password.length < 6)
    throw new Error("Password must be at least 6 characters");
  return { email, password };
}
async function loginWithEmail() {
  try {
    const { email, password } = await authCredentials();
    await window.cloudSync.signIn(email, password);
    await window.cloudSync.loadProfile();
    renderAuthUI();
    showToast("Logged in");
  } catch (error) {
    showToast(error.message || "Login failed", true);
  }
}
async function changePassword() {
  try {
    const password = document.getElementById("new-password")?.value || "";
    const confirm = document.getElementById("confirm-password")?.value || "";
    if (password.length < 8)
      throw new Error("Password must be at least 8 characters");
    if (password !== confirm) throw new Error("Passwords do not match");
    await window.cloudSync.updatePassword(password);
    document.getElementById("new-password").value = "";
    document.getElementById("confirm-password").value = "";
    showToast("Password changed");
  } catch (error) {
    showToast(error.message || "Password change failed", true);
  }
}
async function logoutCloud() {
  try {
    await window.cloudSync?.signOut();
    renderAuthUI();
    showToast("Logged out");
  } catch (error) {
    showToast(error.message || "Logout failed", true);
  }
}
async function syncNow() {
  const result = await window.cloudSync?.syncNow("manual");
  if (result?.error) showToast(result.error.message || "Sync failed", true);
  else showToast("Sync checked");
}
function renderShortcutCategoryOptions() {
  const select = document.getElementById("shortcut-category");
  if (!select) return;
  const current = select.value || getCategories()[0];
  select.innerHTML = getCategories()
    .map(
      (cat) => `<option value="${escapeAttr(cat)}">${escapeHTML(cat)}</option>`,
    )
    .join("");
  select.value = getCategories().includes(current)
    ? current
    : getCategories()[0];
}
function renderShortcutManager() {
  renderShortcutCategoryOptions();
  const wrap = document.getElementById("shortcut-manager");
  const select = document.getElementById("shortcut-category");
  if (!wrap || !select) return;
  const cat = select.value || getCategories()[0];
  const shortcuts = getDescriptionShortcuts()[cat] || [];
  wrap.innerHTML = shortcuts.length
    ? shortcuts
        .map(
          (text) =>
            `<div class="shortcut-pill"><span>${escapeHTML(text)}</span><button onclick="removeDescriptionShortcut('${escapeAttr(cat)}','${escapeAttr(text)}')">Remove</button></div>`,
        )
        .join("")
    : '<div class="empty compact">No shortcuts for this category</div>';
}
function addDescriptionShortcut() {
  const select = document.getElementById("shortcut-category");
  const input = document.getElementById("new-shortcut");
  const cat = select?.value;
  const text = input?.value.trim().replace(/\s+/g, " ");
  if (!cat || !text) {
    showToast("Enter a shortcut", true);
    return;
  }
  const shortcuts = getDescriptionShortcuts();
  const list = shortcuts[cat] || [];
  if (list.some((item) => item.toLowerCase() === text.toLowerCase())) {
    showToast("Shortcut already exists", true);
    return;
  }
  shortcuts[cat] = [...list, text];
  input.value = "";
  saveDescriptionShortcuts(shortcuts);
  showToast("Shortcut added");
}
function removeDescriptionShortcut(cat, text) {
  const shortcuts = getDescriptionShortcuts();
  shortcuts[cat] = (shortcuts[cat] || []).filter((item) => item !== text);
  saveDescriptionShortcuts(shortcuts);
  showToast("Shortcut removed");
}
async function resetDescriptionShortcuts() {
  if (
    !(await showConfirm({
      title: "Reset shortcuts?",
      message:
        "Custom description shortcut buttons will be replaced with the defaults.",
      actionText: "Reset",
    }))
  )
    return;
  localStorage.removeItem("expense_desc_shortcuts");
  renderDescriptionShortcuts();
  renderShortcutManager();
  showToast("Shortcuts reset");
}
function getFontSizeIndex() {
  const saved = Number(localStorage.getItem("expense_font_size") || 1);
  return Math.min(Math.max(saved, 0), FONT_SIZES.length - 1);
}
function applyFontSize() {
  document.body.dataset.fontSize = String(getFontSizeIndex());
}
function renderFontSize() {
  applyFontSize();
  const label = document.getElementById("font-size-label");
  if (label) label.textContent = FONT_SIZES[getFontSizeIndex()];
}
function changeFontSize(delta) {
  const next = Math.min(
    Math.max(getFontSizeIndex() + Number(delta || 0), 0),
    FONT_SIZES.length - 1,
  );
  localStorage.setItem("expense_font_size", String(next));
  renderFontSize();
}

async function exportPDF() {
  const all = await getAllExpenses();
  if (!all.length) {
    showToast("No data", true);
    return;
  }
  if (!window.jspdf?.jsPDF) {
    showToast("PDF library unavailable", true);
    return;
  }

  const pdfFmt = (n) =>
    "Rs. " +
    Number(n || 0).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const monthName = (key) => {
    const [year, month] = key.split("-").map(Number);
    return new Date(year, month - 1, 1).toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
    });
  };

  const sorted = [...all].sort((a, b) => new Date(a.date) - new Date(b.date));
  const groups = sorted.reduce((acc, e) => {
    const key = e.date.slice(0, 7);
    (acc[key] ||= []).push(e);
    return acc;
  }, {});

  const doc = new window.jspdf.jsPDF();
  const total = sorted.reduce((s, e) => s + e.amount, 0);
  doc.setFontSize(18);
  doc.text("Expense Report", 14, 18);
  doc.setFontSize(11);
  doc.text(`Generated: ${new Date().toLocaleDateString("en-IN")}`, 14, 27);
  doc.text("Created by Ritesh Yadav", 14, 35);
  doc.text(`Records: ${sorted.length}   Total: ${pdfFmt(total)}`, 14, 43);

  let startY = 52;
  Object.entries(groups).forEach(([monthKey, records], index) => {
    const monthTotal = records.reduce((s, e) => s + e.amount, 0);
    if (index > 0 && startY > 250) {
      doc.addPage();
      startY = 18;
    }
    doc.setFontSize(13);
    doc.text(`${monthName(monthKey)} - ${pdfFmt(monthTotal)}`, 14, startY);
    const rows = records.map((e) => [
      e.date,
      e.category,
      pdfFmt(e.amount),
      e.description || "-",
    ]);
    doc.autoTable({
      startY: startY + 5,
      head: [["Date", "Category", "Amount", "Description"]],
      body: rows,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [124, 106, 255] },
    });
    startY = doc.lastAutoTable.finalY + 12;
  });

  doc.save(`expenses_${today()}.pdf`);
  showToast("PDF downloaded!");
}

function setDateShortcut(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const offset = Number(offsetDays || 0);
  d.setDate(d.getDate() + offset);
  const dateStr = window.flatpickr
    ? flatpickr.formatDate(d, "Y-m-d")
    : d.toISOString().slice(0, 10);
  if (fp) fp.setDate(dateStr, true, "Y-m-d");
  const input = document.getElementById("f-date");
  if (input) input.value = dateStr;
  document.querySelectorAll("[data-date-offset]").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.dateOffset) === offset);
  });
}

function syncDateShortcutActive(date) {
  if (!date) {
    document
      .querySelectorAll("[data-date-offset]")
      .forEach((btn) => btn.classList.remove("active"));
    return;
  }

  const selected = new Date(date);
  selected.setHours(0, 0, 0, 0);
  const todayDate = new Date();
  todayDate.setHours(0, 0, 0, 0);
  const diffDays = Math.round((selected - todayDate) / 86400000);
  document.querySelectorAll("[data-date-offset]").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.dateOffset) === diffDays);
  });
}

function setAmountShortcut(amount) {
  const value = Number(amount || 0);
  const input = document.getElementById("f-amount");
  if (!input || !value) return;
  input.value = value;
  input.focus();
  document.querySelectorAll("[data-amount]").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.amount) === value);
  });
}

function bindDateShortcuts() {
  document.querySelectorAll("[data-date-offset]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      setDateShortcut(btn.dataset.dateOffset);
    });
  });
}

function bindAmountShortcuts() {
  document.querySelectorAll("[data-amount]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      setAmountShortcut(btn.dataset.amount);
    });
  });

  const input = document.getElementById("f-amount");
  input?.addEventListener("input", () => {
    const value = Number(input.value || 0);
    document.querySelectorAll("[data-amount]").forEach((btn) => {
      btn.classList.toggle("active", Number(btn.dataset.amount) === value);
    });
  });
}

function bindDescriptionShortcuts() {
  const wrap = document.getElementById("desc-shortcuts");
  wrap?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-desc]");
    if (!btn) return;
    e.preventDefault();
    setDescriptionShortcut(btn.dataset.desc);
  });
}

window.setDateShortcut = setDateShortcut;
window.setAmountShortcut = setAmountShortcut;
window.changeFontSize = changeFontSize;
window.addDescriptionShortcut = addDescriptionShortcut;
window.removeDescriptionShortcut = removeDescriptionShortcut;
window.resetDescriptionShortcuts = resetDescriptionShortcuts;
window.renderShortcutManager = renderShortcutManager;

initDB();
loadTheme();
applyFontSize();
renderCategoryButtons();
initFlatpickr();
bindDateShortcuts();
bindAmountShortcuts();
bindDescriptionShortcuts();
registerServiceWorker();
renderAuthUI();
