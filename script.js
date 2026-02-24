// ---------------------------
// CONFIG
// ---------------------------
const OLLAMA_BASE_URL = "https://lacier-costless-elisabeth.ngrok-free.dev"; // e.g. "https://a1b2c3d4.ngrok-free.app"

// ---------------------------
// UI ELEMENTS
// ---------------------------
const messagesDiv = document.getElementById("messages");
const inputEl = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const modelSelect = document.getElementById("model-select");
const debugEl = document.getElementById("debug-content");

// ---------------------------
// DEBUG
// ---------------------------
function updateDebug(info) {
  debugEl.textContent = JSON.stringify(info, null, 2);
}

// ---------------------------
// MESSAGES
// ---------------------------
function addMessage(text, sender) {
  const msg = document.createElement("div");
  msg.classList.add("message", sender);
  msg.textContent = text;
  messagesDiv.appendChild(msg);
  msg.scrollIntoView({ behavior: "smooth" });
  return msg;
}

function setInputEnabled(enabled) {
  inputEl.disabled = !enabled;
  sendBtn.disabled = !enabled;
}

// ---------------------------
// SESSION / STATE MACHINE
// ---------------------------
const Stage = {
  AwaitingIntent: "AwaitingIntent",
  AwaitingParams: "AwaitingParams",
  ReadyToGenerateSql: "ReadyToGenerateSql"
};

const KNOWN_PATTERNS = {
  UpdateEmailForPolicy: {
    requiredParams: ["PolicyNumber", "NewEmail"],
    sqlTemplate: "UPDATE PolicyHolder SET Email = @NewEmail WHERE PolicyNumber = @PolicyNumber;"
  }
};

const session = {
  stage: Stage.AwaitingIntent,
  pattern: null,
  collected: {},
  missing: []
};

function debugState(extra = {}) {
  updateDebug({
    status: "OK",
    stage: session.stage,
    pattern: session.pattern,
    collectedParams: session.collected,
    missingParams: session.missing,
    model: modelSelect.value,
    ...extra
  });
}

// ---------------------------
// OLLAMA STREAMING CALL (NDJSON format)
// ---------------------------
async function callLLMStreaming(prompt) {
  const model = modelSelect.value;

  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: "system", content: "You are a precise assistant for production support workflows." },
        { role: "user", content: prompt }
      ]
    })
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`LLM HTTP error ${response.status}: ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let fullText = "";

  const agentMsg = addMessage("", "agent");

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });

    // Ollama streams NDJSON lines, no "data:" prefix
    const lines = chunk.split("\n").filter(l => l.trim() !== "");

    for (const line of lines) {
      const jsonStr = line.trim();
      if (!jsonStr) continue;

      try {
        const data = JSON.parse(jsonStr);

        // Ollama format: { message: { role, content }, done?: boolean }
        if (data.done) {
          continue;
        }

        const delta = data.message?.content || "";
        if (delta) {
          fullText += delta;
          agentMsg.textContent = fullText;
        }
      } catch {
        // ignore parse errors on partial chunks
      }
    }
  }

  return fullText.trim();
}

// ---------------------------
// INTENT CLASSIFICATION
// ---------------------------
async function classifyIntent(text) {
  const prompt = `
Match the user request to one pattern:

1. UpdateEmailForPolicy: update email for a policy number.

User: "${text}"

Respond ONLY with the pattern name or "Unknown".
`.trim();

  const out = await callLLMStreaming(prompt);
  const token = out.split(/\s+/)[0] || "";
  return token.replace(/[^A-Za-z0-9_]/g, "");
}

// ---------------------------
// PARAMETER EXTRACTION
// ---------------------------
async function extractParams(pattern, text) {
  const prompt = `
Extract parameters for pattern ${pattern}.

Required: PolicyNumber, NewEmail

User: "${text}"

Return JSON only.
`.trim();

  const out = await callLLMStreaming(prompt);

  try {
    const start = out.indexOf("{");
    const end = out.lastIndexOf("}");
    if (start === -1 || end === -1) return {};
    return JSON.parse(out.slice(start, end + 1));
  } catch {
    return {};
  }
}

// ---------------------------
// SQL TEMPLATE FILLING
// ---------------------------
async function fillTemplate(template, params) {
  const prompt = `
Fill this SQL template:

${template}

Parameters:
${JSON.stringify(params)}

