// script.js (type="module")

import * as webllm from "https://esm.run/@mlc-ai/web-llm";

// ---------------------------
// UI Elements
// ---------------------------
const messagesDiv = document.getElementById("messages");
const inputEl = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");

function addMessage(text, sender) {
  const msg = document.createElement("div");
  msg.classList.add("message", sender);
  msg.textContent = text;
  messagesDiv.appendChild(msg);
  msg.scrollIntoView({ behavior: "smooth" });
}

function setInputEnabled(enabled) {
  inputEl.disabled = !enabled;
  sendBtn.disabled = !enabled;
}

// ---------------------------
// WebLLM Initialization
// ---------------------------
let engine = null;
let engineReady = false;

async function initLLM() {
  addMessage("Loading local LLM in your browser (WebGPU)...", "system");
  setInputEnabled(false);

  const model = "Llama-3.2-3B-Instruct-q4f32_1";

  engine = await webllm.CreateMLCEngine(model, {
    initProgressCallback: (p) => {
      // Optional: show progress
    }
  });

  engineReady = true;
  addMessage("LLM ready. You can start typing.", "system");
  setInputEnabled(true);
}

initLLM();

// ---------------------------
// LLM Wrapper
// ---------------------------
async function callLLM(prompt) {
  const res = await engine.chat.completions.create({
    messages: [
      { role: "system", content: "You are a precise assistant for production support workflows." },
      { role: "user", content: prompt }
    ],
    temperature: 0.1,
    max_tokens: 256
  });

  return res.choices[0].message.content.trim();
}

// ---------------------------
// Patterns
// ---------------------------
const KNOWN_PATTERNS = {
  UpdateEmailForPolicy: {
    requiredParams: ["PolicyNumber", "NewEmail"],
    sqlTemplate: "UPDATE PolicyHolder SET Email = @NewEmail WHERE PolicyNumber = @PolicyNumber;"
  }
};

// ---------------------------
// Session State
// ---------------------------
const Stage = {
  AwaitingIntent: "AwaitingIntent",
  AwaitingParams: "AwaitingParams",
  ReadyToGenerateSql: "ReadyToGenerateSql"
};

const session = {
  pattern: null,
  collected: {},
  missing: [],
  stage: Stage.AwaitingIntent
};

// ---------------------------
// Intent Classification
// ---------------------------
async function classifyIntent(text) {
  const prompt = `
Match the user request to one pattern:

1. UpdateEmailForPolicy: update email for a policy number.

User: "${text}"

Respond ONLY with the pattern name or "Unknown".
  `.trim();

  return (await callLLM(prompt)).split(/\s+/)[0];
}

// ---------------------------
// Parameter Extraction
// ---------------------------
async function extractParams(pattern, text) {
  const prompt = `
Extract parameters for pattern ${pattern}.

Required: PolicyNumber, NewEmail

User: "${text}"

Return JSON only.
  `.trim();

  try {
    const out = await callLLM(prompt);
    const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// ---------------------------
// SQL Template Filling
// ---------------------------
async function fillTemplate(template, params) {
  const prompt = `
Fill this SQL template:

${template}

Parameters:
${JSON.stringify(params)}

Return ONLY the SQL.
  `.trim();

  return await callLLM(prompt);
}

// ---------------------------
// SQL Validation
// ---------------------------
function validateSql(sql) {
  const s = sql.toUpperCase();

  if (!s.startsWith("UPDATE")) return "Only UPDATE allowed.";
  if (!s.includes("WHERE")) return "WHERE clause required.";

  const forbidden = ["DELETE", "DROP", "ALTER", "INSERT", "TRUNCATE", "UNION", "--", "/*"];
  for (const f of forbidden) if (s.includes(f)) return `Forbidden keyword: ${f}`;

  if (!s.includes("POLICYHOLDER")) return "Only PolicyHolder table allowed.";
  if (!s.includes("EMAIL") || !s.includes("POLICYNUMBER"))
    return "Only Email and PolicyNumber columns allowed.";

  return null;
}

// ---------------------------
// State Machine Handlers
// ---------------------------
async function handleIntent(text) {
  const pattern = await classifyIntent(text);

  if (pattern === "Unknown") {
    addMessage("I only support updating email for a policy in this POC.", "agent");
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
}

async function handleParams(text) {
  const extracted = await extractParams(session.pattern, text);
  session.collected = { ...session.collected, ...extracted };

  const def = KNOWN_PATTERNS[session.pattern];
  session.missing = def.requiredParams.filter(p => !session.collected[p]);

  if (session.missing.length > 0) {
    addMessage("Still missing:\n" + session.missing.join("\n"), "agent");
  } else {
    session.stage = Stage.ReadyToGenerateSql;
    await handleSql();
  }
}

async function handleSql() {
  const def = KNOWN_PATTERNS[session.pattern];
  const sql = await fillTemplate(def.sqlTemplate, session.collected);

  const error = validateSql(sql);
  if (error) {
    addMessage("SQL failed validation:\n" + error + "\n\nGenerated:\n" + sql, "agent");
  } else {
    addMessage("Here is your SQL:\n\n" + sql, "agent");
  }

  // Reset
  session.pattern = null;
  session.collected = {};
  session.missing = [];
  session.stage = Stage.AwaitingIntent;
}

// ---------------------------
// Main Handler
// ---------------------------
async function handleUserMessage() {
  const text = inputEl.value.trim();
  if (!text) return;

  inputEl.value = "";
  addMessage(text, "user");

  if (!engineReady) {
    addMessage("Model still loading...", "agent");
    return;
  }

  setInputEnabled(false);

  try {
    if (session.stage === Stage.AwaitingIntent) {
      await handleIntent(text);
    } else if (session.stage === Stage.AwaitingParams) {
      await handleParams(text);
    }
  } finally {
    setInputEnabled(true);
  }
}

sendBtn.addEventListener("click", handleUserMessage);
inputEl.addEventListener("keypress", e => {
  if (e.key === "Enter") handleUserMessage();
});
