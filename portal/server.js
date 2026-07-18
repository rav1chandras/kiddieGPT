// Single entrypoint for both local Docker and Vercel.
//
// Vercel's Node runtime looks for a root-level entrypoint (app|index|server).*
// that imports express, and captures the HTTP server it starts — listen() must
// run during module startup, so it is called synchronously below rather than
// after any await. Local Docker runs this same file via `npm start`.
//
// The Express app itself lives in lib/app.js, deliberately OUTSIDE the project
// root: that module exports an object, and Vercel would reject it as an
// entrypoint ("The default export must be a function or server").
const express = require("express");
const { app, initPersistence, flushPending, runLifecycleSweep } = require("./lib/app");

const port = Number(process.env.PORT || 3000);
const onVercel = Boolean(process.env.VERCEL);
const AUTOPILOT_ENABLED = process.env.AUTOPILOT_ENABLED !== "false";
const SWEEP_INTERVAL_MINUTES = Number(process.env.SWEEP_INTERVAL_MINUTES || 360);

// Start persistence once. Requests await this rather than racing it, so a cold
// start can never serve from an uninitialised cache.
const ready = initPersistence();
ready.catch((error) => console.error("Persistence init failed:", error.message));

const server = express();

// Registered before the app is mounted, so every request waits for persistence.
server.use((req, res, next) => {
  ready.then(
    () => {
      // Vercel may suspend the instance once a response finishes, so make sure
      // any queued Postgres write has landed first. No-op for the file driver.
      res.on("finish", () => { flushPending().catch(() => {}); });
      next();
    },
    (error) => {
      res.status(500).json({ error: `Server not ready: ${error.message}` });
    }
  );
});

server.use(app);

server.listen(port, () => {
  console.log(`KiddieGPT portal listening on ${port}`);
  // Locally the sweep runs on an interval. On Vercel the instance is not
  // long-lived, so Vercel Cron drives /api/cron/sweep instead (see vercel.json).
  if (AUTOPILOT_ENABLED && !onVercel) {
    ready
      .then(() => {
        runLifecycleSweep("startup").catch((error) => console.error("Sweep failed:", error.message));
        setInterval(() => {
          runLifecycleSweep("cron").catch((error) => console.error("Sweep failed:", error.message));
        }, Math.max(5, SWEEP_INTERVAL_MINUTES) * 60000);
        console.log(`Autopilot on — lifecycle sweep every ${SWEEP_INTERVAL_MINUTES} min`);
      })
      .catch(() => {});
  }
});
