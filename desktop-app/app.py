from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from flask import Flask, jsonify, render_template, request

ROOT = Path(__file__).resolve().parent
APP_VERSION = "2.2.2"


def load_env_file():
    env_path = ROOT / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_env_file()

BRIDGE_URL = os.getenv("BRIDGE_URL", "http://127.0.0.1:5050/mcp")
BRIDGE_TOKEN = os.getenv("MCP_AUTH_TOKEN", "")
PROFILE_DIR = Path(os.getenv("GEMINI_PROFILE_DIR", str(ROOT / ".gemini-profile"))).expanduser()
HISTORY_PATH = ROOT / "chat-history.json"
CHAT_STATE_PATH = ROOT / "chat-state.json"
CHATS_PATH = ROOT / "chats.json"
HEADLESS = os.getenv("GEMINI_HEADLESS", "true").lower() not in {"0", "false", "no"}
PORT = int(os.getenv("APP_PORT", "5100"))

app = Flask(__name__)
jobs: queue.Queue = queue.Queue()
try:
    saved_events = json.loads(HISTORY_PATH.read_text(encoding="utf-8"))
    events = saved_events if isinstance(saved_events, list) and all(isinstance(item, dict) for item in saved_events) else []
except (OSError, json.JSONDecodeError):
    events = []
try:
    saved_chat_state = json.loads(CHAT_STATE_PATH.read_text(encoding="utf-8"))
    if not isinstance(saved_chat_state, dict):
        saved_chat_state = {}
except (OSError, json.JSONDecodeError):
    saved_chat_state = {}
chat_title = str(saved_chat_state.get("title") or "New chat")
chat_url = str(saved_chat_state.get("url") or "")
saved_chats = {}
try:
    saved_chats = json.loads(CHATS_PATH.read_text(encoding="utf-8"))
    chats = saved_chats.get("chats", []) if isinstance(saved_chats, dict) else []
    if not isinstance(chats, list):
        chats = []
except (OSError, json.JSONDecodeError):
    chats = []
if not chats:
    chats = [{"id": uuid.uuid4().hex, "title": chat_title, "url": chat_url, "events": events}]
active_chat_id = str(saved_chats.get("active_chat_id", "")) if isinstance(saved_chats, dict) else ""
if not any(chat.get("id") == active_chat_id for chat in chats):
    active_chat_id = chats[0]["id"]
active_chat = next(chat for chat in chats if chat["id"] == active_chat_id)
events = active_chat.setdefault("events", [])
chat_title = str(active_chat.get("title") or "New chat")
chat_url = str(active_chat.get("url") or "")
events_lock = threading.Lock()
pending_approvals = {}
pending_lock = threading.Lock()
busy_lock = threading.Lock()
busy = False

TOOL_KEYS = {
    "get_pc_stats": set(),
    "list_files": {"directory"},
    "read_file": {"filename"},
    "write_file": {"filename", "content"},
    "edit_file": {"filename", "old_text", "new_text"},
    "search_files": {"query", "directory", "search_content"},
    "create_directory": {"directory"},
    "move_file": {"source", "destination"},
    "get_file_info": {"filename"},
    "preview_file": {"filename"},
    "run_command": {"command", "purpose", "seconds", "wait_until_completed"},
}
REQUIRED_KEYS = {
    "read_file": {"filename"},
    "write_file": {"filename", "content"},
    "edit_file": {"filename", "old_text", "new_text"},
    "search_files": {"query"},
    "create_directory": {"directory"},
    "move_file": {"source", "destination"},
    "get_file_info": {"filename"},
    "preview_file": {"filename"},
    "run_command": {"command", "purpose"},
}
WRITE_TOOLS = {"write_file", "edit_file", "create_directory", "move_file", "run_command"}

SYSTEM_PROMPT = (ROOT / "initial_prompt.md").read_text(encoding="utf-8-sig").strip()


def publish(kind, content, **extra):
    with events_lock:
        event = {
            "id": len(events) + 1,
            "type": kind,
            "content": content,
            "time": time.strftime("%H:%M"),
            **extra,
        }
        events.append(event)
        if kind in {"user", "assistant", "tool_call", "tool_result"}:
            persist_chats()
        return event


