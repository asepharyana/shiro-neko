# WebView Tool — Spec

## TL;DR
A `web_browse` tool that uses Bun's built-in WebView to navigate, interact with, and
screenshot web pages — no Puppeteer, no Playwright, no separate browser download.

## Problem
The existing `web_fetch` tool only extracts static HTML. SPAs, pages requiring JS
execution, form submissions, and interactive testing are impossible. The agent needs
a real browser to handle modern web apps.

## Goal
- Navigate to any URL and extract text/HTML after JS execution
- Click buttons, fill forms, scroll pages
- Take screenshots (save to file, return path)
- Evaluate arbitrary JavaScript in the page context
- Generate PDFs from pages

## Architecture

### Tool: `web_browse`

Input schema:
```ts
{
  url: string;           // URL to navigate to
  action?: 'text' | 'html' | 'screenshot' | 'evaluate' | 'click' | 'type' | 'scroll' | 'pdf';
  selector?: string;     // CSS selector for click/type/scroll
  text?: string;         // text to type (for 'type' action)
  script?: string;       // JS to evaluate (for 'evaluate' action)
  wait?: number;         // ms to wait after navigation (default: 1000)
}
```

Default action: `text` — navigate and return page text content.

### Implementation (src/tools-webview.ts)

- Uses `Bun.WebView` with Chrome backend (headless)
- One view per call (create → navigate → act → close)
- Screenshot saved to `os.tmpdir()/shiro-webview-{timestamp}.png`
- PDF saved to `os.tmpdir()/shiro-webview-{timestamp}.pdf`
- Timeout: 15s per navigation, 5s per action
- Error handling: browser not found → suggest install; page error → return error text

### Registration

- Add to `tools.ts` as a `net` tool (network access)
- Add to `TOOL_META` as 'net'
- Add to `TOOL_SETS.net` set
- NOT in default tool set (opt-in via toolSets config)

### Tests

- Unit: tool schema validation
- Integration: navigate to data: URL, verify text extraction
- Integration: screenshot saves file
- Integration: evaluate JS returns result
- Edge case: invalid URL returns error
- Edge case: browser not available returns helpful message

## Files touched

- **NEW**: `src/tools-webview.ts`
- **EDIT**: `src/tools.ts` — register tool, add to TOOL_META and TOOL_SETS
- **NEW**: `test/webview.test.ts`
- **NEW**: `docs/webview.md`
