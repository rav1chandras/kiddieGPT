const panels = {
  dashboard: "dashboardPanel",
  tools: "toolsPanel",
  pdf: "pdfPanel",
  quiz: "quizPanel",
  cards: "cardsPanel",
  read: "readPanel",
  math: "mathPanel",
  write: "writePanel",
  screenshot: "screenshotPanel",
  page: "pagePanel",
  ask: "askPanel",
  classroom: "classroomPanel",
  assignments: "assignmentsPanel",
  insights: "insightsPanel",
  safety: "safetyPanel",
  settings: "settingsPanel",
  admin: "adminPanel"
};

const extensionApi = typeof chrome !== "undefined" ? chrome : null;
const storageFallback = "kiddiegptSettings";
let selectedPdfFile = null;
const maxStudyFileBytes = 5 * 1024 * 1024;
const acceptedStudyTypes = ["application/pdf", "text/plain", "image/jpeg", "image/png"];
const sourceState = {
  quiz: "browser",
  cards: "browser"
};

const toolDetails = {
  pdf: {
    title: "PDF Study Helper",
    description: "Upload a homework PDF, worksheet, or notes packet. KiddieGPT extracts the lesson and builds a study sheet, quiz, flashcards, and read-aloud review with parent preview.",
    points: [["▣", "Open It", "Worksheet or chapter"], ["≡", "Find Big Ideas", "Notes kids can read"], ["✓", "Practice", "Quiz and cards"]]
  },
  quiz: {
    title: "Quiz Me",
    description: "Create a short practice quiz from a PDF, web page, notes, or weak spot. Each missed answer gets a simple explanation and becomes review material.",
    points: [["⌕", "Pick a Topic", "Use notes or a weak spot"], ["?", "Try Questions", "5, 10, or test mode"], ["!", "Learn Misses", "Hints before answers"]]
  },
  cards: {
    title: "Flashcards",
    description: "Build flashcards from vocabulary, notes, quiz mistakes, or selected page text. KiddieGPT tracks what is still being learned and resurfaces it later.",
    points: [["Aa", "Grab Words", "Terms from class"], ["↻", "Flip Cards", "Meaning and example"], ["◷", "See Again", "Review at the right time"]]
  },
  read: {
    title: "Read Aloud Coach",
    description: "Turn a study sheet into a short narrated review. Students can pause, repeat, and answer quick recall checks while listening.",
    points: [["▶", "Listen", "Study sheet read aloud"], ["Ⅱ", "Pause", "Stop at tricky parts"], ["◌", "Say It Back", "Quick recall check"]]
  },
  math: {
    title: "Math Step Tutor",
    description: "Capture a math problem from the page, confirm the OCR result, then solve with hint-first step checking. The final answer appears only after student work.",
    points: [["▧", "Catch Problem", "Screenshot or type it"], ["∑", "Try a Step", "One move at a time"], ["✓", "Check Work", "Answer after effort"]]
  },
  write: {
    title: "Writing Coach",
    description: "Paste a paragraph or prompt to get rubric-aware revision coaching. KiddieGPT improves planning, structure, and clarity without ghostwriting the assignment.",
    points: [["✎", "Bring Draft", "Prompt or paragraph"], ["⌕", "Spot Fixes", "Claim, proof, tone"], ["↺", "You Rewrite", "Your words stay yours"]]
  },
  screenshot: {
    title: "Screenshot Explainer",
    description: "Capture the visible tab and turn diagrams, tables, worksheets, or screenshots into grade-safe explanations with parent-visible guardrails.",
    points: [["▧", "Snap It", "Visible tab only"], ["◫", "Notice Parts", "Labels and clues"], ["?", "Ask What", "Explain the confusing bit"]]
  },
  page: {
    title: "Explain Web Page",
    description: "Use the current page or selected text to create a grade-safe explanation. Then turn the same source into a quiz, flashcards, or study notes.",
    points: [["⌕", "Pick Text", "Selection or page"], ["≡", "Make Simple", "Grade-level version"], ["▤", "Turn Into", "Quiz, cards, or notes"]]
  },
  ask: {
    title: "Safe Ask",
    description: "Ask school questions with grade-band responses, blocked topics, and parent-visible safety events. Homework answer requests are redirected into hints.",
    points: [["?", "Ask", "School question"], ["⋯", "Get Hints", "Help, not answer dump"], ["⌂", "Parent Visible", "Safety summary"]]
  }
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
}