def persist_chats():
    active_chat.update({"title": chat_title, "url": chat_url, "events": events})
    CHATS_PATH.write_text(
        json.dumps({"active_chat_id": active_chat_id, "chats": chats}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def save_chat_state():
    persist_chats()


def activate_chat(chat):
    global active_chat, active_chat_id, events, chat_title, chat_url
    active_chat = chat
    active_chat_id = chat["id"]
    events = chat.setdefault("events", [])
    chat_title = str(chat.get("title") or "New chat")
    chat_url = str(chat.get("url") or "")
    persist_chats()


def make_new_chat():
    return {"id": uuid.uuid4().hex, "title": "New chat", "url": "", "events": []}


def can_delete_active_chat():
    return len(chats) > 1 or any(event.get("type") == "user" for event in events)


def remove_local_chat(chat_id):
    chats[:] = [chat for chat in chats if chat.get("id") != chat_id]
    if not chats:
        chats.append(make_new_chat())
    activate_chat(chats[0])


def make_chat_title(text):
    title = " ".join(text.strip().split())
    return title[:47].rstrip() + ("…" if len(title) > 47 else "") or "New chat"


def tool_call_from(text):
    pattern = re.compile(r"(?is)\x60{3}\s*json\s*(.*?)\s*\x60{3}\s*exect\b")
    match = pattern.search(text)
    if not match:
        return None
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict) or payload.get("mcp_call") is not True:
        return None
    name, args = payload.get("tool"), payload.get("args")
    if name not in TOOL_KEYS or not isinstance(args, dict):
        return None
    if set(args) - TOOL_KEYS[name] or REQUIRED_KEYS.get(name, set()) - set(args):
        return None
    return {"mcp_call": True, "tool": name, "args": args}


def wait_for_approval(name, args):
    approval_id = uuid.uuid4().hex
    decision = queue.Queue(maxsize=1)
    with pending_lock:
        pending_approvals[approval_id] = decision
    publish("approval", json.dumps(args, indent=2, ensure_ascii=False), approval_id=approval_id, tool=name)
    try:
        approved = decision.get(timeout=300)
    except queue.Empty:
        return False, "Approval expired; the tool was not run."
    finally:
        with pending_lock:
            pending_approvals.pop(approval_id, None)
    return approved, "Approved by user." if approved else "Rejected by user; the tool was not run."


def execute_tool(payload):
    name, args = payload["tool"], payload["args"]
    publish("tool_call", json.dumps(payload, indent=2, ensure_ascii=False), tool=name)
    if name in WRITE_TOOLS:
        approved, message = wait_for_approval(name, args)
        if not approved:
            result = {"tool": name, "status": "error", "error": {"code": "USER_REJECTED", "message": message}}
            publish("tool_result", json.dumps(result, indent=2, ensure_ascii=False), tool=name)
            return result
    if not BRIDGE_TOKEN:
        result = {"tool": name, "status": "error", "error": {"code": "MISSING_TOKEN", "message": "Set MCP_AUTH_TOKEN in the prototype .env file."}}
    else:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            BRIDGE_URL,
            data=body,
            headers={"Content-Type": "application/json", "X-MCP-Token": BRIDGE_TOKEN},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=315) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            try:
                result = json.loads(exc.read().decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                result = {"tool": name, "status": "error", "error": {"code": "BRIDGE_ERROR", "message": f"Bridge returned HTTP {exc.code}."}}
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            result = {"tool": name, "status": "error", "error": {"code": "BRIDGE_UNAVAILABLE", "message": str(exc)}}
    publish("tool_result", json.dumps(result, indent=2, ensure_ascii=False), tool=name)
    return result


def response_texts(page):
    return page.evaluate("""() => {
      const primary = Array.from(document.querySelectorAll('model-response'))
        .map(node => (node.innerText || node.textContent || '').trim()).filter(Boolean);
      if (primary.length) return primary;
      return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'))
        .map(node => (node.innerText || node.textContent || '').trim()).filter(Boolean);
    }""")


def send_to_gemini(page, prompt):
    composer_selectors = [
        'rich-textarea [contenteditable="true"]',
        'rich-textarea [role="textbox"]',
        'div[contenteditable="true"]',
        '[role="textbox"]',
        'textarea[aria-label*="message" i]',
        'textarea[aria-label*="prompt" i]',
        "textarea",
    ]
    composer = None
    for selector in composer_selectors:
        candidate = page.locator(selector).last
        try:
            if candidate.count() and candidate.is_visible():
                composer = candidate
                break
        except Exception:
            continue
    if composer is None:
        try:
            details = page.evaluate("""() => {
              const text = (document.body?.innerText || '').toLowerCase();
              return {
                title: document.title,
                signIn: /sign in|log in/.test(text),
                verification: /verify it's you|verify your identity|captcha/.test(text)
              };
            }""")
            title = details.get("title") or "(no title)"
            state = "sign-in page" if details.get("signIn") else "verification page" if details.get("verification") else "unrecognized page"
        except Exception:
            title, state = "(no title)", "unrecognized page"
        raise RuntimeError(
            f"Gemini message box was not found ({state}; page title: {title}). "
            "If this is a sign-in or verification page, finish it in the dedicated Chrome profile with `python app.py --login`, close that window, and restart the app. Otherwise Gemini may have changed its page layout."
        )

    before = len(response_texts(page))
    composer.fill(prompt, timeout=20000)
    send_button = page.locator(
        'button[aria-label*="send" i]:not([aria-label*="stop" i]), '
        'button[data-tooltip*="send" i]:not([data-tooltip*="stop" i])'
    ).last
    if send_button.count() and send_button.is_visible() and send_button.is_enabled():
        # Never retry with Enter after a click error: the click may already have
        # submitted the message before Playwright reported a timeout.
        send_button.click(timeout=10000)
    else:
        composer.press("Enter")

    deadline = time.monotonic() + 240
    last_text = ""
    stable_since = None
    while time.monotonic() < deadline:
        page.wait_for_timeout(500)
        texts = response_texts(page)
        if len(texts) > before and texts[-1]:
            current = texts[-1]
            stop_visible = page.evaluate("""() => Array.from(document.querySelectorAll('button'))
              .some(button => button.getClientRects().length && /stop|cancel/i.test(
                (button.getAttribute('aria-label') || '') + ' ' + (button.getAttribute('data-tooltip') || '')
              ))""")
            if current != last_text:
                last_text = current
                stable_since = time.monotonic()
            elif not stop_visible and stable_since and time.monotonic() - stable_since >= 2:
                global chat_url
                if page.url.startswith("https://gemini.google.com/"):
                    chat_url = page.url
                    save_chat_state()
                return current
    raise TimeoutError("Gemini did not finish a response within four minutes.")


def handle_turn(page, user_text, initialize_session=False):
    publish("status", "Sending your message to Gemini…")
    prompt = (SYSTEM_PROMPT + "\n\nUser request:\n" + user_text) if initialize_session else user_text
    for _ in range(8):
        answer = send_to_gemini(page, prompt)
        tool_call = tool_call_from(answer)
        if not tool_call:
            publish("assistant", answer)
            publish("status", "Ready")
            return
        result = execute_tool(tool_call)
        prompt = (
            "The local tool returned this JSON result:\n"
            + json.dumps(result, ensure_ascii=False)
            + "\nContinue helping the user. If another local action is needed, issue one tool call in the required format; otherwise give a normal final answer."
        )
    publish("assistant", "I stopped after 8 tool calls in one turn. Please narrow the request and try again.")
    publish("status", "Ready")


def browser_worker():
    global busy
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        publish("status", "Playwright is missing. Install requirements, then run: python -m playwright install chrome")
        return

    try:
        with sync_playwright() as playwright:
            context = playwright.chromium.launch_persistent_context(
                user_data_dir=str(PROFILE_DIR),
                channel="chrome",
                headless=HEADLESS,
            )
            page = context.pages[0] if context.pages else context.new_page()
            resume_url = chat_url if chat_url.startswith("https://gemini.google.com/") else "https://gemini.google.com/app"
            page.goto(resume_url, wait_until="domcontentloaded", timeout=60000)
            if "accounts.google.com" in page.url:
                publish("status", "Gemini is not signed in. Stop this app and run: python app.py --login")
            else:
                publish("status", "Background Gemini browser is ready.")
            worker_chat_id = None
            while True:
                job = jobs.get()
                if job is None:
                    break
                try:
                    target_id, user_text, initialize = job["chat_id"], job["text"], job["initialize"]
                    target = next((chat for chat in chats if chat.get("id") == target_id), None)
                    if target is None:
                        raise RuntimeError("The selected chat no longer exists.")
                    if worker_chat_id != target_id:
                        resume_url = target.get("url", "")
                        if not resume_url.startswith("https://gemini.google.com/"):
                            resume_url = "https://gemini.google.com/app"
                        page.goto(resume_url, wait_until="domcontentloaded", timeout=60000)
                        worker_chat_id = target_id
                    handle_turn(page, user_text, initialize_session=initialize)
                except Exception as exc:
                    publish("status", f"Gemini/browser error: {exc}")
                finally:
                    with busy_lock:
                        busy = False
                    jobs.task_done()
            context.close()
    except Exception as exc:
        publish("status", f"Could not start the background Chrome session: {exc}")


def login_setup():
    """Use ordinary Chrome for Google sign-in, which rejects automated login windows."""
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    chrome = shutil.which("chrome")
    if not chrome:
        candidates = [
            Path(os.environ.get("PROGRAMFILES", r"C:\Program Files")) / "Google/Chrome/Application/chrome.exe",
            Path(os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")) / "Google/Chrome/Application/chrome.exe",
            Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/Application/chrome.exe",
        ]
        chrome = next((str(path) for path in candidates if path.is_file()), None)
    if not chrome:
        raise SystemExit("Could not find Google Chrome. Install Chrome or add chrome.exe to PATH.")
    process = subprocess.Popen([
        chrome,
        f"--user-data-dir={PROFILE_DIR}",
        "--no-first-run",
        "--no-default-browser-check",
        "https://gemini.google.com/app",
    ])
    print("A regular Chrome window has opened with the prototype's dedicated profile.")
    print("Sign in to Gemini, then close that Chrome window before returning here.")
    input("Press Enter after closing the window to finish setup.")
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.terminate()


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/events")
def get_events():
    try:
        after = max(0, int(request.args.get("after", "0")))
    except ValueError:
        return jsonify({"error": "after must be an integer"}), 400
    with events_lock:
        return jsonify([event for event in events if event["id"] > after])


@app.get("/api/state")
def get_state():
    return jsonify({
        "app_version": APP_VERSION,
        "title": chat_title,
        "active_chat_id": active_chat_id,
        "chats": [{"id": chat["id"], "title": chat.get("title") or "New chat"} for chat in chats],
        "busy": busy,
        "can_delete": can_delete_active_chat(),
    })


@app.post("/api/chat/new")
def new_chat():
    with busy_lock:
        if busy:
            return jsonify({"error": "Wait for the current reply to finish before starting or switching chats."}), 409
        new_item = make_new_chat()
        chats.insert(0, new_item)
        activate_chat(new_item)
    return jsonify({"accepted": True, "active_chat_id": active_chat_id})


@app.post("/api/chat/select")
def select_chat():
    data = request.get_json(silent=True)
    target_id = data.get("id") if isinstance(data, dict) else None
    with busy_lock:
        if busy:
            return jsonify({"error": "Wait for the current reply to finish before switching chats."}), 409
        target = next((chat for chat in chats if chat.get("id") == target_id), None)
        if target is None:
            return jsonify({"error": "Chat not found."}), 404
        activate_chat(target)
    return jsonify({"accepted": True})


@app.post("/api/chat/delete-local")
def delete_local_chat():
    data = request.get_json(silent=True)
    target_id = data.get("id") if isinstance(data, dict) else None
    with busy_lock:
        if busy:
            return jsonify({"error": "Wait for the current reply to finish before deleting this chat."}), 409
        if target_id != active_chat_id:
            return jsonify({"error": "Select this chat before deleting it."}), 400
        if not can_delete_active_chat():
            return jsonify({"error": "This empty chat cannot be deleted yet."}), 400
        remove_local_chat(target_id)
    return jsonify({"accepted": True, "deleted_from": "app_only"})


@app.post("/api/chat")
def send_chat():
    global busy, chat_title
    data = request.get_json(silent=True)
    text = data.get("text") if isinstance(data, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text) > 12000:
        return jsonify({"error": "Message must contain 1 to 12,000 characters."}), 400
    with busy_lock:
        if busy:
            return jsonify({"error": "Wait for the current reply to finish."}), 409
        busy = True
    if chat_title == "New chat":
        chat_title = make_chat_title(text)
        save_chat_state()
    initialize = not any(event.get("type") == "user" for event in events)
    publish("user", text.strip())
    jobs.put({"chat_id": active_chat_id, "text": text.strip(), "initialize": initialize})
    return jsonify({"accepted": True}), 202


@app.post("/api/approval")
def decide_approval():
    data = request.get_json(silent=True)
    approval_id = data.get("id") if isinstance(data, dict) else None
    approved = data.get("approved") if isinstance(data, dict) else None
    if not isinstance(approval_id, str) or not isinstance(approved, bool):
        return jsonify({"error": "Provide an approval id and a boolean decision."}), 400
    with pending_lock:
        decision = pending_approvals.get(approval_id)
        if decision is None:
            return jsonify({"error": "Approval expired or already handled."}), 404
        try:
            decision.put_nowait(approved)
        except queue.Full:
            return jsonify({"error": "Approval was already handled."}), 409
    publish("status", "Tool approved." if approved else "Tool rejected.")
    return jsonify({"accepted": True})


if __name__ == "__main__":
    if "--login" in sys.argv:
        login_setup()
    else:
        threading.Thread(target=browser_worker, daemon=True, name="gemini-browser").start()
        publish("status", "Starting background Gemini browser…")
        print(f"Bridge Desk is listening on http://127.0.0.1:{PORT}")
        app.run(host="127.0.0.1", port=PORT, debug=False, threaded=True)
