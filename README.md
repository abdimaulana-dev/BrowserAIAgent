# Local PC Agent Harness

A small, experimental bridge between **Gemini in your browser** and a **local Python server on Windows**. A Tampermonkey userscript detects explicitly marked JSON tool calls in a Gemini response and sends them to the local server. The server exposes a small allowlist of tools for PC stats and file operations inside one workspace directory.

> **Status:** Prototype. Review the code before running it. This is not a standards-compliant MCP server and does not provide general mouse, keyboard, or application control. It can run shell commands after explicit browser approval.

## Versioning

The current version is `2.0.0`. Version numbers use `MAJOR.FEATURE.FIX`; the first version under this scheme was `1.1.1`. A new major series starts at `.0.0`. For follow-up changes, increment `FIX` for bug fixes and small corrections; after `.100`, roll over to the next `FEATURE` and reset `FIX` to 1. Increment `FEATURE` for a new capability and reset `FIX` to 1. Increment `MAJOR` for a major change and reset both lower numbers to 0. For example, `1.4.100` becomes `1.5.1` for the next fix, and this major release starts at `2.0.0`.

## Features

- Gemini + Tampermonkey browser workflow
- Local Flask server bound to `127.0.0.1:5050`
- Shared-token request authentication
- File operations restricted to a configured workspace
- Tools for PC stats, workspace search and file operations, plus user-approved shell commands
- Manual execution by default; shell commands show a review dialog before running
- Optional auto-execution for read-only tools
- Optional Bridge Desk chat app with a background Gemini browser and persistent conversations

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
3. Reload Gemini. **Auto-execute tools (confirm shell)** is off by default. When enabled, valid calls run after their `exect` marker, including file changes. Shell commands always open an approval dialog and run only after you accept. With auto-execute off, file changes require **Execute Last JSON Tool**. **Auto-send reply in chat** controls ordinary tool replies; approved shell commands send one final result to Gemini after the server responds.

The generated script contains the same token as `.env`. Both files are ignored by Git. Keep them private; this token is a basic local guard rather than a strong security boundary against other software running as your Windows user.

## 3. Test the connection

For a reusable prompt with all current tools and the security rules, open [`docs/INITIAL_PROMPT.md`](docs/INITIAL_PROMPT.md) and use the code block's copy button to copy the full prompt into Gemini.

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

For `read_file`, `filename` must be a path relative to the workspace. With auto-execute off, tool calls that change files run only when you click **Execute Last JSON Tool**. A valid `run_command` call with its `exect` marker opens the shell approval dialog when auto-execute is off.

## Optional: Bridge Desk chat app

Bridge Desk provides a separate local chat window that talks to Gemini through a dedicated Chrome profile and connects to this repo's local server. It uses the signed-in Gemini webpage, so no Gemini API key is needed.

1. In a second PowerShell window, enter `desktop-app` and install its requirements with `pip install -r requirements.txt`.
2. Copy `.env.example` to `.env` and set `MCP_AUTH_TOKEN` to the token from the repo-root `.env`.
3. Run `python app.py --login`, sign in to Gemini in the regular Chrome window, close it, then press Enter.
4. Run `python app.py` and open `http://127.0.0.1:5100`.

Bridge Desk saves chat state locally in ignored files. File changes and shell commands require approval. See [`desktop-app/README.md`](desktop-app/README.md) for setup details and known limitations.

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
