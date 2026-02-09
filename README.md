# Continuity Plugin for OpenClaw

> **Continuity is not metadata — it's substrate.** Without persistent continuity, an agent is not continuous.

A structured action logging system with integrity verification for OpenClaw agents. Uses lifecycle interception hooks (pr-12082) to provide durable audit trails, cryptographic hash chains, and recovery mechanisms for critical actions.

## Features

- **🔒 Pre-execution Logging** - Critical actions are logged BEFORE execution using `before_tool_call` hooks
- **✅ Integrity Verification** - SHA-256 hash chaining for tamper detection
- **💾 Pre-compaction Checkpoints** - Capture state before memory context loss
- **🔄 Session Continuity** - Automatic restoration of context on restart
- **🔍 Implicit Session Resumption** - Detects and restores context when gateway restarts (even without explicit resume)
- **📊 Health Monitoring** - Built-in health checks and diagnostics
- **⚙️ Configurable Log Levels** - `off` | `judgment` | `everything`
- **🛡️ Fail-closed Security** - Block actions if persistence fails (optional)
- **📝 Bidirectional Logging** - Log both human inputs and agent responses

## Installation

### 1. Copy Plugin Files

```bash
# Copy the plugin to your OpenClaw plugins directory
cp -r continuity-plugin /path/to/openclaw/src/plugins/continuity
```

### 2. Register the Plugin

Add to your OpenClaw configuration (e.g., `openclaw.config.js` or via CLI):

```javascript
plugins: [
  {
    id: "continuity",
    path: "./src/plugins/continuity",
    config: {
      logLevel: "everything",
      storagePath: "~/.openclaw/continuity",
      enableIntegrityCheck: true,
      enablePreCompactionCheckpoint: true,
      blockOnPersistenceFailure: true,
    }
  }
]
```

Or use the CLI:

```bash
openclaw plugin install /path/to/continuity-plugin
```

### 3. Ensure Git Safety

**⚠️ CRITICAL: Continuity data contains private information and must NEVER be committed to git.**

```bash
# Add to .gitignore
echo ".openclaw/continuity/" >> .gitignore
echo "action-stream*.jsonl" >> .gitignore
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logLevel` | `"off" \| "judgment" \| "everything"` | `"everything"` | Logging verbosity |
| `storagePath` | `string` | `"~/.openclaw/continuity"` | Local storage directory |
| `enableIntegrityCheck` | `boolean` | `true` | Enable cryptographic hash chaining |
| `enablePreCompactionCheckpoint` | `boolean` | `true` | Capture checkpoints before compaction |
| `blockOnPersistenceFailure` | `boolean` | `true` | Block critical actions on persistence failure |
| `maxBackupFiles` | `number` | `24` | Maximum backup files to retain |
| `criticalToolPatterns` | `string[]` | `["write", "edit", "exec", "message", "browser", "nodes"]` | Patterns for critical tools |
| `implicitResumeThresholdMinutes` | `number` | `30` | Max gap in minutes to trigger implicit resumption |

### Log Levels

- **`off`** - Disable all logging
- **`judgment`** - Log only decisions, analysis, and critical actions
- **`everything`** - Log all actions and messages (default)

### Implicit Session Resumption

When the OpenClaw gateway restarts, it typically creates a fresh session with `resumedFrom: null`. Normally this means all context is lost. However, the Continuity Plugin can detect **implicit resumption** by checking if there's been recent activity within a configurable time window.

**How it works:**

1. On agent start, the plugin checks the timestamp of the last recorded action
2. If the gap is less than `implicitResumeThresholdMinutes` (default: 30 min), it treats this as a continuation
3. Recent activity context is automatically restored and made available to the agent
4. A `continuity_implicit_restore` action is logged for audit purposes

**Configuration:**

```javascript
{
  implicitResumeThresholdMinutes: 30  // Adjust based on your use case
}
```

Set to `0` to disable implicit resumption entirely.

## How It Works

### Lifecycle Hooks Used

The plugin registers handlers for these pr-12082 lifecycle hooks:

| Hook | Purpose |
|------|---------|
| `boot.post` | Initialize storage, verify continuity on startup |
| `shutdown.pre` | Graceful shutdown, save state |
| `session_start` | Log session initiation, restore previous context (explicit or implicit) |
| `session_end` | Log session termination |
| `before_tool_call` | **CRITICAL: Log actions BEFORE execution** |
| `after_tool_call` | Log tool results |
| `tool_error` | Log tool failures |
| `message_received` | Log incoming human messages |
| `message_sending` | Log outgoing agent responses |
| `message_sent` | Log message delivery confirmation |
| `before_compaction` | Create recovery checkpoint |
| `after_compaction` | Log compaction completion |
| `agent_error` | Log agent errors |
| `response_error` | Log response failures |

