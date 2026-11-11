/* ============================================================================
   SWIRLA OPS — APPLICATION ENGINE (v6 Manager Audit + Per-Item Receive + Order Qty)
   ============================================================================ */

const CFG = window.SWIRLA_CONFIG || {};
const ROOT = CFG.firebaseRoot || 'swirla';
const PREFIX = CFG.storagePrefix || 'swirla_';

(function applyBrandConfig() {
  const t = CFG.theme || {};
  const rs = document.documentElement.style;
  if (t.primary) rs.setProperty('--primary', t.primary);
  if (t.primaryDark) rs.setProperty('--primary-dark', t.primaryDark);
  if (t.primaryLight) rs.setProperty('--primary-light', t.primaryLight);
  if (t.secondary) rs.setProperty('--secondary', t.secondary);
  if (t.secondaryLight) rs.setProperty('--secondary-light', t.secondaryLight);
  if (t.accentGold) rs.setProperty('--accent-gold', t.accentGold);
  if (t.headerBg) rs.setProperty('--header-bg', t.headerBg);
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
const fbConfig = (CFG.firebaseConfig && CFG.firebaseConfig.apiKey)
  ? CFG.firebaseConfig
  : { databaseURL: CFG.firebaseDatabaseURL || 'https://swirla-inventory-default-rtdb.firebaseio.com' };
firebase.initializeApp(fbConfig);
const db = firebase.database();
const auth = (CFG.firebaseConfig && CFG.firebaseConfig.apiKey && typeof firebase.auth === 'function') ? firebase.auth() : null;
let realtimeListenersAttached = false;

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
let draftOrderQtys = {};
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
function roleLabel(r) { return r === 'manager' ? 'Manager' : (r === 'buyer' ? 'Buyer' : 'Shift Leader'); }
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeTgMarkdown(s) { return String(s ?? '').replace(/([_*`\[])/g, '\\$1'); }
function formatShortTime(ts) {
  return ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
}
function uniqueSorted(arr) {
  return [...new Set((arr || []).map(v => String(v || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
function getSuggestedOrderQty(item) {
  return (item && item.max > item.stock) ? (item.max - item.stock) : 1;
}
function showToast(msg, type = 'success', duration = 3000) {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  const icon = type === 'info' ? 'ℹ️' : type === 'warning' ? '⚠️' : type === 'error' ? '❌' : '✅';
  t.innerHTML = `<span>${icon}</span><span>${escapeHtml(msg)}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.classList.add('hide'); setTimeout(() => t.remove(), 220); }, duration);
}
function isEditingChecklist() {
  const a = document.activeElement;
  return !!(a && a.closest && a.closest('#checklistItemsList') && a.type !== 'checkbox');
}
function flushDeferredChecklistRender() {
  if (deferredChecklistRender) {
    deferredChecklistRender = false;
    setTimeout(() => { if (!isEditingChecklist()) renderChecklist(); }, 50);
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
  db.ref(`${ROOT}/history`).push({
    type, summary,
    actor: currentUser ? currentUser.name : 'System',
    actorRole: currentUser ? currentUser.role : 'system',
    ts: Date.now(), ...details
  });
}
function queueStockHistoryLog(item, oldVal, newVal) {
  if (oldVal === newVal) return;
  if (stockLogOrigin[item.id] === undefined) stockLogOrigin[item.id] = oldVal;
  clearTimeout(stockLogTimers[item.id]);
  stockLogTimers[item.id] = setTimeout(() => {
    const startVal = stockLogOrigin[item.id];
    delete stockLogOrigin[item.id];
    delete stockLogTimers[item.id];
    if (startVal !== undefined && startVal !== item.stock) {
      logHistory('stock_edit', `${item.name}: Stock ${startVal} → ${item.stock}`, {
        skuId: item.id, itemName: item.name, vendor: item.vendor, oldStock: startVal, newStock: item.stock
      });
    }
  }, 1200);
}

/* 5. Store Cloud Auth & Staff PIN Logic */
async function submitCloudLogin() {
  if (!auth) return;
  const email = document.getElementById('cloudLoginEmail').value.trim();
  const pass = document.getElementById('cloudLoginPassword').value;
  const errEl = document.getElementById('cloudAuthError');
  const btn = document.getElementById('cloudLoginBtn');
  if (!email || !pass) { errEl.innerText = 'Enter your store email and password.'; return; }
  errEl.innerText = ''; btn.disabled = true; btn.innerText = '⏳ Unlocking...';
  try {
    await auth.signInWithEmailAndPassword(email, pass);
    document.getElementById('cloudLoginPassword').value = '';
  } catch (err) {
    errEl.innerText = (err && err.code === 'auth/too-many-requests') ? 'Too many attempts. Wait a minute.' : 'Invalid store email or password.';
  } finally {
    btn.disabled = false; btn.innerText = '🔐 Unlock Store Console';
  }
}
async function logoutCloudStore() {
  if (!auth || !confirm('Lock this device? Next shift will need the Store Email & Password.')) return;
  localStorage.removeItem(PREFIX + 'session');
  localStorage.removeItem(PREFIX + 'skus');
  localStorage.removeItem(PREFIX + 'orders');
  await auth.signOut();
  location.reload();
}
function renderAuthProfiles() {
  const list = document.getElementById('authProfileList');
  if (!list) return;
  list.innerHTML = '';
  accounts.forEach(acc => {
    const btn = document.createElement('button');
    btn.className = 'profile-btn';
    btn.onclick = () => selectLoginProfile(acc.id);
    btn.innerHTML = `<div><div class="profile-name">${escapeHtml(acc.name)}</div><div style="font-size:11px; color:var(--text-muted);">Tap to enter PIN</div></div><span class="role-pill role-${acc.role}">${roleLabel(acc.role)}</span>`;
    list.appendChild(btn);
  });
}
function selectLoginProfile(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  pendingLoginAccount = acc; pinBuffer = ''; updatePinDots();
  document.getElementById('authError').innerText = '';
  document.getElementById('authSelectedName').innerText = acc.name;
  document.getElementById('authSelectedRole').innerText = roleLabel(acc.role);
  document.getElementById('authSubtitle').innerText = 'Enter your 4-digit PIN';
  document.getElementById('authProfileStep').style.display = 'none';
  document.getElementById('authPinStep').style.display = 'flex';
}
function backToProfileList() {
  pendingLoginAccount = null; pinBuffer = ''; updatePinDots();
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
function pressPinDigit(d) {
  if (!pendingLoginAccount || pinBuffer.length >= 4) return;
  document.getElementById('authError').innerText = '';
  pinBuffer += d; updatePinDots();
  if (pinBuffer.length === 4) {
    if (pinBuffer === String(pendingLoginAccount.pin)) completeLogin(pendingLoginAccount);
    else {
      document.getElementById('authError').innerText = 'Incorrect PIN. Try again.';
      setTimeout(() => { pinBuffer = ''; updatePinDots(); }, 320);
    }
  }
}
function backspacePinDigit() { if (pendingLoginAccount && pinBuffer.length) { pinBuffer = pinBuffer.slice(0, -1); updatePinDots(); } }
function clearPinBuffer() { pinBuffer = ''; document.getElementById('authError').innerText = ''; updatePinDots(); }
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
  backToProfileList(); renderAuthProfiles();
  document.getElementById('authOverlay').style.display = 'flex';
}
function restoreSavedSession() {
  if (currentUser) {
    const match = accounts.find(a => a.id === currentUser.id && String(a.pin) === String(currentUser.pin));
    if (!match) { logoutUser(); showToast('Access updated by Management.', 'warning', 4000); return; }
    currentUser = match; applyRoleUI(); return;
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

  // STRICT: History & Reports ONLY visible to Manager
  document.getElementById('tabHistory').style.display = mgr ? 'flex' : 'none';
  document.getElementById('tabReports').style.display = mgr ? 'flex' : 'none';

  document.getElementById('btnManageListsShortcut').style.display = leadOrMgr ? 'inline-flex' : 'none';
  document.getElementById('btnAddNewWrap').style.display = leadOrMgr ? 'block' : 'none';
  document.getElementById('catalogActionsRow').classList.toggle('no-add', !leadOrMgr);
  document.getElementById('addMenuMemberBtn').style.display = mgr ? 'flex' : 'none';
  document.getElementById('btnClearFulfilled').style.display = leadOrMgr ? 'inline-flex' : 'none';
  document.getElementById('btnClearAll').style.display = mgr ? 'inline-flex' : 'none';
  document.getElementById('checkoutUserDisplay').innerText = `${currentUser.name} (${roleLabel(currentUser.role)})`;

  // Bottom bar: ONLY Send Order (Leader/Manager) & Bought Report (no global Receive button)
  const checkoutActions = document.getElementById('checkoutActions');
  let html = '';
  if (leadOrMgr) {
    html += `<button class="btn btn-primary" id="sendTelegramBtn" style="padding:9px 12px; font-size:12.5px;" onclick="dispatchToTelegram()">✈️ Send Order</button>`;
  }
  html += `<button class="btn btn-outline" id="sendBuyerReportBtn" style="padding:9px 11px; font-size:12px;" onclick="dispatchBuyerReport()">🚚 Bought Report</button>`;
  checkoutActions.innerHTML = html;

  if (!mgr && (currentView === 'history' || currentView === 'reports')) {
    switchView(leadOrMgr ? 'catalog' : 'checklist');
  }
  renderCatalog();
  if (!isEditingChecklist()) renderChecklist();
  if (mgr && currentView === 'history') renderHistory();
  if (mgr && currentView === 'reports') renderReports();
  refreshOpenDetailModal();
}

document.addEventListener('keydown', e => {
  if (document.getElementById('authOverlay').style.display !== 'none' && pendingLoginAccount) {
    if (/^[0-9]$/.test(e.key)) pressPinDigit(e.key);
    else if (e.key === 'Backspace') backspacePinDigit();
    else if (e.key === 'Escape') backToProfileList();
  }
});
document.addEventListener('click', e => {
  const wrap = document.getElementById('btnAddNewWrap');
  const menu = document.getElementById('addNewMenu');
  if (menu && menu.classList.contains('open') && wrap && !wrap.contains(e.target)) menu.classList.remove('open');
});

/* 6. Firebase Auth Gate & Realtime Listeners */
let photoRenderTimer = null;
function schedulePhotoRender(changedSkuId) {
  if (activeDetailSkuId === changedSkuId) renderDetailPhotos();
  clearTimeout(photoRenderTimer);
  photoRenderTimer = setTimeout(() => {
    renderCatalog();
    if (!isEditingChecklist()) renderChecklist();
    else deferredChecklistRender = true;
    if (isManager() && currentView === 'reports') renderReports();
  }, 60);
}

function attachRealtimeListeners() {
  if (realtimeListenersAttached) return;
  realtimeListenersAttached = true;

  db.ref(`${ROOT}/accounts`).on('value', snap => {
    const data = snap.val();
    const parsed = Array.isArray(data) ? data : (data ? Object.values(data) : null);
    if (parsed && parsed.length) accounts = parsed;
    else { accounts = JSON.parse(JSON.stringify(DEFAULT_ACCOUNTS)); db.ref(`${ROOT}/accounts`).set(accounts); }
    renderAuthProfiles(); renderAccountsModalList(); populateHistoryUserFilter(); restoreSavedSession();
  });
  db.ref(`${ROOT}/vendors`).on('value', snap => {
    const data = snap.val();
    const parsed = Array.isArray(data) ? data : (data ? Object.values(data) : null);
    vendors = uniqueSorted([...(parsed || CFG.defaultVendors || []), ...skus.map(s => s.vendor)]);
    if (!parsed && vendors.length) db.ref(`${ROOT}/vendors`).set(vendors);
    populateFilters();
    if (document.getElementById('taxonomyModal').style.display === 'flex') renderTaxonomyList();
  });
  db.ref(`${ROOT}/categories`).on('value', snap => {
    const data = snap.val();
    const parsed = Array.isArray(data) ? data : (data ? Object.values(data) : null);
    categories = uniqueSorted([...(parsed || CFG.defaultCategories || []), ...skus.map(s => s.cat)]);
    if (!parsed && categories.length) db.ref(`${ROOT}/categories`).set(categories);
    populateFilters();
    if (document.getElementById('taxonomyModal').style.display === 'flex') renderTaxonomyList();
  });
  db.ref(`${ROOT}/skus`).on('value', snap => {
    const data = snap.val();
    const parsed = Array.isArray(data) ? data : (data ? Object.values(data) : null);
    if (parsed && parsed.length) {
      skus = parsed; localStorage.setItem(PREFIX + 'skus', JSON.stringify(skus));
      vendors = uniqueSorted([...vendors, ...skus.map(s => s.vendor)]);
      categories = uniqueSorted([...categories, ...skus.map(s => s.cat)]);
      populateFilters(); renderCatalog();
      if (!isEditingChecklist()) renderChecklist(); else deferredChecklistRender = true;
      if (isManager() && currentView === 'reports') renderReports();
      refreshOpenDetailModal();
    } else if (INITIAL_SKUS.length) {
      skus = JSON.parse(JSON.stringify(INITIAL_SKUS)); db.ref(`${ROOT}/skus`).set(skus);
    }
  });
  db.ref(`${ROOT}/orders`).on('value', snap => {
    buyOrders = snap.val() || {}; localStorage.setItem(PREFIX + 'orders', JSON.stringify(buyOrders));
    renderCatalog();
    if (!isEditingChecklist()) renderChecklist(); else deferredChecklistRender = true;
    if (activeDetailSkuId && document.getElementById('itemDetailModal').style.display === 'flex') updateDetailOrderButton(activeDetailSkuId);
  });
  db.ref(`${ROOT}/backups`).on('value', snap => {
    cloudBackups = snap.val() || {};
    if (document.getElementById('backupsModal').style.display === 'flex') renderCloudBackupsList();
  });
  db.ref(`${ROOT}/settings/telegram`).on('value', snap => {
    const val = snap.val();
    if (val) {
      if (val.botToken) { botToken = val.botToken; localStorage.setItem(PREFIX + 'bot_token', botToken); }
      if (val.chatId) { chatId = val.chatId; localStorage.setItem(PREFIX + 'chat_id', chatId); }
    }
    updateTelegramBadgeUI();
  });
  db.ref(`${ROOT}/history`).limitToLast(450).on('value', snap => {
    const raw = snap.val() || {};
    historyLogs = Object.entries(raw).map(([id, val]) => ({ id, ...val })).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const pill = document.getElementById('historyCount');
    if (pill) pill.innerText = historyLogs.length;
    if (isManager()) {
      populateHistoryUserFilter();
      if (currentView === 'history') renderHistory();
      if (currentView === 'reports') renderReports();
    }
  });
  const photosRef = db.ref(`${ROOT}/photos`);
  photosRef.on('child_added', s => { itemPhotos[s.key] = Array.isArray(s.val()) ? s.val() : (s.val() ? [s.val()] : []); schedulePhotoRender(s.key); });
  photosRef.on('child_changed', s => { itemPhotos[s.key] = Array.isArray(s.val()) ? s.val() : (s.val() ? [s.val()] : []); schedulePhotoRender(s.key); });
  photosRef.on('child_removed', s => { delete itemPhotos[s.key]; schedulePhotoRender(s.key); });
}

if (auth) {
  auth.onAuthStateChanged(user => {
    const cloudStep = document.getElementById('authCloudStep');
    const profStep = document.getElementById('authProfileStep');
    const pinStep = document.getElementById('authPinStep');
    const signOutBtn = document.getElementById('btnCloudSignOut');
    const sub = document.getElementById('authSubtitle');
    if (user) {
      if (cloudStep) cloudStep.style.display = 'none';
      if (signOutBtn) signOutBtn.style.display = 'block';
      if (!currentUser && profStep && (!pinStep || pinStep.style.display === 'none')) profStep.style.display = 'block';
      if (sub && !pendingLoginAccount) sub.innerText = 'Select your account to sign in';
      attachRealtimeListeners();
    } else {
      currentUser = null; pendingLoginAccount = null;
      if (cloudStep) cloudStep.style.display = 'flex';
      if (profStep) profStep.style.display = 'none';
      if (pinStep) pinStep.style.display = 'none';
      if (signOutBtn) signOutBtn.style.display = 'none';
      if (sub) sub.innerText = 'Store Cloud Sign-In (One-Time Setup)';
      document.getElementById('authOverlay').style.display = 'flex';
    }
  });
} else {
  const profStep = document.getElementById('authProfileStep');
  if (profStep) profStep.style.display = 'block';
  attachRealtimeListeners();
}

function pushAccountsToCloud() { db.ref(`${ROOT}/accounts`).set(accounts); }
function pushVendorsToCloud() { db.ref(`${ROOT}/vendors`).set(uniqueSorted(vendors)); }
function pushCategoriesToCloud() { db.ref(`${ROOT}/categories`).set(uniqueSorted(categories)); }
function pushSkusToCloud() { db.ref(`${ROOT}/skus`).set(skus); localStorage.setItem(PREFIX + 'skus', JSON.stringify(skus)); }
function pushOrdersToCloud() { db.ref(`${ROOT}/orders`).set(buyOrders); localStorage.setItem(PREFIX + 'orders', JSON.stringify(buyOrders)); }
function updateTelegramBadgeUI() {
  const b = document.getElementById('telegramStatusBadge');
  if (b) b.innerText = (botToken && chatId) ? '✈️ Telegram On' : '✈️ Setup Telegram';
}

/* 7. Photo Cloud Sync & Dual Picker */
function pushSkuPhotosToCloud(id) {
  const photos = Array.isArray(itemPhotos[id]) ? itemPhotos[id] : [];
  return photos.length === 0 ? db.ref(`${ROOT}/photos/${id}`).remove() : db.ref(`${ROOT}/photos/${id}`).set(photos);
}
function handleThumbnailClick(id) {
  const photos = Array.isArray(itemPhotos[id]) ? itemPhotos[id] : [];
  if (photos.length > 0) openItemDetailModal(id); else triggerPhoto(id);
}
function triggerPhoto(id) {
  activeCameraSkuId = id;
  if ((itemPhotos[id] || []).length >= 3 && !confirm('Item already has 3 photos. Adding another replaces the oldest. Continue?')) return;
  document.getElementById('photoSourceModal').style.display = 'flex';
}
function launchPhotoInput(mode) {
  closeModal('photoSourceModal');
  const el = document.getElementById(mode === 'camera' ? 'cameraInputLive' : 'cameraInputGallery');
  if (el) el.click();
}
function handlePhotoCapture(event) {
  const file = event.target.files[0], targetSkuId = activeCameraSkuId;
  if (!file || !targetSkuId) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'), maxDim = 720;
      let w = img.width, h = img.height;
      if (w > h && w > maxDim) { h = Math.round((h * maxDim) / w); w = maxDim; }
      else if (h > maxDim) { w = Math.round((w * maxDim) / h); h = maxDim; }
      c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = c.toDataURL('image/jpeg', 0.60);
      if (!Array.isArray(itemPhotos[targetSkuId])) itemPhotos[targetSkuId] = [];
      if (itemPhotos[targetSkuId].length >= 3) itemPhotos[targetSkuId].shift();
      itemPhotos[targetSkuId].push(dataUrl);
      renderCatalog();
      if (!isEditingChecklist()) renderChecklist();
      if (activeDetailSkuId === targetSkuId) renderDetailPhotos();
      pushSkuPhotosToCloud(targetSkuId)
        .then(() => showToast(`Photo synced (${itemPhotos[targetSkuId].length}/3)`, 'success'))
        .catch(() => showToast('Cloud photo sync failed.', 'error'));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file); event.target.value = '';
}

/* 8. Navigation, Sticky Filter Drawer & "+ Add New" Menu */
function switchView(view) {
  if (!isManager() && (view === 'history' || view === 'reports')) view = isLeaderOrManager() ? 'catalog' : 'checklist';
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
  const hasActive = !!(document.getElementById('vendorFilter').value || document.getElementById('categoryFilter').value || filterZeroStock);
  document.getElementById('toggleFiltersBtn').classList.toggle('has-active', hasActive);
  document.getElementById('clearSearchBtn').style.display = document.getElementById('searchBox').value ? 'flex' : 'none';
}
function onSearchInput() { updateFilterIndicators(); renderCatalog(); }
function clearCatalogSearch() { document.getElementById('searchBox').value = ''; updateFilterIndicators(); renderCatalog(); }
function onFilterChange() { updateFilterIndicators(); renderCatalog(); }
function toggleLowStockFilter() { filterLowStock = !filterLowStock; document.getElementById('filterLowStockBtn').classList.toggle('active-danger', filterLowStock); renderCatalog(); }
function toggleNeedsParFilter() { filterNeedsPar = !filterNeedsPar; document.getElementById('filterNeedsParBtn').classList.toggle('active', filterNeedsPar); renderCatalog(); }
function toggleZeroStockFilter() { filterZeroStock = !filterZeroStock; document.getElementById('filterZeroStockBtn').classList.toggle('active-danger', filterZeroStock); updateFilterIndicators(); renderCatalog(); }
function resetAllCatalogFilters() {
  document.getElementById('searchBox').value = '';
  document.getElementById('vendorFilter').value = '';
  document.getElementById('categoryFilter').value = '';
  filterLowStock = filterNeedsPar = filterZeroStock = false;
  document.getElementById('filterLowStockBtn').classList.remove('active-danger');
  document.getElementById('filterNeedsParBtn').classList.remove('active');
  document.getElementById('filterZeroStockBtn').classList.remove('active-danger');
  updateFilterIndicators(); renderCatalog();
}
function toggleAddNewMenu(e) { e.stopPropagation(); document.getElementById('addNewMenu').classList.toggle('open'); }
function handleAddMenuChoice(choice) {
  document.getElementById('addNewMenu').classList.remove('open');
  if (choice === 'sku') openSkuModal();
  else if (choice === 'vendor') openTaxonomyModal('vendor', true);
  else if (choice === 'category') openTaxonomyModal('category', true);
  else if (choice === 'member') { openAccountsModal(); setTimeout(() => document.getElementById('accFormName').focus(), 100); }
  else if (choice === 'manage_lists') openTaxonomyModal('vendor', false);
}

/* 9. Vendor & Category Lists Manager */
function populateFilters() {
  const allVendors = uniqueSorted([...vendors, ...skus.map(s => s.vendor)]);
  const allCats = uniqueSorted([...categories, ...skus.map(s => s.cat)]);
  const fill = (id, list, firstLabel) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = `<option value="">${firstLabel}</option>` + list.map(x => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('');
    if (prev && list.includes(prev)) sel.value = prev;
  };
  fill('vendorFilter', allVendors, 'All Vendors');
  fill('categoryFilter', allCats, 'All Categories');
  fill('reportVendorFilter', allVendors, 'All Vendors');
  fill('editSkuVendor', allVendors, 'Select Vendor...');
  fill('editSkuCategory', allCats, 'Select Category...');
}
function openTaxonomyModal(tab = 'vendor', focus = false) {
  if (!isLeaderOrManager()) return;
  switchTaxonomyTab(tab);
  document.getElementById('taxonomyModal').style.display = 'flex';
  if (focus) setTimeout(() => document.getElementById('taxonomyNameInput').focus(), 100);
}
function switchTaxonomyTab(tab) {
  activeTaxonomyTab = tab; resetTaxonomyForm();
  document.getElementById('taxTabVendor').className = tab === 'vendor' ? 'btn btn-primary' : 'btn btn-outline';
  document.getElementById('taxTabCategory').className = tab === 'category' ? 'btn btn-primary' : 'btn btn-outline';
  document.getElementById('taxonomyNameInput').placeholder = tab === 'vendor' ? 'New vendor name' : 'New category name';
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
  document.getElementById('taxonomyEditLabel').innerText = `Renaming "${name}"`;
  document.getElementById('taxonomyEditHint').style.display = 'flex';
  document.getElementById('taxonomyNameInput').focus();
}
function saveTaxonomyItem() {
  if (!isLeaderOrManager()) return;
  const oldName = document.getElementById('taxonomyOldName').value.trim();
  const newName = document.getElementById('taxonomyNameInput').value.trim();
  if (!newName) { showToast('Enter a name first.', 'warning'); return; }
  const isV = activeTaxonomyTab === 'vendor', list = isV ? vendors : categories;
  if (oldName) {
    if (oldName === newName) { resetTaxonomyForm(); return; }
    if (list.some(x => x.toLowerCase() === newName.toLowerCase() && x !== oldName)) { showToast('Name already exists.', 'warning'); return; }
    const idx = list.indexOf(oldName);
    if (idx !== -1) list[idx] = newName; else list.push(newName);
    let updated = 0;
    skus.forEach(s => { if ((isV ? s.vendor : s.cat) === oldName) { if (isV) s.vendor = newName; else s.cat = newName; updated++; } });
    if (updated) pushSkusToCloud();
    logHistory('sku', `Renamed ${isV ? 'Vendor' : 'Category'}: "${oldName}" → "${newName}" (${updated} SKUs)`);
    showToast(`Renamed to "${newName}"`, 'success');
  } else {
    if (list.some(x => x.toLowerCase() === newName.toLowerCase())) { showToast('Already on list.', 'warning'); return; }
    list.push(newName);
    logHistory('sku', `Added ${isV ? 'Vendor' : 'Category'}: "${newName}"`);
    showToast(`Added "${newName}"`, 'success');
  }
  if (isV) { vendors = uniqueSorted(list); pushVendorsToCloud(); } else { categories = uniqueSorted(list); pushCategoriesToCloud(); }
  resetTaxonomyForm(); populateFilters(); renderTaxonomyList(); renderCatalog();
}
function deleteTaxonomyItem(name) {
  if (!isManager()) { showToast('Managers only.', 'error'); return; }
  const isV = activeTaxonomyTab === 'vendor';
  const used = skus.filter(s => (isV ? s.vendor : s.cat) === name).length;
  if (used) { showToast(`${used} SKU(s) still use "${name}".`, 'warning', 4000); return; }
  if (!confirm(`Delete unused "${name}"?`)) return;
  if (isV) { vendors = vendors.filter(v => v !== name); pushVendorsToCloud(); } else { categories = categories.filter(c => c !== name); pushCategoriesToCloud(); }
  logHistory('sku', `Deleted ${isV ? 'Vendor' : 'Category'}: "${name}"`);
  populateFilters(); renderTaxonomyList(); showToast(`Deleted "${name}"`, 'info');
}
function renderTaxonomyList() {
  const c = document.getElementById('taxonomyList');
  if (!c) return;
  const isV = activeTaxonomyTab === 'vendor', list = uniqueSorted(isV ? vendors : categories), mgr = isManager();
  c.innerHTML = '';
  list.forEach(name => {
    const count = skus.filter(s => (isV ? s.vendor : s.cat) === name).length;
    const row = document.createElement('div');
    row.className = 'list-row-card';
    row.innerHTML = `
      <div><div style="font-size:13.5px; font-weight:800;">${escapeHtml(name)}</div><div style="font-size:11px; color:var(--text-muted);">${count} item${count === 1 ? '' : 's'}</div></div>
      <div style="display:flex; gap:5px;">
        <button class="btn btn-outline" style="padding:4px 8px; font-size:11px;" data-name="${escapeHtml(name)}" onclick="startRenameTaxonomy(this.dataset.name)">Rename</button>
        ${mgr ? `<button class="btn btn-outline" style="padding:4px 8px; font-size:11px; color:var(--danger);" data-name="${escapeHtml(name)}" onclick="deleteTaxonomyItem(this.dataset.name)">✕</button>` : ''}
      </div>`;
    c.appendChild(row);
  });
}
function quickAddTaxonomyFromSku(type) {
  const label = type === 'vendor' ? 'Vendor' : 'Category';
  const raw = prompt(`Enter new ${label} name:`);
  if (!raw || !raw.trim()) return;
  const name = raw.trim(), list = type === 'vendor' ? vendors : categories;
  const existing = list.find(x => x.toLowerCase() === name.toLowerCase()), finalName = existing || name;
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

/* 10. Catalog Rendering, Stock Controls & Editable Order Qty */
function renderCatalog() {
  const q = document.getElementById('searchBox').value.toLowerCase().trim();
  const v = document.getElementById('vendorFilter').value;
  const c = document.getElementById('categoryFilter').value;
  const grid = document.getElementById('itemsGrid');
  const leadOrMgr = isLeaderOrManager();

  const lowCount = skus.filter(s => s.min > 0 && s.stock <= s.min).length;
  const needsParCount = skus.filter(s => s.min === 0 && s.max === 0).length;
  const zeroCount = skus.filter(s => s.stock === 0).length;
  document.getElementById('filterLowStockBtn').innerText = `⚠️ Low (${lowCount})`;
  document.getElementById('filterNeedsParBtn').innerText = `⚙️ 0/0 (${needsParCount})`;
  document.getElementById('filterZeroStockBtn').innerText = `🚫 Out of Stock (${zeroCount})`;

  const filtered = skus.filter(item => {
    const mq = !q || item.name.toLowerCase().includes(q) || item.vendor.toLowerCase().includes(q) || (item.note || '').toLowerCase().includes(q);
    return mq && (!v || item.vendor === v) && (!c || item.cat === c) && (!filterLowStock || (item.min > 0 && item.stock <= item.min)) && (!filterNeedsPar || (item.min === 0 && item.max === 0)) && (!filterZeroStock || item.stock === 0);
  });

  document.getElementById('catalogCount').innerText = filtered.length;
  document.getElementById('catalogMetaBar').innerHTML = `<span>Showing <strong>${filtered.length}</strong> of ${skus.length} SKUs</span><span>${lowCount} below min · ${zeroCount} at 0</span>`;

  if (!filtered.length) {
    grid.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:42px 16px; color:var(--text-muted);"><div style="font-size:32px; margin-bottom:8px;">🔍</div><div style="font-weight:800; color:var(--text);">No matching items found</div><button class="btn btn-outline" style="margin-top:12px;" onclick="resetAllCatalogFilters()">Reset Filters</button></div>`;
    updateChecklistBadge(); return;
  }

  grid.innerHTML = '';
  filtered.forEach(item => {
    const isBelowMin = item.min > 0 && item.stock <= item.min;
    const isNearMin = !isBelowMin && item.min > 0 && item.stock <= item.min + 1;
    const isNoPar = item.min === 0 && item.max === 0;
    const stateCls = isBelowMin ? 'below-min' : (isNearMin ? 'near-min' : (isNoPar ? 'no-par' : ''));
    const isOrdered = buyOrders[item.id] !== undefined;
    const photos = Array.isArray(itemPhotos[item.id]) ? itemPhotos[item.id] : [];
    const latestPhoto = photos[photos.length - 1];
    const unitLabel = item.unit || 'Units';
    const suggestQty = getSuggestedOrderQty(item);
    const orderQtyVal = isOrdered ? Math.max(1, parseInt(buyOrders[item.id].qty) || 1) : (draftOrderQtys[item.id] || suggestQty);
    const stampHtml = item.updatedBy ? ` · ${escapeHtml(item.updatedBy)}` : '';

    const stockControlsHtml = leadOrMgr ? `
      <div class="sku-qty-controls">
        <button class="qty-btn" onclick="updateStock('${item.id}', -1)">−</button>
        <input type="number" id="stockInp_${item.id}" class="qty-input" value="${item.stock}" min="0" onfocus="this.select()" onchange="setStock('${item.id}', this.value)">
        <button class="qty-btn" onclick="updateStock('${item.id}', 1)">+</button>
      </div>` : `<span style="font-size:11px; font-weight:700; color:var(--text-muted);">Min ${item.min} / Max ${item.max}</span>`;

    const actionsHtml = leadOrMgr ? `
      <button class="btn btn-outline" style="flex:0.75;" onclick="openSkuModal('${item.id}')">✏️ Edit</button>
      <div class="order-action-group ${isOrdered ? 'ordered' : ''}">
        <input type="number" id="orderQtyInp_${item.id}" class="order-qty-input" value="${orderQtyVal}" min="1" onfocus="this.select()" oninput="onCatalogOrderQtyInput('${item.id}', this.value)" onchange="commitCatalogOrderQty('${item.id}', this.value)" title="Edit order quantity (Auto: ${suggestQty})">
        <button class="btn-order-submit" onclick="toggleOrder('${item.id}')">${isOrdered ? '✓ In List' : '+ Order'}</button>
      </div>` : `
      <button class="btn btn-outline" onclick="triggerPhoto('${item.id}')">📷 Add Photo</button>
      <button class="btn btn-primary" onclick="openItemDetailModal('${item.id}')">👁️ Details</button>`;

    const card = document.createElement('div');
    card.className = `sku-card ${stateCls}`;
    card.innerHTML = `
      <div class="sku-header">
        <div class="photo-trigger" onclick="handleThumbnailClick('${item.id}')">
          ${latestPhoto ? `<img src="${latestPhoto}"><span class="photo-count-badge">${photos.length}/3</span>` : `<span>📷</span><span>Photo</span>`}
        </div>
        <div class="sku-info">
          <div class="sku-badges-row"><span class="sku-vendor">${escapeHtml(item.vendor)}</span>${item.stock === 0 ? '<span class="sku-zero-tag">Out of Stock</span>' : ''}</div>
          <div class="sku-name" title="${escapeHtml(item.name)}" onclick="openItemDetailModal('${item.id}')">${escapeHtml(item.name)}</div>
          <div class="sku-cat">${escapeHtml(item.cat)}</div>
        </div>
      </div>
      ${item.note ? `<div class="sku-note-pill"><span>📝</span><span>${escapeHtml(item.note)}</span></div>` : ''}
      <div class="sku-stock-row">
        <div style="cursor:${leadOrMgr ? 'pointer' : 'default'};" onclick="${leadOrMgr ? `focusStockInput('${item.id}')` : ''}">
          <span style="font-weight:800;">${item.stock} ${escapeHtml(unitLabel)}</span>
          ${isBelowMin ? '<span style="color:var(--danger); font-size:11px; font-weight:700; margin-left:4px;">Low</span>' : ''}
          <div style="font-size:10px; color:var(--text-muted);">Min ${item.min} / Max ${item.max}${stampHtml}</div>
        </div>
        ${stockControlsHtml}
      </div>
      <div class="sku-card-actions">${actionsHtml}</div>`;
    grid.appendChild(card);
  });
  updateChecklistBadge();
}

function focusStockInput(id) { const el = document.getElementById(`stockInp_${id}`); if (el) { el.focus(); el.select(); } }
function updateStock(id, delta) {
  if (!isLeaderOrManager()) return;
  const item = skus.find(s => s.id === id); if (!item) return;
  const old = item.stock;
  item.stock = Math.max(0, item.stock + delta);
  item.updatedBy = currentUser.name; item.updatedAt = Date.now();
  queueStockHistoryLog(item, old, item.stock); pushSkusToCloud(); renderCatalog();
}
function setStock(id, val) {
  if (!isLeaderOrManager()) return;
  const item = skus.find(s => s.id === id); if (!item) return;
  const old = item.stock;
  item.stock = Math.max(0, parseInt(val) || 0);
  item.updatedBy = currentUser.name; item.updatedAt = Date.now();
  queueStockHistoryLog(item, old, item.stock); pushSkusToCloud(); renderCatalog();
}
function onCatalogOrderQtyInput(id, val) {
  if (!isLeaderOrManager()) return;
  const qty = Math.max(1, parseInt(val) || 1);
  if (buyOrders[id]) {
    buyOrders[id].qty = qty;
    buyOrders[id].done = getOrderBoughtQty(buyOrders[id]) >= qty;
  } else {
    draftOrderQtys[id] = qty;
  }
}
function commitCatalogOrderQty(id, val) {
  if (!isLeaderOrManager()) return;
  const qty = Math.max(1, parseInt(val) || 1);
  if (buyOrders[id]) {
    buyOrders[id].qty = qty;
    buyOrders[id].done = getOrderBoughtQty(buyOrders[id]) >= qty;
    pushOrdersToCloud(); renderChecklist();
    const item = skus.find(s => s.id === id);
    if (item) showToast(`Updated ${item.name} order qty to ${qty}`, 'info');
  } else {
    draftOrderQtys[id] = qty;
  }
}

/* 11. Buy Checklist & Item-by-Item Anti-Theft Verification */
function toggleOrder(id, customQty = null) {
  if (!isLeaderOrManager()) return;
  const item = skus.find(s => s.id === id); if (!item) return;
  if (buyOrders[id]) {
    const prev = buyOrders[id].qty || 1;
    delete buyOrders[id]; delete draftOrderQtys[id];
    logHistory('checklist', `Removed ${item.name} from Buy Checklist (was Qty ${prev})`, { itemName: item.name, vendor: item.vendor });
    showToast(`Removed ${item.name}`, 'info');
  } else {
    const inp = document.getElementById(`orderQtyInp_${id}`);
    const orderQty = Math.max(1, parseInt(customQty ?? inp?.value ?? draftOrderQtys[id] ?? getSuggestedOrderQty(item)) || 1);
    delete draftOrderQtys[id];
    buyOrders[id] = { qty: orderQty, bought: 0, done: false, unit: item.unit || 'Units', note: '', addedBy: currentUser ? currentUser.name : 'Staff' };
    logHistory('checklist', `Added ${item.name} (${orderQty} ${item.unit || 'Units'}) to Buy Checklist`, { itemName: item.name, vendor: item.vendor });
    showToast(`Added ${item.name} (${orderQty})`, 'success');
  }
  pushOrdersToCloud(); renderCatalog(); renderChecklist();
  if (activeDetailSkuId === id) updateDetailOrderButton(id);
}
function updateChecklistBadge() {
  const b = document.getElementById('checklistCount');
  if (b) b.innerText = Object.keys(buyOrders).filter(id => skus.some(s => s.id === id)).length;
}
function getOrderBoughtQty(o) {
  const need = Math.max(1, parseInt(o.qty) || 1);
  return (o.bought !== undefined && o.bought !== null) ? Math.max(0, parseInt(o.bought) || 0) : (o.done ? need : 0);
}
function getLeaderRecQty(o) {
  return (o.recQty !== undefined && o.recQty !== null) ? Math.max(0, parseInt(o.recQty) || 0) : getOrderBoughtQty(o);
}
function getStatusInfo(need, bought) {
  if (bought >= need) return { cls: 'status-bought', text: `Bought (${bought}/${need})`, done: true };
  if (bought > 0) return { cls: 'status-partial', text: `Partial (${bought}/${need})`, done: false };
  return { cls: 'status-pending', text: 'Pending', done: false };
}

function renderChecklist() {
  const container = document.getElementById('checklistItemsList');
  const orderIds = Object.keys(buyOrders).filter(id => skus.some(s => s.id === id));
  if (!orderIds.length) {
    container.innerHTML = `<div style="text-align:center; padding:42px 16px; color:var(--text-muted);"><div style="font-size:32px; margin-bottom:8px;">📋</div><div style="font-weight:800; color:var(--text);">Buying checklist is empty</div><div style="font-size:13px; margin-top:4px;">Shift Leaders can tap "+ Order" on catalog items to build a shopping list.</div></div>`;
    return;
  }

  const mgr = isManager(), leadOrMgr = isLeaderOrManager(), isBuyer = !!(currentUser && currentUser.role === 'buyer');
  const grouped = {};
  orderIds.forEach(id => {
    const item = skus.find(s => s.id === id);
    if (item) { (grouped[item.vendor] = grouped[item.vendor] || []).push({ item, order: buyOrders[id] }); }
  });

  container.innerHTML = '';
  Object.keys(grouped).sort().forEach(vendor => {
    const groupCard = document.createElement('div');
    groupCard.className = 'vendor-group';
    const verifiedCount = grouped[vendor].filter(({ order }) => !!order.leaderChecked).length;

    let itemsHtml = '';
    grouped[vendor].forEach(({ item, order }) => {
      const photos = Array.isArray(itemPhotos[item.id]) ? itemPhotos[item.id] : [];
      const latestPhoto = photos[photos.length - 1];
      const currentUnit = order.unit || item.unit || 'Units';
      const needQty = Math.max(1, parseInt(order.qty) || 1);
      const boughtQty = getOrderBoughtQty(order);
      const recQty = getLeaderRecQty(order);
      const isChecked = !!order.leaderChecked;
      const hasMismatch = boughtQty > 0 && recQty !== boughtQty;
      const status = getStatusInfo(needQty, boughtQty);
      const unitOptions = STANDARD_UNITS.includes(currentUnit) ? STANDARD_UNITS : [currentUnit, ...STANDARD_UNITS];
      const unitSelectHtml = unitOptions.map(u => `<option value="${escapeHtml(u)}" ${u === currentUnit ? 'selected' : ''}>${escapeHtml(u)}</option>`).join('');

      const leftCheckHtml = (isBuyer || mgr) ? `<input type="checkbox" id="clCheck_${item.id}" style="transform:scale(1.2); flex-shrink:0;" ${status.done ? 'checked' : ''} ${isChecked ? 'disabled title="Locked after delivery check"' : ''} onchange="toggleDone('${item.id}')">` : '';

      const needHtml = leadOrMgr ? `
        <div class="cl-field-group">
          <span style="font-size:11.5px; font-weight:700; color:var(--text-muted);">Need:</span>
          <button class="qty-btn" onclick="adjustOrderQty('${item.id}', -1)">−</button>
          <input type="number" class="qty-input" value="${needQty}" min="1" oninput="onOrderQtyInput('${item.id}', this.value)" onchange="pushOrdersToCloud()" onblur="flushDeferredChecklistRender()">
          <button class="qty-btn" onclick="adjustOrderQty('${item.id}', 1)">+</button>
          <select class="cl-unit-select" onchange="setOrderUnit('${item.id}', this.value)" onblur="flushDeferredChecklistRender()">${unitSelectHtml}</select>
        </div>` : `<div class="cl-field-group"><span style="font-size:12px; font-weight:800; background:var(--surface-soft); padding:4px 9px; border-radius:8px;">Need: ${needQty} ${escapeHtml(currentUnit)}</span></div>`;

      let boughtHtml = '';
      if ((isBuyer || mgr) && !isChecked) {
        boughtHtml = `
          <div class="cl-field-group">
            <span style="font-size:11.5px; font-weight:700; color:var(--success);">Bought:</span>
            <button class="qty-btn" onclick="adjustBoughtQty('${item.id}', -1)">−</button>
            <input type="number" class="qty-input" value="${boughtQty}" min="0" onfocus="this.select()" oninput="onBoughtInput('${item.id}', this.value)" onchange="commitBoughtEdit('${item.id}', this.value)" onblur="flushDeferredChecklistRender()">
            <button class="qty-btn" onclick="adjustBoughtQty('${item.id}', 1)">+</button>
          </div>`;
      } else {
        boughtHtml = `<div class="cl-field-group"><span style="font-size:11.5px; font-weight:800; background:var(--surface-soft); padding:4px 8px; border-radius:7px;">Buyer: ${boughtQty}${order.boughtBy ? ` (${escapeHtml(order.boughtBy)})` : ''}${isChecked ? ' 🔒' : ''}</span></div>`;
      }

      let leaderBoxHtml = '';
      if (leadOrMgr) {
        const diff = recQty - boughtQty;
        const auditBadge = hasMismatch
          ? `<span class="cl-mismatch-pill">🚨 Diff: ${diff > 0 ? '+' : ''}${diff} vs Buyer (${boughtQty})</span>`
          : (isChecked ? `<span class="cl-match-pill">✓ Verified by ${escapeHtml(order.checkedBy || 'Leader')}</span>` : '');
        const fillBtn = (recQty === 0 && !isChecked) ? `<button class="btn btn-outline" style="padding:3px 7px; font-size:11px;" onclick="fillRecFromNeed('${item.id}')">= ${needQty}</button>` : '';
        leaderBoxHtml = `
          <div class="cl-verify-box ${isChecked ? 'verified' : ''} ${hasMismatch ? 'mismatch' : ''}" id="clVerifyBox_${item.id}">
            <div class="cl-verify-top">
              <div class="cl-field-group">
                <span style="font-size:11.5px; font-weight:800; color:var(--header-bg);">Rec'd Count:</span>
                <button class="qty-btn" onclick="adjustRecQty('${item.id}', -1)">−</button>
                <input type="number" id="clRecInput_${item.id}" class="qty-input" value="${recQty}" min="0" onfocus="this.select()" oninput="onRecQtyInput('${item.id}', this.value)" onchange="commitRecQtyEdit('${item.id}', this.value)" onblur="flushDeferredChecklistRender()">
                <button class="qty-btn" onclick="adjustRecQty('${item.id}', 1)">+</button>
                ${fillBtn}
              </div>
              <div id="clAuditBadge_${item.id}">${auditBadge}</div>
            </div>
            <div class="cl-verify-actions">
              <button id="clVerifyBtn_${item.id}" class="btn btn-outline ${isChecked ? 'btn-verify-done' : ''}" onclick="toggleLeaderVerify('${item.id}')">${isChecked ? `✅ Verified (${recQty})` : '☑️ Verify Count'}</button>
              <button class="btn btn-primary" data-vendor="${escapeHtml(vendor)}" data-id="${item.id}" onclick="openReceiveModal(this.dataset.vendor, this.dataset.id)">📥 Receive Item</button>
            </div>
          </div>`;
      } else if (isChecked) {
        leaderBoxHtml = `<div class="cl-match-pill" style="align-self:flex-start;">✅ Verified by ${escapeHtml(order.checkedBy || 'Leader')} (${recQty})</div>`;
      }

      itemsHtml += `
        <div class="checklist-item ${status.done ? 'done' : ''}" id="clRow_${item.id}">
          <div class="cl-item-top">
            <div class="cl-left">
              ${leftCheckHtml}
              <div class="cl-thumb" onclick="handleThumbnailClick('${item.id}')">${latestPhoto ? `<img src="${latestPhoto}">` : `<span>📷</span>`}</div>
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
          ${item.note ? `<div class="sku-note-pill" style="padding:4px 8px; font-size:11px;"><span>📌</span><span>${escapeHtml(item.note)}</span></div>` : ''}
          <div class="cl-controls-row">${needHtml}${boughtHtml}<span class="cl-status-pill ${status.cls}" id="clStatus_${item.id}">${status.text}</span></div>
          ${leaderBoxHtml}
          <input type="text" class="cl-note-input" value="${escapeHtml(order.note || '')}" placeholder="📝 Note (price, discrepancy reason, aisle)..." oninput="onNoteInput('${item.id}', this.value)" onchange="pushOrdersToCloud()" onblur="flushDeferredChecklistRender()">
        </div>`;
    });

    const vendorActionsHtml = leadOrMgr ? `
      <div class="vendor-header-actions">
        <button class="btn btn-primary" style="padding:4px 9px; font-size:11px;" data-vendor="${escapeHtml(vendor)}" onclick="dispatchToTelegram(this.dataset.vendor)">✈️ Send Store</button>
        <button class="btn btn-success" style="padding:4px 9px; font-size:11px;" data-vendor="${escapeHtml(vendor)}" onclick="openReceiveModal(this.dataset.vendor)">✅ Receive Store (${verifiedCount}/${grouped[vendor].length})</button>
      </div>` : '';

    groupCard.innerHTML = `<div class="vendor-header"><span>📍 ${escapeHtml(vendor)} (${grouped[vendor].length})</span>${vendorActionsHtml}</div>${itemsHtml}`;
    container.appendChild(groupCard);
  });
}

function toggleDone(id) {
  const o = buyOrders[id], item = skus.find(s => s.id === id);
  if (!o || o.leaderChecked) return;
  const need = Math.max(1, parseInt(o.qty) || 1), old = getOrderBoughtQty(o);
  o.bought = old >= need ? 0 : need; o.done = o.bought >= need; o.boughtBy = currentUser ? currentUser.name : 'Buyer';
  if (item) logHistory('bought_edit', `${item.name}: Bought ${old} → ${o.bought} (of ${need})`, { itemName: item.name, vendor: item.vendor });
  pushOrdersToCloud(); renderChecklist();
}
function adjustOrderQty(id, delta) {
  if (!isLeaderOrManager() || !buyOrders[id]) return;
  buyOrders[id].qty = Math.max(1, (parseInt(buyOrders[id].qty) || 1) + delta);
  buyOrders[id].done = getOrderBoughtQty(buyOrders[id]) >= buyOrders[id].qty;
  pushOrdersToCloud(); renderChecklist();
}
function onOrderQtyInput(id, val) {
  if (!isLeaderOrManager() || !buyOrders[id]) return;
  const need = Math.max(1, parseInt(val) || 1); buyOrders[id].qty = need;
  const st = getStatusInfo(need, getOrderBoughtQty(buyOrders[id])); buyOrders[id].done = st.done;
  updateChecklistRowStatusInPlace(id, st);
}
function adjustBoughtQty(id, delta) {
  if (!buyOrders[id] || buyOrders[id].leaderChecked) return;
  const old = getOrderBoughtQty(buyOrders[id]), next = Math.max(0, old + delta), need = Math.max(1, parseInt(buyOrders[id].qty) || 1);
  buyOrders[id].bought = next; buyOrders[id].done = next >= need; buyOrders[id].boughtBy = currentUser ? currentUser.name : 'Buyer';
  const item = skus.find(s => s.id === id);
  if (item && old !== next) logHistory('bought_edit', `${item.name}: Bought ${old} → ${next} (of ${need})`, { itemName: item.name, vendor: item.vendor });
  pushOrdersToCloud(); renderChecklist();
}
function onBoughtInput(id, val) {
  if (!buyOrders[id] || buyOrders[id].leaderChecked) return;
  const bought = Math.max(0, parseInt(val) || 0), need = Math.max(1, parseInt(buyOrders[id].qty) || 1);
  buyOrders[id].bought = bought; buyOrders[id].boughtBy = currentUser ? currentUser.name : 'Buyer';
  const st = getStatusInfo(need, bought); buyOrders[id].done = st.done;
  updateChecklistRowStatusInPlace(id, st); refreshChecklistItemBadgesInPlace(id);
}
function commitBoughtEdit(id, val) {
  if (!buyOrders[id] || buyOrders[id].leaderChecked) return;
  const item = skus.find(s => s.id === id), bought = Math.max(0, parseInt(val) || 0), need = Math.max(1, parseInt(buyOrders[id].qty) || 1);
  buyOrders[id].bought = bought; buyOrders[id].done = bought >= need; buyOrders[id].boughtBy = currentUser ? currentUser.name : 'Buyer';
  if (item) logHistory('bought_edit', `${item.name}: Set Bought to ${bought} (of ${need})`, { itemName: item.name, vendor: item.vendor });
  pushOrdersToCloud();
}
function adjustRecQty(id, delta) {
  if (!isLeaderOrManager() || !buyOrders[id]) return;
  buyOrders[id].recQty = Math.max(0, getLeaderRecQty(buyOrders[id]) + delta);
  pushOrdersToCloud(); renderChecklist();
}
function fillRecFromNeed(id) {
  if (!isLeaderOrManager() || !buyOrders[id]) return;
  buyOrders[id].recQty = Math.max(1, parseInt(buyOrders[id].qty) || 1);
  pushOrdersToCloud(); renderChecklist();
}
function onRecQtyInput(id, val) {
  if (!isLeaderOrManager() || !buyOrders[id]) return;
  buyOrders[id].recQty = Math.max(0, parseInt(val) || 0);
  refreshChecklistItemBadgesInPlace(id);
}
function commitRecQtyEdit(id, val) {
  if (!isLeaderOrManager() || !buyOrders[id]) return;
  buyOrders[id].recQty = Math.max(0, parseInt(val) || 0);
  pushOrdersToCloud();
}
function refreshChecklistItemBadgesInPlace(id) {
  const o = buyOrders[id]; if (!o) return;
  const bought = getOrderBoughtQty(o), rec = getLeaderRecQty(o), checked = !!o.leaderChecked;
  const mismatch = bought > 0 && rec !== bought, diff = rec - bought;
  const box = document.getElementById(`clVerifyBox_${id}`), badge = document.getElementById(`clAuditBadge_${id}`), btn = document.getElementById(`clVerifyBtn_${id}`);
  if (box) { box.classList.toggle('verified', checked); box.classList.toggle('mismatch', mismatch); }
  if (badge) badge.innerHTML = mismatch ? `<span class="cl-mismatch-pill">🚨 Diff: ${diff > 0 ? '+' : ''}${diff} vs Buyer (${bought})</span>` : (checked ? `<span class="cl-match-pill">✓ Verified by ${escapeHtml(o.checkedBy || 'Leader')}</span>` : '');
  if (btn) btn.innerText = checked ? `✅ Verified (${rec})` : '☑️ Verify Count';
}
function toggleLeaderVerify(id) {
  if (!isLeaderOrManager() || !buyOrders[id]) return;
  const o = buyOrders[id], item = skus.find(s => s.id === id), bought = getOrderBoughtQty(o), rec = getLeaderRecQty(o);
  if (o.leaderChecked) {
    o.leaderChecked = false; delete o.checkedBy; delete o.checkedAt;
    showToast(`Unverified ${item ? item.name : 'item'}`, 'info');
  } else {
    o.recQty = rec; o.leaderChecked = true; o.checkedBy = currentUser.name; o.checkedAt = Date.now();
    if (item) {
      const diff = rec - bought;
      logHistory('verify_item', `Verified ${item.name}: Rec'd ${rec} (Buyer: ${bought})${(bought > 0 && diff !== 0) ? ` [🚨 MISMATCH: ${diff}]` : ''}`, { itemName: item.name, vendor: item.vendor, buyerClaimed: bought, recQty: rec, diff });
    }
    showToast(bought > 0 && rec !== bought ? `Verified with mismatch: Buyer ${bought} vs Rec'd ${rec}` : `Verified ${item ? item.name : 'item'} (${rec})`, bought > 0 && rec !== bought ? 'warning' : 'success');
  }
  pushOrdersToCloud(); renderChecklist();
}
function updateChecklistRowStatusInPlace(id, st) {
  const pill = document.getElementById(`clStatus_${id}`), chk = document.getElementById(`clCheck_${id}`), row = document.getElementById(`clRow_${id}`);
  if (pill) { pill.className = `cl-status-pill ${st.cls}`; pill.innerText = st.text; }
  if (chk) chk.checked = st.done;
  if (row) row.classList.toggle('done', st.done);
}
function setOrderUnit(id, unit) { if (isLeaderOrManager() && buyOrders[id]) { buyOrders[id].unit = unit; pushOrdersToCloud(); } }
function onNoteInput(id, note) { if (buyOrders[id]) buyOrders[id].note = note; }
function clearFulfilled() {
  if (!isLeaderOrManager()) return;
  const doneIds = Object.keys(buyOrders).filter(id => buyOrders[id] && getStatusInfo(Math.max(1, parseInt(buyOrders[id].qty) || 1), getOrderBoughtQty(buyOrders[id])).done);
  if (!doneIds.length) { showToast('No fulfilled items.', 'info'); return; }
  doneIds.forEach(id => delete buyOrders[id]);
  logHistory('checklist', `Cleared ${doneIds.length} fulfilled item(s)`);
  pushOrdersToCloud(); renderCatalog(); renderChecklist(); showToast('Fulfilled items cleared', 'info');
}
function clearAllChecklist() {
  if (!isManager()) { showToast('Managers only.', 'error'); return; }
  const n = Object.keys(buyOrders).filter(id => skus.some(s => s.id === id)).length;
  if (!n || !confirm('Clear ALL items from the buying checklist?')) return;
  buyOrders = {}; logHistory('checklist', `Cleared entire Buy Checklist (${n} items)`);
  pushOrdersToCloud(); renderCatalog(); renderChecklist(); showToast('Checklist cleared', 'info');
}

/* 12. Receive Item / Verified Store (Leaders & Managers Only) */
function openReceiveModal(targetVendor = null, targetSkuId = null) {
  if (!isLeaderOrManager()) { showToast('Shift Leaders or Managers only.', 'warning'); return; }
  const orderIds = targetSkuId ? (buyOrders[targetSkuId] ? [targetSkuId] : []) : Object.keys(buyOrders).filter(id => skus.some(s => s.id === id));
  pendingReceiveSummary = []; let unverifiedCount = 0;

  orderIds.forEach(id => {
    const item = skus.find(s => s.id === id);
    if (!item || (targetVendor && item.vendor !== targetVendor)) return;
    const o = buyOrders[id], need = Math.max(1, parseInt(o.qty) || 1), buyerClaimed = getOrderBoughtQty(o), recQty = getLeaderRecQty(o);
    if (!targetSkuId && !o.leaderChecked) { unverifiedCount++; return; }
    if (targetSkuId && recQty === 0 && buyerClaimed === 0) return;
    pendingReceiveSummary.push({
      id, name: item.name, vendor: item.vendor, unit: o.unit || item.unit || 'Units',
      oldStock: item.stock, bought: recQty, buyerClaimed, diff: recQty - buyerClaimed, need,
      newStock: item.stock + recQty, remaining: Math.max(0, need - recQty),
      boughtBy: o.boughtBy || 'Buyer', checkedBy: o.checkedBy || currentUser.name
    });
  });

  if (!pendingReceiveSummary.length) {
    showToast(targetSkuId ? 'Enter a Rec\'d Count greater than 0 first.' : 'Check items one by one (tap ☑️ Verify Count) before tapping Receive Store.', 'warning', 4000);
    return;
  }

  document.getElementById('receiveModalTitle').innerText = targetSkuId ? `📥 Receive: ${pendingReceiveSummary[0].name}` : `✅ Receive ${targetVendor} Store`;
  const list = document.getElementById('receivePreviewList'); list.innerHTML = '';
  const mismatches = pendingReceiveSummary.filter(e => e.buyerClaimed > 0 && e.diff !== 0);
  const banner = document.createElement('div');
  banner.className = `audit-banner ${mismatches.length ? 'alert' : 'ok'}`;
  banner.innerText = mismatches.length
    ? `🚨 BUYER DISCREPANCY on ${mismatches.length} item(s)! Mismatches are permanently logged to Management History.`
    : '✅ All verified counts match the Buyer\'s report.';
  list.appendChild(banner);

  if (!targetSkuId && unverifiedCount) {
    const n = document.createElement('div');
    n.style.cssText = 'font-size:11.5px; font-weight:700; color:var(--text-muted); padding:2px 4px;';
    n.innerText = `⏳ ${unverifiedCount} unchecked item(s) will remain on the checklist.`;
    list.appendChild(n);
  }

  pendingReceiveSummary.forEach(e => {
    const row = document.createElement('div'); row.className = 'list-row-card';
    const diffBadge = (e.buyerClaimed > 0 && e.diff !== 0) ? `<span class="cl-mismatch-pill">Buyer ${e.buyerClaimed} vs Rec'd ${e.bought} (${e.diff > 0 ? '+' : ''}${e.diff})</span>` : '';
    const remBadge = e.remaining > 0 ? `<span style="font-size:11px; color:#92400E; background:var(--warning-light); padding:2px 7px; border-radius:6px; font-weight:700;">${e.remaining} left</span>` : `<span style="font-size:11px; color:#065F46; background:var(--success-light); padding:2px 7px; border-radius:6px; font-weight:700;">Fulfilled</span>`;
    row.innerHTML = `<div style="min-width:0; display:flex; flex-direction:column; gap:3px;"><div style="font-size:13px; font-weight:800;">${escapeHtml(e.name)}</div><div style="font-size:11px; color:var(--text-muted);">Stock: ${e.oldStock} → <strong>${e.newStock} ${escapeHtml(e.unit)}</strong> (+${e.bought})</div>${diffBadge}</div>${remBadge}`;
    list.appendChild(row);
  });
  document.getElementById('receiveModal').style.display = 'flex';
}

async function confirmReceiveToStock() {
  if (!isLeaderOrManager() || !pendingReceiveSummary.length) return;
  const sendTg = document.getElementById('receiveAlsoTelegram').checked, now = Date.now();
  let partialCount = 0;

  pendingReceiveSummary.forEach(e => {
    const item = skus.find(s => s.id === e.id);
    if (item) { item.stock += e.bought; item.updatedBy = currentUser.name; item.updatedAt = now; }
    if (e.remaining > 0 && buyOrders[e.id]) {
      buyOrders[e.id].qty = e.remaining; buyOrders[e.id].bought = 0; buyOrders[e.id].done = false;
      delete buyOrders[e.id].recQty; delete buyOrders[e.id].leaderChecked; delete buyOrders[e.id].checkedBy; delete buyOrders[e.id].checkedAt; delete buyOrders[e.id].boughtBy;
      partialCount++;
    } else {
      delete buyOrders[e.id];
    }
  });

  const vSet = uniqueSorted(pendingReceiveSummary.map(e => e.vendor));
  const mismatches = pendingReceiveSummary.filter(e => e.buyerClaimed > 0 && e.diff !== 0);
  logHistory('receive', `Received ${pendingReceiveSummary.length} item(s) (${vSet.join(', ')})${mismatches.length ? ` · 🚨 ${mismatches.length} Mismatch(es)` : ''}`, {
    vendors: vSet, mismatchCount: mismatches.length,
    items: pendingReceiveSummary.map(e => ({ id: e.id, name: e.name, vendor: e.vendor, unit: e.unit, oldStock: e.oldStock, bought: e.bought, buyerClaimed: e.buyerClaimed, diff: e.diff, newStock: e.newStock, need: e.need, remaining: e.remaining, boughtBy: e.boughtBy, checkedBy: e.checkedBy }))
  });

  pushSkusToCloud(); pushOrdersToCloud(); closeModal('receiveModal'); renderCatalog(); renderChecklist();
  if (sendTg) await sendBuyerReceiptTelegram(pendingReceiveSummary);
  showToast(partialCount ? `Received ${pendingReceiveSummary.length} item(s) (${partialCount} left)` : `Received ${pendingReceiveSummary.length} item(s)!`, mismatches.length ? 'warning' : 'success', 4000);
  pendingReceiveSummary = [];
}

/* 13. Manager-Only History View & Undo */
function populateHistoryUserFilter() {
  const sel = document.getElementById('historyUserFilter'); if (!sel) return;
  const prev = sel.value, names = uniqueSorted([...accounts.map(a => a.name), ...historyLogs.map(h => h.actor)]);
  sel.innerHTML = '<option value="">All Staff</option>' + names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  if (prev && names.includes(prev)) sel.value = prev;
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
      const ok = h.vendor === vendorOverride || (Array.isArray(h.vendors) && h.vendors.includes(vendorOverride)) || (Array.isArray(h.items) && h.items.some(i => i.vendor === vendorOverride));
      if (!ok) return false;
    }
    if (!rangeOverride && q && !`${h.summary || ''} ${h.actor || ''} ${JSON.stringify(h.items || '')}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
function historyBadgeMeta(t) {
  return ({ receive: { cls: 'hb-receive', label: 'Received' }, verify_item: { cls: 'hb-receive', label: 'Verified' }, order_sent: { cls: 'hb-order', label: 'Order Sent' }, buyer_report: { cls: 'hb-order', label: 'Buyer Report' }, bought_edit: { cls: 'hb-receive', label: 'Bought Edit' }, stock_edit: { cls: 'hb-stock', label: 'Stock Edit' }, checklist: { cls: 'hb-sku', label: 'Checklist' } })[t] || { cls: 'hb-sku', label: 'Catalog Edit' };
}
function renderHistory() {
  if (!isManager()) return;
  const c = document.getElementById('historyList'); if (!c) return;
  const list = getFilteredHistory();
  if (!list.length) {
    c.innerHTML = `<div style="text-align:center; padding:40px 16px; color:var(--text-muted); background:var(--card-bg); border-radius:14px; border:1px solid var(--border);"><div style="font-size:28px; margin-bottom:6px;">🕵️</div><div style="font-weight:800; color:var(--text);">No activity logs match these filters</div></div>`;
    return;
  }
  c.innerHTML = '';
  list.slice(0, 150).forEach(h => {
    const meta = historyBadgeMeta(h.type), itemsList = Array.isArray(h.items) ? h.items : [];
    const itemsHtml = itemsList.length ? `<div class="history-items-box">${itemsList.map(it => {
      if (h.type === 'receive') {
        const sTxt = it.remaining > 0 ? ` <span style="color:#B45309;">(Short ${it.remaining})</span>` : '';
        const mTxt = (it.buyerClaimed > 0 && it.diff !== 0) ? ` <span style="color:var(--danger); font-weight:800;">[🚨 Buyer claimed ${it.buyerClaimed}, Rec'd ${it.bought}]</span>` : '';
        return `<div>• <strong>${escapeHtml(it.name)}</strong> (${escapeHtml(it.vendor)}): +${it.bought} ${escapeHtml(it.unit)} → Stock ${it.oldStock} → <strong>${it.newStock}</strong>${sTxt}${mTxt}</div>`;
      }
      return `<div>• <strong>${escapeHtml(it.name)}</strong> (${escapeHtml(it.vendor || '')}): ${it.qty || it.bought || 0} ${escapeHtml(it.unit || 'Units')}</div>`;
    }).join('')}</div>` : '';
    const undo = (h.type === 'receive' && !h.undone && itemsList.length)
      ? `<button class="btn btn-danger-soft" style="padding:3px 8px; font-size:11px;" onclick="undoReceiveEvent('${h.id}')">↩️ Undo Receive</button>`
      : (h.undone ? `<span style="font-size:11px; color:var(--danger); font-weight:800;">Reversed</span>` : '');
    const card = document.createElement('div'); card.className = 'history-card';
    card.innerHTML = `<div class="history-top"><div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;"><span class="history-badge ${meta.cls}">${meta.label}</span><strong style="font-size:13px;">${escapeHtml(h.actor || 'Staff')}</strong><span style="font-size:11px; color:var(--text-muted);">${formatShortTime(h.ts)}</span></div>${undo}</div><div style="font-size:13px; font-weight:600;">${escapeHtml(h.summary)}</div>${itemsHtml}`;
    c.appendChild(card);
  });
}
function undoReceiveEvent(histId) {
  if (!isManager()) return;
  const e = historyLogs.find(h => h.id === histId);
  if (!e || e.undone || !Array.isArray(e.items) || !confirm(`Roll back stock for ${e.items.length} item(s)?`)) return;
  e.items.forEach(it => {
    const sku = skus.find(s => s.id === it.id);
    if (sku) { sku.stock = Math.max(0, sku.stock - (parseInt(it.bought) || 0)); sku.updatedBy = currentUser.name; sku.updatedAt = Date.now(); }
  });
  db.ref(`${ROOT}/history/${histId}/undone`).set(true);
  logHistory('stock_edit', `Reversed Receive (${e.items.length} items) by ${e.actor}`, { items: e.items.map(it => ({ name: it.name, vendor: it.vendor, qty: -(it.bought || 0), unit: it.unit })) });
  pushSkusToCloud(); renderCatalog(); renderHistory(); showToast('Stock rolled back', 'info', 4000);
}
function exportHistoryCsv() {
  if (!isManager()) return;
  const list = getFilteredHistory();
  if (!list.length) { showToast('No history rows.', 'warning'); return; }
  downloadCsvFile([['Date', 'Staff', 'Role', 'Action', 'Summary'], ...list.map(h => [new Date(h.ts || 0).toISOString(), h.actor || '', h.actorRole || '', h.type || '', h.summary || ''])], `${PREFIX}history-${new Date().toISOString().slice(0, 10)}.csv`);
}

/* 14. Manager-Only Management Reports */
function computeReportMetrics() {
  const range = document.getElementById('reportRangeFilter')?.value || '30';
  const vendor = document.getElementById('reportVendorFilter')?.value || '';
  const events = getFilteredHistory(range, vendor || null);
  const skuPool = vendor ? skus.filter(s => s.vendor === vendor) : skus;
  const receiveEvents = events.filter(e => e.type === 'receive' && !e.undone);
  const orderEvents = events.filter(e => e.type === 'order_sent');
  const itemStats = {}, vendorStats = {}, staffStats = {}, discrepancyEvents = [];
  let totalBought = 0, totalNeeded = 0;

  events.forEach(e => {
    const a = e.actor || 'Staff';
    if (!staffStats[a]) staffStats[a] = { orders: 0, receives: 0, edits: 0 };
    if (e.type === 'order_sent') staffStats[a].orders++;
    else if (e.type === 'receive' && !e.undone) staffStats[a].receives++;
    else staffStats[a].edits++;
  });
  receiveEvents.forEach(ev => {
    (ev.items || []).forEach(it => {
      if (vendor && it.vendor !== vendor) return;
      const bought = parseInt(it.bought) || 0, need = parseInt(it.need) || bought;
      totalBought += bought; totalNeeded += need;
      if (it.buyerClaimed > 0 && it.diff !== 0) {
        discrepancyEvents.push({ ts: ev.ts, name: it.name, vendor: it.vendor, buyerClaimed: it.buyerClaimed, recQty: bought, diff: it.diff, buyer: it.boughtBy || 'Buyer', checker: it.checkedBy || ev.actor });
      }
      const key = it.id || it.name;
      if (!itemStats[key]) itemStats[key] = { id: it.id, name: it.name, vendor: it.vendor, unit: it.unit || 'Units', bought: 0, needed: 0, runs: 0, shorts: 0 };
      itemStats[key].bought += bought; itemStats[key].needed += need; itemStats[key].runs++;
      if (bought < need) itemStats[key].shorts++;
      const vn = it.vendor || 'Other';
      if (!vendorStats[vn]) vendorStats[vn] = { vendor: vn, trips: 0, bought: 0, needed: 0, shorts: 0 };
      vendorStats[vn].trips++; vendorStats[vn].bought += bought; vendorStats[vn].needed += need;
      if (bought < need) vendorStats[vn].shorts++;
    });
  });

  const mostBought = Object.values(itemStats).sort((a, b) => b.bought - a.bought || b.runs - a.runs);
  const leastBought = skuPool.map(s => ({ id: s.id, name: s.name, vendor: s.vendor, stock: s.stock, min: s.min, max: s.max, bought: itemStats[s.id]?.bought || 0 })).sort((a, b) => a.bought - b.bought || b.stock - a.stock);
  const parSuggestions = [];
  mostBought.forEach(st => {
    const s = skus.find(x => x.id === st.id); if (!s) return;
    if (s.max === 0) parSuggestions.push({ name: s.name, type: 'Set Par', detail: `Bought ${st.bought} (${st.runs}x) with 0/0 pars.` });
    else if (st.runs >= 3 && st.bought > s.max * 2) parSuggestions.push({ name: s.name, type: 'Raise Max', detail: `Ordered ${st.runs}x (${st.bought} bought). Raise Max above ${s.max}.` });
  });
  skuPool.forEach(s => { if (s.max > 0 && s.stock >= s.max * 1.5 && !(itemStats[s.id]?.bought > 0)) parSuggestions.push({ name: s.name, type: 'Overstocked', detail: `Stock ${s.stock} > Max ${s.max} with 0 buys.` }); });

  return {
    range, vendor, skuPool, receiveEvents, orderEvents, totalBought, totalNeeded,
    fulfillRate: totalNeeded > 0 ? Math.round((totalBought / totalNeeded) * 100) : 100,
    mostBought, leastBought, discrepancyEvents,
    vendorList: Object.values(vendorStats).sort((a, b) => b.bought - a.bought),
    parSuggestions: parSuggestions.slice(0, 12),
    staffList: Object.entries(staffStats).map(([name, s]) => ({ name, ...s })),
    lowCount: skuPool.filter(s => s.min > 0 && s.stock <= s.min).length,
    noParCount: skuPool.filter(s => s.min === 0 && s.max === 0).length,
    photoCount: skuPool.filter(s => (itemPhotos[s.id] || []).length > 0).length
  };
}
function renderReports() {
  if (!isManager()) return;
  const c = document.getElementById('reportsContent'); if (!c) return;
  const m = computeReportMetrics(), maxTop = m.mostBought.length ? Math.max(1, m.mostBought[0].bought) : 1, photoPct = m.skuPool.length ? Math.round((m.photoCount / m.skuPool.length) * 100) : 0;
  const emptyNotice = m.receiveEvents.length === 0 ? `<div style="background:var(--primary-light); border:1px solid rgba(217,107,39,0.28); color:var(--primary-dark); padding:11px 14px; border-radius:12px; font-size:12.5px; font-weight:600; margin-bottom:12px;">📊 Buying velocity &amp; audit charts populate after your team completes a <strong>Receive</strong> run.</div>` : '';
  const topHtml = m.mostBought.length ? m.mostBought.slice(0, 10).map(it => `<div class="bar-row"><div class="bar-row-head"><span>${escapeHtml(it.name)} <span style="font-weight:500; color:var(--text-muted);">(${escapeHtml(it.vendor)})</span></span><span>${it.bought} ${escapeHtml(it.unit)} · ${it.runs}x</span></div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(6, Math.round((it.bought / maxTop) * 100))}%"></div></div></div>`).join('') : '<div style="font-size:12.5px; color:var(--text-muted);">No purchases received yet.</div>';
  const leastHtml = m.leastBought.slice(0, 12).map(it => `<div style="display:flex; justify-content:space-between; font-size:12px; padding:5px 0; border-bottom:1px solid #F2EDE4; gap:8px;"><span><strong>${escapeHtml(it.name)}</strong> <span style="color:var(--text-muted);">(${escapeHtml(it.vendor)})</span></span><span style="white-space:nowrap; color:var(--text-muted);">${it.bought} bought · Stock: ${it.stock}</span></div>`).join('');
  const vendorHtml = m.vendorList.length ? m.vendorList.map(v => { const r = v.needed > 0 ? Math.round((v.bought / v.needed) * 100) : 100; return `<div class="bar-row"><div class="bar-row-head"><span>${escapeHtml(v.vendor)} (${v.trips})</span><span>${v.bought} · ${r}% filled</span></div><div class="bar-track"><div class="bar-fill indigo" style="width:${Math.max(8, r)}%"></div></div></div>`; }).join('') : '<div style="font-size:12.5px; color:var(--text-muted);">No vendor runs logged yet.</div>';
  const auditHtml = m.discrepancyEvents.length ? m.discrepancyEvents.slice(0, 10).map(d => `<div style="font-size:12px; padding:6px 8px; background:var(--danger-light); border-radius:8px; color:#991B1B; font-weight:600;">🚨 <strong>${escapeHtml(d.name)}</strong> (${escapeHtml(d.vendor)}): Buyer (${escapeHtml(d.buyer)}) claimed <strong>${d.buyerClaimed}</strong>, ${escapeHtml(d.checker)} verified <strong>${d.recQty}</strong> (${d.diff > 0 ? '+' : ''}${d.diff}) · ${formatShortTime(d.ts)}</div>`).join('') : '<div style="font-size:12.5px; color:#065F46; font-weight:700;">✅ Zero Buyer-vs-Leader count discrepancies.</div>';
  const parHtml = m.parSuggestions.length ? m.parSuggestions.map(p => `<div style="font-size:12px; padding:5px 8px; background:var(--bg); border-radius:8px; border:1px solid var(--border);"><span style="font-weight:800; color:var(--primary-dark);">[${escapeHtml(p.type)}]</span> <strong>${escapeHtml(p.name)}</strong>: ${escapeHtml(p.detail)}</div>`).join('') : '<div style="font-size:12.5px; color:var(--text-muted);">No par adjustments flagged.</div>';
  const staffHtml = m.staffList.length ? m.staffList.map(s => `<div style="display:flex; justify-content:space-between; font-size:12px; padding:4px 0; border-bottom:1px solid #F2EDE4;"><strong>${escapeHtml(s.name)}</strong><span style="color:var(--text-muted);">${s.orders} orders · ${s.receives} receives · ${s.edits} edits</span></div>`).join('') : '<div style="font-size:12.5px; color:var(--text-muted);">No staff activity logged yet.</div>';

  c.innerHTML = `${emptyNotice}
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-value">${m.totalBought}</div><div class="kpi-label">Units Bought</div></div>
      <div class="kpi-card"><div class="kpi-value" style="color:${m.discrepancyEvents.length ? 'var(--danger)' : 'var(--success)'};">${m.discrepancyEvents.length}</div><div class="kpi-label">Count Mismatches</div></div>
      <div class="kpi-card"><div class="kpi-value" style="color:var(--success);">${m.fulfillRate}%</div><div class="kpi-label">Fill Rate</div></div>
      <div class="kpi-card"><div class="kpi-value" style="color:var(--secondary);">${m.lowCount} / ${photoPct}%</div><div class="kpi-label">Low Stock / Photos</div></div>
    </div>
    <div class="report-grid">
      <div class="report-card"><div class="report-card-title"><span>🚨 Buyer vs. Delivery Audit</span><span style="font-size:11px; color:var(--text-muted);">Anti-Theft Log</span></div>${auditHtml}</div>
      <div class="report-card"><div class="report-card-title"><span>🔥 Most-Bought Items</span><span style="font-size:11px; color:var(--text-muted);">Top 10</span></div>${topHtml}</div>
      <div class="report-card"><div class="report-card-title"><span>🧊 Least-Bought / Dead Stock</span><span style="font-size:11px; color:var(--text-muted);">Slowest 12</span></div>${leastHtml}</div>
      <div class="report-card"><div class="report-card-title"><span>🏪 Vendor Activity &amp; Par Insights</span><span style="font-size:11px; color:var(--text-muted);">${m.noParCount} at 0/0</span></div>${vendorHtml}<div style="font-size:12px; font-weight:800; margin-top:4px;">🎯 Par Recommendations</div>${parHtml}<div style="font-size:12px; font-weight:800; margin-top:4px;">👥 Team Activity</div>${staffHtml}</div>
    </div>`;
}
function exportReportCsv() {
  if (!isManager()) return;
  const m = computeReportMetrics();
  downloadCsvFile([['Item', 'Vendor', 'Bought', 'Runs', 'Needed', 'Shorts', 'Stock', 'Min', 'Max'], ...m.skuPool.map(s => { const st = m.mostBought.find(x => x.id === s.id); return [s.name, s.vendor, st?.bought || 0, st?.runs || 0, st?.needed || 0, st?.shorts || 0, s.stock, s.min, s.max]; })], `${PREFIX}report-${new Date().toISOString().slice(0, 10)}.csv`);
}
function downloadCsvFile(rows, filename) {
  const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
  showToast('CSV exported', 'success');
}
async function sendReportSummaryTelegram() {
  if (!isManager()) return;
  const m = computeReportMetrics();
  const topLines = m.mostBought.slice(0, 5).map((x, i) => `${i + 1}. *${escapeTgMarkdown(x.name)}* — ${x.bought} ${escapeTgMarkdown(x.unit)} (${x.runs}x)`).join('\n') || '_No buys yet_';
  const text = `📊 *${escapeTgMarkdown(CFG.appName || 'Swirla Café')} — Management Summary (${m.range === 'all' ? 'All Time' : `Last ${m.range} Days`})*\n• *Units Bought:* ${m.totalBought} | *Fill Rate:* ${m.fulfillRate}%\n• *Count Mismatches:* ${m.discrepancyEvents.length}\n• *Low Stock:* ${m.lowCount} | *Missing Pars:* ${m.noParCount}\n\n🔥 *Top 5:*\n${topLines}`;
  if (await postTelegramMessage(text)) showToast('Summary sent to Telegram!', 'success');
}

/* 15. Telegram Dispatch */
async function postTelegramMessage(text) {
  if (!botToken || !chatId) { showToast('Manager: tap ✈️ Telegram to set Token & Chat ID.', 'warning', 4500); return false; }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }) });
    const data = await res.json();
    if (!data.ok) { showToast(`Telegram Error: ${data.description}`, 'error', 5000); return false; }
    return true;
  } catch (e) { showToast('Network error contacting Telegram.', 'error'); return false; }
}
async function dispatchToTelegram(targetVendor = null) {
  if (!isLeaderOrManager()) return;
  const ids = Object.keys(buyOrders).filter(id => { const it = skus.find(s => s.id === id); return it && (!targetVendor || it.vendor === targetVendor); });
  if (!ids.length) { showToast('No items to send.', 'warning'); return; }
  const grouped = {}, logItems = [];
  ids.forEach(id => {
    const it = skus.find(s => s.id === id);
    (grouped[it.vendor] = grouped[it.vendor] || []).push({ item: it, order: buyOrders[id] });
    logItems.push({ id: it.id, name: it.name, vendor: it.vendor, qty: Math.max(1, parseInt(buyOrders[id].qty) || 1), unit: buyOrders[id].unit || it.unit || 'Units' });
  });
  let text = `🛒 *${escapeTgMarkdown(CFG.appName || 'Swirla Café')} — ${targetVendor ? escapeTgMarkdown(targetVendor) + ' Order' : 'Buy Order'}*\n👤 *By:* ${escapeTgMarkdown(currentUser.name)}\n📅 *${formatShortTime(Date.now())}*\n\n`;
  Object.keys(grouped).sort().forEach(v => {
    text += `📍 *${escapeTgMarkdown(v)}*\n`;
    grouped[v].forEach(({ item, order }) => {
      text += `• *${escapeTgMarkdown(item.name)}* — *Qty: ${Math.max(1, parseInt(order.qty) || 1)} ${escapeTgMarkdown(order.unit || item.unit || 'Units')}* (Stock: ${item.stock})\n`;
      if (item.note) text += `   📌 _${escapeTgMarkdown(item.note)}_\n`;
      if (order.note && order.note.trim()) text += `   📝 _${escapeTgMarkdown(order.note.trim())}_\n`;
    });
    text += `\n`;
  });
  if (await postTelegramMessage(text)) {
    logHistory('order_sent', `Sent ${targetVendor || 'Full'} Order (${ids.length} items)`, { vendors: Object.keys(grouped), items: logItems });
    showToast(`Order dispatched by ${currentUser.name}!`, 'success', 3500);
  }
}
async function dispatchBuyerReport() {
  const ids = Object.keys(buyOrders).filter(id => skus.some(s => s.id === id));
  if (!ids.length) { showToast('Checklist is empty.', 'warning'); return; }
  const grouped = {}, logItems = [];
  ids.forEach(id => {
    const it = skus.find(s => s.id === id);
    (grouped[it.vendor] = grouped[it.vendor] || []).push({ item: it, order: buyOrders[id] });
    logItems.push({ name: it.name, vendor: it.vendor, bought: getOrderBoughtQty(buyOrders[id]), unit: buyOrders[id].unit || it.unit || 'Units' });
  });
  let text = `🚚 *${escapeTgMarkdown(CFG.appName || 'Swirla Café')} — Buyer Run Update*\n👤 *Buyer:* ${escapeTgMarkdown(currentUser.name)}\n📅 *${formatShortTime(Date.now())}*\n\n`;
  Object.keys(grouped).sort().forEach(v => {
    text += `📍 *${escapeTgMarkdown(v)}*\n`;
    grouped[v].forEach(({ item, order }) => {
      const u = escapeTgMarkdown(order.unit || item.unit || 'Units'), need = Math.max(1, parseInt(order.qty) || 1), b = getOrderBoughtQty(order);
      if (b >= need) text += `✅ *${escapeTgMarkdown(item.name)}* — Bought *${b}/${need} ${u}*\n`;
      else if (b > 0) text += `⚠️ *${escapeTgMarkdown(item.name)}* — Partial *${b}/${need} ${u}* (Short ${need - b})\n`;
      else text += `❌ *${escapeTgMarkdown(item.name)}* — Not Bought (Need ${need} ${u})\n`;
      if (order.note && order.note.trim()) text += `   📝 _${escapeTgMarkdown(order.note.trim())}_\n`;
    });
    text += `\n`;
  });
  if (await postTelegramMessage(text)) {
    logHistory('buyer_report', `Sent Buyer Run Update (${ids.length} items)`, { items: logItems });
    showToast('Buyer report sent!', 'success', 3500);
  }
}
async function sendBuyerReceiptTelegram(entries) {
  if (!botToken || !chatId || !entries.length) return;
  let text = `📦 *${escapeTgMarkdown(CFG.appName || 'Swirla Café')} — Received into Stock*\n👤 *Verified by:* ${escapeTgMarkdown(currentUser.name)}\n📅 *${formatShortTime(Date.now())}*\n\n`;
  entries.forEach(e => {
    const st = e.remaining > 0 ? `⚠️ *+${e.bought} ${escapeTgMarkdown(e.unit)}* (Short ${e.remaining})` : `✅ *+${e.bought} ${escapeTgMarkdown(e.unit)}*`;
    text += `• *${escapeTgMarkdown(e.name)}* (${escapeTgMarkdown(e.vendor)}) — ${st} → Stock: *${e.newStock}*\n`;
    if (e.buyerClaimed > 0 && e.diff !== 0) text += `   🚨 _MISMATCH: Buyer claimed ${e.buyerClaimed}, Verified ${e.bought} (${e.diff > 0 ? '+' : ''}${e.diff})_\n`;
  });
  await postTelegramMessage(text);
}

