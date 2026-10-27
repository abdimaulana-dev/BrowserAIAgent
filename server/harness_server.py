"""
Local browser-to-PC tool server.

Security notes:
- Bind only to 127.0.0.1.
- Set MCP_AUTH_TOKEN in the environment and use the same token in Tampermonkey.
- File access is limited to PC_AGENT_WORKSPACE.
- This is a custom HTTP tool bridge, not a standards-based MCP protocol server.
"""
import hmac
import logging
import os
import platform
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

import psutil
from flask import Flask, jsonify, request

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024  # Limit request bodies to 2 MiB

DEFAULT_WORKSPACE = Path.home() / "PC-Agent-Workspace"
WORKSPACE_DIR = Path(
    os.environ.get("PC_AGENT_WORKSPACE", str(DEFAULT_WORKSPACE))
).expanduser().resolve()

MAX_READ_BYTES = 1_000_000
MAX_WRITE_BYTES = 1_000_000
MAX_LIST_ENTRIES = 500
MAX_SEARCH_FILES = 2000
MAX_SEARCH_MATCHES = 100
MAX_COMMAND_OUTPUT = 8000
MAX_COMMAND_WAIT_SECONDS = 300


def _auth_token() -> str:
    return os.environ.get("MCP_AUTH_TOKEN", "")


def _require_auth() -> bool:
    expected = _auth_token()
    supplied = request.headers.get("X-MCP-Token", "")
    # Fail closed when no token has been configured.
    return bool(expected) and bool(supplied) and hmac.compare_digest(supplied, expected)


@app.before_request
def authenticate_request():
    if request.endpoint == "health":
        # Health endpoint reveals no system or workspace information.
        return None
    if not _require_auth():
        return jsonify({
            "status": "error",
            "error": {
                "code": "UNAUTHORIZED",
                "message": "Missing or invalid local agent token."
            }
        }), 401
    return None


def safe_path(rel_path: str) -> Path:
    """Resolve a relative path and ensure it remains inside the workspace."""
    if not isinstance(rel_path, str) or not rel_path.strip():
        raise ValueError("A non-empty relative path is required.")

    supplied = Path(rel_path)
    if supplied.is_absolute():
        raise PermissionError("Absolute paths are not allowed.")

    # Resolve existing symlinks and normalize '..' before checking containment.
    target = (WORKSPACE_DIR / supplied).resolve()
    try:
        target.relative_to(WORKSPACE_DIR)
    except ValueError:
        raise PermissionError("Access outside the workspace is blocked.") from None

    return target


def _require_object_args(args: Any) -> dict:
    if not isinstance(args, dict):
        raise ValueError("'args' must be a JSON object.")
    return args


def tool_get_pc_stats(args: dict) -> dict:
    return {
        "os": platform.platform(),
        "cpu_percent": psutil.cpu_percent(interval=0.2),
        "ram_percent": psutil.virtual_memory().percent,
        "workspace": str(WORKSPACE_DIR),
    }


def tool_list_files(args: dict) -> dict:
    directory = args.get("directory", ".")
    target = safe_path(directory)
    if not target.is_dir():
        raise ValueError("Directory does not exist.")

    entries = []
    for item in sorted(target.iterdir(), key=lambda p: p.name.casefold())[:MAX_LIST_ENTRIES]:
        # Do not follow an entry symlink outside the workspace.
        try:
            resolved = item.resolve()
            resolved.relative_to(WORKSPACE_DIR)
            allowed = True
        except (OSError, ValueError):
            allowed = False

        entries.append({
            "name": item.name,
            "is_directory": item.is_dir() if allowed else False,
            "is_file": item.is_file() if allowed else False,
            "blocked_link": not allowed,
        })

    return {
        "directory": str(target.relative_to(WORKSPACE_DIR)) or ".",
        "entries": entries,
        "truncated": len(entries) == MAX_LIST_ENTRIES,
    }


def tool_read_file(args: dict) -> dict:
    filename = args.get("filename")
    target = safe_path(filename)

    if not target.is_file():
        raise FileNotFoundError("File not found.")
    if target.stat().st_size > MAX_READ_BYTES:
        raise ValueError(f"File exceeds the {MAX_READ_BYTES}-byte read limit.")

    # Resolve again immediately before opening; this reduces (but does not fully
    # eliminate) filesystem race risks on a concurrently modified workspace.
    target = target.resolve()
    try:
        target.relative_to(WORKSPACE_DIR)
    except ValueError:
        raise PermissionError("Access outside the workspace is blocked.") from None

    with target.open("r", encoding="utf-8") as file:
        content = file.read(4000)

    return {
        "filename": str(target.relative_to(WORKSPACE_DIR)),
        "content": content,
        "truncated": target.stat().st_size > len(content.encode("utf-8")),
    }


