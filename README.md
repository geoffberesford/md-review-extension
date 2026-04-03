# Markdown Rich Review for GitHub Pull Requests

A Chrome / Microsoft Edge extension (MV3) that enhances the GitHub Pull Request **Files changed** view for Markdown files.

![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Rich diff enhancement** — When you switch a `.md` or `.mdc` file to GitHub's rich diff view, the extension overlays line numbers, comment indicators, and click-to-source navigation.
- **Inline comment threads** — PR review comments appear directly in the rich diff view, threaded and collapsible. No more switching to source diff to read feedback.
- **Reply from rich diff** — Reply to any comment thread without leaving the rendered preview.
- **Add comments from rich diff** — Hover over any block element to see a "+" bubble. Click to leave a new review comment anchored to that line.
- **Line-level comment indicators** — Lines with existing review comments show a chat-bubble icon with superscript count in the right margin, and a permanent dashed outline.
- **Click-to-source** — Click any element in the rich preview to jump to the corresponding line in the source diff, with automatic expansion of collapsed sections.
- **Back to rich view** — A header button lets you switch back from source diff to rich preview in one click.
- **Comment bar** — A summary bar at the top of each rich diff shows all commented lines with quick-jump badges.
- **Toggle on/off** — Click the floating status badge to pause or resume the extension.
- **Source line highlighting** — Selected source lines are persistently highlighted with automatic retry for lazy-loaded diffs.
- **Comment activity tracking** — Starting a review or adding comments reflects back in the rich diff indicators in real time.

## Setup

### 1. Install the extension

**From source (developer mode):**

1. Clone this repository:
   ```bash
   git clone https://github.com/geoffberesford/md-review-extension.git
   cd md-review-extension
   ```

2. Open your browser's extension page:
   - **Edge**: `edge://extensions`
   - **Chrome**: `chrome://extensions`

3. Enable **Developer mode**.

4. Click **Load unpacked** and select the project directory.

**From packaged zip:**

1. Download the latest `.zip` from [Releases](../../releases).
2. Unzip to a folder.
3. Load unpacked from that folder.

### 2. Configure a GitHub token (for inline comments)

The inline comment features (viewing, creating, and replying to comments in the rich diff) require a GitHub Personal Access Token:

1. Click the extension icon in your browser toolbar.
2. Enter a GitHub PAT with `repo` scope (for private repos) or `public_repo` scope (for public repos only).
3. Click **Save**, then **Test Connection** to verify.

Without a token, the extension still works for line numbers, click-to-source, and comment indicators — just without the inline thread display and comment creation.

## Packaging

```bash
npm run package
```

Outputs `dist/markdown-rich-review-<version>.zip`.

## CI / CD

| Trigger | What happens |
|---|---|
| Push to `main` | Packages the extension and updates a rolling `latest` pre-release |
| Push a tag `v*` | Creates a GitHub Release with the `.zip` attached |
| Manual dispatch | Packages the extension and uploads as a build artifact |

## File structure

```
md-review-extension/
├── manifest.json              # MV3 extension manifest
├── content-script.js          # Main content script — enhancement logic
├── inline-comments.js         # Inline comment threads, create/reply, hover bubble
├── utils/
│   └── domHelpers.js          # Shared DOM utility functions
├── styles/
│   └── reviewPane.css         # All extension styles
├── background/
│   └── service-worker.js      # GitHub API proxy (authenticated requests)
├── popup/
│   ├── popup.html             # Settings popup
│   ├── popup.js               # Settings logic (token management)
│   └── popup.css              # Popup styles
├── icons/
│   ├── icon16.png
│   ├── icon32.png
│   └── icon64.png
├── scripts/
│   └── package.mjs            # Packaging script
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── release.yml
├── package.json
├── LICENSE
└── README.md
```

## How it works

The extension runs as a content script on `github.com/*` pages. On PR Files changed pages, it:

1. **Detects** `.md` and `.mdc` files among the diff containers (via embedded payload metadata and DOM inspection).
2. **Enhances** the rich diff view — adding click handlers, line numbers, comment indicators, and inline comment threads.
3. **Fetches** raw file content (using same-origin credentials) to build a line map for accurate source-position mapping.
4. **Fetches** PR review comments (via the GitHub REST API through the background service worker) to render inline comment threads.
5. **Navigates** to the source diff on click, expanding collapsed sections and highlighting the target line.

The basic features (line numbers, click-to-source, comment indicators) work without authentication, using the browser session and embedded page data. The inline comment features require a GitHub PAT configured in the popup.

## License

[MIT](LICENSE)
