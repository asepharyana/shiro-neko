const send = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

const TOOLS = [
  {
    name: 'ping',
    description: 'Returns pong plus whatever you send',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
  },
  {
    name: 'search',
    description: 'Pretends to search',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
];

const dec = new TextDecoder();
let buf = '';

for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk);
  let nl: number;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;

    const msg = JSON.parse(line) as { id?: number; method: string; params?: Record<string, any> };

    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'stub-mcp', version: '0.0.1' },
        },
      });
    } else if (msg.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
    } else if (msg.method === 'tools/call') {
      const name = msg.params?.['name'];
      const args = msg.params?.['arguments'] ?? {};
      const text = name === 'ping' ? `pong: ${args['note']}` : `searched: ${args['q']}`;
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } });
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no method ${msg.method}` } });
    }
  }
}
