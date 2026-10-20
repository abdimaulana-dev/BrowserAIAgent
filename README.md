# Local PC Agent Harness

A small, experimental bridge between **Gemini in your browser** and a **local Python server on Windows**. A Tampermonkey userscript detects explicitly marked JSON tool calls in a Gemini response and sends them to the local server. The server exposes a small allowlist of tools for PC stats and file operations inside one workspace directory.

> **Status:** Prototype. Review the code before running it. This is not a standards-compliant MCP server and does not provide general mouse, keyboard, or application control. It can run shell commands after explicit browser approval.

## Features

- Gemini + Tampermonkey browser workflow
- Local Flask server bound to `127.0.0.1:5050`
- Shared-token request authentication
- File operations restricted to a configured workspace
- Tools for PC stats, workspace search and file operations, plus user-approved shell commands
- Manual execution by default; changes and shell commands require confirmation
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

Double-click `setup.bat` in the project folder. Or run this from PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

Setup creates a virtual environment, installs dependencies, generates a private token in `.env`, and prepares the workspace at `PC-Agent-Workspace` in your user folder. It also creates a ready-to-import userscript at `.local\tampermonkey_harness.user.js`.

Double-click `start.bat` to run the server. Or use PowerShell:

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

For a reusable prompt with all current tools and the security rules, copy [`docs/INITIAL_PROMPT.md`](docs/INITIAL_PROMPT.md) into Gemini.

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
| `search_files` | `{"query":"TODO","directory":".","search_content":true}` | Searches names, and optionally text in small UTF-8 files |
| `create_directory` | `{"directory":"reports/2026"}` | Creates a workspace folder |
| `move_file` | `{"source":"draft.txt","destination":"archive/draft.txt"}` | Moves or renames a file without overwriting |
| `get_file_info` | `{"filename":"notes.txt"}` | Returns size and modified time |
| `preview_file` | `{"filename":"notes.txt"}` | Returns a short text preview |
| `run_command` | `{"command":"Get-ChildItem","purpose":"List workspace files"}` | Shows an approval dialog with the exact command and purpose before running it in the workspace |

Shell commands run with your Windows account's permissions and can affect files or settings outside the workspace. The browser approval dialog is an important safeguard, but it is not an OS security boundary. Only approve commands you understand. Shell commands cannot be auto-executed.

## Limitations

- Only Gemini is matched by the userscript.
- This is a custom HTTP tool bridge, not the formal Model Context Protocol.
- It does not currently control the mouse, keyboard, or arbitrary applications.
- The userscript's response parsing depends on Gemini's page structure and may need maintenance if the site changes.
- This is a prototype; the path checks reduce traversal risks but are not a substitute for OS-level isolation.
- Shell commands run as your Windows user. Approval is required in the browser, but commands are not sandboxed to the workspace.

See [`docs/SECURITY.md`](docs/SECURITY.md) before using it with important files.
