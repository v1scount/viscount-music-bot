import { REST, Routes } from "discord.js";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../config.js";
import { log, logError } from "../utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Register slash commands with Discord (guild-scoped when DISCORD_GUILD_ID is set).
 */
export async function deployCommands() {
  const commandsDir = path.join(__dirname, "..", "commands");
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
    log(
      "deployCommands",
      `Deployed ${body.length} guild command(s) to ${config.discord.guildId}`,
    );

    // Stale global commands can override/confuse the Discord client.
    await rest.put(Routes.applicationCommands(config.discord.clientId), {
      body: [],
    });
    log("deployCommands", "Cleared global application commands");
  } else {
    await rest.put(Routes.applicationCommands(config.discord.clientId), {
      body,
    });
    log("deployCommands", `Deployed ${body.length} global command(s)`);
  }

  return body.length;
}

/**
 * Deploy commands but never fail bot startup.
 */
export async function deployCommandsSafe() {
  try {
    await deployCommands();
  } catch (error) {
    logError("deployCommands", error);
  }
}
