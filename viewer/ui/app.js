const botsEl = document.getElementById("bots");
const threadEl = document.getElementById("thread");
const titleEl = document.getElementById("title");
let activeId = null;

function renderBots(bots) {
  botsEl.innerHTML = "";
  botsEl.classList.remove("empty");
  for (const bot of bots) {
    const button = document.createElement("button");
    button.className = `bot${bot.id === activeId ? " active" : ""}`;
    button.textContent = `${bot.busy ? "● " : ""}${bot.name}${bot.title ? ` — ${bot.title}` : ""}`;
    button.onclick = () => selectBot(bot);
    botsEl.appendChild(button);
  }
}

function renderMessages(bot, messages) {
  titleEl.textContent = bot.name;
  threadEl.innerHTML = "";
  if (!messages.length) {
    threadEl.innerHTML = '<p class="empty">No messages yet.</p>';
    return;
  }
  for (const message of messages) {
    const block = document.createElement("div");
    block.className = "msg";
    block.innerHTML = `<div class="role">${message.role ?? "message"}</div><div>${escapeHtml(message.text ?? "")}</div>`;
    threadEl.appendChild(block);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function selectBot(bot) {
  activeId = bot.id;
  const payload = await window.viewer.bots();
  renderBots(payload.bots ?? []);
  const messages = await window.viewer.messages(bot.id);
  renderMessages(bot, messages.messages ?? []);
}

async function boot() {
  try {
    const payload = await window.viewer.bots();
    const bots = payload.bots ?? [];
    renderBots(bots);
    if (bots[0]) await selectBot(bots[0]);
  } catch (error) {
    botsEl.textContent = error.message;
  }
}

boot();
