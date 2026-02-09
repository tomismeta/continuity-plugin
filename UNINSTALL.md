# Uninstalling the Continuity Plugin

This document provides complete instructions for uninstalling the Continuity plugin from OpenClaw.

## Quick Uninstall

```bash
# 1. Disable the plugin
openclaw plugins disable continuity

# 2. Remove the plugin directory (if installed from path)
rm -rf ~/.openclaw/extensions/continuity

# 3. Remove plugin data (optional - see below)
rm -rf ~/.openclaw/continuity

# 4. Restart OpenClaw
openclaw gateway restart
```

## Step-by-Step Uninstall

### Step 1: Disable the Plugin

Disable the plugin in the OpenClaw configuration:

```bash
# Using CLI
openclaw plugins disable continuity

# Or manually edit ~/.openclaw/config.yaml and set:
# plugins:
#   entries:
#     continuity:
#       enabled: false
```

### Step 2: Remove Plugin Files

Delete the plugin directory (if you want complete removal):

```bash
# For path-linked plugins
rm -rf ~/.openclaw/extensions/continuity

# Or if you used --link during install, remove from the linked path
rm -rf /path/to/your/continuity-plugin
```

### Step 3: Remove Plugin Data (Optional)

**⚠️ WARNING: This will delete all logged actions and continuity history.**

If you want to keep your action history for future reference:

```bash
# Archive instead of delete
mv ~/.openclaw/continuity ~/archived-continuity-$(date +%Y%m%d)
```

If you want to completely remove all data:

```bash
# Remove all continuity data
rm -rf ~/.openclaw/continuity

# Or remove just the current logs, keeping backups
rm ~/.openclaw/continuity/action-stream-*.jsonl
rm ~/.openclaw/continuity/.state.json
rm ~/.openclaw/continuity/COMPACTION_MANIFEST.json
```

### Step 4: Verify Removal

```bash
# Check plugin list
openclaw plugins list

# Verify continuity shows as "disabled"
openclaw plugins info continuity
```

### Step 5: Restart OpenClaw

```bash
# Restart the gateway
openclaw gateway restart

# Or if using systemd
sudo systemctl restart openclaw
```

## Cleaning Up Git (if applicable)

If you accidentally committed continuity data to git:

```bash
# Add to .gitignore (if not already)
echo ".openclaw/continuity/" >> .gitignore
echo "action-stream*.jsonl" >> .gitignore

# Remove from git history (destructive - requires force push)
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch -r .openclaw/continuity/' HEAD

# Or use BFG Repo-Cleaner (recommended for large repos)
bfg --delete-folders .openclaw/continuity
```

## Data Retention Options

### Option A: Full Removal (No History)

```bash
rm -rf ~/.openclaw/continuity
```

**Result:** All continuity data is permanently deleted.

### Option B: Archive History

```bash
# Create archive
mkdir -p ~/archives
tar czf ~/archives/continuity-$(date +%Y%m%d).tar.gz ~/.openclaw/continuity/

# Remove live data
rm -rf ~/.openclaw/continuity
```

**Result:** Compressed archive kept for records, live data removed.

### Option C: Export & Remove

```bash
# Export to searchable format
mkdir -p ~/exports
cat ~/.openclaw/continuity/action-stream-*.jsonl > ~/exports/continuity-export-$(date +%Y%m%d).jsonl

# Remove live data
rm -rf ~/.openclaw/continuity
```

**Result:** Single JSONL file with all actions, live data removed.

## Troubleshooting Uninstall

### "Plugin still showing as loaded"

```bash
# Check current status
openclaw plugins info continuity

# Ensure it's disabled
openclaw plugins disable continuity

# Clear plugin cache if needed
rm -rf ~/.openclaw/.plugin-cache/
```

### "Permission denied when removing files"

```bash
# Use sudo for extensions directory if needed
sudo rm -rf ~/.openclaw/extensions/continuity

# Fix permissions on user data
sudo chown -R $(whoami) ~/.openclaw/continuity
rm -rf ~/.openclaw/continuity
```

### "OpenClaw won't start after uninstall"

Check for configuration references:

```bash
# View current config
openclaw gateway config.get | grep -A5 continuity

# Or manually edit ~/.openclaw/config.yaml and remove the continuity entry under plugins.entries
```

## Reinstalling Later

If you want to reinstall the continuity plugin later:

```bash
# 1. Install the plugin from the directory
openclaw plugins install /path/to/continuity-plugin

# 2. Enable the plugin (it should auto-enable, but just in case)
openclaw plugins enable continuity

# 3. If you have archived data, restore it
mkdir -p ~/.openclaw/continuity
tar xzf ~/archives/continuity-YYYYMMDD.tar.gz -C ~/.openclaw/

# 4. Restart
openclaw gateway restart
```

## Questions?

- Review the [README.md](./README.md) for more information
- Check OpenClaw plugin documentation
- Open an issue on the continuity plugin repository

---

**Note:** Uninstalling the plugin does not affect OpenClaw's core functionality. The system will continue to operate normally without continuity logging.
