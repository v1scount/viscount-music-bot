import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { debug, log, logError } from "../utils/logger.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";
import { formatDuration, requireVoiceChannel } from "../utils/voice.js";
import {
  assertCanJoinVoice,
  ensurePlayer,
  waitForVoiceConnection,
} from "../utils/voiceConnection.js";

export const data = new SlashCommandBuilder()
  .setName("play")
  .setDescription("Play a track, album, playlist, or search query")
  .addStringOption((option) =>
    option
      .setName("query")
      .setDescription("Spotify/YouTube URL or search terms")
      .setRequired(true)
      .setAutocomplete(true),
  );

/**
 * @param {import("../client.js").MusicBot} client
 */
function getConnectedNode(client) {
  for (const node of client.poru.nodes.values()) {
    if (node.isConnected) return node;
  }
  return null;
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
 * @param {import("poru").Track} track
 */
function trackChoiceValue(track) {
  const uri = track.info.uri?.trim();
  if (uri && uri.length <= 100) return uri;

  const id = track.info.identifier?.trim();
  if (id) {
    const short = `https://youtu.be/${id}`;
    if (short.length <= 100) return short;
  }

  return null;
}

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

  // Respond immediately with the typed query so Discord always has choices
  // within the 3s window even if Lavalink is slow.
  /** @type {import("discord.js").ApplicationCommandOptionChoiceData[]} */
  const choices = [
    { name: truncate(`Search: ${query}`), value: truncate(query) },
  ];

  if (/^https?:\/\//i.test(query) || /^[a-z0-9]+:/i.test(query)) {
    return interaction.respond([
      { name: truncate(`Use link: ${query}`), value: truncate(query) },
    ]);
  }

  const node = getConnectedNode(client);
  if (!node) {
    log("autocomplete", "No Lavalink node connected — returning typed query only");
    return interaction.respond(choices);
  }

  try {
    const result = await Promise.race([
      client.poru.resolve({
        query,
        source: "ytsearch",
        requester: interaction.user,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("autocomplete search timeout")), 2200),
      ),
    ]);

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

  const node = getConnectedNode(client);
  if (!node) {
    const hosts = [...client.poru.nodes.values()]
      .map(
        (n) =>
          `${n.name} (${n.options?.host ?? n.host}:${n.options?.port ?? n.port}, connected=${n.isConnected})`,
      )
      .join(", ");

    log("play", `No connected Lavalink node. Configured: ${hosts || "none"}`);

    return interaction.reply({
      content:
        "Lavalink is not connected. Start it (e.g. `docker compose up -d lavalink`) and set `LAVALINK_HOST=127.0.0.1` when running the bot on the host/WSL.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply();

  let query = interaction.options.getString("query", true).trim();
  // YouTube Mix/radio links (`list=RD…`) resolve as ~25 related tracks and make
  // /skip look like it is playing “songs by the same artist” instead of the queue.
  if (/^https?:\/\//i.test(query) && /[?&]list=RD/i.test(query)) {
    try {
      const url = new URL(query);
      url.searchParams.delete("list");
      url.searchParams.delete("start_radio");
      url.searchParams.delete("index");
      query = url.toString();
      debug("play", `Stripped YouTube Mix params → ${query}`);
    } catch {
      // keep original query if URL parsing fails
    }
  }
  const isUrl = /^https?:\/\//i.test(query) || query.includes(":");

  debug("play", {
    query,
    isUrl,
    voiceChannelId: voice.voiceChannelId,
    node: `${node.name}@${node.options?.host ?? node.host}:${node.options?.port ?? node.port}`,
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

  const result = await client.poru.resolve({
    query,
    // Let LavaSrc handle Spotify URLs; use YouTube search for plain text.
    ...(isUrl ? {} : { source: "ytsearch" }),
    requester: interaction.user,
  });

  debug(
    "play",
    `resolve loadType=${result.loadType}, tracks=${result.tracks?.length ?? 0}`,
  );

  if (result.loadType === "error") {
    return interaction.editReply("Failed to load that query.");
  }

  if (result.loadType === "empty") {
    return interaction.editReply("No results found.");
  }

  // Only start if the player is fully idle. Checking isPlaying alone races
  // (false during pause / mid-updatePlayer); checking currentTrack alone also
  // races (cleared briefly on TrackEnd). Either signal means "don't replace".
  const shouldStart =
    !player.currentTrack && !player.isPlaying && !player.isPaused;

  debug("play", {
    shouldStart,
    currentTrack: player.currentTrack?.info?.title ?? null,
    isPlaying: player.isPlaying,
    isPaused: player.isPaused,
    queueLength: player.queue.length,
  });

  if (result.loadType === "playlist") {
    // YouTube Mix / radio URLs (list=RD…) resolve as playlists of related
    // tracks — same artist / similar songs. Only keep the seed track so skip
    // advances to what the user actually queued next.
    const playlistName = result.playlistInfo?.name ?? "";
    const isRadioMix =
      /[?&]list=RD/i.test(query) || /^mix\b/i.test(playlistName.trim());

    const tracks = isRadioMix
      ? result.tracks.slice(0, 1)
      : result.tracks;

    for (const track of tracks) {
      track.info.requester = interaction.user;
      player.queue.add(track);
    }

    if (shouldStart) {
      await player.play();
    }

    await updatePlayerPanel(client, player);

    if (isRadioMix) {
      const track = tracks[0];
      return interaction.editReply(
        shouldStart
          ? `Playing **${track.info.title}** by ${track.info.author} (ignored YouTube Mix related tracks).`
          : `Queued **${track.info.title}** by ${track.info.author} (ignored YouTube Mix related tracks).`,
      );
    }

    return interaction.editReply(
      shouldStart
        ? `Playing playlist **${playlistName || "Unknown"}** (${tracks.length} tracks).`
        : `Queued playlist **${playlistName || "Unknown"}** (${tracks.length} tracks).`,
    );
  }

  const track = result.tracks[0];
  track.info.requester = interaction.user;
  player.queue.add(track);

  if (shouldStart) {
    await player.play();
  }

  await updatePlayerPanel(client, player);

  return interaction.editReply(
    shouldStart
      ? `Playing **${track.info.title}** by ${track.info.author}.`
      : `Queued **${track.info.title}** by ${track.info.author}.`,
  );
}
