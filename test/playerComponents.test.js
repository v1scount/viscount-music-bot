import test from "node:test";
import assert from "node:assert/strict";
import { handleMusicComponent } from "../src/utils/playerComponents.js";
import { getPlayerState } from "../src/utils/playerState.js";

function createTrack(index = 1) {
  return {
    info: {
      title: `Track ${index}`,
      author: "Artist",
      length: 180_000,
      requester: "Tester",
    },
  };
}

function createClient(player) {
  return {
    poru: { players: new Map([[player.guildId, player]]) },
    channels: {
      cache: new Map(),
      async fetch() {
        return null;
      },
    },
  };
}

test("autoplay button toggles the guild setting", async () => {
  const player = {
    guildId: "guild",
    textChannel: "channel",
    queue: [],
    currentTrack: createTrack(),
    volume: 100,
    loop: "NONE",
  };
  const client = createClient(player);
  const interaction = {
    customId: "music:autoplay",
    guildId: "guild",
    deferred: false,
    replied: false,
    isStringSelectMenu: () => false,
    async deferUpdate() {
      this.deferred = true;
    },
  };

  assert.equal(getPlayerState(client, "guild").autoplay, true);
  assert.equal(await handleMusicComponent(interaction, client), true);
  assert.equal(getPlayerState(client, "guild").autoplay, false);
  assert.equal(interaction.deferred, true);
});

test("queue next button updates the requested page", async () => {
  const player = {
    guildId: "guild",
    queue: Array.from({ length: 12 }, (_, index) => createTrack(index + 1)),
    currentTrack: createTrack(),
  };
  const client = createClient(player);
  let payload;
  const interaction = {
    customId: "music_queue:next:0",
    guildId: "guild",
    async update(value) {
      payload = value;
    },
  };

  assert.equal(await handleMusicComponent(interaction, client), true);
  assert.match(payload.embeds[0].toJSON().footer.text, /Page 2\/2/);
});