function getSettings() {
  return new Promise(resolve => {
    const localDefaults = globalThis.KIDDIEGPT_LOCAL_SETTINGS || {};
    const defaults = { openaiDemoEnabled: false, openaiApiKey: "", openaiModel: "gpt-4.1", activeView: "dashboard", gradeBand: "6-8", ...localDefaults };
    if (extensionApi?.storage?.local) {
      extensionApi.storage.local.get(defaults, data => {
        resolve({
          ...data,
          openaiApiKey: data.openaiApiKey || localDefaults.openaiApiKey || "",
          openaiDemoEnabled: Boolean(data.openaiApiKey || localDefaults.openaiApiKey) ? true : Boolean(data.openaiDemoEnabled),
          openaiModel: data.openaiModel || localDefaults.openaiModel || "gpt-4.1"
        });
      });
      return;
    }
    try {
      const data = { ...defaults, ...JSON.parse(localStorage.getItem(storageFallback) || "{}") };
      resolve({
        ...data,
        openaiApiKey: data.openaiApiKey || localDefaults.openaiApiKey || "",
        openaiDemoEnabled: Boolean(data.openaiApiKey || localDefaults.openaiApiKey) ? true : Boolean(data.openaiDemoEnabled),
        openaiModel: data.openaiModel || localDefaults.openaiModel || "gpt-4.1"
      });
    } catch {
      resolve(defaults);
    }
  });
}

function saveSettings(values) {
  return new Promise(resolve => {
    if (extensionApi?.storage?.local) {
      extensionApi.storage.local.set(values, resolve);
      return;
    }
    getSettings().then(current => {
      localStorage.setItem(storageFallback, JSON.stringify({ ...current, ...values }));
      resolve();
    });
  });
}

function showPanel(name) {
  const panelName = panels[name] ? name : "dashboard";
  const panelId = panels[panelName];

  document.querySelectorAll(".view-panel").forEach(panel => {
    panel.classList.toggle("active", panel.id === panelId);
  });
  document.querySelectorAll(".side-link[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === panelName);
  });

  if (toolDetails[panelName]) {
    selectTool(panelName);
  }

  saveSettings({ activeView: panelName });
  document.querySelector(".workspace-main")?.scrollTo({ top: 0, behavior: "smooth" });
}

function selectTool(name) {
  const detail = toolDetails[name] || toolDetails.pdf;
  const launchButton = document.querySelector("[data-launch]");
  const points = document.getElementById("toolDetailPoints");

  document.querySelectorAll("[data-tool]").forEach(tile => {
    tile.classList.toggle("active", tile.dataset.tool === name);
  });

  document.getElementById("toolDetailTitle").textContent = detail.title;
  document.getElementById("toolDetailDescription").textContent = detail.description;
  launchButton.dataset.launch = name;
  launchButton.textContent = `Launch ${detail.title}`;
  points.innerHTML = detail.points.map(([icon, label, value]) => (
    `<div class="tool-flow-step"><i class="tool-flow-dot" data-icon="${escapeHtml(icon)}"></i><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`
  )).join("");
}

function setGrade(button) {
  button.parentElement.querySelectorAll("button").forEach(tab => tab.classList.toggle("active", tab === button));
  saveSettings({ gradeBand: button.textContent.trim() });
}

