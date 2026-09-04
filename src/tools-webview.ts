import { z } from 'zod';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Bun built-in WebView tool for shiro-neko.
 *
 * Uses `Bun.WebView` to navigate, interact with, and screenshot web pages.
 * No Puppeteer, no Playwright, no separate browser download — just the
 * runtime's own headless browser.
 *
 * Requires Chrome/Chromium/Edge on Linux/Windows, or WKWebView on macOS.
 * Not in the default tool set — opt-in via `toolSets: ["net"]`.
 */

const WEBVIEW_TIMEOUT = 15_000;

export const webBrowseSchema = z.object({
  url: z.string().url().describe('URL to navigate to.'),
  action: z
    .enum(['text', 'html', 'screenshot', 'evaluate', 'click', 'type', 'scroll'])
    .default('text')
    .describe(
      'text: page text content after JS; html: raw HTML; screenshot: save PNG and return path; ' +
      'evaluate: run script and return result; click: click a selector; type: type into a selector; ' +
      'scroll: scroll to a selector.',
    ),
  selector: z.string().optional().describe('CSS selector for click/type/scroll actions.'),
  text: z.string().optional().describe('Text to type (for "type" action).'),
  script: z.string().optional().describe('JavaScript to evaluate (for "evaluate" action).'),
  wait: z.number().min(0).max(30_000).default(1000).describe('Ms to wait after navigation before acting.'),
});

export type WebBrowseInput = z.infer<typeof webBrowseSchema>;

function timestamp(): string {
  return Date.now().toString(36);
}

/** Type-safe wrapper around view.evaluate that always returns a string. */
async function evalJS(view: InstanceType<typeof Bun.WebView>, script: string): Promise<string> {
  const result = await (view as any).evaluate(script);
  if (typeof result === 'string') return result;
  if (result === undefined || result === null) return '';
  return String(result);
}

export async function executeWebBrowse(args: WebBrowseInput): Promise<string> {
  // Check if WebView is available
  if (typeof (Bun as any).WebView === 'undefined') {
    return 'Bun.WebView is not available in this Bun version. Upgrade to Bun 1.2+ for WebView support.';
  }

  const { url, action, selector, text, script, wait } = args;

  // Create a new view for each call (clean state)
  let view: InstanceType<typeof Bun.WebView> | undefined;
  try {
    view = new (Bun as any).WebView({ width: 1280, height: 720 }) as InstanceType<typeof Bun.WebView>;

    // Navigate
    try {
      await Promise.race([
        view.navigate(url),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Navigation timeout after ${WEBVIEW_TIMEOUT}ms`)), WEBVIEW_TIMEOUT),
        ),
      ]);
    } catch (e) {
      return `Failed to navigate to ${url}: ${e instanceof Error ? e.message : String(e)}`;
    }

    // Wait for page to settle (JS execution, rendering)
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    // Execute action
    switch (action) {
      case 'text': {
        const bodyText = await evalJS(view, 'document.body?.innerText ?? ""');
        const title = await evalJS(view, 'document.title ?? ""');
        const finalUrl = view.url;
        return `[${title}](${finalUrl})\n\n${bodyText}`;
      }

      case 'html': {
        return await evalJS(view, 'document.documentElement?.outerHTML ?? ""');
      }

      case 'screenshot': {
        const buf = await view.screenshot({ format: 'png', encoding: 'buffer' });
        const path = join(tmpdir(), `shiro-webview-${timestamp()}.png`);
        await Bun.write(path, buf);
        return `Screenshot saved: ${path} (${(buf.length / 1024).toFixed(1)} KB)`;
      }

      case 'evaluate': {
        if (!script) return 'Error: "evaluate" action requires a "script" argument.';
        return await evalJS(view, script);
      }

      case 'click': {
        if (!selector) return 'Error: "click" action requires a "selector" argument.';
        try {
          await view.click(selector);
          return `Clicked: ${selector}`;
        } catch (e) {
          return `Failed to click "${selector}": ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      case 'type': {
        if (!selector) return 'Error: "type" action requires a "selector" argument.';
        if (!text) return 'Error: "type" action requires a "text" argument.';
        try {
          await (view as any).type(selector, text);
          return `Typed "${text}" into: ${selector}`;
        } catch (e) {
          return `Failed to type into "${selector}": ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      case 'scroll': {
        if (!selector) return 'Error: "scroll" action requires a "selector" argument.';
        try {
          await view.scrollTo(selector);
          return `Scrolled to: ${selector}`;
        } catch (e) {
          return `Failed to scroll to "${selector}": ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
  } catch (e) {
    return `WebView error: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    view?.close();
  }

  // Unreachable but satisfies TS
  return '';
}

/**
 * The web_browse tool definition.
 */
export const webBrowseTool = {
  name: 'web_browse',
  description:
    'Browse a web page with a real browser (Bun WebView). Navigates, executes JS, clicks, types, scrolls, and screenshots — no Puppeteer needed. Use for SPAs, pages requiring JS, or when web_fetch returns incomplete content.',
  inputSchema: webBrowseSchema,
  execute: async (args: WebBrowseInput) => {
    return executeWebBrowse(args);
  },
};