/* 16. Modals: Team, Backups, Telegram, SKU & Item Detail */
function closeModal(id) {
  const el = document.getElementById(id); if (el) el.style.display = 'none';
  if (id === 'itemDetailModal') activeDetailSkuId = null;
}
function handleTelegramBadgeClick() {
  if (isManager()) {
    document.getElementById('cfgBotToken').value = botToken;
    document.getElementById('cfgChatId').value = chatId;
    document.getElementById('telegramModal').style.display = 'flex';
  } else showToast(botToken && chatId ? 'Telegram alerts active.' : 'Ask Management to configure Telegram.', 'info');
}
function saveTelegramSettings() {
  if (!isManager()) return;
  botToken = document.getElementById('cfgBotToken').value.trim();
  chatId = document.getElementById('cfgChatId').value.trim();
  localStorage.setItem(PREFIX + 'bot_token', botToken); localStorage.setItem(PREFIX + 'chat_id', chatId);
  db.ref(`${ROOT}/settings/telegram`).set({ botToken, chatId });
  updateTelegramBadgeUI(); closeModal('telegramModal'); showToast('Telegram settings saved', 'success');
}
function openAccountsModal() { if (isManager()) { resetAccountForm(); renderAccountsModalList(); document.getElementById('accountsModal').style.display = 'flex'; } }
function resetAccountForm() {
  document.getElementById('accEditId').value = ''; document.getElementById('accFormTitle').innerText = 'Add New Team Member';
  document.getElementById('accFormName').value = ''; document.getElementById('accFormRole').value = 'leader';
  document.getElementById('accFormPin').value = ''; document.getElementById('accCancelEditBtn').style.display = 'none';
}
function editAccount(id) {
  const acc = accounts.find(a => a.id === id); if (!acc) return;
  document.getElementById('accEditId').value = acc.id; document.getElementById('accFormTitle').innerText = `Edit ${acc.name}`;
  document.getElementById('accFormName').value = acc.name; document.getElementById('accFormRole').value = acc.role;
  document.getElementById('accFormPin').value = acc.pin; document.getElementById('accCancelEditBtn').style.display = 'inline-flex';
}
function saveAccountForm() {
  if (!isManager()) return;
  const id = document.getElementById('accEditId').value, name = document.getElementById('accFormName').value.trim(), role = document.getElementById('accFormRole').value, pin = document.getElementById('accFormPin').value.trim();
  if (!name || !/^\d{4}$/.test(pin)) { showToast('Enter name and 4-digit PIN.', 'warning'); return; }
  if (id) {
    const idx = accounts.findIndex(a => a.id === id); if (idx === -1) return;
    if (accounts[idx].role === 'manager' && role !== 'manager' && !accounts.some(a => a.role === 'manager' && a.id !== id)) { showToast('One Manager required.', 'error'); return; }
    accounts[idx] = { ...accounts[idx], name, role, pin };
    if (currentUser && currentUser.id === id) { currentUser = accounts[idx]; localStorage.setItem(PREFIX + 'session', JSON.stringify({ id, pin })); applyRoleUI(); }
    showToast(`Updated ${name}`, 'success');
  } else {
    if (accounts.some(a => a.name.toLowerCase() === name.toLowerCase())) { showToast('Name exists.', 'warning'); return; }
    accounts.push({ id: 'acc_' + Date.now(), name, role, pin }); showToast(`Added ${name}`, 'success');
  }
  pushAccountsToCloud(); resetAccountForm(); renderAccountsModalList();
}
function removeAccount(id) {
  if (!isManager()) return;
  const t = accounts.find(a => a.id === id); if (!t) return;
  if (t.role === 'manager' && accounts.filter(a => a.role === 'manager').length <= 1) { showToast('Cannot remove only Manager.', 'error'); return; }
  if (currentUser && currentUser.id === id) { showToast('Switch Manager first.', 'warning'); return; }
  if (!confirm(`Revoke access for "${t.name}"?`)) return;
  accounts = accounts.filter(a => a.id !== id); pushAccountsToCloud(); renderAccountsModalList(); showToast(`Removed ${t.name}`, 'info');
}
function renderAccountsModalList() {
  const c = document.getElementById('accountsList'); if (!c) return;
  c.innerHTML = '';
  accounts.forEach(acc => {
    const row = document.createElement('div'); row.className = 'list-row-card';
    row.innerHTML = `<div><div style="font-weight:800; font-size:13.5px;">${escapeHtml(acc.name)}</div><div style="display:flex; gap:6px; align-items:center; margin-top:2px;"><span class="role-pill role-${acc.role}">${roleLabel(acc.role)}</span><span style="font-size:11px; color:var(--text-muted); font-weight:700;">PIN: ${escapeHtml(acc.pin)}</span></div></div><div style="display:flex; gap:5px;"><button class="btn btn-outline" style="padding:4px 8px; font-size:11px;" onclick="editAccount('${acc.id}')">Edit</button><button class="btn btn-outline" style="padding:4px 8px; font-size:11px; color:var(--danger);" onclick="removeAccount('${acc.id}')">✕</button></div>`;
    c.appendChild(row);
  });
}
function openBackupsModal() { if (isManager()) { renderCloudBackupsList(); document.getElementById('backupsModal').style.display = 'flex'; } }
function saveCloudSnapshot() {
  if (!isManager()) return;
  const inp = document.getElementById('snapshotLabelInput'), label = inp.value.trim() || `Snapshot (${formatShortTime(Date.now())})`, id = 'bk_' + Date.now();
  db.ref(`${ROOT}/backups/${id}`).set({ id, label, createdBy: currentUser.name, createdAt: Date.now(), skus, orders: buyOrders, accounts, vendors, categories }).then(() => { inp.value = ''; showToast('Snapshot saved', 'success'); });
}
function renderCloudBackupsList() {
  const c = document.getElementById('cloudBackupsList'), items = Object.values(cloudBackups || {}).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!items.length) { c.innerHTML = `<div style="text-align:center; padding:12px; font-size:12px; color:var(--text-muted); background:var(--bg); border-radius:8px; border:1px dashed var(--border);">No cloud restore points yet.</div>`; return; }
  c.innerHTML = '';
  items.forEach(bk => {
    const len = Array.isArray(bk.skus) ? bk.skus.length : (bk.skus ? Object.keys(bk.skus).length : 0);
    const row = document.createElement('div'); row.className = 'list-row-card';
    row.innerHTML = `<div style="min-width:0;"><div style="font-size:13px; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(bk.label)}</div><div style="font-size:11px; color:var(--text-muted);">${formatShortTime(bk.createdAt)} · ${len} SKUs</div></div><div style="display:flex; gap:5px;"><button class="btn btn-primary" style="padding:4px 8px; font-size:11px;" onclick="restoreCloudSnapshot('${bk.id}')">Restore</button><button class="btn btn-outline" style="padding:4px 8px; font-size:11px; color:var(--danger);" onclick="deleteCloudSnapshot('${bk.id}')">✕</button></div>`;
    c.appendChild(row);
  });
}
function restoreCloudSnapshot(bkId) {
  const bk = cloudBackups[bkId]; if (!isManager() || !bk || !confirm(`Restore "${bk.label}"?`)) return;
  if (bk.skus) { skus = Array.isArray(bk.skus) ? bk.skus : Object.values(bk.skus); pushSkusToCloud(); }
  buyOrders = bk.orders || {}; pushOrdersToCloud();
  if (bk.accounts) { accounts = Array.isArray(bk.accounts) ? bk.accounts : Object.values(bk.accounts); pushAccountsToCloud(); }
  if (bk.vendors) { vendors = uniqueSorted(bk.vendors); pushVendorsToCloud(); }
  if (bk.categories) { categories = uniqueSorted(bk.categories); pushCategoriesToCloud(); }
  closeModal('backupsModal'); showToast(`Restored "${bk.label}"`, 'success', 4000);
}
function deleteCloudSnapshot(bkId) { if (isManager() && confirm('Delete snapshot?')) { db.ref(`${ROOT}/backups/${bkId}`).remove(); showToast('Snapshot deleted', 'info'); } }
function downloadFullBackup() {
  if (!isManager()) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify({ app: CFG.appName || 'Swirla Ops', exportedAt: new Date().toISOString(), skus, orders: buyOrders, accounts, vendors, categories, photos: itemPhotos, history: historyLogs }, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `${PREFIX}backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url);
  showToast('Backup downloaded', 'success');
}
function handleBackupFileUpload(event) {
  if (!isManager() || !event.target.files[0]) return;
  const r = new FileReader();
  r.onload = e => {
    try {
      const p = JSON.parse(e.target.result);
      if (!p || !Array.isArray(p.skus)) { showToast('Invalid backup.', 'error'); return; }
      if (!confirm(`Restore ${p.skus.length} SKUs?`)) return;
      skus = p.skus; pushSkusToCloud();
      if (p.orders !== undefined) { buyOrders = p.orders || {}; pushOrdersToCloud(); }
      if (Array.isArray(p.accounts) && p.accounts.length) { accounts = p.accounts; pushAccountsToCloud(); }
      if (Array.isArray(p.vendors)) { vendors = uniqueSorted(p.vendors); pushVendorsToCloud(); }
      if (Array.isArray(p.categories)) { categories = uniqueSorted(p.categories); pushCategoriesToCloud(); }
      if (p.photos) { itemPhotos = p.photos; db.ref(`${ROOT}/photos`).set(itemPhotos); }
      closeModal('backupsModal'); showToast('Backup restored!', 'success', 4000);
    } catch (err) { showToast('Invalid JSON file.', 'error'); }
  };
  r.readAsText(event.target.files[0]); event.target.value = '';
}
function resetToOriginalCatalog() {
  if (!isManager() || !confirm('Reset catalog to baseline items?') || !confirm('Final confirmation: wipe changes and clear checklist?')) return;
  skus = JSON.parse(JSON.stringify(INITIAL_SKUS)); buyOrders = {};
  vendors = uniqueSorted([...(CFG.defaultVendors || []), ...skus.map(s => s.vendor)]);
  categories = uniqueSorted([...(CFG.defaultCategories || []), ...skus.map(s => s.cat)]);
  pushSkusToCloud(); pushOrdersToCloud(); pushVendorsToCloud(); pushCategoriesToCloud();
  closeModal('backupsModal'); showToast('Restored baseline catalog', 'success', 4000);
}

/* 17. SKU Modal & Item Detail */
function checkDuplicateSkuName() {
  const editId = document.getElementById('editSkuId').value, val = document.getElementById('editSkuName').value.trim().toLowerCase(), warn = document.getElementById('duplicateSkuWarning');
  const match = val ? skus.find(s => s.id !== editId && s.name.trim().toLowerCase() === val) : null;
  if (match) { warn.innerText = `⚠️ "${match.name}" already exists under ${match.vendor}.`; warn.style.display = 'block'; }
  else warn.style.display = 'none';
}
function openSkuModal(id = null) {
  if (!isLeaderOrManager()) return;
  populateFilters();
  document.getElementById('duplicateSkuWarning').style.display = 'none';
  if (id) {
    const it = skus.find(s => s.id === id); if (!it) return;
    document.getElementById('skuModalTitle').innerText = 'Edit SKU';
    document.getElementById('editSkuId').value = it.id; document.getElementById('editSkuName').value = it.name;
    document.getElementById('editSkuVendor').value = it.vendor; document.getElementById('editSkuCategory').value = it.cat;
    document.getElementById('editSkuStock').value = it.stock; document.getElementById('editSkuUnit').value = it.unit || '';
    document.getElementById('editSkuMin').value = it.min; document.getElementById('editSkuMax').value = it.max;
    document.getElementById('editSkuNote').value = it.note || '';
    document.getElementById('deleteSkuBtn').style.display = isManager() ? 'inline-flex' : 'none';
  } else {
    document.getElementById('skuModalTitle').innerText = 'Add New SKU';
    ['editSkuId', 'editSkuName', 'editSkuVendor', 'editSkuCategory', 'editSkuUnit', 'editSkuNote'].forEach(k => document.getElementById(k).value = '');
    ['editSkuStock', 'editSkuMin', 'editSkuMax'].forEach(k => document.getElementById(k).value = 0);
    document.getElementById('deleteSkuBtn').style.display = 'none';
  }
  document.getElementById('skuModal').style.display = 'flex';
}
function saveSkuModal() {
  if (!isLeaderOrManager()) return;
  const id = document.getElementById('editSkuId').value, name = document.getElementById('editSkuName').value.trim(), vendor = document.getElementById('editSkuVendor').value.trim(), cat = document.getElementById('editSkuCategory').value.trim();
  const stock = Math.max(0, parseInt(document.getElementById('editSkuStock').value) || 0), unit = document.getElementById('editSkuUnit').value.trim();
  const min = Math.max(0, parseInt(document.getElementById('editSkuMin').value) || 0), max = Math.max(0, parseInt(document.getElementById('editSkuMax').value) || 0), note = document.getElementById('editSkuNote').value.trim();
  if (!name || !vendor || !cat) { showToast('Select Vendor, Category, and enter Name.', 'warning'); return; }
  if (id) {
    const it = skus.find(s => s.id === id);
    if (it) {
      const oldS = it.stock; it.name = name; it.vendor = vendor; it.cat = cat; it.stock = stock; it.min = min; it.max = max;
      if (unit) it.unit = unit; else delete it.unit;
      if (note) it.note = note; else delete it.note;
      it.updatedBy = currentUser.name; it.updatedAt = Date.now();
      logHistory('sku', `Edited SKU "${name}" (${vendor}) · Stock ${oldS} → ${stock}, Min/Max ${min}/${max}`);
      showToast(`Updated ${name}`, 'success');
    }
  } else {
    const s = { id: Date.now().toString(), name, vendor, cat, stock, min, max, updatedBy: currentUser.name, updatedAt: Date.now() };
    if (unit) s.unit = unit; if (note) s.note = note;
    skus.unshift(s); logHistory('sku', `Created SKU "${name}" (${vendor}) · Stock: ${stock}`); showToast(`Added ${name}`, 'success');
  }
  pushSkusToCloud(); populateFilters(); renderCatalog(); renderChecklist(); refreshOpenDetailModal(); closeModal('skuModal');
}
function deleteCurrentSku() {
  if (!isManager()) return;
  const id = document.getElementById('editSkuId').value, it = skus.find(s => s.id === id);
  if (!it || !confirm(`Delete "${it.name}" permanently?`)) return;
  skus = skus.filter(s => s.id !== id); pushSkusToCloud();
  if (buyOrders[id]) { delete buyOrders[id]; pushOrdersToCloud(); }
  if (itemPhotos[id]) { delete itemPhotos[id]; pushSkuPhotosToCloud(id); }
  logHistory('sku', `Deleted SKU "${it.name}" (${it.vendor})`);
  closeModal('skuModal'); if (activeDetailSkuId === id) closeModal('itemDetailModal');
  populateFilters(); renderCatalog(); renderChecklist(); showToast(`Deleted ${it.name}`, 'info');
}

function openItemDetailModal(id) {
  const it = skus.find(s => s.id === id); if (!it) return;
  activeDetailSkuId = id;
  document.getElementById('detailSkuVendor').innerText = it.vendor;
  document.getElementById('detailSkuName').innerText = it.name;
  document.getElementById('detailSkuCat').innerText = it.cat;
  document.getElementById('detailSkuUpdated').innerText = it.updatedBy ? `Updated by ${it.updatedBy}${it.updatedAt ? ' · ' + formatShortTime(it.updatedAt) : ''}` : '';
  document.getElementById('detailSkuStock').innerText = `${it.stock} ${it.unit || 'Units'}`;
  document.getElementById('detailSkuMin').innerText = it.min;
  document.getElementById('detailSkuMax').innerText = it.max;
  const nb = document.getElementById('detailSkuNoteBox');
  if (it.note) { document.getElementById('detailSkuNoteText').innerText = it.note; nb.style.display = 'flex'; } else nb.style.display = 'none';
  const leadOrMgr = isLeaderOrManager();
  document.getElementById('detailActionRow').style.display = leadOrMgr ? 'flex' : 'none';
  if (leadOrMgr) updateDetailOrderButton(id);
  renderDetailPhotos();
  document.getElementById('itemDetailModal').style.display = 'flex';
}
function updateDetailOrderButton(id) {
  const it = skus.find(s => s.id === id);
  const isOrd = buyOrders[id] !== undefined;
  const grp = document.getElementById('detailOrderGroup'), inp = document.getElementById('detailOrderQtyInput'), btn = document.getElementById('detailOrderBtn');
  if (grp) grp.classList.toggle('ordered', isOrd);
  if (inp && it) inp.value = isOrd ? Math.max(1, parseInt(buyOrders[id].qty) || 1) : (draftOrderQtys[id] || getSuggestedOrderQty(it));
  if (btn) btn.innerText = isOrd ? '✓ In List' : '+ Order';
}
function onDetailOrderQtyChange(val) { if (activeDetailSkuId) commitCatalogOrderQty(activeDetailSkuId, val); }
function editFromDetail() { if (isLeaderOrManager() && activeDetailSkuId) { const id = activeDetailSkuId; closeModal('itemDetailModal'); openSkuModal(id); } }
function toggleOrderFromDetail() {
  if (!isLeaderOrManager() || !activeDetailSkuId) return;
  const inp = document.getElementById('detailOrderQtyInput');
  toggleOrder(activeDetailSkuId, inp ? inp.value : null);
}
function renderDetailPhotos() {
  const id = activeDetailSkuId; if (!id) return;
  const c = document.getElementById('detailGalleryList'), photos = Array.isArray(itemPhotos[id]) ? itemPhotos[id] : [], mgr = isManager();
  document.getElementById('detailPhotoCount').innerText = photos.length;
  document.getElementById('detailAddBtn').style.display = photos.length >= 3 ? 'none' : 'inline-flex';
  if (!photos.length) { c.innerHTML = `<div style="text-align:center; padding:22px 10px; background:var(--bg); border-radius:10px; border:1px dashed var(--border); color:var(--text-muted); font-size:13px;">No reference photos yet.</div>`; return; }
  c.innerHTML = '';
  photos.forEach((url, idx) => {
    const card = document.createElement('div'); card.style.cssText = 'position:relative; background:#1B1A26; border-radius:10px; overflow:hidden; border:1px solid var(--border);';
    card.innerHTML = `<img src="${url}" style="width:100%; max-height:360px; object-fit:contain; display:block;"><div style="position:absolute; top:8px; left:8px; background:rgba(0,0,0,0.7); color:#fff; font-size:11px; font-weight:700; padding:3px 8px; border-radius:6px;">Photo ${idx + 1} of ${photos.length}</div>${mgr ? `<button class="btn" style="position:absolute; top:8px; right:8px; background:#DC2626; color:#fff; padding:5px 10px; font-size:12px;" onclick="deletePhoto('${id}', ${idx})">🗑️ Delete</button>` : ''}`;
    c.appendChild(card);
  });
}
function deletePhoto(id, idx) {
  if (!isManager() || !confirm('Delete this photo?')) return;
  const p = Array.isArray(itemPhotos[id]) ? itemPhotos[id] : [];
  p.splice(idx, 1); if (!p.length) delete itemPhotos[id]; else itemPhotos[id] = p;
  renderDetailPhotos(); renderCatalog(); if (!isEditingChecklist()) renderChecklist();
  pushSkuPhotosToCloud(id).then(() => showToast('Photo deleted', 'info'));
}
function triggerPhotoFromDetail() { if (activeDetailSkuId) triggerPhoto(activeDetailSkuId); }

window.onload = function() { populateFilters(); renderCatalog(); };
