// Vercel serverless entry — wraps the existing Express app.
//
// Local Docker keeps running app.js directly (long-lived process, file DB).
//
// The Express app MUST NOT live in a file named server.{js,cjs,mjs,ts,...} at the
// project root: Vercel auto-detects that name as a Node server entrypoint and
// rejects it ("The default export must be a function or server") because the
// module exports an object, not a handler. Hence app.js.
// On Vercel every request invokes this handler: we ensure persistence is loaded
// once (cold start), delegate to the Express app, then flush any pending
// Postgres write before the function suspends.
const { app, initPersistence, flushPending } = require("../app");

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
