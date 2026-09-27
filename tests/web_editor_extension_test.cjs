const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('embedded extension refreshes bounded logs, rotation, metadata and VM commands', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ocvm-editor-extension-'));
  const channels = new Map();
  const commands = new Map();
  const subscriptions = [];
  let terminal;
  let timer;
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    window: {
      createOutputChannel(name) {
        const channel = { text: '', shown: false, replace(text) { this.text = text; }, show() { this.shown = true; }, dispose() {} };
        channels.set(name, channel);
        return channel;
      },
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      createTerminal(options) { terminal = options; return { show() {} }; },
    },
    commands: { registerCommand(name, fn) { commands.set(name, fn); return { dispose() {} }; } },
  };
  try {
    await fs.mkdir(path.join(root, 'mcp'));
    await fs.mkdir(path.join(root, 'editor'));
    const runtime = path.join(root, 'editor/runtime.json');
    await fs.writeFile(runtime, JSON.stringify({ schema: 1, share: root, project: root, projectHash: 'test', mcpEnabled: true }));
    await fs.writeFile(path.join(root, 'mcp/adapter.log'), 'old\n'.repeat(50000) + 'LATEST\n');
    const journal = { schema: 1, project: 'test', epoch: 'epoch-1', events: [{ timestamp: 'now', type: 'message.completed', session_id: 'ses_test', message_id: 'msg_test', source: 'observed', prompt: 'PRIVATE PROMPT', title: 'PRIVATE TITLE' }] };
    await fs.writeFile(path.join(root, 'mcp/activity.json'), JSON.stringify(journal));
    const script = await fs.readFile(path.join(__dirname, '../opencode-vm.sh'), 'utf8');
    const source = script.split("read -r -d '' OCVM_EDITOR_EXTENSION_JS <<'EDITOR_JS' || true\n")[1].split('\nEDITOR_JS\n')[0];
    const context = { exports: {}, require: name => name === 'vscode' ? vscode : require(name), Buffer,
      process: { env: { OCVM_EDITOR_RUNTIME: runtime } },
      setInterval(callback) { timer = callback; return 1; }, clearInterval() { timer = undefined; },
    };
    vm.runInNewContext(source, context);
    await context.exports.activate({ subscriptions });
    const log = channels.get('MCP: Communication');
    assert.ok(Buffer.byteLength(log.text) < 132000);
    assert.match(log.text, /Earlier log entries omitted/);
    assert.match(log.text, /LATEST/);
    assert.equal(log.shown, false, 'startup must not open the panel');
    const activity = channels.get('OpenCode: Activity');
    assert.match(activity.text, /message.completed.*ses_test.*msg_test/);
    assert.doesNotMatch(activity.text, /PRIVATE/);
    assert.match(channels.get('opencode-vm: Status').text, /MCP: unreachable/);
    await fs.rename(path.join(root, 'mcp/adapter.log'), path.join(root, 'mcp/adapter.log.old'));
    await fs.writeFile(path.join(root, 'mcp/adapter.log'), 'ROTATED\n');
    await commands.get('ocvm.logs.mcp')();
    assert.match(log.text, /ROTATED/);
    assert.doesNotMatch(log.text, /LATEST/);
    assert.equal(log.shown, true);
    journal.project = 'foreign';
    await fs.writeFile(path.join(root, 'mcp/activity.json'), JSON.stringify(journal));
    await commands.get('ocvm.logs.activity')();
    assert.match(activity.text, /unavailable/);
    assert.doesNotMatch(activity.text, /ses_test/);
    await commands.get('ocvm.terminal')();
    assert.equal(terminal.cwd, root);
    assert.ok(timer);
  } finally {
    for (const item of subscriptions) item.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
  assert.equal(timer, undefined);
});
