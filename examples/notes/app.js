// Ratatoskr Notes - Collaborative Document Editor Example
//
// Document namespace: dev.tionis.notes
// - app:dev.tionis.notes - User's index document (server routes to user-specific version)
// - doc:dev.tionis.notes:{hash} - Individual note documents

const SERVER_URL = "http://localhost:4151";
const APP_NAMESPACE = "dev.tionis.notes";

// Client and repo
let RatatoskrClient;
let client;
let repo;

// App state
let appDocHandle = null;
let appDocUrl = null;
let currentUser = null;
let currentDocUrl = null; // automerge URL - this IS the document ID
let currentDocHandle = null;
let currentAcl = [];
let isOwner = false;
let pendingConfirmCallback = null;
let isViewerMode = false;

// DOM Elements
const loginScreen = document.getElementById("login-screen");
const loadingScreen = document.getElementById("loading-screen");
const mainApp = document.getElementById("main-app");
const welcomeView = document.getElementById("welcome-view");
const editorView = document.getElementById("editor-view");
const editor = document.getElementById("editor");
const toastContainer = document.getElementById("toast-container");

// ============ Initialization ============

async function initializeClient() {
  try {
    const module = await import(`${SERVER_URL}/ui/lib/ratatoskr-client.js`);
    RatatoskrClient = module.RatatoskrClient;
    client = new RatatoskrClient({
      serverUrl: SERVER_URL,
    });
    return true;
  } catch (err) {
    console.error("Failed to load Ratatoskr client:", err);
    showToast("Failed to connect to server", "error");
    return false;
  }
}

/**
 * Get the localStorage key for app document URL, scoped by user ID.
 */
function getAppDocKey(userId) {
  return `ratatoskr:${APP_NAMESPACE}:app-url:${userId}`;
}

/**
 * Get server document ID from automerge URL.
 * Simple prefix, no mapping needed.
 */
function getServerId(automergeUrl) {
  const hash = automergeUrl.replace("automerge:", "");
  return `doc:${APP_NAMESPACE}:${hash}`;
}

/**
 * Get server app document ID.
 */
function getAppServerId(automergeUrl) {
  const hash = automergeUrl.replace("automerge:", "");
  return `app:${APP_NAMESPACE}:${hash}`;
}

async function initializeAppDocument() {
  if (!currentUser) return;

  // Check if we have a stored app document URL for this user
  const storageKey = getAppDocKey(currentUser.id);
  appDocUrl = localStorage.getItem(storageKey);

  if (appDocUrl) {
    try {
      appDocHandle = await repo.find(appDocUrl);
      await waitForHandle(appDocHandle);

      const doc = getDocFromHandle(appDocHandle);
      if (doc && doc.notes !== undefined) {
        appDocHandle.on("change", () => renderDocumentList());
        return;
      }
    } catch (err) {
      console.warn("Could not load app document, creating new one:", err);
      localStorage.removeItem(storageKey);
    }
  }

  // Create new app document
  appDocHandle = repo.create();
  appDocUrl = appDocHandle.url;
  const appAutomergeHash = appDocUrl.replace("automerge:", "");

  // Store the URL for this user
  localStorage.setItem(storageKey, appDocUrl);

  // Register with server
  try {
    await client.createDocument({
      id: getAppServerId(appDocUrl),
      automergeId: appAutomergeHash,
      type: "app-index",
    });
  } catch (err) {
    console.warn("Could not register app document with server:", err);
  }

  // Initialize structure
  appDocHandle.change((d) => {
    d.notes = [];
    d.settings = {};
    d.version = 1;
  });

  appDocHandle.on("change", () => renderDocumentList());
}

// ============ Helper Functions ============

function getDocFromHandle(handle) {
  if (typeof handle.doc === "function") return handle.doc();
  if (typeof handle.docSync === "function") return handle.docSync();
  if (handle.doc !== undefined && typeof handle.doc !== "function")
    return handle.doc;
  return undefined;
}

