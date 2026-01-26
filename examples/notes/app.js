// Ratatoskr Notes - Collaborative Document Editor Example
//
// Document namespace: dev.tionis.notes
// - app:dev.tionis.notes - Index document tracking all notes
// - doc:dev.tionis.notes-{id} - Individual note documents

const SERVER_URL = "http://localhost:4151";
const APP_NAMESPACE = "dev.tionis.notes";
const APP_DOC_URL_KEY = `ratatoskr:${APP_NAMESPACE}:app-url`;

// Client and repo
let RatatoskrClient;
let client;
let repo;

// App state
let appDocHandle = null;
let appDocUrl = null;
let currentUser = null;
let currentDocId = null; // automerge URL
let currentServerId = null; // server document ID for ACL operations
let currentDocHandle = null;
let currentAcl = [];
let isOwner = false;
let pendingConfirmCallback = null;
let isViewerMode = false; // True when viewing without full auth

// DOM Elements
const loginScreen = document.getElementById("login-screen");
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

async function initializeAppDocument() {
  // Check if we have a stored app document URL
  appDocUrl = localStorage.getItem(APP_DOC_URL_KEY);

  if (appDocUrl) {
    // Try to find existing app document
    try {
      // repo.find() returns a Promise in newer automerge-repo versions
      appDocHandle = await repo.find(appDocUrl);
      await waitForHandle(appDocHandle);

      const doc = getDocFromHandle(appDocHandle);
      if (doc && Object.keys(doc).length > 0) {
        // Found existing document
        appDocHandle.on("change", () => renderDocumentList());
        return;
      }
    } catch (err) {
      console.warn("Could not load app document, creating new one:", err);
      // Clear invalid URL from storage
      localStorage.removeItem(APP_DOC_URL_KEY);
    }
  }

  // Create new app document
  appDocHandle = repo.create();
  appDocUrl = appDocHandle.url;

  // Store the URL for later
  localStorage.setItem(APP_DOC_URL_KEY, appDocUrl);

  // Register with server FIRST (before .change() triggers sync)
  const appAutomergeId = appDocUrl.replace("automerge:", "");
  try {
    await client.createDocument({
      id: `app:${APP_NAMESPACE}-${appAutomergeId}`,
      automergeId: appAutomergeId,
      type: "app-index",
    });
  } catch (err) {
    // May fail if offline, that's ok - will sync later
    console.warn("Could not register app document with server:", err);
  }

  // THEN initialize structure (this triggers sync)
  appDocHandle.change((d) => {
    d.notes = []; // Array of { id, title, createdAt, updatedAt }
    d.settings = {};
    d.version = 1;
  });

  // Listen for changes
  appDocHandle.on("change", () => renderDocumentList());
}

// ============ Helper Functions ============

/**
 * Get document from handle, trying different API methods.
 */
function getDocFromHandle(handle) {
  if (typeof handle.doc === "function") {
    return handle.doc();
  }
  if (typeof handle.docSync === "function") {
    return handle.docSync();
  }
  // Maybe it's a property, not a method
  if (handle.doc !== undefined && typeof handle.doc !== "function") {
    return handle.doc;
  }
  return undefined;
}

/**
 * Wait for a document handle to be ready.
 * Works with different automerge-repo versions.
 */
