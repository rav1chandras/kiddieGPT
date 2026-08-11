(function () {
  "use strict";
  const engine = globalThis.KiddieCalculatorEngine;
  const state = { mode: "basic", angleMode: "DEG", expression: "", result: "0", ans: 0, memory: 0, error: false, history: loadHistory() };
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem("kiddiegptCalculatorHistory") || "[]").slice(0, 8); }
    catch { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem("kiddiegptCalculatorHistory", JSON.stringify(state.history.slice(0, 8))); } catch { /* private browsing */ }
  }
  function currentNumericValue() {
    try { return engine.evaluate(state.expression || state.result, { angleMode: state.angleMode, ans: state.ans }); }
    catch { return Number(state.result) || 0; }
  }
  function render() {
    const expression = $("#displayExpression");
    const result = $("#displayResult");
    const angle = $("#angleModeLabel");
    const memory = $("#memoryLabel");
    if (expression) expression.textContent = state.expression || (state.error ? "Check your expression" : "Ready when you are");
    if (result) {
      result.textContent = state.result;
      result.classList.toggle("error-result", state.error);
    }
    if (angle) angle.textContent = state.angleMode;
    if (memory) memory.hidden = state.memory === 0;
    $$("[data-mode]").forEach(button => {
      const active = button.dataset.mode === state.mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    $("#basicKeypad").hidden = state.mode !== "basic";
    $("#functionsKeypad").hidden = state.mode !== "functions";
    renderHistory();
  }
  function renderHistory() {
    const panel = $("#historyPanel");
    const list = $("#historyList");
    if (!panel || !list) return;
    panel.hidden = state.history.length === 0;
    list.innerHTML = state.history.map(item => `<div class="history-item"><span>${escapeHtml(item.expression)}</span><b>${escapeHtml(item.result)}</b></div>`).join("");
  }
  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }
  function clear() { state.expression = ""; state.result = "0"; state.error = false; render(); }
  function append(value) {
    if (state.error) clear();
    if (!state.expression && state.result !== "0") {
      state.expression = /^[0-9.]$/.test(value) ? "" : state.result;
    }
    state.expression += value;
    render();
  }
  function backspace() {
    if (state.error) { clear(); return; }
    state.expression = state.expression.slice(0, -1);
    render();
  }
  function toggleSign() {
    if (state.error) clear();
    const expression = state.expression || state.result;
    state.expression = expression.startsWith("-(") && expression.endsWith(")") ? expression.slice(2, -1) : `-(${expression || "0"})`;
    state.result = "0";
    render();
  }
  function wrapExpression(prefix, suffix = ")") {
    const expression = state.expression || state.result;
    state.expression = `${prefix}(${expression || "0"})${suffix}`;
    state.result = "0";
    render();
  }
  function calculate() {
    if (!state.expression) return;
    try {
      const value = engine.evaluate(state.expression, { angleMode: state.angleMode, ans: state.ans });
      const formatted = engine.format(value);
      state.history.unshift({ expression: state.expression.replace(/\*/g, "×").replace(/\//g, "÷"), result: formatted });
      state.history = state.history.slice(0, 8);
      state.ans = value;
      state.result = formatted;
      state.expression = "";
      state.error = false;
      saveHistory();
    } catch (error) {
      state.result = "Error";
      state.error = true;
    }
    render();
  }
  function memoryAction(action) {
    if (action === "mc") state.memory = 0;
    if (action === "mr") append(engine.format(state.memory));
    if (action === "mplus") state.memory += currentNumericValue();
    if (action === "mminus") state.memory -= currentNumericValue();
    render();
  }
  function handleKey(key) {
    if (/^[0-9.]$/.test(key) || /^[+\-*/^%()]$/.test(key)) append(key);
    else if (key === "=") calculate();
    else if (key === "backspace") backspace();
    else if (key === "ac") clear();
    else if (key === "sign") toggleSign();
    else if (key === "ans") append("ans");
    else if (["mc", "mr", "mplus", "mminus"].includes(key)) memoryAction(key);
    else if (key === "square") wrapExpression("(", ")^2");
    else if (key === "reciprocal") wrapExpression("1/(");
    else if (key === "pi" || key === "e" || key.endsWith("(")) append(key);
    else if (key === "angle") { state.angleMode = state.angleMode === "DEG" ? "RAD" : "DEG"; render(); }
    else append(key);
  }
  $$("[data-mode]").forEach(button => button.addEventListener("click", () => { state.mode = button.dataset.mode; render(); }));
  $$("[data-key]").forEach(button => button.addEventListener("click", () => handleKey(button.dataset.key)));
  $("#angleToggle")?.addEventListener("click", () => handleKey("angle"));
  $("#clearHistory")?.addEventListener("click", () => { state.history = []; saveHistory(); render(); });
  $("#closeCalculator")?.addEventListener("click", () => window.close());
  document.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === "=") { event.preventDefault(); calculate(); return; }
    if (event.key === "Escape") { event.preventDefault(); clear(); return; }
    if (event.key === "Backspace") { event.preventDefault(); backspace(); return; }
    if (/^[0-9.]$/.test(event.key) || /^[+\-*/^%()]$/.test(event.key)) { event.preventDefault(); append(event.key); }
  });
  render();
})();
