// ==UserScript==
// @name         Browser Chat PC Agent Harness (v4.2)
// @namespace    local-pc-agent
// @version      4.2
// @description  Bridges Gemini tool calls to a token-protected local PC agent.
// @match        https://gemini.google.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  "use strict";

  const SERVER_URL = "http://127.0.0.1:5050/mcp";
  const REQUEST_TIMEOUT_MS = 65000;
  const TRIGGER_WORD = "exect";
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
  const pendingSignatures = new Set();
  const autoAttemptedSignatures = new Set();

  const previousPanel = document.getElementById("mcp-harness-panel");
  if (previousPanel) previousPanel.remove();

  const panel = document.createElement("div");
  panel.id = "mcp-harness-panel";
  panel.style.cssText = "position:fixed;bottom:20px;right:20px;z-index:999999;background:#1e1e2e;color:#cdd6f4;padding:12px;border-radius:10px;font-family:monospace;box-shadow:0 4px 12px rgba(0,0,0,.5);width:280px;";

  const title = document.createElement("div");
  title.textContent = "Local PC Agent Harness v4.2";
  title.style.cssText = "font-weight:bold;margin-bottom:8px;font-size:13px;";

  const runButton = document.createElement("button");
  runButton.textContent = "Execute Last JSON Tool";
  runButton.style.cssText = "background:#a6e3a1;color:#11111b;border:none;padding:8px 12px;border-radius:6px;cursor:pointer;font-weight:bold;width:100%;margin-bottom:8px;";

  const toggles = document.createElement("div");
  toggles.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-bottom:8px;";

  const autoExecuteLabel = document.createElement("label");
  autoExecuteLabel.style.cssText = "font-size:12px;cursor:pointer;display:flex;align-items:center;";
  const autoExecuteToggle = document.createElement("input");
  autoExecuteToggle.type = "checkbox";
  autoExecuteToggle.style.cssText = "margin-right:6px;";
  autoExecuteToggle.checked = localStorage.getItem("mcp_auto_exec") === "true";
  autoExecuteLabel.append(autoExecuteToggle, document.createTextNode("Auto-execute read-only tools"));

  const autoSendLabel = document.createElement("label");
  autoSendLabel.style.cssText = "font-size:12px;cursor:pointer;display:flex;align-items:center;";
  const autoSendToggle = document.createElement("input");
  autoSendToggle.type = "checkbox";
  autoSendToggle.style.cssText = "margin-right:6px;";
  autoSendToggle.checked = localStorage.getItem("mcp_auto_send") === "true";
  autoSendLabel.append(autoSendToggle, document.createTextNode("Auto-send reply in chat"));
  toggles.append(autoExecuteLabel, autoSendLabel);

  const status = document.createElement("div");
  status.style.cssText = "margin-top:8px;font-size:11px;color:#a6adc8;overflow-wrap:anywhere;";
  status.textContent = "Ready — manual execution enabled.";
  panel.append(title, runButton, toggles, status);
  document.body.appendChild(panel);

  autoExecuteToggle.addEventListener("change", () => {
    localStorage.setItem("mcp_auto_exec", String(autoExecuteToggle.checked));
    status.textContent = autoExecuteToggle.checked
      ? "Auto-execute enabled for read-only tools."
      : "Auto-execute disabled; use the button to run tools.";
  });
  autoSendToggle.addEventListener("change", () => {
    localStorage.setItem("mcp_auto_send", String(autoSendToggle.checked));
  });

  function parseToolCall(text) {
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return null;
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.mcp_call !== true) return null;
    if (typeof payload.tool !== "string" || !Object.prototype.hasOwnProperty.call(ALLOWED_TOOLS, payload.tool)) return null;
    if (!payload.args || typeof payload.args !== "object" || Array.isArray(payload.args)) return null;

    const allowedKeys = ALLOWED_TOOLS[payload.tool];
    if (Object.keys(payload.args).some(key => !allowedKeys.includes(key))) return null;
    const args = payload.args;

    if (payload.tool === "list_files" && "directory" in args && typeof args.directory !== "string") return null;
    if (["read_file", "get_file_info", "preview_file"].includes(payload.tool) && typeof args.filename !== "string") return null;
    if (payload.tool === "write_file" && (typeof args.filename !== "string" || typeof args.content !== "string")) return null;
    if (payload.tool === "search_files" &&
        (typeof args.query !== "string" ||
         ("directory" in args && typeof args.directory !== "string") ||
         ("search_content" in args && typeof args.search_content !== "boolean"))) return null;
    if (payload.tool === "create_directory" && typeof args.directory !== "string") return null;
    if (payload.tool === "move_file" && (typeof args.source !== "string" || typeof args.destination !== "string")) return null;
    if (payload.tool === "run_command" && (typeof args.command !== "string" || typeof args.purpose !== "string")) return null;
    return payload;
  }

  function triggerContext(block, blockText) {
    const normalizedBlockText = blockText.replace(/\s+/g, " ").trim();
    let parent = block.parentElement;
    for (let depth = 0; parent && depth < 15; depth++, parent = parent.parentElement) {
      const text = (parent.innerText || parent.textContent || "").replace(/\s+/g, " ");
      const index = text.lastIndexOf(normalizedBlockText);
      if (index < 0) continue;
      const followingText = text.slice(index + normalizedBlockText.length).replace(/copy\s*code/gi, "");
      if (new RegExp("^\\s*" + TRIGGER_WORD + "(?:\\s|$)", "i").test(followingText)) return text;
    }
    return "";
  }

  function signatureFor(payload) {
    return JSON.stringify([payload.tool, Object.entries(payload.args).sort(([a], [b]) => a.localeCompare(b))]);
  }

  function callKeyFor(signature, context) {
    let hash = 2166136261;
    for (const character of signature + "\n" + context) {
      hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    }
    return "mcp_handled_" + (hash >>> 0).toString(36);
  }

  function wasHandledAcrossRefreshes(callKey) {
    try {
      return sessionStorage.getItem(callKey) === "true";
    } catch (_) {
      return false;
    }
  }

  function findLatestToolCall(autoMode) {
    const blocks = Array.from(document.querySelectorAll("pre, code"));
    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index];
      const rawText = (block.innerText || block.textContent || "").trim();
      if (!rawText.startsWith("{") || !rawText.includes('"mcp_call"')) continue;
      if (block.getAttribute("data-mcp-executed") === "true") continue;

      const payload = parseToolCall(rawText);
      const context = payload && triggerContext(block, rawText);
      if (!payload || !context) continue;
      const signature = signatureFor(payload);
      const callKey = callKeyFor(signature, context);
      if (executedSignatures.has(signature) || pendingSignatures.has(signature)) continue;
      if (wasHandledAcrossRefreshes(callKey)) continue;
      if (autoMode && autoAttemptedSignatures.has(signature)) continue;

      const readOnlyTools = ["get_pc_stats", "list_files", "read_file", "search_files", "get_file_info", "preview_file"];
      if (autoMode && !readOnlyTools.includes(payload.tool)) continue;
      return { payload, element: block, rawText, signature, callKey };
    }
    return null;
  }

  function insertIntoChat(responseText, forceSend = false) {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(responseText).catch(() => {});

    const inputBox =
      document.querySelector('rich-textarea [contenteditable="true"]') ||
      document.querySelector('.ql-editor[contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector("textarea");
    if (!inputBox) {
      status.textContent = "Result copied if clipboard access was available; paste it into chat manually.";
      return Promise.resolve(false);
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

    if (!forceSend && !autoSendToggle.checked) {
      status.textContent = "Reply inserted. Review and send manually.";
      return Promise.resolve(false);
    }

    status.textContent = "Reply inserted; attempting to send...";
    return new Promise(resolve => setTimeout(() => {
      const sendButton = Array.from(document.querySelectorAll(
        'button[aria-label="Send message"], button[aria-label="Send"]'
      )).find(button => button.getClientRects().length > 0 && !button.disabled &&
        button.getAttribute("aria-disabled") !== "true");
      if (sendButton) {
        sendButton.click();
        status.textContent = "Send button clicked; check that the reply appeared in chat.";
        resolve(true);
      } else {
        inputBox.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13
        }));
        status.textContent = "Enter key pressed; check whether the reply was sent.";
        resolve(true);
      }
    }, 150));
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
      const purposeText = document.createElement("p");
      purposeText.textContent = "Purpose: " + purpose;
      purposeText.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;";
      const commandField = document.createElement("textarea");
      commandField.readOnly = true;
      commandField.value = command;
      commandField.setAttribute("aria-label", "Exact command to execute");
      commandField.style.cssText = "box-sizing:border-box;width:100%;min-height:110px;background:#11111b;color:#f9e2af;border:1px solid #585b70;border-radius:6px;padding:10px;font:13px monospace;resize:vertical;";
      const warning = document.createElement("p");
      warning.textContent = "This runs with your Windows account's permissions. Review the full command before approving.";
      warning.style.cssText = "color:#f38ba8;font-size:12px;";
      const buttons = document.createElement("div");
      buttons.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:14px;";
      const rejectButton = document.createElement("button");
      rejectButton.textContent = "Reject";
      const acceptButton = document.createElement("button");
      acceptButton.textContent = "Accept and run";
      acceptButton.style.cssText = "background:#a6e3a1;color:#11111b;font-weight:bold;";
      for (const button of [rejectButton, acceptButton]) {
        button.style.cssText += "border:0;border-radius:5px;padding:9px 14px;cursor:pointer;";
      }
      const finish = approved => { overlay.remove(); resolve(approved); };
      rejectButton.addEventListener("click", () => finish(false));
      acceptButton.addEventListener("click", () => finish(true));
      overlay.addEventListener("click", event => { if (event.target === overlay) finish(false); });
      dialog.append(heading, purposeText, commandField, warning, buttons);
      buttons.append(rejectButton, acceptButton);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      commandField.focus();
    });
  }

  function finishCall(target) {
    pendingSignatures.delete(target.signature);
    executedSignatures.add(target.signature);
    target.element.setAttribute("data-mcp-executed", "true");
    try {
      sessionStorage.setItem(target.callKey, "true");
    } catch (_) {}
  }

  async function executeToolCall(target) {
    if (typeof GM_xmlhttpRequest !== "function") {
      status.textContent = "Error: Tampermonkey GM_xmlhttpRequest is unavailable.";
      return;
    }
    if (!MCP_TOKEN || MCP_TOKEN.includes("REPLACE_WITH_")) {
      status.textContent = "Run setup again to generate a configured userscript.";
      return;
    }

    pendingSignatures.add(target.signature);
    if (target.payload.tool === "run_command") {
      const approved = await approveCommand(target.payload.args.command, target.payload.args.purpose);
      if (!approved) {
        finishCall(target);
        const rejection = {
          tool: "run_command",
          status: "error",
          error: {
            code: "USER_REJECTED",
            message: "The user rejected this command. It was not executed.",
            command: target.payload.args.command
          }
        };
        insertIntoChat("```json\n" + JSON.stringify(rejection, null, 2) + "\n```", true);
        return;
      }
    }

    // Claim the call before sending it so failures cannot cause an auto-execution loop.
    finishCall(target);
    const isCommand = target.payload.tool === "run_command";
    if (isCommand) {
      status.textContent = "Approved. Sending acknowledgement, then waiting up to 60 seconds for the command.";
      const acknowledgement = {
        tool: "run_command",
        status: "running",
        result: {
          message: "The user approved the command. It is running; wait for the final tool result before continuing.",
          purpose: target.payload.args.purpose
        }
      };
      await insertIntoChat("```json\n" + JSON.stringify(acknowledgement, null, 2) + "\n```", true);
    } else {
      status.textContent = "Running " + target.payload.tool + "...";
    }
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
        let data;
        try {
          data = JSON.parse(response.responseText);
        } catch {
          status.textContent = "Server returned non-JSON (HTTP " + response.status + ").";
          if (isCommand) {
            const parseError = {
              tool: "run_command",
              status: "error",
              error: { code: "INVALID_SERVER_RESPONSE", message: "The server returned a non-JSON response (HTTP " + response.status + ")." }
            };
            insertIntoChat("```json\n" + JSON.stringify(parseError, null, 2) + "\n```", true);
          }
          return;
        }
        status.textContent = response.status >= 200 && response.status < 300 && data.status === "success"
          ? "Completed: " + target.payload.tool
          : "Tool failed (HTTP " + response.status + "): " + ((data.error && data.error.message) || data.error || "Unknown error");
        insertIntoChat("```json\n" + JSON.stringify(data, null, 2) + "\n```", isCommand);
      },
      ontimeout() {
        status.textContent = "Timed out. The call will not repeat automatically; inspect the server before retrying.";
        if (isCommand) {
          const timeoutResult = {
            tool: "run_command",
            status: "error",
            error: { code: "CLIENT_TIMEOUT", message: "No final command response arrived within 60 seconds." }
          };
          insertIntoChat("```json\n" + JSON.stringify(timeoutResult, null, 2) + "\n```", true);
        }
      },
      onerror() {
        status.textContent = "Connection failed. Check that the local server is running.";
        if (isCommand) {
          const connectionError = {
            tool: "run_command",
            status: "error",
            error: { code: "CONNECTION_FAILED", message: "The local server connection failed; no final command result was received." }
          };
          insertIntoChat("```json\n" + JSON.stringify(connectionError, null, 2) + "\n```", true);
        }
      }
    });
  }

  runButton.addEventListener("click", () => {
    const target = findLatestToolCall(false);
    if (!target) {
      status.textContent = 'No unhandled valid tool call found with "exect" immediately after it.';
      return;
    }
    executeToolCall(target);
  });

  setInterval(() => {
    if (!autoExecuteToggle.checked) return;
    const target = findLatestToolCall(true);
    if (!target) return;
    autoAttemptedSignatures.add(target.signature);
    executeToolCall(target);
  }, 2000);
})();
