const botsEl = document.getElementById("bots");
const threadEl = document.getElementById("thread");
const streamingEl = document.getElementById("streaming");
const titleEl = document.getElementById("title");
const connectionEl = document.getElementById("connection");
const toggleComputerBtn = document.getElementById("toggle-computer");
const computerPanel = document.getElementById("computer");
const screenImg = document.getElementById("screen");
const screenEmpty = document.getElementById("screen-empty");
const localStatusEl = document.getElementById("local-status");
const computerErrorEl = document.getElementById("computer-error");

const state = {
  bots: [],
  messages: {},
  streaming: {},
  reasoning: {},
  screens: {},
  activeBotId: null,
  computerOpen: false,
  localComputer: null,
};

function activeBot() {
  return state.bots.find((bot) => bot.id === state.activeBotId) ?? null;
}

function toolLabel(tool) {
  if (!tool) return "an action";
  const bare = tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ");
  const nice = {
    Bash: "run a command",
    Read: "read a file",
    Write: "write a file",
    Edit: "edit a file",
    WebFetch: "fetch a web page",
    WebSearch: "search the web",
  };
  return nice[tool] ?? bare;
}

function isRefusal(choice) {
  return choice.trim().toLowerCase() === "deny";
}

function responseBehavior(choice, isPermission) {
  if (!isPermission) return "answer";
  return isRefusal(choice) ? "deny" : "allow";
}

