import { REST, Routes } from "discord.js";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function deploy() {
  const commandsDir = path.join(__dirname, "commands");
  const files = (await readdir(commandsDir)).filter((f) => f.endsWith(".js"));
  const body = [];

  for (const file of files) {
    const command = await import(
      pathToFileURL(path.join(commandsDir, file)).href
    );
    if (!command?.data?.toJSON) continue;
    body.push(command.data.toJSON());
  }

  const rest = new REST({ version: "10" }).setToken(config.discord.token);

  if (config.discord.guildId) {
    await rest.put(
      Routes.applicationGuildCommands(
        config.discord.clientId,
        config.discord.guildId,
      ),
      { body },
    );
    console.log(
      `Deployed ${body.length} guild command(s) to ${config.discord.guildId}`,
    );

    // Stale global commands (e.g. without autocomplete) can override/confuse
    // the Discord client. Clear them while developing with a guild deploy.
    await rest.put(Routes.applicationCommands(config.discord.clientId), {
      body: [],
    });
    console.log("Cleared global application commands");
  } else {
    await rest.put(Routes.applicationCommands(config.discord.clientId), {
      body,
    });
    console.log(`Deployed ${body.length} global command(s)`);
  }
}

deploy().catch((error) => {
  console.error("Failed to deploy commands:", error);
  process.exit(1);
});
