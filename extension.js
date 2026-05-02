const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Prices in USD per million tokens
const PRICING = {
  'claude-opus-4-7':   { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-sonnet-4-6': { input:  3.00, output: 15.00, cacheWrite:  3.75, cacheRead: 0.30 },
  'claude-haiku-4-5':  { input:  0.80, output:  4.00, cacheWrite:  1.00, cacheRead: 0.08 },
};

function getPricing(model) {
  if (model) {
    for (const [key, price] of Object.entries(PRICING)) {
      if (model.includes(key)) return price;
    }
  }
  return PRICING['claude-sonnet-4-6'];
}

// Guard against Infinity/NaN/non-number values from untrusted JSONL
function safeInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function calcCost(usage, model) {
  const p = getPricing(model);
  return (
    (safeInt(usage.input_tokens) / 1e6) * p.input +
    (safeInt(usage.output_tokens) / 1e6) * p.output +
    (safeInt(usage.cache_creation_input_tokens) / 1e6) * p.cacheWrite +
    (safeInt(usage.cache_read_input_tokens) / 1e6) * p.cacheRead
  );
}

function fmtTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function hasTextContent(entry) {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return true;
  return content.some(c => c.type === 'text');
}

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB guard against blocking reads

// Single-pass parse: returns both turn data and user message count.
function parseSession(filePath) {
  try {
    if (fs.statSync(filePath).size > MAX_FILE_BYTES) return { turn: null, userCount: 0 };
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    const parsed = [];
    let userCount = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        parsed.push(entry);
        if (entry.type === 'user') userCount++;
      } catch { /* skip malformed */ }
    }

    // Find the last assistant entry that has usage
    let lastAssistantIdx = -1;
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].type === 'assistant' && parsed[i].message?.usage) {
        lastAssistantIdx = i;
        break;
      }
    }
    if (lastAssistantIdx === -1) return { turn: null, userCount };

    // Only update when the turn is complete (last assistant msg has text, not just tool calls)
    if (!hasTextContent(parsed[lastAssistantIdx])) return { turn: null, userCount };

    // Find the last user message before this assistant block
    let lastUserIdx = 0;
    for (let i = lastAssistantIdx - 1; i >= 0; i--) {
      if (parsed[i].type === 'user') { lastUserIdx = i; break; }
    }

    // Sum all assistant usage between the last user message and end of file.
    // Deduplicate by message.id — Claude Code can write multiple JSONL entries
    // for the same API response when the content has both text and tool_use blocks.
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    let model = null;
    let steps = 0;
    const seenIds = new Set();
    for (let i = lastUserIdx + 1; i < parsed.length; i++) {
      const entry = parsed[i];
      if (entry.type === 'assistant' && entry.message?.usage) {
        const msgId = entry.message.id;
        if (msgId && seenIds.has(msgId)) continue;
        if (msgId) seenIds.add(msgId);
        const u = entry.message.usage;
        usage.input_tokens += safeInt(u.input_tokens);
        usage.output_tokens += safeInt(u.output_tokens);
        usage.cache_creation_input_tokens += safeInt(u.cache_creation_input_tokens);
        usage.cache_read_input_tokens += safeInt(u.cache_read_input_tokens);
        model = model || entry.message.model;
        steps++;
      }
    }

    return { turn: { usage, model, steps }, userCount };
  } catch { return { turn: null, userCount: 0 }; }
}

function newestJsonl(projectsDir) {
  let newest = null, newestTime = 0;
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      if (dir !== path.basename(dir)) continue; // path traversal guard
      const dirPath = path.join(projectsDir, dir);
      try {
        for (const file of fs.readdirSync(dirPath)) {
          if (!file.endsWith('.jsonl') || file !== path.basename(file)) continue;
          const fp = path.join(dirPath, file);
          const t = fs.statSync(fp).mtimeMs;
          if (t > newestTime) { newestTime = t; newest = fp; }
        }
      } catch { /* skip unreadable dirs */ }
    }
  } catch { /* projects dir missing */ }
  return newest;
}

function activate(context) {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects');

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusBar.command = 'claudeTokenTracker.showDetails';
  statusBar.tooltip = 'Claude Code last turn tokens — click for breakdown';
  statusBar.text = '$(pulse) claude: --';
  statusBar.show();
  context.subscriptions.push(statusBar);

  let lastTurn = null;
  let currentSessionFile = null;
  let lastNotifiedCount = 0;
  let debounceTimer = null;

  function applyTurn(turn) {
    if (!turn) return;
    lastTurn = turn;
    const cost = calcCost(turn.usage, turn.model);
    const total = turn.usage.input_tokens + turn.usage.output_tokens;
    const stepLabel = turn.steps > 1 ? ` (${turn.steps} steps)` : '';
    statusBar.text = `$(pulse) ${fmtTokens(total)}tok  $${cost.toFixed(4)}${stepLabel}`;
  }

  function checkCompact(fsPath, userCount) {
    const cfg = vscode.workspace.getConfiguration('claudeTokenTracker');
    if (!cfg.get('compactNotification', true)) return;
    const threshold = Math.max(1, cfg.get('compactThreshold', 10));

    if (fsPath !== currentSessionFile) {
      currentSessionFile = fsPath;
      lastNotifiedCount = 0;
    }
    if (userCount > 0 && userCount % threshold === 0 && userCount !== lastNotifiedCount) {
      lastNotifiedCount = userCount;
      vscode.window.showInformationMessage(
        `Claude Code: ${userCount} messages in session — run /compact to save tokens?`,
        'Copy /compact',
        'Dismiss'
      ).then(choice => {
        if (choice === 'Copy /compact') {
          vscode.env.clipboard.writeText('/compact');
          vscode.commands.executeCommand('claude-vscode.focus');
          vscode.window.showInformationMessage('/compact copied — paste and press Enter');
        }
      }).catch(() => {});
    }
  }

  function onFileChange(fsPath) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const { turn, userCount } = parseSession(fsPath);
      applyTurn(turn);
      if (turn) checkCompact(fsPath, userCount);
    }, 300);
  }

  // Watch all JSONL files under ~/.claude/projects/
  const base = vscode.Uri.file(claudeProjectsDir);
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(base, '**/*.jsonl')
  );
  watcher.onDidChange(uri => onFileChange(uri.fsPath));
  watcher.onDidCreate(uri => onFileChange(uri.fsPath));
  context.subscriptions.push(watcher);

  // Show data from the most recently touched session on startup
  const initial = newestJsonl(claudeProjectsDir);
  if (initial) applyTurn(parseSession(initial).turn);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeTokenTracker.showDetails', () => {
      if (!lastTurn) {
        vscode.window.showInformationMessage('No Claude Code message data yet — send a message first.');
        return;
      }
      const { usage, model, steps } = lastTurn;
      const cost = calcCost(usage, model);
      const lines = [
        `Model: ${model || 'unknown'}`,
        `\nSteps in turn: ${steps}`,
        `\nInput tokens:  ${usage.input_tokens.toLocaleString()}`,
        `\nOutput tokens: ${usage.output_tokens.toLocaleString()}`,
      ];
      if (usage.cache_creation_input_tokens)
        lines.push(`\nCache write: ${usage.cache_creation_input_tokens.toLocaleString()}`);
      if (usage.cache_read_input_tokens)
        lines.push(`\nCache read:  ${usage.cache_read_input_tokens.toLocaleString()}`);
      lines.push(`\nEstimated cost: $${cost.toFixed(6)}`);
      vscode.window.showInformationMessage(lines.join('\n'));
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
