/* ============================================================================
   SWIRLA OPS — APPLICATION ENGINE (v3 White-Label Edition)
   ============================================================================ */

const CFG = window.SWIRLA_CONFIG || {};
const ROOT = CFG.firebaseRoot || 'swirla';
const PREFIX = CFG.storagePrefix || 'swirla_';

// Apply white-label branding & logo colors from data.js
(function applyBrandConfig() {
  const t = CFG.theme || {};
  const rootStyle = document.documentElement.style;
  if (t.primary) rootStyle.setProperty('--primary', t.primary);
  if (t.primaryDark) rootStyle.setProperty('--primary-dark', t.primaryDark);
  if (t.primaryLight) rootStyle.setProperty('--primary-light', t.primaryLight);
  if (t.secondary) rootStyle.setProperty('--secondary', t.secondary);
  if (t.secondaryLight) rootStyle.setProperty('--secondary-light', t.secondaryLight);
  if (t.accentGold) rootStyle.setProperty('--accent-gold', t.accentGold);
  if (t.headerBg) rootStyle.setProperty('--header-bg', t.headerBg);

  if (CFG.appName) {
    document.title = `${CFG.appName} — ${CFG.appSubtitle || 'Operations Console'}`;
    const b1 = document.getElementById('authBrandName');
    const b2 = document.getElementById('headerAppName');
    if (b1) b1.innerText = CFG.appName;
    if (b2) b2.innerText = CFG.appName;
  }
  if (CFG.logoUrl) {
    ['authLogoImg', 'headerLogoImg'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.src = CFG.logoUrl;
    });
  }
})();

/* 1. Firebase Initialization */
firebase.initializeApp({
  databaseURL: CFG.firebaseDatabaseURL || 'https://swirla-inventory-default-rtdb.firebaseio.com'
});
const db = firebase.database();

/* 2. State & Constants */
const DEFAULT_ACCOUNTS = CFG.defaultAccounts || [
  { id: 'acc_manager', name: 'Manager', role: 'manager', pin: '1234' },
  { id: 'acc_buyer', name: 'Buyer', role: 'buyer', pin: '3333' }
];
const STANDARD_UNITS = CFG.standardUnits || ['Units', 'Cases', 'Boxes', 'Bags', 'Bottles', 'Gallons', 'Packs', 'Tubs', 'Rolls', 'Each'];
const INITIAL_SKUS = Array.isArray(CFG.initialSkus) ? CFG.initialSkus : [];

let botToken = (CFG.telegram && CFG.telegram.defaultBotToken) || localStorage.getItem(PREFIX + 'bot_token') || '';
let chatId = (CFG.telegram && CFG.telegram.defaultChatId) || localStorage.getItem(PREFIX + 'chat_id') || '';

let accounts = [];
let vendors = [...(CFG.defaultVendors || [])];
let categories = [...(CFG.defaultCategories || [])];
let skus = JSON.parse(localStorage.getItem(PREFIX + 'skus') || 'null') || JSON.parse(JSON.stringify(INITIAL_SKUS));
let buyOrders = JSON.parse(localStorage.getItem(PREFIX + 'orders') || 'null') || {};
let itemPhotos = {};
let cloudBackups = {};
let historyLogs = [];

let currentUser = null;
let pendingLoginAccount = null;
let pinBuffer = '';
let currentView = 'catalog';

let filterLowStock = false;
let filterNeedsPar = false;
let filterZeroStock = false;
let filtersDrawerOpen = false;
let activeTaxonomyTab = 'vendor';
let activeCameraSkuId = null;
let activeDetailSkuId = null;
let pendingReceiveSummary = [];
let deferredChecklistRender = false;
const stockLogTimers = {};
const stockLogOrigin = {};

/* 3. Role & Utility Helpers */
function isManager() { return !!(currentUser && currentUser.role === 'manager'); }
function isLeaderOrManager() { return !!(currentUser && (currentUser.role === 'manager' || currentUser.role === 'leader')); }

