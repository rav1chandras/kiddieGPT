function createPersistenceReady(initialize, {
  cooldownMs = 2000, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  let pending;
  let failedAt = -Infinity;
  let lastError;
  return function ready() {
    if (pending) return pending;
    if (now() - failedAt < cooldownMs) return Promise.reject(lastError);
    pending = Promise.resolve().then(async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await initialize(); }
        catch (error) {
          const transient = /timed?\s*out|timeout|ECONNRESET|ECONNREFUSED|connection terminated/i.test(error.message || "");
          if (!transient || attempt >= 2) throw error;
          await sleep(500 * (attempt + 1));
        }
      }
    }).catch((error) => {
      pending = undefined;
      failedAt = now();
      lastError = error;
      throw error;
    });
    return pending;
  };
}

module.exports = { createPersistenceReady };
