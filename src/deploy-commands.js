import { deployCommands } from "./services/deployCommands.js";

deployCommands().catch((error) => {
  console.error("Failed to deploy commands:", error);
  process.exit(1);
});
