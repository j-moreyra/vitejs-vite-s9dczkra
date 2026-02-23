import { useState, useEffect, useCallback, useRef, useMemo } from "react";

// ─── CONSTANTS & HELPERS ──────────────────────────────────────────────────
const QUIZ_MODES = [
  { id: "quick", name: "Quick Quiz", count: 10, desc: "10 mixed questions — perfect for a fast review", icon: "⚡" },
  { id: "standard", name: "Standard Quiz", count: 25, desc: "25 mixed questions — comprehensive coverage", icon: "📋" },
  { id: "hard", name: "Hard Mode", count: 25, desc: "25 application & reasoning questions", icon: "🔥" },
  { id: "drill", name: "Drill Mode", count: 15, desc: "Deep-dive into a single topic", icon: "🎯" },
];

const SPACED_INTERVALS = [
  { label: "1 day", days: 1 },
  { label: "3 days", days: 3 },
  { label: "7 days", days: 7 },
  { label: "14 days", days: 14 },
];

const uid = () => crypto.randomUUID?.() || Math.random().toString(36).slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtDate = (d) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmtTime = (s) => { const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, "0")}`; };

// Simple storage helper (persistent via window.storage)
const DB = {
  async get(key) {
    try { const r = await window.storage.get(key); return r ? JSON.parse(r.value) : null; } catch { return null; }
  },
  async set(key, val) {
    try { await window.storage.set(key, JSON.stringify(val)); } catch (e) { console.error("Storage set error:", e); }
  },
  async del(key) {
    try { await window.storage.delete(key); } catch { }
  },
  async list(prefix) {
    try { const r = await window.storage.list(prefix); return r?.keys || []; } catch { return []; }
  }
};

// ─── TEXT EXTRACTION ──────────────────────────────────────────────────────
function extractTextFromFile(file) {
  return new Promise((resolve, reject) => {
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "txt") {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = () => reject(new Error("Failed to read TXT file"));
      reader.readAsText(file);
    } else if (ext === "pdf") {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          if (!window.pdfjsLib) {
            const s = document.createElement("script");
            s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
            document.head.appendChild(s);
            await new Promise((res) => { s.onload = res; s.onerror = () => reject(new Error("PDF.js failed to load")); });
            window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
          }
          const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(e.target.result) }).promise;
          let text = "";
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            text += content.items.map((it) => it.str).join(" ") + "\n\n";
          }
          resolve(text);
        } catch (err) { reject(err); }
      };
      reader.readAsArrayBuffer(file);
    } else if (ext === "docx") {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          if (!window.mammoth) {
            const s = document.createElement("script");
            s.src = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js";
            document.head.appendChild(s);
            await new Promise((res) => { s.onload = res; s.onerror = () => reject(new Error("Mammoth.js failed to load")); });
          }
          const result = await window.mammoth.extractRawText({ arrayBuffer: e.target.result });
          resolve(result.value);
        } catch (err) { reject(err); }
      };
      reader.readAsArrayBuffer(file);
    } else if (ext === "pptx") {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          if (!window.JSZip) {
            const s = document.createElement("script");
            s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
            document.head.appendChild(s);
            await new Promise((res) => { s.onload = res; s.onerror = () => reject(new Error("JSZip failed to load")); });
          }
          const zip = await window.JSZip.loadAsync(e.target.result);
          let text = "";
          const slideFiles = Object.keys(zip.files).filter((f) => f.match(/ppt\/slides\/slide\d+\.xml/)).sort();
          for (const sf of slideFiles) {
            const xml = await zip.files[sf].async("text");
            const matches = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || [];
            const slideText = matches.map((m) => m.replace(/<[^>]+>/g, "")).join(" ");
            if (slideText.trim()) text += slideText + "\n\n";
          }
          resolve(text);
        } catch (err) { reject(err); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      reject(new Error("Unsupported file type: " + ext));
    }
  });
}

// ─── CHUNK TEXT ────────────────────────────────────────────────────────────
function chunkText(text, fileName, chunkSize = 500) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = "";
  let idx = 0;
  for (const sentence of sentences) {
    if (current.length + sentence.length > chunkSize && current.length > 0) {
      chunks.push({ id: uid(), text: current.trim(), fileName, index: idx++ });
      current = "";
    }
    current += sentence + " ";
  }
  if (current.trim()) chunks.push({ id: uid(), text: current.trim(), fileName, index: idx });
  return chunks;
}

// ─── TOPIC EXTRACTION ─────────────────────────────────────────────────────
function extractTopics(chunks) {
  const stopWords = new Set(["the","a","an","and","or","but","in","on","at","to","for","of","with","by","is","it","as","was","are","be","this","that","from","not","has","have","had","will","can","do","does","did","been","being","would","could","should","may","might","shall","into","than","then","these","those","their","there","them","they","its","our","we","you","your","he","she","his","her","him","all","each","every","both","few","more","most","other","some","such","no","any","only","same","so","very","just","also","about","up","out","if","when","where","how","what","which","who","whom","why","after","before","during","between","through","under","over","above","below","because","while","since","until","although","though","whether","either","neither","nor","per","via","vs","etc","eg","ie"]);
  const freq = {};
  for (const chunk of chunks) {
    const words = chunk.text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/);
    const seen = new Set();
    // Bigrams and single important words
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.length > 3 && !stopWords.has(w)) {
        if (!seen.has(w)) { freq[w] = (freq[w] || 0) + 1; seen.add(w); }
      }
      if (i < words.length - 1) {
        const bigram = w + " " + words[i + 1];
        if (w.length > 3 && words[i + 1].length > 3 && !stopWords.has(w) && !stopWords.has(words[i + 1])) {
          if (!seen.has(bigram)) { freq[bigram] = (freq[bigram] || 0) + 1; seen.add(bigram); }
        }
      }
    }
  }
  return Object.entries(freq)
    .filter(([k, v]) => v >= 2 && k.includes(" "))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([k]) => k.split(" ").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "));
}

// ─── SEARCH CHUNKS ────────────────────────────────────────────────────────
function searchChunks(chunks, query, topK = 5) {
  const qWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const scored = chunks.map((c) => {
    const txt = c.text.toLowerCase();
    let score = 0;
    for (const w of qWords) { if (txt.includes(w)) score += 1; }
    return { ...c, score };
  });
  return scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
}

// ─── AI QUIZ GENERATION ───────────────────────────────────────────────────
async function generateQuizFromContent(chunks, topics, mode, selectedTopic, previousQuestionTexts = [], learningObjectives = "", { signal, countOverride, focusTopics } = {}) {
  const modeConfig = QUIZ_MODES.find((m) => m.id === mode) || QUIZ_MODES[0];
  const questionCount = countOverride || modeConfig.count;

  let relevantChunks = chunks;
  if (mode === "drill" && selectedTopic) {
    relevantChunks = searchChunks(chunks, selectedTopic, 30);
    if (relevantChunks.length === 0) return { error: "Not found in your uploads. Upload more material or change topics." };
  }

  // If user selected focus topics, filter chunks to those topics
  if (focusTopics && focusTopics.length > 0 && mode !== "drill") {
    const topicQuery = focusTopics.join(" ");
    const focused = searchChunks(chunks, topicQuery, 50);
    if (focused.length > 0) relevantChunks = focused;
  }

  // Sample chunks to cover all topics
  const sampledChunks = [];
  const chunkGroups = {};
  for (const c of relevantChunks) {
    const key = c.fileName;
    if (!chunkGroups[key]) chunkGroups[key] = [];
    chunkGroups[key].push(c);
  }
  const groupKeys = Object.keys(chunkGroups);
  let idx = 0;
  while (sampledChunks.length < Math.min(40, relevantChunks.length)) {
    const group = chunkGroups[groupKeys[idx % groupKeys.length]];
    const remaining = group.filter((c) => !sampledChunks.includes(c));
    if (remaining.length > 0) sampledChunks.push(remaining[Math.floor(Math.random() * remaining.length)]);
    idx++;
    if (idx > 200) break;
  }

  const contentSample = sampledChunks.map((c, i) => `[Chunk ${i + 1} | File: ${c.fileName}]\n${c.text}`).join("\n\n---\n\n");

  const previousQuestionsNote = previousQuestionTexts.length > 0
    ? `\n\nIMPORTANT: Do NOT repeat or rephrase any of these previously asked questions:\n${previousQuestionTexts.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n\nGenerate completely NEW and DIFFERENT questions.`
    : "";

  const objectivesNote = learningObjectives
    ? `\n\nThe user wants questions focused on these learning objectives:\n${learningObjectives}\nPrioritize questions that address these objectives while still using ONLY the provided content.`
    : "";

  const difficultyNote = mode === "hard"
    ? "\nGenerate APPLICATION-LEVEL and MULTI-STEP REASONING questions. Require students to apply concepts, analyze scenarios, compare/contrast, or solve multi-step problems. Avoid simple recall questions."
    : "";

  const topicCoverageNote = focusTopics && focusTopics.length > 0
    ? `\n\nThe user wants questions FOCUSED on these specific topics: ${focusTopics.join(", ")}\nPrioritize questions from these topics. Most questions should cover these areas.`
    : topics.length > 0
    ? `\n\nDetected topics in the material: ${topics.join(", ")}\nTry to cover ALL major topics/concepts. No concept should be left out.`
    : "";

  const prompt = `You are an expert medical/science exam question writer. Generate exactly ${questionCount} practice questions based STRICTLY on the provided study material.

ANTI-HALLUCINATION RULES:
- Every question, answer, and explanation MUST be directly supported by the content below
- Do NOT invent facts, statistics, or information not present in the material
- If content is insufficient, generate fewer questions rather than making things up
- Each citation must reference the actual file name and quote a SHORT relevant excerpt

QUESTION TYPE MIX:
- ~50% Multiple Choice (4 options, exactly 1 correct)
- ~20% Select All That Apply (4 options, 1-4 correct)
- ~15% Fill in the Blank
- ~15% Short Answer

IMPORTANT FORMATTING RULE:
- Do NOT include "Select all that apply" or any similar instruction in the "prompt" field. The UI handles this automatically. The prompt should contain ONLY the question text itself.
${difficultyNote}${previousQuestionsNote}${objectivesNote}${topicCoverageNote}

STUDY MATERIAL:
${contentSample}

Respond with ONLY valid JSON (no markdown, no backticks):
{
  "questions": [
    {
      "type": "multiple_choice" | "select_all" | "fill_blank" | "short_answer",
      "topic": "topic name",
      "prompt": "question text",
      "options": ["A", "B", "C", "D"] or null,
      "correct": "A" or ["A","C"] or "fill text" or "short answer text",
      "explanation": "why this is correct",
      "citation": { "fileName": "source.pdf", "excerpt": "short quote from material" }
    }
  ]
}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await response.json();
    const text = data.content?.map((b) => b.text || "").join("") || "";
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return parsed;
  } catch (err) {
    console.error("Quiz generation error:", err);
    return { error: "Failed to generate quiz. Please try again." };
  }
}

