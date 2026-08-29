const botsEl = document.getElementById("bots");
const roomsEl = document.getElementById("rooms");
const bridgesEl = document.getElementById("bridges");
const threadEl = document.getElementById("thread");
const streamingEl = document.getElementById("streaming");
const titleEl = document.getElementById("title");
const connectionEl = document.getElementById("connection");
const toggleComputerBtn = document.getElementById("toggle-computer");
const interruptBtn = document.getElementById("interrupt");
const modelPicker = document.getElementById("model-picker");
const composer = document.getElementById("composer");
const composerText = document.getElementById("composer-text");
const computerPanel = document.getElementById("computer");
const screenImg = document.getElementById("screen");
const screenEmpty = document.getElementById("screen-empty");
const localStatusEl = document.getElementById("local-status");
const computerErrorEl = document.getElementById("computer-error");

const state = {
  bots: [],
  groups: [],
  bridges: [],
  instances: [],
  messages: {},
  streaming: {},
  reasoning: {},
  screens: {},
  activeKind: "bot",
  activeBotId: null,
  activeRoomId: null,
  computerOpen: false,
  localComputer: null,
};

function activeBot() {
  return state.bots.find((bot) => bot.id === state.activeBotId) ?? null;
}

function activeRoom() {
  return state.groups.find((group) => group.id === state.activeRoomId) ?? null;
}

function activeThreadId() {
  if (state.activeKind === "room") return activeRoom()?.threadId ?? null;
  return activeBot()?.threadId ?? null;
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
    run_on_bridge: "run a command on a home bridge",
    run_on_ssh_target: "run a command over SSH",
    observe_bridge_screen: "observe a bridge screen",
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
  state.groups = fleet.groups ?? [];
  state.messages = {};
  for (const bot of state.bots) {
    state.messages[bot.threadId] = bot.messages ?? [];
  }
  for (const group of state.groups) {
    state.messages[group.threadId] = group.messages ?? [];
  }
  renderBots();
  renderRooms();
  const bot = activeBot() ?? state.bots[0];
  if (bot) selectBot(bot, { skipFetch: true });
  else if (state.groups[0]) selectRoom(state.groups[0], { skipFetch: true });
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
    button.className = `bot${state.activeKind === "bot" && bot.id === state.activeBotId ? " active" : ""}`;
    button.textContent = `${bot.busy ? "● " : ""}${bot.name}${bot.title ? ` — ${bot.title}` : ""}`;
    button.onclick = () => selectBot(bot);
    botsEl.appendChild(button);
  }
}

function renderRooms() {
  roomsEl.innerHTML = "";
  if (!state.groups.length) {
    roomsEl.textContent = "No rooms.";
    roomsEl.classList.add("empty");
    return;
  }
  roomsEl.classList.remove("empty");
  for (const group of state.groups) {
    const button = document.createElement("button");
    button.className = `bot${state.activeKind === "room" && group.id === state.activeRoomId ? " active" : ""}`;
    button.textContent = `${group.busyBotId ? "● " : ""}${group.name}`;
    button.onclick = () => selectRoom(group);
    roomsEl.appendChild(button);
  }
}

function renderBridges() {
  bridgesEl.innerHTML = "";
  if (!state.bridges.length) {
    bridgesEl.textContent = "No paired bridges.";
    bridgesEl.classList.add("empty");
    return;
  }
  bridgesEl.classList.remove("empty");
  for (const bridge of state.bridges) {
    const wrap = document.createElement("div");
    wrap.className = "bridge";
    const caps = (bridge.capabilities ?? []).join(", ") || "no capabilities";
    wrap.innerHTML = `<strong>${escapeHtml(bridge.name)}</strong>
      <div class="meta">${bridge.online ? "Online" : "Offline"} · ${escapeHtml(caps)}</div>`;
    const row = document.createElement("div");
    row.className = "row";
    const rotate = document.createElement("button");
    rotate.textContent = "Rotate";
    rotate.onclick = () => mutateBridge("rotate", bridge.id);
    const revoke = document.createElement("button");
    revoke.textContent = "Revoke";
    revoke.onclick = () => {
      if (confirm(`Revoke ${bridge.name}? The daemon must re-pair.`)) mutateBridge("revoke", bridge.id);
    };
    row.append(rotate, revoke);
    wrap.appendChild(row);
    bridgesEl.appendChild(wrap);
  }
}

function renderModelPicker() {
  const bot = state.activeKind === "bot" ? activeBot() : null;
  if (!bot || !state.instances.length) {
    modelPicker.hidden = true;
    return;
  }
  modelPicker.hidden = false;
  modelPicker.innerHTML = "";
  for (const instance of state.instances) {
    for (const option of instance.models?.options ?? []) {
      const opt = document.createElement("option");
      opt.value = `${instance.instanceId}::${option.id}`;
      opt.textContent = `${instance.instanceId} / ${option.id}`;
      if (bot.modelSelection?.instanceId === instance.instanceId && bot.modelSelection?.model === option.id) {
        opt.selected = true;
      }
      modelPicker.appendChild(opt);
    }
  }
}

function renderToolbar() {
  const bot = activeBot();
  const room = activeRoom();
  interruptBtn.hidden = !(state.activeKind === "bot" ? bot?.busy : room?.busyBotId);
  composer.hidden = !(bot || room);
  renderModelPicker();
}

