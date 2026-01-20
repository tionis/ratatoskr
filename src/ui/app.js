// Ratatoskr Notes - Collaborative Document Editor
import { RatatoskrClient } from "/ui/lib/ratatoskr-client.js";

// Initialize client
const client = new RatatoskrClient({
  serverUrl: window.location.origin,
  autoReconnect: true,
});

// App State
let currentUser = null;
let currentDocId = null;
let currentDocHandle = null;
let currentAcl = [];
let isOwner = false;
let documents = { owned: [], accessible: [] };
let pendingConfirmCallback = null;

// DOM Elements
const loginScreen = document.getElementById("login-screen");
const mainApp = document.getElementById("main-app");
const welcomeView = document.getElementById("welcome-view");
const editorView = document.getElementById("editor-view");
const editor = document.getElementById("editor");
const toastContainer = document.getElementById("toast-container");

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

function generateId() {
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ============ API Helper ============

async function api(method, path, body = null) {
  const token = client.getToken();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const options = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`/api/v1${path}`, options);
  if (response.status === 204) return null;

  const data = await response.json();
  if (!response.ok)
    throw new Error(data.message || data.error || "Request failed");
  return data;
}

// ============ Authentication ============

async function checkAuth() {
  if (client.isLoggedIn()) {
    currentUser = client.getUser();
    showMainApp();
    await loadDocuments();
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
    await client.login();
    currentUser = client.getUser();
    showMainApp();
    await loadDocuments();
    showToast("Welcome back!", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

function handleLogout() {
  client.logout();
  currentUser = null;
  closeDocument();
  showLogin();
  showToast("Logged out", "info");
}

// ============ Document List ============

async function loadDocuments() {
  const ownedList = document.getElementById("owned-docs-list");
  const sharedList = document.getElementById("shared-docs-list");

  ownedList.innerHTML = '<div class="loading-small">Loading...</div>';
  sharedList.innerHTML = '<div class="loading-small">Loading...</div>';

  try {
    const data = await api("GET", "/documents");
    documents = data;
    renderDocumentList(ownedList, data.owned, true);
    renderDocumentList(sharedList, data.accessible, false);
  } catch (_err) {
    ownedList.innerHTML = `<div class="empty-state-small">Failed to load</div>`;
    sharedList.innerHTML = "";
    showToast("Failed to load documents", "error");
  }
}

function renderDocumentList(container, docs, owned) {
  if (docs.length === 0) {
    container.innerHTML = `<div class="empty-state-small">${owned ? "No documents yet" : "None shared"}</div>`;
    return;
  }

  container.innerHTML = docs
    .map((doc) => {
      const title = getDocTitle(doc);
      const isActive = doc.id === currentDocId;
      return `
        <div class="doc-item ${isActive ? "active" : ""}" data-id="${escapeHtml(doc.id)}">
          <div class="doc-item-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
              <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
            </svg>
          </div>
          <div class="doc-item-info">
            <span class="doc-item-title">${escapeHtml(title)}</span>
            <span class="doc-item-meta">${formatDate(doc.updatedAt || doc.createdAt)}</span>
          </div>
        </div>
      `;
    })
    .join("");

  // Add click handlers
  container.querySelectorAll(".doc-item").forEach((item) => {
    item.addEventListener("click", () => openDocument(item.dataset.id));
  });
}

function getDocTitle(doc) {
  // Try to get title from document content or fall back to ID
  return (
    doc.title || doc.id.replace(/^doc[:-]/, "").replace(/-/g, " ") || "Untitled"
  );
}

// ============ Document Operations ============

async function createDocument(title, customId) {
  const id = customId || `doc:${generateId()}`;

  try {
    // Create document via API
    await api("POST", "/documents", { id, type: "note" });

    // Initialize with title using automerge
    const handle = await client.getDocument(id);
    handle.change((doc) => {
      doc.title = title || "Untitled";
      doc.content = "";
      doc.createdAt = new Date().toISOString();
      doc.updatedAt = new Date().toISOString();
    });

    await loadDocuments();
    await openDocument(id);
    showToast("Document created", "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function openDocument(docId) {
  // Close previous document if open
  if (currentDocHandle) {
    currentDocHandle.off("change", handleDocumentChange);
  }

  currentDocId = docId;
  isOwner = documents.owned.some((d) => d.id === docId);

  // Update UI
  welcomeView.classList.add("hidden");
  editorView.classList.remove("hidden");

  // Update sidebar active state
  document.querySelectorAll(".doc-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.id === docId);
  });

  // Show/hide owner-only buttons
  document.getElementById("share-btn").style.display = isOwner ? "" : "none";
  document.getElementById("delete-doc-btn").style.display = isOwner
    ? ""
    : "none";

  // Set sync status to loading
  setSyncStatus("syncing");

  try {
    // Get document handle from automerge-repo
    currentDocHandle = await client.getDocument(docId);

    // Load initial content
    const doc = currentDocHandle.docSync();
    if (doc) {
      document.getElementById("doc-title-input").value = doc.title || "";
      editor.value = doc.content || "";
      updateCharCount();
    }

    // Listen for changes (from other collaborators)
    currentDocHandle.on("change", handleDocumentChange);

    setSyncStatus("synced");
  } catch (err) {
    showToast(`Failed to open document: ${err.message}`, "error");
    setSyncStatus("error");
  }
}

function handleDocumentChange({ doc }) {
  // Update editor if content changed from remote
  const currentContent = editor.value;
  const newContent = doc.content || "";

  if (newContent !== currentContent) {
    // Preserve cursor position as best we can
    const selStart = editor.selectionStart;
    const selEnd = editor.selectionEnd;

    editor.value = newContent;

    // Try to restore cursor position
    editor.selectionStart = Math.min(selStart, newContent.length);
    editor.selectionEnd = Math.min(selEnd, newContent.length);
  }

  // Update title if changed
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

async function deleteDocument(docId) {
  try {
    await api("DELETE", `/documents/${encodeURIComponent(docId)}`);
    showToast("Document deleted", "success");

    if (currentDocId === docId) {
      closeDocument();
    }
    await loadDocuments();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ============ Editor ============

let saveTimeout = null;

function handleEditorInput() {
  if (!currentDocHandle) return;

  setSyncStatus("syncing");

  // Debounce saves
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const content = editor.value;
    currentDocHandle.change((doc) => {
      doc.content = content;
      doc.updatedAt = new Date().toISOString();
    });
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

  // Update sidebar
  loadDocuments();
}

function updateCharCount() {
  const count = editor.value.length;
  document.getElementById("char-count").textContent =
    `${count.toLocaleString()} characters`;
}

function setSyncStatus(status) {
  const statusEl = document.getElementById("sync-status");
  const _dotEl = statusEl.querySelector(".sync-dot");
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
    const data = await api(
      "GET",
      `/documents/${encodeURIComponent(currentDocId)}/acl`,
    );
    currentAcl = data.acl || [];
    renderShareList();
  } catch (_err) {
    shareList.innerHTML = '<div class="empty-state-small">Failed to load</div>';
    showToast("Failed to load sharing settings", "error");
  }
}

function renderShareList() {
  const container = document.getElementById("share-list");

  // Check for public access
  const publicEntry = currentAcl.find((e) => e.principal === "public");
  document.getElementById("public-read-toggle").checked = !!publicEntry;

  // Filter out public entry for the list
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

  // Add event listeners
  container.querySelectorAll(".share-entry-permission").forEach((select) => {
    select.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const entry = userEntries[idx];
      const aclIdx = currentAcl.findIndex(
        (e) => e.principal === entry.principal,
      );
      if (aclIdx >= 0) {
        currentAcl[aclIdx].permission = e.target.value;
      }
    });
  });

  container.querySelectorAll(".share-remove-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const principal = e.target.dataset.principal;
      currentAcl = currentAcl.filter((e) => e.principal !== principal);
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
    await api("PUT", `/documents/${encodeURIComponent(currentDocId)}/acl`, {
      acl: currentAcl,
    });
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
    const user = await api("GET", "/auth/userinfo");
    const docs = await api("GET", "/documents");

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
    const tokens = await api("GET", "/auth/api-tokens");

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
          await api("DELETE", `/auth/api-tokens/${id}`);
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
    const data = await api("POST", "/auth/api-tokens", { name, scopes });
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

document.addEventListener("DOMContentLoaded", () => {
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
    const customId = document.getElementById("new-doc-id").value.trim();
    createDocument(title, customId ? `doc:${customId}` : null);
    closeModal("new-doc-modal");
    document.getElementById("new-doc-form").reset();
  });

  // Refresh
  document
    .getElementById("refresh-docs-btn")
    .addEventListener("click", loadDocuments);

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
    showConfirm(
      "Delete Document",
      "Are you sure you want to delete this document? This cannot be undone.",
      () => {
        deleteDocument(currentDocId);
      },
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
    // Escape to close modals
    if (e.key === "Escape") {
      closeAllModals();
    }

    // Ctrl/Cmd + S to save (prevent default, auto-saved)
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      showToast("Document auto-saved", "info");
    }

    // Ctrl/Cmd + N for new document
    if (
      (e.ctrlKey || e.metaKey) &&
      e.key === "n" &&
      !e.target.matches("input, textarea")
    ) {
      e.preventDefault();
      openModal("new-doc-modal");
    }
  });

  // Initialize
  checkAuth();
});
