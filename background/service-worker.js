/**
 * service-worker.js — Background service worker for MD Review Extension.
 *
 * Proxies authenticated GitHub API requests from content scripts
 * to avoid CORS restrictions. Reads the PAT from chrome.storage.sync.
 */

(() => {
  "use strict";

  const API_BASE = "https://api.github.com";
  const API_VERSION = "2022-11-28";

  async function getToken(overrideToken) {
    if (overrideToken) return overrideToken;
    const result = await chrome.storage.sync.get("github_pat");
    return result.github_pat || "";
  }

  async function apiRequest(method, url, body, token) {
    const pat = await getToken(token);

    const headers = {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    };
    if (pat) {
      headers["Authorization"] = `Bearer ${pat}`;
    }

    const opts = { method, headers };
    if (body && (method === "POST" || method === "PATCH" || method === "PUT")) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }

    const fullUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
    const resp = await fetch(fullUrl, opts);

    let responseBody = null;
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      responseBody = await resp.json();
    } else {
      responseBody = await resp.text();
    }

    return {
      ok: resp.ok,
      status: resp.status,
      body: responseBody,
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "api") return false;

    const { method, url, body, token } = message;

    apiRequest(method || "GET", url, body, token)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, status: 0, body: { message: err.message } });
      });

    return true;
  });
})();