function setToolSource(tool, source) {
  if (!sourceState[tool]) return;
  sourceState[tool] = source;
  document.querySelectorAll(`[data-source-group="${tool}"] [data-source-option]`).forEach(button => {
    button.classList.toggle("active", button.dataset.sourceOption === source);
  });
  document.querySelectorAll(`[data-source-card^="${tool}-"]`).forEach(card => {
    card.classList.toggle("active", card.dataset.sourceCard === `${tool}-${source}`);
  });
  const label = source === "pdf" ? "Uploaded PDF" : "Active tab";
  const status = document.querySelector(`[data-source-status="${tool}"]`);
  if (status) status.textContent = label;
  saveSettings({ [`${tool}Source`]: source });
}

function setScreenshotStatus(text, tone = "") {
  const status = document.getElementById("screenshotStatus");
  if (!status) return;
  status.textContent = text;
  status.className = `status ${tone}`.trim();
}

function renderScreenshot(src) {
  const preview = document.getElementById("screenshotPreview");
  const observation = document.getElementById("screenshotObservation");
  if (!preview || !observation) return;

  preview.innerHTML = `<img src="${src}" alt="Captured visible tab screenshot">`;
  observation.textContent = "Screenshot captured. KiddieGPT would identify the visible question, diagram labels, and confusing parts before offering a grade-safe explanation.";
  setScreenshotStatus("Captured");
  saveSettings({ lastScreenshotAt: Date.now() });
}

function updateSettingsStatus(message, tone = "") {
  const status = document.getElementById("settingsStatus");
  if (!status) return;
  status.textContent = message;
  status.className = `settings-note ${tone}`.trim();
}

async function loadSettingsForm() {
  const settings = await getSettings();
  const toggle = document.getElementById("openaiDemoToggle");
  const keyInput = document.getElementById("openaiApiKeyInput");
  const modelInput = document.getElementById("openaiModelInput");
  if (toggle) toggle.checked = Boolean(settings.openaiDemoEnabled);
  if (keyInput) keyInput.value = settings.openaiApiKey || "";
  if (modelInput) modelInput.value = settings.openaiModel || "gpt-4.1";
}

async function saveSettingsForm() {
  const key = document.getElementById("openaiApiKeyInput")?.value.trim() || "";
  const model = document.getElementById("openaiModelInput")?.value.trim() || "gpt-4.1";
  const enabled = Boolean(document.getElementById("openaiDemoToggle")?.checked);
  await saveSettings({ openaiDemoEnabled: enabled, openaiApiKey: key, openaiModel: model });
  updateSettingsStatus(key ? "Demo OpenAI settings saved." : "Saved. Add a key before using OpenAI demo mode.", key ? "" : "warn");
  return { openaiDemoEnabled: enabled, openaiApiKey: key, openaiModel: model };
}

async function clearOpenAISettings() {
  document.getElementById("openaiApiKeyInput").value = "";
  document.getElementById("openaiDemoToggle").checked = false;
  await saveSettings({ openaiDemoEnabled: false, openaiApiKey: "" });
  updateSettingsStatus("OpenAI demo key cleared.");
}