// ─── FLASHCARD GENERATION ─────────────────────────────────────────────────
async function generateFlashcards(chunks, topic, count = 10) {
  const relevant = topic ? searchChunks(chunks, topic, 20) : chunks.slice(0, 30);
  const content = relevant.map((c) => `[${c.fileName}] ${c.text}`).join("\n\n");

  const prompt = `Generate ${count} flashcards for studying based STRICTLY on this material. Each card must be grounded in the content.

MATERIAL:
${content}

Respond with ONLY valid JSON:
{
  "cards": [
    {
      "front": "question or term",
      "back": "answer or definition",
      "citation": { "fileName": "source.pdf", "excerpt": "relevant quote" }
    }
  ]
}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await response.json();
    const text = data.content?.map((b) => b.text || "").join("") || "";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (err) {
    return { error: "Failed to generate flashcards." };
  }
}

// ─── STYLES ───────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;0,9..144,800;1,9..144,400&display=swap');

:root {
  --ink: #1a1a2e;
  --ink-light: #4a4a6a;
  --ink-muted: #8888a8;
  --bg: #f8f7f4;
  --bg-card: #ffffff;
  --bg-warm: #faf5ef;
  --accent: #2d6a4f;
  --accent-light: #40916c;
  --accent-pale: #d8f3dc;
  --accent-glow: #52b788;
  --danger: #c1121f;
  --danger-pale: #ffeaea;
  --warning: #e76f51;
  --warning-pale: #fff3ed;
  --success: #2d6a4f;
  --success-pale: #d8f3dc;
  --blue: #1d3557;
  --blue-pale: #e8f0fe;
  --radius: 12px;
  --radius-sm: 8px;
  --radius-lg: 16px;
  --shadow: 0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04);
  --shadow-lg: 0 4px 20px rgba(0,0,0,0.08), 0 8px 32px rgba(0,0,0,0.04);
  --transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  --font-display: 'Fraunces', Georgia, serif;
  --font-body: 'DM Sans', -apple-system, sans-serif;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: var(--font-body);
  background: var(--bg);
  color: var(--ink);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

/* ─── ANIMATIONS ─────────────────────────────── */
@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes slideUp { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes scaleIn { from { transform: scale(0.95); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }

.fade-in { animation: fadeIn 0.4s ease-out both; }
.slide-up { animation: slideUp 0.5s ease-out both; }

/* ─── LAYOUT ─────────────────────────────────── */
.app { min-height: 100vh; display: flex; flex-direction: column; }

.nav {
  background: var(--ink);
  color: white;
  padding: 0 24px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: sticky;
  top: 0;
  z-index: 100;
  box-shadow: 0 2px 16px rgba(0,0,0,0.15);
}

.nav-logo {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  letter-spacing: -0.3px;
}

.nav-logo .logo-icon {
  width: 32px;
  height: 32px;
  background: var(--accent);
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
}

.nav-links { display: flex; align-items: center; gap: 8px; }
.nav-links button {
  background: transparent;
  border: none;
  color: rgba(255,255,255,0.7);
  font-family: var(--font-body);
  font-size: 14px;
  font-weight: 500;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: var(--transition);
}
.nav-links button:hover, .nav-links button.active { color: white; background: rgba(255,255,255,0.1); }
.nav-user {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  color: rgba(255,255,255,0.8);
}
.nav-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--accent);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 14px;
  color: white;
}

.container { max-width: 1100px; margin: 0 auto; padding: 24px 20px; width: 100%; flex: 1; }

/* ─── BUTTONS ────────────────────────────────── */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border: none;
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: var(--transition);
  text-decoration: none;
  white-space: nowrap;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: var(--accent); color: white; }
.btn-primary:hover:not(:disabled) { background: var(--accent-light); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(45,106,79,0.3); }
.btn-secondary { background: var(--bg); color: var(--ink); border: 1.5px solid #ddd; }
.btn-secondary:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn-danger { background: var(--danger-pale); color: var(--danger); }
.btn-danger:hover:not(:disabled) { background: var(--danger); color: white; }
.btn-ghost { background: transparent; color: var(--ink-light); padding: 8px 12px; }
.btn-ghost:hover { color: var(--ink); background: rgba(0,0,0,0.04); }
.btn-lg { padding: 14px 28px; font-size: 16px; border-radius: var(--radius); }
.btn-sm { padding: 6px 12px; font-size: 13px; }
.btn-icon { padding: 8px; border-radius: var(--radius-sm); }

/* ─── CARDS ──────────────────────────────────── */
.card {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  padding: 24px;
  transition: var(--transition);
  border: 1px solid rgba(0,0,0,0.04);
}
.card:hover { box-shadow: var(--shadow-lg); }
.card-flat { box-shadow: none; border: 1.5px solid #e8e8e8; }
.card-flat:hover { border-color: var(--accent-pale); }

/* ─── FORMS ──────────────────────────────────── */
.input, .textarea, .select {
  width: 100%;
  padding: 10px 14px;
  border: 1.5px solid #ddd;
  border-radius: var(--radius-sm);
  font-family: var(--font-body);
  font-size: 14px;
  color: var(--ink);
  background: white;
  transition: var(--transition);
  outline: none;
}
.input:focus, .textarea:focus, .select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-pale); }
.textarea { min-height: 80px; resize: vertical; }
.label { display: block; font-size: 13px; font-weight: 600; color: var(--ink-light); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }

/* ─── BADGE ──────────────────────────────────── */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
}
.badge-green { background: var(--success-pale); color: var(--success); }
.badge-yellow { background: var(--warning-pale); color: var(--warning); }
.badge-red { background: var(--danger-pale); color: var(--danger); }
.badge-blue { background: var(--blue-pale); color: var(--blue); }

/* ─── PROGRESS BAR ───────────────────────────── */
.progress-bar {
  width: 100%;
  height: 6px;
  background: #e8e8e8;
  border-radius: 3px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-glow));
  border-radius: 3px;
  transition: width 0.4s ease;
}

/* ─── LANDING PAGE ───────────────────────────── */
.landing {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.landing-hero {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 60px 24px;
  background: linear-gradient(170deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  position: relative;
  overflow: hidden;
}
.landing-hero::before {
  content: '';
  position: absolute;
  top: -50%;
  right: -20%;
  width: 600px;
  height: 600px;
  background: radial-gradient(circle, rgba(45,106,79,0.15) 0%, transparent 70%);
  border-radius: 50%;
}
.landing-hero::after {
  content: '';
  position: absolute;
  bottom: -30%;
  left: -10%;
  width: 500px;
  height: 500px;
  background: radial-gradient(circle, rgba(82,183,136,0.1) 0%, transparent 70%);
  border-radius: 50%;
}
.hero-content {
  max-width: 560px;
  text-align: center;
  position: relative;
  z-index: 1;
  animation: slideUp 0.8s ease-out;
}
.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(255,255,255,0.08);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255,255,255,0.1);
  padding: 6px 16px;
  border-radius: 20px;
  font-size: 13px;
  color: var(--accent-glow);
  font-weight: 500;
  margin-bottom: 24px;
}
.hero-title {
  font-family: var(--font-display);
  font-size: 52px;
  font-weight: 800;
  line-height: 1.1;
  color: white;
  margin-bottom: 16px;
  letter-spacing: -1px;
}
.hero-title span { color: var(--accent-glow); }
.hero-subtitle {
  font-size: 18px;
  color: rgba(255,255,255,0.6);
  margin-bottom: 36px;
  line-height: 1.7;
}
.hero-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
.btn-hero {
  padding: 14px 32px;
  font-size: 16px;
  font-weight: 700;
  border-radius: var(--radius);
  border: none;
  cursor: pointer;
  font-family: var(--font-body);
  transition: var(--transition);
}
.btn-hero-primary { background: var(--accent-glow); color: white; }
.btn-hero-primary:hover { background: var(--accent-light); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(82,183,136,0.3); }
.btn-hero-secondary { background: transparent; color: white; border: 1.5px solid rgba(255,255,255,0.2); }
.btn-hero-secondary:hover { border-color: rgba(255,255,255,0.5); background: rgba(255,255,255,0.05); }

.landing-features {
  padding: 60px 24px;
  background: var(--bg);
}
.features-grid {
  max-width: 900px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 20px;
}
.feature-card {
  padding: 28px;
  border-radius: var(--radius-lg);
  background: var(--bg-card);
  border: 1.5px solid #e8e8e8;
}
.feature-card .icon {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  margin-bottom: 14px;
  background: var(--accent-pale);
}
.feature-card h3 { font-family: var(--font-display); font-size: 18px; font-weight: 700; margin-bottom: 8px; }
.feature-card p { font-size: 14px; color: var(--ink-light); line-height: 1.6; }

/* ─── AUTH ────────────────────────────────────── */
.auth-card {
  max-width: 400px;
  margin: 60px auto;
  padding: 40px;
}
.auth-card h2 { font-family: var(--font-display); font-size: 28px; margin-bottom: 6px; }
.auth-card .sub { color: var(--ink-muted); margin-bottom: 28px; font-size: 14px; }
.form-group { margin-bottom: 18px; }
.auth-toggle { text-align: center; margin-top: 20px; font-size: 14px; color: var(--ink-muted); }
.auth-toggle span { color: var(--accent); font-weight: 600; cursor: pointer; }
.auth-toggle span:hover { text-decoration: underline; }

/* ─── DASHBOARD ──────────────────────────────── */
.dash-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 28px;
  flex-wrap: wrap;
  gap: 12px;
}
.dash-header h1 { font-family: var(--font-display); font-size: 32px; font-weight: 700; }
.courses-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
.course-card { cursor: pointer; }
.course-card .course-name { font-family: var(--font-display); font-size: 20px; font-weight: 700; margin-bottom: 4px; }
.course-card .course-term { color: var(--ink-muted); font-size: 14px; margin-bottom: 12px; }
.course-card .exam-count { font-size: 13px; color: var(--ink-light); display: flex; align-items: center; gap: 6px; }
.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--ink-muted);
}
.empty-state .icon { font-size: 48px; margin-bottom: 16px; }
.empty-state h3 { font-family: var(--font-display); font-size: 22px; color: var(--ink); margin-bottom: 8px; }
.empty-state p { max-width: 400px; margin: 0 auto 20px; font-size: 14px; line-height: 1.6; }

/* ─── EXAM PAGE ──────────────────────────────── */
.exam-header { margin-bottom: 28px; }
.exam-header .breadcrumb { font-size: 13px; color: var(--ink-muted); margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
.exam-header .breadcrumb span { cursor: pointer; color: var(--accent); }
.exam-header .breadcrumb span:hover { text-decoration: underline; }
.exam-header h1 { font-family: var(--font-display); font-size: 28px; }

.section-title {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.file-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
.file-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: var(--bg);
  border-radius: var(--radius-sm);
  font-size: 14px;
  border: 1px solid #eee;
}
.file-item .file-icon { font-size: 20px; }
.file-item .file-name { flex: 1; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-item .file-delete { cursor: pointer; color: var(--ink-muted); transition: var(--transition); border: none; background: none; font-size: 16px; padding: 4px; }
.file-item .file-delete:hover { color: var(--danger); }

.upload-zone {
  border: 2px dashed #d0d0d0;
  border-radius: var(--radius);
  padding: 36px;
  text-align: center;
  cursor: pointer;
  transition: var(--transition);
  background: white;
  margin-bottom: 20px;
}
.upload-zone:hover, .upload-zone.drag { border-color: var(--accent); background: var(--accent-pale); }
.upload-zone .icon { font-size: 36px; margin-bottom: 8px; }
.upload-zone p { color: var(--ink-muted); font-size: 14px; }
.upload-zone .formats { font-size: 12px; color: var(--ink-muted); margin-top: 6px; }

.topics-list { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
.topic-tag {
  padding: 6px 14px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: var(--transition);
  border: 1.5px solid #ddd;
  background: white;
  color: var(--ink-light);
}
.topic-tag:hover { border-color: var(--accent); color: var(--accent); }
.topic-tag.selected { background: var(--accent); color: white; border-color: var(--accent); }

.mode-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-bottom: 20px; }
.mode-card {
  padding: 20px;
  border-radius: var(--radius);
  border: 2px solid #e8e8e8;
  background: white;
  cursor: pointer;
  transition: var(--transition);
  text-align: center;
}
.mode-card:hover { border-color: var(--accent-pale); transform: translateY(-2px); }
.mode-card.selected { border-color: var(--accent); background: var(--accent-pale); }
.mode-card .mode-icon { font-size: 28px; margin-bottom: 8px; }
.mode-card .mode-name { font-weight: 700; font-size: 15px; margin-bottom: 4px; }
.mode-card .mode-desc { font-size: 12px; color: var(--ink-muted); }

/* ─── QUIZ PAGE ──────────────────────────────── */
.quiz-container { max-width: 720px; margin: 0 auto; }
.quiz-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
  flex-wrap: wrap;
  gap: 8px;
}
.quiz-header .quiz-info { font-size: 14px; color: var(--ink-muted); }
.quiz-header .quiz-timer { font-family: 'DM Sans', monospace; font-size: 18px; font-weight: 600; color: var(--ink); }

.question-card {
  animation: fadeIn 0.3s ease-out;
  margin-bottom: 20px;
}
.question-number { font-size: 12px; font-weight: 700; color: var(--accent); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; }
.question-type-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: var(--blue-pale); color: var(--blue); font-weight: 600; margin-left: 8px; }
.question-prompt { font-size: 17px; font-weight: 500; line-height: 1.6; margin-bottom: 20px; color: var(--ink); }

.options-list { display: flex; flex-direction: column; gap: 10px; }
.option-btn {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 18px;
  border: 2px solid #e8e8e8;
  border-radius: var(--radius);
  background: white;
  cursor: pointer;
  transition: var(--transition);
  text-align: left;
  font-family: var(--font-body);
  font-size: 15px;
  color: var(--ink);
  width: 100%;
}
.option-btn:hover { border-color: var(--accent-pale); background: #fafff8; }
.option-btn.selected { border-color: var(--accent); background: var(--accent-pale); }
.option-btn.correct { border-color: var(--success); background: var(--success-pale); }
.option-btn.incorrect { border-color: var(--danger); background: var(--danger-pale); }
.option-letter {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid #ddd;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  flex-shrink: 0;
  transition: var(--transition);
}
.option-btn.selected .option-letter { background: var(--accent); color: white; border-color: var(--accent); }
.option-btn.correct .option-letter { background: var(--success); color: white; border-color: var(--success); }
.option-btn.incorrect .option-letter { background: var(--danger); color: white; border-color: var(--danger); }

.fill-blank-input { width: 100%; padding: 12px 16px; border: 2px solid #e8e8e8; border-radius: var(--radius); font-size: 16px; font-family: var(--font-body); outline: none; }
.fill-blank-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-pale); }

.quiz-nav { display: flex; justify-content: space-between; align-items: center; margin-top: 24px; }

/* ─── RESULTS ────────────────────────────────── */
.results-hero {
  text-align: center;
  padding: 40px 20px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  margin-bottom: 24px;
  animation: scaleIn 0.5s ease-out;
}
.results-hero .score-circle {
  width: 140px;
  height: 140px;
  border-radius: 50%;
  margin: 0 auto 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-size: 44px;
  font-weight: 800;
  border: 5px solid;
}
.results-hero h2 { font-family: var(--font-display); font-size: 24px; margin-bottom: 8px; }
.results-hero p { color: var(--ink-muted); font-size: 14px; }

.results-breakdown { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
.breakdown-card { padding: 16px; border-radius: var(--radius); text-align: center; background: var(--bg-card); border: 1px solid #eee; }
.breakdown-card .stat { font-family: var(--font-display); font-size: 28px; font-weight: 700; }
.breakdown-card .stat-label { font-size: 12px; color: var(--ink-muted); text-transform: uppercase; letter-spacing: 0.5px; }

.review-question { margin-bottom: 16px; padding: 20px; }
.review-question .citation-box {
  margin-top: 14px;
  padding: 12px 16px;
  background: var(--blue-pale);
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--blue);
  font-size: 13px;
}
.review-question .citation-box .cite-label { font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--blue); margin-bottom: 4px; }
.review-question .explanation-box {
  margin-top: 10px;
  padding: 12px 16px;
  background: var(--bg-warm);
  border-radius: var(--radius-sm);
  font-size: 14px;
  color: var(--ink-light);
  line-height: 1.6;
}

/* ─── FLASHCARDS ─────────────────────────────── */
.flashcard {
  width: 100%;
  max-width: 500px;
  margin: 0 auto;
  height: 300px;
  perspective: 1000px;
  cursor: pointer;
}
.flashcard-inner {
  width: 100%;
  height: 100%;
  position: relative;
  transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  transform-style: preserve-3d;
}
.flashcard-inner.flipped { transform: rotateY(180deg); }
.flashcard-face {
  position: absolute;
  width: 100%;
  height: 100%;
  backface-visibility: hidden;
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
  text-align: center;
  box-shadow: var(--shadow-lg);
}
.flashcard-front { background: white; }
.flashcard-back { background: var(--accent); color: white; transform: rotateY(180deg); }
.flashcard-face .card-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.5; position: absolute; top: 16px; font-weight: 600; }
.flashcard-face .card-text { font-size: 18px; line-height: 1.6; font-weight: 500; }

/* ─── MODAL ──────────────────────────────────── */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  animation: fadeIn 0.2s ease;
  padding: 20px;
}
.modal {
  background: white;
  border-radius: var(--radius-lg);
  padding: 32px;
  width: 100%;
  max-width: 480px;
  max-height: 90vh;
  overflow-y: auto;
  animation: scaleIn 0.3s ease-out;
}
.modal h2 { font-family: var(--font-display); font-size: 22px; margin-bottom: 6px; }
.modal .sub { color: var(--ink-muted); font-size: 14px; margin-bottom: 20px; }

/* ─── LOADING ────────────────────────────────── */
.spinner { width: 24px; height: 24px; border: 3px solid #e8e8e8; border-top: 3px solid var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
.loading-shimmer { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: var(--radius-sm); height: 16px; }

/* ─── TABS ───────────────────────────────────── */
.tabs { display: flex; gap: 2px; background: #eee; padding: 3px; border-radius: var(--radius-sm); margin-bottom: 20px; }
.tab {
  flex: 1;
  padding: 8px 12px;
  text-align: center;
  font-size: 13px;
  font-weight: 600;
  border: none;
  background: transparent;
  cursor: pointer;
  border-radius: 6px;
  color: var(--ink-muted);
  transition: var(--transition);
  font-family: var(--font-body);
}
.tab.active { background: white; color: var(--ink); box-shadow: 0 1px 3px rgba(0,0,0,0.08); }

/* ─── CONTENT WARNING ────────────────────────── */
.content-warning {
  padding: 14px 18px;
  background: var(--warning-pale);
  border: 1px solid var(--warning);
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--warning);
  margin-bottom: 16px;
  line-height: 1.5;
}

/* ─── QUIZ HISTORY ───────────────────────────── */
.history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid #eee;
  cursor: pointer;
  transition: var(--transition);
}
.history-item:hover { background: var(--bg); }
.history-item:last-child { border-bottom: none; }
.history-item .badge-yellow { animation: pulse 2s ease-in-out infinite; }

/* ─── SAVED QUIZ BANNER ─────────────────────── */
.saved-banner {
  padding: 14px 18px;
  background: var(--warning-pale);
  border: 1.5px solid var(--warning);
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}
.saved-banner .saved-info { font-size: 14px; font-weight: 500; color: var(--ink); }
.saved-banner .saved-detail { font-size: 12px; color: var(--ink-muted); margin-top: 2px; }

/* ─── RESPONSIVE ─────────────────────────────── */
@media (max-width: 768px) {
  .hero-title { font-size: 36px; }
  .hero-subtitle { font-size: 16px; }
  .container { padding: 16px 14px; }
  .nav { padding: 0 14px; }
  .nav-links { display: none; }
  .courses-grid { grid-template-columns: 1fr; }
  .mode-grid { grid-template-columns: 1fr 1fr; }
  .features-grid { grid-template-columns: 1fr; }
  .results-breakdown { grid-template-columns: 1fr 1fr; }
}
`;

// ─── APP COMPONENT ────────────────────────────────────────────────────────
export default function MedTrackQuizzer() {
  // ── State ──
  const [page, setPage] = useState("landing");
  const [user, setUser] = useState(null);
  const [courses, setCourses] = useState([]);
  const [exams, setExams] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [quizzes, setQuizzes] = useState([]);
  const [attempts, setAttempts] = useState([]);

  const [selectedCourse, setSelectedCourse] = useState(null);
  const [selectedExam, setSelectedExam] = useState(null);
  const [selectedQuiz, setSelectedQuiz] = useState(null);
  const [selectedAttempt, setSelectedAttempt] = useState(null);

  const [authMode, setAuthMode] = useState("signup");
  const [authForm, setAuthForm] = useState({ name: "", email: "", password: "" });
  const [modal, setModal] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Quiz state
  const [quizMode, setQuizMode] = useState("quick");
  const [selectedTopics, setSelectedTopics] = useState([]);
  const [learningObjectives, setLearningObjectives] = useState("");
  const [timerEnabled, setTimerEnabled] = useState(false);
  const [timerSeconds, setTimerSeconds] = useState(0);
  const timerRef = useRef(null);
  const [currentQ, setCurrentQ] = useState(0);
  const [answers, setAnswers] = useState({});
  const [quizPaused, setQuizPaused] = useState(false);
  const [quizSubmitted, setQuizSubmitted] = useState(false);
  const [savedQuizProgress, setSavedQuizProgress] = useState({});
  // savedQuizProgress shape: { [quizId]: { answers, currentQ, timerSeconds, timerEnabled, savedAt } }
  const [confirmAction, setConfirmAction] = useState(null);
  // confirmAction shape: { title, message, onConfirm }
  const abortControllerRef = useRef(null);

  // Study state
  const [flashcards, setFlashcards] = useState([]);
  const [currentCard, setCurrentCard] = useState(0);
  const [cardFlipped, setCardFlipped] = useState(false);
  const [studyTab, setStudyTab] = useState("missed");

  // Derived data
  const examDocs = useMemo(() => documents.filter((d) => d.examId === selectedExam?.id), [documents, selectedExam]);
  const allChunks = useMemo(() => examDocs.flatMap((d) => d.chunks || []), [examDocs]);
  const topics = useMemo(() => extractTopics(allChunks), [allChunks]);
  const examQuizzes = useMemo(() => quizzes.filter((q) => q.examId === selectedExam?.id), [quizzes, selectedExam]);
  const examAttempts = useMemo(() => attempts.filter((a) => examQuizzes.some((q) => q.id === a.quizId)), [attempts, examQuizzes]);

  const missedQuestions = useMemo(() => {
    const missed = [];
    for (const attempt of examAttempts) {
      const quiz = quizzes.find((q) => q.id === attempt.quizId);
      if (!quiz) continue;
      for (const q of quiz.questions || []) {
        const userAns = attempt.answers?.[q.prompt];
        let isCorrect = false;
        if (q.type === "select_all") {
          const correct = Array.isArray(q.correct) ? q.correct.sort().join(",") : q.correct;
          const user = Array.isArray(userAns) ? userAns.sort().join(",") : userAns || "";
          isCorrect = correct === user;
        } else {
          isCorrect = String(userAns || "").toLowerCase().trim() === String(q.correct).toLowerCase().trim();
        }
        if (!isCorrect) missed.push({ ...q, attemptDate: attempt.date, userAnswer: userAns });
      }
    }
    return missed;
  }, [examAttempts, quizzes]);

  // ── Persist State ──
  useEffect(() => {
    (async () => {
      const u = await DB.get("user");
      if (u) { setUser(u); setPage("dashboard"); }
      setCourses((await DB.get("courses")) || []);
      setExams((await DB.get("exams")) || []);
      setDocuments((await DB.get("documents")) || []);
      setQuizzes((await DB.get("quizzes")) || []);
      setAttempts((await DB.get("attempts")) || []);
      setSavedQuizProgress((await DB.get("savedProgress")) || {});
    })();
  }, []);

  useEffect(() => { if (user) DB.set("user", user); }, [user]);
  useEffect(() => { DB.set("courses", courses); }, [courses]);
  useEffect(() => { DB.set("exams", exams); }, [exams]);
  useEffect(() => {
    // Store documents without the full raw text to save space (chunks are kept)
    const docsForStorage = documents.map(({ text, ...rest }) => rest);
    DB.set("documents", docsForStorage);
  }, [documents]);
  useEffect(() => { DB.set("quizzes", quizzes); }, [quizzes]);
  useEffect(() => { DB.set("attempts", attempts); }, [attempts]);
  useEffect(() => { DB.set("savedProgress", savedQuizProgress); }, [savedQuizProgress]);

  // ── Timer ──
  useEffect(() => {
    if (page === "quiz" && timerEnabled && !quizPaused && !quizSubmitted) {
      timerRef.current = setInterval(() => setTimerSeconds((s) => s + 1), 1000);
    }
    return () => clearInterval(timerRef.current);
  }, [page, timerEnabled, quizPaused, quizSubmitted]);

  // ── Auth ──
  const handleAuth = async () => {
    if (!authForm.email || !authForm.password) return setError("Please fill all fields");
    if (authMode === "signup" && !authForm.name) return setError("Name is required");
    const u = { id: uid(), name: authForm.name || authForm.email.split("@")[0], email: authForm.email };
    setUser(u);
    setError("");
    setPage("dashboard");
  };

  const logout = async () => {
    setUser(null);
    setPage("landing");
    await DB.del("user");
  };

  // ── Courses ──
  const createCourse = (name, term) => {
    const c = { id: uid(), name, term, userId: user.id, created: Date.now() };
    setCourses((prev) => [...prev, c]);
    setModal(null);
  };

  const deleteCourse = (id) => {
    setCourses((prev) => prev.filter((c) => c.id !== id));
    setExams((prev) => prev.filter((e) => e.courseId !== id));
    setDocuments((prev) => prev.filter((d) => !exams.some((e) => e.courseId === id && e.id === d.examId)));
  };

  // ── Exams ──
  const createExam = (name, date) => {
    const e = { id: uid(), courseId: selectedCourse.id, name, date, created: Date.now() };
    setExams((prev) => [...prev, e]);
    setModal(null);
  };

  const deleteExam = (id) => {
    setExams((prev) => prev.filter((e) => e.id !== id));
    setDocuments((prev) => prev.filter((d) => d.examId !== id));
  };

  // ── File Upload ──
  const handleFileUpload = async (files) => {
    for (const file of files) {
      const ext = file.name.split(".").pop().toLowerCase();
      if (!["pdf", "pptx", "docx", "txt"].includes(ext)) continue;

      const docId = uid();
      const newDoc = { id: docId, examId: selectedExam.id, fileName: file.name, fileType: ext, status: "processing", chunks: [], text: "", created: Date.now() };
      setDocuments((prev) => [...prev, newDoc]);

      try {
        const text = await extractTextFromFile(file);
        if (text.length < 10) throw new Error("Could not extract meaningful text");
        const chunks = chunkText(text, file.name);
        setDocuments((prev) => prev.map((d) => d.id === docId ? { ...d, status: "ready", text, chunks } : d));
      } catch (err) {
        console.error("Extraction error:", err);
        setDocuments((prev) => prev.map((d) => d.id === docId ? { ...d, status: "failed" } : d));
      }
    }
  };

  const deleteDocument = (id) => {
    setDocuments((prev) => prev.filter((d) => d.id !== id));
  };

  // ── Quiz Generation ──
  const generateQuiz = async () => {
    if (allChunks.length === 0) return setError("Upload files first before generating a quiz.");
    setLoading(true);
    setError("");

    // Create an AbortController so user can cancel
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const previousQuestionTexts = examQuizzes.flatMap((q) => (q.questions || []).map((qq) => qq.prompt));

    // For drill mode, use the first selected topic
    const drillTopic = quizMode === "drill" && selectedTopics.length > 0 ? selectedTopics[0] : "";

    try {
      const result = await generateQuizFromContent(
        allChunks, topics, quizMode, drillTopic, previousQuestionTexts, learningObjectives,
        { signal: controller.signal, focusTopics: selectedTopics.length > 0 ? selectedTopics : undefined }
      );

      // If we were cancelled, just bail
      if (controller.signal.aborted) { setLoading(false); abortControllerRef.current = null; return; }

      if (result.error) { setError(result.error); setLoading(false); abortControllerRef.current = null; return; }

      const generatedQuestions = result.questions || [];
      if (generatedQuestions.length === 0) {
        setError("No questions were generated. Please try again or upload more materials.");
        setLoading(false);
        abortControllerRef.current = null;
        return;
      }

      const quiz = {
        id: uid(),
        examId: selectedExam.id,
        mode: quizMode,
        questions: generatedQuestions,
        created: Date.now(),
      };
      setQuizzes((prev) => [...prev, quiz]);
      setSelectedQuiz(quiz);
      setCurrentQ(0);
      setAnswers({});
      setTimerSeconds(0);
      setQuizSubmitted(false);
      setQuizPaused(false);
      setLoading(false);
      abortControllerRef.current = null;
      setPage("quiz");
    } catch (err) {
      if (err.name === "AbortError") {
        setLoading(false);
        abortControllerRef.current = null;
        return;
      }
      console.error("Quiz generation error:", err);
      setError("Failed to generate quiz: " + (err.message || "Unknown error. Please try again."));
      setLoading(false);
      abortControllerRef.current = null;
    }
  };

  // ── Cancel Quiz Generation ──
  const cancelGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setLoading(false);
  };

  // ── Submit Quiz ──
  const submitQuiz = () => {
    if (!selectedQuiz) return;
    clearInterval(timerRef.current);
    setQuizSubmitted(true);

    let score = 0;
    const questions = selectedQuiz.questions || [];
    for (const q of questions) {
      const userAns = answers[q.prompt];
      if (q.type === "select_all") {
        const correct = Array.isArray(q.correct) ? q.correct.sort().join(",") : q.correct;
        const user = Array.isArray(userAns) ? userAns.sort().join(",") : "";
        if (correct === user) score++;
      } else if (q.type === "fill_blank" || q.type === "short_answer") {
        if (String(userAns || "").toLowerCase().trim() === String(q.correct).toLowerCase().trim()) score++;
      } else {
        if (userAns === q.correct) score++;
      }
    }

    const attempt = {
      id: uid(),
      quizId: selectedQuiz.id,
      userId: user.id,
      answers: { ...answers },
      score,
      total: questions.length,
      time: timerSeconds,
      date: Date.now(),
    };
    setAttempts((prev) => [...prev, attempt]);
    setSelectedAttempt(attempt);
    setPage("results");
  };

  // ── Generate Flashcards ──
  const generateFlashcardsHandler = async (topic) => {
    setLoading(true);
    const result = await generateFlashcards(allChunks, topic);
    if (result.cards) {
      setFlashcards(result.cards);
      setCurrentCard(0);
      setCardFlipped(false);
    }
    setLoading(false);
  };

  // ── Retake Missed ──
  const retakeMissed = async () => {
    if (missedQuestions.length === 0) return;
    setLoading(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const prompts = missedQuestions.map((q) => q.prompt);

    // Find the original quiz to match its question count
    const lastAttempt = examAttempts.sort((a, b) => b.date - a.date)[0];
    const originalQuiz = lastAttempt ? quizzes.find((q) => q.id === lastAttempt.quizId) : null;
    const originalCount = originalQuiz?.questions?.length || 25;

    // Regenerate quiz from missed content areas
    const relatedChunks = [];
    for (const q of missedQuestions) {
      relatedChunks.push(...searchChunks(allChunks, q.prompt, 3));
    }

    if (relatedChunks.length > 0) {
      try {
        const result = await generateQuizFromContent(relatedChunks, topics, "standard", "", prompts, "", { countOverride: originalCount, signal: controller.signal });
        if (controller.signal.aborted) { setLoading(false); abortControllerRef.current = null; return; }
        if (!result.error && result.questions && result.questions.length > 0) {
          const quiz = { id: uid(), examId: selectedExam.id, mode: "retake_missed", questions: result.questions, created: Date.now() };
          setQuizzes((prev) => [...prev, quiz]);
          setSelectedQuiz(quiz);
          setCurrentQ(0);
          setAnswers({});
          setTimerSeconds(0);
          setQuizSubmitted(false);
          setPage("quiz");
        }
      } catch (err) {
        if (err.name === "AbortError") { setLoading(false); abortControllerRef.current = null; return; }
      }
    }
    setLoading(false);
    abortControllerRef.current = null;
  };

  // ── Navigation helper ──
  const navigate = (pg, data) => {
    setError("");
    setPage(pg);
    if (data) {
      if (data.course) setSelectedCourse(data.course);
      if (data.exam) setSelectedExam(data.exam);
    }
  };

  // ── Save & Exit Quiz ──
  const saveAndExitQuiz = () => {
    if (!selectedQuiz) return;
    clearInterval(timerRef.current);
    setSavedQuizProgress((prev) => ({
      ...prev,
      [selectedQuiz.id]: {
        answers: { ...answers },
        currentQ,
        timerSeconds,
        timerEnabled,
        savedAt: Date.now(),
      },
    }));
    setQuizPaused(false);
    setSelectedQuiz(null);
    navigate("exam");
  };

  // ── Quit Quiz (discard progress) ──
  const quitQuiz = () => {
    if (!selectedQuiz) return;
    const quizId = selectedQuiz.id;
    setConfirmAction({
      title: "Quit Quiz?",
      message: "Are you sure you want to quit? Your progress on this quiz will be lost permanently and it will be removed from your history.",
      confirmLabel: "Quit Quiz",
      confirmStyle: "danger",
      onConfirm: () => {
        clearInterval(timerRef.current);
        // Remove saved progress
        setSavedQuizProgress((prev) => {
          const copy = { ...prev };
          delete copy[quizId];
          return copy;
        });
        // Remove the quiz itself if it has no completed attempts
        const hasAttempts = attempts.some((a) => a.quizId === quizId);
        if (!hasAttempts) {
          setQuizzes((prev) => prev.filter((q) => q.id !== quizId));
        }
        setQuizPaused(false);
        setSelectedQuiz(null);
        setConfirmAction(null);
        navigate("exam");
      },
    });
  };

  // ── Resume Saved Quiz ──
  const resumeSavedQuiz = (quiz) => {
    const saved = savedQuizProgress[quiz.id];
    if (!saved) return;
    setSelectedQuiz(quiz);
    setAnswers(saved.answers || {});
    setCurrentQ(saved.currentQ || 0);
    setTimerSeconds(saved.timerSeconds || 0);
    setTimerEnabled(saved.timerEnabled || false);
    setQuizSubmitted(false);
    setQuizPaused(false);
    // Clear the saved progress since we're resuming
    setSavedQuizProgress((prev) => {
      const copy = { ...prev };
      delete copy[quiz.id];
      return copy;
    });
    setPage("quiz");
  };

  // ═══════════════════════════════════════════════════════════════════════
  // ── RENDER ──
  // ═══════════════════════════════════════════════════════════════════════

  // ── Landing Page ──
  if (page === "landing") {
    return (
      <div className="landing">
        <style>{CSS}</style>
        <div className="landing-hero">
          <div className="hero-content">
            <div className="hero-badge">🔬 Built for Pre-Med Students</div>
            <h1 className="hero-title">
              Study smarter with<br /><span>Med Track Quizzer</span>
            </h1>
            <p className="hero-subtitle">
              Upload your class materials, and we'll generate practice quizzes grounded in your content — with citations for every answer.
            </p>
            <div className="hero-actions">
              <button className="btn-hero btn-hero-primary" onClick={() => { setAuthMode("signup"); setPage("auth"); }}>
                Get Started Free
              </button>
              <button className="btn-hero btn-hero-secondary" onClick={() => { setAuthMode("login"); setPage("auth"); }}>
                Sign In
              </button>
            </div>
          </div>
        </div>
        <div className="landing-features">
          <div className="features-grid">
            {[
              { icon: "📄", title: "Upload Anything", desc: "PDF, PPTX, DOCX, or TXT — upload your lecture slides, notes, and study guides." },
              { icon: "🧠", title: "AI-Grounded Quizzes", desc: "Every question is generated from YOUR materials. No hallucinations, always cited." },
              { icon: "📊", title: "Track & Improve", desc: "Review missed questions, retake targeted quizzes, and use spaced repetition." },
              { icon: "⚡", title: "Multiple Modes", desc: "Quick review, standard practice, hard mode for reasoning, or drill into specific topics." },
              { icon: "🃏", title: "Flashcards", desc: "Auto-generate flashcards from your materials with source citations." },
              { icon: "🔒", title: "Your Data, Private", desc: "Everything stays in your account. Delete anytime." },
            ].map((f, i) => (
              <div key={i} className="feature-card" style={{ animationDelay: `${i * 0.1}s` }}>
                <div className="icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Auth Page ──
  if (page === "auth") {
    return (
      <div className="app">
        <style>{CSS}</style>
        <div className="nav">
          <div className="nav-logo" onClick={() => setPage("landing")}>
            <div className="logo-icon">🔬</div>
            Med Track Quizzer
          </div>
        </div>
        <div className="container">
          <div className="card auth-card slide-up">
            <h2>{authMode === "signup" ? "Create Account" : "Welcome Back"}</h2>
            <p className="sub">{authMode === "signup" ? "Start studying smarter today" : "Sign in to continue"}</p>
            {error && <div className="content-warning">{error}</div>}
            {authMode === "signup" && (
              <div className="form-group">
                <label className="label">Full Name</label>
                <input className="input" placeholder="Your name" value={authForm.name} onChange={(e) => setAuthForm({ ...authForm, name: e.target.value })} />
              </div>
            )}
            <div className="form-group">
              <label className="label">Email</label>
              <input className="input" type="email" placeholder="you@school.edu" value={authForm.email} onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="label">Password</label>
              <input className="input" type="password" placeholder="••••••••" value={authForm.password} onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} onKeyDown={(e) => e.key === "Enter" && handleAuth()} />
            </div>
            <button className="btn btn-primary btn-lg" style={{ width: "100%" }} onClick={handleAuth}>
              {authMode === "signup" ? "Create Account" : "Sign In"}
            </button>
            <div className="auth-toggle">
              {authMode === "signup" ? (
                <>Already have an account? <span onClick={() => { setAuthMode("login"); setError(""); }}>Sign in</span></>
              ) : (
                <>Don't have an account? <span onClick={() => { setAuthMode("signup"); setError(""); }}>Sign up</span></>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Main App Shell ──
  const ConfirmModal = () => confirmAction ? (
    <div className="modal-overlay" onClick={() => setConfirmAction(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>{confirmAction.confirmStyle === "danger" ? "⚠️" : "❓"}</div>
        <h2>{confirmAction.title}</h2>
        <p className="sub">{confirmAction.message}</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button className="btn btn-secondary btn-lg" onClick={() => setConfirmAction(null)}>Cancel</button>
          <button className={`btn ${confirmAction.confirmStyle === "danger" ? "btn-danger" : "btn-primary"} btn-lg`} onClick={confirmAction.onConfirm}>
            {confirmAction.confirmLabel || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const NavBar = () => (
    <>
    <ConfirmModal />
    <div className="nav">
      <div className="nav-logo" onClick={() => navigate("dashboard")}>
        <div className="logo-icon">🔬</div>
        Med Track Quizzer
      </div>
      <div className="nav-links">
        <button className={page === "dashboard" ? "active" : ""} onClick={() => navigate("dashboard")}>Dashboard</button>
        {selectedExam && <button className={page === "exam" ? "active" : ""} onClick={() => navigate("exam")}>Exam</button>}
        {selectedExam && <button className={page === "study" ? "active" : ""} onClick={() => navigate("study")}>Study</button>}
        <button className={page === "settings" ? "active" : ""} onClick={() => navigate("settings")}>Settings</button>
      </div>
      <div className="nav-user">
        <div className="nav-avatar">{user?.name?.[0]?.toUpperCase()}</div>
      </div>
    </div>
    </>
  );

  // ── Dashboard ──
  if (page === "dashboard") {
    const userCourses = courses.filter((c) => c.userId === user?.id);
    return (
      <div className="app">
        <style>{CSS}</style>
        <NavBar />
        <div className="container">
          <div className="dash-header fade-in">
            <div>
              <h1>Welcome back, {user?.name?.split(" ")[0]} 👋</h1>
              <p style={{ color: "var(--ink-muted)", fontSize: 14, marginTop: 4 }}>Your courses are listed below. Click a course to view your practice quizzes.</p>
            </div>
            <button className="btn btn-primary" onClick={() => setModal("new-course")}>+ New Course</button>
          </div>

          {userCourses.length === 0 ? (
            <div className="empty-state slide-up">
              <div className="icon">📚</div>
              <h3>No courses yet</h3>
              <p>Create your first course to start uploading study materials and generating practice quizzes.</p>
              <button className="btn btn-primary" onClick={() => setModal("new-course")}>Create a Course</button>
            </div>
          ) : (
            <div className="courses-grid">
              {userCourses.map((c, i) => {
                const courseExams = exams.filter((e) => e.courseId === c.id);
                return (
                  <div key={c.id} className="card card-flat course-card slide-up" style={{ animationDelay: `${i * 0.05}s` }} onClick={() => { setSelectedCourse(c); navigate("course"); }}>
                    <div className="course-name">{c.name}</div>
                    <div className="course-term">{c.term}</div>
                    <div className="exam-count">
                      📝 {courseExams.length} exam{courseExams.length !== 1 ? "s" : ""}
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
                      <button className="btn btn-sm btn-secondary" onClick={(e) => { e.stopPropagation(); setModal({ type: "edit-course", course: c }); }}>Edit</button>
                      <button className="btn btn-sm btn-danger" onClick={(e) => { e.stopPropagation(); setConfirmAction({ title: "Delete Course?", message: "This will delete this course and all its exams, files, and quizzes.", confirmLabel: "Delete Course", confirmStyle: "danger", onConfirm: () => { deleteCourse(c.id); setConfirmAction(null); } }); }}>Delete</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* New Course Modal */}
        {modal === "new-course" && <Modal title="New Course" sub="Add a new course to your dashboard" onClose={() => setModal(null)}>
          <CourseForm onSubmit={createCourse} />
        </Modal>}

        {/* Edit Course Modal */}
        {modal?.type === "edit-course" && <Modal title="Edit Course" sub="Update your course details" onClose={() => setModal(null)}>
          <CourseForm
            initial={modal.course}
            submitLabel="Save Changes"
            onSubmit={(name, term) => {
              setCourses((prev) => prev.map((c) => c.id === modal.course.id ? { ...c, name, term } : c));
              setModal(null);
            }}
          />
        </Modal>}
      </div>
    );
  }

  // ── Course Page (list exams) ──
  if (page === "course" && selectedCourse) {
    const courseExams = exams.filter((e) => e.courseId === selectedCourse.id);
    return (
      <div className="app">
        <style>{CSS}</style>
        <NavBar />
        <div className="container">
          <div className="exam-header fade-in">
            <div className="breadcrumb">
              <span onClick={() => navigate("dashboard")}>Dashboard</span> › {selectedCourse.name}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
              <h1>{selectedCourse.name}</h1>
              <button className="btn btn-primary" onClick={() => setModal("new-exam")}>+ New Exam</button>
            </div>
            <p style={{ color: "var(--ink-muted)", fontSize: 14, marginTop: 6 }}>Click into an exam to upload study materials, generate quizzes, and review results.</p>
          </div>

          {courseExams.length === 0 ? (
            <div className="empty-state slide-up">
              <div className="icon">📝</div>
              <h3>No exams yet</h3>
              <p>Create an exam to upload your study materials and generate practice quizzes.</p>
              <button className="btn btn-primary" onClick={() => setModal("new-exam")}>Create an Exam</button>
            </div>
          ) : (
            <div className="courses-grid">
              {courseExams.map((e, i) => {
                const eDocs = documents.filter((d) => d.examId === e.id);
                const eQuizzes = quizzes.filter((q) => q.examId === e.id);
                return (
                  <div key={e.id} className="card card-flat course-card slide-up" style={{ animationDelay: `${i * 0.05}s` }} onClick={() => { setSelectedExam(e); navigate("exam"); }}>
                    <div className="course-name">{e.name}</div>
                    <div className="course-term">{e.date ? fmtDate(e.date) : "No date set"}</div>
                    <div style={{ display: "flex", gap: 16, fontSize: 13, color: "var(--ink-light)", marginTop: 8 }}>
                      <span>📄 {eDocs.length} file{eDocs.length !== 1 ? "s" : ""}</span>
                      <span>📋 {eQuizzes.length} quiz{eQuizzes.length !== 1 ? "zes" : ""}</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
                      <button className="btn btn-sm btn-secondary" onClick={(ev) => { ev.stopPropagation(); setModal({ type: "edit-exam", exam: e }); }}>Edit</button>
                      <button className="btn btn-sm btn-danger" onClick={(ev) => { ev.stopPropagation(); setConfirmAction({ title: "Delete Exam?", message: "This will delete this exam and all its files and quizzes.", confirmLabel: "Delete Exam", confirmStyle: "danger", onConfirm: () => { deleteExam(e.id); setConfirmAction(null); } }); }}>Delete</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {modal === "new-exam" && <Modal title="New Exam" sub="Create an exam to study for" onClose={() => setModal(null)}>
          <ExamForm onSubmit={createExam} />
        </Modal>}

        {/* Edit Exam Modal */}
        {modal?.type === "edit-exam" && <Modal title="Edit Exam" sub="Update your exam details" onClose={() => setModal(null)}>
          <ExamForm
            initial={modal.exam}
            submitLabel="Save Changes"
            onSubmit={(name, date) => {
              setExams((prev) => prev.map((ex) => ex.id === modal.exam.id ? { ...ex, name, date } : ex));
              // Update selectedExam if it's the one being edited
              if (selectedExam?.id === modal.exam.id) setSelectedExam((prev) => ({ ...prev, name, date }));
              setModal(null);
            }}
          />
        </Modal>}
      </div>
    );
  }

  // ── Exam Page ──
  if (page === "exam" && selectedExam) {
    const readyDocs = examDocs.filter((d) => d.status === "ready");
    return (
      <div className="app">
        <style>{CSS}</style>
        <NavBar />
        <div className="container">
          <div className="exam-header fade-in">
            <div className="breadcrumb">
              <span onClick={() => navigate("dashboard")}>Dashboard</span> ›{" "}
              <span onClick={() => navigate("course")}>{selectedCourse?.name}</span> ›{" "}
              {selectedExam.name}
            </div>
            <h1>{selectedExam.name}</h1>
          </div>

          {error && <div className="content-warning">{error}</div>}

          {/* Saved Quiz Banner */}
          {examQuizzes.filter((q) => savedQuizProgress[q.id]).map((q) => {
            const saved = savedQuizProgress[q.id];
            const total = q.questions?.length || 0;
            const modeInfo = QUIZ_MODES.find((m) => m.id === q.mode);
            const answeredCount = Object.keys(saved.answers || {}).length;
            return (
              <div key={q.id} className="saved-banner slide-up">
                <div>
                  <div className="saved-info">⏸ You have a saved quiz in progress</div>
                  <div className="saved-detail">
                    {modeInfo?.icon} {modeInfo?.name || q.mode} · Question {saved.currentQ + 1} of {total} · {answeredCount} answered · Saved {fmtDate(saved.savedAt)}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => resumeSavedQuiz(q)}>▶ Resume Quiz</button>
                  <button className="btn btn-danger btn-sm" onClick={() => {
                    const quizId = q.id;
                    setConfirmAction({
                      title: "Discard Saved Quiz?",
                      message: "This will permanently delete your saved progress and remove this quiz from your history.",
                      confirmLabel: "Discard",
                      confirmStyle: "danger",
                      onConfirm: () => {
                        setSavedQuizProgress((prev) => { const copy = { ...prev }; delete copy[quizId]; return copy; });
                        // Remove quiz from history if no completed attempts
                        const hasAttempts = attempts.some((a) => a.quizId === quizId);
                        if (!hasAttempts) {
                          setQuizzes((prev) => prev.filter((qz) => qz.id !== quizId));
                        }
                        setConfirmAction(null);
                      },
                    });
                  }}>Discard</button>
                </div>
              </div>
            );
          })}

          {/* Upload Section */}
          <div className="card slide-up" style={{ marginBottom: 20 }}>
            <div className="section-title">📄 Study Materials</div>
            <div className="content-warning" style={{ marginBottom: 16 }}>
              ⚠️ Please upload your personal notes and professor-provided slides. Avoid uploading copyrighted textbook pages in bulk.
            </div>
            <UploadZone onFiles={handleFileUpload} />
            {examDocs.length > 0 && (
              <div className="file-list">
                {examDocs.map((d) => (
                  <div key={d.id} className="file-item">
                    <span className="file-icon">{d.fileType === "pdf" ? "📕" : d.fileType === "pptx" ? "📊" : d.fileType === "docx" ? "📘" : "📝"}</span>
                    <span className="file-name">{d.fileName}</span>
                    <span className={`badge ${d.status === "ready" ? "badge-green" : d.status === "processing" ? "badge-yellow" : "badge-red"}`}>
                      {d.status === "processing" && "⏳ "}
                      {d.status}
                    </span>
                    <button className="file-delete" onClick={() => deleteDocument(d.id)}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Topics */}
          {topics.length > 0 && (
            <div className="card slide-up" style={{ marginBottom: 20, animationDelay: "0.1s" }}>
              <div className="section-title">🏷️ Topics Detected</div>
              <p style={{ fontSize: 13, color: "var(--ink-muted)", marginBottom: 12, lineHeight: 1.5 }}>
                Select one or more topics below to <strong>focus your quiz</strong> on those areas. If none are selected, the quiz will cover all topics evenly. In Drill Mode, select the single topic you want to drill into.
              </p>
              {selectedTopics.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 13 }}>
                  <span style={{ color: "var(--accent)", fontWeight: 600 }}>{selectedTopics.length} topic{selectedTopics.length > 1 ? "s" : ""} selected</span>
                  <button className="btn btn-ghost btn-sm" style={{ fontSize: 12, padding: "2px 8px" }} onClick={() => setSelectedTopics([])}>Clear all</button>
                </div>
              )}
              <div className="topics-list">
                {topics.map((t) => (
                  <span key={t} className={`topic-tag ${selectedTopics.includes(t) ? "selected" : ""}`} onClick={() => {
                    setSelectedTopics((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]);
                  }}>
                    {selectedTopics.includes(t) && "✓ "}{t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Quiz Generation */}
          <div className="card slide-up" style={{ marginBottom: 20, animationDelay: "0.2s" }}>
            <div className="section-title">⚡ Generate Quiz</div>

            {readyDocs.length > 0 && (
              <div style={{ padding: "10px 14px", background: "var(--success-pale)", borderRadius: "var(--radius-sm)", marginBottom: 16, fontSize: 13, color: "var(--success)", display: "flex", alignItems: "center", gap: 8 }}>
                ✓ Knowledge base ready — {readyDocs.length} file{readyDocs.length !== 1 ? "s" : ""} loaded with {allChunks.length} content chunks
              </div>
            )}

            <div className="mode-grid">
              {QUIZ_MODES.map((m) => (
                <div key={m.id} className={`mode-card ${quizMode === m.id ? "selected" : ""}`} onClick={() => setQuizMode(m.id)}>
                  <div className="mode-icon">{m.icon}</div>
                  <div className="mode-name">{m.name}</div>
                  <div className="mode-desc">{m.desc}</div>
                </div>
              ))}
            </div>

            {quizMode === "drill" && (
              <div style={{ marginBottom: 16 }}>
                <label className="label">Select a topic to drill {selectedTopics.length === 1 ? `(using: ${selectedTopics[0]})` : ""}</label>
                {selectedTopics.length !== 1 && (
                  <p style={{ fontSize: 13, color: "var(--warning)", marginBottom: 8 }}>
                    ⚠️ For Drill Mode, select exactly 1 topic from the Detected Topics section above.
                  </p>
                )}
                <select className="select" value={selectedTopics[0] || ""} onChange={(e) => setSelectedTopics(e.target.value ? [e.target.value] : [])}>
                  <option value="">Choose a topic...</option>
                  {topics.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            )}

            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer" }}>
                <input type="checkbox" checked={timerEnabled} onChange={(e) => setTimerEnabled(e.target.checked)} />
                Enable timer
              </label>
              {!loading ? (
                <button className="btn btn-primary btn-lg" disabled={readyDocs.length === 0 || (quizMode === "drill" && selectedTopics.length !== 1)} onClick={generateQuiz}>
                  Generate Quiz
                </button>
              ) : (
                <button className="btn btn-danger btn-lg" onClick={cancelGeneration}>
                  Cancel
                </button>
              )}
            </div>
            {loading && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, padding: "10px 14px", background: "var(--blue-pale)", borderRadius: "var(--radius-sm)", fontSize: 13, color: "var(--blue)" }}>
                <div className="spinner" style={{ width: 18, height: 18, borderTopColor: "var(--blue)" }} />
                <div>
                  <strong>Generating your quiz...</strong>
                  <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>Estimated time: {allChunks.length > 30 ? "30–50" : "15–30"} seconds. Questions are being created from your study materials.</div>
                </div>
              </div>
            )}
          </div>

          {/* Quiz History */}
          {examQuizzes.length > 0 && (
            <div className="card slide-up" style={{ animationDelay: "0.25s" }}>
              <div className="section-title">📋 Previous Quizzes</div>
              {examQuizzes.sort((a, b) => b.created - a.created).map((q) => {
                const att = attempts.filter((a) => a.quizId === q.id);
                const bestScore = att.length > 0 ? Math.max(...att.map((a) => a.score)) : null;
                const total = q.questions?.length || 0;
                const hasSavedProgress = !!savedQuizProgress[q.id];
                const saved = savedQuizProgress[q.id];
                const modeInfo = QUIZ_MODES.find((m) => m.id === q.mode);
                return (
                  <div key={q.id} className="history-item" style={{ flexWrap: "wrap", gap: 8 }} onClick={() => {
                    if (hasSavedProgress) {
                      resumeSavedQuiz(q);
                    } else if (att.length > 0) {
                      setSelectedQuiz(q);
                      setSelectedAttempt(att[att.length - 1]);
                      setPage("results");
                    }
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 15, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        {modeInfo?.icon} {modeInfo?.name || q.mode}
                        {hasSavedProgress && <span className="badge badge-yellow">⏸ In Progress</span>}
                      </div>
                      <div style={{ fontSize: 13, color: "var(--ink-muted)" }}>{fmtDate(q.created)} · {total} questions</div>
                      {hasSavedProgress && saved && (
                        <div style={{ fontSize: 12, color: "var(--warning)", marginTop: 2 }}>
                          {saved.currentQ + 1}/{total} answered · Saved {fmtDate(saved.savedAt)}
                        </div>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {hasSavedProgress ? (
                        <button className="btn btn-primary btn-sm" onClick={(e) => { e.stopPropagation(); resumeSavedQuiz(q); }}>
                          ▶ Resume
                        </button>
                      ) : (
                        <div style={{ textAlign: "right" }}>
                          {bestScore !== null && <div className={`badge ${bestScore / total >= 0.8 ? "badge-green" : bestScore / total >= 0.6 ? "badge-yellow" : "badge-red"}`}>Best: {bestScore}/{total}</div>}
                          {att.length > 0 && <div style={{ fontSize: 12, color: "var(--ink-muted)", marginTop: 4 }}>{att.length} attempt{att.length > 1 ? "s" : ""}</div>}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Quiz Page ──
  if (page === "quiz" && selectedQuiz) {
    const questions = selectedQuiz.questions || [];
    const q = questions[currentQ];
    const progress = ((currentQ + 1) / questions.length) * 100;

    if (quizPaused) {
      return (
        <div className="app">
          <style>{CSS}</style>
          <NavBar />
          <div className="container">
            <div className="quiz-container" style={{ textAlign: "center", paddingTop: 80 }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>⏸️</div>
              <h2 style={{ fontFamily: "var(--font-display)", marginBottom: 8 }}>Quiz Paused</h2>
              <p style={{ color: "var(--ink-muted)", marginBottom: 8 }}>Take a break. Your progress is saved in memory.</p>
              <p style={{ color: "var(--ink-muted)", marginBottom: 28, fontSize: 13 }}>
                Question {currentQ + 1} of {questions.length} · {Object.keys(answers).length} answered
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center", maxWidth: 320, margin: "0 auto" }}>
                <button className="btn btn-primary btn-lg" style={{ width: "100%" }} onClick={() => setQuizPaused(false)}>▶ Resume Quiz</button>
                <button className="btn btn-secondary btn-lg" style={{ width: "100%" }} onClick={saveAndExitQuiz}>💾 Save & Exit</button>
                <button className="btn btn-danger btn-lg" style={{ width: "100%" }} onClick={quitQuiz}>✕ Quit Quiz</button>
              </div>
              <p style={{ color: "var(--ink-muted)", fontSize: 12, marginTop: 16 }}>
                <strong>Save & Exit</strong> keeps your progress so you can come back later.<br />
                <strong>Quit</strong> discards your progress permanently.
              </p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="app">
        <style>{CSS}</style>
        <NavBar />
        <div className="container">
          <div className="quiz-container">
            <div className="quiz-header fade-in">
              <div className="quiz-info">
                Question {currentQ + 1} of {questions.length}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {timerEnabled && <div className="quiz-timer">⏱ {fmtTime(timerSeconds)}</div>}
                <button className="btn btn-ghost btn-sm" onClick={() => setQuizPaused(true)}>⏸ Pause</button>
                <button className="btn btn-ghost btn-sm" onClick={saveAndExitQuiz} title="Save progress and exit">💾 Save & Exit</button>
                <button className="btn btn-ghost btn-sm" style={{ color: "var(--danger)" }} onClick={quitQuiz} title="Quit without saving">✕ Quit</button>
              </div>
            </div>
            <div className="progress-bar" style={{ marginBottom: 24 }}>
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>

            {q && (
              <div className="card question-card">
                <div className="question-number">
                  Question {currentQ + 1}
                  <span className="question-type-badge">
                    {q.type === "multiple_choice" ? "Multiple Choice" : q.type === "select_all" ? "Multi-Select" : q.type === "fill_blank" ? "Fill in the Blank" : "Short Answer"}
                  </span>
                </div>
                <div className="question-prompt">{q.prompt.replace(/\s*\(?select all that apply\.?\)?\s*/gi, " ").trim()}</div>
                {q.type === "select_all" && (
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)", marginBottom: 14 }}>(Select all that apply)</div>
                )}

                {(q.type === "multiple_choice" || q.type === "select_all") && q.options && (
                  <div className="options-list">
                    {q.options.map((opt, i) => {
                      const letter = String.fromCharCode(65 + i);
                      const isSelected = q.type === "select_all"
                        ? (answers[q.prompt] || []).includes(opt)
                        : answers[q.prompt] === opt;
                      return (
                        <button key={i} className={`option-btn ${isSelected ? "selected" : ""}`} onClick={() => {
                          if (q.type === "select_all") {
                            const prev = answers[q.prompt] || [];
                            setAnswers({ ...answers, [q.prompt]: isSelected ? prev.filter((x) => x !== opt) : [...prev, opt] });
                          } else {
                            setAnswers({ ...answers, [q.prompt]: opt });
                          }
                        }}>
                          <div className="option-letter">{letter}</div>
                          <div>{opt}</div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {(q.type === "fill_blank" || q.type === "short_answer") && (
                  <input className="fill-blank-input" placeholder={q.type === "fill_blank" ? "Type your answer..." : "Write your answer..."} value={answers[q.prompt] || ""} onChange={(e) => setAnswers({ ...answers, [q.prompt]: e.target.value })} />
                )}
              </div>
            )}

            <div className="quiz-nav">
              <button className="btn btn-secondary" disabled={currentQ === 0} onClick={() => setCurrentQ(currentQ - 1)}>
                ← Previous
              </button>
              <div style={{ display: "flex", gap: 8 }}>
                {currentQ < questions.length - 1 ? (
                  <button className="btn btn-primary" onClick={() => setCurrentQ(currentQ + 1)}>
                    Next →
                  </button>
                ) : (
                  <button className="btn btn-primary" onClick={() => {
                    // Count unanswered questions
                    const unanswered = questions.filter((qq) => {
                      const a = answers[qq.prompt];
                      if (a === undefined || a === null || a === "") return true;
                      if (Array.isArray(a) && a.length === 0) return true;
                      return false;
                    });
                    if (unanswered.length > 0) {
                      setConfirmAction({
                        title: "Unanswered Questions",
                        message: `You have ${unanswered.length} unanswered question${unanswered.length > 1 ? "s" : ""}. Do you want to submit anyway or go back and answer them?`,
                        confirmLabel: "Submit Anyway",
                        confirmStyle: "primary",
                        onConfirm: () => { setConfirmAction(null); submitQuiz(); },
                      });
                    } else {
                      submitQuiz();
                    }
                  }}>
                    Submit Quiz ✓
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Results Page ──
  if (page === "results" && selectedQuiz && selectedAttempt) {
    const questions = selectedQuiz.questions || [];
    const { score, total, time } = selectedAttempt;
    const pct = total > 0 ? Math.round((score / total) * 100) : 0;
    const scoreColor = pct >= 80 ? "var(--success)" : pct >= 60 ? "var(--warning)" : "var(--danger)";
    const scoreBg = pct >= 80 ? "var(--success-pale)" : pct >= 60 ? "var(--warning-pale)" : "var(--danger-pale)";

    // Topic breakdown
    const topicStats = {};
    for (const q of questions) {
      const t = q.topic || "General";
      if (!topicStats[t]) topicStats[t] = { correct: 0, total: 0 };
      topicStats[t].total++;
      const userAns = selectedAttempt.answers?.[q.prompt];
      let isCorrect = false;
      if (q.type === "select_all") {
        const c = Array.isArray(q.correct) ? q.correct.sort().join(",") : q.correct;
        const u = Array.isArray(userAns) ? userAns.sort().join(",") : "";
        isCorrect = c === u;
      } else if (q.type === "fill_blank" || q.type === "short_answer") {
        isCorrect = String(userAns || "").toLowerCase().trim() === String(q.correct).toLowerCase().trim();
      } else {
        isCorrect = userAns === q.correct;
      }
      if (isCorrect) topicStats[t].correct++;
    }

    return (
      <div className="app">
        <style>{CSS}</style>
        <NavBar />
        <div className="container">
          <div className="quiz-container">
            <div className="results-hero">
              <div className="score-circle" style={{ borderColor: scoreColor, background: scoreBg, color: scoreColor }}>
                {pct}%
                <div style={{ fontSize: 14, fontWeight: 400, fontFamily: "var(--font-body)" }}>{score}/{total}</div>
              </div>
              <h2>{pct >= 80 ? "Great work! 🎉" : pct >= 60 ? "Good effort! 💪" : "Keep studying! 📖"}</h2>
              <p>{timerEnabled && time > 0 ? `Completed in ${fmtTime(time)}` : `${fmtDate(selectedAttempt.date)}`}</p>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16, flexWrap: "wrap" }}>
                <button className="btn btn-primary" onClick={() => navigate("exam")}>
                  Generate New Quiz
                </button>
                <button className="btn btn-secondary" onClick={() => navigate("study")}>
                  Study Missed Questions
                </button>
              </div>
            </div>

            {/* Topic Breakdown */}
            <div className="section-title" style={{ marginTop: 24 }}>📊 Topic Breakdown</div>
            <div className="results-breakdown">
              {Object.entries(topicStats).map(([topic, stats]) => {
                const topicPct = Math.round((stats.correct / stats.total) * 100);
                return (
                  <div key={topic} className="breakdown-card">
                    <div className="stat" style={{ color: topicPct >= 80 ? "var(--success)" : topicPct >= 60 ? "var(--warning)" : "var(--danger)" }}>
                      {topicPct}%
                    </div>
                    <div className="stat-label">{topic}</div>
                    <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>{stats.correct}/{stats.total} correct</div>
                  </div>
                );
              })}
            </div>

            {/* Review Questions */}
            <div className="section-title">📝 Review All Questions</div>
            {questions.map((q, i) => {
              const userAns = selectedAttempt.answers?.[q.prompt];
              let isCorrect = false;
              if (q.type === "select_all") {
                const c = Array.isArray(q.correct) ? q.correct.sort().join(",") : q.correct;
                const u = Array.isArray(userAns) ? userAns.sort().join(",") : "";
                isCorrect = c === u;
              } else if (q.type === "fill_blank" || q.type === "short_answer") {
                isCorrect = String(userAns || "").toLowerCase().trim() === String(q.correct).toLowerCase().trim();
              } else {
                isCorrect = userAns === q.correct;
              }

              return (
                <div key={i} className="card review-question" style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8, flexWrap: "wrap", gap: 6 }}>
                    <div>
                      <span className="question-number" style={{ margin: 0 }}>Question {i + 1}</span>
                      {q.citation?.fileName && (
                        <div style={{ fontSize: 12, color: "var(--blue)", marginTop: 3, display: "flex", alignItems: "center", gap: 4 }}>
                          📄 Source: <strong>{q.citation.fileName}</strong>
                        </div>
                      )}
                    </div>
                    <span className={`badge ${isCorrect ? "badge-green" : "badge-red"}`}>{isCorrect ? "✓ Correct" : "✗ Incorrect"}</span>
                  </div>
                  <div style={{ fontWeight: 500, marginBottom: 10, fontSize: 15, lineHeight: 1.5 }}>{q.prompt.replace(/\s*\(?select all that apply\.?\)?\s*/gi, " ").trim()}</div>

                  {(q.type === "multiple_choice" || q.type === "select_all") && q.options && (
                    <div className="options-list" style={{ marginBottom: 10 }}>
                      {q.options.map((opt, j) => {
                        const isUserPick = q.type === "select_all" ? (userAns || []).includes(opt) : userAns === opt;
                        const isCorrectOpt = q.type === "select_all" ? (Array.isArray(q.correct) ? q.correct : [q.correct]).includes(opt) : q.correct === opt;
                        let cls = "";
                        if (isCorrectOpt) cls = "correct";
                        else if (isUserPick && !isCorrectOpt) cls = "incorrect";
                        return (
                          <div key={j} className={`option-btn ${cls}`} style={{ cursor: "default" }}>
                            <div className="option-letter">{String.fromCharCode(65 + j)}</div>
                            <div>{opt} {isUserPick && !isCorrectOpt && <span style={{ fontSize: 12, color: "var(--danger)" }}>(Your answer)</span>}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {(q.type === "fill_blank" || q.type === "short_answer") && (
                    <div style={{ marginBottom: 10, fontSize: 14 }}>
                      <div><strong>Your answer:</strong> {userAns || <em style={{ color: "var(--ink-muted)" }}>No answer</em>}</div>
                      <div><strong>Correct answer:</strong> <span style={{ color: "var(--success)" }}>{q.correct}</span></div>
                    </div>
                  )}

                  <div className="explanation-box">
                    💡 {q.explanation}
                  </div>

                  {q.citation && (
                    <div className="citation-box">
                      <div className="cite-label">📎 Where this came from</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: 16 }}>{q.citation.fileName?.endsWith('.pdf') ? '📕' : q.citation.fileName?.endsWith('.pptx') ? '📊' : q.citation.fileName?.endsWith('.docx') ? '📘' : '📝'}</span>
                        <strong>{q.citation.fileName}</strong>
                      </div>
                      <div style={{ fontStyle: "italic", color: "var(--ink-light)" }}>"{q.citation.excerpt}"</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // ── Study Page ──
  if (page === "study") {
    return (
      <div className="app">
        <style>{CSS}</style>
        <NavBar />
        <div className="container">
          <div className="exam-header fade-in">
            <div className="breadcrumb">
              <span onClick={() => navigate("dashboard")}>Dashboard</span> ›{" "}
              <span onClick={() => navigate("exam")}>{selectedExam?.name}</span> ›{" "}
              Study Tools
            </div>
            <h1>Study Tools</h1>
          </div>

          <div className="tabs">
            <button className={`tab ${studyTab === "missed" ? "active" : ""}`} onClick={() => setStudyTab("missed")}>Missed Questions</button>
            <button className={`tab ${studyTab === "flashcards" ? "active" : ""}`} onClick={() => setStudyTab("flashcards")}>Flashcards</button>
            <button className={`tab ${studyTab === "spaced" ? "active" : ""}`} onClick={() => setStudyTab("spaced")}>Spaced Repetition</button>
          </div>

          {studyTab === "missed" && (
            <div className="slide-up">
              {missedQuestions.length === 0 ? (
                <div className="empty-state">
                  <div className="icon">🎯</div>
                  <h3>No missed questions</h3>
                  <p>Take a quiz first, and any questions you miss will appear here for review.</p>
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
                    <p style={{ color: "var(--ink-muted)", fontSize: 14 }}>{missedQuestions.length} missed question{missedQuestions.length !== 1 ? "s" : ""}</p>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {!loading ? (
                        <button className="btn btn-primary" onClick={retakeMissed}>
                          🔄 Retake Missed Questions
                        </button>
                      ) : (
                        <>
                          <button className="btn btn-danger" onClick={cancelGeneration}>
                            Cancel
                          </button>
                          <div className="spinner" style={{ width: 18, height: 18 }} />
                          <span style={{ fontSize: 13, color: "var(--ink-muted)" }}>Generating...</span>
                        </>
                      )}
                    </div>
                  </div>
                  {missedQuestions.slice(0, 20).map((q, i) => (
                    <div key={i} className="card" style={{ marginBottom: 8, padding: 16 }}>
                      <div style={{ fontWeight: 500, marginBottom: 6 }}>{q.prompt.replace(/\s*\(?select all that apply\.?\)?\s*/gi, " ").trim()}</div>
                      <div style={{ fontSize: 13, color: "var(--ink-muted)" }}>
                        Your answer: <span style={{ color: "var(--danger)" }}>{Array.isArray(q.userAnswer) ? q.userAnswer.join(", ") : q.userAnswer || "—"}</span>
                        {" · "}Correct: <span style={{ color: "var(--success)" }}>{Array.isArray(q.correct) ? q.correct.join(", ") : q.correct}</span>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {studyTab === "flashcards" && (
            <div className="slide-up">
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
                <button className="btn btn-primary" onClick={() => generateFlashcardsHandler("")} disabled={loading || allChunks.length === 0}>
                  {loading ? "Generating..." : "Generate Flashcards"}
                </button>
                {topics.slice(0, 5).map((t) => (
                  <button key={t} className="btn btn-secondary btn-sm" onClick={() => generateFlashcardsHandler(t)} disabled={loading}>{t}</button>
                ))}
              </div>

              {flashcards.length > 0 && (
                <>
                  <div className="flashcard" onClick={() => setCardFlipped(!cardFlipped)}>
                    <div className={`flashcard-inner ${cardFlipped ? "flipped" : ""}`}>
                      <div className="flashcard-face flashcard-front">
                        <div className="card-label">Question</div>
                        <div className="card-text">{flashcards[currentCard]?.front}</div>
                      </div>
                      <div className="flashcard-face flashcard-back">
                        <div className="card-label">Answer</div>
                        <div className="card-text">{flashcards[currentCard]?.back}</div>
                        {flashcards[currentCard]?.citation && (
                          <div style={{ position: "absolute", bottom: 16, fontSize: 11, opacity: 0.7 }}>
                            📎 {flashcards[currentCard].citation.fileName}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 20 }}>
                    <button className="btn btn-secondary" disabled={currentCard === 0} onClick={() => { setCurrentCard(currentCard - 1); setCardFlipped(false); }}>← Previous</button>
                    <span style={{ padding: "10px 0", color: "var(--ink-muted)", fontSize: 14 }}>{currentCard + 1} / {flashcards.length}</span>
                    <button className="btn btn-secondary" disabled={currentCard === flashcards.length - 1} onClick={() => { setCurrentCard(currentCard + 1); setCardFlipped(false); }}>Next →</button>
                  </div>
                </>
              )}

              {flashcards.length === 0 && !loading && (
                <div className="empty-state">
                  <div className="icon">🃏</div>
                  <h3>No flashcards yet</h3>
                  <p>Click "Generate Flashcards" to create study cards from your uploaded materials.</p>
                </div>
              )}
            </div>
          )}

          {studyTab === "spaced" && (
            <div className="slide-up">
              <div className="card" style={{ marginBottom: 16, padding: 20 }}>
                <div className="section-title" style={{ marginBottom: 12 }}>📅 Spaced Repetition Schedule</div>
                <p style={{ color: "var(--ink-muted)", fontSize: 14, marginBottom: 16 }}>
                  Missed questions are automatically scheduled for review at increasing intervals: 1 day, 3 days, 7 days, and 14 days.
                </p>
                {SPACED_INTERVALS.map((interval) => {
                  const dueDate = new Date();
                  dueDate.setDate(dueDate.getDate() + interval.days);
                  const dueQuestions = missedQuestions.filter((q) => {
                    const elapsed = (Date.now() - q.attemptDate) / (1000 * 60 * 60 * 24);
                    return elapsed >= interval.days - 0.5 && elapsed < interval.days + 0.5;
                  });
                  return (
                    <div key={interval.days} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid #eee" }}>
                      <div>
                        <div style={{ fontWeight: 600 }}>Review in {interval.label}</div>
                        <div style={{ fontSize: 13, color: "var(--ink-muted)" }}>{fmtDate(dueDate)}</div>
                      </div>
                      <div className="badge badge-blue">{dueQuestions.length} question{dueQuestions.length !== 1 ? "s" : ""}</div>
                    </div>
                  );
                })}
              </div>

              {missedQuestions.length > 0 && (
                <button className="btn btn-primary" onClick={retakeMissed} disabled={loading}>
                  {loading ? "Generating..." : "Start Review Session"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Settings Page ──
  if (page === "settings") {
    return (
      <div className="app">
        <style>{CSS}</style>
        <NavBar />
        <div className="container">
          <h1 style={{ fontFamily: "var(--font-display)", marginBottom: 24 }}>Settings</h1>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="section-title">👤 Account</div>
            <div style={{ fontSize: 14, color: "var(--ink-light)", marginBottom: 8 }}>Name: {user?.name}</div>
            <div style={{ fontSize: 14, color: "var(--ink-light)", marginBottom: 16 }}>Email: {user?.email}</div>
            <button className="btn btn-secondary" onClick={logout}>Sign Out</button>
          </div>
          <div className="card">
            <div className="section-title">🗑️ Danger Zone</div>
            <p style={{ fontSize: 14, color: "var(--ink-muted)", marginBottom: 16 }}>Permanently delete all your data including courses, exams, quizzes, and uploaded materials.</p>
            <button className="btn btn-danger" onClick={() => {
              setConfirmAction({
                title: "Delete All Data?",
                message: "This will permanently delete ALL your courses, exams, quizzes, and uploaded materials. This cannot be undone.",
                confirmLabel: "Delete Everything",
                confirmStyle: "danger",
                onConfirm: async () => {
                  setCourses([]);
                  setExams([]);
                  setDocuments([]);
                  setQuizzes([]);
                  setAttempts([]);
                  setSavedQuizProgress({});
                  await DB.del("courses");
                  await DB.del("exams");
                  await DB.del("documents");
                  await DB.del("quizzes");
                  await DB.del("attempts");
                  await DB.del("savedProgress");
                  setConfirmAction(null);
                  navigate("dashboard");
                },
              });
            }}>Delete All Data</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Default fallback ──
  return (
    <div className="app">
      <style>{CSS}</style>
      <NavBar />
      <div className="container">
        <div className="empty-state">
          <h3>Page not found</h3>
          <button className="btn btn-primary" onClick={() => navigate("dashboard")}>Go to Dashboard</button>
        </div>
      </div>
    </div>
  );
}

// ─── SUB-COMPONENTS ───────────────────────────────────────────────────────

function Modal({ title, sub, onClose, children }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {sub && <p className="sub">{sub}</p>}
        {children}
      </div>
    </div>
  );
}

function CourseForm({ onSubmit, initial, submitLabel }) {
  const [name, setName] = useState(initial?.name || "");
  const [term, setTerm] = useState(initial?.term || "");
  return (
    <>
      <div className="form-group">
        <label className="label">Course Name</label>
        <input className="input" placeholder="e.g. Biology 201" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-group">
        <label className="label">Term</label>
        <input className="input" placeholder="e.g. Spring 2026" value={term} onChange={(e) => setTerm(e.target.value)} />
      </div>
      <button className="btn btn-primary btn-lg" style={{ width: "100%" }} disabled={!name} onClick={() => onSubmit(name, term)}>{submitLabel || "Create Course"}</button>
    </>
  );
}

function ExamForm({ onSubmit, initial, submitLabel }) {
  const [name, setName] = useState(initial?.name || "");
  const [date, setDate] = useState(initial?.date || "");
  return (
    <>
      <div className="form-group">
        <label className="label">Exam Name</label>
        <input className="input" placeholder="e.g. Midterm 1" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-group">
        <label className="label">Exam Date (Optional)</label>
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <button className="btn btn-primary btn-lg" style={{ width: "100%" }} disabled={!name} onClick={() => onSubmit(name, date)}>{submitLabel || "Create Exam"}</button>
    </>
  );
}

function UploadZone({ onFiles }) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);
  return (
    <div
      className={`upload-zone ${drag ? "drag" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles(Array.from(e.dataTransfer.files)); }}
      onClick={() => inputRef.current?.click()}
    >
      <div className="icon">📤</div>
      <p><strong>Drop files here</strong> or click to browse</p>
      <div className="formats">Supported: PDF, PPTX, DOCX, TXT</div>
      <input ref={inputRef} type="file" multiple accept=".pdf,.pptx,.docx,.txt" style={{ display: "none" }} onChange={(e) => onFiles(Array.from(e.target.files))} />
    </div>
  );
}
