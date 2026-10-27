const transcript = document.getElementById("transcript");
const statusLine = document.getElementById("status");
const form = document.getElementById("composer");
const input = document.getElementById("message");
const sendButton = document.getElementById("send");
const detailsToggle = document.getElementById("showDetails");
const chatTitle = document.getElementById("chatTitle");
const chatList = document.getElementById("chatList");
const newChatButton = document.getElementById("newChat");
let events = [];
let lastId = 0;
let knownActiveChatId = null;
let pollCount = 0;

detailsToggle.checked = localStorage.getItem("bridge-show-details") === "true";
detailsToggle.addEventListener("change", () => {
  localStorage.setItem("bridge-show-details", String(detailsToggle.checked));
  render();
});

function addText(parent, text, className) {
  const el = document.createElement("div");
  if (className) el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
}

function render() {
  transcript.replaceChildren();
  const visible = events.filter(event =>
    ["user", "assistant", "approval", "status"].includes(event.type) ||
    (detailsToggle.checked && ["tool_call", "tool_result"].includes(event.type))
  );
  if (!visible.some(event => event.type === "user" || event.type === "assistant")) {
    const welcome = document.createElement("div");
    welcome.className = "welcome";
    addText(welcome, "✦", "welcome-icon");
    addText(welcome, "Your local AI workspace", "welcome-title");
    addText(welcome, "Send a request. Gemini runs in the background and can use the tools allowed by your Python bridge.", "welcome-copy");
    transcript.appendChild(welcome);
  }
  for (const event of visible) {
    if (event.type === "status") {
      statusLine.textContent = event.content;
      continue;
    }
    if (event.type === "approval") {
      const card = document.createElement("article");
      card.className = "approval-card";
      addText(card, "Approval required", "approval-title");
      addText(card, event.tool.replaceAll("_", " "), "approval-tool");
      const pre = document.createElement("pre");
      pre.textContent = event.content;
      card.appendChild(pre);
      const actions = document.createElement("div");
      actions.className = "approval-actions";
      const reject = document.createElement("button");
      reject.className = "secondary";
      reject.textContent = "Reject";
      reject.addEventListener("click", () => decide(event.approval_id, false, card));
      const approve = document.createElement("button");
      approve.className = "primary";
      approve.textContent = "Approve";
      approve.addEventListener("click", () => decide(event.approval_id, true, card));
      actions.append(reject, approve);
      card.appendChild(actions);
      transcript.appendChild(card);
      continue;
    }
    const message = document.createElement("article");
    message.className = "message " + event.type;
    const role = event.type === "user" ? "You" :
      event.type === "assistant" ? "Gemini" :
      event.type === "tool_call" ? "Tool call" : "Tool result";
    addText(message, role, "message-label");
    addText(message, event.content, "message-content");
    transcript.appendChild(message);
  }
  transcript.scrollTop = transcript.scrollHeight;
}

async function refreshState() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) return;
    const state = await response.json();
    chatTitle.textContent = state.title;
    newChatButton.disabled = state.busy;
    sendButton.disabled = state.busy;
    chatList.replaceChildren();
    for (const chat of state.chats) {
      const button = document.createElement("button");
      button.className = "conversation" + (chat.id === state.active_chat_id ? " active" : "");
      button.title = chat.title;
      addText(button, "✦", "chat-icon");
      addText(button, chat.title, "chat-name");
      button.addEventListener("click", () => selectChat(chat.id));
      button.disabled = state.busy || chat.id === state.active_chat_id;
      chatList.appendChild(button);
    }
    if (knownActiveChatId !== null && knownActiveChatId !== state.active_chat_id) {
      events = [];
      lastId = 0;
      await loadCurrentTranscript();
    }
    knownActiveChatId = state.active_chat_id;
  } catch {}
}

async function loadCurrentTranscript() {
  try {
    const response = await fetch("/api/events?after=0");
    if (!response.ok) return;
    events = await response.json();
    lastId = events.length ? events[events.length - 1].id : 0;
    render();
  } catch {}
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

async function selectChat(id) {
  try {
    await postJson("/api/chat/select", {id});
    events = [];
    lastId = 0;
    await refreshState();
    await loadCurrentTranscript();
  } catch (error) {
    statusLine.textContent = error.message;
  }
}

newChatButton.addEventListener("click", async () => {
  try {
    await postJson("/api/chat/new", {});
    events = [];
    lastId = 0;
    await refreshState();
    render();
  } catch (error) {
    statusLine.textContent = error.message;
  }
});

async function decide(id, approved, card) {
  const buttons = card.querySelectorAll("button");
  buttons.forEach(button => button.disabled = true);
  try {
    const response = await fetch("/api/approval", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({id, approved})
    });
    if (!response.ok) throw new Error((await response.json()).error || "Could not send decision.");
    card.remove();
  } catch (error) {
    addText(card, error.message, "error");
    buttons.forEach(button => button.disabled = false);
  }
}

async function poll() {
  try {
    const response = await fetch("/api/events?after=" + lastId);
    if (!response.ok) throw new Error("Event request failed.");
    const incoming = await response.json();
    if (incoming.length) {
      events.push(...incoming);
      lastId = incoming[incoming.length - 1].id;
      render();
    }
  } catch {
    statusLine.textContent = "Disconnected from local app.";
  }
  pollCount += 1;
  if (pollCount % 7 === 0) refreshState();
  setTimeout(poll, 700);
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  sendButton.disabled = true;
  input.disabled = true;
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({text})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Message was not accepted.");
    input.value = "";
    input.style.height = "auto";
    refreshState();
  } catch (error) {
    events.push({id: lastId + 0.1, type: "assistant", content: "Could not send: " + error.message});
    render();
  } finally {
    sendButton.disabled = false;
    input.disabled = false;
    input.focus();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
});
input.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

refreshState();
poll();