async function testOpenAIKey() {
  const settings = await saveSettingsForm();
  if (!settings.openaiApiKey) {
    updateSettingsStatus("Add an OpenAI API key first.", "warn");
    return;
  }
  updateSettingsStatus("Testing OpenAI key...", "blue");
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${settings.openaiApiKey}`
      },
      body: JSON.stringify({
        model: settings.openaiModel || "gpt-4.1",
        input: "Reply with exactly: KiddieGPT demo ready"
      })
    });
    if (!response.ok) throw new Error(await response.text());
    updateSettingsStatus("OpenAI key works for demo mode.");
  } catch (error) {
    updateSettingsStatus(`OpenAI test failed: ${friendlyError(error)}`, "warn");
  }
}

function friendlyError(error) {
  if (error.name === "AbortError") {
    return "OpenAI request timed out. Try a smaller PDF or check the API key/network.";
  }
  try {
    const parsed = JSON.parse(error.message);
    return parsed.error?.message || error.message;
  } catch {
    return error.message || "Something went wrong.";
  }
}

function setPdfStatus(message, tone = "") {
  const status = document.getElementById("pdfBuildStatus");
  if (!status) return;
  status.textContent = message;
  status.className = `pdf-status ${tone}`.trim();
}

function setPdfBusy(isBusy) {
  const button = document.getElementById("pdfBuildButton");
  const progress = document.getElementById("pdfProgress");
  if (button) {
    button.disabled = isBusy;
    button.textContent = isBusy ? "Building..." : "Build Study Pack";
  }
  if (progress) {
    progress.hidden = !isBusy;
  }
}

function setUploadCollapsed(collapsed) {
  const panel = document.getElementById("pdfUploadPanel");
  const summary = document.getElementById("uploadSummary");
  const button = document.getElementById("toggleUploadButton");
  if (!panel || !summary || !button) return;
  panel.classList.toggle("collapsed", collapsed);
  summary.hidden = !collapsed;
  button.textContent = collapsed ? "Change Source" : "Collapse";
}

function choosePdfFile() {
  setUploadCollapsed(false);
  document.getElementById("pdfFileInput")?.click();
}

function handlePdfFileChange(event) {
  const file = event.target.files?.[0];
  handleStudyFile(file);
}

function handleStudyFile(file) {
  if (!file) return;
  const isAcceptedType = acceptedStudyTypes.includes(file.type) || /\.(pdf|txt|jpe?g|png)$/i.test(file.name);
  if (!isAcceptedType) {
    setPdfStatus("Use a PDF, TXT, JPG, or PNG file.", "warn");
    return;
  }
  if (file.size > maxStudyFileBytes) {
    setPdfStatus("File is too large. Please use a file under 5 MB.", "warn");
    return;
  }
  selectedPdfFile = file;
  document.getElementById("pdfUploadZone")?.classList.remove("dragging");
  document.getElementById("pdfFileName").textContent = file.name;
  document.getElementById("pdfFileMeta").textContent = `${formatBytes(file.size)} selected · ${fileKindLabel(file)} · ready to build`;
  document.getElementById("uploadSummaryTitle").textContent = file.name;
  document.getElementById("uploadSummaryMeta").textContent = `${fileKindLabel(file)} · ${formatBytes(file.size)}`;
  setPdfStatus(`${fileKindLabel(file)} selected. Press Build Study Pack when ready.`, "blue");
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function fileKindLabel(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "PDF under 50 pages";
  if (file.type === "text/plain" || /\.txt$/i.test(file.name)) return "Text file";
  return "Image file";
}

function isImageFile(file) {
  return file.type.startsWith("image/") || /\.(jpe?g|png)$/i.test(file.name);
}

function getOpenAIStudySourcePart(file, fileData) {
  if (isImageFile(file)) {
    return {
      type: "input_image",
      image_url: fileData
    };
  }
  return {
    type: "input_file",
    filename: file.name,
    file_data: fileData
  };
}

function initUploadDropZone() {
  const zone = document.getElementById("pdfUploadZone");
  if (!zone) return;
  ["dragenter", "dragover"].forEach(type => {
    zone.addEventListener(type, event => {
      event.preventDefault();
      zone.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach(type => {
    zone.addEventListener(type, event => {
      event.preventDefault();
      zone.classList.remove("dragging");
    });
  });
  zone.addEventListener("drop", event => {
    handleStudyFile(event.dataTransfer?.files?.[0]);
  });
}

function handleSourceUrl() {
  const input = document.getElementById("sourceUrlInput");
  const url = input?.value.trim();
  if (!url) {
    return;
  }
  try {
    const parsed = new URL(url);
    document.getElementById("pdfFileName").textContent = parsed.pathname.split("/").pop() || "Study source URL";
    document.getElementById("pdfFileMeta").textContent = "URL source selected · direct import coming next";
    document.getElementById("uploadSummaryTitle").textContent = parsed.hostname;
    document.getElementById("uploadSummaryMeta").textContent = "URL source selected";
    setPdfStatus("URL saved for this study pack. Direct URL fetching will use the same OpenAI flow next.", "blue");
  } catch {
    setPdfStatus("Use a full URL that starts with https://", "warn");
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Could not read PDF."));
    reader.readAsDataURL(file);
  });
}

async function buildPdfStudyPack() {
  setPdfStatus("Starting PDF study pack...", "blue");
  setPdfBusy(true);
  try {
    const settings = await getSettings();
    const useOpenAI = settings.openaiDemoEnabled && settings.openaiApiKey && selectedPdfFile;
    const filePreviewMode = location.protocol === "file:" && useOpenAI;
    setPdfStatus(
      useOpenAI
        ? (filePreviewMode ? "Reading study file. If this file preview blocks network calls, load the Chrome extension package and try again." : "Reading study file and asking OpenAI...")
        : "Using sample study pack. Add a Settings key and choose a study file for OpenAI mode.",
      useOpenAI ? "blue" : ""
    );
    const pack = useOpenAI ? await buildPdfWithOpenAI(selectedPdfFile, settings) : sampleStudyPack(selectedPdfFile?.name);
    renderPdfStudyPack(pack, useOpenAI ? "OpenAI" : "Sample");
    setUploadCollapsed(true);
    setPdfStatus(useOpenAI ? "Study pack built with OpenAI." : "Sample study pack loaded.", "");
  } catch (error) {
    setPdfStatus(`Could not build study pack: ${friendlyError(error)}`, "warn");
  } finally {
    setPdfBusy(false);
  }
}

function initPdfTool() {
  document.getElementById("pdfChooseButton")?.addEventListener("click", choosePdfFile);
  document.getElementById("pdfBuildButton")?.addEventListener("click", buildPdfStudyPack);
  document.getElementById("sourceUrlButton")?.addEventListener("click", handleSourceUrl);
  document.getElementById("toggleUploadButton")?.addEventListener("click", () => {
    const panel = document.getElementById("pdfUploadPanel");
    setUploadCollapsed(!panel?.classList.contains("collapsed"));
  });
  document.getElementById("pdfFileInput")?.addEventListener("change", handlePdfFileChange);
  initUploadDropZone();
}

function initSettingsTool() {
  document.getElementById("saveSettingsButton")?.addEventListener("click", saveSettingsForm);
  document.getElementById("clearOpenAIButton")?.addEventListener("click", clearOpenAISettings);
  document.getElementById("testOpenAIButton")?.addEventListener("click", testOpenAIKey);
}

async function buildPdfWithOpenAI(file, settings) {
  if (file.size > maxStudyFileBytes) throw new Error("Study file must be under 5 MB.");
  setPdfStatus("Reading study file...", "blue");
  const fileData = await readFileAsDataUrl(file);
  const studySourcePart = getOpenAIStudySourcePart(file, fileData);
  setPdfStatus("Sending study source to OpenAI...", "blue");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 90000);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    signal: controller.signal,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.openaiApiKey}`
    },
    body: JSON.stringify({
      model: settings.openaiModel || "gpt-4.1",
      instructions: "You are KiddieGPT, a parent-safe study helper for grades K-8. Help the student learn from the uploaded study source. Do not provide answer dumps. Return only valid JSON.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Create a grade-aware study pack from this uploaded study source. It may be a PDF, text file, or image. If it is an image, read the visible text, diagrams, tables, and labels. If it is a PDF, assume the app asks students to keep uploads under 50 pages. Return JSON with keys: mainIdea string, keyTerms array of 5 short strings, rememberThis string, quiz array of 5 objects with question, choices array of 4 strings, answer string, flashcards array of 6 objects with term and meaning, readAloud string, parentNote string. Filename: ${file.name}`
            },
            studySourcePart
          ]
        }
      ]
    })
  }).finally(() => clearTimeout(timeoutId));
  setPdfStatus("Turning OpenAI response into a study pack...", "blue");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(JSON.stringify(data));
  return normalizeStudyPack(parseOpenAIJson(extractOutputText(data)));
}

