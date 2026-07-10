// Copy this file to `local-settings.js` and paste a LOCAL/dev OpenAI key.
// `local-settings.js` is for local development only and must never be committed
// or shipped with a real key. In production the key is served by the portal
// (see the extension<->portal wiring), not hard-coded here.
globalThis.KIDDIEGPT_LOCAL_SETTINGS = {
  // Point the extension at a local portal during development. Omit in
  // production and it defaults to https://app.kiddiegpt.com.
  portalBaseUrl: 'http://localhost',
  // Legacy local-key demo mode is no longer used for AI (the portal proxies
  // OpenAI). These are kept only for offline experiments.
  openaiDemoEnabled: false,
  openaiApiKey: '',
  openaiModel: 'gpt-4.1'
};