Return ONLY the SQL.
`.trim();

  return await callLLMStreaming(prompt);
}

// ---------------------------
// SQL VALIDATION
// ---------------------------
function validateSql(sql) {
  const s = sql.toUpperCase();

  if (!s.startsWith("UPDATE")) return "Only UPDATE allowed.";
  if (!s.includes("WHERE")) return "WHERE clause required.";

  const forbidden = ["DELETE", "DROP", "ALTER", "INSERT", "TRUNCATE", "UNION", "--", "/*", "*/", "EXEC"];
  for (const f of forbidden) if (s.includes(f)) return `Forbidden keyword: ${f}`;

  if (!s.includes("POLICYHOLDER")) return "Only PolicyHolder table allowed.";
  if (!s.includes("EMAIL") || !s.includes("POLICYNUMBER"))
    return "Only Email and PolicyNumber columns allowed.";

  if (s.includes(" LIKE ") || s.includes(" IN ") || s.includes(" BETWEEN "))
    return "Pattern does not allow multi-row updates.";

  return null;
}

// ---------------------------
// STATE HANDLERS
// ---------------------------
async function handleIntent(text) {
  const pattern = await classifyIntent(text);

  if (!pattern || pattern === "Unknown") {
    addMessage("I only support updating email for a policy in this POC.", "agent");
    debugState({ note: "Unknown or empty pattern", rawPattern: pattern });
    return;
  }

  session.pattern = pattern;
  const def = KNOWN_PATTERNS[pattern];

  if (!def) {
    addMessage(`Pattern "${pattern}" is not configured in this POC.`, "agent");
    debugState({ note: "Pattern not found in KNOWN_PATTERNS", rawPattern: pattern });
    session.pattern = null;
    return;
  }

  const extracted = await extractParams(pattern, text);
  session.collected = extracted;
  session.missing = def.requiredParams.filter(p => !session.collected[p]);

  if (session.missing.length > 0) {
    session.stage = Stage.AwaitingParams;
    addMessage("I need:\n" + session.missing.join("\n"), "agent");
  } else {
    session.stage = Stage.ReadyToGenerateSql;
    await handleSql();
  }

  debugState();
}

async function handleParams(text) {
  const def = KNOWN_PATTERNS[session.pattern];

  if (!def) {
    addMessage("Internal state error: pattern definition missing. Resetting session.", "agent");
    session.stage = Stage.AwaitingIntent;
    session.pattern = null;
    session.collected = {};
    session.missing = [];
    debugState({ error: "Missing pattern definition in handleParams" });
    return;
  }

  const extracted = await extractParams(session.pattern, text);
  session.collected = { ...session.collected, ...extracted };

  session.missing = def.requiredParams.filter(p => !session.collected[p]);

  if (session.missing.length > 0) {
    addMessage("Still missing:\n" + session.missing.join("\n"), "agent");
  } else {
    session.stage = Stage.ReadyToGenerateSql;
    await handleSql();
  }

  debugState();
}

async function handleSql() {
  const def = KNOWN_PATTERNS[session.pattern];

  if (!def) {
    addMessage("Internal state error: pattern definition missing during SQL generation. Resetting session.", "agent");
    session.stage = Stage.AwaitingIntent;
    session.pattern = null;
    session.collected = {};
    session.missing = [];
    debugState({ error: "Missing pattern definition in handleSql" });
    return;
  }

  const sql = await fillTemplate(def.sqlTemplate, session.collected);

  const error = validateSql(sql);
  if (error) {
    addMessage("SQL failed validation:\n" + error + "\n\nGenerated:\n" + sql, "agent");
  } else {
    addMessage("Here is your SQL:\n\n" + sql + "\n\n(POC only – do not run directly in prod.)", "agent");
  }

  session.stage = Stage.AwaitingIntent;
  session.pattern = null;
  session.collected = {};
  session.missing = [];

  debugState({ note: "Session reset after SQL" });
}

// ---------------------------
// MAIN HANDLER
// ---------------------------
async function handleUserMessage() {
  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = "";
  addMessage(text, "user");

  setInputEnabled(false);
  try {
    if (session.stage === Stage.AwaitingIntent) {
      await handleIntent(text);
    } else if (session.stage === Stage.AwaitingParams) {
      await handleParams(text);
    }
  } catch (err) {
    addMessage("Error: " + err.message, "agent");
    debugState({ error: err.message, stack: err.stack });
  } finally {
    setInputEnabled(true);
  }
}

// ---------------------------
// CONNECTION TEST (safe version)
// ---------------------------
async function testConnection() {
  try {
    // Ollama accepts POST to /api/tags; this plays nicer with some ngrok setups
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    const data = await res.json();
    updateDebug({
      status: "Connected to local LLM",
      models: data.models?.map(m => m.name)
    });
  } catch (err) {
    updateDebug({
      status: "Cannot reach local LLM",
      error: err.message,
      hint: "Check ngrok is running and URL is correct."
    });
  }
}

// Uncomment if you want the connection test to run on load
// testConnection();

// ---------------------------
// EVENTS
// ---------------------------
sendBtn.addEventListener("click", handleUserMessage);
inputEl.addEventListener("keypress", e => {
  if (e.key === "Enter") handleUserMessage();
});
