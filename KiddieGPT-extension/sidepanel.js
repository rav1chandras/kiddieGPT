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
  admin: "adminPanel"
};

const extensionApi = typeof chrome !== "undefined" ? chrome : null;

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
  return value.replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  }[char]));
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

  extensionApi?.storage?.local?.set?.({ activeView: panelName });
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
  extensionApi?.storage?.local?.set?.({ gradeBand: button.textContent.trim() });
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
  extensionApi?.storage?.local?.set?.({ lastScreenshotAt: Date.now() });
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

  const action = event.target.closest("[data-action]");
  if (action?.dataset.action === "capture-screenshot") captureVisibleTab();
  if (action?.dataset.action === "mock-screenshot") useSampleScreenshot();
});

extensionApi?.storage?.local?.get?.(["activeView", "gradeBand"], data => {
  showPanel(data.activeView || "dashboard");
  if (data.gradeBand) {
    document.querySelectorAll(".grade-tabs button").forEach(button => {
      button.classList.toggle("active", button.textContent.trim() === data.gradeBand);
    });
  }
});
