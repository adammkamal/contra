/** @type {import('next').NextConfig} */
export default {
  // Next gets its own tsconfig so it never rewrites the root one (src, test, bench, scripts).
  // The UI is a client of the HTTP API (npm run api): it only imports types from src/ and server/.
  typescript: { tsconfigPath: "tsconfig.next.json" },
};
