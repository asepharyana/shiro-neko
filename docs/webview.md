# WebView Tool (web_browse)

A built-in browser tool powered by Bun's native WebView. No Puppeteer, no Playwright,
no separate browser download — just the runtime's own headless browser.

## What it does

- **Navigate** to any URL and extract text/HTML after JS execution
- **Click** buttons, links, and interactive elements
- **Type** into input fields and forms
- **Scroll** to elements on the page
- **Screenshot** pages as PNG files
- **Evaluate** arbitrary JavaScript in the page context

## When to use it

Use `web_browse` instead of `web_fetch` when:

- The page is a SPA (Single Page Application) that needs JavaScript
- You need to interact with the page (click, type, scroll)
- You need a visual screenshot of the page
- `web_fetch` returns incomplete or empty content
- You need to fill forms or submit data

Use `web_fetch` when:

- The page is static HTML
- You just need the text content quickly
- No JS execution is needed

## Actions

| Action | Description | Requires |
|--------|-------------|----------|
| `text` | Page text content after JS execution | — |
| `html` | Raw HTML of the page | — |
| `screenshot` | Save page as PNG, return file path | — |
| `evaluate` | Run JavaScript, return result | `script` |
| `click` | Click an element | `selector` |
| `type` | Type text into an input | `selector` + `text` |
| `scroll` | Scroll to an element | `selector` |

## Examples

```json
// Get page text
{ "url": "https://example.com", "action": "text" }

// Take a screenshot
{ "url": "https://example.com", "action": "screenshot" }

// Click a button
{ "url": "https://example.com", "action": "click", "selector": "button.submit" }

// Fill a form
{ "url": "https://example.com", "action": "type", "selector": "#email", "text": "user@example.com" }

// Run custom JS
{ "url": "https://example.com", "action": "evaluate", "script": "document.querySelectorAll('a').length" }
```

## Requirements

- **macOS**: Uses system WKWebView (no install needed)
- **Linux/Windows**: Requires Chrome, Chromium, Edge, or Brave installed
- Bun 1.2+ for WebView support

## Tool set

`web_browse` is in the `net` tool set. Enable it in config:

```json
{ "toolSets": ["core", "git", "net"] }
```

Or enable all sets with `toolSets: ["*"]`.

## Limitations

- Each call creates a fresh browser instance (no persistent sessions by default)
- Maximum 15s navigation timeout, 5s action timeout
- Screenshots are saved to the system temp directory
- Not available in Bun versions before 1.2
