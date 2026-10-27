# Local PC Agent Harness

A small, experimental local PC agent for Windows. **Bridge Desk is the main interface**: it gives you a clean chat window, uses your signed-in Gemini webpage in a background Chrome profile, and connects to the local Python bridge. The Tampermonkey flow remains available as an alternate interface.

> **Status:** Prototype. Review the code before running it. This is not a standards-compliant MCP server and does not provide general mouse, keyboard, or application control. It can run shell commands after explicit browser approval.

## Versioning

The current version is `2.2.5`. Version numbers use `MAJOR.FEATURE.FIX`; the first version under this scheme was `1.1.1`. A new major series starts at `.0.0`. For follow-up changes, increment `FIX` for bug fixes and small corrections; after `.100`, roll over to the next `FEATURE` and reset `FIX` to 1. Increment `FEATURE` for a new capability and reset `FIX` to 1. Increment `MAJOR` for a major change and reset both lower numbers to 0. For example, `1.4.100` becomes `1.5.1` for the next fix, the desktop-first setup was `2.1.1`, app-only chat deletion was `2.2.1`, launcher paths with spaces were fixed in `2.2.2`, Gemini rendered tool-call text support was added in `2.2.3`, Gemini composer submission and the foreground command-window launcher were improved in `2.2.4`, and `2.2.5` quiets routine local web requests in the command window; the next major series starts at `3.0.0`.

## Features

- Bridge Desk chat app with saved conversations and a background Gemini browser
- Local Flask server bound to `127.0.0.1:5050`
- Shared-token request authentication
- File operations restricted to a configured workspace
- Tools for PC stats, workspace search and file operations, plus user-approved shell commands
- File changes and shell commands require approval in Bridge Desk
- Optional Tampermonkey workflow for using Gemini directly in a browser
- Delete saved chats from Bridge Desk; Gemini chat history is not deleted

## Project layout

```text
local-pc-agent-harness/
├── server/
│   └── harness_server.py
├── desktop-app/
│   ├── app.py
│   ├── initial_prompt.md
│   ├── static/
│   └── templates/
├── userscript/
│   └── tampermonkey_harness.user.js
├── setup.bat
├── setup.ps1
├── login.bat
├── start.bat
├── start.ps1
├── stop.bat
├── stop.ps1
├── stop.bat
├── docs/
│   └── SECURITY.md
├── requirements.txt
├── .gitignore
└── README.md
```

## Requirements

- Windows with Python 3.10+ (newer versions may work; not all have been tested)
- Google Chrome
- Gemini at `https://gemini.google.com/`

## Quick start: Bridge Desk

1. Double-click `setup.bat`. It installs the bridge and app dependencies, creates the local token and workspace, and opens a regular Chrome window for Gemini sign-in on first setup.
2. Sign in to Gemini in that window, close it, and press Enter in the setup window.
3. Double-click `start.bat`. It starts the local bridge and chat app in the same command window, then opens Bridge Desk in your browser at `http://127.0.0.1:5100`. Keep that window open while using the app; closing it stops both services.
4. When finished, close the command window or double-click `stop.bat` to stop Bridge Desk and the local bridge.

If Gemini needs sign-in again, double-click `login.bat`. Startup errors appear in the command window.

Setup is safe to rerun. It reuses the existing workspace and token and refreshes the desktop app's private configuration.

## Optional: use Gemini directly with Tampermonkey

Bridge Desk setup also prepares `.local\tampermonkey_harness.user.js` for the alternate browser workflow:

1. Open Tampermonkey and choose **Create a new script**.
2. Import or paste `.local\tampermonkey_harness.user.js` and save it.
3. Start only the bridge with `powershell -ExecutionPolicy Bypass -File .\start.ps1 -BridgeOnly`, then reload Gemini.

This workflow uses the same private token in `.env` and the generated userscript. Both files are ignored by Git. Keep them private; the token is a basic local guard, not a security boundary against other software running as your Windows user.

## Check the bridge connection

With Bridge Desk running, open `http://127.0.0.1:5050/health`. Expected response:

```json
{"status":"ok"}
```

For the Tampermonkey workflow, the reusable prompt is in [`docs/INITIAL_PROMPT.md`](docs/INITIAL_PROMPT.md). A tool call uses this format, with `exect` immediately after the JSON code fence:

```json
{
  "mcp_call": true,
  "tool": "get_pc_stats",
  "args": {}
}
```
exect

In Tampermonkey, click **Execute Last JSON Tool** to run the call. The result is inserted into Gemini for review; send it manually unless you enable auto-send.

For file listing, use:

```json
{
  "mcp_call": true,
  "tool": "list_files",
  "args": {"directory": "."}
}
```
exect

For `read_file`, `filename` must be a path relative to the workspace. With auto-execute off, tool calls that change files run only when you click **Execute Last JSON Tool**. A valid `run_command` call with its `exect` marker opens the shell approval dialog when auto-execute is off.

## Available tools

| Tool | Arguments | Purpose |
|---|---|---|
| `get_pc_stats` | `{}` | Returns OS name, CPU and RAM utilization, and workspace path |
| `list_files` | `{"directory":"."}` | Lists entries within the workspace |
| `read_file` | `{"filename":"notes.txt"}` | Reads a UTF-8 text file, up to the configured limit |
| `write_file` | `{"filename":"test.txt","content":"hello"}` | Writes UTF-8 text inside the workspace |
| `edit_file` | `{"filename":"app.py","old_text":"old line","new_text":"new line"}` | Replaces one unique exact text match in a UTF-8 text file |
| `search_files` | `{"query":"TODO","directory":".","search_content":true}` | Searches names, and optionally text in small UTF-8 files |
| `create_directory` | `{"directory":"reports/2026"}` | Creates a workspace folder |
| `move_file` | `{"source":"draft.txt","destination":"archive/draft.txt"}` | Moves or renames a file without overwriting |
| `get_file_info` | `{"filename":"notes.txt"}` | Returns size and modified time |
| `preview_file` | `{"filename":"notes.txt"}` | Returns a short text preview |
| `run_command` | `{"command":"Get-ChildItem","purpose":"List workspace files","seconds":15,"wait_until_completed":true}` | Always opens an approval dialog. `seconds` defaults to 15 (maximum 300). `wait_until_completed` defaults to false (returns PID after launch); set true to wait up to `seconds` and receive output |

Shell commands run using your Windows account's permissions and can affect files or settings outside the workspace. They always require approval in the browser, even when auto-execute is on.

## Limitations

- Only Gemini is matched by the userscript.
- This is a custom HTTP tool bridge, not the formal Model Context Protocol.
- It does not currently control the mouse, keyboard, or arbitrary applications.
- The userscript's response parsing depends on Gemini's page structure and may need maintenance if the site changes.
- This is a prototype; the path checks reduce traversal risks but are not a substitute for OS-level isolation.
- Shell commands run as your Windows user. Approval is required in the browser, but commands are not sandboxed to the workspace.

See [`docs/SECURITY.md`](docs/SECURITY.md) before using it with important files.
