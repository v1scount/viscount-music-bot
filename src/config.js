import "dotenv/config";
import path from "node:path";

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
  /** Persisted player sessions (JSON file). Docker sets DATA_PATH=/app/data/sessions.json. */
  dataPath:
    process.env.DATA_PATH || path.join(process.cwd(), "data", "sessions.json"),
  /** Leave voice when alone for this long (default 5 minutes). */
  idleLeaveMs: Number(process.env.IDLE_LEAVE_MS || 300_000),
};