def tool_write_file(args: dict) -> dict:
    filename = args.get("filename")
    content = args.get("content", "")

    if not isinstance(content, str):
        raise ValueError("'content' must be a string.")
    content_bytes = content.encode("utf-8")
    if len(content_bytes) > MAX_WRITE_BYTES:
        raise ValueError(f"Content exceeds the {MAX_WRITE_BYTES}-byte write limit.")

    target = safe_path(filename)
    target.parent.mkdir(parents=True, exist_ok=True)

    # Re-check after creating parents. Atomic replace avoids leaving a partially
    # written file if the process is interrupted during the write.
    parent = target.parent.resolve()
    try:
        parent.relative_to(WORKSPACE_DIR)
    except ValueError:
        raise PermissionError("Access outside the workspace is blocked.") from None

    target = parent / target.name
    if target.exists() and target.is_dir():
        raise ValueError("Target path is a directory.")

    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=str(parent),
            prefix=".pc-agent-",
            suffix=".tmp",
            delete=False,
        ) as temp_file:
            temp_name = temp_file.name
            temp_file.write(content_bytes)
            temp_file.flush()
            os.fsync(temp_file.fileno())

        Path(temp_name).replace(target)
    finally:
        if temp_name and os.path.exists(temp_name):
            try:
                os.remove(temp_name)
            except OSError:
                pass

    return {
        "success": True,
        "filename": str(target.relative_to(WORKSPACE_DIR)),
        "bytes_written": len(content_bytes),
    }


def tool_edit_file(args: dict) -> dict:
    filename = args.get("filename")
    old_text = args.get("old_text")
    new_text = args.get("new_text")
    if not isinstance(old_text, str) or not old_text:
        raise ValueError("'old_text' must be a non-empty string.")
    if not isinstance(new_text, str):
        raise ValueError("'new_text' must be a string.")

    target = safe_path(filename)
    if not target.is_file():
        raise FileNotFoundError("File not found.")
    if target.stat().st_size > MAX_READ_BYTES:
        raise ValueError(f"File exceeds the {MAX_READ_BYTES}-byte edit limit.")

    target = target.resolve()
    try:
        target.relative_to(WORKSPACE_DIR)
    except ValueError:
        raise PermissionError("Access outside the workspace is blocked.") from None

    try:
        with target.open("rb") as file:
            original_bytes = file.read(MAX_READ_BYTES + 1)
        if len(original_bytes) > MAX_READ_BYTES:
            raise ValueError(f"File exceeds the {MAX_READ_BYTES}-byte edit limit.")
        original = original_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("Only UTF-8 text files can be edited.") from exc

    occurrences = original.count(old_text)
    if occurrences != 1:
        raise ValueError(f"'old_text' must match exactly once; found {occurrences} matches. No changes were made.")

    result = tool_write_file({"filename": filename, "content": original.replace(old_text, new_text, 1)})
    result["replacements"] = 1
    return result


def tool_search_files(args: dict) -> dict:
    query = args.get("query")
    directory = args.get("directory", ".")
    search_content = args.get("search_content", False)
    if not isinstance(query, str) or not query:
        raise ValueError("'query' must be a non-empty string.")
    if len(query) > 500:
        raise ValueError("'query' must be 500 characters or fewer.")
    if not isinstance(directory, str) or not isinstance(search_content, bool):
        raise ValueError("'directory' must be text and 'search_content' must be a boolean.")
    root = safe_path(directory)
    if not root.is_dir():
        raise ValueError("Directory does not exist.")

    matches = []
    scanned = 0
    truncated = False
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if (Path(current) / name).resolve().is_relative_to(WORKSPACE_DIR)]
        for name in files:
            path = Path(current) / name
            try:
                path.resolve().relative_to(WORKSPACE_DIR)
            except (OSError, ValueError):
                continue
            scanned += 1
            if scanned > MAX_SEARCH_FILES:
                truncated = True
                break
            rel = str(path.relative_to(WORKSPACE_DIR))
            matched = query.casefold() in name.casefold()
            excerpt = None
            if search_content and not matched:
                try:
                    if path.stat().st_size <= MAX_READ_BYTES:
                        content = path.read_text(encoding="utf-8")
                        index = content.casefold().find(query.casefold())
                        if index >= 0:
                            excerpt = content[max(0, index - 80):index + len(query) + 160]
                            matched = True
                except (OSError, UnicodeError):
                    pass
            if matched:
                matches.append({"filename": rel, "excerpt": excerpt})
                if len(matches) >= MAX_SEARCH_MATCHES:
                    truncated = True
                    break
        if truncated:
            break
    return {"query": query, "matches": matches, "truncated": truncated}


