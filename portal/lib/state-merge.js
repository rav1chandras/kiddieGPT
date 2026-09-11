const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keyed = value => Array.isArray(value) && value.every(item => object(item) && typeof item.id === "string");

// Apply only this writer's changes to the latest locked row. In particular a
// concurrent profile save must not overwrite a refund's billing fields.
function mergeState(before, after, current) {
  if (equal(before, after)) return current;
  if (keyed(before) && keyed(after) && keyed(current)) {
    const old = new Map(before.map(item => [item.id, item]));
    const next = new Map(after.map(item => [item.id, item]));
    const latest = new Map(current.map(item => [item.id, item]));
    const result = after.filter(item => !old.has(item.id) || latest.has(item.id))
      .map(item => mergeState(old.get(item.id), item, latest.get(item.id)));
    for (const item of current) if (!old.has(item.id) && !next.has(item.id)) result.push(item);
    return result;
  }
  if (object(before) && object(after) && object(current)) {
    const result = { ...current };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!Object.hasOwn(after, key)) delete result[key];
      else if (!equal(before[key], after[key])) result[key] = mergeState(before[key], after[key], current[key]);
    }
    return result;
  }
  return after;
}

module.exports = { mergeState };