function renderThread() {
  const bot = activeBot();
  const room = activeRoom();
  const owner = state.activeKind === "room" ? room : bot;
  if (!owner) {
    titleEl.textContent = "Select a bot";
    threadEl.innerHTML = "";
    streamingEl.hidden = true;
    renderToolbar();
    return;
  }

  titleEl.textContent = owner.name;
  const messages = state.messages[owner.threadId] ?? [];
  threadEl.innerHTML = "";

  if (!messages.length) {
    threadEl.innerHTML = '<p class="empty">No messages yet.</p>';
  } else {
    for (const message of messages) {
      if (message.kind === "options" && message.card) {
        threadEl.appendChild(renderApprovalCard(bot ?? { name: owner.name, id: "", threadId: owner.threadId }, message));
        continue;
      }
      const block = document.createElement("div");
      block.className = "msg";
      const text = message.text ?? message.card?.subtitle ?? "";
      block.innerHTML = `<div class="role">${escapeHtml(message.role ?? "message")}</div><div>${escapeHtml(text)}</div>`;
      threadEl.appendChild(block);
    }
  }

  const tail = state.streaming[owner.threadId];
  const think = state.reasoning[owner.threadId];
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
  renderToolbar();
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
    if (shouldRememberPermission(card, choice) && bot.id) {
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

async function selectConversation(kind, owner, { skipFetch = false } = {}) {
  state.activeKind = kind;
  if (kind === "bot") {
    state.activeBotId = owner.id;
    state.activeRoomId = null;
  } else {
    state.activeRoomId = owner.id;
    state.activeBotId = null;
  }
  renderBots();
  renderRooms();
  if (!skipFetch && !state.messages[owner.threadId]?.length) {
    try {
      const page = await window.viewer.messages(owner.threadId);
      state.messages[owner.threadId] = page.messages ?? [];
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

function selectBot(bot, opts) {
  return selectConversation("bot", bot, opts);
}

function selectRoom(room, opts) {
  return selectConversation("room", room, opts);
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

    case "group": {
      const group = frame.group;
      if (!group) break;
      const index = state.groups.findIndex((g) => g.id === group.id);
      if (index >= 0) {
        const prev = state.groups[index];
        state.groups[index] = { ...prev, ...group, messages: group.messages ?? prev.messages };
        if (group.messages) state.messages[group.threadId] = group.messages;
      } else {
        state.groups.push(group);
        state.messages[group.threadId] = group.messages ?? [];
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
        if (state.activeBotId === botId) {
          state.activeBotId = state.bots[0]?.id ?? null;
          state.activeKind = state.activeBotId ? "bot" : state.groups[0] ? "room" : "bot";
          state.activeRoomId = state.activeBotId ? null : state.groups[0]?.id ?? null;
        }
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
  renderRooms();
  renderThread();
  if (state.computerOpen) renderComputer();
}

async function refreshBridges() {
  try {
    const payload = await window.viewer.bridges();
    state.bridges = payload.bridges ?? [];
    renderBridges();
  } catch (error) {
    bridgesEl.textContent = error.message;
    bridgesEl.classList.add("empty");
  }
}

async function mutateBridge(action, id) {
  try {
    if (action === "revoke") await window.viewer.revokeBridge(id);
    else await window.viewer.rotateBridge(id);
    await refreshBridges();
  } catch (error) {
    connectionEl.textContent = error.message;
    connectionEl.classList.remove("live");
  }
}

async function refreshInstances() {
  try {
    const payload = await window.viewer.instances();
    state.instances = payload.instances ?? [];
    renderModelPicker();
  } catch {
    /* catalog is optional for a read-only reconnect */
  }
}

toggleComputerBtn.addEventListener("click", () => {
  void setComputerOpen(!state.computerOpen);
});

interruptBtn.addEventListener("click", async () => {
  try {
    if (state.activeKind === "room" && state.activeRoomId) await window.viewer.interruptRoom(state.activeRoomId);
    else if (state.activeBotId) await window.viewer.interruptBot(state.activeBotId);
  } catch (error) {
    connectionEl.textContent = error.message;
    connectionEl.classList.remove("live");
  }
});

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = composerText.value.trim();
  if (!text) return;
  try {
    if (state.activeKind === "room" && state.activeRoomId) {
      await window.viewer.sendRoom(state.activeRoomId, text);
    } else if (state.activeBotId) {
      await window.viewer.sendBot(state.activeBotId, text);
    }
    composerText.value = "";
  } catch (error) {
    connectionEl.textContent = error.message;
    connectionEl.classList.remove("live");
  }
});

modelPicker.addEventListener("change", async () => {
  const bot = activeBot();
  if (!bot) return;
  const [instanceId, model] = modelPicker.value.split("::");
  try {
    await window.viewer.patchModel(bot.id, { instanceId, model });
  } catch (error) {
    connectionEl.textContent = error.message;
    connectionEl.classList.remove("live");
  }
});

for (const [id, action] of [
  ["vm-run", "run"],
  ["vm-stop", "stop"],
  ["vm-recreate", "recreate"],
]) {
  document.getElementById(id).addEventListener("click", async () => {
    const bot = activeBot();
    if (!bot) return;
    computerErrorEl.hidden = true;
    try {
      state.localComputer = await window.viewer.localVmAction(bot.id, action);
      renderComputer();
    } catch (error) {
      computerErrorEl.textContent = error.message;
      computerErrorEl.hidden = false;
    }
  });
}

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
  await Promise.all([refreshBridges(), refreshInstances()]);
}

boot();
