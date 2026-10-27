// ==UserScript==
// @name         Browser Chat PC Agent Harness (v2.2.1)
// @namespace    local-pc-agent
// @version      2.2.1
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
    edit_file: ["filename", "old_text", "new_text"],
    search_files: ["query", "directory", "search_content"],
    create_directory: ["directory"],
    move_file: ["source", "destination"],
    get_file_info: ["filename"],
    preview_file: ["filename"],
    run_command: ["command", "purpose", "seconds", "wait_until_completed"]
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
  title.textContent = "Local PC Agent Harness v2.2.1";
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
  autoExecuteLabel.append(autoExecuteToggle, document.createTextNode("Auto-execute tools (confirm shell)"));

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
      ? "Auto-execute enabled; shell commands still need approval."
      : "Auto-execute disabled; use the button to run tools.";
  });
  autoSendToggle.addEventListener("change", () => {
    localStorage.setItem("mcp_auto_send", String(autoSendToggle.checked));
  });

  function parseToolCall(text) {
    // Gemini may include the fenced-block language label in the code element.
    // Strip only a standalone leading JSON label; keep the payload strict JSON.
    const normalizedText = String(text)
      .replace(/^\s*json\s*(?:\r?\n|$)/i, "")
      .trim();
    let payload;
    try {
      payload = JSON.parse(normalizedText);
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
    if (payload.tool === "edit_file" &&
        (typeof args.filename !== "string" || typeof args.old_text !== "string" || !args.old_text ||
         typeof args.new_text !== "string")) return null;
    if (payload.tool === "search_files" &&
        (typeof args.query !== "string" ||
         ("directory" in args && typeof args.directory !== "string") ||
         ("search_content" in args && typeof args.search_content !== "boolean"))) return null;
    if (payload.tool === "create_directory" && typeof args.directory !== "string") return null;
    if (payload.tool === "move_file" && (typeof args.source !== "string" || typeof args.destination !== "string")) return null;
    if (payload.tool === "run_command" &&
        (typeof args.command !== "string" || typeof args.purpose !== "string" ||
         ("seconds" in args && (!Number.isInteger(args.seconds) || args.seconds < 1 || args.seconds > 300)) ||
         ("wait_until_completed" in args && typeof args.wait_until_completed !== "boolean"))) return null;
    return payload;
  }

  function parentAcrossShadow(node) {
    if (node.parentElement) return node.parentElement;
    return node.getRootNode?.().host || null;
  }

  function queryAllIncludingOpenShadow(selector, root = document) {
    const matches = Array.from(root.querySelectorAll(selector));
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) matches.push(...queryAllIncludingOpenShadow(selector, element.shadowRoot));
    }
    return matches;
  }

  function toolCallBlocks() {
    const blocks = queryAllIncludingOpenShadow("pre, code");
    const codeBlocks = blocks.filter(block => block.tagName === "CODE");
    return codeBlocks.length ? codeBlocks : blocks.filter(block => block.tagName === "PRE");
  }

  function triggerContext(block) {
    let current = block;
    for (let depth = 0; current && depth < 15; depth++, current = parentAcrossShadow(current)) {
      for (let sibling = current.nextSibling; sibling; sibling = sibling.nextSibling) {
        if (sibling.nodeType === Node.ELEMENT_NODE &&
            sibling.matches("button,[role=button],[aria-label],[aria-hidden=true],svg")) continue;
        const followingText = (sibling.nodeType === Node.TEXT_NODE
          ? sibling.nodeValue
          : (sibling.innerText || sibling.textContent || ""))
          .replace(/copy\s*code/gi, "")
          .replace(/[\u200B-\u200D\uFEFF]/g, "")
          .trim();
        if (!followingText) continue;
        if (new RegExp("^" + TRIGGER_WORD + "(?:\\s|$)", "i").test(followingText)) {
          const parent = parentAcrossShadow(current);
          return (parent?.innerText || parent?.textContent || followingText).replace(/\s+/g, " ").trim();
        }
        // Gemini may put intervening presentation nodes between the code and
        // trigger. Check the rendered text order after walking this ancestor.
        break;
      }
    }

    const normalizeDisplayText = value => String(value || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/copy\s*code/gi, "")
      .replace(/\s+/g, " ")
      .trim();
    const codeText = normalizeDisplayText(block.innerText || block.textContent || "")
      .replace(/^json\s+(?=\{)/i, "");
    if (!codeText) return "";

    current = block;
    for (let depth = 0; current && depth < 15; depth++, current = parentAcrossShadow(current)) {
      const container = parentAcrossShadow(current);
      const containerText = normalizeDisplayText(container?.innerText || container?.textContent || "");
      const codeIndex = containerText.lastIndexOf(codeText);
      if (codeIndex < 0) continue;
      const afterCode = containerText.slice(codeIndex + codeText.length).trim();
      if (new RegExp("^" + TRIGGER_WORD + "(?:\\s|$)", "i").test(afterCode)) {
        return containerText;
      }
    }
    return "";
  }

  function signatureFor(payload) {
    return JSON.stringify([payload.tool, Object.entries(payload.args).sort(([a], [b]) => a.localeCompare(b))]);
  }

  function callKeyFor(signature, context, occurrence = null) {
    let hash = 2166136261;
    const identity = signature + "\n" + context +
      (occurrence === null ? "" : "\noccurrence:" + occurrence);
    for (const character of identity) {
      hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    }
    return "mcp_handled_" + (hash >>> 0).toString(36);
  }

  function occurrenceFor(blocks, index, payload, context) {
    const signature = signatureFor(payload);
    let occurrence = 0;
    for (let priorIndex = 0; priorIndex < index; priorIndex++) {
      const text = (blocks[priorIndex].innerText || blocks[priorIndex].textContent || "")
        .replace(/^\s*json\s*(?:\r?\n|$)/i, "").trim();
      const priorPayload = parseToolCall(text);
      if (priorPayload && signatureFor(priorPayload) === signature &&
          triggerContext(blocks[priorIndex]) === context) occurrence++;
    }
    return occurrence;
  }

  function wasHandledAcrossRefreshes(callKey, legacyCallKey, occurrence) {
    try {
      return sessionStorage.getItem(callKey) === "true" ||
        (occurrence === 0 && sessionStorage.getItem(legacyCallKey) === "true");
    } catch (_) {
      return false;
    }
  }

  function findLatestToolCall(autoMode, onlyTool = null) {
    const blocks = toolCallBlocks();
    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index];
      const rawText = (block.innerText || block.textContent || "").trim();
      const candidateText = rawText.replace(/^\s*json\s*(?:\r?\n|$)/i, "").trim();
      if (!candidateText.startsWith("{") || !candidateText.includes('"mcp_call"')) continue;
      if (block.getAttribute("data-mcp-executed") === "true") continue;

      const payload = parseToolCall(candidateText);
      if (onlyTool && payload?.tool !== onlyTool) continue;
      const context = payload && triggerContext(block);
      if (!payload || !context) continue;
      const signature = signatureFor(payload);
      const occurrence = occurrenceFor(blocks, index, payload, context);
      const callKey = callKeyFor(signature, context, occurrence);
      if (executedSignatures.has(callKey) || pendingSignatures.has(callKey)) continue;
      if (wasHandledAcrossRefreshes(callKey, callKeyFor(signature, context), occurrence)) continue;
      if (autoMode && autoAttemptedSignatures.has(callKey)) continue;

      return { payload, element: block, rawText, signature, callKey };
    }
    return null;
  }

  function diagnoseLatestToolCall(onlyTool = null) {
    const blocks = toolCallBlocks();
    if (!blocks.length) return "No code blocks found in the page. The response may not have rendered as a code block.";

    let hasToolMarker = false;
    let malformedJson = false;
    let invalidCall = false;
    let wrongTool = false;
    let missingTrigger = false;
    let alreadyHandled = false;

    for (let index = blocks.length - 1; index >= 0; index--) {
      const block = blocks[index];
      const rawText = (block.innerText || block.textContent || "").trim();
      const candidateText = rawText.replace(/^\s*json\s*(?:\r?\n|$)/i, "").trim();
      if (!candidateText.startsWith("{") || !candidateText.includes('"mcp_call"')) continue;
      hasToolMarker = true;

      try {
        JSON.parse(candidateText);
      } catch (_) {
        malformedJson = true;
        continue;
      }

      const payload = parseToolCall(candidateText);
      if (!payload) {
        invalidCall = true;
        continue;
      }
      if (onlyTool && payload.tool !== onlyTool) {
        wrongTool = true;
        continue;
      }

      const context = triggerContext(block);
      if (!context) {
        missingTrigger = true;
        continue;
      }

      const signature = signatureFor(payload);
      const occurrence = occurrenceFor(blocks, index, payload, context);
      const callKey = callKeyFor(signature, context, occurrence);
      if (block.getAttribute("data-mcp-executed") === "true" ||
          executedSignatures.has(callKey) ||
          wasHandledAcrossRefreshes(callKey, callKeyFor(signature, context), occurrence)) {
        alreadyHandled = true;
        continue;
      }
      if (pendingSignatures.has(callKey)) return "This valid tool call is already being processed; wait for its result.";
      return "The call is valid and its trigger was found. If no approval dialog appeared, check the Tampermonkey script version and reload Gemini.";
    }

    if (!hasToolMarker) return "Code blocks were found, but none contains a JSON object with the \"mcp_call\" marker.";
    if (missingTrigger) return 'A tool call passed validation, but a standalone "exect" trigger was not found after its code block.';
    if (wrongTool) return onlyTool
      ? 'A valid tool call was found, but it is not the expected tool "' + onlyTool + '".'
      : "A valid tool call was found, but it could not be selected.";
    if (invalidCall) return "The JSON parsed, but the call was rejected: check mcp_call:true, the allowed tool name, and that args contains only allowed fields with the expected types.";
    if (malformedJson) return "A block contains the mcp_call marker, but its contents are not valid JSON. Remove any text inside the JSON object and check quotes and commas.";
    if (alreadyHandled) return "This tool call was already handled. Change the call or resend it as a new message if you intend to run it again.";
    return "No valid tool call could be selected. Check that the code block contains one JSON object.";
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

    status.textContent = "Reply inserted; waiting for Gemini to finish before sending...";
    return new Promise(resolve => {
      const deadline = Date.now() + 30000;
      const trySend = () => {
        const selector = [
          'button[aria-label*="send" i]',
          'button[data-tooltip*="send" i]',
          'button.mdc-icon-button.mat-mdc-icon-button.mat-mdc-button-base.mat-badge.mat-unthemed.mat-badge-overlap.mat-badge-above.mat-badge-after.mat-badge-small.mat-badge-hidden.ng-star-inserted'
        ].join(", ");
        let container = inputBox;
        let sendButton = null;
        while (container && container !== document) {
          const buttons = queryAllIncludingOpenShadow(selector, container).filter(button =>
            button.getClientRects().length > 0 && !button.disabled &&
            button.getAttribute("aria-disabled") !== "true" &&
            !/stop|cancel/i.test((button.getAttribute("aria-label") || "") + " " +
              (button.getAttribute("data-tooltip") || "")));
          if (buttons.length) {
            if (buttons.length === 1) sendButton = buttons[0];
            break;
          }
          container = parentAcrossShadow(container);
        }
        if (sendButton) {
          sendButton.click();
          status.textContent = "Reply sent to Gemini.";
          resolve(true);
        } else if (Date.now() >= deadline) {
          status.textContent = "Reply is in the composer, but its send button was unavailable or ambiguous. Send it manually.";
          resolve(false);
        } else {
          setTimeout(trySend, 300);
        }
      };
      setTimeout(trySend, 300);
    });
  }

  function approveCommand(command, purpose, seconds, waitUntilCompleted) {
    return new Promise(resolve => {
      status.textContent = "Review the shell command and choose Accept and run, Reject, or Reject silently.";
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
      const waitText = document.createElement("p");
      waitText.textContent = waitUntilCompleted
        ? "Wait for completion: up to " + seconds + " seconds."
        : "Wait for completion: No; return after launch.";
      waitText.style.cssText = "font-size:12px;color:#a6adc8;";
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
      const silentRejectButton = document.createElement("button");
      silentRejectButton.textContent = "Reject silently";
      const acceptButton = document.createElement("button");
      acceptButton.textContent = "Accept and run";
      acceptButton.style.cssText = "background:#a6e3a1;color:#11111b;font-weight:bold;";
      silentRejectButton.title = "Do not run the command and do not send a rejection message to the AI.";
      for (const button of [rejectButton, silentRejectButton, acceptButton]) {
        button.style.cssText += "border:0;border-radius:5px;padding:9px 14px;cursor:pointer;";
      }
      const finish = choice => { overlay.remove(); resolve(choice); };
      rejectButton.addEventListener("click", () => finish("reject"));
      silentRejectButton.addEventListener("click", () => finish("silent"));
      acceptButton.addEventListener("click", () => finish("accept"));
      overlay.addEventListener("click", event => { if (event.target === overlay) finish("reject"); });
      dialog.append(heading, purposeText, waitText, commandField, warning, buttons);
      buttons.append(rejectButton, silentRejectButton, acceptButton);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      commandField.focus();
    });
  }

  function finishCall(target) {
    pendingSignatures.delete(target.callKey);
    executedSignatures.add(target.callKey);
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

    pendingSignatures.add(target.callKey);
    if (target.payload.tool === "run_command") {
      const seconds = target.payload.args.seconds ?? 15;
      const waitUntilCompleted = target.payload.args.wait_until_completed ?? false;
      const decision = await approveCommand(target.payload.args.command, target.payload.args.purpose,
        seconds, waitUntilCompleted);
      if (decision !== "accept") {
        finishCall(target);
        if (decision === "silent") {
          status.textContent = "Rejected silently. The command was not run, and no rejection message was sent to the AI.";
          return;
        }
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
      const seconds = target.payload.args.seconds ?? 15;
      const waitUntilCompleted = target.payload.args.wait_until_completed ?? false;
      status.textContent = waitUntilCompleted
        ? "Approved. Waiting up to " + seconds + " seconds for the command result."
        : "Approved. Launching the command and waiting for its start result.";
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
      timeout: isCommand && (target.payload.args.wait_until_completed ?? false)
        ? ((target.payload.args.seconds ?? 15) * 1000 + 5000)
        : REQUEST_TIMEOUT_MS,
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
          ? (isCommand && !(target.payload.args.wait_until_completed ?? false)
            ? "Started: run_command"
            : "Completed: " + target.payload.tool)
          : "Tool failed (HTTP " + response.status + "): " + ((data.error && data.error.message) || data.error || "Unknown error");
        insertIntoChat("```json\n" + JSON.stringify(data, null, 2) + "\n```", isCommand);
      },
      ontimeout() {
        status.textContent = "Timed out. The call will not repeat automatically; inspect the server before retrying.";
        if (isCommand) {
          const timeoutResult = {
            tool: "run_command",
            status: "error",
            error: { code: "CLIENT_TIMEOUT", message: "No final command response arrived within the requested wait." }
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
      status.textContent = diagnoseLatestToolCall();
      return;
    }
    executeToolCall(target);
  });

  setInterval(() => {
    const commandTarget = findLatestToolCall(false, "run_command");
    if (commandTarget) {
      executeToolCall(commandTarget);
      return;
    }
    if (!autoExecuteToggle.checked) return;
    const target = findLatestToolCall(true);
    if (!target) return;
    autoAttemptedSignatures.add(target.callKey);
    executeToolCall(target);
  }, 2000);
})();
