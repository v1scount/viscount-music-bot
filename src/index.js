import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MusicBot } from "./client.js";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client = new MusicBot();

async function loadCommands() {
  const commandsDir = path.join(__dirname, "commands");
  const files = (await readdir(commandsDir)).filter((f) => f.endsWith(".js"));

  for (const file of files) {
    const command = await import(
      pathToFileURL(path.join(commandsDir, file)).href
    );
    if (!command?.data?.name || typeof command.execute !== "function") {
      console.warn(`[commands] Skipping invalid command file: ${file}`);
      continue;
    }
    client.commands.set(command.data.name, command);
  }

  console.log(`[commands] Loaded ${client.commands.size} command(s)`);
}

async function loadEvents() {
  const eventsDir = path.join(__dirname, "events");
  const files = (await readdir(eventsDir)).filter((f) => f.endsWith(".js"));

  for (const file of files) {
    const event = await import(pathToFileURL(path.join(eventsDir, file)).href);
    if (!event?.name || typeof event.execute !== "function") {
      console.warn(`[events] Skipping invalid event file: ${file}`);
      continue;
    }

    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args, client));
    } else {
      client.on(event.name, (...args) => event.execute(...args, client));
    }
  }

  console.log(`[events] Loaded ${files.length} Discord event(s)`);
}

async function loadPoruEvents() {
  const poruDir = path.join(__dirname, "events", "poru");
  const files = (await readdir(poruDir)).filter((f) => f.endsWith(".js"));

  for (const file of files) {
    const event = await import(pathToFileURL(path.join(poruDir, file)).href);
    if (!event?.name || typeof event.execute !== "function") {
      console.warn(`[poru] Skipping invalid event file: ${file}`);
      continue;
    }
    client.poru.on(event.name, (...args) => {
      Promise.resolve(event.execute(...args, client)).catch((error) => {
        console.error(`[poru:${event.name}]`, error);
      });
    });
  }

  console.log(`[poru] Loaded ${files.length} Poru event(s)`);
}

async function main() {
  await loadCommands();
  await loadEvents();
  await loadPoruEvents();

  process.on("unhandledRejection", (error) => {
    console.error("[unhandledRejection]", error);
  });

  await client.login(config.discord.token);
}

main().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exit(1);
});
