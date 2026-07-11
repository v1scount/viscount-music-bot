import {
  Client,
  Collection,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { Poru } from "poru";
import { config } from "./config.js";

export class MusicBot extends Client {
  constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Channel],
    });

    this.commands = new Collection();

    this.poru = new Poru(
      this,
      [
        {
          name: config.lavalink.name,
          host: config.lavalink.host,
          port: config.lavalink.port,
          password: config.lavalink.password,
          secure: config.lavalink.secure,
        },
      ],
      {
        library: "discord.js",
        defaultPlatform: "ytsearch",
        autoResume: false,
      },
    );
  }
}
