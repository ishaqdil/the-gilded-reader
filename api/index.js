// Vercel serverless entrypoint.
// Cold starts run init() once (DB tables, seed chapter, admin bootstrap);
// warm invocations reuse the Express app. The app is stateless: sessions,
// CSRF tokens and rate-limit-safe state live in Postgres (DATABASE_URL).
const { app, init } = require('../server.js');

let ready = null;

module.exports = async (req, res) => {
  try {
    if (!ready) {
      ready = init().catch((e) => { ready = null; throw e; });
    }
    await ready;
  } catch (e) {
    console.error('[init]', e && e.message ? e.message : e);
    res.statusCode = 500;
    res.end('Service temporarily unavailable. Please try again.');
    return;
  }
  return app(req, res);
};
