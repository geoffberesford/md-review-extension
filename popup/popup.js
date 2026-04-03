(() => {
  "use strict";

  const patInput = document.getElementById("pat-input");
  const toggleBtn = document.getElementById("toggle-visibility");
  const saveBtn = document.getElementById("save-btn");
  const testBtn = document.getElementById("test-btn");
  const statusEl = document.getElementById("status");

  function showStatus(message, type) {
    statusEl.textContent = message;
    statusEl.className = `status ${type}`;
    statusEl.hidden = false;
  }

  function hideStatus() {
    statusEl.hidden = true;
  }

  const clickToCommentCheckbox = document.getElementById("click-to-comment");

  chrome.storage.sync.get(["github_pat", "click_to_comment"], (result) => {
    if (result.github_pat) {
      patInput.value = result.github_pat;
    }
    clickToCommentCheckbox.checked = result.click_to_comment === true;
  });

  clickToCommentCheckbox.addEventListener("change", () => {
    chrome.storage.sync.set({ click_to_comment: clickToCommentCheckbox.checked });
  });

  toggleBtn.addEventListener("click", () => {
    const isPassword = patInput.type === "password";
    patInput.type = isPassword ? "text" : "password";
    toggleBtn.textContent = isPassword ? "\u2715" : "\ud83d\udc41";
  });

  saveBtn.addEventListener("click", () => {
    const token = patInput.value.trim();
    if (!token) {
      chrome.storage.sync.remove("github_pat", () => {
        showStatus("Token cleared.", "success");
      });
      return;
    }

    chrome.storage.sync.set({ github_pat: token }, () => {
      showStatus("Token saved.", "success");
    });
  });

  testBtn.addEventListener("click", async () => {
    const token = patInput.value.trim();
    if (!token) {
      showStatus("Enter a token first.", "error");
      return;
    }

    hideStatus();
    testBtn.disabled = true;
    testBtn.textContent = "Testing\u2026";

    try {
      const response = await chrome.runtime.sendMessage({
        type: "api",
        method: "GET",
        url: "https://api.github.com/user",
        token,
      });

      if (response.ok) {
        const data = response.body;
        showStatus(`Connected as ${data.login}`, "success");
      } else {
        showStatus(`Auth failed (${response.status}). Check your token.`, "error");
      }
    } catch (err) {
      showStatus(`Error: ${err.message}`, "error");
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = "Test Connection";
    }
  });
})();
