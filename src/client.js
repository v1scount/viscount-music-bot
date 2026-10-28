import {
  Client,
  Collection,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { config } from "./config.js";
import { SpotifyClient } from "./services/spotifyClient.js";

export class MusicBot extends Client {
  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel],
    });

    this.commands = new Collection();
    /** @type {Map<string, import("./player/guildPlayer.js").GuildPlayer>} */
    this.players = new Map();
    /** Guild currently holding the single Spotify stream. */
    this.engineOwner = null;
    this.spotify = new SpotifyClient(config.spotify);
  }
}
