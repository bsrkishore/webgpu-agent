// ---------------------------
// CONFIG
// ---------------------------
const OLLAMA_BASE_URL = "https://lacier-costless-elisabeth.ngrok-free.dev";

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
// STATE MACHINE
// ---------------------------
const Stage = {
  Conversation: "Conversation",
  AwaitingYesNo: "AwaitingYesNo",
  AwaitingField: "AwaitingField",
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
  stage: Stage.Conversation,
  pendingField: null,
  pendingAction: null,
  pattern: null,
  collected: {},
  missing: []
};

function debugState(extra = {}) {
  updateDebug({
    stage: session.stage,
    pendingField: session.pendingField,
    pendingAction: session.pendingAction,
    pattern: session.pattern,
    collectedParams: session.collected,
    missingParams: session.missing,
    model: modelSelect.value,
    ...extra
  });
}

// ---------------------------
// OLLAMA STREAMING (NDJSON)
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
    const lines = chunk.split("\n").filter(l => l.trim() !== "");

    for (const line of lines) {
      try {
        const data = JSON.parse(line.trim());
        if (data.done) continue;

        const delta = data.message?.content || "";
        if (delta) {
          fullText += delta;
          agentMsg.textContent = fullText;
        }
      } catch {
        // ignore partial chunks
      }
    }
  }

  return fullText.trim();
}

