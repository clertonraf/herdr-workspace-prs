import { runPollOnce } from "./daemon.ts";

try {
  await runPollOnce();
  console.log("Workspace PRs refreshed.");
  process.exit(0);
} catch (e: any) {
  console.error("Refresh failed:", e?.message);
  process.exit(1);
}