async function waitForHandle(handle, timeoutMs = 5000) {
  if (!handle) {
    throw new Error("Invalid handle: null or undefined");
  }

  // If handle has whenReady method, use it
  if (typeof handle.whenReady === "function") {
    try {
      await handle.whenReady(["ready", "unavailable"]);
      return;
    } catch (err) {
      console.warn("whenReady failed:", err);
    }
  }

  // Fallback: poll until doc returns something or timeout
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        const doc = getDocFromHandle(handle);
        if (doc !== undefined) {
          resolve();
          return;
        }
      } catch (err) {
        console.warn("getDocFromHandle error:", err);
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

/**
 * Get document info from URL hash.
 * Supports formats:
 * - #noteId (short note ID from local index)
 * - #automerge:hash (full automerge URL)
 * - #hash (just the automerge hash)
 */
function getDocFromHash() {
  const hash = window.location.hash.slice(1); // Remove #
  if (!hash) return null;

  // Full automerge URL
  if (hash.startsWith("automerge:")) {
    return { type: "automerge", url: hash };
  }

  // Check if it's a note ID from our index
  const notes = getNotesFromAppDoc();
  const note = notes.find((n) => n.id === hash);
  if (note) {
    return { type: "note", note };
  }

  // Assume it's an automerge hash
  return { type: "automerge", url: `automerge:${hash}` };
}

/**
 * Update URL hash when opening a document.
 * Uses the short note ID if available, otherwise the automerge hash.
 */
function setDocHash(noteInfo, automergeUrl) {
  if (noteInfo?.id) {
    window.location.hash = noteInfo.id;
  } else if (automergeUrl) {
    // Use just the hash part for cleaner URLs
    const hash = automergeUrl.replace("automerge:", "");
    window.location.hash = hash;
  }
}

/**
 * Clear the URL hash.
 */
function clearDocHash() {
  history.pushState(
    null,
    "",
    window.location.pathname + window.location.search,
  );
}

/**
 * Get a shareable link for the current document.
 * Uses the automerge hash for maximum compatibility.
 */
function getShareableLink() {
  if (!currentDocId) return null;
  const hash = currentDocId.replace("automerge:", "");
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

function generateNoteId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ============ Authentication ============

async function checkAuth() {
  const hashDoc = getDocFromHash();

  if (client.isAuthenticated()) {
    currentUser = client.getUser();
    isViewerMode = false;
    showMainApp();
    repo = client.getRepo();
    await initializeAppDocument();
    renderDocumentList();

    // If there's a document in the URL, try to open it
    if (hashDoc) {
      await openDocFromHash(hashDoc);
    }
  } else if (hashDoc) {
    // Not logged in, but there's a document to view
    // Show viewer mode
    isViewerMode = true;
    showViewerMode(hashDoc);
  } else {
    showLogin();
  }
}

/**
 * Handle opening a document from URL hash info.
 */
async function openDocFromHash(hashDoc) {
  if (hashDoc.type === "note" && hashDoc.note) {
    await openDocumentByUrl(hashDoc.note.url, hashDoc.note);
  } else if (hashDoc.type === "automerge" && hashDoc.url) {
    await openDocumentByUrl(hashDoc.url);
  }
}

function showLogin() {
  loginScreen.classList.remove("hidden");
  mainApp.classList.add("hidden");
}

function showMainApp() {
  loginScreen.classList.add("hidden");
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

/**
 * Show the app in viewer mode for unauthenticated users viewing a shared document.
 */
async function showViewerMode(hashDoc) {
  showMainApp();

  // Hide elements that require authentication
  document.getElementById("new-doc-btn").style.display = "none";
  document.getElementById("refresh-docs-btn").style.display = "none";
  document.getElementById("settings-btn").style.display = "none";
  document.getElementById("owned-docs-list").innerHTML =
    '<div class="empty-state-small">Sign in to see your documents</div>';
  document.getElementById("shared-docs-list").innerHTML = "";

  // Show login prompt in sidebar footer
  const footer = document.querySelector(".sidebar-footer .user-menu");
  footer.innerHTML = `
    <button id="viewer-login-btn" class="btn btn-primary btn-small">Sign In</button>
  `;
  document
    .getElementById("viewer-login-btn")
    .addEventListener("click", handleLogin);

  // Try to open the document anonymously
  // This will work for public documents
  try {
    // Get repo - will connect anonymously since no token is set
    repo = client.getRepo();

    if (hashDoc.type === "automerge" && hashDoc.url) {
      await openDocumentByUrl(hashDoc.url, null, { readOnly: true });
    }
  } catch (err) {
    console.error("Failed to open document in viewer mode:", err);
    showViewerLoginPrompt();
  }
}

/**
 * Show login prompt when document requires authentication.
 */
function showViewerLoginPrompt() {
  showToast("Sign in to view this document", "info");

  // Show login prompt in the main area
  welcomeView.classList.remove("hidden");
  editorView.classList.add("hidden");
  document.querySelector(".welcome-content h2").textContent = "Sign in to view";
  document.querySelector(".welcome-content p").textContent =
    "This document may require authentication to view.";
  document.getElementById("welcome-new-doc-btn").textContent = "Sign In";
  document.getElementById("welcome-new-doc-btn").onclick = handleLogin;
}

async function handleLogin() {
  // Remember if we were viewing a document before login
  const wasViewingDoc = isViewerMode && currentDocId;
  const docToReopen = currentDocId;

  try {
    currentUser = await client.login();
    isViewerMode = false;

    // Reset UI elements that were hidden in viewer mode
    document.getElementById("new-doc-btn").style.display = "";
    document.getElementById("refresh-docs-btn").style.display = "";
    document.getElementById("settings-btn").style.display = "";

    // Reset welcome view content
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

    // If we were viewing a document, reopen it with full permissions
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
        const isActive = note.url === currentDocId;
        return `
          <div class="doc-item ${isActive ? "active" : ""}" data-id="${escapeHtml(note.id)}">
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

    // Add click handlers
    ownedList.querySelectorAll(".doc-item").forEach((item) => {
      item.addEventListener("click", () => openDocument(item.dataset.id));
    });
  }

  // For now, shared list shows hint about using ACLs
  sharedList.innerHTML =
    '<div class="empty-state-small">Share documents via ACL settings</div>';
}

// ============ Document Operations ============

async function createDocument(title) {
  const noteId = generateNoteId();

  try {
    // Create local automerge document
    const handle = repo.create();
    const docUrl = handle.url;
    const automergeId = docUrl.replace("automerge:", "");
    const serverId = `doc:${APP_NAMESPACE}-${automergeId}`;

    // Register with server FIRST (before .change() triggers sync)
    try {
      await client.createDocument({
        id: serverId,
        automergeId: automergeId,
        type: "note",
      });
    } catch (err) {
      console.warn("Could not register document with server:", err);
    }

    // THEN initialize document content (this triggers sync)
    handle.change((doc) => {
      doc.title = title || "Untitled";
      doc.content = "";
      doc.createdAt = new Date().toISOString();
      doc.updatedAt = new Date().toISOString();
    });

    // Add to app index (store the automerge URL)
    appDocHandle.change((appDoc) => {
      if (!appDoc.notes) appDoc.notes = [];
      appDoc.notes.unshift({
        id: noteId,
        url: docUrl,
        serverId: serverId,
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

function openDocument(noteId) {
  // Find the note in the app index to get its URL
  const notes = getNotesFromAppDoc();
  const note = notes.find((n) => n.id === noteId);
  if (!note || !note.url) {
    showToast("Document not found", "error");
    return;
  }
  openDocumentByUrl(note.url, note);
}

async function openDocumentByUrl(docUrl, noteInfo = null, options = {}) {
  const { readOnly = false } = options;

  // Close previous document if open
  if (currentDocHandle) {
    currentDocHandle.off("change", handleDocumentChange);
  }

  // Find note info if not provided (only if authenticated)
  if (!noteInfo && !isViewerMode) {
    const notes = getNotesFromAppDoc();
    noteInfo = notes.find((n) => n.url === docUrl);
  }

  currentDocId = docUrl;
  currentServerId = noteInfo?.serverId || null;

  // Determine ownership - only owner if authenticated and it's our doc
  isOwner = !isViewerMode && !readOnly && !!noteInfo;

  // Update URL hash
  setDocHash(noteInfo, docUrl);

  // Update UI
  welcomeView.classList.add("hidden");
  editorView.classList.remove("hidden");

  // Update sidebar active state (only if not in viewer mode)
  if (!isViewerMode) {
    document.querySelectorAll(".doc-item").forEach((item) => {
      const notes = getNotesFromAppDoc();
      const note = notes.find((n) => n.id === item.dataset.id);
      item.classList.toggle("active", note?.url === docUrl);
    });
  }

  // Show/hide owner buttons based on ownership
  document.getElementById("share-btn").style.display = isOwner ? "" : "none";
  document.getElementById("delete-doc-btn").style.display = isOwner
    ? ""
    : "none";

  // Handle read-only mode
  const titleInput = document.getElementById("doc-title-input");
  if (readOnly || isViewerMode) {
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
    // Get document handle (repo.find returns a Promise)
    currentDocHandle = await repo.find(docUrl);

    // Set up a timeout for viewer mode - document may not be accessible
    const loadPromise = waitForHandle(
      currentDocHandle,
      isViewerMode ? 10000 : 5000,
    );

    await loadPromise;

    // Load content
    const doc = getDocFromHandle(currentDocHandle);
    if (!doc) {
      if (isViewerMode) {
        // In viewer mode, show login prompt if document isn't accessible
        showViewerLoginPrompt();
        return;
      }
      showToast("Document unavailable - may need to sync", "error");
      setSyncStatus("error");
      currentDocHandle = null;
      return;
    }

    titleInput.value = doc.title || "";
    editor.value = doc.content || "";
    updateCharCount();

    // Listen for remote changes
    currentDocHandle.on("change", handleDocumentChange);

    setSyncStatus("synced");
  } catch (err) {
    if (isViewerMode) {
      // In viewer mode, show login prompt for any error
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
  currentDocId = null;
  currentServerId = null;

  // Clear URL hash
  clearDocHash();

  welcomeView.classList.remove("hidden");
  editorView.classList.add("hidden");

  // Reset readonly state
  editor.removeAttribute("readonly");
  document.getElementById("doc-title-input").removeAttribute("readonly");
  editor.classList.remove("readonly");
  document.getElementById("doc-title-input").classList.remove("readonly");

  document.querySelectorAll(".doc-item").forEach((item) => {
    item.classList.remove("active");
  });
}

async function deleteDocument(noteId) {
  const notes = getNotesFromAppDoc();
  const note = notes.find((n) => n.id === noteId);

  if (!note) {
    showToast("Document not found", "error");
    return;
  }

  try {
    // Try to delete from server if we have a server ID
    if (note.serverId) {
      try {
        await client.deleteDocument(note.serverId);
      } catch (err) {
        console.warn("Could not delete from server:", err);
      }
    }

    // Remove from app index
    appDocHandle.change((appDoc) => {
      if (appDoc.notes) {
        const idx = appDoc.notes.findIndex((n) => n.id === noteId);
        if (idx >= 0) {
          appDoc.notes.splice(idx, 1);
        }
      }
    });

    showToast("Document deleted", "success");

    if (currentDocId === note.url) {
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

    // Update app index with timestamp
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

  // Update app index
  updateNoteInIndex({ title, updatedAt: new Date().toISOString() });
  renderDocumentList();
}

function updateNoteInIndex(updates) {
  if (!appDocHandle || !currentDocId) return;

  appDocHandle.change((appDoc) => {
    if (!appDoc.notes) return;
    const note = appDoc.notes.find((n) => n.url === currentDocId);
    if (note) {
      Object.assign(note, updates);
    }
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
  if (!currentDocId || !isOwner || !currentServerId) {
    showToast("Cannot share: document not registered with server", "error");
    return;
  }

  document.getElementById("share-doc-title").textContent =
    document.getElementById("doc-title-input").value || "Untitled";

  // Populate shareable link
  const shareLink = getShareableLink();
  document.getElementById("share-link-input").value = shareLink || "";

  openModal("share-modal");

  const shareList = document.getElementById("share-list");
  shareList.innerHTML = '<div class="loading-small">Loading...</div>';

  try {
    const acl = await client.getDocumentACL(currentServerId);
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
      if (aclIdx >= 0) {
        currentAcl[aclIdx].permission = e.target.value;
      }
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
  try {
    await client.setDocumentACL(currentServerId, currentAcl);
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
        const id = btn.dataset.id;
        try {
          await client.deleteApiToken(id);
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
  const initialized = await initializeClient();
  if (!initialized) {
    document.getElementById("login-btn").disabled = true;
    document.getElementById("login-btn").textContent = "Connection Failed";
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
    if (!currentDocId) return;
    // Find the note by URL
    const notes = getNotesFromAppDoc();
    const note = notes.find((n) => n.url === currentDocId);
    if (!note) return;
    showConfirm(
      "Delete Document",
      "Are you sure you want to delete this document? This cannot be undone.",
      () => deleteDocument(note.id),
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
    if (e.key === "Escape") {
      closeAllModals();
    }

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
        if (event.state === "offline") {
          setSyncStatus("offline");
        }
        break;
      case "auth:required":
        showToast("Session expired, please log in again", "warning");
        handleLogout();
        break;
    }
  });

  // Hash change listener for navigation
  window.addEventListener("hashchange", async () => {
    const hashDoc = getDocFromHash();
    if (hashDoc && client.isAuthenticated()) {
      await openDocFromHash(hashDoc);
    } else if (!hashDoc && currentDocId) {
      // Hash was cleared, close document
      closeDocument();
    }
  });

  // Copy link button in share modal
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
