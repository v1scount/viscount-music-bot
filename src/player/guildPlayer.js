import { PassThrough } from "node:stream";
import {
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import { startAutoplay } from "../services/autoplay.js";
import { refreshIdleTimer } from "../services/idleLeave.js";
import { logError } from "../utils/logger.js";
import { sendPlayerMessage } from "../utils/playerMessage.js";
import { updatePlayerPanel } from "../utils/playerPanel.js";
import { getPlayerState, rememberTrack } from "../utils/playerState.js";
import { shouldRefreshPanel } from "../utils/playerUpdate.js";
import { PcmFeed } from "./pcmFeed.js";

/**
 * @param {Array<unknown>} [tracks]
 */
export function createQueue(tracks = []) {
  const queue = [...tracks];
  queue.add = (track) => {
    queue.push(track);
    return queue;
  };
  queue.remove = (index) => queue.splice(index, 1)[0];
  queue.clear = () => queue.splice(0, queue.length);
  return queue;
}

export class GuildPlayer {
  /**
   * @param {import("../client.js").MusicBot} client
   * @param {string} guildId
   */
  constructor(client, guildId) {
    this.client = client;
    this.guildId = guildId;
    this.voiceChannel = null;
    this.textChannel = null;
    this.queue = createQueue();
    this.currentTrack = null;
    this.previousTrack = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.isAutoPlay = false;
    this.position = 0;
    this.playToken = 0;
    this.ignoreEnd = false;
    this.unavailableRetries = 0;
    this.destroyed = false;
    /** @type {import("@discordjs/voice").VoiceConnection | null} */
    this.connection = null;
    /** @type {import("@discordjs/voice").AudioPlayer | null} */
    this.audioPlayer = null;
    /** @type {PassThrough | null} */
    this.pcmTarget = null;
    this.feed = new PcmFeed();
    this.resourceStarted = false;
    /** @type {Promise<void> | null} */
    this.connectPromise = null;
  }

  get isConnected() {
    return this.connection?.state.status === VoiceConnectionStatus.Ready;
  }

  async connectVoice() {
    if (this.destroyed) throw new Error("Player is stopped.");
    if (this.isConnected && this.connection.joinConfig.channelId === this.voiceChannel) {
      return;
    }
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = this.openVoice().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async openVoice() {
    const guild = this.client.guilds.cache.get(this.guildId);
    if (!guild) throw new Error("Guild is not cached.");
    if (!this.voiceChannel) throw new Error("No voice channel selected.");

    if (!this.audioPlayer) {
      this.audioPlayer = createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Play,
          // Five missed 20 ms frames (the default) stops playback. This machine
          // is a 4-core i5-6400 that swaps, so a short stall must not end the song.
          maxMissedFrames: 25,
        },
      });
    }

    if (
      this.connection &&
      this.connection.joinConfig.channelId !== this.voiceChannel
    ) {
      this.connection.destroy();
      this.connection = null;
    }

    if (!this.connection) {
      this.connection = joinVoiceChannel({
        channelId: this.voiceChannel,
        guildId: this.guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
      });
      this.connection.subscribe(this.audioPlayer);
    }

    await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
  }

  /**
   * @param {number} [positionMs]
   */
  async play(positionMs = 0) {
    if (this.destroyed || this.currentTrack) return false;
    const track = this.queue.shift();
    if (!track) {
      await this.finishQueue();
      return false;
    }

    const busy = otherActiveGuild(this.client, this.guildId);
    if (busy) {
      this.queue.unshift(track);
      throw new Error("Spotify is already playing in another server.");
    }

    const token = ++this.playToken;
    this.client.engineOwner = this.guildId;
    this.currentTrack = track;
    this.isPlaying = true;
    this.isPaused = false;
    this.position = positionMs;
    this.attachAudio();

    try {
      await this.client.spotify.load(track.info.uri, positionMs);
      if (token !== this.playToken || this.destroyed) return false;
      const next = this.queue[0];
      if (next?.info?.uri) {
        this.client.spotify.preload(next.info.uri).catch((error) => {
          logError("preload", error, { uri: next.info.uri });
        });
      }
      await this.onTrackStart(track);
      return true;
    } catch (error) {
      if (token !== this.playToken || this.destroyed) return false;
      await this.onTrackError(track, error);
      return false;
    }
  }

  /**
   * @param {boolean} paused
   */
  async pause(paused) {
    if (!this.currentTrack) return;
    this.isPaused = paused;
    if (paused) {
      await this.client.spotify.pause();
      this.audioPlayer?.pause();
    } else {
      await this.client.spotify.resume();
      this.audioPlayer?.unpause();
    }
  }

  async skip() {
    this.ignoreEnd = true;
    try {
      await this.client.spotify.stop();
    } catch (error) {
      logError("skip:stop", error, { guildId: this.guildId });
    }
    try {
      await this.advance();
    } finally {
      this.ignoreEnd = false;
    }
  }

  async advance() {
    if (this.destroyed) return;
    this.playToken += 1;
    this.previousTrack = this.currentTrack ?? this.previousTrack;
    this.currentTrack = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.position = 0;
    this.pcmTarget = null;
    this.resourceStarted = false;
    this.feed.reset();
    if (this.queue.length > 0) {
      await this.play();
      return;
    }
    await this.finishQueue();
  }

  /**
   * @param {number} positionMs
   */
  async seekTo(positionMs) {
    if (!this.currentTrack) return;
    const wasPaused = this.isPaused;
    this.position = positionMs;
    await this.client.spotify.seek(positionMs);
    if (wasPaused) {
      this.isPaused = true;
      await this.client.spotify.pause();
      this.audioPlayer?.pause();
    }
  }

  async destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.playToken += 1;
    this.currentTrack = null;
    this.isPlaying = false;
    this.isPaused = false;
    this.pcmTarget = null;
    this.resourceStarted = false;
    this.feed.reset();
    this.queue.clear();

    try {
      this.audioPlayer?.stop(true);
    } catch {
      // ignore
    }
    try {
      this.connection?.destroy();
    } catch (error) {
      logError("player:voice", error, { guildId: this.guildId });
    }
    this.connection = null;
    this.audioPlayer = null;
    this.client.players.delete(this.guildId);

    if (this.client.engineOwner === this.guildId) {
      this.client.engineOwner = null;
      try {
        await this.client.spotify.stop();
      } catch (error) {
        logError("player:stop", error, { guildId: this.guildId });
      }
    }
  }

  attachAudio() {
    if (!this.audioPlayer || this.destroyed) return;
    // Don't play yet. An empty resource makes Discord count missed frames
    // until PCM shows up, which is what was cutting the audio out.
    const pass = new PassThrough({ highWaterMark: 256 * 1024 });
    this.pcmTarget = pass;
    this.feed.reset();
    this.resourceStarted = false;
  }

  /**
   * @param {Buffer[]} chunks
   */
  openResource(chunks) {
    const pass = this.pcmTarget;
    if (!pass || !this.audioPlayer || this.resourceStarted) return;
    const resource = createAudioResource(pass, { inputType: StreamType.Raw });
    this.audioPlayer.play(resource);
    for (const part of chunks) pass.write(part);
    this.resourceStarted = true;
    if (!this.isPaused) return;
    if (this.audioPlayer.pause()) return;
    this.audioPlayer.once("stateChange", () => {
      if (this.isPaused) this.audioPlayer?.pause();
    });
  }

  /**
   * @param {Buffer} chunk
   */
  writePcm(chunk) {
    if (this.destroyed || !this.pcmTarget || !chunk?.length) return;
    const ready = this.feed.push(chunk);
    if (!ready) return;
    if (!this.resourceStarted) {
      this.openResource(ready);
      return;
    }
    for (const part of ready) this.pcmTarget.write(part);
  }

  onDiscontinuity() {
    if (this.destroyed || !this.currentTrack) return;
    this.attachAudio();
    // Drop audio already buffered for the previous segment (seek or new track).
    this.audioPlayer?.stop(true);
  }

  /**
   * @param {{ type?: string, uri?: string, positionMs?: number | null }} event
   */
  async handleEngineEvent(event) {
    if (this.destroyed || this.client.engineOwner !== this.guildId) return;
    const uri = event?.uri;
    const currentUri = this.currentTrack?.info?.uri;
    if (uri && currentUri && uri !== currentUri) return;

    if (event.type === "position" || event.type === "playing" || event.type === "seeked") {
      if (Number.isFinite(event.positionMs)) this.position = event.positionMs;
      if (event.type === "playing") {
        this.isPlaying = true;
        this.isPaused = false;
      }
      await this.refreshProgress();
      return;
    }

    if (event.type === "paused") {
      this.isPaused = true;
      if (Number.isFinite(event.positionMs)) this.position = event.positionMs;
      return;
    }

    if (event.type === "end") {
      if (this.ignoreEnd || !this.currentTrack) return;
      if (event.uri && event.uri !== this.currentTrack.info.uri) return;
      const length = Number(this.currentTrack.info.length) || 0;
      // A fast sink used to decode the file in a few seconds and report the end
      // while Discord was still at the start. Only advance near the real end.
      if (length > 15_000 && this.position < length - 10_000) return;
      if (!this.resourceStarted && this.feed.pendingBytes > 0) {
        this.openResource(this.feed.flush());
      }
      await this.advance();
      return;
    }

    if (event.type === "unavailable") {
      if (this.ignoreEnd || !this.currentTrack) return;
      const early = (this.position ?? 0) < 3_000;
      if (early && this.unavailableRetries < 1 && this.currentTrack.info?.uri) {
        this.unavailableRetries += 1;
        const uri = this.currentTrack.info.uri;
        const position = this.position ?? 0;
        try {
          await this.client.spotify.load(uri, position);
          return;
        } catch (error) {
          logError("trackError:retry", error, { uri, guildId: this.guildId });
        }
      }
      await this.onTrackError(this.currentTrack, new Error("Track unavailable"));
    }
  }

  async refreshProgress() {
    const state = getPlayerState(this.client, this.guildId);
    if (!shouldRefreshPanel(this, state)) return;
    await updatePlayerPanel(this.client, this);
  }

  /**
   * @param {object} track
   */
  async onTrackStart(track) {
    const state = getPlayerState(this.client, this.guildId);
    this.unavailableRetries = 0;
    state.lastTrack = track;
    rememberTrack(state, track);
    await updatePlayerPanel(this.client, this);
    refreshIdleTimer(this.client, this);
  }

  /**
   * @param {object | null} track
   * @param {unknown} error
   */
  async onTrackError(track, error) {
    logError("trackError", error, {
      title: track?.info?.title ?? null,
      uri: track?.info?.uri ?? null,
      guildId: this.guildId,
    });
    const title = track?.info?.title ?? "Unknown track";
    await sendPlayerMessage(
      this.client,
      this.textChannel,
      `Skipping **${title}** — it failed to play.`,
    );
    try {
      await this.advance();
    } catch (skipError) {
      logError("trackError:skip", skipError, { guildId: this.guildId });
    }
  }

  async finishQueue() {
    if (this.destroyed || this.currentTrack || this.isPlaying) return;
    const state = getPlayerState(this.client, this.guildId);
    if (state.autoplay) {
      try {
        const started = await startAutoplay(this.client, this);
        if (started) return;
      } catch (error) {
        logError("queueEnd:autoplay", error, { guildId: this.guildId });
      }
    }

    const { stopPlayback } = await import("../utils/playback.js");
    try {
      await stopPlayback(this.client, this);
    } catch (error) {
      logError("queueEnd:destroy", error, { guildId: this.guildId });
    }
  }
}

/**
 * @param {import("../client.js").MusicBot} client
 * @param {string} guildId
 */
export function otherActiveGuild(client, guildId) {
  for (const [id, player] of client.players) {
    if (id === guildId) continue;
    if (player.currentTrack || player.isPlaying || player.queue.length > 0) {
      return id;
    }
  }
  return null;
}