def tool_create_directory(args: dict) -> dict:
    directory = args.get("directory")
    target = safe_path(directory)
    target.mkdir(parents=True, exist_ok=True)
    return {"success": True, "directory": str(target.relative_to(WORKSPACE_DIR)) or "."}


def tool_move_file(args: dict) -> dict:
    source = safe_path(args.get("source"))
    destination = safe_path(args.get("destination"))
    if not source.is_file():
        raise FileNotFoundError("File not found.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Resolve again after creating the parent to keep destination inside workspace.
    parent = destination.parent.resolve()
    try:
        parent.relative_to(WORKSPACE_DIR)
        source.resolve().relative_to(WORKSPACE_DIR)
    except ValueError:
        raise PermissionError("Access outside the workspace is blocked.") from None
    destination = parent / destination.name
    if destination.exists():
        raise ValueError("Destination already exists; refusing to overwrite it.")
    source.replace(destination)
    return {"success": True, "source": str(source.relative_to(WORKSPACE_DIR)),
            "destination": str(destination.relative_to(WORKSPACE_DIR))}


def tool_get_file_info(args: dict) -> dict:
    target = safe_path(args.get("filename"))
    if not target.is_file():
        raise FileNotFoundError("File not found.")
    info = target.stat()
    return {"filename": str(target.relative_to(WORKSPACE_DIR)), "size_bytes": info.st_size,
            "modified": datetime.fromtimestamp(info.st_mtime).astimezone().isoformat()}


def tool_preview_file(args: dict) -> dict:
    target = safe_path(args.get("filename"))
    if not target.is_file():
        raise FileNotFoundError("File not found.")
    if target.stat().st_size > MAX_READ_BYTES:
        raise ValueError(f"File exceeds the {MAX_READ_BYTES}-byte preview limit.")
    with target.open("r", encoding="utf-8") as file:
        content = file.read(1000)
    return {"filename": str(target.relative_to(WORKSPACE_DIR)), "preview": content,
            "truncated": target.stat().st_size > len(content.encode("utf-8"))}


def tool_run_command(args: dict) -> dict:
    command = args.get("command")
    purpose = args.get("purpose")
    seconds = args.get("seconds", 15)
    wait_until_completed = args.get("wait_until_completed", False)
    if not isinstance(command, str) or not command.strip() or len(command) > 4000:
        raise ValueError("'command' must contain 1 to 4000 characters.")
    if not isinstance(purpose, str) or not purpose.strip() or len(purpose) > 500:
        raise ValueError("'purpose' must contain 1 to 500 characters.")
    if isinstance(seconds, bool) or not isinstance(seconds, int) or not 1 <= seconds <= MAX_COMMAND_WAIT_SECONDS:
        raise ValueError(f"'seconds' must be an integer from 1 to {MAX_COMMAND_WAIT_SECONDS}.")
    if not isinstance(wait_until_completed, bool):
        raise ValueError("'wait_until_completed' must be a boolean.")

    if not wait_until_completed:
        try:
            process = subprocess.Popen(command, shell=True, cwd=WORKSPACE_DIR,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL)
        except OSError as exc:
            raise ValueError(f"Could not start command: {exc}") from exc
        return {"started": True, "pid": process.pid, "waited": False,
                "purpose": purpose, "message": "Command started; completion and output were not awaited."}

    try:
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            completed = subprocess.run(command, shell=True, cwd=WORKSPACE_DIR, stdout=stdout,
                                       stderr=stderr, timeout=seconds)
            stdout.seek(0)
            stderr.seek(0)
            output = stdout.read(MAX_COMMAND_OUTPUT + 1)
            errors = stderr.read(MAX_COMMAND_OUTPUT + 1)
        return {"return_code": completed.returncode,
                "stdout": output[:MAX_COMMAND_OUTPUT].decode("utf-8", errors="replace"),
                "stderr": errors[:MAX_COMMAND_OUTPUT].decode("utf-8", errors="replace"),
                "output_truncated": len(output) > MAX_COMMAND_OUTPUT or len(errors) > MAX_COMMAND_OUTPUT,
                "purpose": purpose, "waited": True}
    except subprocess.TimeoutExpired as exc:
        raise ValueError(f"Command did not complete within the requested {seconds}-second wait.") from exc


TOOLS = {
    "get_pc_stats": (tool_get_pc_stats, set()),
    "list_files": (tool_list_files, {"directory"}),
    "read_file": (tool_read_file, {"filename"}),
    "write_file": (tool_write_file, {"filename", "content"}),
    "edit_file": (tool_edit_file, {"filename", "old_text", "new_text"}),
    "search_files": (tool_search_files, {"query", "directory", "search_content"}),
    "create_directory": (tool_create_directory, {"directory"}),
    "move_file": (tool_move_file, {"source", "destination"}),
    "get_file_info": (tool_get_file_info, {"filename"}),
    "preview_file": (tool_preview_file, {"filename"}),
    "run_command": (tool_run_command, {"command", "purpose", "seconds", "wait_until_completed"}),
}


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.post("/mcp")
def handle_mcp():
    if not request.is_json:
        return jsonify({
            "status": "error",
            "error": {"code": "INVALID_CONTENT_TYPE", "message": "Send application/json."}
        }), 415

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({
            "status": "error",
            "error": {"code": "INVALID_JSON", "message": "Request body must be a JSON object."}
        }), 400

    if data.get("mcp_call") is not True:
        return jsonify({
            "status": "error",
            "error": {"code": "INVALID_ENVELOPE", "message": "mcp_call must be true."}
        }), 400

    tool_name = data.get("tool")
    if not isinstance(tool_name, str) or tool_name not in TOOLS:
        return jsonify({
            "status": "error",
            "error": {"code": "UNKNOWN_TOOL", "message": "Unknown or unauthorized tool."}
        }), 400

    try:
        args = _require_object_args(data.get("args", {}))
        _, allowed_keys = TOOLS[tool_name]
        unknown_keys = set(args) - allowed_keys
        if unknown_keys:
            raise ValueError("Unexpected argument(s): " + ", ".join(sorted(unknown_keys)))

        # Do not log argument values: they can contain private file paths or content.
        print(f"[*] Tool request: {tool_name}")

        handler, _ = TOOLS[tool_name]
        result = handler(args)
        return jsonify({
            "tool": tool_name,
            "status": "success",
            "result": result,
        })
    except PermissionError as exc:
        return jsonify({
            "tool": tool_name,
            "status": "error",
            "error": {"code": "PERMISSION_DENIED", "message": str(exc)},
        }), 403
    except FileNotFoundError:
        return jsonify({
            "tool": tool_name,
            "status": "error",
            "error": {"code": "NOT_FOUND", "message": "File or directory not found."},
        }), 404
    except (ValueError, TypeError) as exc:
        return jsonify({
            "tool": tool_name,
            "status": "error",
            "error": {"code": "INVALID_ARGUMENT", "message": str(exc)},
        }), 400
    except OSError:
        app.logger.exception("Operating-system error while running tool %s", tool_name)
        return jsonify({
            "tool": tool_name,
            "status": "error",
            "error": {"code": "FILESYSTEM_ERROR", "message": "The filesystem operation failed."},
        }), 500
    except Exception:
        app.logger.exception("Unexpected error while running tool %s", tool_name)
        return jsonify({
            "tool": tool_name,
            "status": "error",
            "error": {"code": "INTERNAL_ERROR", "message": "The tool failed unexpectedly."},
        }), 500


@app.errorhandler(413)
def request_too_large(_error):
    return jsonify({
        "status": "error",
        "error": {"code": "REQUEST_TOO_LARGE", "message": "Request body exceeds 2 MiB."}
    }), 413


if __name__ == "__main__":
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
    if not _auth_token():
        raise SystemExit(
            "MCP_AUTH_TOKEN is not set. Set it in PowerShell before starting the server."
        )
    print("[*] Local PC Agent running on http://127.0.0.1:5050")
    print(f"[*] Workspace: {WORKSPACE_DIR}")
    print("[*] Authentication: enabled; keep the token private.")
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    app.run(host="127.0.0.1", port=5050, debug=False, threaded=True)
