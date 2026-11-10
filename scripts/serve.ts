/** Local JSON API for the demo frontend.  npm run api   (env: CONTRA_PORT, default 4100) */
import { allowedOriginsFromEnv, createApiServer } from "../server/api.ts";
import { settingsFromEnv } from "../src/extract/anthropic.ts";

// POST /api/try reads CONTRA_ANTHROPIC_API_KEY / CONTRA_MODEL / CONTRA_EFFORT from .env.local (never ANTHROPIC_*).
try {
  process.loadEnvFile(".env.local");
} catch {
  /* no .env.local: /api/try answers 503 with what's missing */
}
const port = Number(process.env.CONTRA_PORT ?? 4100);
const allowedOrigins = allowedOriginsFromEnv(process.env); // CONTRA_ALLOWED_ORIGINS, comma-separated
const { server } = createApiServer({ dbPath: "data/demo.db", allowedOrigins, try: { settings: () => settingsFromEnv(process.env) } });
server.listen(port, "127.0.0.1", () => {
  console.log(`Contra API on http://127.0.0.1:${port}  (GET /api/screens, POST /api/action, POST /api/reset, POST /api/try)`);
  console.log(`CORS allowed for: ${allowedOrigins.join(", ")}`);
});