function shouldRememberPermission(card, choice) {
  if (!card.tool || !card.allowKey) return false;
  return choice.trim().toLowerCase() === "always allow";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function hydrateFleet(fleet) {
  state.bots = fleet.bots ?? [];
  state.messages = {};
  for (const bot of state.bots) {
    state.messages[bot.threadId] = bot.messages ?? [];
  }
  renderBots();
  const bot = activeBot() ?? state.bots[0];
  if (bot) selectBot(bot, { skipFetch: true });
}

function renderBots() {
  botsEl.innerHTML = "";
  if (!state.bots.length) {
    botsEl.textContent = "No bots.";
    botsEl.classList.add("empty");
    return;
  }
  botsEl.classList.remove("empty");
  for (const bot of state.bots) {
    const button = document.createElement("button");
    button.className = `bot${bot.id === state.activeBotId ? " active" : ""}`;
    button.textContent = `${bot.busy ? "● " : ""}${bot.name}${bot.title ? ` — ${bot.title}` : ""}`;
    button.onclick = () => selectBot(bot);
    botsEl.appendChild(button);
  }
}

function renderThread() {
  const bot = activeBot();
  if (!bot) {
    titleEl.textContent = "Select a bot";
    threadEl.innerHTML = "";
    streamingEl.hidden = true;
    return;
  }

  titleEl.textContent = bot.name;
  const messages = state.messages[bot.threadId] ?? [];
  threadEl.innerHTML = "";

  if (!messages.length) {
    threadEl.innerHTML = '<p class="empty">No messages yet.</p>';
  } else {
    for (const message of messages) {
      if (message.kind === "options" && message.card) {
        threadEl.appendChild(renderApprovalCard(bot, message));
        continue;
      }
      const block = document.createElement("div");
      block.className = "msg";
      const text = message.text ?? message.card?.subtitle ?? "";
      block.innerHTML = `<div class="role">${escapeHtml(message.role ?? "message")}</div><div>${escapeHtml(text)}</div>`;
      threadEl.appendChild(block);
    }
  }

  const tail = state.streaming[bot.threadId];
  const think = state.reasoning[bot.threadId];
  if (tail || think) {
    streamingEl.hidden = false;
    streamingEl.innerHTML = "";
    if (think) {
      const block = document.createElement("div");
      block.className = "streaming";
      block.innerHTML = `<div class="label">Reasoning</div>${escapeHtml(think)}`;
      streamingEl.appendChild(block);
    }
    if (tail) {
      const block = document.createElement("div");
      block.className = "streaming";
      block.innerHTML = `<div class="label">Replying…</div>${escapeHtml(tail)}`;
      streamingEl.appendChild(block);
    }
    streamingEl.scrollIntoView({ block: "end", behavior: "smooth" });
  } else {
    streamingEl.hidden = true;
    streamingEl.innerHTML = "";
  }
}

function renderApprovalCard(bot, message) {
  const card = message.card;
  const settled = card.answered;
  const pending = card.requestId && !settled && card.dismissed !== true;
  const wrap = document.createElement("div");
  wrap.className = `approval${settled ? " settled" : ""}`;
  wrap.innerHTML = `
    <h3>${escapeHtml(bot.name)} wants to ${escapeHtml(toolLabel(card.tool))}</h3>
    ${card.tool ? `<div class="role">${escapeHtml(card.tool)}</div>` : ""}
    <pre>${escapeHtml(card.subtitle ?? "")}</pre>
    ${card.held ? `<div class="held">${escapeHtml(card.held)}</div>` : ""}
  `;

  if (pending) {
    const actions = document.createElement("div");
    actions.className = "actions";
    for (const option of card.options ?? ["Allow", "Deny"]) {
      const btn = document.createElement("button");
      const deny = isRefusal(option);
      btn.className = deny ? "deny" : "allow";
      btn.textContent = option;
      btn.onclick = () => answerApproval(bot, message, option);
      actions.appendChild(btn);
    }
    wrap.appendChild(actions);
  } else {
    const status = document.createElement("div");
    status.className = "status";
    if (settled === "allow") status.textContent = "Allowed";
    else if (settled) status.textContent = "Denied";
    else status.textContent = "Waiting for your answer";
    wrap.appendChild(status);
  }

  return wrap;
}

async function answerApproval(bot, message, choice) {
  const card = message.card;
  if (!card?.requestId) return;
  try {
    if (shouldRememberPermission(card, choice)) {
      await window.viewer.alwaysAllow(bot.id, card.allowKey);
    }
    const behavior = responseBehavior(choice, Boolean(card.tool));
    await window.viewer.respond(
      bot.threadId,
      card.requestId,
      behavior,
      behavior === "answer" ? choice : undefined,
    );
  } catch (error) {
    connectionEl.textContent = error.message;
    connectionEl.classList.remove("live");
  }
}

function renderComputer() {
  const bot = activeBot();
  if (!state.computerOpen || !bot) return;

  const frame = state.screens[bot.id];
  if (frame?.png) {
    const mime = frame.mime ?? "image/png";
    screenImg.src = `data:${mime};base64,${frame.png}`;
    screenImg.hidden = false;
    screenEmpty.hidden = true;
  } else {
    screenImg.hidden = true;
    screenEmpty.hidden = false;
  }

  const lc = state.localComputer;
  if (!lc) {
    localStatusEl.innerHTML = '<div class="empty">Loading status…</div>';
    return;
  }

  const rows = [
    ["Runtime", lc.runtime ?? "unknown"],
    ["Container", lc.container ?? "unknown"],
    ["Mode", lc.mode ?? "—"],
    ["Problem", lc.problem ?? "—"],
  ];
  localStatusEl.innerHTML = rows
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}:</dt><dd>${escapeHtml(String(value))}</dd></div>`)
    .join("");
}

async function refreshLocalComputer() {
  const bot = activeBot();
  if (!bot || !state.computerOpen) return;
  computerErrorEl.hidden = true;
  try {
    state.localComputer = await window.viewer.localComputer(bot.id);
    renderComputer();
  } catch (error) {
    state.localComputer = null;
    computerErrorEl.textContent = error.message;
    computerErrorEl.hidden = false;
    renderComputer();
  }
}

async function setComputerOpen(open) {
  state.computerOpen = open;
  document.body.classList.toggle("computer-open", open);
  toggleComputerBtn.textContent = open ? "Hide computer" : "Computer";
  await window.viewer.setScreens(open);
  if (open) {
    await refreshLocalComputer();
    renderComputer();
  } else {
    const bot = activeBot();
    if (bot) delete state.screens[bot.id];
  }
}

async function selectBot(bot, { skipFetch = false } = {}) {
  state.activeBotId = bot.id;
  renderBots();
  if (!skipFetch && !state.messages[bot.threadId]?.length) {
    try {
      const page = await window.viewer.messages(bot.threadId);
      state.messages[bot.threadId] = page.messages ?? [];
    } catch (error) {
      connectionEl.textContent = error.message;
      connectionEl.classList.remove("live");
    }
  }
  renderThread();
  if (state.computerOpen) {
    await refreshLocalComputer();
    renderComputer();
  }
}

function upsertMessage(threadId, message) {
  const thread = state.messages[threadId] ?? [];
  const index = thread.findIndex((m) => m.id === message.id);
  if (index >= 0) thread[index] = message;
  else thread.push(message);
  state.messages[threadId] = thread;
}

function clearStream(threadId) {
  delete state.streaming[threadId];
  delete state.reasoning[threadId];
}

function applyEvent(frame) {
  switch (frame.kind) {
    case "hello":
      connectionEl.textContent = frame.resumed ? "Live (resumed)" : "Live (hydrated)";
      connectionEl.classList.add("live");
      break;

    case "message": {
      const { threadId, message } = frame;
      if (!threadId || !message) break;
      upsertMessage(threadId, message);
      if (message.role === "bot" && message.kind === "text") clearStream(threadId);
      const bot = state.bots.find((b) => b.threadId === threadId);
      if (bot) {
        const index = state.bots.findIndex((b) => b.id === bot.id);
        if (index >= 0) state.bots[index] = { ...state.bots[index], activeLeafId: message.id };
      }
      break;
    }

    case "message.patch": {
      const { threadId, message } = frame;
      if (!threadId || !message) break;
      upsertMessage(threadId, message);
      break;
    }

    case "bot": {
      const bot = frame.bot;
      if (!bot) break;
      const index = state.bots.findIndex((b) => b.id === bot.id);
      if (index >= 0) {
        const prev = state.bots[index];
        state.bots[index] = { ...prev, ...bot, messages: bot.messages ?? prev.messages };
        if (bot.messages) {
          state.messages[bot.threadId] = bot.messages;
          clearStream(prev.threadId);
        }
      } else {
        state.bots.push(bot);
        state.messages[bot.threadId] = bot.messages ?? [];
      }
      break;
    }

    case "bot.deleted": {
      const botId = frame.botId;
      const index = state.bots.findIndex((b) => b.id === botId);
      if (index >= 0) {
        const threadId = state.bots[index].threadId;
        state.bots.splice(index, 1);
        delete state.messages[threadId];
        clearStream(threadId);
        delete state.screens[botId];
        if (state.activeBotId === botId) state.activeBotId = state.bots[0]?.id ?? null;
      }
      break;
    }

    case "runtime": {
      const event = frame.event;
      if (!event) break;
      if (event.type === "content.delta" && event.delta && event.threadId) {
        if (event.streamKind === "assistant_text") {
          state.streaming[event.threadId] = (state.streaming[event.threadId] ?? "") + event.delta;
        } else if (event.streamKind === "reasoning_text") {
          state.reasoning[event.threadId] = (state.reasoning[event.threadId] ?? "") + event.delta;
        }
      } else if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.aborted") {
        clearStream(event.threadId);
      }
      break;
    }

    case "screen": {
      const { botId, png, mime } = frame;
      if (botId && png) state.screens[botId] = { png, mime };
      break;
    }

    default:
      break;
  }

  renderBots();
  renderThread();
  if (state.computerOpen) renderComputer();
}

toggleComputerBtn.addEventListener("click", () => {
  void setComputerOpen(!state.computerOpen);
});

async function boot() {
  window.viewer.onEvent((frame) => applyEvent(frame));
  window.viewer.onHydrated((fleet) => hydrateFleet(fleet));
  window.viewer.onError((message) => {
    connectionEl.textContent = message;
    connectionEl.classList.remove("live");
  });

  try {
    const payload = await window.viewer.bots();
    hydrateFleet(payload);
  } catch (error) {
    botsEl.textContent = error.message;
  }
}

boot();
