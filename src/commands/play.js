import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { debug, log, logError } from "../utils/logger.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";
import { resolveCache } from "../utils/resolveCache.js";
import { classifyQuery } from "../utils/spotifyQuery.js";
import { rankSearchResults } from "../utils/searchRank.js";
import { formatDuration, requireVoiceChannel } from "../utils/voice.js";
import {
  assertCanJoinVoice,
  ensurePlayer,
  streamBusyMessage,
  waitForVoiceConnection,
} from "../utils/voiceConnection.js";
import { refreshIdleTimer } from "../services/idleLeave.js";

const AUTOCOMPLETE_SEARCH_TIMEOUT_MS = 2200;
const PLAY_SEARCH_TIMEOUT_MS = 6000;

const UNSUPPORTED =
  "This bot only plays Spotify. Paste a Spotify track, album, or playlist link, or search by name.";

/**
 * @param {import("../client.js").MusicBot} client
 * @param {string} query
 * @param {unknown} requester
 * @param {number} timeoutMs
 */
async function resolveQuery(client, query, requester, timeoutMs) {
  const classified = classifyQuery(query);
  if (classified.kind === "unsupported") {
    return { loadType: "unsupported", tracks: [] };
  }

  const source = classified.kind === "search" ? "search" : classified.kind;
  const cacheKey = resolveCache.key(source, classified.uri ?? classified.query);
  const cached = resolveCache.get(cacheKey);
  if (cached) {
    debug("resolveCache", `hit ${cacheKey}`);
    return cloneResult(cached, requester);
  }

  const result =
    classified.kind === "search"
      ? await client.spotify.search(classified.query, timeoutMs)
      : await client.spotify.resolve(classified.uri, timeoutMs);

  if (classified.kind === "search" && result.loadType === "search") {
    result.tracks = rankSearchResults(classified.query, result.tracks);
  }

  if (result.loadType !== "error") {
    resolveCache.set(cacheKey, result);
  }
  return cloneResult(result, requester);
}

/**
 * @param {object} result
 * @param {unknown} requester
 */
function cloneResult(result, requester) {
  return {
    ...result,
    tracks: (result.tracks ?? []).map((track) => ({
      info: {
        ...track.info,
        requester: requester ?? track.info?.requester,
      },
    })),
  };
}

/**
 * Discord autocomplete choice name/value must be unique and ≤100 chars.
 * @param {string} text
 * @param {number} max
 */
