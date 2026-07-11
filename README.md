# music-bot

Private Discord music bot using Lavalink v4 (with LavaSrc), Poru, and YouTube Mix recommendations.

The bot provides an interactive now-playing panel, editable queue, audio filters, and similar-track autoplay when the manual queue ends.

## Requirements

- Node.js 20+
- Docker (for Lavalink)

## Setup

1. Copy `.env.example` to `.env` and fill in your Discord and Spotify credentials.
2. Start Lavalink:

```bash
docker compose up -d lavalink
```

3. Install dependencies and register slash commands:

```bash
npm install
npm run deploy-commands
```

4. Run the bot:

```bash
npm start
```

Or run everything with Docker:

```bash
docker compose up -d
```

For local/`npm start` use `LAVALINK_HOST=127.0.0.1`. Inside Compose, the bot uses the `lavalink` service name automatically.

Compose includes a one-shot `lavalink-plugins-init` service that `chown`s the plugins volume to uid `322` (Lavalink’s user). Empty named volumes are created as root and otherwise cause `Permission denied` when downloading plugins. If you bind-mount a host directory instead, fix ownership with:

```bash
sudo mkdir -p lavalink/plugins && sudo chown -R 322:322 lavalink/plugins
```

## Commands

| Command | Description |
|---------|-------------|
| `/play` | Play a song or add it to the queue |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/skip` | Skip the current track |
| `/queue` | Show the queue |
| `/stop` | Stop playback and clear the queue |
| `/volume level` | Set playback volume from 0 to 100 |
| `/seek position` | Jump to seconds, `mm:ss`, or `hh:mm:ss` |
| `/loop mode` | Loop the current track, queue, or nothing |
| `/shuffle` | Shuffle upcoming tracks |
| `/remove position` | Remove an upcoming track |
| `/move from to` | Reorder an upcoming track |
| `/clear` | Clear upcoming tracks without stopping |
| `/autoplay enabled` | Toggle YouTube Mix autoplay |
| `/filter preset` | Apply bass boost, nightcore, karaoke, or reset |

## Player panel

The bot keeps one now-playing message per server and updates it as playback changes. Its controls provide pause/resume, skip, stop, loop, autoplay, and audio filter selection. The progress display refreshes periodically while a track is active.

## Autoplay

Autoplay is enabled by default. When the manual queue ends, the bot builds a YouTube Mix from the last song and chooses a related track. If the original song came from Spotify, SoundCloud, or another source, the bot first finds its YouTube Music equivalent. Recently played tracks are excluded, manually queued tracks always take priority, and a YouTube Music search is used if the Mix is unavailable.

Use `/autoplay enabled:false` or the panel button to disable it for a server.

## Development

Run the unit tests with:

```bash
npm test
```
