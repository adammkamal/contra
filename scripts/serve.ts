/** Local JSON API for the demo frontend.  npm run api   (env: CONTRA_PORT, default 4100) */
import { createApiServer } from "../server/api.ts";

const port = Number(process.env.CONTRA_PORT ?? 4100);
const { server } = createApiServer({ dbPath: "data/demo.db" });
server.listen(port, "127.0.0.1", () => {
  console.log(`Contra API on http://127.0.0.1:${port}  (GET /api/screens, POST /api/action, POST /api/reset)`);
});
