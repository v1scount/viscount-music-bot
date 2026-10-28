import { Events } from "discord.js";
import { config } from "../config.js";
import { deployCommandsSafe } from "../services/deployCommands.js";
import { restoreSessions } from "../services/sessionStore.js";
import { log, logError } from "../utils/logger.js";

export const name = Events.ClientReady;
export const once = true;

export async function execute(readyClient, client) {
  await deployCommandsSafe();

  client.spotify.start({
    onEvent: (event) => {
      const owner = client.engineOwner;
      const player = owner ? client.players.get(owner) : null;
      if (!player) return;
      Promise.resolve(player.handleEngineEvent(event)).catch((error) => {
        logError("spotify:event", error, { type: event?.type });
      });
    },
    onPcm: (chunk) => {
      const owner = client.engineOwner;
      client.players.get(owner)?.writePcm(chunk);
    },
    onDiscontinuity: () => {
      const owner = client.engineOwner;
      client.players.get(owner)?.onDiscontinuity();
    },
  });

  try {
    await restoreSessions(client);
  } catch (error) {
    logError("ready:restoreSessions", error);
  }

  log(
    "ready",
    `Logged in as ${readyClient.user.tag} | Spotify ${config.spotify.engineUrl} | guilds=${client.guilds.cache.size}`,
  );

  if (client.guilds.cache.size === 0) {
    const invite = `https://discord.com/oauth2/authorize?client_id=${config.discord.clientId}&permissions=3145728&integration_type=0&scope=bot%20applications.commands`;
    log("ready", `No guilds in cache. Invite with bot scope: ${invite}`);
  }
}
