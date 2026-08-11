const assert = require("node:assert/strict");
const engine = require("../calculator-engine.js");

function close(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} !== ${expected}`);
}

close(engine.evaluate("2+2"), 4, "addition");
close(engine.evaluate("(10+5)*2"), 30, "parentheses");
close(engine.evaluate("25%*200"), 50, "percent");
close(engine.evaluate("sqrt(144)"), 12, "square root");
close(engine.evaluate("2^10"), 1024, "power");
close(engine.evaluate("5!"), 120, "factorial");
close(engine.evaluate("sin(30)", { angleMode: "DEG" }), 0.5, "degree sine");
close(engine.evaluate("sin(pi/2)", { angleMode: "RAD" }), 1, "radian sine");
assert.equal(engine.format(engine.evaluate("0.1+0.2")), "0.3");
assert.throws(() => engine.evaluate("1/0"));
assert.throws(() => engine.evaluate("sqrt(-1)"));
assert.throws(() => engine.evaluate("log(0)"));
console.log("calculator engine tests passed");
