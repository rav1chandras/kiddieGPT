(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KiddieCalculatorEngine = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function () {
  "use strict";

  const FUNCTIONS = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "log", "ln", "exp", "abs"]);
  const CONSTANTS = new Set(["pi", "e", "ans"]);

  function tokenize(source) {
    const input = String(source || "")
      .replace(/[×·]/g, "*")
      .replace(/[÷]/g, "/")
      .replace(/[−–—]/g, "-")
      .replace(/π/g, "pi");
    const tokens = [];
    let index = 0;
    while (index < input.length) {
      const char = input[index];
      if (/\s/.test(char)) { index += 1; continue; }
      const number = input.slice(index).match(/^(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?/);
      if (number) {
        tokens.push({ type: "number", value: Number(number[0]) });
        index += number[0].length;
        continue;
      }
      const word = input.slice(index).match(/^[A-Za-z]+/);
      if (word) {
        const value = word[0].toLowerCase();
        if (!FUNCTIONS.has(value) && !CONSTANTS.has(value)) throw new Error(`Unknown function or constant: ${word[0]}`);
        tokens.push({ type: "word", value });
        index += word[0].length;
        continue;
      }
      if ("+-*/^%!()".includes(char)) tokens.push({ type: char, value: char });
      else throw new Error(`Unexpected character: ${char}`);
      index += 1;
    }
    tokens.push({ type: "eof", value: "" });
    return tokens;
  }

  function factorial(value) {
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value) || value > 170) throw new Error("Factorial needs a whole number from 0 to 170");
    let result = 1;
    for (let n = 2; n <= value; n += 1) result *= n;
    return result;
  }

  function evaluate(source, options = {}) {
    const angleMode = options.angleMode === "RAD" ? "RAD" : "DEG";
    const ans = Number.isFinite(options.ans) ? options.ans : 0;
    const tokens = tokenize(source);
    let cursor = 0;
    const peek = () => tokens[cursor];
    const take = type => {
      if (type && peek().type !== type) throw new Error(`Expected ${type}`);
      return tokens[cursor++];
    };
    const startsPrimary = token => token.type === "number" || token.type === "word" || token.type === "(";
    const toRadians = value => angleMode === "DEG" ? value * Math.PI / 180 : value;
    const fromRadians = value => angleMode === "DEG" ? value * 180 / Math.PI : value;
    const applyFunction = (name, value) => {
      let result;
      if (["sin", "cos", "tan"].includes(name)) result = Math[name](toRadians(value));
      else if (["asin", "acos", "atan"].includes(name)) result = fromRadians(Math[name](value));
      else if (name === "sqrt") result = Math.sqrt(value);
      else if (name === "log") result = Math.log10(value);
      else if (name === "ln") result = Math.log(value);
      else if (name === "exp") result = Math.exp(value);
      else if (name === "abs") result = Math.abs(value);
      if (!Number.isFinite(result)) throw new Error("That function has no real result");
      return result;
    };

    function parseExpression() { return parseAddSub(); }
    function parseAddSub() {
      let value = parseMulDiv();
      while (peek().type === "+" || peek().type === "-") {
        const operator = take().type;
        const right = parseMulDiv();
        value = operator === "+" ? value + right : value - right;
      }
      return value;
    }
    function parseMulDiv() {
      let value = parsePower();
      while (peek().type === "*" || peek().type === "/" || startsPrimary(peek())) {
        const operator = peek().type === "*" || peek().type === "/" ? take().type : "*";
        const right = parsePower();
        if (operator === "/" && right === 0) throw new Error("Cannot divide by zero");
        value = operator === "*" ? value * right : value / right;
      }
      return value;
    }
    function parsePower() {
      const left = parseUnary();
      if (peek().type !== "^") return left;
      take("^");
      const result = Math.pow(left, parseUnary());
      if (!Number.isFinite(result)) throw new Error("That power is too large");
      return result;
    }
    function parseUnary() {
      if (peek().type === "+") { take("+"); return parseUnary(); }
      if (peek().type === "-") { take("-"); return -parseUnary(); }
      return parsePostfix();
    }
    function parsePostfix() {
      let value = parsePrimary();
      while (peek().type === "!" || peek().type === "%") {
        if (take().type === "!") value = factorial(value);
        else value /= 100;
      }
      return value;
    }
    function parsePrimary() {
      if (peek().type === "number") return take("number").value;
      if (peek().type === "(") {
        take("(");
        const value = parseExpression();
        take(")");
        return value;
      }
      if (peek().type === "word") {
        const name = take("word").value;
        if (CONSTANTS.has(name)) return name === "pi" ? Math.PI : name === "e" ? Math.E : ans;
        take("(");
        const value = parseExpression();
        take(")");
        return applyFunction(name, value);
      }
      throw new Error("Enter a number or expression");
    }

    if (peek().type === "eof") throw new Error("Enter a calculation first");
    const value = parseExpression();
    if (peek().type !== "eof") throw new Error("Check the brackets and operators");
    if (!Number.isFinite(value)) throw new Error("The result is too large");
    return value;
  }

  function format(value) {
    if (!Number.isFinite(value)) return "Error";
    if (Object.is(value, -0)) value = 0;
    const rounded = Number(value.toPrecision(12));
    return String(rounded)
      .replace(/\.0+$/, "")
      .replace(/(\.\d*?)0+(e|$)/i, "$1$2")
      .replace(/e\+?/i, "e");
  }

  return { evaluate, format, tokenize };
});