// ---------------------------
// HYBRID FIELD DETECTION (F3 + C1)
// ---------------------------
async function detectField(text) {
  const t = text.toLowerCase();

  // Keyword detection first
  if (t.includes("email")) return "Email";
  if (t.includes("policy number")) return "PolicyNumber";
  if (t.includes("phone")) return "Phone";
  if (t.includes("address")) return "Address";

  // LLM fallback (P2 strict canonical)
  const prompt = `
Identify which field of the policy the user is referring to.

User: "${text}"

Respond with exactly one of:
Email, Phone, Address, PolicyNumber, Unknown.
`.trim();

  const out = await callLLMStreaming(prompt);
  const field = (out.split(/\s+/)[0] || "").trim();

  const canonical = ["Email", "Phone", "Address", "PolicyNumber", "Unknown"];
  return canonical.includes(field) ? field : "Unknown";
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
  return (out.split(/\s+/)[0] || "Unknown").trim();
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
// SQL GENERATION
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

function validateSql(sql) {
  const s = sql.toUpperCase();

  if (!s.startsWith("UPDATE")) return "Only UPDATE allowed.";
  if (!s.includes("WHERE")) return "WHERE clause required.";

  const forbidden = ["DELETE", "DROP", "ALTER", "INSERT", "TRUNCATE", "UNION", "--", "/*", "*/", "EXEC"];
  for (const f of forbidden) if (s.includes(f)) return `Forbidden keyword: ${f}`;

  if (!s.includes("POLICYHOLDER")) return "Only PolicyHolder table allowed.";
  if (!s.includes("EMAIL") || !s.includes("POLICYNUMBER"))
    return "Only Email and PolicyNumber columns allowed.";

  return null;
}

// ---------------------------
// CONVERSATION LAYER
// ---------------------------
function detectConversationMode(text) {
  const t = text.toLowerCase();

  const SMALL_TALK = ["hi", "hello", "hey", "yo", "how are you"];
  if (SMALL_TALK.some(p => t.includes(p))) return "smallTalk";

  const DOMAIN = ["policy", "email", "account"];
  const PROBLEM = ["wrong", "incorrect", "issue", "problem", "mismatch", "not right"];
  const ACTION = ["update", "change", "fix", "correct", "modify"];

  const hasDomain = DOMAIN.some(k => t.includes(k));
  const hasProblem = PROBLEM.some(k => t.includes(k));
  const hasAction = ACTION.some(k => t.includes(k));

  // If user mentions policy but no number → generic problem
  const hasPolicy = t.includes("policy");
  const hasNumber = /\d/.test(t);

  if (hasAction) return "action";
  if (hasDomain && hasProblem) return "domainProblem";
  if (hasPolicy && !hasNumber) return "genericProblem";
  if (hasDomain) return "genericProblem";

  return "unknown";
}

function isCapabilityQuestion(text) {
  const t = text.toLowerCase();
  return t.includes("what can you do") || t.includes("how can you help");
}

// ---------------------------
// STATE HANDLERS
// ---------------------------
async function handleIntent(text) {
  const pattern = await classifyIntent(text);

  if (pattern === "Unknown") {
    addMessage("I only support updating the email for a policy in this POC.", "agent");
    debugState({ note: "Unknown pattern from classifyIntent", raw: text });
    return;
  }

  session.pattern = pattern;
  const def = KNOWN_PATTERNS[pattern];

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
  const sql = await fillTemplate(def.sqlTemplate, session.collected);

  const error = validateSql(sql);
  if (error) {
    addMessage("SQL failed validation:\n" + error + "\n\nGenerated:\n" + sql, "agent");
  } else {
    addMessage("Here is your SQL:\n\n" + sql + "\n\n(POC only – do not run directly in prod.)", "agent");
  }

  session.stage = Stage.Conversation;
  session.pattern = null;
  session.collected = {};
  session.missing = [];
  session.pendingField = null;
  session.pendingAction = null;

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
    // Capability questions
    if (isCapabilityQuestion(text)) {
      addMessage(
        "Right now I can help with updating the email address for a policy and generating safe SQL for it.",
        "agent"
      );
      debugState({ note: "Capability question detected" });
      return;
    }

    // If we're in yes/no confirmation stage
    if (session.stage === Stage.AwaitingYesNo) {
      const t = text.toLowerCase();

      if (t === "yes" || t === "y") {
        // Option A: proceed with UpdateEmailForPolicy
        session.pattern = "UpdateEmailForPolicy";
        session.stage = Stage.AwaitingParams;
        addMessage("Sure — what's the policy number?", "agent");
        debugState({ note: "User confirmed yes to update" });
        return;
      }

      if (t === "no" || t === "n") {
        // Option N3: generic fallback
        session.stage = Stage.Conversation;
        session.pendingField = null;
        addMessage("No problem — what is wrong with the policy?", "agent");
        debugState({ note: "User declined update" });
        return;
      }

      // If they accidentally give useful info (policy number or email), treat as params
      if (/\d/.test(text) || text.includes("@")) {
        session.pattern = "UpdateEmailForPolicy";
        session.stage = Stage.AwaitingParams;
        await handleParams(text);
        return;
      }

      addMessage("Please answer yes or no.", "agent");
      return;
    }

    // If we're already collecting params
    if (session.stage === Stage.AwaitingParams) {
      await handleParams(text);
      return;
    }

    // Conversation mode
    const mode = detectConversationMode(text);

    if (mode === "smallTalk") {
      addMessage("Hi! What can I help you with today?", "agent");
      debugState({ note: "Small talk" });
      return;
    }

    if (mode === "genericProblem") {
      addMessage("What is wrong with the policy?", "agent");
      debugState({ note: "Generic problem detected" });
      return;
    }

    if (mode === "domainProblem") {
      // Try to detect field
      const field = await detectField(text);
      session.pendingField = field;

      if (field === "Unknown") {
        // Fallback to generic clarification
        session.stage = Stage.Conversation;
        addMessage("I can help with policy updates. What is wrong with the policy?", "agent");
        debugState({ note: "Domain problem but field unknown" });
        return;
      }

      // Ask yes/no confirmation (Option A)
      session.stage = Stage.AwaitingYesNo;
      addMessage(
        `It sounds like the ${field.toLowerCase()} on the policy is incorrect. Do you want to update it?`,
        "agent"
      );
      debugState({ note: "Domain problem with field", field });
      return;
    }

    if (mode === "action") {
      await handleIntent(text);
      return;
    }

    // Fallback for unknown
    addMessage("Can you tell me more about the issue with the policy?", "agent");
    debugState({ note: "Unknown conversation mode", text });

  } catch (err) {
    addMessage("Error: " + err.message, "agent");
    debugState({ error: err.message, stack: err.stack });
  } finally {
    setInputEnabled(true);
  }
}

// ---------------------------
// EVENTS
// ---------------------------
sendBtn.addEventListener("click", handleUserMessage);
inputEl.addEventListener("keypress", e => {
  if (e.key === "Enter") handleUserMessage();
});