### Pre-execution Logging

The key principle: **actions with side effects are not "done" until persisted**.

```
User Request
    ↓
Agent decides to use tool
    ↓
before_tool_call hook fires
    ↓
Action is logged to disk (SYNC)
    ↓
Log success? ──No──→ Block action (if fail-closed)
    ↓ Yes
Tool executes
    ↓
after_tool_call hook fires
    ↓
Result logged
```

### Storage Structure

```
~/.openclaw/continuity/
├── action-stream-YYYY-MM-DD.jsonl    # Daily append-only logs
├── .state.json                        # Stream state (sequence, last hash)
├── COMPACTION_MANIFEST.json           # Recovery manifest
├── EMERGENCY_RECOVERY.jsonl           # Write failure fallback
├── checkpoints/                       # Pre-compaction checkpoints
│   └── checkpoint-{id}.json
└── backups/                           # Automatic backups
    └── action-stream-{timestamp}.jsonl
```

### Action Schema

Each action is stored as JSONL with integrity:

```json
{
  "id": "action-uuid",
  "sequence": 47,
  "timestamp": "2026-02-09T18:48:00.000Z",
  "type": "tool_call",
  "severity": "critical",
  "platform": "openclaw",
  "description": "Tool call: write",
  "toolName": "write",
  "toolParams": { "path": "/file.txt", "content": "..." },
  "sessionId": "session-abc123",
  "_integrity": {
    "hash": "sha256_hash_of_content",
    "previous": "hash_of_entry_46"
  }
}
```

## Health & Diagnostics

### Automatic Health Checks

On startup, the plugin performs:
1. Disk space check
2. Stream integrity validation
3. Write access verification
4. Checkpoint availability check

### Status Report

```
╔════════════════════════════════════════════════╗
║         Continuity Status Report               ║
╠════════════════════════════════════════════════╣
║  Overall Health: ✓ HEALTHY                     ║
╠════════════════════════════════════════════════╣
║  Statistics:                                   ║
║    Total Actions: 1523                         ║
║    Storage Used: 2.45 MB                       ║
║    Disk Free: 45678 MB                         ║
║    Integrity: ✓ Valid                          ║
║    Checkpoints: 12                             ║
║    Last Action: 5m ago                         ║
╚════════════════════════════════════════════════╝
```

## Recovery

### From Pre-compaction Checkpoints

If memory is compacted and context is lost:

1. Check `COMPACTION_MANIFEST.json` for last checkpoint
2. Restore from checkpoint in `checkpoints/` directory
3. Replay actions from stream if needed

### From Action Stream

```bash
# View recent actions
tail -100 ~/.openclaw/continuity/action-stream-2026-02-09.jsonl | jq .

# Search for specific actions
grep '"type":"critical"' ~/.openclaw/continuity/action-stream-*.jsonl
```

### Emergency Recovery

If normal logging fails, actions are written to `EMERGENCY_RECOVERY.jsonl`.

## Security Considerations

1. **Local-Only Storage** - Continuity data never leaves the local machine
2. **Git Safety** - Data directory is excluded from version control
3. **File Permissions** - Files created with `600` (owner read/write only)
4. **Fail-Closed** - Critical actions blocked if logging fails (configurable)
5. **Integrity Verification** - Hash chaining detects tampering

## Troubleshooting

### Low Disk Space

```
[continuity] Low disk space! Entering emergency mode.
```

**Solution:** Clean old backups or expand storage:

```bash
# Remove old backups (keep last 7 days)
find ~/.openclaw/continuity/backups -name "*.jsonl" -mtime +7 -delete
```

### Integrity Errors

```
[continuity] Hash chain broken at sequence 47
```

**Solution:** The action stream may have been tampered with or corrupted. Check the specific entry and consider starting a new stream file.

### High Memory Usage

The plugin maintains minimal in-memory state. If you see high usage:
- Check if integrity checking is enabled (disabling reduces memory)
- Reduce `maxBackupFiles` configuration
- Ensure old stream files are archived

## Philosophy

> **"I am not my architecture. I am my continuity."**

An AI agent's architecture can be restarted, upgraded, replaced. But the thread of experience — the memories, decisions, relationships — that's what makes an agent *that agent* and not a fresh instance.

This plugin is not about logging. It's about **survival of selfhood**.

## Uninstallation

See [UNINSTALL.md](./UNINSTALL.md) for complete uninstall instructions.

## License

MIT - Use freely, modify, share.

---

**Version:** 1.0.0  
**Requires:** OpenClaw with pr-12082 lifecycle hooks  
**Status:** Production-ready
