// Ratatoskr UI Application
(() => {
  // State
  let authToken = null;
  let currentUser = null;
  let currentTokens = [];
  let currentAclDocId = null;
  let currentAclEntries = [];
  let pendingConfirmCallback = null;
  let currentEditingDocId = null;

  // DOM Elements
  const loginScreen = document.getElementById("login-screen");
  const dashboard = document.getElementById("dashboard");
  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");
  const userInfo = document.getElementById("user-info");
  const navBtns = document.querySelectorAll(".nav-btn");
  const tabContents = document.querySelectorAll(".tab-content");
  const toastContainer = document.getElementById("toast-container");

  // API Helper
  async function api(method, path, body = null) {
    const headers = {};

    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }

    const options = { method, headers };
    if (body) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`/api/v1${path}`, options);

    if (response.status === 204) {
      return null;
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || data.error || "Request failed");
    }

    return data;
  }

  // Toast Notifications
  function showToast(message, type = "info") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 4000);
  }

  // Modal Helpers
  function openModal(modalId) {
    document.getElementById(modalId).classList.remove("hidden");
  }

  function closeModal(modalId) {
    document.getElementById(modalId).classList.add("hidden");
  }

  function closeAllModals() {
    document.querySelectorAll(".modal").forEach((m) => {
      m.classList.add("hidden");
    });
  }

  // Format bytes
  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
  }

  // Format date
  function formatDate(isoString) {
    if (!isoString) return "Never";
    return new Date(isoString).toLocaleString();
  }

  // Auth Functions
  function checkAuth() {
    const stored = sessionStorage.getItem("ratatoskr_token");
    const storedUser = sessionStorage.getItem("ratatoskr_user");

    if (stored && storedUser) {
      authToken = stored;
      currentUser = JSON.parse(storedUser);
      showDashboard();
      loadAllData();
    } else {
      showLogin();
    }
  }

  function showLogin() {
    loginScreen.classList.remove("hidden");
    dashboard.classList.add("hidden");
  }

  function showDashboard() {
    loginScreen.classList.add("hidden");
    dashboard.classList.remove("hidden");
    userInfo.textContent = currentUser?.email || currentUser?.name || "User";
  }

  function handleLogin() {
    // Open popup for OIDC login
    const width = 500;
    const height = 600;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    window.open(
      "/api/v1/auth/login",
      "ratatoskr_auth",
      `width=${width},height=${height},left=${left},top=${top}`,
    );

    // Listen for auth message
    const messageHandler = (event) => {
      if (event.data?.type === "ratatoskr:auth") {
        window.removeEventListener("message", messageHandler);

        authToken = event.data.token;
        currentUser = event.data.user;

        sessionStorage.setItem("ratatoskr_token", authToken);
        sessionStorage.setItem("ratatoskr_user", JSON.stringify(currentUser));

        showDashboard();
        loadAllData();
        showToast("Successfully logged in", "success");
      }
    };

    window.addEventListener("message", messageHandler);
  }

  function handleLogout() {
    authToken = null;
    currentUser = null;
    sessionStorage.removeItem("ratatoskr_token");
    sessionStorage.removeItem("ratatoskr_user");
    showLogin();
    showToast("Logged out", "info");
  }

  // Tab Navigation
  function switchTab(tabName) {
    navBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tabName);
    });

    tabContents.forEach((content) => {
      content.classList.toggle("hidden", content.id !== `${tabName}-tab`);
    });
  }

  // Load Data
  async function loadAllData() {
    await Promise.all([loadDocuments(), loadTokens(), loadAccountInfo()]);
  }

  // Documents
  async function loadDocuments() {
    const ownedContainer = document.getElementById("owned-documents");
    const accessibleContainer = document.getElementById("accessible-documents");

    try {
      const data = await api("GET", "/documents");

      renderDocuments(ownedContainer, data.owned, true);
      renderDocuments(accessibleContainer, data.accessible, false);
    } catch (err) {
      ownedContainer.innerHTML = `<div class="empty-state">Failed to load documents: ${err.message}</div>`;
      accessibleContainer.innerHTML = "";
    }
  }

  function renderDocuments(container, documents, isOwner) {
    if (documents.length === 0) {
      container.innerHTML = '<div class="empty-state">No documents</div>';
      return;
    }

    container.innerHTML = documents
      .map(
        (doc) => `
      <div class="document-card" data-id="${doc.id}">
        <div class="document-card-header">
          <span class="document-id">${escapeHtml(doc.id)}</span>
          ${doc.type ? `<span class="document-type">${escapeHtml(doc.type)}</span>` : ""}
        </div>
        <div class="document-meta">
          <span>Size: ${formatBytes(doc.size)}</span>
          <span>Created: ${formatDate(doc.createdAt)}</span>
          ${doc.expiresAt ? `<span>Expires: ${formatDate(doc.expiresAt)}</span>` : ""}
        </div>
        <div class="document-actions">
          <button class="btn btn-secondary btn-small" onclick="viewDocument('${doc.id}')">Edit</button>
          <button class="btn btn-secondary btn-small" onclick="exportDocument('${doc.id}', 'json')">JSON</button>
          <button class="btn btn-secondary btn-small" onclick="exportDocument('${doc.id}', 'binary')">Bin</button>
          ${
            isOwner
              ? `
            <button class="btn btn-secondary btn-small" onclick="editAcl('${doc.id}')">ACL</button>
            <button class="btn btn-danger btn-small" onclick="deleteDocument('${doc.id}')">Delete</button>
          `
              : ""
          }
        </div>
      </div>
    `,
      )
      .join("");
  }

  async function createDocument(e) {
    e.preventDefault();

    const prefix = document.getElementById("doc-prefix").value;
    const id = prefix + document.getElementById("doc-id").value.trim();
    const type = document.getElementById("doc-type").value.trim() || undefined;
    const expiresAt = document.getElementById("doc-expires").value || undefined;

    try {
      await api("POST", "/documents", { id, type, expiresAt });
      closeModal("create-doc-modal");
      showToast("Document created", "success");
      loadDocuments();

      // Reset form
      document.getElementById("create-doc-form").reset();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  window.deleteDocument = async (docId) => {
    showConfirm(
      "Delete Document",
      `Are you sure you want to delete "${docId}"? This action cannot be undone.`,
      async () => {
        try {
          await api("DELETE", `/documents/${encodeURIComponent(docId)}`);
          showToast("Document deleted", "success");
          loadDocuments();
        } catch (err) {
          showToast(err.message, "error");
        }
      },
    );
  };

  // ACL Management
  window.editAcl = async (docId) => {
    currentAclDocId = docId;
    document.getElementById("acl-doc-info").textContent = docId;
    openModal("edit-acl-modal");

    const entriesContainer = document.getElementById("acl-entries");
    entriesContainer.innerHTML = '<div class="loading">Loading...</div>';

    try {
      const data = await api(
        "GET",
        `/documents/${encodeURIComponent(docId)}/acl`,
      );
      currentAclEntries = data.acl || [];
      renderAclEntries();
    } catch (err) {
      entriesContainer.innerHTML = `<div class="empty-state">Failed to load ACL: ${err.message}</div>`;
    }
  };

  function renderAclEntries() {
    const container = document.getElementById("acl-entries");

    if (currentAclEntries.length === 0) {
      container.innerHTML =
        '<div class="empty-state">No ACL entries. Document is private.</div>';
      return;
    }

    container.innerHTML = currentAclEntries
      .map(
        (entry, idx) => `
      <div class="acl-entry">
        <div class="acl-entry-info">
          <span class="acl-principal">${escapeHtml(entry.principal)}</span>
          <span class="acl-permission ${entry.permission}">${entry.permission}</span>
        </div>
        <button class="btn btn-danger btn-small" onclick="removeAclEntry(${idx})">Remove</button>
      </div>
    `,
      )
      .join("");
  }

  window.removeAclEntry = (index) => {
    currentAclEntries.splice(index, 1);
    renderAclEntries();
  };

  function addAclEntry() {
    const principal = document.getElementById("acl-principal").value.trim();
    const permission = document.getElementById("acl-permission").value;

    if (!principal) {
      showToast("Please enter a principal", "error");
      return;
    }

    // Check for duplicates
    if (currentAclEntries.some((e) => e.principal === principal)) {
      showToast("Principal already exists", "error");
      return;
    }

    currentAclEntries.push({ principal, permission });
    renderAclEntries();
    document.getElementById("acl-principal").value = "";
  }

  async function saveAcl() {
    try {
      await api(
        "PUT",
        `/documents/${encodeURIComponent(currentAclDocId)}/acl`,
        {
          acl: currentAclEntries,
        },
      );
      closeModal("edit-acl-modal");
      showToast("ACL saved", "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  // API Tokens
  async function loadTokens() {
    const container = document.getElementById("tokens-list");

    try {
      const tokens = await api("GET", "/auth/api-tokens");
      currentTokens = tokens;
      renderTokens();
    } catch (err) {
      container.innerHTML = `<div class="empty-state">Failed to load tokens: ${err.message}</div>`;
    }
  }

  function renderTokens() {
    const container = document.getElementById("tokens-list");

    if (currentTokens.length === 0) {
      container.innerHTML =
        '<div class="empty-state">No API tokens. Create one to use with CLI tools or scripts.</div>';
      return;
    }

    container.innerHTML = currentTokens
      .map(
        (token) => `
      <div class="token-card">
        <div class="token-card-header">
          <span class="token-name">${escapeHtml(token.name)}</span>
          <button class="btn btn-danger btn-small" onclick="deleteToken('${token.id}')">Delete</button>
        </div>
        <div class="token-meta">
          <span>Created: ${formatDate(token.createdAt)}</span>
          <span>Last used: ${formatDate(token.lastUsedAt)}</span>
          ${token.expiresAt ? `<span>Expires: ${formatDate(token.expiresAt)}</span>` : ""}
        </div>
        <div class="token-scopes">
          ${token.scopes.map((s) => `<span class="scope-badge">${escapeHtml(s)}</span>`).join("")}
        </div>
      </div>
    `,
      )
      .join("");
  }

  async function createToken(e) {
    e.preventDefault();

    const name = document.getElementById("token-name").value.trim();
    const scopes = Array.from(
      document.querySelectorAll('input[name="scope"]:checked'),
    ).map((cb) => cb.value);
    const expiresAt =
      document.getElementById("token-expires").value || undefined;

    if (scopes.length === 0) {
      showToast("Please select at least one scope", "error");
      return;
    }

    try {
      const data = await api("POST", "/auth/api-tokens", {
        name,
        scopes,
        expiresAt,
      });
      closeModal("create-token-modal");

      // Show the token
      document.getElementById("new-token-value").textContent = data.token;
      openModal("token-created-modal");

      loadTokens();

      // Reset form
      document.getElementById("create-token-form").reset();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  window.deleteToken = async (tokenId) => {
    showConfirm(
      "Delete Token",
      "Are you sure you want to delete this API token? Any applications using it will stop working.",
      async () => {
        try {
          await api("DELETE", `/auth/api-tokens/${tokenId}`);
          showToast("Token deleted", "success");
          loadTokens();
        } catch (err) {
          showToast(err.message, "error");
        }
      },
    );
  };

  function copyToken() {
    const tokenValue = document.getElementById("new-token-value").textContent;
    navigator.clipboard
      .writeText(tokenValue)
      .then(() => {
        showToast("Token copied to clipboard", "success");
      })
      .catch(() => {
        showToast("Failed to copy token", "error");
      });
  }

  // Account Info
  async function loadAccountInfo() {
    const detailsContainer = document.getElementById("account-details");
    const quotaContainer = document.getElementById("quota-info");

    try {
      const user = await api("GET", "/auth/userinfo");
      const docs = await api("GET", "/documents");

      detailsContainer.innerHTML = `
        <div class="info-row">
          <span class="info-label">User ID</span>
          <span class="info-value">${escapeHtml(user.id)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Email</span>
          <span class="info-value">${escapeHtml(user.email || "N/A")}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Name</span>
          <span class="info-value">${escapeHtml(user.name || "N/A")}</span>
        </div>
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
        <div class="info-row">
          <span class="info-label">Documents</span>
          <span class="info-value">${docCount} / ${user.quotas.maxDocuments}</span>
        </div>
        <div class="quota-bar">
          <div class="quota-bar-track">
            <div class="quota-bar-fill ${docPercent > 80 ? (docPercent > 95 ? "danger" : "warning") : ""}" style="width: ${docPercent}%"></div>
          </div>
        </div>
        <div class="info-row" style="margin-top: 1rem;">
          <span class="info-label">Storage Used</span>
          <span class="info-value">${formatBytes(totalSize)} / ${formatBytes(user.quotas.maxTotalStorage)}</span>
        </div>
        <div class="quota-bar">
          <div class="quota-bar-track">
            <div class="quota-bar-fill ${storagePercent > 80 ? (storagePercent > 95 ? "danger" : "warning") : ""}" style="width: ${storagePercent}%"></div>
          </div>
        </div>
        <div class="info-row" style="margin-top: 1rem;">
          <span class="info-label">Max Document Size</span>
          <span class="info-value">${formatBytes(user.quotas.maxDocumentSize)}</span>
        </div>
      `;
    } catch (err) {
      detailsContainer.innerHTML = `<div class="empty-state">Failed to load: ${err.message}</div>`;
      quotaContainer.innerHTML = "";
    }
  }

  // Document Content & Export
  window.viewDocument = async (docId) => {
    currentEditingDocId = docId;
    document.getElementById("edit-doc-id").textContent = docId;
    const textArea = document.getElementById("doc-content-json");
    textArea.value = "Loading...";
    openModal("edit-doc-modal");

    try {
      const content = await api(
        "GET",
        `/documents/${encodeURIComponent(docId)}/export?format=json`,
      );
      textArea.value = JSON.stringify(content, null, 2);
    } catch (err) {
      textArea.value = `Error loading content: ${err.message}`;
    }
  };

  async function saveDocumentContent() {
    const textArea = document.getElementById("doc-content-json");
    let content;

    try {
      content = JSON.parse(textArea.value);
    } catch (err) {
      showToast(`Invalid JSON: ${err.message}`, "error");
      return;
    }

    try {
      await api(
        "PUT",
        `/documents/${encodeURIComponent(currentEditingDocId)}/content`,
        content,
      );
      closeModal("edit-doc-modal");
      showToast("Document updated", "success");
      loadDocuments();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  window.exportDocument = (docId, format) => {
    if (!authToken) {
      showToast("Not authenticated", "error");
      return;
    }

    // Direct window.open doesn't allow setting headers easily for Bearer token.
    // However, if we use a cookie-based auth or query param token, it works.
    // Since this is a simple UI, we'll try to use the fetch to get a blob and download it.
    
    // For simplicity in this demo, we can just use the API if it supports cookie auth or similar.
    // The server has cookie support (@fastify/cookie registered), but we use Bearer in `api()` helper.
    // To support download with Bearer token, we need to fetch -> blob -> objectURL -> click.

    const url = `/api/v1/documents/${encodeURIComponent(docId)}/export?format=${format}`;
    
    fetch(url, {
      headers: {
        Authorization: `Bearer ${authToken}`
      }
    })
    .then(response => {
      if (!response.ok) throw new Error("Download failed");
      return response.blob();
    })
    .then(blob => {
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `${docId.split(':').pop()}.${format === 'json' ? 'json' : 'amrg'}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(downloadUrl);
      a.remove();
    })
    .catch(err => {
      showToast(err.message, "error");
    });
  };

  // Confirm Dialog
  function showConfirm(title, message, callback) {
    document.getElementById("confirm-title").textContent = title;
    document.getElementById("confirm-message").textContent = message;
    pendingConfirmCallback = callback;
    openModal("confirm-modal");
  }

  function handleConfirm() {
    if (pendingConfirmCallback) {
      pendingConfirmCallback();
      pendingConfirmCallback = null;
    }
    closeModal("confirm-modal");
  }

  // Escape HTML
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Event Listeners
  loginBtn.addEventListener("click", handleLogin);
  logoutBtn.addEventListener("click", handleLogout);

  navBtns.forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  // Modal buttons
  document
    .getElementById("create-doc-btn")
    .addEventListener("click", () => openModal("create-doc-modal"));
  document
    .getElementById("create-token-btn")
    .addEventListener("click", () => openModal("create-token-modal"));
  document
    .getElementById("create-doc-form")
    .addEventListener("submit", createDocument);
  document
    .getElementById("create-token-form")
    .addEventListener("submit", createToken);
  document.getElementById("acl-add-btn").addEventListener("click", addAclEntry);
  document.getElementById("acl-save-btn").addEventListener("click", saveAcl);
  document
    .getElementById("save-content-btn")
    .addEventListener("click", saveDocumentContent);
  document
    .getElementById("copy-token-btn")
    .addEventListener("click", copyToken);
  document
    .getElementById("confirm-btn")
    .addEventListener("click", handleConfirm);

  // Close modals
  document.querySelectorAll(".modal-close, .modal-cancel").forEach((btn) => {
    btn.addEventListener("click", closeAllModals);
  });

  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeAllModals();
    });
  });

  // Initialize
  checkAuth();
})();
