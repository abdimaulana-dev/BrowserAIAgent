# Local PC Agent Harness

A small, experimental bridge between **Gemini in your browser** and a **local Python server on Windows**. A Tampermonkey userscript detects explicitly marked JSON tool calls in a Gemini response and sends them to the local server. The server exposes a small allowlist of tools for PC stats and file operations inside one workspace directory.

> **Status:** Prototype. Review the code before running it. This is not a standards-compliant MCP server, and it does not provide general mouse, keyboard, shell, or application control.

## Features

- Gemini + Tampermonkey browser workflow
- Local Flask server bound to `127.0.0.1:5050`
- Shared-token request authentication
- File operations restricted to a configured workspace
- Tools: `get_pc_stats`, `list_files`, `read_file`, `write_file`
- Manual execution by default; writes require confirmation
- Optional auto-execution for read-only tools

## Project layout

```text
local-pc-agent-harness/
├── server/
│   └── harness_server.py
├── userscript/
│   └── tampermonkey_harness.user.js
├── setup.ps1
├── start.ps1
├── docs/
│   └── SECURITY.md
├── requirements.txt
├── .gitignore
└── README.md
```

## Requirements

- Windows with Python 3.10+ (newer versions may work; not all have been tested)
- Google Chrome or another browser supported by Tampermonkey
- Tampermonkey extension
- Gemini at `https://gemini.google.com/`

## 1. Set up and start the server

Open PowerShell in the project folder and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

Setup creates a virtual environment, installs dependencies, generates a private token in `.env`, and prepares the workspace at `PC-Agent-Workspace` in your user folder. It also creates a ready-to-import userscript at `.local\tampermonkey_harness.user.js`.

Start the server with:

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```

Keep the PowerShell window open while using the bridge. To choose another workspace, edit `PC_AGENT_WORKSPACE` in `.env`, then run setup again. Use a dedicated test folder; avoid folders containing secrets or important files.

## 2. Install the Tampermonkey userscript

1. Open Tampermonkey and choose **Create a new script**.
2. Open `.local\tampermonkey_harness.user.js`, copy its contents into the editor, and save.
3. Reload Gemini. Leave **Auto-execute read-only tools** and **Auto-send reply in chat** disabled for initial tests.

The generated script contains the same token as `.env`. Both files are ignored by Git. Keep them private; this token is a basic local guard rather than a strong security boundary against other software running as your Windows user.

## 3. Test the connection

Open `http://127.0.0.1:5050/health` in your browser. Expected response:

```json
{"status":"ok"}
```

Then use Gemini to produce a tool call in this format. The word `exect` must appear immediately after the closing code fence:

```json
{
  "mcp_call": true,
  "tool": "get_pc_stats",
  "args": {}
}
```
exect

Click **Execute Last JSON Tool** in the userscript panel. The result should be inserted into the Gemini composer for you to review. Send it manually unless you intentionally enabled auto-send.

For file listing, use:

```json
{
  "mcp_call": true,
  "tool": "list_files",
  "args": {"directory": "."}
}
```
exect

For `read_file`, `filename` must be a path relative to the workspace. For `write_file`, use a harmless test filename first. The script asks for confirmation before writing.

## Available tools

| Tool | Arguments | Purpose |
|---|---|---|
| `get_pc_stats` | `{}` | Returns OS name, CPU and RAM utilization, and workspace path |
| `list_files` | `{"directory":"."}` | Lists entries within the workspace |
| `read_file` | `{"filename":"notes.txt"}` | Reads a UTF-8 text file, up to the configured limit |
| `write_file` | `{"filename":"test.txt","content":"hello"}` | Writes UTF-8 text inside the workspace |

## Limitations

- Only Gemini is matched by the userscript.
- This is a custom HTTP tool bridge, not the formal Model Context Protocol.
- It does not currently control the mouse, keyboard, shell, or arbitrary applications.
- The userscript's response parsing depends on Gemini's page structure and may need maintenance if the site changes.
- This is a prototype; the path checks reduce traversal risks but are not a substitute for OS-level isolation.

See [`docs/SECURITY.md`](docs/SECURITY.md) before using it with important files.