function extractOutputText(data) {
  if (data.output_text) return data.output_text;
  return (data.output || [])
    .flatMap(item => item.content || [])
    .map(content => content.text || "")
    .join("\n")
    .trim();
}

function parseOpenAIJson(text) {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("OpenAI returned text, but not a study-pack JSON object.");
  }
}

function normalizeStudyPack(pack) {
  return {
    mainIdea: pack.mainIdea || "This PDF explains the main lesson and key vocabulary.",
    keyTerms: Array.isArray(pack.keyTerms) ? pack.keyTerms.slice(0, 6) : [],
    rememberThis: pack.rememberThis || "Review the big idea, then practice with a few questions.",
    quiz: Array.isArray(pack.quiz) ? pack.quiz.slice(0, 10) : [],
    flashcards: Array.isArray(pack.flashcards) ? pack.flashcards.slice(0, 12) : [],
    readAloud: pack.readAloud || "Read the study sheet slowly, then pause and say the main idea back.",
    parentNote: pack.parentNote || "Parent can preview the study pack before practice."
  };
}

function sampleStudyPack(filename = "Photosynthesis_Chapter_4.pdf") {
  return normalizeStudyPack({
    mainIdea: `${filename} is ready for a study pack. In sample mode, plants use sunlight, water, and carbon dioxide to make glucose and oxygen.`,
    keyTerms: ["chlorophyll", "chloroplast", "glucose", "stomata", "carbon dioxide"],
    rememberThis: "Inputs go in, outputs come out. The chloroplast is where photosynthesis happens.",
    quiz: [
      { question: "Which gas do plants take in?", choices: ["Oxygen", "Carbon dioxide", "Nitrogen", "Hydrogen"], answer: "Carbon dioxide" },
      { question: "Where does photosynthesis happen?", choices: ["Nucleus", "Chloroplast", "Root", "Stem"], answer: "Chloroplast" }
    ],
    flashcards: [
      { term: "Chlorophyll", meaning: "Green pigment that captures sunlight." },
      { term: "Glucose", meaning: "Sugar plants make for energy." },
      { term: "Stomata", meaning: "Tiny openings that let gases move in and out." }
    ],
    readAloud: "Plants use sunlight to make food. They take in carbon dioxide and water, then release oxygen.",
    parentNote: "Sample mode shown. Enable OpenAI in Settings to analyze the uploaded PDF."
  });
}

