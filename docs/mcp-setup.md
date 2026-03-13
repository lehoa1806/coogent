# MCP Setup Guide

> How external AI tools (Antigravity IDE, Cursor, Claude Desktop) connect to the Coogent MCP server.

---

## Automatic Setup

When the Coogent extension activates, it automatically:

1. **Deploys** the MCP stdio server to a well-known global directory:
   - **macOS**: `~/Library/Application Support/Antigravity/coogent/mcp/`
   - **Windows**: `%APPDATA%/Antigravity/coogent/mcp/`
   - **Linux**: `~/.config/antigravity/coogent/mcp/`

2. **Writes** the MCP configuration file that external tools read:
   - **Path**: `~/.gemini/antigravity/mcp_config.json`

This should work out-of-the-box — no manual steps needed.

---

## Manual Setup (Fallback)

If the MCP connection isn't working automatically, you can manually create/edit the config file.

### 1. Locate or Create the Config File

```
~/.gemini/antigravity/mcp_config.json
```

Create the directory if it doesn't exist:

```bash
mkdir -p ~/.gemini/antigravity
```

### 2. Add the Configuration

Replace `<WORKSPACE_PATH>` with the absolute path to your project:

```json
{
    "mcpServers": {
        "coogent": {
            "command": "node",
            "args": [
                "~/Library/Application Support/Antigravity/coogent/mcp/stdio-server.js",
                "--workspace",
                "<WORKSPACE_PATH>"
            ]
        }
    }
}
```

#### Platform-Specific Server Paths

| Platform | Server Path |
|----------|------------|
| macOS    | `~/Library/Application Support/Antigravity/coogent/mcp/stdio-server.js` |
| Windows  | `%APPDATA%/Antigravity/coogent/mcp/stdio-server.js` |
| Linux    | `~/.config/antigravity/coogent/mcp/stdio-server.js` |

> [!IMPORTANT]
> Use **absolute paths** (not `~`) in the actual config file. For example:
> `/Users/yourname/Library/Application Support/Antigravity/coogent/mcp/stdio-server.js`

### 3. Verify

Reload VS Code (`Developer: Reload Window`). The MCP server should now be discovered by external AI tools.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "MCP server coogent not found" | Ensure `mcp_config.json` exists with the correct server path |
| "Cannot find module" | Verify the `stdio-server.js` path exists on disk |
| Config gets overwritten | The extension merges (not overwrites) — other server entries are preserved |