async function waitForHandle(handle, timeoutMs = 5000) {
  if (!handle) throw new Error("Invalid handle");

  if (typeof handle.whenReady === "function") {
    try {
      await handle.whenReady(["ready", "unavailable"]);
      return;
    } catch (err) {
      console.warn("whenReady failed:", err);
    }
  }

  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const doc = getDocFromHandle(handle);
      if (doc !== undefined) {
        resolve();
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        reject(new Error("Timeout waiting for document"));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

// ============ URL Hash Routing ============

// Base58 characters (Bitcoin alphabet)
const BASE58_REGEX =
  /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;

function isValidAutomergeHash(hash) {
  // Automerge document IDs are base58 encoded, variable length
  // Minimum ~20 chars to reject obvious non-hashes like "test"
  return hash.length >= 20 && BASE58_REGEX.test(hash);
}

function getDocFromHash() {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;

  // Full automerge URL
  if (hash.startsWith("automerge:")) {
    const docHash = hash.slice("automerge:".length);
    if (!isValidAutomergeHash(docHash)) {
      console.warn("Invalid automerge hash in URL:", hash);
      return null;
    }
    return { url: hash };
  }

  // Just the hash part - validate it
  if (!isValidAutomergeHash(hash)) {
    console.warn("Invalid automerge hash in URL:", hash);
    return null;
  }

  return { url: `automerge:${hash}` };
}

function setDocHash(automergeUrl) {
  if (automergeUrl) {
    const hash = automergeUrl.replace("automerge:", "");
    window.location.hash = hash;
  }
}

function clearDocHash() {
  history.pushState(
    null,
    "",
    window.location.pathname + window.location.search,
  );
}

function getShareableLink() {
  if (!currentDocUrl) return null;
  const hash = currentDocUrl.replace("automerge:", "");
  return `${window.location.origin}${window.location.pathname}#${hash}`;
}

// ============ Utility Functions ============

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

function closeAllModals() {
  document.querySelectorAll(".modal").forEach((m) => {
    m.classList.add("hidden");
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

function formatDate(isoString) {
  if (!isoString) return "Never";
  return new Date(isoString).toLocaleDateString();
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

// ============ Authentication ============

async function checkAuth() {
  const hashDoc = getDocFromHash();

  // Check stored credentials and validate token
  if (client.hasStoredCredentials()) {
    // Verify token is still valid with server
    const isValid = await client.validateToken();
    if (!isValid) {
      console.warn("Stored token is invalid or expired, logging out");
      client.logout();
      // Fall through to show login or viewer mode
    } else {
      currentUser = client.getUser();
      isViewerMode = false;
      showMainApp();
      repo = client.getRepo();
      await initializeAppDocument();
      renderDocumentList();

      if (hashDoc) {
        await openDocumentByUrl(hashDoc.url);
      }
      return;
    }
  }

  // Not authenticated or token was invalid
  if (hashDoc) {
    // There's a document to view
    isViewerMode = true;
    await showViewerMode(hashDoc);
  } else {
    showLogin();
  }
}

function showLoading() {
  loadingScreen?.classList.remove("hidden");
  loginScreen.classList.add("hidden");
  mainApp.classList.add("hidden");
}

function showLogin() {
  loginScreen.classList.remove("hidden");
  loadingScreen?.classList.add("hidden");
  mainApp.classList.add("hidden");
}

function showMainApp() {
  loginScreen.classList.add("hidden");
  loadingScreen?.classList.add("hidden");
  mainApp.classList.remove("hidden");

  if (isViewerMode) {
    document.getElementById("user-name").textContent = "Viewer";
    document.getElementById("sidebar").classList.add("viewer-mode");
  } else {
    document.getElementById("user-name").textContent =
      currentUser?.name || currentUser?.email || currentUser?.id || "User";
    document.getElementById("sidebar").classList.remove("viewer-mode");
  }
}

async function showViewerMode(hashDoc) {
  showMainApp();

  document.getElementById("new-doc-btn").style.display = "none";
  document.getElementById("refresh-docs-btn").style.display = "none";
  document.getElementById("settings-btn").style.display = "none";
  document.getElementById("owned-docs-list").innerHTML =
    '<div class="empty-state-small">Sign in to see your documents</div>';
  document.getElementById("shared-docs-list").innerHTML = "";

  const footer = document.querySelector(".sidebar-footer .user-menu");
  footer.innerHTML = `<button id="viewer-login-btn" class="btn btn-primary btn-small">Sign In</button>`;
  document
    .getElementById("viewer-login-btn")
    .addEventListener("click", handleLogin);

  try {
    repo = client.getRepo();
    if (hashDoc?.url) {
      await openDocumentByUrl(hashDoc.url, { readOnly: true });
    }
  } catch (err) {
    console.error("Failed to open document in viewer mode:", err);
    showViewerLoginPrompt();
  }
}

function showViewerLoginPrompt() {
  showToast("Sign in to view this document", "info");
  welcomeView.classList.remove("hidden");
  editorView.classList.add("hidden");
  document.querySelector(".welcome-content h2").textContent = "Sign in to view";
  document.querySelector(".welcome-content p").textContent =
    "This document may require authentication to view.";
  document.getElementById("welcome-new-doc-btn").textContent = "Sign In";
  document.getElementById("welcome-new-doc-btn").onclick = handleLogin;
}

async function handleLogin() {
  const wasViewingDoc = isViewerMode && currentDocUrl;
  const docToReopen = currentDocUrl;

  try {
    currentUser = await client.login();
    isViewerMode = false;

    // Reset UI
    document.getElementById("new-doc-btn").style.display = "";
    document.getElementById("refresh-docs-btn").style.display = "";
    document.getElementById("settings-btn").style.display = "";

    document.querySelector(".welcome-content h2").textContent =
      "Welcome to Ratatoskr Notes";
    document.querySelector(".welcome-content p").textContent =
      "Select a document from the sidebar or create a new one to get started.";
    document.getElementById("welcome-new-doc-btn").textContent =
      "Create Your First Document";
    document.getElementById("welcome-new-doc-btn").onclick = () =>
      openModal("new-doc-modal");

    // Restore sidebar footer
    const footer = document.querySelector(".sidebar-footer .user-menu");
    footer.innerHTML = `
      <span id="user-name" class="user-name">User</span>
      <button id="settings-btn" class="btn-icon" title="Settings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/>
        </svg>
      </button>
      <button id="logout-btn" class="btn-icon" title="Logout">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>
        </svg>
      </button>
    `;
    document
      .getElementById("settings-btn")
      .addEventListener("click", openSettings);
    document
      .getElementById("logout-btn")
      .addEventListener("click", handleLogout);

    showMainApp();
    repo = client.getRepo();
    await initializeAppDocument();
    renderDocumentList();

    if (wasViewingDoc && docToReopen) {
      closeDocument();
      await openDocumentByUrl(docToReopen);
    }

    showToast("Welcome back!", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

function handleLogout() {
  client.logout();
  currentUser = null;
  repo = null;
  appDocHandle = null;
  appDocUrl = null;
  closeDocument();
  showLogin();
  showToast("Logged out", "info");
}

// ============ Document List ============

function getNotesFromAppDoc() {
  if (!appDocHandle) return [];
  const doc = getDocFromHandle(appDocHandle);
  return doc?.notes || [];
}

function renderDocumentList() {
  const ownedList = document.getElementById("owned-docs-list");
  const sharedList = document.getElementById("shared-docs-list");

  const notes = getNotesFromAppDoc();

  if (notes.length === 0) {
    ownedList.innerHTML =
      '<div class="empty-state-small">No documents yet</div>';
  } else {
    ownedList.innerHTML = notes
      .map((note) => {
        const isActive = note.url === currentDocUrl;
        return `
          <div class="doc-item ${isActive ? "active" : ""}" data-url="${escapeHtml(note.url)}">
            <div class="doc-item-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
              </svg>
            </div>
            <div class="doc-item-info">
              <span class="doc-item-title">${escapeHtml(note.title || "Untitled")}</span>
              <span class="doc-item-meta">${formatDate(note.updatedAt || note.createdAt)}</span>
            </div>
          </div>
        `;
      })
      .join("");

    ownedList.querySelectorAll(".doc-item").forEach((item) => {
      item.addEventListener("click", () => openDocumentByUrl(item.dataset.url));
    });
  }

  sharedList.innerHTML =
    '<div class="empty-state-small">Share documents via ACL settings</div>';
}

// ============ Document Operations ============

async function createDocument(title) {
  try {
    const handle = repo.create();
    const docUrl = handle.url;
    const automergeHash = docUrl.replace("automerge:", "");
    const serverId = getServerId(docUrl);

    // Register with server first
    try {
      await client.createDocument({
        id: serverId,
        automergeId: automergeHash,
        type: "note",
      });
    } catch (err) {
      console.warn("Could not register document with server:", err);
    }

    // Initialize content
    handle.change((doc) => {
      doc.title = title || "Untitled";
      doc.content = "";
      doc.createdAt = new Date().toISOString();
      doc.updatedAt = new Date().toISOString();
    });

    // Add to app index
    appDocHandle.change((appDoc) => {
      if (!appDoc.notes) appDoc.notes = [];
      appDoc.notes.unshift({
        url: docUrl,
        title: title || "Untitled",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    renderDocumentList();
    await openDocumentByUrl(docUrl);
    showToast("Document created", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function openDocumentByUrl(docUrl, options = {}) {
  const { readOnly = false } = options;

  if (currentDocHandle) {
    currentDocHandle.off("change", handleDocumentChange);
  }

  // Find note info from our index
  const notes = getNotesFromAppDoc();
  const noteInfo = notes.find((n) => n.url === docUrl);

  currentDocUrl = docUrl;

  // Owner if it's in our index (we created it)
  isOwner = !isViewerMode && !!noteInfo;

  setDocHash(docUrl);

  welcomeView.classList.add("hidden");
  editorView.classList.remove("hidden");

  // Update sidebar
  if (!isViewerMode) {
    document.querySelectorAll(".doc-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.url === docUrl);
    });
  }

  // Show/hide owner buttons
  document.getElementById("share-btn").style.display = isOwner ? "" : "none";
  document.getElementById("delete-doc-btn").style.display = isOwner
    ? ""
    : "none";

  // Handle read-only mode (only in viewer mode)
  const titleInput = document.getElementById("doc-title-input");
  const shouldBeReadOnly = readOnly || isViewerMode;

  if (shouldBeReadOnly) {
    editor.setAttribute("readonly", "true");
    titleInput.setAttribute("readonly", "true");
    editor.classList.add("readonly");
    titleInput.classList.add("readonly");
  } else {
    editor.removeAttribute("readonly");
    titleInput.removeAttribute("readonly");
    editor.classList.remove("readonly");
    titleInput.classList.remove("readonly");
  }

  setSyncStatus("syncing");

  try {
    currentDocHandle = await repo.find(docUrl);
    await waitForHandle(currentDocHandle, isViewerMode ? 10000 : 5000);

    const doc = getDocFromHandle(currentDocHandle);
    if (!doc) {
      if (isViewerMode) {
        showViewerLoginPrompt();
        return;
      }
      showToast("Document unavailable", "error");
      setSyncStatus("error");
      currentDocHandle = null;
      return;
    }

    titleInput.value = doc.title || "";
    editor.value = doc.content || "";
    updateCharCount();

    currentDocHandle.on("change", handleDocumentChange);
    setSyncStatus("synced");
  } catch (err) {
    if (isViewerMode) {
      showViewerLoginPrompt();
      return;
    }
    showToast(`Failed to open document: ${err.message}`, "error");
    setSyncStatus("error");
    currentDocHandle = null;
  }
}

function handleDocumentChange({ doc }) {
  const currentContent = editor.value;
  const newContent = doc.content || "";

  if (newContent !== currentContent) {
    const selStart = editor.selectionStart;
    const selEnd = editor.selectionEnd;
    editor.value = newContent;
    editor.selectionStart = Math.min(selStart, newContent.length);
    editor.selectionEnd = Math.min(selEnd, newContent.length);
  }

  const titleInput = document.getElementById("doc-title-input");
  if (doc.title && doc.title !== titleInput.value) {
    titleInput.value = doc.title;
  }

  updateCharCount();
  setSyncStatus("synced");
}

function closeDocument() {
  if (currentDocHandle) {
    currentDocHandle.off("change", handleDocumentChange);
    currentDocHandle = null;
  }
  currentDocUrl = null;

  clearDocHash();

  welcomeView.classList.remove("hidden");
  editorView.classList.add("hidden");

  editor.removeAttribute("readonly");
  document.getElementById("doc-title-input").removeAttribute("readonly");
  editor.classList.remove("readonly");
  document.getElementById("doc-title-input").classList.remove("readonly");

  document.querySelectorAll(".doc-item").forEach((item) => {
    item.classList.remove("active");
  });
}

async function deleteDocument(docUrl) {
  const notes = getNotesFromAppDoc();
  const note = notes.find((n) => n.url === docUrl);

  if (!note) {
    showToast("Document not found", "error");
    return;
  }

  try {
    const serverId = getServerId(docUrl);
    try {
      await client.deleteDocument(serverId);
    } catch (err) {
      console.warn("Could not delete from server:", err);
    }

    appDocHandle.change((appDoc) => {
      if (appDoc.notes) {
        const idx = appDoc.notes.findIndex((n) => n.url === docUrl);
        if (idx >= 0) appDoc.notes.splice(idx, 1);
      }
    });

    showToast("Document deleted", "success");

    if (currentDocUrl === docUrl) {
      closeDocument();
    }
    renderDocumentList();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ============ Editor ============

let saveTimeout = null;

function handleEditorInput() {
  if (!currentDocHandle || typeof currentDocHandle.change !== "function")
    return;

  setSyncStatus("syncing");

  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    if (!currentDocHandle || typeof currentDocHandle.change !== "function")
      return;

    const content = editor.value;
    currentDocHandle.change((doc) => {
      doc.content = content;
      doc.updatedAt = new Date().toISOString();
    });

    updateNoteInIndex({ updatedAt: new Date().toISOString() });
    setSyncStatus("synced");
  }, 300);

  updateCharCount();
}

function handleTitleChange() {
  if (!currentDocHandle || typeof currentDocHandle.change !== "function")
    return;

  const title = document.getElementById("doc-title-input").value;
  currentDocHandle.change((doc) => {
    doc.title = title;
    doc.updatedAt = new Date().toISOString();
  });

  updateNoteInIndex({ title, updatedAt: new Date().toISOString() });
  renderDocumentList();
}

function updateNoteInIndex(updates) {
  if (!appDocHandle || !currentDocUrl) return;

  appDocHandle.change((appDoc) => {
    if (!appDoc.notes) return;
    const note = appDoc.notes.find((n) => n.url === currentDocUrl);
    if (note) Object.assign(note, updates);
  });
}

function updateCharCount() {
  const count = editor.value.length;
  document.getElementById("char-count").textContent =
    `${count.toLocaleString()} characters`;
}

function setSyncStatus(status) {
  const statusEl = document.getElementById("sync-status");
  const textEl = statusEl.querySelector(".sync-text");

  statusEl.className = `sync-status ${status}`;

  switch (status) {
    case "synced":
      textEl.textContent = "Synced";
      break;
    case "syncing":
      textEl.textContent = "Saving...";
      break;
    case "error":
      textEl.textContent = "Error";
      break;
    case "offline":
      textEl.textContent = "Offline";
      break;
  }
}

// ============ Sharing / ACL ============

async function openShareModal() {
  if (!currentDocUrl || !isOwner) {
    showToast("Cannot share this document", "error");
    return;
  }

  const serverId = getServerId(currentDocUrl);

  document.getElementById("share-doc-title").textContent =
    document.getElementById("doc-title-input").value || "Untitled";

  document.getElementById("share-link-input").value = getShareableLink() || "";

  openModal("share-modal");

  const shareList = document.getElementById("share-list");
  shareList.innerHTML = '<div class="loading-small">Loading...</div>';

  try {
    const acl = await client.getDocumentACL(serverId);
    currentAcl = acl || [];
    renderShareList();
  } catch (_err) {
    shareList.innerHTML = '<div class="empty-state-small">Failed to load</div>';
    showToast("Failed to load sharing settings", "error");
  }
}

function renderShareList() {
  const container = document.getElementById("share-list");

  const publicEntry = currentAcl.find((e) => e.principal === "public");
  document.getElementById("public-read-toggle").checked = !!publicEntry;

  const userEntries = currentAcl.filter((e) => e.principal !== "public");

  if (userEntries.length === 0) {
    container.innerHTML =
      '<div class="empty-state-small">No one else has access</div>';
    return;
  }

  container.innerHTML = userEntries
    .map(
      (entry, idx) => `
      <div class="share-entry" data-principal="${escapeHtml(entry.principal)}">
        <div class="share-entry-info">
          <span class="share-entry-user">${escapeHtml(entry.principal)}</span>
          <select class="share-entry-permission" data-idx="${idx}">
            <option value="read" ${entry.permission === "read" ? "selected" : ""}>Can view</option>
            <option value="write" ${entry.permission === "write" ? "selected" : ""}>Can edit</option>
          </select>
        </div>
        <button class="btn btn-danger btn-small share-remove-btn" data-principal="${escapeHtml(entry.principal)}">Remove</button>
      </div>
    `,
    )
    .join("");

  container.querySelectorAll(".share-entry-permission").forEach((select) => {
    select.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const entry = userEntries[idx];
      const aclIdx = currentAcl.findIndex(
        (item) => item.principal === entry.principal,
      );
      if (aclIdx >= 0) currentAcl[aclIdx].permission = e.target.value;
    });
  });

  container.querySelectorAll(".share-remove-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const principal = e.target.dataset.principal;
      currentAcl = currentAcl.filter((item) => item.principal !== principal);
      renderShareList();
    });
  });
}

function addShareEntry() {
  const userInput = document.getElementById("share-user-input");
  const permission = document.getElementById("share-permission").value;
  const principal = userInput.value.trim();

  if (!principal) {
    showToast("Please enter a user ID", "error");
    return;
  }

  if (currentAcl.some((e) => e.principal === principal)) {
    showToast("User already has access", "error");
    return;
  }

  currentAcl.push({ principal, permission });
  userInput.value = "";
  renderShareList();
}

function handlePublicToggle() {
  const isPublic = document.getElementById("public-read-toggle").checked;
  currentAcl = currentAcl.filter((e) => e.principal !== "public");
  if (isPublic) {
    currentAcl.push({ principal: "public", permission: "read" });
  }
}

async function saveShareSettings() {
  const serverId = getServerId(currentDocUrl);
  try {
    await client.setDocumentACL(serverId, currentAcl);
    closeModal("share-modal");
    showToast("Sharing settings saved", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ============ Settings ============

function openSettings() {
  openModal("settings-modal");
  loadAccountInfo();
  loadTokens();
}

async function loadAccountInfo() {
  const detailsContainer = document.getElementById("account-details");
  const quotaContainer = document.getElementById("quota-info");

  try {
    const user = await client.fetchUserInfo();
    const docs = await client.listDocuments();

    detailsContainer.innerHTML = `
      <div class="info-row"><span class="info-label">User ID</span><span class="info-value">${escapeHtml(user.id)}</span></div>
      <div class="info-row"><span class="info-label">Email</span><span class="info-value">${escapeHtml(user.email || "N/A")}</span></div>
      <div class="info-row"><span class="info-label">Name</span><span class="info-value">${escapeHtml(user.name || "N/A")}</span></div>
    `;

    const docCount = docs.owned.length;
    const totalSize = docs.owned.reduce((sum, d) => sum + d.size, 0);
    const docPercent = Math.min(
      100,
      (docCount / user.quotas.maxDocuments) * 100,
    );
    const storagePercent = Math.min(
      100,
      (totalSize / user.quotas.maxTotalStorage) * 100,
    );

    quotaContainer.innerHTML = `
      <div class="info-row"><span class="info-label">Documents</span><span class="info-value">${docCount} / ${user.quotas.maxDocuments}</span></div>
      <div class="quota-bar"><div class="quota-bar-track"><div class="quota-bar-fill" style="width: ${docPercent}%"></div></div></div>
      <div class="info-row" style="margin-top: 1rem;"><span class="info-label">Storage</span><span class="info-value">${formatBytes(totalSize)} / ${formatBytes(user.quotas.maxTotalStorage)}</span></div>
      <div class="quota-bar"><div class="quota-bar-track"><div class="quota-bar-fill" style="width: ${storagePercent}%"></div></div></div>
    `;
  } catch (_err) {
    detailsContainer.innerHTML =
      '<div class="empty-state-small">Failed to load</div>';
    quotaContainer.innerHTML = "";
  }
}

async function loadTokens() {
  const container = document.getElementById("tokens-list");

  try {
    const tokens = await client.listApiTokens();

    if (tokens.length === 0) {
      container.innerHTML =
        '<div class="empty-state-small">No API tokens</div>';
      return;
    }

    container.innerHTML = tokens
      .map(
        (token) => `
        <div class="token-card">
          <div class="token-card-header">
            <span class="token-name">${escapeHtml(token.name)}</span>
            <button class="btn btn-danger btn-small delete-token-btn" data-id="${token.id}">Delete</button>
          </div>
          <div class="token-meta">
            <span>Created: ${formatDate(token.createdAt)}</span>
            <span>Last used: ${formatDate(token.lastUsedAt)}</span>
          </div>
          <div class="token-scopes">${token.scopes.map((s) => `<span class="scope-badge">${s}</span>`).join("")}</div>
        </div>
      `,
      )
      .join("");

    container.querySelectorAll(".delete-token-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await client.deleteApiToken(btn.dataset.id);
          showToast("Token deleted", "success");
          loadTokens();
        } catch (err) {
          showToast(err.message, "error");
        }
      });
    });
  } catch (_err) {
    container.innerHTML =
      '<div class="empty-state-small">Failed to load tokens</div>';
  }
}

async function createToken(e) {
  e.preventDefault();

  const name = document.getElementById("token-name").value.trim();
  const scopes = Array.from(
    document.querySelectorAll('input[name="scope"]:checked'),
  ).map((cb) => cb.value);

  if (scopes.length === 0) {
    showToast("Select at least one permission", "error");
    return;
  }

  try {
    const data = await client.createApiToken(name, scopes);
    closeModal("create-token-modal");
    document.getElementById("new-token-value").textContent = data.token;
    openModal("token-created-modal");
    loadTokens();
    document.getElementById("create-token-form").reset();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ============ Confirm Dialog ============

function showConfirm(title, message, callback) {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-message").textContent = message;
  pendingConfirmCallback = callback;
  openModal("confirm-modal");
}

// ============ Event Listeners ============

document.addEventListener("DOMContentLoaded", async () => {
  // Show loading while initializing
  showLoading();

  const initialized = await initializeClient();
  if (!initialized) {
    document.getElementById("login-btn").disabled = true;
    document.getElementById("login-btn").textContent = "Connection Failed";
    showLogin();
    return;
  }

  // Auth
  document.getElementById("login-btn").addEventListener("click", handleLogin);
  document.getElementById("logout-btn").addEventListener("click", handleLogout);

  // New document
  document
    .getElementById("new-doc-btn")
    .addEventListener("click", () => openModal("new-doc-modal"));
  document
    .getElementById("welcome-new-doc-btn")
    .addEventListener("click", () => openModal("new-doc-modal"));
  document.getElementById("new-doc-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = document.getElementById("new-doc-title").value.trim();
    createDocument(title);
    closeModal("new-doc-modal");
    document.getElementById("new-doc-form").reset();
  });

  // Refresh
  document
    .getElementById("refresh-docs-btn")
    .addEventListener("click", renderDocumentList);

  // Editor
  editor.addEventListener("input", handleEditorInput);
  document
    .getElementById("doc-title-input")
    .addEventListener("change", handleTitleChange);
  document.getElementById("back-btn").addEventListener("click", closeDocument);

  // Share
  document
    .getElementById("share-btn")
    .addEventListener("click", openShareModal);
  document
    .getElementById("share-add-btn")
    .addEventListener("click", addShareEntry);
  document
    .getElementById("public-read-toggle")
    .addEventListener("change", handlePublicToggle);
  document
    .getElementById("share-save-btn")
    .addEventListener("click", saveShareSettings);

  // Delete document
  document.getElementById("delete-doc-btn").addEventListener("click", () => {
    if (!currentDocUrl) return;
    showConfirm(
      "Delete Document",
      "Are you sure you want to delete this document? This cannot be undone.",
      () => deleteDocument(currentDocUrl),
    );
  });

  // Settings
  document
    .getElementById("settings-btn")
    .addEventListener("click", openSettings);
  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".settings-tab").forEach((t) => {
        t.classList.remove("active");
      });
      tab.classList.add("active");
      const tabName = tab.dataset.tab;
      document
        .getElementById("account-settings")
        .classList.toggle("hidden", tabName !== "account");
      document
        .getElementById("tokens-settings")
        .classList.toggle("hidden", tabName !== "tokens");
    });
  });

  // Tokens
  document
    .getElementById("create-token-btn")
    .addEventListener("click", () => openModal("create-token-modal"));
  document
    .getElementById("create-token-form")
    .addEventListener("submit", createToken);
  document.getElementById("copy-token-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(
      document.getElementById("new-token-value").textContent,
    );
    showToast("Copied to clipboard", "success");
  });

  // Confirm
  document.getElementById("confirm-btn").addEventListener("click", () => {
    if (pendingConfirmCallback) {
      pendingConfirmCallback();
      pendingConfirmCallback = null;
    }
    closeModal("confirm-modal");
  });

  // Modal close buttons
  document.querySelectorAll(".modal-close, .modal-cancel").forEach((btn) => {
    btn.addEventListener("click", closeAllModals);
  });

  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeAllModals();
    });
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllModals();

    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      showToast("Document auto-saved", "info");
    }

    if (
      (e.ctrlKey || e.metaKey) &&
      e.key === "n" &&
      !e.target.matches("input, textarea")
    ) {
      e.preventDefault();
      openModal("new-doc-modal");
    }
  });

  // Sync events
  client.onSyncEvent((event) => {
    switch (event.type) {
      case "connectivity:changed":
        if (event.state === "offline") setSyncStatus("offline");
        break;
      case "auth:required":
        showToast("Session expired, please log in again", "warning");
        handleLogout();
        break;
    }
  });

  // Hash change listener
  window.addEventListener("hashchange", async () => {
    const hashDoc = getDocFromHash();
    if (hashDoc && client.isAuthenticated()) {
      await openDocumentByUrl(hashDoc.url);
    } else if (!hashDoc && currentDocUrl) {
      closeDocument();
    }
  });

  // Copy link button
  document.getElementById("copy-link-btn")?.addEventListener("click", () => {
    const link = getShareableLink();
    if (link) {
      navigator.clipboard.writeText(link);
      showToast("Link copied to clipboard", "success");
    }
  });

  // Initialize
  checkAuth();
});
