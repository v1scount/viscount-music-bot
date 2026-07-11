import "dotenv/config";

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  discord: {
    token: required("DISCORD_TOKEN"),
    clientId: required("DISCORD_CLIENT_ID"),
    guildId: process.env.DISCORD_GUILD_ID || null,
  },
  lavalink: {
    name: "main",
    host: process.env.LAVALINK_HOST || "lavalink",
    port: Number(process.env.LAVALINK_PORT || 2333),
    password: required("LAVALINK_PASSWORD"),
    secure: false,
  },
  lastfm: {
    apiKey: process.env.LASTFM_API_KEY || null,
  },
};
