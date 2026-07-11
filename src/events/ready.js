import { Events } from "discord.js";
import { config } from "../config.js";
import { debug, log } from "../utils/logger.js";

export const name = Events.ClientReady;
export const once = true;

export async function execute(readyClient, client) {
  await client.poru.init(client);

  // Wrap Poru's Discord voice send so we can see if OP4 is actually emitted.
  const originalSend = client.poru.send?.bind(client.poru);
  client.poru.send = (packet) => {
    const guild = client.guilds.cache.get(packet?.d?.guild_id);
    debug("voiceSend", {
      op: packet?.op,
      guildId: packet?.d?.guild_id,
      channelId: packet?.d?.channel_id,
      guildCached: Boolean(guild),
      shardId: guild?.shardId,
      hasShard: Boolean(guild?.shard),
    });

    if (!guild) {
      log("voiceSend", `No guild in cache for ${packet?.d?.guild_id}`);
      return;
    }
    if (!guild.shard) {
      log("voiceSend", `No shard available for guild ${guild.id}`);
      return;
    }

    if (originalSend) {
      originalSend(packet);
    } else {
      guild.shard.send(packet);
    }
  };

  client.on(Events.Raw, (packet) => {
    if (
      packet.t === "VOICE_STATE_UPDATE" &&
      packet.d?.user_id === client.user.id
    ) {
      debug("rawVoiceState", {
        guildId: packet.d.guild_id,
        channelId: packet.d.channel_id,
        sessionId: packet.d.session_id,
      });
    }
    if (packet.t === "VOICE_SERVER_UPDATE") {
      debug("rawVoiceServer", {
        guildId: packet.d.guild_id,
        endpoint: packet.d.endpoint,
      });
    }
  });

  log(
    "ready",
    `Logged in as ${readyClient.user.tag} | Lavalink ${config.lavalink.host}:${config.lavalink.port} | guilds=${client.guilds.cache.size}`,
  );

  if (!config.lastfm.apiKey) {
    log(
      "ready",
      "LASTFM_API_KEY is missing; autoplay will use the YouTube Music fallback.",
    );
  }

  if (client.guilds.cache.size === 0) {
    const invite = `https://discord.com/oauth2/authorize?client_id=${config.discord.clientId}&permissions=3145728&integration_type=0&scope=bot%20applications.commands`;
    log("ready", `No guilds in cache. Invite with bot scope: ${invite}`);
  }
}
