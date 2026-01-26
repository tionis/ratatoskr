// Ratatoskr Notes - Collaborative Document Editor Example
//
// Document namespace: dev.tionis.notes
// - app:dev.tionis.notes - Index document tracking all notes
// - doc:dev.tionis.notes-{id} - Individual note documents

const SERVER_URL = window.location.origin;
const APP_NAMESPACE = "dev.tionis.notes";
const APP_DOC_ID = `app:${APP_NAMESPACE}`;

// Client and repo
let RatatoskrClient;
let client;
let repo;

// App state
let appDocHandle = null;
let currentUser = null;
let currentDocId = null;
let currentDocHandle = null;
let currentAcl = [];
let isOwner = false;
let pendingConfirmCallback = null;

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
  // Get or create the app index document
  try {
    // Try to find existing app document
    appDocHandle = repo.find(APP_DOC_ID);
    await appDocHandle.whenReady();

    const doc = appDocHandle.docSync();
    if (!doc || Object.keys(doc).length === 0) {
      // Initialize the app document structure
      appDocHandle.change((d) => {
        d.notes = []; // Array of { id, title, createdAt, updatedAt }
        d.settings = {};
        d.version = 1;
      });
    }
  } catch (_err) {
    // Create the app document on the server first
    try {
      await client.createDocument({ id: APP_DOC_ID, type: "app-index" });
    } catch (createErr) {
      // May already exist, that's fine
      if (!createErr.message?.includes("already exists")) {
        console.warn("Could not create app document:", createErr);
      }
    }

    // Now find/create locally
    appDocHandle = repo.find(APP_DOC_ID);
    await appDocHandle.whenReady();

    const doc = appDocHandle.docSync();
    if (!doc || Object.keys(doc).length === 0) {
      appDocHandle.change((d) => {
        d.notes = [];
        d.settings = {};
        d.version = 1;
      });
    }
  }

  // Listen for changes to the app document (e.g., from other devices)
  appDocHandle.on("change", () => {
    renderDocumentList();
  });
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

function makeDocId(noteId) {
  return `doc:${APP_NAMESPACE}-${noteId}`;
}

// ============ Authentication ============

async function checkAuth() {
  if (client.isAuthenticated()) {
    currentUser = client.getUser();
    showMainApp();
    repo = client.getRepo();
    await initializeAppDocument();
    renderDocumentList();
  } else {
    showLogin();
  }
}

function showLogin() {
  loginScreen.classList.remove("hidden");
  mainApp.classList.add("hidden");
}

function showMainApp() {
  loginScreen.classList.add("hidden");
  mainApp.classList.remove("hidden");
  document.getElementById("user-name").textContent =
    currentUser?.name || currentUser?.email || currentUser?.id || "User";
}

async function handleLogin() {
  try {
    currentUser = await client.login();
    showMainApp();
    repo = client.getRepo();
    await initializeAppDocument();
    renderDocumentList();
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
  const doc = appDocHandle.docSync();
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
        const isActive = makeDocId(note.id) === currentDocId;
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
  const docId = makeDocId(noteId);

  try {
    // Create document on server
    await client.createDocument({ id: docId, type: "note" });

    // Create local automerge document
    const handle = repo.find(docId);
    await handle.whenReady();

    // Initialize document content
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
        id: noteId,
        title: title || "Untitled",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    renderDocumentList();
    await openDocument(noteId);
    showToast("Document created", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function openDocument(noteId) {
  const docId = makeDocId(noteId);

  // Close previous document if open
  if (currentDocHandle) {
    currentDocHandle.off("change", handleDocumentChange);
  }

  currentDocId = docId;
  isOwner = true; // For now, assume ownership of our namespaced docs

  // Update UI
  welcomeView.classList.add("hidden");
  editorView.classList.remove("hidden");

  // Update sidebar active state
  document.querySelectorAll(".doc-item").forEach((item) => {
    item.classList.toggle("active", makeDocId(item.dataset.id) === docId);
  });

  // Show owner buttons
  document.getElementById("share-btn").style.display = "";
  document.getElementById("delete-doc-btn").style.display = "";

  setSyncStatus("syncing");

  try {
    // Get document handle
    currentDocHandle = repo.find(docId);
    await currentDocHandle.whenReady();

    // Load content
    const doc = currentDocHandle.docSync();
    if (doc) {
      document.getElementById("doc-title-input").value = doc.title || "";
      editor.value = doc.content || "";
      updateCharCount();
    }

    // Listen for remote changes
    currentDocHandle.on("change", handleDocumentChange);

    setSyncStatus("synced");
  } catch (err) {
    showToast(`Failed to open document: ${err.message}`, "error");
    setSyncStatus("error");
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

  welcomeView.classList.remove("hidden");
  editorView.classList.add("hidden");

  document.querySelectorAll(".doc-item").forEach((item) => {
    item.classList.remove("active");
  });
}

async function deleteDocument(noteId) {
  const docId = makeDocId(noteId);

  try {
    await client.deleteDocument(docId);

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

    if (currentDocId === docId) {
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
  if (!currentDocHandle) return;

  setSyncStatus("syncing");

  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
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
  if (!currentDocHandle) return;

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

  const noteId = currentDocId.replace(`doc:${APP_NAMESPACE}-`, "");

  appDocHandle.change((appDoc) => {
    if (!appDoc.notes) return;
    const note = appDoc.notes.find((n) => n.id === noteId);
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
  if (!currentDocId || !isOwner) return;

  document.getElementById("share-doc-title").textContent =
    document.getElementById("doc-title-input").value || currentDocId;

  openModal("share-modal");

  const shareList = document.getElementById("share-list");
  shareList.innerHTML = '<div class="loading-small">Loading...</div>';

  try {
    const acl = await client.getDocumentACL(currentDocId);
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
    await client.setDocumentACL(currentDocId, currentAcl);
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
    const noteId = currentDocId.replace(`doc:${APP_NAMESPACE}-`, "");
    showConfirm(
      "Delete Document",
      "Are you sure you want to delete this document? This cannot be undone.",
      () => deleteDocument(noteId),
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

  // Initialize
  checkAuth();
});