function renderPdfStudyPack(pack, sourceLabel) {
  document.getElementById("pdfReadyStatus").textContent = sourceLabel;
  const termChips = pack.keyTerms.map(term => `<span>${escapeHtml(term)}</span>`).join("");
  document.getElementById("pdfStudySheet").innerHTML = `
    <div class="study-celebration">
      <div><span>Study sheet ready</span><h3>${escapeHtml(pack.mainIdea)}</h3></div>
      <button class="studied-button" type="button" data-action="studied-sheet"><span>✓</span> Studied this <b>→</b></button>
    </div>
    <div class="study-card-grid">
      <div class="study-card big"><span>Big idea</span><p>${escapeHtml(pack.mainIdea)}</p></div>
      <div class="study-card"><span>Remember</span><p>${escapeHtml(pack.rememberThis)}</p></div>
      <div class="study-card"><span>Read aloud</span><p>${escapeHtml(pack.readAloud)}</p></div>
    </div>
    <div class="term-cloud">${termChips || "<span>No key terms yet</span>"}</div>
  `;
  document.getElementById("pdfPackActions").innerHTML = `
    <div class="builder-step"><span>Make Quiz</span><b>${pack.quiz.length || 0} Qs</b></div>
    <div class="builder-step"><span>Make Cards</span><b>${pack.flashcards.length || 0} cards</b></div>
    <div class="builder-step"><span>Parent Note</span><b>${escapeHtml(pack.parentNote.slice(0, 24))}${pack.parentNote.length > 24 ? "..." : ""}</b></div>
  `;
}