function roleLabel(role) {
  if (role === 'manager') return 'Manager';
  if (role === 'buyer') return 'Buyer';
  return 'Shift Leader';
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeTgMarkdown(str) {
  return String(str ?? '').replace(/([_*`\[])/g, '\\$1');
}

function formatShortTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function uniqueSorted(arr) {
  return [...new Set((arr || []).map(v => String(v || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function showToast(message, type = 'success', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icon = type === 'info' ? 'ℹ️' : type === 'warning' ? '⚠️' : type === 'error' ? '❌' : '✅';
  toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 220);
  }, duration);
}

function isEditingChecklist() {
  const active = document.activeElement;
  return !!(active && active.closest && active.closest('#checklistItemsList') && active.type !== 'checkbox');
}

function flushDeferredChecklistRender() {
  if (deferredChecklistRender) {
    deferredChecklistRender = false;
    setTimeout(() => {
      if (!isEditingChecklist()) renderChecklist();
    }, 50);
  }
}

function refreshOpenDetailModal() {
  if (activeDetailSkuId && document.getElementById('itemDetailModal').style.display === 'flex') {
    if (skus.some(s => s.id === activeDetailSkuId)) openItemDetailModal(activeDetailSkuId);
    else closeModal('itemDetailModal');
  }
}

/* 4. Audit History Logger */
function logHistory(type, summary, details = {}) {
  const entry = {
    type,
    summary,
    actor: currentUser ? currentUser.name : 'System',
    actorRole: currentUser ? currentUser.role : 'system',
    ts: Date.now(),
    ...details
  };
  db.ref(`${ROOT}/history`).push(entry);
}

function queueStockHistoryLog(item, oldVal, newVal) {
  if (oldVal === newVal) return;
  if (stockLogOrigin[item.id] === undefined) {
    stockLogOrigin[item.id] = oldVal;
  }
  clearTimeout(stockLogTimers[item.id]);
  stockLogTimers[item.id] = setTimeout(() => {
    const startVal = stockLogOrigin[item.id];
    delete stockLogOrigin[item.id];
    delete stockLogTimers[item.id];
    if (startVal !== undefined && startVal !== item.stock) {
      logHistory('stock_edit', `${item.name}: Stock ${startVal} → ${item.stock}`, {
        skuId: item.id,
        itemName: item.name,
        vendor: item.vendor,
        oldStock: startVal,
        newStock: item.stock
      });
    }
  }, 1200);
}

/* 5. Auth & PIN Logic */
function renderAuthProfiles() {
  const list = document.getElementById('authProfileList');
  if (!list) return;
  list.innerHTML = '';
  accounts.forEach(acc => {
    const btn = document.createElement('button');
    btn.className = 'profile-btn';
    btn.onclick = () => selectLoginProfile(acc.id);
    btn.innerHTML = `
      <div>
        <div class="profile-name">${escapeHtml(acc.name)}</div>
        <div style="font-size:11px; color:var(--text-muted);">Tap to enter PIN</div>
      </div>
      <span class="role-pill role-${acc.role}">${roleLabel(acc.role)}</span>
    `;
    list.appendChild(btn);
  });
}

function selectLoginProfile(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  pendingLoginAccount = acc;
  pinBuffer = '';
  updatePinDots();
  document.getElementById('authError').innerText = '';
  document.getElementById('authSelectedName').innerText = acc.name;
  document.getElementById('authSelectedRole').innerText = roleLabel(acc.role);
  document.getElementById('authSubtitle').innerText = 'Enter your 4-digit PIN';
  document.getElementById('authProfileStep').style.display = 'none';
  document.getElementById('authPinStep').style.display = 'flex';
}

function backToProfileList() {
  pendingLoginAccount = null;
  pinBuffer = '';
  updatePinDots();
  document.getElementById('authError').innerText = '';
  document.getElementById('authSubtitle').innerText = 'Select your account to sign in';
  document.getElementById('authPinStep').style.display = 'none';
  document.getElementById('authProfileStep').style.display = 'block';
}

function updatePinDots() {
  for (let i = 0; i < 4; i++) {
    const dot = document.getElementById(`pinDot${i}`);
    if (dot) dot.classList.toggle('filled', i < pinBuffer.length);
  }
}

function pressPinDigit(digit) {
  if (!pendingLoginAccount || pinBuffer.length >= 4) return;
  document.getElementById('authError').innerText = '';
  pinBuffer += digit;
  updatePinDots();
  if (pinBuffer.length === 4) {
    if (pinBuffer === String(pendingLoginAccount.pin)) {
      completeLogin(pendingLoginAccount);
    } else {
      document.getElementById('authError').innerText = 'Incorrect PIN. Try again.';
      setTimeout(() => { pinBuffer = ''; updatePinDots(); }, 320);
    }
  }
}

function backspacePinDigit() {
  if (!pendingLoginAccount || !pinBuffer.length) return;
  pinBuffer = pinBuffer.slice(0, -1);
  updatePinDots();
}

function clearPinBuffer() {
  pinBuffer = '';
  document.getElementById('authError').innerText = '';
  updatePinDots();
}

function completeLogin(acc) {
  currentUser = acc;
  localStorage.setItem(PREFIX + 'session', JSON.stringify({ id: acc.id, pin: String(acc.pin) }));
  document.getElementById('authOverlay').style.display = 'none';
  backToProfileList();
  applyRoleUI();
  switchView(acc.role === 'buyer' ? 'checklist' : 'catalog');
  showToast(`Signed in as ${acc.name} (${roleLabel(acc.role)})`, 'info');
}

function logoutUser() {
  currentUser = null;
  localStorage.removeItem(PREFIX + 'session');
  ['accountsModal', 'backupsModal', 'receiveModal', 'telegramModal', 'skuModal', 'itemDetailModal', 'taxonomyModal', 'photoSourceModal'].forEach(closeModal);
  backToProfileList();
  renderAuthProfiles();
  document.getElementById('authOverlay').style.display = 'flex';
}

function restoreSavedSession() {
  if (currentUser) {
    const match = accounts.find(a => a.id === currentUser.id && String(a.pin) === String(currentUser.pin));
    if (!match) {
      logoutUser();
      showToast('Access updated by Management. Please sign in again.', 'warning', 4000);
      return;
    }
    currentUser = match;
    applyRoleUI();
    return;
  }
  const raw = localStorage.getItem(PREFIX + 'session');
  if (raw) {
    try {
      const saved = JSON.parse(raw);
      const match = accounts.find(a => a.id === saved.id && String(a.pin) === String(saved.pin));
      if (match) {
        currentUser = match;
        document.getElementById('authOverlay').style.display = 'none';
        applyRoleUI();
        switchView(match.role === 'buyer' ? 'checklist' : 'catalog');
        return;
      }
    } catch (e) {}
    localStorage.removeItem(PREFIX + 'session');
  }
  document.getElementById('authOverlay').style.display = 'flex';
}

function applyRoleUI() {
  if (!currentUser) return;
  const mgr = isManager();
  const leadOrMgr = isLeaderOrManager();

  document.getElementById('userStatusPill').innerText = `👤 ${currentUser.name} · ${roleLabel(currentUser.role)}`;
  document.getElementById('btnTeamAccess').style.display = mgr ? 'inline-flex' : 'none';
  document.getElementById('btnBackups').style.display = mgr ? 'inline-flex' : 'none';
  document.getElementById('telegramStatusBadge').style.cursor = mgr ? 'pointer' : 'default';
  document.getElementById('tabHistory').style.display = leadOrMgr ? 'flex' : 'none';
  document.getElementById('tabReports').style.display = leadOrMgr ? 'flex' : 'none';
  document.getElementById('btnManageListsShortcut').style.display = leadOrMgr ? 'inline-flex' : 'none';

  // Single-line action row adjustments
  document.getElementById('btnAddNewWrap').style.display = leadOrMgr ? 'block' : 'none';
  document.getElementById('catalogActionsRow').classList.toggle('no-add', !leadOrMgr);
  document.getElementById('addMenuMemberBtn').style.display = mgr ? 'flex' : 'none';

  document.getElementById('btnClearFulfilled').style.display = leadOrMgr ? 'inline-flex' : 'none';
  document.getElementById('btnClearAll').style.display = mgr ? 'inline-flex' : 'none';
  document.getElementById('checkoutUserDisplay').innerText = `${currentUser.name} (${roleLabel(currentUser.role)})`;

  // Receive Stock locked strictly to Leaders & Managers; Buyers send Bought Report
  const checkoutActions = document.getElementById('checkoutActions');
  let actionHtml = '';
  if (leadOrMgr) {
    actionHtml += `<button class="btn btn-primary" id="sendTelegramBtn" style="padding:9px 12px; font-size:12.5px;" onclick="dispatchToTelegram()">✈️ Send Order</button>`;
  }
  actionHtml += `<button class="btn btn-outline" id="sendBuyerReportBtn" style="padding:9px 11px; font-size:12px;" onclick="dispatchBuyerReport()">🚚 Bought Report</button>`;
  if (leadOrMgr) {
    actionHtml += `<button class="btn btn-success" style="padding:9px 12px; font-size:12.5px;" onclick="openReceiveModal()">✅ Receive Stock</button>`;
  }
  checkoutActions.innerHTML = actionHtml;

  if (!leadOrMgr && (currentView === 'history' || currentView === 'reports')) {
    switchView('checklist');
  }

  renderCatalog();
  if (!isEditingChecklist()) renderChecklist();
  if (leadOrMgr && currentView === 'history') renderHistory();
  if (leadOrMgr && currentView === 'reports') renderReports();
  refreshOpenDetailModal();
}

document.addEventListener('keydown', e => {
  if (document.getElementById('authOverlay').style.display !== 'none' && pendingLoginAccount) {
    if (/^[0-9]$/.test(e.key)) pressPinDigit(e.key);
    else if (e.key === 'Backspace') backspacePinDigit();
    else if (e.key === 'Escape') backToProfileList();
  }
});

// Close + Add New dropdown when tapping outside
document.addEventListener('click', e => {
  const wrap = document.getElementById('btnAddNewWrap');
  const menu = document.getElementById('addNewMenu');
  if (menu && menu.classList.contains('open') && wrap && !wrap.contains(e.target)) {
    menu.classList.remove('open');
  }
});

/* 6. Firebase Realtime Listeners */
db.ref(`${ROOT}/accounts`).on('value', snap => {
  const data = snap.val();
  const parsed = Array.isArray(data) ? data : (data ? Object.values(data) : null);
  if (parsed && parsed.length > 0) accounts = parsed;
  else {
    accounts = JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS));
    db.ref(`${ROOT}/accounts`).set(accounts);
  }
  renderAuthProfiles();
  renderAccountsModalList();
  populateHistoryUserFilter();
  restoreSavedSession();
});

db.ref(`${ROOT}/vendors`).on('value', snap => {
  const data = snap.val();
  const parsed = Array.isArray(data) ? data : (data ? Object.values(data) : null);
  if (parsed && parsed.length > 0) {
    vendors = uniqueSorted([...parsed, ...skus.map(s => s.vendor)]);
  } else {
    vendors = uniqueSorted([...(CFG.defaultVendors || []), ...skus.map(s => s.vendor)]);
    if (vendors.length) db.ref(`${ROOT}/vendors`).set(vendors);
  }
  populateFilters();
  if (document.getElementById('taxonomyModal').style.display === 'flex') renderTaxonomyList();
});

db.ref(`${ROOT}/categories`).on('value', snap => {
  const data = snap.val();
  const parsed = Array.isArray(data) ? data : (data ? Object.values(data) : null);
  if (parsed && parsed.length > 0) {
    categories = uniqueSorted([...parsed, ...skus.map(s => s.cat)]);
  } else {
    categories = uniqueSorted([...(CFG.defaultCategories || []), ...skus.map(s => s.cat)]);
    if (categories.length) db.ref(`${ROOT}/categories`).set(categories);
  }
  populateFilters();
  if (document.getElementById('taxonomyModal').style.display === 'flex') renderTaxonomyList();
});

db.ref(`${ROOT}/skus`).on('value', snap => {
  const data = snap.val();
  const parsed = Array.isArray(data) ? data : (data ? Object.values(data) : null);
  if (parsed && parsed.length > 0) {
    skus = parsed;
    localStorage.setItem(PREFIX + 'skus', JSON.stringify(skus));
    vendors = uniqueSorted([...vendors, ...skus.map(s => s.vendor)]);
    categories = uniqueSorted([...categories, ...skus.map(s => s.cat)]);
    populateFilters();
    renderCatalog();
    if (!isEditingChecklist()) renderChecklist();
    else deferredChecklistRender = true;
    if (currentView === 'reports') renderReports();
    refreshOpenDetailModal();
  } else if (INITIAL_SKUS.length > 0) {
    skus = JSON.parse(JSON.stringify(INITIAL_SKUS));
    db.ref(`${ROOT}/skus`).set(skus);
  }
});

db.ref(`${ROOT}/orders`).on('value', snap => {
  buyOrders = snap.val() || {};
  localStorage.setItem(PREFIX + 'orders', JSON.stringify(buyOrders));
  renderCatalog();
  if (!isEditingChecklist()) renderChecklist();
  else deferredChecklistRender = true;
  if (activeDetailSkuId && document.getElementById('itemDetailModal').style.display === 'flex') {
    updateDetailOrderButton(activeDetailSkuId);
  }
});

db.ref(`${ROOT}/backups`).on('value', snap => {
  cloudBackups = snap.val() || {};
  if (document.getElementById('backupsModal').style.display === 'flex') renderCloudBackupsList();
});

db.ref(`${ROOT}/settings/telegram`).on('value', snap => {
  const val = snap.val();
  if (val && (val.botToken || val.chatId)) {
    if (val.botToken) { botToken = val.botToken; localStorage.setItem(PREFIX + 'bot_token', botToken); }
    if (val.chatId) { chatId = val.chatId; localStorage.setItem(PREFIX + 'chat_id', chatId); }
  }
  updateTelegramBadgeUI();
});

db.ref(`${ROOT}/history`).limitToLast(450).on('value', snap => {
  const raw = snap.val() || {};
  historyLogs = Object.entries(raw)
    .map(([key, val]) => ({ id: key, ...val }))
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const pill = document.getElementById('historyCount');
  if (pill) pill.innerText = historyLogs.length;
  populateHistoryUserFilter();
  if (currentView === 'history') renderHistory();
  if (currentView === 'reports') renderReports();
});

function pushAccountsToCloud() { db.ref(`${ROOT}/accounts`).set(accounts); }
function pushVendorsToCloud() { db.ref(`${ROOT}/vendors`).set(uniqueSorted(vendors)); }
function pushCategoriesToCloud() { db.ref(`${ROOT}/categories`).set(uniqueSorted(categories)); }
function pushSkusToCloud() {
  db.ref(`${ROOT}/skus`).set(skus);
  localStorage.setItem(PREFIX + 'skus', JSON.stringify(skus));
}
function pushOrdersToCloud() {
  db.ref(`${ROOT}/orders`).set(buyOrders);
  localStorage.setItem(PREFIX + 'orders', JSON.stringify(buyOrders));
}

function updateTelegramBadgeUI() {
  const badge = document.getElementById('telegramStatusBadge');
  if (!badge) return;
  badge.innerText = (botToken && chatId) ? '✈️ Telegram On' : '✈️ Setup Telegram';
}

/* 7. Photo Cloud Sync & Dual Picker (Camera + Library) */
const photosRef = db.ref(`${ROOT}/photos`);
let photoRenderTimer = null;

function schedulePhotoRender(changedSkuId) {
  if (activeDetailSkuId === changedSkuId) renderDetailPhotos();
  clearTimeout(photoRenderTimer);
  photoRenderTimer = setTimeout(() => {
    renderCatalog();
    if (!isEditingChecklist()) renderChecklist();
    else deferredChecklistRender = true;
    if (currentView === 'reports') renderReports();
  }, 60);
}

photosRef.on('child_added', s => {
  const val = s.val();
  itemPhotos[s.key] = Array.isArray(val) ? val : (val ? [val] : []);
  schedulePhotoRender(s.key);
});
photosRef.on('child_changed', s => {
  const val = s.val();
  itemPhotos[s.key] = Array.isArray(val) ? val : (val ? [val] : []);
  schedulePhotoRender(s.key);
});
photosRef.on('child_removed', s => {
  delete itemPhotos[s.key];
  schedulePhotoRender(s.key);
});

function pushSkuPhotosToCloud(id) {
  const photos = Array.isArray(itemPhotos[id]) ? itemPhotos[id] : (itemPhotos[id] ? [itemPhotos[id]] : []);
  return photos.length === 0 ? db.ref(`${ROOT}/photos/${id}`).remove() : db.ref(`${ROOT}/photos/${id}`).set(photos);
}

function handleThumbnailClick(id) {
  const photos = Array.isArray(itemPhotos[id]) ? itemPhotos[id] : [];
  if (photos.length > 0) openItemDetailModal(id);
  else triggerPhoto(id);
}

function triggerPhoto(id) {
  activeCameraSkuId = id;
  const photos = Array.isArray(itemPhotos[id]) ? itemPhotos[id] : [];
  if (photos.length >= 3) {
    if (!confirm('This item already has 3 photos. Adding another replaces the oldest one. Continue?')) return;
  }
  document.getElementById('photoSourceModal').style.display = 'flex';
}

function launchPhotoInput(mode) {
  closeModal('photoSourceModal');
  const el = document.getElementById(mode === 'camera' ? 'cameraInputLive' : 'cameraInputGallery');
  if (el) el.click();
}

function handlePhotoCapture(event) {
  const file = event.target.files[0];
  const targetSkuId = activeCameraSkuId;
  if (!file || !targetSkuId) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      const maxDim = 720;
      let width = img.width, height = img.height;
      if (width > height && width > maxDim) { height = Math.round((height * maxDim) / width); width = maxDim; }
      else if (height > maxDim) { width = Math.round((width * maxDim) / height); height = maxDim; }
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      const compressed = canvas.toDataURL('image/jpeg', 0.60);

      if (!Array.isArray(itemPhotos[targetSkuId])) itemPhotos[targetSkuId] = [];
      if (itemPhotos[targetSkuId].length >= 3) itemPhotos[targetSkuId].shift();
      itemPhotos[targetSkuId].push(compressed);

      renderCatalog();
      if (!isEditingChecklist()) renderChecklist();
      if (activeDetailSkuId === targetSkuId) renderDetailPhotos();

      pushSkuPhotosToCloud(targetSkuId)
        .then(() => showToast(`Photo synced (${itemPhotos[targetSkuId].length}/3)`, 'success'))
        .catch(() => showToast('Cloud photo sync failed.', 'error'));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

/* 8. Navigation, Sticky Filter Drawer & "+ Add New" Unified Menu */
function switchView(view) {
  const leadOrMgr = isLeaderOrManager();
  if (!leadOrMgr && (view === 'history' || view === 'reports')) view = 'checklist';
  currentView = view;

  document.getElementById('catalogView').style.display = view === 'catalog' ? 'block' : 'none';
  document.getElementById('catalogStickyControls').style.display = view === 'catalog' ? 'flex' : 'none';
  document.getElementById('checklistView').style.display = view === 'checklist' ? 'block' : 'none';
  document.getElementById('historyView').style.display = view === 'history' ? 'block' : 'none';
  document.getElementById('reportsView').style.display = view === 'reports' ? 'block' : 'none';

  document.getElementById('tabCatalog').classList.toggle('active', view === 'catalog');
  document.getElementById('tabChecklist').classList.toggle('active', view === 'checklist');
  document.getElementById('tabHistory').classList.toggle('active', view === 'history');
  document.getElementById('tabReports').classList.toggle('active', view === 'reports');

  if (view === 'catalog') renderCatalog();
  else if (view === 'checklist') renderChecklist();
  else if (view === 'history') renderHistory();
  else if (view === 'reports') renderReports();
}

function toggleFiltersDrawer() {
  filtersDrawerOpen = !filtersDrawerOpen;
  document.getElementById('filtersDrawer').classList.toggle('open', filtersDrawerOpen);
  document.getElementById('toggleFiltersBtn').classList.toggle('open', filtersDrawerOpen);
  document.getElementById('filtersChevron').innerText = filtersDrawerOpen ? '▴' : '▾';
}

function updateFilterIndicators() {
  const v = document.getElementById('vendorFilter').value;
  const c = document.getElementById('categoryFilter').value;
  const hasDrawerActive = !!(v || c || filterZeroStock);
  document.getElementById('toggleFiltersBtn').classList.toggle('has-active', hasDrawerActive);
  const q = document.getElementById('searchBox').value;
  document.getElementById('clearSearchBtn').style.display = q ? 'flex' : 'none';
}

function onSearchInput() {
  updateFilterIndicators();
  renderCatalog();
}

function clearCatalogSearch() {
  document.getElementById('searchBox').value = '';
  updateFilterIndicators();
  renderCatalog();
}

function onFilterChange() {
  updateFilterIndicators();
  renderCatalog();
}

function toggleLowStockFilter() {
  filterLowStock = !filterLowStock;
  document.getElementById('filterLowStockBtn').classList.toggle('active-danger', filterLowStock);
  renderCatalog();
}

function toggleNeedsParFilter() {
  filterNeedsPar = !filterNeedsPar;
  document.getElementById('filterNeedsParBtn').classList.toggle('active', filterNeedsPar);
  renderCatalog();
}

function toggleZeroStockFilter() {
  filterZeroStock = !filterZeroStock;
  document.getElementById('filterZeroStockBtn').classList.toggle('active-danger', filterZeroStock);
  updateFilterIndicators();
  renderCatalog();
}

function resetAllCatalogFilters() {
  document.getElementById('searchBox').value = '';
  document.getElementById('vendorFilter').value = '';
  document.getElementById('categoryFilter').value = '';
  filterLowStock = false;
  filterNeedsPar = false;
  filterZeroStock = false;
  document.getElementById('filterLowStockBtn').classList.remove('active-danger');
  document.getElementById('filterNeedsParBtn').classList.remove('active');
  document.getElementById('filterZeroStockBtn').classList.remove('active-danger');
  updateFilterIndicators();
  renderCatalog();
}

function toggleAddNewMenu(event) {
  event.stopPropagation();
  document.getElementById('addNewMenu').classList.toggle('open');
}

function handleAddMenuChoice(choice) {
  document.getElementById('addNewMenu').classList.remove('open');
  if (choice === 'sku') openSkuModal();
  else if (choice === 'vendor') openTaxonomyModal('vendor', true);
  else if (choice === 'category') openTaxonomyModal('category', true);
  else if (choice === 'member') {
    openAccountsModal();
    setTimeout(() => document.getElementById('accFormName').focus(), 100);
  } else if (choice === 'manage_lists') {
    openTaxonomyModal('vendor', false);
  }
}

/* 9. Vendor & Category Lists Manager */
function populateFilters() {
  const allVendors = uniqueSorted([...vendors, ...skus.map(s => s.vendor)]);
  const allCats = uniqueSorted([...categories, ...skus.map(s => s.cat)]);

  const fillSelect = (elId, list, defaultLabel) => {
    const sel = document.getElementById(elId);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = `<option value="">${defaultLabel}</option>`;
    list.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item;
      opt.textContent = item;
      if (item === prev) opt.selected = true;
      sel.appendChild(opt);
    });
  };

  fillSelect('vendorFilter', allVendors, 'All Vendors');
  fillSelect('categoryFilter', allCats, 'All Categories');
  fillSelect('reportVendorFilter', allVendors, 'All Vendors');

  // SKU modal dropdowns
  const fillModalSelect = (elId, list, placeholder) => {
    const sel = document.getElementById(elId);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = `<option value="">${placeholder}</option>`;
    list.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item;
      opt.textContent = item;
      if (item === prev) opt.selected = true;
      sel.appendChild(opt);
    });
  };
  fillModalSelect('editSkuVendor', allVendors, 'Select Vendor...');
  fillModalSelect('editSkuCategory', allCats, 'Select Category...');
}

function openTaxonomyModal(tab = 'vendor', focusInput = false) {
  if (!isLeaderOrManager()) return;
  switchTaxonomyTab(tab);
  document.getElementById('taxonomyModal').style.display = 'flex';
  if (focusInput) setTimeout(() => document.getElementById('taxonomyNameInput').focus(), 100);
}

function switchTaxonomyTab(tab) {
  activeTaxonomyTab = tab;
  resetTaxonomyForm();
  document.getElementById('taxTabVendor').className = tab === 'vendor' ? 'btn btn-primary' : 'btn btn-outline';
  document.getElementById('taxTabCategory').className = tab === 'category' ? 'btn btn-primary' : 'btn btn-outline';
  document.getElementById('taxonomyNameInput').placeholder = tab === 'vendor' ? 'New vendor name (e.g., Restaurant Depot)' : 'New category name (e.g., Dairy & Milks)';
  renderTaxonomyList();
}

function resetTaxonomyForm() {
  document.getElementById('taxonomyOldName').value = '';
  document.getElementById('taxonomyNameInput').value = '';
  document.getElementById('taxonomySaveBtn').innerText = '+ Add';
  document.getElementById('taxonomyEditHint').style.display = 'none';
}

function startRenameTaxonomy(name) {
  document.getElementById('taxonomyOldName').value = name;
  document.getElementById('taxonomyNameInput').value = name;
  document.getElementById('taxonomySaveBtn').innerText = 'Save';
  document.getElementById('taxonomyEditLabel').innerText = `Renaming "${name}" (updates all matching SKUs)`;
  document.getElementById('taxonomyEditHint').style.display = 'flex';
  document.getElementById('taxonomyNameInput').focus();
}

function saveTaxonomyItem() {
  if (!isLeaderOrManager()) return;
  const oldName = document.getElementById('taxonomyOldName').value.trim();
  const newName = document.getElementById('taxonomyNameInput').value.trim();
  if (!newName) { showToast('Enter a name first.', 'warning'); return; }

  const isVendor = activeTaxonomyTab === 'vendor';
  const list = isVendor ? vendors : categories;

  if (oldName) {
    if (oldName === newName) { resetTaxonomyForm(); return; }
    if (list.some(x => x.toLowerCase() === newName.toLowerCase() && x !== oldName)) {
      showToast('That name already exists.', 'warning'); return;
    }
    const idx = list.indexOf(oldName);
    if (idx !== -1) list[idx] = newName;
    else list.push(newName);

    let updatedSkus = 0;
    skus.forEach(s => {
      if ((isVendor ? s.vendor : s.cat) === oldName) {
        if (isVendor) s.vendor = newName;
        else s.cat = newName;
        updatedSkus++;
      }
    });
    if (updatedSkus > 0) pushSkusToCloud();
    logHistory('sku', `Renamed ${isVendor ? 'Vendor' : 'Category'}: "${oldName}" → "${newName}" (${updatedSkus} SKUs)`);
    showToast(`Renamed to "${newName}"`, 'success');
  } else {
    if (list.some(x => x.toLowerCase() === newName.toLowerCase())) {
      showToast('Already on the list.', 'warning'); return;
    }
    list.push(newName);
    logHistory('sku', `Added ${isVendor ? 'Vendor' : 'Category'}: "${newName}"`);
    showToast(`Added ${isVendor ? 'vendor' : 'category'} "${newName}"`, 'success');
  }

  if (isVendor) { vendors = uniqueSorted(list); pushVendorsToCloud(); }
  else { categories = uniqueSorted(list); pushCategoriesToCloud(); }

  resetTaxonomyForm();
  populateFilters();
  renderTaxonomyList();
  renderCatalog();
}

function deleteTaxonomyItem(name) {
  if (!isManager()) { showToast('Only Managers can delete vendors/categories.', 'error'); return; }
  const isVendor = activeTaxonomyTab === 'vendor';
  const usedCount = skus.filter(s => (isVendor ? s.vendor : s.cat) === name).length;
  if (usedCount > 0) {
    showToast(`${usedCount} SKU(s) still use "${name}". Move or rename them first.`, 'warning', 4500);
    return;
  }
  if (!confirm(`Delete unused ${isVendor ? 'vendor' : 'category'} "${name}"?`)) return;
  if (isVendor) { vendors = vendors.filter(v => v !== name); pushVendorsToCloud(); }
  else { categories = categories.filter(c => c !== name); pushCategoriesToCloud(); }
  logHistory('sku', `Deleted ${isVendor ? 'Vendor' : 'Category'}: "${name}"`);
  populateFilters();
  renderTaxonomyList();
  showToast(`Deleted "${name}"`, 'info');
}

function renderTaxonomyList() {
  const container = document.getElementById('taxonomyList');
  if (!container) return;
  const isVendor = activeTaxonomyTab === 'vendor';
  const list = uniqueSorted(isVendor ? vendors : categories);
  const mgr = isManager();
  container.innerHTML = '';

  list.forEach(name => {
    const count = skus.filter(s => (isVendor ? s.vendor : s.cat) === name).length;
    const row = document.createElement('div');
    row.className = 'list-row-card';
    row.innerHTML = `
      <div style="min-width:0;">
        <div style="font-size:13.5px; font-weight:800;">${escapeHtml(name)}</div>
        <div style="font-size:11px; color:var(--text-muted);">${count} item${count === 1 ? '' : 's'}</div>
      </div>
      <div style="display:flex; gap:5px; flex-shrink:0;">
        <button class="btn btn-outline" style="padding:4px 8px; font-size:11px;" data-name="${escapeHtml(name)}" onclick="startRenameTaxonomy(this.dataset.name)">Rename</button>
        ${mgr ? `<button class="btn btn-outline" style="padding:4px 8px; font-size:11px; color:var(--danger);" data-name="${escapeHtml(name)}" onclick="deleteTaxonomyItem(this.dataset.name)">✕</button>` : ''}
      </div>
    `;
    container.appendChild(row);
  });
}

function quickAddTaxonomyFromSku(type) {
  const label = type === 'vendor' ? 'Vendor' : 'Category';
  const raw = prompt(`Enter new ${label} name:`);
  if (!raw) return;
  const name = raw.trim();
  if (!name) return;

  const list = type === 'vendor' ? vendors : categories;
  const existing = list.find(x => x.toLowerCase() === name.toLowerCase());
  const finalName = existing || name;
  if (!existing) {
    list.push(name);
    if (type === 'vendor') { vendors = uniqueSorted(vendors); pushVendorsToCloud(); }
    else { categories = uniqueSorted(categories); pushCategoriesToCloud(); }
    logHistory('sku', `Added ${label}: "${name}"`);
  }
  populateFilters();
  document.getElementById(type === 'vendor' ? 'editSkuVendor' : 'editSkuCategory').value = finalName;
  showToast(`${label} "${finalName}" selected`, 'success');
}

/* 10. Catalog Rendering & Stock Controls */
function renderCatalog() {
  const query = document.getElementById('searchBox').value.toLowerCase().trim();
  const selVendor = document.getElementById('vendorFilter').value;
  const selCat = document.getElementById('categoryFilter').value;
  const grid = document.getElementById('itemsGrid');
  const leadOrMgr = isLeaderOrManager();

  // Live toolbar counts
  const lowCount = skus.filter(s => s.min > 0 && s.stock <= s.min).length;
  const needsParCount = skus.filter(s => s.min === 0 && s.max === 0).length;
  const zeroCount = skus.filter(s => s.stock === 0).length;

  document.getElementById('filterLowStockBtn').innerText = `⚠️ Low (${lowCount})`;
  document.getElementById('filterNeedsParBtn').innerText = `⚙️ 0/0 (${needsParCount})`;
  document.getElementById('filterZeroStockBtn').innerText = `🚫 Out of Stock (${zeroCount})`;

  const filtered = skus.filter(item => {
    const noteText = (item.note || '').toLowerCase();
    const matchesQuery = !query || item.name.toLowerCase().includes(query) || item.vendor.toLowerCase().includes(query) || noteText.includes(query);
    const matchesVendor = !selVendor || item.vendor === selVendor;
    const matchesCat = !selCat || item.cat === selCat;
    const matchesLow = !filterLowStock || (item.min > 0 && item.stock <= item.min);
    const matchesNeedsPar = !filterNeedsPar || (item.min === 0 && item.max === 0);
    const matchesZero = !filterZeroStock || item.stock === 0;
    return matchesQuery && matchesVendor && matchesCat && matchesLow && matchesNeedsPar && matchesZero;
  });

  document.getElementById('catalogCount').innerText = filtered.length;
  const metaBar = document.getElementById('catalogMetaBar');
  metaBar.innerHTML = `
    <span>Showing <strong>${filtered.length}</strong> of ${skus.length} SKUs</span>
    <span>${lowCount} below min · ${zeroCount} at 0</span>
  `;

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div style="grid-column:1/-1; text-align:center; padding:42px 16px; color:var(--text-muted);">
        <div style="font-size:32px; margin-bottom:8px;">🔍</div>
        <div style="font-weight:800; color:var(--text);">No matching items found</div>
        <button class="btn btn-outline" style="margin-top:12px;" onclick="resetAllCatalogFilters()">Reset Filters</button>
      </div>
    `;
    updateChecklistBadge();
    return;
  }

  grid.innerHTML = '';
  filtered.forEach(item => {
    const isBelowMin = item.min > 0 && item.stock <= item.min;
    const isNearMin = !isBelowMin && item.min > 0 && item.stock <= item.min + 1;
    const isNoPar = item.min === 0 && item.max === 0;
    const cardStateCls = isBelowMin ? 'below-min' : (isNearMin ? 'near-min' : (isNoPar ? 'no-par' : ''));

    const isOrdered = buyOrders[item.id] !== undefined;
    const photos = Array.isArray(itemPhotos[item.id]) ? itemPhotos[item.id] : [];
    const latestPhoto = photos[photos.length - 1];
    const unitLabel = item.unit || 'Units';
    const suggestQty = (item.max > item.stock) ? (item.max - item.stock) : 1;
    const stampHtml = item.updatedBy ? ` · ${escapeHtml(item.updatedBy)}` : '';

    const stockControlsHtml = leadOrMgr ? `
      <div class="sku-qty-controls">
        <button class="qty-btn" onclick="updateStock('${item.id}', -1)">−</button>
        <input type="number" id="stockInp_${item.id}" class="qty-input" value="${item.stock}" min="0" onfocus="this.select()" onchange="setStock('${item.id}', this.value)">
        <button class="qty-btn" onclick="updateStock('${item.id}', 1)">+</button>
      </div>
    ` : `<span style="font-size:11px; font-weight:700; color:var(--text-muted);">Min ${item.min} / Max ${item.max}</span>`;

    const actionsHtml = leadOrMgr ? `
      <button class="btn btn-outline" onclick="openSkuModal('${item.id}')">✏️ Edit</button>
      <button class="btn ${isOrdered ? 'btn-ordered' : 'btn-primary'}" onclick="toggleOrder('${item.id}')">
        ${isOrdered ? '✓ In Checklist' : `+ Order (${suggestQty})`}
      </button>
    ` : `
      <button class="btn btn-outline" onclick="triggerPhoto('${item.id}')">📷 Add Photo</button>
      <button class="btn btn-primary" onclick="openItemDetailModal('${item.id}')">👁️ Details</button>
    `;

    const noteHtml = item.note ? `
      <div class="sku-note-pill"><span>📝</span><span>${escapeHtml(item.note)}</span></div>
    ` : '';

    const card = document.createElement('div');
    card.className = `sku-card ${cardStateCls}`;
    card.innerHTML = `
      <div class="sku-header">
        <div class="photo-trigger" onclick="handleThumbnailClick('${item.id}')">
          ${latestPhoto ? `<img src="${latestPhoto}"><span class="photo-count-badge">${photos.length}/3</span>` : `<span>📷</span><span>Photo</span>`}
        </div>
        <div class="sku-info">
          <div class="sku-badges-row">
            <span class="sku-vendor">${escapeHtml(item.vendor)}</span>
            ${item.stock === 0 ? '<span class="sku-zero-tag">Out of Stock</span>' : ''}
          </div>
          <div class="sku-name" title="${escapeHtml(item.name)}" onclick="openItemDetailModal('${item.id}')">${escapeHtml(item.name)}</div>
          <div class="sku-cat">${escapeHtml(item.cat)}</div>
        </div>
      </div>

      ${noteHtml}

      <div class="sku-stock-row">
        <div style="cursor:${leadOrMgr ? 'pointer' : 'default'};" onclick="${leadOrMgr ? `focusStockInput('${item.id}')` : ''}">
          <span style="font-weight:800;">${item.stock} ${escapeHtml(unitLabel)}</span>
          ${isBelowMin ? '<span style="color:var(--danger); font-size:11px; font-weight:700; margin-left:4px;">Low</span>' : ''}
          <div style="font-size:10px; color:var(--text-muted);">Min ${item.min} / Max ${item.max}${stampHtml}</div>
        </div>
        ${stockControlsHtml}
      </div>

      <div class="sku-card-actions">${actionsHtml}</div>
    `;
    grid.appendChild(card);
  });

  updateChecklistBadge();
}

function focusStockInput(id) {
  const el = document.getElementById(`stockInp_${id}`);
  if (el) { el.focus(); el.select(); }
}

function updateStock(id, delta) {
  if (!isLeaderOrManager()) return;
  const item = skus.find(s => s.id === id);
  if (!item) return;
  const oldVal = item.stock;
  item.stock = Math.max(0, item.stock + delta);
  item.updatedBy = currentUser.name;
  item.updatedAt = Date.now();
  queueStockHistoryLog(item, oldVal, item.stock);
  pushSkusToCloud();
  renderCatalog();
}

function setStock(id, val) {
  if (!isLeaderOrManager()) return;
  const item = skus.find(s => s.id === id);
  if (!item) return;
  const oldVal = item.stock;
  item.stock = Math.max(0, parseInt(val) || 0);
  item.updatedBy = currentUser.name;
  item.updatedAt = Date.now();
  queueStockHistoryLog(item, oldVal, item.stock);
  pushSkusToCloud();
  renderCatalog();
}

/* 11. Buy Checklist & Ordering */
function toggleOrder(id) {
  if (!isLeaderOrManager()) return;
  const item = skus.find(s => s.id === id);
  if (!item) return;

  if (buyOrders[id]) {
    const prevQty = buyOrders[id].qty || 1;
    delete buyOrders[id];
    logHistory('checklist', `Removed ${item.name} from Buy Checklist (was Qty ${prevQty})`, { itemName: item.name, vendor: item.vendor });
    showToast(`Removed ${item.name}`, 'info');
  } else {
    const orderQty = (item.max > item.stock) ? (item.max - item.stock) : 1;
    buyOrders[id] = {
      qty: orderQty,
      bought: 0,
      done: false,
      unit: item.unit || 'Units',
      note: '',
      addedBy: currentUser ? currentUser.name : 'Staff'
    };
    logHistory('checklist', `Added ${item.name} (${orderQty} ${item.unit || 'Units'}) to Buy Checklist`, { itemName: item.name, vendor: item.vendor });
    showToast(`Added ${item.name}`, 'success');
  }
  pushOrdersToCloud();
  renderCatalog();
  renderChecklist();
  if (activeDetailSkuId === id) updateDetailOrderButton(id);
}

function updateChecklistBadge() {
  const count = Object.keys(buyOrders).filter(id => skus.some(s => s.id === id)).length;
  const badge = document.getElementById('checklistCount');
  if (badge) badge.innerText = count;
}

function getOrderBoughtQty(order) {
  const need = Math.max(1, parseInt(order.qty) || 1);
  if (order.bought !== undefined && order.bought !== null) return Math.max(0, parseInt(order.bought) || 0);
  return order.done ? need : 0;
}

function getStatusInfo(need, bought) {
  if (bought >= need) return { cls: 'status-bought', text: `Bought (${bought}/${need})`, done: true };
  if (bought > 0) return { cls: 'status-partial', text: `Partial (${bought}/${need})`, done: false };
  return { cls: 'status-pending', text: 'Pending', done: false };
}

function renderChecklist() {
  const container = document.getElementById('checklistItemsList');
  const orderIds = Object.keys(buyOrders).filter(id => skus.some(s => s.id === id));

  if (orderIds.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:42px 16px; color:var(--text-muted);">
        <div style="font-size:32px; margin-bottom:8px;">📋</div>
        <div style="font-weight:800; color:var(--text);">Buying checklist is empty</div>
        <div style="font-size:13px; margin-top:4px;">Shift Leaders can tap "+ Order" on catalog items to build a shopping list.</div>
      </div>
    `;
    return;
  }

  const leadOrMgr = isLeaderOrManager();
  const grouped = {};
  orderIds.forEach(id => {
    const item = skus.find(s => s.id === id);
    if (item) {
      if (!grouped[item.vendor]) grouped[item.vendor] = [];
      grouped[item.vendor].push({ item, order: buyOrders[id] });
    }
  });

  container.innerHTML = '';
  Object.keys(grouped).sort().forEach(vendor => {
    const groupCard = document.createElement('div');
    groupCard.className = 'vendor-group';

    let itemsHtml = '';
    grouped[vendor].forEach(({ item, order }) => {
      const photos = Array.isArray(itemPhotos[item.id]) ? itemPhotos[item.id] : [];
      const latestPhoto = photos[photos.length - 1];
      const currentUnit = order.unit || item.unit || 'Units';
      const needQty = Math.max(1, parseInt(order.qty) || 1);
      const boughtQty = getOrderBoughtQty(order);
      const status = getStatusInfo(needQty, boughtQty);

      const unitOptions = STANDARD_UNITS.includes(currentUnit) ? STANDARD_UNITS : [currentUnit, ...STANDARD_UNITS];
      const unitSelectHtml = unitOptions.map(u => `<option value="${escapeHtml(u)}" ${u === currentUnit ? 'selected' : ''}>${escapeHtml(u)}</option>`).join('');

      const needHtml = leadOrMgr ? `
        <div class="cl-field-group">
          <span style="font-size:11.5px; font-weight:700; color:var(--text-muted);">Need:</span>
          <button class="qty-btn" onclick="adjustOrderQty('${item.id}', -1)">−</button>
          <input type="number" class="qty-input" value="${needQty}" min="1" oninput="onOrderQtyInput('${item.id}', this.value)" onchange="pushOrdersToCloud()" onblur="flushDeferredChecklistRender()">
          <button class="qty-btn" onclick="adjustOrderQty('${item.id}', 1)">+</button>
          <select class="cl-unit-select" onchange="setOrderUnit('${item.id}', this.value)" onblur="flushDeferredChecklistRender()">${unitSelectHtml}</select>
        </div>
      ` : `
        <div class="cl-field-group">
          <span style="font-size:12px; font-weight:800; background:var(--surface-soft); padding:4px 9px; border-radius:8px;">Need: ${needQty} ${escapeHtml(currentUnit)}</span>
        </div>
      `;

      const skuNoteHtml = item.note ? `
        <div class="sku-note-pill" style="padding:4px 8px; font-size:11px;"><span>📌</span><span>${escapeHtml(item.note)}</span></div>
      ` : '';

      itemsHtml += `
        <div class="checklist-item ${status.done ? 'done' : ''}" id="clRow_${item.id}">
          <div class="cl-item-top">
            <div class="cl-left">
              <input type="checkbox" id="clCheck_${item.id}" style="transform:scale(1.2); flex-shrink:0;" ${status.done ? 'checked' : ''} onchange="toggleDone('${item.id}')">
              <div class="cl-thumb" onclick="handleThumbnailClick('${item.id}')">
                ${latestPhoto ? `<img src="${latestPhoto}">` : `<span>📷</span>`}
              </div>
              <div style="min-width:0; flex:1;">
                <div class="cl-title" onclick="openItemDetailModal('${item.id}')">${escapeHtml(item.name)}</div>
                <div class="cl-sub">Stock: ${item.stock} · Max: ${item.max}${order.addedBy ? ` · by ${escapeHtml(order.addedBy)}` : ''}</div>
              </div>
            </div>
            <div style="display:flex; gap:4px; align-items:center; flex-shrink:0;">
              <button class="btn btn-outline" style="padding:4px 8px; font-size:12px;" onclick="triggerPhoto('${item.id}')" title="Add Photo">📷</button>
              ${leadOrMgr ? `<button class="btn btn-outline" style="padding:4px 8px; font-size:11px; color:var(--danger);" onclick="toggleOrder('${item.id}')">✕</button>` : ''}
            </div>
          </div>

          ${skuNoteHtml}

          <div class="cl-controls-row">
            ${needHtml}
            <div class="cl-field-group">
              <span style="font-size:11.5px; font-weight:700; color:var(--success);">Bought:</span>
              <button class="qty-btn" onclick="adjustBoughtQty('${item.id}', -1)">−</button>
              <input type="number" class="qty-input" value="${boughtQty}" min="0" oninput="onBoughtInput('${item.id}', this.value)" onchange="commitBoughtEdit('${item.id}', this.value)" onblur="flushDeferredChecklistRender()">
              <button class="qty-btn" onclick="adjustBoughtQty('${item.id}', 1)">+</button>
            </div>
            <span class="cl-status-pill ${status.cls}" id="clStatus_${item.id}">${status.text}</span>
          </div>

          <input type="text" class="cl-note-input" value="${escapeHtml(order.note || '')}" placeholder="📝 One-time buy note (price, brand out, aisle)..." oninput="onNoteInput('${item.id}', this.value)" onchange="pushOrdersToCloud()" onblur="flushDeferredChecklistRender()">
        </div>
      `;
    });

    const vendorActionsHtml = leadOrMgr ? `
      <div class="vendor-header-actions">
        <button class="btn btn-primary" style="padding:4px 9px; font-size:11px;" data-vendor="${escapeHtml(vendor)}" onclick="dispatchToTelegram(this.dataset.vendor)">✈️ Send Store</button>
        <button class="btn btn-success" style="padding:4px 9px; font-size:11px;" data-vendor="${escapeHtml(vendor)}" onclick="openReceiveModal(this.dataset.vendor)">✅ Receive Store</button>
      </div>
    ` : '';

    groupCard.innerHTML = `
      <div class="vendor-header">
        <span>📍 ${escapeHtml(vendor)} (${grouped[vendor].length})</span>
        ${vendorActionsHtml}
      </div>
      ${itemsHtml}
    `;
    container.appendChild(groupCard);
  });
}

function toggleDone(id) {
  const order = buyOrders[id];
  const item = skus.find(s => s.id === id);
  if (!order) return;
  const need = Math.max(1, parseInt(order.qty) || 1);
  const oldBought = getOrderBoughtQty(order);
  if (oldBought >= need) {
    order.bought = 0;
    order.done = false;
  } else {
    order.bought = need;
    order.done = true;
  }
  order.boughtBy = currentUser ? currentUser.name : 'Buyer';
  if (item) {
    logHistory('bought_edit', `${item.name}: Bought ${oldBought} → ${order.bought} (of ${need})`, { itemName: item.name, vendor: item.vendor });
  }
  pushOrdersToCloud();
  renderChecklist();
}

function adjustOrderQty(id, delta) {
  if (!isLeaderOrManager() || !buyOrders[id]) return;
  buyOrders[id].qty = Math.max(1, (parseInt(buyOrders[id].qty) || 1) + delta);
  buyOrders[id].done = getOrderBoughtQty(buyOrders[id]) >= buyOrders[id].qty;
  pushOrdersToCloud();
  renderChecklist();
}

function onOrderQtyInput(id, val) {
  if (!isLeaderOrManager() || !buyOrders[id]) return;
  const need = Math.max(1, parseInt(val) || 1);
  buyOrders[id].qty = need;
  const status = getStatusInfo(need, getOrderBoughtQty(buyOrders[id]));
  buyOrders[id].done = status.done;
  updateChecklistRowStatusInPlace(id, status);
}

function adjustBoughtQty(id, delta) {
  if (!buyOrders[id]) return;
  const oldBought = getOrderBoughtQty(buyOrders[id]);
  const nextBought = Math.max(0, oldBought + delta);
  const need = Math.max(1, parseInt(buyOrders[id].qty) || 1);
  buyOrders[id].bought = nextBought;
  buyOrders[id].done = nextBought >= need;
  buyOrders[id].boughtBy = currentUser ? currentUser.name : 'Buyer';
  const item = skus.find(s => s.id === id);
  if (item && oldBought !== nextBought) {
    logHistory('bought_edit', `${item.name}: Bought ${oldBought} → ${nextBought} (of ${need})`, { itemName: item.name, vendor: item.vendor });
  }
  pushOrdersToCloud();
  renderChecklist();
}

function onBoughtInput(id, val) {
  if (!buyOrders[id]) return;
  const bought = Math.max(0, parseInt(val) || 0);
  const need = Math.max(1, parseInt(buyOrders[id].qty) || 1);
  buyOrders[id].bought = bought;
  buyOrders[id].boughtBy = currentUser ? currentUser.name : 'Buyer';
  const status = getStatusInfo(need, bought);
  buyOrders[id].done = status.done;
  updateChecklistRowStatusInPlace(id, status);
}

function commitBoughtEdit(id, val) {
  if (!buyOrders[id]) return;
  const item = skus.find(s => s.id === id);
  const bought = Math.max(0, parseInt(val) || 0);
  const need = Math.max(1, parseInt(buyOrders[id].qty) || 1);
  buyOrders[id].bought = bought;
  buyOrders[id].done = bought >= need;
  buyOrders[id].boughtBy = currentUser ? currentUser.name : 'Buyer';
  if (item) {
    logHistory('bought_edit', `${item.name}: Set Bought to ${bought} (of ${need})`, { itemName: item.name, vendor: item.vendor });
  }
  pushOrdersToCloud();
}

function updateChecklistRowStatusInPlace(id, status) {
  const pill = document.getElementById(`clStatus_${id}`);
  const chk = document.getElementById(`clCheck_${id}`);
  const row = document.getElementById(`clRow_${id}`);
  if (pill) { pill.className = `cl-status-pill ${status.cls}`; pill.innerText = status.text; }
  if (chk) chk.checked = status.done;
  if (row) row.classList.toggle('done', status.done);
}

function setOrderUnit(id, unit) {
  if (!isLeaderOrManager() || !buyOrders[id]) return;
  buyOrders[id].unit = unit;
  pushOrdersToCloud();
}

function onNoteInput(id, note) {
  if (buyOrders[id]) buyOrders[id].note = note;
}

function clearFulfilled() {
  if (!isLeaderOrManager()) return;
  const doneIds = Object.keys(buyOrders).filter(id => buyOrders[id] && getStatusInfo(Math.max(1, parseInt(buyOrders[id].qty) || 1), getOrderBoughtQty(buyOrders[id])).done);
  if (!doneIds.length) { showToast('No fulfilled items to clear.', 'info'); return; }
  const names = doneIds.map(id => (skus.find(s => s.id === id) || {}).name).filter(Boolean);
  doneIds.forEach(id => delete buyOrders[id]);
  logHistory('checklist', `Cleared ${doneIds.length} fulfilled item(s): ${names.slice(0, 5).join(', ')}`);
  pushOrdersToCloud();
  renderCatalog();
  renderChecklist();
  showToast('Fulfilled items cleared', 'info');
}

function clearAllChecklist() {
  if (!isManager()) { showToast('Manager access required.', 'error'); return; }
  const activeIds = Object.keys(buyOrders).filter(id => skus.some(s => s.id === id));
  if (!activeIds.length) { showToast('Checklist is already empty.', 'info'); return; }
  if (!confirm('Clear ALL items from the buying checklist?')) return;
  buyOrders = {};
  logHistory('checklist', `Cleared entire Buy Checklist (${activeIds.length} items)`);
  pushOrdersToCloud();
  renderCatalog();
  renderChecklist();
  showToast('Buying checklist cleared', 'info');
}

/* 12. Supervise & Receive Bought Items (Shift Leaders & Managers Only) */
function openReceiveModal(targetVendor = null) {
  if (!isLeaderOrManager()) {
    showToast('Only Shift Leaders or Management can receive stock.', 'warning');
    return;
  }
  const orderIds = Object.keys(buyOrders).filter(id => skus.some(s => s.id === id));
  pendingReceiveSummary = [];

  orderIds.forEach(id => {
    const item = skus.find(s => s.id === id);
    if (!item || (targetVendor && item.vendor !== targetVendor)) return;
    const order = buyOrders[id];
    const need = Math.max(1, parseInt(order.qty) || 1);
    const bought = getOrderBoughtQty(order);
    if (bought > 0) {
      pendingReceiveSummary.push({
        id,
        name: item.name,
        vendor: item.vendor,
        unit: order.unit || item.unit || 'Units',
        oldStock: item.stock,
        bought,
        need,
        newStock: item.stock + bought,
        remaining: Math.max(0, need - bought),
        boughtBy: order.boughtBy || 'Buyer'
      });
    }
  });

  if (!pendingReceiveSummary.length) {
    showToast('No items marked Bought yet for this selection.', 'warning');
    return;
  }

  document.getElementById('receiveModalTitle').innerText = targetVendor
    ? `✅ Receive ${targetVendor} Items`
    : '✅ Receive Bought Items into Stock';

  const list = document.getElementById('receivePreviewList');
  list.innerHTML = '';
  pendingReceiveSummary.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'list-row-card';
    const remainBadge = entry.remaining > 0
      ? `<span style="font-size:11px; color:#92400E; background:var(--warning-light); padding:2px 7px; border-radius:6px; font-weight:700;">${entry.remaining} left</span>`
      : `<span style="font-size:11px; color:#065F46; background:var(--success-light); padding:2px 7px; border-radius:6px; font-weight:700;">Fulfilled</span>`;

    row.innerHTML = `
      <div style="min-width:0;">
        <div style="font-size:13px; font-weight:800;">${escapeHtml(entry.name)}</div>
        <div style="font-size:11px; color:var(--text-muted);">${escapeHtml(entry.vendor)} · Stock: ${entry.oldStock} → <strong>${entry.newStock} ${escapeHtml(entry.unit)}</strong> (+${entry.bought})</div>
      </div>
      ${remainBadge}
    `;
    list.appendChild(row);
  });

  document.getElementById('receiveModal').style.display = 'flex';
}

async function confirmReceiveToStock() {
  if (!isLeaderOrManager() || !pendingReceiveSummary.length) return;
  const sendTg = document.getElementById('receiveAlsoTelegram').checked;
  const now = Date.now();
  let partialCount = 0;

  pendingReceiveSummary.forEach(entry => {
    const item = skus.find(s => s.id === entry.id);
    if (item) {
      item.stock = item.stock + entry.bought;
      item.updatedBy = currentUser.name;
      item.updatedAt = now;
    }
    if (entry.remaining > 0 && buyOrders[entry.id]) {
      buyOrders[entry.id].qty = entry.remaining;
      buyOrders[entry.id].bought = 0;
      buyOrders[entry.id].done = false;
      partialCount++;
    } else {
      delete buyOrders[entry.id];
    }
  });

  const vendorSet = uniqueSorted(pendingReceiveSummary.map(e => e.vendor));
  logHistory('receive', `Received ${pendingReceiveSummary.length} item(s) (${vendorSet.join(', ')})`, {
    vendors: vendorSet,
    items: pendingReceiveSummary.map(e => ({
      id: e.id, name: e.name, vendor: e.vendor, unit: e.unit,
      oldStock: e.oldStock, bought: e.bought, newStock: e.newStock,
      need: e.need, remaining: e.remaining, boughtBy: e.boughtBy
    }))
  });

  pushSkusToCloud();
  pushOrdersToCloud();
  closeModal('receiveModal');
  renderCatalog();
  renderChecklist();

  if (sendTg) await sendBuyerReceiptTelegram(pendingReceiveSummary);

  showToast(partialCount > 0
    ? `Updated ${pendingReceiveSummary.length} items (${partialCount} partial kept)`
    : `Updated ${pendingReceiveSummary.length} items into stock!`, 'success', 4000);
  pendingReceiveSummary = [];
}

/* 13. History View & Manager Undo */
function populateHistoryUserFilter() {
  const sel = document.getElementById('historyUserFilter');
  if (!sel) return;
  const prev = sel.value;
  const names = uniqueSorted([...accounts.map(a => a.name), ...historyLogs.map(h => h.actor)]);
  sel.innerHTML = '<option value="">All Staff</option>';
  names.forEach(n => {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    if (n === prev) opt.selected = true;
    sel.appendChild(opt);
  });
}

function getFilteredHistory(rangeOverride = null, vendorOverride = null) {
  const q = (document.getElementById('historySearchBox')?.value || '').toLowerCase().trim();
  const type = document.getElementById('historyTypeFilter')?.value || '';
  const actor = document.getElementById('historyUserFilter')?.value || '';
  const rangeVal = rangeOverride !== null ? rangeOverride : (document.getElementById('historyRangeFilter')?.value || '30');
  const cutoff = rangeVal === 'all' ? 0 : (Date.now() - parseInt(rangeVal) * 86400000);

  return historyLogs.filter(h => {
    if (cutoff && (h.ts || 0) < cutoff) return false;
    if (!rangeOverride && type && h.type !== type) return false;
    if (!rangeOverride && actor && h.actor !== actor) return false;
    if (vendorOverride) {
      const hasVendor = (h.vendor === vendorOverride) ||
        (Array.isArray(h.vendors) && h.vendors.includes(vendorOverride)) ||
        (Array.isArray(h.items) && h.items.some(i => i.vendor === vendorOverride));
      if (!hasVendor) return false;
    }
    if (!rangeOverride && q) {
      const blob = `${h.summary || ''} ${h.actor || ''} ${JSON.stringify(h.items || '')}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
}

function historyBadgeMeta(type) {
  switch (type) {
    case 'receive': return { cls: 'hb-receive', label: 'Received' };
    case 'order_sent': return { cls: 'hb-order', label: 'Order Sent' };
    case 'buyer_report': return { cls: 'hb-order', label: 'Buyer Report' };
    case 'bought_edit': return { cls: 'hb-receive', label: 'Bought Edit' };
    case 'stock_edit': return { cls: 'hb-stock', label: 'Stock Edit' };
    case 'checklist': return { cls: 'hb-sku', label: 'Checklist' };
    default: return { cls: 'hb-sku', label: 'Catalog Edit' };
  }
}

function renderHistory() {
  const container = document.getElementById('historyList');
  if (!container) return;
  const list = getFilteredHistory();
  const mgr = isManager();

  if (!list.length) {
    container.innerHTML = `
      <div style="text-align:center; padding:40px 16px; color:var(--text-muted); background:var(--card-bg); border-radius:14px; border:1px solid var(--border);">
        <div style="font-size:28px; margin-bottom:6px;">🕵️</div>
        <div style="font-weight:800; color:var(--text);">No activity logs match these filters yet</div>
        <div style="font-size:12px; margin-top:4px;">Orders, stock adjustments, buyer edits, and receives are automatically tracked here.</div>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  list.slice(0, 150).forEach(h => {
    const meta = historyBadgeMeta(h.type);
    const itemsList = Array.isArray(h.items) ? h.items : [];
    const itemsHtml = itemsList.length ? `
      <div class="history-items-box">
        ${itemsList.map(it => {
          if (h.type === 'receive') {
            const shortTxt = it.remaining > 0 ? ` <span style="color:#B45309;">(Short ${it.remaining})</span>` : '';
            return `<div>• <strong>${escapeHtml(it.name)}</strong> (${escapeHtml(it.vendor)}): +${it.bought} ${escapeHtml(it.unit)} → Stock ${it.oldStock} → <strong>${it.newStock}</strong>${shortTxt}</div>`;
          }
          return `<div>• <strong>${escapeHtml(it.name)}</strong> (${escapeHtml(it.vendor || '')}): ${it.qty || it.bought || 0} ${escapeHtml(it.unit || 'Units')}</div>`;
        }).join('')}
      </div>
    ` : '';

    const undoHtml = (mgr && h.type === 'receive' && !h.undone && itemsList.length)
      ? `<button class="btn btn-danger-soft" style="padding:3px 8px; font-size:11px;" onclick="undoReceiveEvent('${h.id}')">↩️ Undo Receive</button>`
      : (h.undone ? `<span style="font-size:11px; color:var(--danger); font-weight:800;">Reversed</span>` : '');

    const card = document.createElement('div');
    card.className = 'history-card';
    card.innerHTML = `
      <div class="history-top">
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <span class="history-badge ${meta.cls}">${meta.label}</span>
          <strong style="font-size:13px;">${escapeHtml(h.actor || 'Staff')}</strong>
          <span style="font-size:11px; color:var(--text-muted);">${formatShortTime(h.ts)}</span>
        </div>
        ${undoHtml}
      </div>
      <div style="font-size:13px; font-weight:600; color:var(--text);">${escapeHtml(h.summary)}</div>
      ${itemsHtml}
    `;
    container.appendChild(card);
  });
}

function undoReceiveEvent(histId) {
  if (!isManager()) return;
  const entry = historyLogs.find(h => h.id === histId);
  if (!entry || entry.undone || !Array.isArray(entry.items)) return;
  if (!confirm(`Roll back stock for ${entry.items.length} item(s) from this receive batch?`)) return;

  entry.items.forEach(it => {
    const sku = skus.find(s => s.id === it.id);
    if (sku) {
      sku.stock = Math.max(0, sku.stock - (parseInt(it.bought) || 0));
      sku.updatedBy = currentUser.name;
      sku.updatedAt = Date.now();
    }
  });

  db.ref(`${ROOT}/history/${histId}/undone`).set(true);
  logHistory('stock_edit', `Reversed Receive (${entry.items.length} items) originally by ${entry.actor}`, {
    items: entry.items.map(it => ({ name: it.name, vendor: it.vendor, qty: -(it.bought || 0), unit: it.unit }))
  });
  pushSkusToCloud();
  renderCatalog();
  renderHistory();
  showToast('Stock rolled back to pre-receive counts', 'info', 4000);
}

function exportHistoryCsv() {
  const list = getFilteredHistory();
  if (!list.length) { showToast('No history rows to export.', 'warning'); return; }
  const rows = [['Date', 'Staff', 'Role', 'Action', 'Summary']];
  list.forEach(h => {
    rows.push([
      new Date(h.ts || 0).toISOString(),
      h.actor || '',
      h.actorRole || '',
      h.type || '',
      h.summary || ''
    ]);
  });
  downloadCsvFile(rows, `swirla-history-${new Date().toISOString().slice(0, 10)}.csv`);
}

/* 14. Management & Buying Insights Reports */
function computeReportMetrics() {
  const range = document.getElementById('reportRangeFilter')?.value || '30';
  const vendor = document.getElementById('reportVendorFilter')?.value || '';
  const events = getFilteredHistory(range, vendor || null);

  const skuPool = vendor ? skus.filter(s => s.vendor === vendor) : skus;
  const receiveEvents = events.filter(e => e.type === 'receive' && !e.undone);
  const orderEvents = events.filter(e => e.type === 'order_sent');

  const itemStats = {};
  const vendorStats = {};
  const staffStats = {};
  let totalBought = 0;
  let totalNeeded = 0;

  events.forEach(e => {
    const actor = e.actor || 'Staff';
    if (!staffStats[actor]) staffStats[actor] = { orders: 0, receives: 0, edits: 0 };
    if (e.type === 'order_sent') staffStats[actor].orders++;
    else if (e.type === 'receive' && !e.undone) staffStats[actor].receives++;
    else staffStats[actor].edits++;
  });

  receiveEvents.forEach(ev => {
    (ev.items || []).forEach(it => {
      if (vendor && it.vendor !== vendor) return;
      const bought = parseInt(it.bought) || 0;
      const need = parseInt(it.need) || bought;
      totalBought += bought;
      totalNeeded += need;

      const key = it.id || it.name;
      if (!itemStats[key]) {
        itemStats[key] = { id: it.id, name: it.name, vendor: it.vendor, unit: it.unit || 'Units', bought: 0, needed: 0, runs: 0, shorts: 0 };
      }
      itemStats[key].bought += bought;
      itemStats[key].needed += need;
      itemStats[key].runs++;
      if (bought < need) itemStats[key].shorts++;

      const vName = it.vendor || 'Other';
      if (!vendorStats[vName]) vendorStats[vName] = { vendor: vName, trips: 0, bought: 0, needed: 0, shorts: 0 };
      vendorStats[vName].trips++;
      vendorStats[vName].bought += bought;
      vendorStats[vName].needed += need;
      if (bought < need) vendorStats[vName].shorts++;
    });
  });

  const mostBought = Object.values(itemStats).sort((a, b) => b.bought - a.bought || b.runs - a.runs);
  const leastBought = skuPool
    .map(s => ({
      id: s.id,
      name: s.name,
      vendor: s.vendor,
      stock: s.stock,
      min: s.min,
      max: s.max,
      bought: itemStats[s.id]?.bought || 0,
      runs: itemStats[s.id]?.runs || 0
    }))
    .sort((a, b) => a.bought - b.bought || b.stock - a.stock);

  const shortItems = Object.values(itemStats)
    .filter(x => x.shorts > 0)
    .sort((a, b) => b.shorts - a.shorts || (a.bought / Math.max(1, a.needed)) - (b.bought / Math.max(1, b.needed)));

  const parSuggestions = [];
  mostBought.forEach(st => {
    const sku = skus.find(s => s.id === st.id);
    if (!sku) return;
    if (sku.max === 0) {
      parSuggestions.push({ name: sku.name, vendor: sku.vendor, type: 'Set Par', detail: `Bought ${st.bought} across ${st.runs} run(s) with Min/Max still 0/0.` });
    } else if (st.runs >= 3 && st.bought > sku.max * 2) {
      parSuggestions.push({ name: sku.name, vendor: sku.vendor, type: 'Raise Max', detail: `Ordered ${st.runs} times (${st.bought} bought). Consider raising Max above ${sku.max}.` });
    }
  });
  skuPool.forEach(s => {
    if (s.max > 0 && s.stock >= s.max * 1.5 && !(itemStats[s.id]?.bought > 0)) {
      parSuggestions.push({ name: s.name, vendor: s.vendor, type: 'Overstocked', detail: `Stock (${s.stock}) is above Max (${s.max}) with 0 buys in period.` });
    }
  });

  const lowCount = skuPool.filter(s => s.min > 0 && s.stock <= s.min).length;
  const noParCount = skuPool.filter(s => s.min === 0 && s.max === 0).length;
  const photoCount = skuPool.filter(s => (itemPhotos[s.id] || []).length > 0).length;
  const fulfillRate = totalNeeded > 0 ? Math.round((totalBought / totalNeeded) * 100) : 100;

  return {
    range, vendor, skuPool, receiveEvents, orderEvents, totalBought, totalNeeded,
    fulfillRate, mostBought, leastBought, shortItems,
    vendorList: Object.values(vendorStats).sort((a, b) => b.bought - a.bought),
    parSuggestions: parSuggestions.slice(0, 12),
    staffList: Object.entries(staffStats).map(([name, s]) => ({ name, ...s })),
    lowCount, noParCount, photoCount
  };
}

function renderReports() {
  const container = document.getElementById('reportsContent');
  if (!container) return;
  const m = computeReportMetrics();
  const maxTop = m.mostBought.length ? Math.max(1, m.mostBought[0].bought) : 1;
  const photoPct = m.skuPool.length ? Math.round((m.photoCount / m.skuPool.length) * 100) : 0;

  const emptyNotice = m.receiveEvents.length === 0 ? `
    <div style="background:var(--primary-light); border:1px solid rgba(217,107,39,0.28); color:var(--primary-dark); padding:11px 14px; border-radius:12px; font-size:12.5px; font-weight:600; margin-bottom:12px;">
      📊 Buying velocity charts start filling automatically as soon as your team completes its first <strong>Receive Stock</strong> run! Catalog Health &amp; Dead Stock insights are already live below.
    </div>
  ` : '';

  const topHtml = m.mostBought.length ? m.mostBought.slice(0, 10).map(it => {
    const pct = Math.max(6, Math.round((it.bought / maxTop) * 100));
    return `
      <div class="bar-row">
        <div class="bar-row-head">
          <span>${escapeHtml(it.name)} <span style="font-weight:500; color:var(--text-muted);">(${escapeHtml(it.vendor)})</span></span>
          <span>${it.bought} ${escapeHtml(it.unit)} · ${it.runs}x</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      </div>
    `;
  }).join('') : '<div style="font-size:12.5px; color:var(--text-muted);">No received purchases in this period yet.</div>';

  const leastHtml = m.leastBought.slice(0, 12).map(it => `
    <div style="display:flex; justify-content:space-between; font-size:12px; padding:5px 0; border-bottom:1px solid #F2EDE4; gap:8px;">
      <span><strong>${escapeHtml(it.name)}</strong> <span style="color:var(--text-muted);">(${escapeHtml(it.vendor)})</span></span>
      <span style="white-space:nowrap; color:var(--text-muted);">${it.bought} bought · Stock: ${it.stock}</span>
    </div>
  `).join('');

  const vendorHtml = m.vendorList.length ? m.vendorList.map(v => {
    const rate = v.needed > 0 ? Math.round((v.bought / v.needed) * 100) : 100;
    return `
      <div class="bar-row">
        <div class="bar-row-head">
          <span>${escapeHtml(v.vendor)} (${v.trips} line items)</span>
          <span>${v.bought} bought · ${rate}% filled</span>
        </div>
        <div class="bar-track"><div class="bar-fill indigo" style="width:${Math.max(8, rate)}%"></div></div>
      </div>
    `;
  }).join('') : '<div style="font-size:12.5px; color:var(--text-muted);">No vendor runs logged yet.</div>';

  const shortHtml = m.shortItems.length ? m.shortItems.slice(0, 8).map(it => {
    const rate = it.needed > 0 ? Math.round((it.bought / it.needed) * 100) : 100;
    return `<div style="font-size:12px; padding:4px 0; border-bottom:1px solid #F2EDE4;"><strong>${escapeHtml(it.name)}</strong> (${escapeHtml(it.vendor)}): Short ${it.shorts}x · ${rate}% fulfilled (${it.bought}/${it.needed})</div>`;
  }).join('') : '<div style="font-size:12.5px; color:var(--text-muted);">No recurring store shortages recorded.</div>';

  const parHtml = m.parSuggestions.length ? m.parSuggestions.map(p => `
    <div style="font-size:12px; padding:5px 8px; background:var(--bg); border-radius:8px; border:1px solid var(--border);">
      <span style="font-weight:800; color:var(--primary-dark);">[${escapeHtml(p.type)}]</span> <strong>${escapeHtml(p.name)}</strong>: ${escapeHtml(p.detail)}
    </div>
  `).join('') : '<div style="font-size:12.5px; color:var(--text-muted);">No par adjustments flagged right now.</div>';

  const staffHtml = m.staffList.length ? m.staffList.map(st => `
    <div style="display:flex; justify-content:space-between; font-size:12px; padding:4px 0; border-bottom:1px solid #F2EDE4;">
      <strong>${escapeHtml(st.name)}</strong>
      <span style="color:var(--text-muted);">${st.orders} orders · ${st.receives} receives · ${st.edits} edits</span>
    </div>
  `).join('') : '<div style="font-size:12.5px; color:var(--text-muted);">No staff activity logged yet.</div>';

  container.innerHTML = `
    ${emptyNotice}
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-value">${m.totalBought}</div><div class="kpi-label">Units Bought</div></div>
      <div class="kpi-card"><div class="kpi-value">${m.receiveEvents.length} / ${m.orderEvents.length}</div><div class="kpi-label">Receives / Orders</div></div>
      <div class="kpi-card"><div class="kpi-value" style="color:var(--success);">${m.fulfillRate}%</div><div class="kpi-label">Fill Rate</div></div>
      <div class="kpi-card"><div class="kpi-value" style="color:var(--secondary);">${m.lowCount} / ${photoPct}%</div><div class="kpi-label">Low Stock / Photos</div></div>
    </div>

    <div class="report-grid">
      <div class="report-card">
        <div class="report-card-title"><span>🔥 Most-Bought Items</span><span style="font-size:11px; color:var(--text-muted);">Top 10</span></div>
        ${topHtml}
      </div>

      <div class="report-card">
        <div class="report-card-title"><span>🧊 Least-Bought / Dead Stock</span><span style="font-size:11px; color:var(--text-muted);">Slowest 12</span></div>
        ${leastHtml}
      </div>

      <div class="report-card">
        <div class="report-card-title"><span>🏪 Vendor Activity &amp; Reliability</span></div>
        ${vendorHtml}
        <div style="font-size:12px; font-weight:800; margin-top:6px;">⚠️ Frequent Shortages</div>
        ${shortHtml}
      </div>

      <div class="report-card">
        <div class="report-card-title"><span>🎯 Smart Par &amp; Catalog Health</span><span style="font-size:11px; color:var(--text-muted);">${m.noParCount} at 0/0</span></div>
        ${parHtml}
        <div style="font-size:12px; font-weight:800; margin-top:6px;">👥 Team Activity</div>
        ${staffHtml}
      </div>
    </div>
  `;
}

function exportReportCsv() {
  const m = computeReportMetrics();
  const rows = [['Item', 'Vendor', 'Units Bought', 'Buying Runs', 'Units Needed', 'Shortages', 'Current Stock', 'Min', 'Max']];
  m.skuPool.forEach(s => {
    const st = m.mostBought.find(x => x.id === s.id);
    rows.push([s.name, s.vendor, st?.bought || 0, st?.runs || 0, st?.needed || 0, st?.shorts || 0, s.stock, s.min, s.max]);
  });
  downloadCsvFile(rows, `swirla-report-${new Date().toISOString().slice(0, 10)}.csv`);
}

function downloadCsvFile(rows, filename) {
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV exported', 'success');
}

async function sendReportSummaryTelegram() {
  if (!isLeaderOrManager()) return;
  if (!botToken || !chatId) { showToast('Configure Telegram settings first.', 'warning'); return; }
  const m = computeReportMetrics();
  const topLines = m.mostBought.slice(0, 5).map((x, i) => `${i + 1}. *${escapeTgMarkdown(x.name)}* — ${x.bought} ${escapeTgMarkdown(x.unit)} (${x.runs}x)`).join('\n') || '_No buys recorded yet_';
  const label = m.range === 'all' ? 'All Time' : `Last ${m.range} Days`;

  const text = `📊 *${escapeTgMarkdown(CFG.appName || 'Swirla Café')} — Management Summary (${label})*\n` +
    `• *Units Bought:* ${m.totalBought}\n` +
    `• *Fill Rate:* ${m.fulfillRate}%\n` +
    `• *Low Stock Items:* ${m.lowCount} | *Missing Pars (0/0):* ${m.noParCount}\n\n` +
    `🔥 *Top 5 Most-Bought:*\n${topLines}\n\n_Generated by ${escapeTgMarkdown(currentUser.name)}_`;

  const ok = await postTelegramMessage(text);
  if (ok) showToast('Management summary sent to Telegram!', 'success');
}

/* 15. Telegram Dispatch */
async function postTelegramMessage(text) {
  if (!botToken || !chatId) {
    showToast('Telegram not configured. Manager: tap ✈️ Telegram to set Token & Chat ID.', 'warning', 4500);
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });
    const data = await res.json();
    if (!data.ok) { showToast(`Telegram Error: ${data.description}`, 'error', 5000); return false; }
    return true;
  } catch (err) {
    showToast('Network error contacting Telegram.', 'error');
    return false;
  }
}

async function dispatchToTelegram(targetVendor = null) {
  if (!isLeaderOrManager()) return;
  const orderIds = Object.keys(buyOrders).filter(id => {
    const item = skus.find(s => s.id === id);
    return item && (!targetVendor || item.vendor === targetVendor);
  });
  if (!orderIds.length) { showToast('No items to send for this order.', 'warning'); return; }

  const grouped = {};
  const logItems = [];
  orderIds.forEach(id => {
    const item = skus.find(s => s.id === id);
    if (!grouped[item.vendor]) grouped[item.vendor] = [];
    grouped[item.vendor].push({ item, order: buyOrders[id] });
    logItems.push({ id: item.id, name: item.name, vendor: item.vendor, qty: Math.max(1, parseInt(buyOrders[id].qty) || 1), unit: buyOrders[id].unit || item.unit || 'Units' });
  });

  const timeStr = formatShortTime(Date.now());
  let text = `🛒 *${escapeTgMarkdown(CFG.appName || 'Swirla Café')} — ${targetVendor ? escapeTgMarkdown(targetVendor) + ' Order' : 'Buy Order'}*\n`;
  text += `👤 *Submitted by:* ${escapeTgMarkdown(currentUser.name)}\n📅 *${timeStr}*\n\n`;

  Object.keys(grouped).sort().forEach(vendor => {
    text += `📍 *${escapeTgMarkdown(vendor)}*\n`;
    grouped[vendor].forEach(({ item, order }) => {
      const unit = order.unit || item.unit || 'Units';
      const need = Math.max(1, parseInt(order.qty) || 1);
      text += `• *${escapeTgMarkdown(item.name)}* — *Qty: ${need} ${escapeTgMarkdown(unit)}* (Stock: ${item.stock})\n`;
      if (item.note) text += `   📌 _${escapeTgMarkdown(item.note)}_\n`;
      if (order.note && order.note.trim()) text += `   📝 _${escapeTgMarkdown(order.note.trim())}_\n`;
    });
    text += `\n`;
  });

  if (await postTelegramMessage(text)) {
    logHistory('order_sent', `Sent ${targetVendor || 'Full'} Order (${orderIds.length} items) to Telegram`, {
      vendors: Object.keys(grouped),
      items: logItems
    });
    showToast(`Order dispatched by ${currentUser.name}!`, 'success', 3500);
  }
}

async function dispatchBuyerReport() {
  const orderIds = Object.keys(buyOrders).filter(id => skus.some(s => s.id === id));
  if (!orderIds.length) { showToast('Checklist is empty.', 'warning'); return; }

  const grouped = {};
  const logItems = [];
  orderIds.forEach(id => {
    const item = skus.find(s => s.id === id);
    if (!grouped[item.vendor]) grouped[item.vendor] = [];
    grouped[item.vendor].push({ item, order: buyOrders[id] });
    logItems.push({ name: item.name, vendor: item.vendor, bought: getOrderBoughtQty(buyOrders[id]), unit: buyOrders[id].unit || item.unit || 'Units' });
  });

  let text = `🚚 *${escapeTgMarkdown(CFG.appName || 'Swirla Café')} — Buyer Run Update*\n`;
  text += `👤 *Buyer:* ${escapeTgMarkdown(currentUser.name)}\n📅 *${formatShortTime(Date.now())}*\n\n`;

  Object.keys(grouped).sort().forEach(vendor => {
    text += `📍 *${escapeTgMarkdown(vendor)}*\n`;
    grouped[vendor].forEach(({ item, order }) => {
      const unit = order.unit || item.unit || 'Units';
      const need = Math.max(1, parseInt(order.qty) || 1);
      const bought = getOrderBoughtQty(order);
      if (bought >= need) text += `✅ *${escapeTgMarkdown(item.name)}* — Bought *${bought}/${need} ${escapeTgMarkdown(unit)}*\n`;
      else if (bought > 0) text += `⚠️ *${escapeTgMarkdown(item.name)}* — Partial *${bought}/${need} ${escapeTgMarkdown(unit)}* (Short ${need - bought})\n`;
      else text += `❌ *${escapeTgMarkdown(item.name)}* — Not Bought (Need ${need} ${escapeTgMarkdown(unit)})\n`;
      if (order.note && order.note.trim()) text += `   📝 _${escapeTgMarkdown(order.note.trim())}_\n`;
    });
    text += `\n`;
  });

  if (await postTelegramMessage(text)) {
    logHistory('buyer_report', `Sent Buyer Run Update (${orderIds.length} items)`, { items: logItems });
    showToast('Buyer report sent to Telegram!', 'success', 3500);
  }
}

async function sendBuyerReceiptTelegram(entries) {
  if (!botToken || !chatId || !entries.length) return;
  let text = `📦 *${escapeTgMarkdown(CFG.appName || 'Swirla Café')} — Received into Stock*\n`;
  text += `👤 *Approved by:* ${escapeTgMarkdown(currentUser.name)}\n📅 *${formatShortTime(Date.now())}*\n\n`;
  entries.forEach(e => {
    const statusText = e.remaining > 0 ? `⚠️ *+${e.bought} ${escapeTgMarkdown(e.unit)}* (Short ${e.remaining})` : `✅ *+${e.bought} ${escapeTgMarkdown(e.unit)}*`;
    text += `• *${escapeTgMarkdown(e.name)}* (${escapeTgMarkdown(e.vendor)}) — ${statusText} → Stock: *${e.newStock}*\n`;
  });
  await postTelegramMessage(text);
}

/* 16. Modals: Team, Backups, Telegram, SKU Add/Edit, Item Detail */
function closeModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.style.display = 'none';
  if (modalId === 'itemDetailModal') activeDetailSkuId = null;
}

function handleTelegramBadgeClick() {
  if (isManager()) {
    document.getElementById('cfgBotToken').value = botToken;
    document.getElementById('cfgChatId').value = chatId;
    document.getElementById('telegramModal').style.display = 'flex';
  } else {
    showToast(botToken && chatId ? 'Telegram alerts are active.' : 'Ask Management to finish Telegram setup.', 'info');
  }
}

function saveTelegramSettings() {
  if (!isManager()) return;
  botToken = document.getElementById('cfgBotToken').value.trim();
  chatId = document.getElementById('cfgChatId').value.trim();
  localStorage.setItem(PREFIX + 'bot_token', botToken);
  localStorage.setItem(PREFIX + 'chat_id', chatId);
  db.ref(`${ROOT}/settings/telegram`).set({ botToken, chatId });
  updateTelegramBadgeUI();
  closeModal('telegramModal');
  showToast('Telegram settings saved privately to cloud', 'success');
}

function openAccountsModal() {
  if (!isManager()) return;
  resetAccountForm();
  renderAccountsModalList();
  document.getElementById('accountsModal').style.display = 'flex';
}

function resetAccountForm() {
  document.getElementById('accEditId').value = '';
  document.getElementById('accFormTitle').innerText = 'Add New Team Member';
  document.getElementById('accFormName').value = '';
  document.getElementById('accFormRole').value = 'leader';
  document.getElementById('accFormPin').value = '';
  document.getElementById('accCancelEditBtn').style.display = 'none';
}

function editAccount(id) {
  const acc = accounts.find(a => a.id === id);
  if (!acc) return;
  document.getElementById('accEditId').value = acc.id;
  document.getElementById('accFormTitle').innerText = `Edit ${acc.name}`;
  document.getElementById('accFormName').value = acc.name;
  document.getElementById('accFormRole').value = acc.role;
  document.getElementById('accFormPin').value = acc.pin;
  document.getElementById('accCancelEditBtn').style.display = 'inline-flex';
}

function saveAccountForm() {
  if (!isManager()) return;
  const id = document.getElementById('accEditId').value;
  const name = document.getElementById('accFormName').value.trim();
  const role = document.getElementById('accFormRole').value;
  const pin = document.getElementById('accFormPin').value.trim();
  if (!name) { showToast('Enter a name.', 'warning'); return; }
  if (!/^\d{4}$/.test(pin)) { showToast('PIN must be 4 digits.', 'warning'); return; }

  if (id) {
    const idx = accounts.findIndex(a => a.id === id);
    if (idx === -1) return;
    if (accounts[idx].role === 'manager' && role !== 'manager' && accounts.filter(a => a.role === 'manager' && a.id !== id).length === 0) {
      showToast('At least one Manager is required.', 'error'); return;
    }
    accounts[idx] = { ...accounts[idx], name, role, pin };
    if (currentUser && currentUser.id === id) {
      currentUser = accounts[idx];
      localStorage.setItem(PREFIX + 'session', JSON.stringify({ id: currentUser.id, pin: String(currentUser.pin) }));
      applyRoleUI();
    }
    showToast(`Updated ${name}`, 'success');
  } else {
    if (accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) { showToast('Name already exists.', 'warning'); return; }
    accounts.push({ id: 'acc_' + Date.now(), name, role, pin });
    showToast(`Added ${name}`, 'success');
  }
  pushAccountsToCloud();
  resetAccountForm();
  renderAccountsModalList();
}

function removeAccount(id) {
  if (!isManager()) return;
  const target = accounts.find(a => a.id === id);
  if (!target) return;
  if (target.role === 'manager' && accounts.filter(a => a.role === 'manager').length <= 1) { showToast('Cannot remove the only Manager.', 'error'); return; }
  if (currentUser && currentUser.id === id) { showToast('Switch to another Manager first.', 'warning'); return; }
  if (!confirm(`Revoke app access for "${target.name}"?`)) return;
  accounts = accounts.filter(a => a.id !== id);
  pushAccountsToCloud();
  renderAccountsModalList();
  showToast(`Removed ${target.name}`, 'info');
}

function renderAccountsModalList() {
  const container = document.getElementById('accountsList');
  if (!container) return;
  container.innerHTML = '';
  accounts.forEach(acc => {
    const row = document.createElement('div');
    row.className = 'list-row-card';
    row.innerHTML = `
      <div>
        <div style="font-weight:800; font-size:13.5px;">${escapeHtml(acc.name)}</div>
        <div style="display:flex; gap:6px; align-items:center; margin-top:2px;">
          <span class="role-pill role-${acc.role}">${roleLabel(acc.role)}</span>
          <span style="font-size:11px; color:var(--text-muted); font-weight:700;">PIN: ${escapeHtml(acc.pin)}</span>
        </div>
      </div>
      <div style="display:flex; gap:5px;">
        <button class="btn btn-outline" style="padding:4px 8px; font-size:11px;" onclick="editAccount('${acc.id}')">Edit</button>
        <button class="btn btn-outline" style="padding:4px 8px; font-size:11px; color:var(--danger);" onclick="removeAccount('${acc.id}')">✕</button>
      </div>
    `;
    container.appendChild(row);
  });
}

function openBackupsModal() {
  if (!isManager()) return;
  renderCloudBackupsList();
  document.getElementById('backupsModal').style.display = 'flex';
}

function saveCloudSnapshot() {
  if (!isManager()) return;
  const input = document.getElementById('snapshotLabelInput');
  const label = input.value.trim() || `Snapshot (${formatShortTime(Date.now())})`;
  const id = 'bk_' + Date.now();
  db.ref(`${ROOT}/backups/${id}`).set({
    id, label, createdBy: currentUser.name, createdAt: Date.now(),
    skus, orders: buyOrders, accounts, vendors, categories
  }).then(() => { input.value = ''; showToast('Cloud snapshot saved', 'success'); });
}

function renderCloudBackupsList() {
  const container = document.getElementById('cloudBackupsList');
  const items = Object.values(cloudBackups || {}).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!items.length) {
    container.innerHTML = `<div style="text-align:center; padding:12px; font-size:12px; color:var(--text-muted); background:var(--bg); border-radius:8px; border:1px dashed var(--border);">No cloud restore points yet.</div>`;
    return;
  }
  container.innerHTML = '';
  items.forEach(bk => {
    const skuLen = Array.isArray(bk.skus) ? bk.skus.length : (bk.skus ? Object.keys(bk.skus).length : 0);
    const row = document.createElement('div');
    row.className = 'list-row-card';
    row.innerHTML = `
      <div style="min-width:0;">
        <div style="font-size:13px; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(bk.label)}</div>
        <div style="font-size:11px; color:var(--text-muted);">${formatShortTime(bk.createdAt)} · ${skuLen} SKUs</div>
      </div>
      <div style="display:flex; gap:5px; flex-shrink:0;">
        <button class="btn btn-primary" style="padding:4px 8px; font-size:11px;" onclick="restoreCloudSnapshot('${bk.id}')">Restore</button>
        <button class="btn btn-outline" style="padding:4px 8px; font-size:11px; color:var(--danger);" onclick="deleteCloudSnapshot('${bk.id}')">✕</button>
      </div>
    `;
    container.appendChild(row);
  });
}

function restoreCloudSnapshot(bkId) {
  if (!isManager() || !cloudBackups[bkId]) return;
  const bk = cloudBackups[bkId];
  if (!confirm(`Restore "${bk.label}"? Live data will be overwritten.`)) return;
  if (bk.skus) { skus = Array.isArray(bk.skus) ? bk.skus : Object.values(bk.skus); pushSkusToCloud(); }
  buyOrders = bk.orders || {}; pushOrdersToCloud();
  if (bk.accounts) { accounts = Array.isArray(bk.accounts) ? bk.accounts : Object.values(bk.accounts); pushAccountsToCloud(); }
  if (bk.vendors) { vendors = uniqueSorted(bk.vendors); pushVendorsToCloud(); }
  if (bk.categories) { categories = uniqueSorted(bk.categories); pushCategoriesToCloud(); }
  closeModal('backupsModal');
  showToast(`Restored "${bk.label}"`, 'success', 4000);
}

function deleteCloudSnapshot(bkId) {
  if (!isManager() || !confirm('Delete this cloud snapshot?')) return;
  db.ref(`${ROOT}/backups/${bkId}`).remove();
  showToast('Snapshot deleted', 'info');
}

function downloadFullBackup() {
  if (!isManager()) return;
  const payload = { app: CFG.appName || 'Swirla Ops', exportedAt: new Date().toISOString(), skus, orders: buyOrders, accounts, vendors, categories, photos: itemPhotos, history: historyLogs };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${PREFIX}backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  URL.revokeObjectURL(url);
  showToast('Backup file downloaded', 'success');
}

function handleBackupFileUpload(event) {
  if (!isManager()) return;
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed || !Array.isArray(parsed.skus)) { showToast('Invalid backup file.', 'error'); return; }
      if (!confirm(`Restore ${parsed.skus.length} SKUs from backup file?`)) return;
      skus = parsed.skus; pushSkusToCloud();
      if (parsed.orders !== undefined) { buyOrders = parsed.orders || {}; pushOrdersToCloud(); }
      if (Array.isArray(parsed.accounts) && parsed.accounts.length) { accounts = parsed.accounts; pushAccountsToCloud(); }
      if (Array.isArray(parsed.vendors)) { vendors = uniqueSorted(parsed.vendors); pushVendorsToCloud(); }
      if (Array.isArray(parsed.categories)) { categories = uniqueSorted(parsed.categories); pushCategoriesToCloud(); }
      if (parsed.photos) { itemPhotos = parsed.photos; db.ref(`${ROOT}/photos`).set(itemPhotos); }
      closeModal('backupsModal');
      showToast('Full backup restored!', 'success', 4000);
    } catch (err) { showToast('Could not read JSON file.', 'error'); }
  };
  reader.readAsText(file);
  event.target.value = '';
}

function resetToOriginalCatalog() {
  if (!isManager()) return;
  if (!confirm('Reset catalog back to baseline items? Added SKUs, stock counts, and Min/Max edits will be reset.')) return;
  if (!confirm('Final confirmation: restore baseline SKUs and clear Buy Checklist?')) return;
  skus = JSON.parse(JSON.stringify(INITIAL_SKUS));
  buyOrders = {};
  vendors = uniqueSorted([...(CFG.defaultVendors || []), ...skus.map(s => s.vendor)]);
  categories = uniqueSorted([...(CFG.defaultCategories || []), ...skus.map(s => s.cat)]);
  pushSkusToCloud(); pushOrdersToCloud(); pushVendorsToCloud(); pushCategoriesToCloud();
  closeModal('backupsModal');
  showToast('Restored baseline catalog', 'success', 4000);
}

/* 17. SKU Add/Edit Modal & Duplicate Warning */
function checkDuplicateSkuName() {
  const editId = document.getElementById('editSkuId').value;
  const val = document.getElementById('editSkuName').value.trim().toLowerCase();
  const warn = document.getElementById('duplicateSkuWarning');
  if (!val) { warn.style.display = 'none'; return; }
  const match = skus.find(s => s.id !== editId && s.name.trim().toLowerCase() === val);
  if (match) {
    warn.innerText = `⚠️ "${match.name}" already exists under ${match.vendor}.`;
    warn.style.display = 'block';
  } else {
    warn.style.display = 'none';
  }
}

function openSkuModal(id = null) {
  if (!isLeaderOrManager()) return;
  populateFilters();
  const title = document.getElementById('skuModalTitle');
  const deleteBtn = document.getElementById('deleteSkuBtn');
  document.getElementById('duplicateSkuWarning').style.display = 'none';

  if (id) {
    const item = skus.find(s => s.id === id);
    if (!item) return;
    title.innerText = 'Edit SKU';
    document.getElementById('editSkuId').value = item.id;
    document.getElementById('editSkuName').value = item.name;
    document.getElementById('editSkuVendor').value = item.vendor;
    document.getElementById('editSkuCategory').value = item.cat;
    document.getElementById('editSkuStock').value = item.stock;
    document.getElementById('editSkuUnit').value = item.unit || '';
    document.getElementById('editSkuMin').value = item.min;
    document.getElementById('editSkuMax').value = item.max;
    document.getElementById('editSkuNote').value = item.note || '';
    deleteBtn.style.display = isManager() ? 'inline-flex' : 'none';
  } else {
    title.innerText = 'Add New SKU';
    document.getElementById('editSkuId').value = '';
    document.getElementById('editSkuName').value = '';
    document.getElementById('editSkuVendor').value = '';
    document.getElementById('editSkuCategory').value = '';
    document.getElementById('editSkuStock').value = 0;
    document.getElementById('editSkuUnit').value = '';
    document.getElementById('editSkuMin').value = 0;
    document.getElementById('editSkuMax').value = 0;
    document.getElementById('editSkuNote').value = '';
    deleteBtn.style.display = 'none';
  }
  document.getElementById('skuModal').style.display = 'flex';
}

function saveSkuModal() {
  if (!isLeaderOrManager()) return;
  const id = document.getElementById('editSkuId').value;
  const name = document.getElementById('editSkuName').value.trim();
  const vendor = document.getElementById('editSkuVendor').value.trim();
  const cat = document.getElementById('editSkuCategory').value.trim();
  const stock = Math.max(0, parseInt(document.getElementById('editSkuStock').value) || 0);
  const unit = document.getElementById('editSkuUnit').value.trim();
  const min = Math.max(0, parseInt(document.getElementById('editSkuMin').value) || 0);
  const max = Math.max(0, parseInt(document.getElementById('editSkuMax').value) || 0);
  const note = document.getElementById('editSkuNote').value.trim();

  if (!name || !vendor || !cat) { showToast('Select Vendor, Category, and enter Item Name.', 'warning'); return; }

  if (id) {
    const item = skus.find(s => s.id === id);
    if (item) {
      const oldStock = item.stock;
      item.name = name; item.vendor = vendor; item.cat = cat;
      item.stock = stock; item.min = min; item.max = max;
      if (unit) item.unit = unit; else delete item.unit;
      if (note) item.note = note; else delete item.note;
      item.updatedBy = currentUser.name; item.updatedAt = Date.now();
      logHistory('sku', `Edited SKU "${name}" (${vendor}) · Stock ${oldStock} → ${stock}, Min/Max ${min}/${max}`);
      showToast(`Updated ${name}`, 'success');
    }
  } else {
    const newSku = {
      id: Date.now().toString(),
      name, vendor, cat, stock, min, max,
      updatedBy: currentUser.name, updatedAt: Date.now()
    };
    if (unit) newSku.unit = unit;
    if (note) newSku.note = note;
    skus.unshift(newSku);
    logHistory('sku', `Created SKU "${name}" (${vendor}, ${cat}) · Initial Stock: ${stock}`);
    showToast(`Added ${name}`, 'success');
  }

  pushSkusToCloud();
  populateFilters();
  renderCatalog();
  renderChecklist();
  refreshOpenDetailModal();
  closeModal('skuModal');
}

function deleteCurrentSku() {
  if (!isManager()) return;
  const id = document.getElementById('editSkuId').value;
  const item = skus.find(s => s.id === id);
  if (!item || !confirm(`Delete "${item.name}" permanently for all staff?`)) return;

  skus = skus.filter(s => s.id !== id);
  pushSkusToCloud();
  if (buyOrders[id]) { delete buyOrders[id]; pushOrdersToCloud(); }
  if (itemPhotos[id]) { delete itemPhotos[id]; pushSkuPhotosToCloud(id); }
  logHistory('sku', `Deleted SKU "${item.name}" (${item.vendor})`);

  closeModal('skuModal');
  if (activeDetailSkuId === id) closeModal('itemDetailModal');
  populateFilters(); renderCatalog(); renderChecklist();
  showToast(`Deleted ${item.name}`, 'info');
}

/* 18. Item Detail & Gallery */
function openItemDetailModal(id) {
  const item = skus.find(s => s.id === id);
  if (!item) return;
  activeDetailSkuId = id;
  const unitLabel = item.unit || 'Units';
  document.getElementById('detailSkuVendor').innerText = item.vendor;
  document.getElementById('detailSkuName').innerText = item.name;
  document.getElementById('detailSkuCat').innerText = item.cat;
  document.getElementById('detailSkuUpdated').innerText = item.updatedBy ? `Updated by ${item.updatedBy}${item.updatedAt ? ' · ' + formatShortTime(item.updatedAt) : ''}` : '';
  document.getElementById('detailSkuStock').innerText = `${item.stock} ${unitLabel}`;
  document.getElementById('detailSkuMin').innerText = item.min;
  document.getElementById('detailSkuMax').innerText = item.max;

  const noteBox = document.getElementById('detailSkuNoteBox');
  if (item.note) {
    document.getElementById('detailSkuNoteText').innerText = item.note;
    noteBox.style.display = 'flex';
  } else {
    noteBox.style.display = 'none';
  }

  const leadOrMgr = isLeaderOrManager();
  document.getElementById('detailActionRow').style.display = leadOrMgr ? 'flex' : 'none';
  if (leadOrMgr) updateDetailOrderButton(id);

  renderDetailPhotos();
  document.getElementById('itemDetailModal').style.display = 'flex';
}

function updateDetailOrderButton(id) {
  const btn = document.getElementById('detailOrderBtn');
  const isOrdered = buyOrders[id] !== undefined;
  btn.className = `btn ${isOrdered ? 'btn-ordered' : 'btn-primary'}`;
  btn.innerText = isOrdered ? '✓ In Checklist' : '+ Order';
}

function editFromDetail() {
  if (!isLeaderOrManager() || !activeDetailSkuId) return;
  const id = activeDetailSkuId;
  closeModal('itemDetailModal');
  openSkuModal(id);
}

function toggleOrderFromDetail() {
  if (isLeaderOrManager() && activeDetailSkuId) toggleOrder(activeDetailSkuId);
}

function renderDetailPhotos() {
  const id = activeDetailSkuId;
  if (!id) return;
  const container = document.getElementById('detailGalleryList');
  const photos = Array.isArray(itemPhotos[id]) ? itemPhotos[id] : [];
  const mgr = isManager();
  document.getElementById('detailPhotoCount').innerText = photos.length;
  document.getElementById('detailAddBtn').style.display = photos.length >= 3 ? 'none' : 'inline-flex';

  if (!photos.length) {
    container.innerHTML = `<div style="text-align:center; padding:22px 10px; background:var(--bg); border-radius:10px; border:1px dashed var(--border); color:var(--text-muted); font-size:13px;">No reference photos yet. Tap <strong>📷 + Add Photo</strong> above.</div>`;
    return;
  }

  container.innerHTML = '';
  photos.forEach((photoUrl, index) => {
    const card = document.createElement('div');
    card.style.cssText = 'position:relative; background:#1B1A26; border-radius:10px; overflow:hidden; border:1px solid var(--border);';
    const delBtn = mgr ? `<button class="btn" style="position:absolute; top:8px; right:8px; background:#DC2626; color:#fff; padding:5px 10px; font-size:12px;" onclick="deletePhoto('${id}', ${index})">🗑️ Delete</button>` : '';
    card.innerHTML = `
      <img src="${photoUrl}" style="width:100%; max-height:360px; object-fit:contain; display:block;">
      <div style="position:absolute; top:8px; left:8px; background:rgba(0,0,0,0.7); color:#fff; font-size:11px; font-weight:700; padding:3px 8px; border-radius:6px;">Photo ${index + 1} of ${photos.length}</div>
      ${delBtn}
    `;
    container.appendChild(card);
  });
}

function deletePhoto(id, photoIndex) {
  if (!isManager() || !confirm('Delete this photo?')) return;
  const photos = Array.isArray(itemPhotos[id]) ? itemPhotos[id] : [];
  photos.splice(photoIndex, 1);
  if (!photos.length) delete itemPhotos[id];
  else itemPhotos[id] = photos;
  renderDetailPhotos();
  renderCatalog();
  if (!isEditingChecklist()) renderChecklist();
  pushSkuPhotosToCloud(id).then(() => showToast('Photo deleted', 'info'));
}

function triggerPhotoFromDetail() {
  if (activeDetailSkuId) triggerPhoto(activeDetailSkuId);
}

window.onload = function() {
  populateFilters();
  renderCatalog();
};
