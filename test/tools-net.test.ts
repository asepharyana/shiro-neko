import { afterEach, beforeEach, expect, test } from 'bun:test';
import { checkUrl, isPrivateAddress, webFetchTool } from '../src/tools-net';
import { htmlToMarkdown } from '../src/markdown';

/** The tool takes its fetch from the call context, so a server stands in for the web. */
const run = (input: unknown, fetchImpl?: typeof globalThis.fetch) =>
  Promise.resolve(
    webFetchTool.execute!(input as never, {
      toolCallId: 't1',
      messages: [],
      ...(fetchImpl ? { experimental_context: { fetch: fetchImpl } } : {}),
    } as never),
  ) as Promise<string>;

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

beforeEach(() => {
  server = undefined;
});

function serve(routes: Record<string, { body: string; type?: string; status?: number; headers?: Record<string, string> }>) {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const hit = routes[path];
      if (!hit) return new Response('not found', { status: 404 });
      return new Response(hit.body, {
        status: hit.status ?? 200,
        headers: { 'content-type': hit.type ?? 'text/plain', ...(hit.headers ?? {}) },
      });
    },
  });
  return server;
}

test('loopback and private ranges are recognised', () => {
  for (const host of [
    'localhost',
    'api.localhost',
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '192.168.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    '[::1]',
    'fd00::1',
    'fe80::1',
  ]) {
    expect(isPrivateAddress(host), host).toBe(true);
  }
});

test('public addresses are not treated as private', () => {
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1', '2606:4700::1111']) {
    expect(isPrivateAddress(host), host).toBe(false);
  }
});

test('only http and https are fetched', () => {
  for (const url of ['file:///etc/passwd', 'data:text/html,<b>x</b>', 'ftp://example.com/x']) {
    const checked = checkUrl(url);
    expect(checked.ok, url).toBe(false);
  }
});

test('plain http to a public host is refused, https is accepted', () => {
  expect(checkUrl('http://example.com').ok).toBe(false);
  expect(checkUrl('https://example.com').ok).toBe(true);
});

test('https to a private host is refused', () => {
  // The metadata endpoint is the reason this exists: a URL from model output must
  // not be able to read cloud credentials.
  expect(checkUrl('https://169.254.169.254/latest/meta-data/').ok).toBe(false);
  expect(checkUrl('https://localhost/admin').ok).toBe(false);
});

test('http to localhost is allowed, so a local dev server can be read', () => {
  expect(checkUrl('http://localhost:3000/docs').ok).toBe(true);
});

test('a malformed URL is reported rather than fetched', () => {
  const checked = checkUrl('not a url');
  expect(checked.ok).toBe(false);
  if (!checked.ok) expect(checked.reason).toContain('not a URL');
});

test('a refused URL never reaches the network', async () => {
  let called = 0;
  const spy = (async () => {
    called++;
    return new Response('x');
  }) as unknown as typeof globalThis.fetch;

  expect(run({ url: 'https://169.254.169.254/' }, spy)).rejects.toThrow(/private or loopback/);
  await Bun.sleep(20);
  expect(called).toBe(0);
});

test('plain text comes back with the URL that served it', async () => {
  const s = serve({ '/doc.txt': { body: 'the answer is 42' } });
  const out = await run({ url: `${s.url}doc.txt` });
  expect(out).toContain('doc.txt');
  expect(out).toContain('the answer is 42');
});

test('html is converted, and script and nav are dropped', async () => {
  const html = `<html><head><style>body{color:red}</style></head><body>
    <nav><a href="/">Home</a></nav>
    <h1>Install</h1>
    <p>Run <code>bun install</code> first.</p>
    <script>window.tracker = 1;</script>
    <footer>copyright</footer>
  </body></html>`;

  const s = serve({ '/page': { body: html, type: 'text/html; charset=utf-8' } });
  const out = await run({ url: `${s.url}page` });

  expect(out).toContain('# Install');
  expect(out).toContain('`bun install`');
  expect(out).not.toContain('window.tracker');
  expect(out).not.toContain('color:red');
  expect(out).not.toContain('Home');
  expect(out).not.toContain('copyright');
});

test('a non-2xx status is reported with the code', async () => {
  const s = serve({ '/gone': { body: 'nope', status: 503 } });
  expect(run({ url: `${s.url}gone` })).rejects.toThrow(/503/);
});

test('a binary content type is refused rather than returned as mojibake', async () => {
  const s = serve({ '/blob': { body: 'PK\u0003\u0004', type: 'application/zip' } });
  expect(run({ url: `${s.url}blob` })).rejects.toThrow(/not text/);
});

test('a redirect is followed and both URLs are shown', async () => {
  const s = serve({
    '/old': { body: '', status: 302, headers: { location: '/new' } },
    '/new': { body: 'moved content' },
  });

  const out = await run({ url: `${s.url}old` });
  expect(out).toContain('->');
  expect(out).toContain('moved content');
});

test('a redirect to a private host is refused mid-chain', async () => {
  // redirect: 'follow' would let a public URL walk to the metadata endpoint with
  // the check already passed, which is why every hop is re-checked.
  const s = serve({
    '/trap': { body: '', status: 302, headers: { location: 'https://169.254.169.254/latest/' } },
  });

  expect(run({ url: `${s.url}trap` })).rejects.toThrow(/refused URL/);
});

test('a redirect loop stops rather than hanging', async () => {
  const s = serve({ '/loop': { body: '', status: 302, headers: { location: '/loop' } } });
  expect(run({ url: `${s.url}loop` })).rejects.toThrow(/redirects/);
});

test('maxChars truncates with a count', async () => {
  const s = serve({ '/long': { body: 'x'.repeat(5000) } });
  const out = await run({ url: `${s.url}long`, maxChars: 500 });
  expect(out).toContain('truncated');
  expect(out.length).toBeLessThan(1200);
});

test('an oversized body is capped and the cap is stated', async () => {
  const s = serve({ '/huge': { body: 'y'.repeat(700 * 1024) } });
  const out = await run({ url: `${s.url}huge` });
  expect(out).toContain('capped at');
});

test('entities are decoded so code samples read correctly', () => {
  const out = htmlToMarkdown('<p>use &lt;div&gt; &amp; &quot;quotes&quot; &#39;here&#39;</p>');
  expect(out).toBe(`use <div> & "quotes" 'here'`);
});

test('a pre block becomes a fenced block', () => {
  const out = htmlToMarkdown('<pre><code>const a = 1;\nconst b = 2;</code></pre>');
  expect(out).toContain('```');
  expect(out).toContain('const a = 1;');
  expect(out).toContain('const b = 2;');
});

test('list items become bullets', () => {
  const out = htmlToMarkdown('<ul><li>first</li><li>second</li></ul>');
  expect(out).toContain('- first');
  expect(out).toContain('- second');
});

test('headings keep their level', () => {
  expect(htmlToMarkdown('<h3>Third</h3>')).toBe('### Third');
});
