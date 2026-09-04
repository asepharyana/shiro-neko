import { expect, test } from 'bun:test';
import { executeWebBrowse } from '../src/tools-webview';

// These tests require a browser (Chrome/Chromium on Linux, WKWebView on macOS).
// They use data: URLs so no network access is needed.

const HAS_WV = typeof (Bun as any).WebView !== 'undefined';

test.skipIf(!HAS_WV)('text action extracts page content from data URL', async () => {
  const result = await executeWebBrowse({
    url: 'data:text/html,<h1>Hello WebView</h1><p>Test content</p>',
    action: 'text',
    wait: 500,
  });
  expect(result).toContain('Hello WebView');
  expect(result).toContain('Test content');
});

test.skipIf(!HAS_WV)('html action returns raw HTML', async () => {
  const result = await executeWebBrowse({
    url: 'data:text/html,<html><body><div id="app">OK</div></body></html>',
    action: 'html',
    wait: 500,
  });
  expect(result).toContain('<div id="app">OK</div>');
});

test.skipIf(!HAS_WV)('evaluate action runs JavaScript', async () => {
  const result = await executeWebBrowse({
    url: 'data:text/html,<script>window.x = 42;</script>',
    action: 'evaluate',
    script: 'window.x',
    wait: 500,
  });
  expect(result).toContain('42');
});

test.skipIf(!HAS_WV)('screenshot action saves a PNG file', async () => {
  const result = await executeWebBrowse({
    url: 'data:text/html,<h1 style="color:blue">Screenshot</h1>',
    action: 'screenshot',
    wait: 500,
  });
  expect(result).toContain('Screenshot saved');
  expect(result).toContain('.png');
  expect(result).toContain('KB');
});

test.skipIf(!HAS_WV)('click action works on a button', async () => {
  const result = await executeWebBrowse({
    url: 'data:text/html,<button onclick="document.title = clicked">Click me</button>',
    action: 'click',
    selector: 'button',
    wait: 500,
  });
  expect(result).toContain('Clicked: button');
});

test.skipIf(!HAS_WV)('type action fills an input', async () => {
  const result = await executeWebBrowse({
    url: 'data:text/html,<input id="name" />',
    action: 'type',
    selector: '#name',
    text: 'hello',
    wait: 500,
  });
  expect(result).toContain('Typed "hello"');
});

test.skipIf(!HAS_WV)('missing selector returns error', async () => {
  const result = await executeWebBrowse({
    url: 'data:text/html,<button>Click</button>',
    action: 'click',
    wait: 500,
  });
  expect(result).toContain('Error');
  expect(result).toContain('selector');
});

test.skipIf(!HAS_WV)('missing script returns error for evaluate', async () => {
  const result = await executeWebBrowse({
    url: 'data:text/html,<h1>Test</h1>',
    action: 'evaluate',
    wait: 500,
  });
  expect(result).toContain('Error');
  expect(result).toContain('script');
});

test.skipIf(!HAS_WV)('invalid URL returns error', async () => {
  const result = await executeWebBrowse({
    url: 'https://this-does-not-exist-12345.invalid',
    action: 'text',
    wait: 100,
  });
  expect(result).toContain('Failed to navigate');
});

test('schema validation rejects invalid URL', () => {
  // This tests the zod schema, not the WebView itself
  const { webBrowseSchema } = require('../src/tools-webview');
  const result = webBrowseSchema.safeParse({ url: 'not-a-url' });
  expect(result.success).toBe(false);
});
