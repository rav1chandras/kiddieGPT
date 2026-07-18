// Vercel serverless entry — wraps the existing Express app.
//
// Local Docker keeps running lib/app.js directly (long-lived process, file DB).
//
// The Express app MUST live OUTSIDE the project root (hence lib/app.js): Vercel
// auto-detects a root-level .js entrypoint and rejects it with "The default
// export must be a function or server", because that module exports an object
// rather than a handler. This file is the only entrypoint Vercel should see.
// On Vercel every request invokes this handler: we ensure persistence is loaded
// once (cold start), delegate to the Express app, then flush any pending
// Postgres write before the function suspends.
const { app, initPersistence, flushPending } = require("../lib/app");

let ready = null;

module.exports = async (req, res) => {
  if (!ready) ready = initPersistence();
  await ready;

  await new Promise((resolve) => {
    res.on("finish", resolve);
    res.on("close", resolve);
    app(req, res);
  });

  // Make sure the DB write reached Postgres before the invocation ends.
  await flushPending();
};
