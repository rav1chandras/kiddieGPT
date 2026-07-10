// Vercel serverless entry — wraps the existing Express app.
//
// Local Docker keeps running server.js directly (long-lived process, file DB).
// On Vercel every request invokes this handler: we ensure persistence is loaded
// once (cold start), delegate to the Express app, then flush any pending
// Postgres write before the function suspends.
const { app, initPersistence, flushPending } = require("../server");

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
