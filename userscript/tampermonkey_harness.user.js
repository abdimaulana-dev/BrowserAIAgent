// ==UserScript==
// @name         Browser Chat PC Agent Harness (v3.1)
// @namespace    local-pc-agent
// @version      3.1
// @description  Bridges Gemini chat tool calls to a local, token-protected PC agent.
// @match        https://gemini.google.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  "use strict";

  const SERVER_URL = "http://127.0.0.1:5050/mcp";
  const REQUEST_TIMEOUT_MS = 15000;
  const TRIGGER_WORD = "exect";

  // Set this to the SAME token as MCP_AUTH_TOKEN in the server environment.
  // This is a basic local guard, not protection against malware or a malicious
  // process already running as your Windows user.
  const MCP_TOKEN = "REPLACE_WITH_THE_SAME_LONG_RANDOM_TOKEN";

  const ALLOWED_TOOLS = {
    get_pc_stats: [],
    list_files: ["directory"],
    read_file: ["filename"],
    write_file: ["filename", "content"],
    search_files: ["query", "directory", "search_content"],
    create_directory: ["directory"],
    move_file: ["source", "destination"],
    get_file_info: ["filename"],
    preview_file: ["filename"],
    run_command: ["command", "purpose"]
  };

  const executedSignatures = new Set();
  const autoAttemptedSignatures = new Set();
  const pendingSignatures = new Set();

  const oldPanel = document.getElementById("mcp-harness-panel");
  if (oldPanel) oldPanel.remove();

  const panel = document.createElement("div");
  panel.id = "mcp-harness-panel";
  panel.style.cssText =
    "position:fixed;bottom:20px;right:20px;z-index:999999;background:#1e1e2e;color:#cdd6f4;padding:12px;border-radius:10px;font-family:monospace;box-shadow:0 4px 12px rgba(0,0,0,.5);width:280px;";

  const title = document.createElement("div");
  title.textContent = "Local PC Agent Harness v3.1";
  title.style.cssText = "font-weight:bold;margin-bottom:8px;font-size:13px;";

  const runBtn = document.createElement("button");
  runBtn.textContent = "Execute Last JSON Tool";
  runBtn.style.cssText =
    "background:#a6e3a1;color:#11111b;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;font-weight:bold;width:100%;margin-bottom:8px;";

  const toggleWrapper = document.createElement("div");
  toggleWrapper.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-bottom:8px;";

  const autoExecLabel = document.createElement("label");
  autoExecLabel.style.cssText = "font-size:12px;cursor:pointer;display:flex;align-items:center;";
  const autoExecToggle = document.createElement("input");
  autoExecToggle.type = "checkbox";
  autoExecToggle.style.cssText = "margin-right:6px;";
  // Safe default: disabled unless explicitly enabled by the user.
  autoExecToggle.checked = localStorage.getItem("mcp_auto_exec") === "true";
  autoExecLabel.append(autoExecToggle, document.createTextNode("Auto-execute read-only tools"));

  const autoSendLabel = document.createElement("label");
  autoSendLabel.style.cssText = "font-size:12px;cursor:pointer;display:flex;align-items:center;";
  const autoSendToggle = document.createElement("input");
  autoSendToggle.type = "checkbox";
  autoSendToggle.style.cssText = "margin-right:6px;";
  autoSendToggle.checked = localStorage.getItem("mcp_auto_send") === "true";
  autoSendLabel.append(autoSendToggle, document.createTextNode("Auto-send reply in chat"));

  toggleWrapper.append(autoExecLabel, autoSendLabel);

  const statusEl = document.createElement("div");
  statusEl.style.cssText = "margin-top:8px;font-size:11px;color:#a6adc8;overflow-wrap:anywhere;";
  statusEl.textContent = "Ready — manual execution enabled.";

  panel.append(title, runBtn, toggleWrapper, statusEl);
  document.body.appendChild(panel);

  autoExecToggle.addEventListener("change", () => {
    localStorage.setItem("mcp_auto_exec", String(autoExecToggle.checked));
  });
  autoSendToggle.addEventListener("change", () => {
    localStorage.setItem("mcp_auto_send", String(autoSendToggle.checked));
  });

  function parseAndValidateToolCall(rawText) {
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch {
      return null;
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    if (payload.mcp_call !== true) return null;
    if (typeof payload.tool !== "string" || !Object.prototype.hasOwnProperty.call(ALLOWED_TOOLS, payload.tool)) return null;
    if (!payload.args || typeof payload.args !== "object" || Array.isArray(payload.args)) return null;

    const allowedKeys = ALLOWED_TOOLS[payload.tool];
    const argKeys = Object.keys(payload.args);
    if (argKeys.some(key => !allowedKeys.includes(key))) return null;

    if (payload.tool === "list_files" &&
        ("directory" in payload.args) &&
        typeof payload.args.directory !== "string") return null;
    if (payload.tool === "read_file" &&
        typeof payload.args.filename !== "string") return null;
    if (payload.tool === "write_file" &&
        (typeof payload.args.filename !== "string" || typeof payload.args.content !== "string")) return null;
    if (payload.tool === "search_files" &&
        (typeof payload.args.query !== "string" ||
         ("directory" in payload.args && typeof payload.args.directory !== "string") ||
         ("search_content" in payload.args && typeof payload.args.search_content !== "boolean"))) return null;
    if (payload.tool === "create_directory" && typeof payload.args.directory !== "string") return null;
    if (payload.tool === "move_file" &&
        (typeof payload.args.source !== "string" || typeof payload.args.destination !== "string")) return null;
    if (["get_file_info", "preview_file"].includes(payload.tool) && typeof payload.args.filename !== "string") return null;
    if (payload.tool === "run_command" &&
        (typeof payload.args.command !== "string" || typeof payload.args.purpose !== "string")) return null;

    return payload;
  }

  // Require "exect" to occur immediately after the candidate code block in the
  // same nearby response container, rather than anywhere in a large ancestor.
  function hasImmediateTrigger(block, blockText) {
    let parent = block.parentElement;
    for (let depth = 0; parent && depth < 6; depth++, parent = parent.parentElement) {
      const fullText = parent.innerText || parent.textContent || "";
      const index = fullText.lastIndexOf(blockText);
      if (index < 0) continue;
      const after = fullText.slice(index + blockText.length);
      if (/^\s*exect(?:\s|$)/i.test(after)) return true;
    }
    return false;
  }

  function findLatestUnexecutedToolCall(isAutoMode) {
    const blocks = Array.from(document.querySelectorAll("pre, code"));
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      const rawText = (block.innerText || block.textContent || "").trim();
      if (!rawText.startsWith("{") || !rawText.includes('"mcp_call"')) continue;
      const payload = parseAndValidateToolCall(rawText);
      if (!payload) continue;
      if (!hasImmediateTrigger(block, rawText)) continue;
      const signature = JSON.stringify([payload.tool, Object.entries(payload.args).sort(([a], [b]) => a.localeCompare(b))]);
      if (executedSignatures.has(signature) || pendingSignatures.has(signature) ||
          (isAutoMode && autoAttemptedSignatures.has(signature))) continue;

      // Auto mode is deliberately limited to read-only tools.
      if (isAutoMode && !["get_pc_stats", "list_files", "read_file", "search_files", "get_file_info", "preview_file"].includes(payload.tool)) continue;

      return { payload, element: block, rawText, signature };
    }
    return null;
  }

  function insertIntoChat(responseText) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(responseText).catch(() => {});
    }

    const inputBox =
      document.querySelector('.ql-editor[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector("textarea");

    if (!inputBox) {
      statusEl.textContent = "Result copied if clipboard access was available; paste it into chat manually.";
      return;
    }

    inputBox.focus();
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, responseText);
    } catch (_) {}

    if (!inserted) {
      if (inputBox instanceof HTMLTextAreaElement) {
        inputBox.value = responseText;
        inputBox.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        inputBox.textContent = responseText;
        inputBox.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: responseText }));
      }
    }

    if (autoSendToggle.checked) {
      statusEl.textContent = "Reply inserted; attempting to send...";
      setTimeout(() => {
        const sendButton =
          document.querySelector('button[aria-label="Send message"]') ||
          document.querySelector('button[aria-label="Send"]');
        if (sendButton && !sendButton.disabled) {
          sendButton.click();
          statusEl.textContent = "Reply sent (button clicked).";
        } else {
          statusEl.textContent = "Reply inserted. Send button not found; please send manually.";
        }
      }, 250);
    } else {
      statusEl.textContent = "Reply inserted. Review and send manually.";
    }
  }

  function approveCommand(command, purpose) {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;z-index:1000001;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;padding:20px;";
      const dialog = document.createElement("div");
      dialog.style.cssText = "background:#1e1e2e;color:#cdd6f4;padding:20px;border-radius:10px;width:min(620px,95vw);font:14px sans-serif;box-shadow:0 8px 32px #000;";
      const heading = document.createElement("h2");
      heading.textContent = "Approve shell command?";
      heading.style.cssText = "margin:0 0 12px;font-size:18px;";
      const details = document.createElement("p");
      details.textContent = "Purpose: " + purpose;
      details.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;";
      const field = document.createElement("textarea");
      field.readOnly = true;
      field.value = command;
      field.setAttribute("aria-label", "Exact command to execute");
      field.style.cssText = "box-sizing:border-box;width:100%;min-height:110px;background:#11111b;color:#f9e2af;border:1px solid #585b70;border-radius:6px;padding:10px;font:13px monospace;resize:vertical;";
      const note = document.createElement("p");
      note.textContent = "This runs with your Windows account's permissions. Review the full command before approving.";
      note.style.cssText = "color:#f38ba8;font-size:12px;";
      const buttons = document.createElement("div");
      buttons.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:14px;";
      const reject = document.createElement("button");
      reject.textContent = "Reject";
      const accept = document.createElement("button");
      accept.textContent = "Accept and run";
      accept.style.cssText = "background:#a6e3a1;color:#11111b;font-weight:bold;";
      for (const button of [reject, accept]) button.style.cssText += "border:0;border-radius:5px;padding:9px 14px;cursor:pointer;";
      function finish(approved) { overlay.remove(); resolve(approved); }
      reject.addEventListener("click", () => finish(false));
      accept.addEventListener("click", () => finish(true));
      overlay.addEventListener("click", event => { if (event.target === overlay) finish(false); });
      dialog.append(heading, details, field, note, buttons);
      buttons.append(reject, accept);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      field.focus();
    });
  }

  async function executeToolCall(target) {
    if (typeof GM_xmlhttpRequest !== "function") {
      statusEl.textContent = "Error: Tampermonkey GM_xmlhttpRequest is unavailable.";
      return;
    }
    if (!MCP_TOKEN || MCP_TOKEN.includes("REPLACE_WITH_")) {
      statusEl.textContent = "Set MCP_TOKEN in this userscript before executing tools.";
      return;
    }

    pendingSignatures.add(target.signature);
    if (target.payload.tool === "run_command") {
      const approved = await approveCommand(target.payload.args.command, target.payload.args.purpose);
      if (!approved) {
        pendingSignatures.delete(target.signature);
        statusEl.textContent = "Command rejected; nothing was run.";
        return;
      }
    }
    statusEl.textContent = "Running " + target.payload.tool + "...";

    GM_xmlhttpRequest({
      method: "POST",
      url: SERVER_URL,
      headers: {
        "Content-Type": "application/json",
        "X-MCP-Token": MCP_TOKEN
      },
      data: JSON.stringify(target.payload),
      timeout: REQUEST_TIMEOUT_MS,
      onload(response) {
        pendingSignatures.delete(target.signature);
        let data;
        try {
          data = JSON.parse(response.responseText);
        } catch {
          statusEl.textContent = "Server returned non-JSON (HTTP " + response.status + ").";
          return;
        }

        if (response.status >= 200 && response.status < 300 && data.status === "success") {
          executedSignatures.add(target.signature);
          target.element.setAttribute("data-mcp-executed", "true");
          statusEl.textContent = "Completed: " + target.payload.tool;
        } else {
          statusEl.textContent = "Tool failed (HTTP " + response.status + "): " +
            ((data.error && data.error.message) || data.error || "Unknown error");
        }

        const formattedReply = "```json\n" + JSON.stringify(data, null, 2) + "\n```";
        insertIntoChat(formattedReply);
      },
      ontimeout() {
        pendingSignatures.delete(target.signature);
        statusEl.textContent = "Timed out. Check the server before retrying to avoid repeating an action.";
      },
      onerror() {
        pendingSignatures.delete(target.signature);
        statusEl.textContent = "Connection failed. Check that the local server is running.";
      }
    });
  }

  runBtn.addEventListener("click", () => {
    const target = findLatestUnexecutedToolCall(false);
    if (!target) {
      statusEl.textContent = 'No valid unexecuted tool call found with "exect" immediately after it.';
      return;
    }
    executeToolCall(target);
  });

  setInterval(() => {
    if (!autoExecToggle.checked) return;
    const target = findLatestUnexecutedToolCall(true);
    if (target) {
      autoAttemptedSignatures.add(target.signature);
      executeToolCall(target);
    }
  }, 2000);
})();