function useSampleScreenshot() {
  const sampleSvg = encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420">
      <rect width="720" height="420" fill="#fbfdf8"/>
      <rect x="42" y="42" width="636" height="336" rx="24" fill="#ffffff" stroke="#dbe7df" stroke-width="4"/>
      <text x="72" y="92" fill="#0b2d43" font-family="Arial" font-size="28" font-weight="700">Water Cycle Diagram</text>
      <circle cx="170" cy="175" r="54" fill="#dce96a"/>
      <path d="M310 244c44-66 116-66 160 0" fill="none" stroke="#0f8bf2" stroke-width="16" stroke-linecap="round"/>
      <path d="M484 150h84l-28-28" fill="none" stroke="#004f48" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M484 150h84l-28 28" fill="none" stroke="#004f48" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="96" y="272" fill="#29495b" font-family="Arial" font-size="22" font-weight="700">evaporation</text>
      <text x="304" y="288" fill="#29495b" font-family="Arial" font-size="22" font-weight="700">condensation</text>
      <text x="500" y="220" fill="#29495b" font-family="Arial" font-size="22" font-weight="700">precipitation</text>
    </svg>
  `);
  renderScreenshot(`data:image/svg+xml;charset=utf-8,${sampleSvg}`);
}

function captureVisibleTab() {
  showPanel("screenshot");
  setScreenshotStatus("Capturing", "blue");

  if (!extensionApi?.tabs?.captureVisibleTab) {
    setScreenshotStatus("Unavailable", "warn");
    useSampleScreenshot();
    return;
  }

  extensionApi.tabs.captureVisibleTab({ format: "png" }, dataUrl => {
    if (extensionApi.runtime.lastError || !dataUrl) {
      setScreenshotStatus("Use sample", "warn");
      useSampleScreenshot();
      return;
    }
    renderScreenshot(dataUrl);
  });
}

document.addEventListener("click", event => {
  const target = event.target.closest("[data-view]");
  if (target) showPanel(target.dataset.view);

  const tool = event.target.closest("[data-tool]");
  if (tool) selectTool(tool.dataset.tool);

  const launch = event.target.closest("[data-launch]");
  if (launch) showPanel(launch.dataset.launch);

  const gradeTab = event.target.closest(".grade-tabs button");
  if (gradeTab) setGrade(gradeTab);

  const sourceButton = event.target.closest("[data-source-group] [data-source-option]");
  if (sourceButton) {
    const group = sourceButton.closest("[data-source-group]");
    setToolSource(group.dataset.sourceGroup, sourceButton.dataset.sourceOption);
  }

  const action = event.target.closest("[data-action]");
  if (action?.dataset.action === "capture-screenshot") captureVisibleTab();
  if (action?.dataset.action === "mock-screenshot") useSampleScreenshot();
  if (action?.dataset.action === "studied-sheet") {
    action.classList.add("done");
    action.innerHTML = "<span>✓</span> Studied <b>→</b>";
    setPdfStatus("Nice work. This study sheet is marked as studied.", "blue");
  }

  if (event.target.closest("#pdfChooseButton")) event.preventDefault();
  if (event.target.closest("#pdfBuildButton")) event.preventDefault();
  if (event.target.closest("#saveSettingsButton")) event.preventDefault();
  if (event.target.closest("#clearOpenAIButton")) event.preventDefault();
  if (event.target.closest("#testOpenAIButton")) event.preventDefault();
});

initPdfTool();
initSettingsTool();

globalThis.kiddieGPTDemo = {
  buildPdfStudyPack,
  choosePdfFile,
  renderPdfStudyPack,
  sampleStudyPack
};

getSettings().then(data => {
  showPanel(data.activeView || "dashboard");
  if (data.gradeBand) {
    document.querySelectorAll(".grade-tabs button").forEach(button => {
      button.classList.toggle("active", button.textContent.trim() === data.gradeBand);
    });
  }
  setToolSource("quiz", data.quizSource || "browser");
  setToolSource("cards", data.cardsSource || "browser");
  loadSettingsForm();
});
