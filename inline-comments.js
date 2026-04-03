/**
 * inline-comments.js — Inline comment threads for the rich diff view.
 *
 * Exposes InlineComments as a global, consumed by content-script.js.
 * Fetches PR review comments via the background service worker,
 * groups them into threads, maps them to DOM elements in the rich diff,
 * and renders inline comment thread UI with reply and create capabilities.
 */

// eslint-disable-next-line no-var
var InlineComments = (() => {
  "use strict";

  const { qs, qsa, createElement, debounce } = DomHelpers;

  const THREAD_CLASS = "mdr-inline-thread";
  const BUBBLE_CLASS = "mdr-add-comment-bubble";
  const FORM_CLASS = "mdr-comment-form";
  const THREAD_COLLAPSED_CLASS = "mdr-inline-thread--collapsed";

  /* ---------------------------------------------------------------- */
  /*  API helpers (message passing to service worker)                   */
  /* ---------------------------------------------------------------- */

  function _apiCall(method, url, body) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "api", method, url, body },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        }
      );
    });
  }

  async function _hasToken() {
    return new Promise((resolve) => {
      chrome.storage.sync.get("github_pat", (result) => {
        resolve(Boolean(result.github_pat));
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /*  URL parsing                                                      */
  /* ---------------------------------------------------------------- */

  function _parsePRUrl() {
    const match = window.location.pathname.match(
      /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/
    );
    if (!match) return null;
    return { owner: match[1], repo: match[2], pullNumber: parseInt(match[3], 10) };
  }

  /* ---------------------------------------------------------------- */
  /*  Fetch and group comments                                         */
  /* ---------------------------------------------------------------- */

  const _commentCache = new Map();
  const CACHE_TTL_MS = 30_000;

  async function fetchPRComments(owner, repo, pullNumber) {
    const cacheKey = `${owner}/${repo}/${pullNumber}`;
    const cached = _commentCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return cached.comments;
    }

    const allComments = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/comments?per_page=${perPage}&page=${page}`;
      const resp = await _apiCall("GET", url);
      if (!resp.ok) {
        console.warn("[MD Review] Failed to fetch comments:", resp.status, resp.body);
        break;
      }

      const batch = resp.body;
      if (!Array.isArray(batch) || batch.length === 0) break;
      allComments.push(...batch);
      if (batch.length < perPage) break;
      page++;
    }

    _commentCache.set(cacheKey, { comments: allComments, ts: Date.now() });
    return allComments;
  }

  function groupCommentsIntoThreads(comments, filePath) {
    const fileComments = comments.filter(
      (c) => c.path === filePath && c.subject_type !== "file"
    );

    const threadsById = new Map();
    const rootComments = [];

    for (const comment of fileComments) {
      if (comment.in_reply_to_id) {
        const parentId = comment.in_reply_to_id;
        if (!threadsById.has(parentId)) {
          threadsById.set(parentId, []);
        }
        threadsById.get(parentId).push(comment);
      } else {
        rootComments.push(comment);
        if (!threadsById.has(comment.id)) {
          threadsById.set(comment.id, []);
        }
      }
    }

    return rootComments.map((root) => ({
      root,
      replies: (threadsById.get(root.id) || []).sort(
        (a, b) => new Date(a.created_at) - new Date(b.created_at)
      ),
      line: root.original_line || root.line,
      side: root.side || "RIGHT",
    }));
  }

  /* ---------------------------------------------------------------- */
  /*  Time formatting                                                  */
  /* ---------------------------------------------------------------- */

  function _relativeTime(dateStr) {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diffMs = now - then;
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return `${diffDay}d ago`;
    return new Date(dateStr).toLocaleDateString();
  }

  /* ---------------------------------------------------------------- */
  /*  Render comment thread                                            */
  /* ---------------------------------------------------------------- */

  function _renderCommentBody(bodyText) {
    const lines = (bodyText || "").split("\n");
    const parts = [];
    let inCode = false;

    for (const line of lines) {
      if (line.startsWith("```")) {
        inCode = !inCode;
        continue;
      }
      if (inCode) {
        parts.push(`<code>${_escapeHtml(line)}</code>`);
      } else {
        parts.push(_escapeHtml(line));
      }
    }

    return parts.join("<br>");
  }

  function _escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function _createSingleCommentEl(comment) {
    const wrapper = createElement("div", { className: "mdr-comment" });

    const header = createElement("div", { className: "mdr-comment__header" });
    const avatar = createElement("img", {
      className: "mdr-comment__avatar",
    });
    avatar.src = comment.user?.avatar_url || "";
    avatar.alt = comment.user?.login || "user";

    const author = createElement("a", {
      className: "mdr-comment__author",
      href: comment.user?.html_url || "#",
    });
    author.target = "_blank";
    author.textContent = comment.user?.login || "unknown";

    const time = createElement("span", {
      className: "mdr-comment__time",
      title: new Date(comment.created_at).toLocaleString(),
      textContent: _relativeTime(comment.created_at),
    });

    header.appendChild(avatar);
    header.appendChild(author);
    header.appendChild(time);

    const body = createElement("div", { className: "mdr-comment__body" });
    body.innerHTML = _renderCommentBody(comment.body);

    wrapper.appendChild(header);
    wrapper.appendChild(body);
    return wrapper;
  }

  function renderThread(thread, prInfo, filePath, commitId, onRefresh) {
    const container = createElement("div", { className: THREAD_CLASS });
    container.setAttribute("data-mdr-thread-id", String(thread.root.id));
    container.setAttribute("data-mdr-line", String(thread.line));

    const toggle = createElement("button", {
      className: "mdr-inline-thread__toggle",
      type: "button",
      title: "Collapse/expand thread",
    });
    const commentCount = 1 + thread.replies.length;
    toggle.innerHTML =
      `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path></svg>` +
      ` <span class="mdr-inline-thread__count">${commentCount}</span>`;

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      container.classList.toggle(THREAD_COLLAPSED_CLASS);
    });
    container.appendChild(toggle);

    const threadBody = createElement("div", { className: "mdr-inline-thread__body" });

    threadBody.appendChild(_createSingleCommentEl(thread.root));
    for (const reply of thread.replies) {
      threadBody.appendChild(_createSingleCommentEl(reply));
    }

    const replyForm = _createReplyForm(prInfo, thread.root.id, threadBody, onRefresh);
    threadBody.appendChild(replyForm);

    container.appendChild(threadBody);
    return container;
  }

  /* ---------------------------------------------------------------- */
  /*  Reply form                                                       */
  /* ---------------------------------------------------------------- */

  function _createReplyForm(prInfo, rootCommentId, threadBody, onRefresh) {
    const form = createElement("div", { className: `${FORM_CLASS} mdr-reply-form` });

    const textarea = createElement("textarea", {
      className: "mdr-comment-form__textarea",
      placeholder: "Reply\u2026",
    });
    textarea.rows = 2;

    const actions = createElement("div", { className: "mdr-comment-form__actions" });

    const cancelBtn = createElement("button", {
      className: "mdr-btn mdr-btn--secondary",
      type: "button",
      textContent: "Cancel",
    });

    const submitBtn = createElement("button", {
      className: "mdr-btn mdr-btn--primary",
      type: "button",
      textContent: "Reply",
    });

    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      textarea.value = "";
      form.classList.remove("mdr-comment-form--active");
    });

    submitBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const body = textarea.value.trim();
      if (!body) return;

      submitBtn.disabled = true;
      submitBtn.textContent = "Posting\u2026";

      try {
        const url = `https://api.github.com/repos/${prInfo.owner}/${prInfo.repo}/pulls/${prInfo.pullNumber}/comments/${rootCommentId}/replies`;
        const resp = await _apiCall("POST", url, { body });

        if (resp.ok) {
          const newComment = resp.body;
          const commentEl = _createSingleCommentEl(newComment);
          threadBody.insertBefore(commentEl, form);
          textarea.value = "";
          form.classList.remove("mdr-comment-form--active");

          const countEl = threadBody.parentElement?.querySelector(".mdr-inline-thread__count");
          if (countEl) {
            const prev = parseInt(countEl.textContent, 10) || 0;
            countEl.textContent = String(prev + 1);
          }

          _invalidateCache(prInfo);
          if (onRefresh) onRefresh();
        } else {
          console.warn("[MD Review] Reply failed:", resp.status, resp.body);
          alert(`Reply failed: ${resp.body?.message || resp.status}`);
        }
      } catch (err) {
        console.error("[MD Review] Reply error:", err);
        alert(`Reply error: ${err.message}`);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Reply";
      }
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);

    textarea.addEventListener("focus", () => {
      form.classList.add("mdr-comment-form--active");
    });

    form.appendChild(textarea);
    form.appendChild(actions);
    return form;
  }

  /* ---------------------------------------------------------------- */
  /*  New comment form (from hover bubble)                             */
  /* ---------------------------------------------------------------- */

  function createNewCommentForm(prInfo, filePath, commitId, lineNum, anchorEl, onRefresh) {
    const existing = qs(`.mdr-new-comment-form[data-mdr-line="${lineNum}"]`, anchorEl.parentElement);
    if (existing) {
      qs("textarea", existing)?.focus();
      return;
    }

    const form = createElement("div", {
      className: `${FORM_CLASS} mdr-new-comment-form`,
    });
    form.setAttribute("data-mdr-line", String(lineNum));

    const textarea = createElement("textarea", {
      className: "mdr-comment-form__textarea",
      placeholder: "Leave a comment\u2026",
    });
    textarea.rows = 3;

    const actions = createElement("div", { className: "mdr-comment-form__actions" });

    const cancelBtn = createElement("button", {
      className: "mdr-btn mdr-btn--secondary",
      type: "button",
      textContent: "Cancel",
    });

    const submitBtn = createElement("button", {
      className: "mdr-btn mdr-btn--primary",
      type: "button",
      textContent: "Add Comment",
    });

    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      form.remove();
    });

    submitBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const bodyText = textarea.value.trim();
      if (!bodyText) return;

      submitBtn.disabled = true;
      submitBtn.textContent = "Posting\u2026";

      try {
        const url = `https://api.github.com/repos/${prInfo.owner}/${prInfo.repo}/pulls/${prInfo.pullNumber}/comments`;
        const resp = await _apiCall("POST", url, {
          body: bodyText,
          commit_id: commitId,
          path: filePath,
          line: lineNum,
          side: "RIGHT",
        });

        if (resp.ok) {
          form.remove();
          _invalidateCache(prInfo);
          if (onRefresh) onRefresh();
        } else {
          console.warn("[MD Review] Create comment failed:", resp.status, resp.body);
          alert(`Comment failed: ${resp.body?.message || resp.status}`);
        }
      } catch (err) {
        console.error("[MD Review] Create comment error:", err);
        alert(`Comment error: ${err.message}`);
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Add Comment";
      }
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);
    form.appendChild(textarea);
    form.appendChild(actions);

    anchorEl.insertAdjacentElement("afterend", form);
    textarea.focus();
  }

  /* ---------------------------------------------------------------- */
  /*  Hover bubble                                                     */
  /* ---------------------------------------------------------------- */

  let _activeBubble = null;
  let _bubbleTimeout = null;

  function installHoverBubble(article, lineMap, prInfo, filePath, commitId, onRefresh) {
    const blockSelector = "li, p, h1, h2, h3, h4, h5, h6, tr, blockquote, pre";

    article.addEventListener("mouseover", (e) => {
      const block = e.target.closest(blockSelector);
      if (!block || !article.contains(block)) return;
      if (block.closest(`.${THREAD_CLASS}`) || block.closest(`.${FORM_CLASS}`)) return;

      clearTimeout(_bubbleTimeout);

      if (_activeBubble && _activeBubble._mdrBlock === block) return;

      _removeBubble();

      _bubbleTimeout = setTimeout(() => {
        _showBubble(block, article, lineMap, prInfo, filePath, commitId, onRefresh);
      }, 200);
    });

    article.addEventListener("mouseleave", () => {
      clearTimeout(_bubbleTimeout);
      _bubbleTimeout = setTimeout(_removeBubble, 300);
    });
  }

  function _showBubble(block, article, lineMap, prInfo, filePath, commitId, onRefresh) {
    _removeBubble();

    const lineNum = _resolveBlockLine(block, lineMap);
    if (!lineNum) return;

    const bubble = createElement("button", {
      className: BUBBLE_CLASS,
      type: "button",
      title: `Comment on line ${lineNum}`,
    });
    bubble.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path fill-rule="evenodd" d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z"></path></svg>`;
    bubble._mdrBlock = block;

    bubble.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      _removeBubble();
      createNewCommentForm(prInfo, filePath, commitId, lineNum, block, onRefresh);
    });

    bubble.addEventListener("mouseenter", () => {
      clearTimeout(_bubbleTimeout);
    });

    bubble.addEventListener("mouseleave", () => {
      _bubbleTimeout = setTimeout(_removeBubble, 300);
    });

    block.style.position = "relative";
    block.appendChild(bubble);
    _activeBubble = bubble;
  }

  function _removeBubble() {
    if (_activeBubble) {
      _activeBubble.remove();
      _activeBubble = null;
    }
  }

  function _resolveBlockLine(block, lineMap) {
    const sourcePos = block.closest("[data-sourcepos]");
    if (sourcePos) {
      const value = sourcePos.getAttribute("data-sourcepos") || "";
      const match = value.match(/^(\d+):\d+-\d+:\d+$/);
      if (match) return parseInt(match[1], 10);
    }

    if (!lineMap || lineMap.size === 0) return null;

    const text = (block.textContent || "").trim();
    if (!text) return null;

    return _findBestLineMatchSimple(text, lineMap);
  }

  function _normalizeText(text) {
    return (text || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function _stripMarkdown(text) {
    return text
      .replace(/^#{1,6}\s+/, "")
      .replace(/^\*\s+/, "")
      .replace(/^-\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/\*\*/g, "")
      .replace(/\*/g, "")
      .replace(/`/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();
  }

  function _findBestLineMatchSimple(text, lineMap) {
    const normalized = _normalizeText(text);
    if (!normalized || normalized.length < 2) return null;

    const exact = lineMap.get(normalized);
    if (exact?.length === 1) return exact[0];

    const firstLine = _normalizeText(normalized.split("\n")[0]);
    if (firstLine.length > 1) {
      const match = lineMap.get(firstLine);
      if (match?.length === 1) return match[0];

      const stripped = _normalizeText(_stripMarkdown(firstLine));
      if (stripped.length > 1) {
        const strippedMatch = lineMap.get(stripped);
        if (strippedMatch?.length === 1) return strippedMatch[0];
      }
    }

    return null;
  }

  /* ---------------------------------------------------------------- */
  /*  Cache invalidation                                               */
  /* ---------------------------------------------------------------- */

  function _invalidateCache(prInfo) {
    const key = `${prInfo.owner}/${prInfo.repo}/${prInfo.pullNumber}`;
    _commentCache.delete(key);
  }

  /* ---------------------------------------------------------------- */
  /*  Main entry: enhance a rich diff article with inline comments     */
  /* ---------------------------------------------------------------- */

  async function enhanceArticle(article, container, lineMap, filePath, pathDigest, commitId, onRefresh) {
    console.log("[MD Review InlineComments] enhanceArticle called for", filePath, "commitId:", commitId);

    const hasAuth = await _hasToken();
    if (!hasAuth) {
      console.warn("[MD Review InlineComments] No GitHub PAT configured — skipping inline comments. Set one via the extension popup.");
      return;
    }
    console.log("[MD Review InlineComments] Token found");

    const prInfo = _parsePRUrl();
    if (!prInfo) {
      console.warn("[MD Review InlineComments] Could not parse PR info from URL:", window.location.pathname);
      return;
    }
    console.log("[MD Review InlineComments] PR:", prInfo.owner + "/" + prInfo.repo + "#" + prInfo.pullNumber);

    qsa(`.${THREAD_CLASS}`, article).forEach((el) => el.remove());
    qsa(`.mdr-new-comment-form`, article).forEach((el) => el.remove());

    let threads;
    try {
      const comments = await fetchPRComments(prInfo.owner, prInfo.repo, prInfo.pullNumber);
      console.log("[MD Review InlineComments] Fetched", comments.length, "total PR comments");
      threads = groupCommentsIntoThreads(comments, filePath);
      console.log("[MD Review InlineComments] Grouped into", threads.length, "threads for", filePath);
      for (const t of threads) {
        console.log("[MD Review InlineComments]   Thread on line", t.line, "- root comment:", t.root.id, "-", (t.root.body || "").substring(0, 60));
      }
    } catch (err) {
      console.warn("[MD Review InlineComments] Failed to fetch inline comments:", err);
      return;
    }

    if (threads.length === 0 && !commitId) {
      console.log("[MD Review InlineComments] No threads and no commitId — nothing to do");
      return;
    }

    const blockSelector = "[data-sourcepos], li, p, h1, h2, h3, h4, h5, h6, tr, blockquote, pre";
    const allBlocks = qsa(blockSelector, article).filter(
      (b) => !b.closest(`.${THREAD_CLASS}`) && !b.closest(`.${FORM_CLASS}`)
    );

    const blockByLine = new Map();
    for (const block of allBlocks) {
      const blockLine = _resolveBlockLine(block, lineMap);
      if (!blockLine) continue;
      if (!blockByLine.has(blockLine) || block.hasAttribute("data-sourcepos")) {
        blockByLine.set(blockLine, block);
      }
    }
    console.log("[MD Review InlineComments] Mapped", blockByLine.size, "DOM blocks to line numbers:", [...blockByLine.keys()].sort((a, b) => a - b).join(", "));

    let anchored = 0;
    for (const thread of threads) {
      const anchorBlock = blockByLine.get(thread.line);
      if (!anchorBlock) {
        console.warn("[MD Review InlineComments] No DOM anchor for thread on line", thread.line, "— available lines:", [...blockByLine.keys()].sort((a, b) => a - b).join(", "));
        continue;
      }

      const threadEl = renderThread(thread, prInfo, filePath, commitId, onRefresh);
      anchorBlock.insertAdjacentElement("afterend", threadEl);
      anchored++;
    }
    console.log("[MD Review InlineComments] Rendered", anchored, "of", threads.length, "threads");

    if (commitId) {
      installHoverBubble(article, lineMap, prInfo, filePath, commitId, () => {
        _invalidateCache(prInfo);
        if (onRefresh) onRefresh();
      });
      console.log("[MD Review InlineComments] Hover bubble installed");
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Cleanup                                                          */
  /* ---------------------------------------------------------------- */

  function removeAllInlineComments() {
    qsa(`.${THREAD_CLASS}`).forEach((el) => el.remove());
    qsa(`.mdr-new-comment-form`).forEach((el) => el.remove());
    _removeBubble();
  }

  return {
    enhanceArticle,
    removeAllInlineComments,
    fetchPRComments,
    groupCommentsIntoThreads,
    createNewCommentForm,
    THREAD_CLASS,
    FORM_CLASS,
    BUBBLE_CLASS,
  };
})();