function truncate(text, max = 100) {
  const cleaned = String(text).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}.`;
}

/**
 * @param {{ info: { uri?: string } }} track
 */
function trackChoiceValue(track) {
  const uri = track.info.uri?.trim();
  if (uri && uri.length <= 100) return uri;
  return null;
}

export const data = new SlashCommandBuilder()
  .setName("play")
  .setDescription("Play a track, album, playlist, or search query")
  .addStringOption((option) =>
    option
      .setName("query")
      .setDescription("Spotify link or search terms")
      .setRequired(true)
      .setAutocomplete(true),
  );

/**
 * @param {import("discord.js").AutocompleteInteraction} interaction
 * @param {import("../client.js").MusicBot} client
 */
export async function autocomplete(interaction, client) {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "query") {
    return interaction.respond([]);
  }

  const query = focused.value.trim();
  log("autocomplete", `focused query="${query}"`);

  if (query.length < 2) {
    return interaction.respond([]);
  }

  /** @type {import("discord.js").ApplicationCommandOptionChoiceData[]} */
  const choices = [
    { name: truncate(`Search: ${query}`), value: truncate(query) },
  ];

  const classified = classifyQuery(query);
  if (classified.kind === "track" || classified.kind === "album" || classified.kind === "playlist") {
    return interaction.respond([
      { name: truncate(`Play ${classified.kind}: ${query}`), value: truncate(query) },
    ]);
  }
  if (classified.kind === "unsupported") {
    return interaction.respond([
      { name: truncate("Spotify links only"), value: truncate(query) },
    ]);
  }

  if (!(await client.spotify.healthy())) {
    log("autocomplete", "Spotify engine is down — returning typed query only");
    return interaction.respond(choices);
  }

  try {
    const result = await resolveQuery(
      client,
      query,
      interaction.user,
      AUTOCOMPLETE_SEARCH_TIMEOUT_MS,
    );

    log(
      "autocomplete",
      `resolve loadType=${result.loadType} tracks=${result.tracks?.length ?? 0}`,
    );

    if (result.loadType !== "error" && result.loadType !== "empty") {
      const usedNames = new Set([choices[0].name]);
      const usedValues = new Set([choices[0].value]);

      for (const track of result.tracks ?? []) {
        if (choices.length >= 25) break;

        const value = trackChoiceValue(track);
        if (!value || usedValues.has(value)) continue;

        const duration = formatDuration(track.info.length);
        let name = truncate(
          `${track.info.title} - ${track.info.author} [${duration}]`,
        );
        if (!name) continue;

        if (usedNames.has(name)) {
          name = truncate(`${name} (${choices.length + 1})`);
        }
        if (usedNames.has(name)) continue;

        usedNames.add(name);
        usedValues.add(value);
        choices.push({ name, value });
      }
    }

    log("autocomplete", `responding with ${choices.length} choice(s)`);
    return interaction.respond(choices);
  } catch (error) {
    logError("autocomplete", error, { query });
    try {
      if (!interaction.responded) {
        await interaction.respond(choices);
      }
    } catch (respondError) {
      logError("autocomplete:respond", respondError, { query });
    }
  }
}

export async function execute(interaction, client) {
  if (!interaction.inGuild()) {
    return interaction.reply({
      content: "This command can only be used in a server.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const guild =
    interaction.guild ?? client.guilds.cache.get(interaction.guildId);
  if (!guild) {
    return interaction.reply({
      content:
        "I'm not a full member of this server (guild not cached). Re-invite me with the **bot** scope and **Connect** + **Speak** permissions — user-install alone is not enough for music.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const voice = requireVoiceChannel(interaction);
  if (!voice) {
    return interaction.reply({
      content: "Join a voice channel first, then run `/play` again.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const permissionError = assertCanJoinVoice(guild, voice.voiceChannelId);
  if (permissionError) {
    return interaction.reply({
      content: permissionError,
      flags: MessageFlags.Ephemeral,
    });
  }

  const botChannelId = guild.members.me?.voice?.channelId;
  if (botChannelId && botChannelId !== voice.voiceChannelId) {
    return interaction.reply({
      content: `I'm already in <#${botChannelId}>.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const busy = streamBusyMessage(client, interaction.guildId);
  if (busy) {
    return interaction.reply({
      content: busy,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!(await client.spotify.healthy())) {
    log("play", "Spotify engine is not healthy");
    return interaction.reply({
      content:
        "Spotify is not connected. Start the engine (`docker compose up -d spotify-engine`) and set `SPOTIFY_USERNAME` / `SPOTIFY_PASSWORD` for a Premium account.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();

  const query = interaction.options.getString("query", true).trim();
  debug("play", {
    query,
    voiceChannelId: voice.voiceChannelId,
  });

  const player = ensurePlayer(client, {
    guildId: interaction.guildId,
    voiceChannelId: voice.voiceChannelId,
    textChannelId: interaction.channelId,
  });

  try {
    await waitForVoiceConnection(player);
  } catch (error) {
    log("play", error instanceof Error ? error.message : String(error));
    return interaction.editReply(
      "Couldn't join your voice channel in time. Make sure I have **Connect** and **Speak**, then try again.",
    );
  }

  let result;
  try {
    result = await resolveQuery(
      client,
      query,
      interaction.user,
      PLAY_SEARCH_TIMEOUT_MS,
    );
  } catch (error) {
    logError("play:resolve", error, { query });
    return interaction.editReply("Failed to load that query.");
  }

  debug(
    "play",
    `resolve loadType=${result.loadType}, tracks=${result.tracks?.length ?? 0}`,
  );

  if (result.loadType === "unsupported") {
    return interaction.editReply(UNSUPPORTED);
  }

  if (result.loadType === "error") {
    return interaction.editReply("Failed to load that query.");
  }

  if (result.loadType === "empty" || result.tracks.length === 0) {
    return interaction.editReply("No results found.");
  }

  const shouldStart =
    !player.currentTrack && !player.isPlaying && !player.isPaused;

  debug("play", {
    shouldStart,
    currentTrack: player.currentTrack?.info?.title ?? null,
    isPlaying: player.isPlaying,
    isPaused: player.isPaused,
    queueLength: player.queue.length,
  });

  const tracks =
    result.loadType === "playlist" ? result.tracks : result.tracks.slice(0, 1);

  for (const track of tracks) {
    track.info.requester = interaction.user;
    player.queue.add(track);
  }

  if (shouldStart) {
    try {
      await player.play();
    } catch (error) {
      logError("play:start", error, { guildId: interaction.guildId });
      return interaction.editReply("Couldn't start playback.");
    }
  }

  if (!shouldStart) {
    await updatePlayerPanel(client, player);
  }
  refreshIdleTimer(client, player);

  if (result.loadType === "playlist") {
    const playlistName = result.playlistInfo?.name || "Unknown";
    return interaction.editReply(
      shouldStart
        ? `Playing playlist **${playlistName}** (${tracks.length} tracks).`
        : `Queued playlist **${playlistName}** (${tracks.length} tracks).`,
    );
  }

  const track = tracks[0];
  return interaction.editReply(
    shouldStart
      ? `Playing **${track.info.title}** by ${track.info.author}.`
      : `Queued **${track.info.title}** by ${track.info.author}.`,
  );
}
