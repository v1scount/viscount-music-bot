# music-bot

Private Discord music bot. Playback comes from a [librespot](https://github.com/librespot-org/librespot) engine logged into one Spotify Premium account. The bot keeps the queue, now-playing panel, and slash commands.

## Requirements

- Node.js 20+
- Docker (for the Spotify engine)
- A Spotify Premium account

librespot is an unofficial client. Spotify's terms forbid that, and free accounts cannot stream.

## Setup

1. Copy `.env.example` to `.env` and fill in Discord plus the Premium account.
2. Start everything:

```bash
docker compose up -d --build
```

Slash commands are registered when the bot becomes ready. You can still deploy them with `npm run deploy-commands`.

To run the bot on the host while the engine stays in Docker, publish the loopback ports (Compose does this) and:

```bash
npm install
npm start
```

The engine stores Spotify credentials in the `spotify-cache` volume so it can reuse them after the first login. If Spotify rejects the username and password, `docker logs -f music-bot-spotify` prints a browser link. Open that link on this machine, approve access, and the engine continues. The callback is `http://127.0.0.1:8898/login`.

One Premium account can play in one server at a time. A second server is refused while a stream is active.

## Persistence and idle leave

Player sessions are saved to a JSON file (`DATA_PATH`, default `./data/sessions.json` locally or `/app/data/sessions.json` in Docker). Tracks are stored as Spotify URIs. Older YouTube sessions are ignored.

If the bot is alone in a voice channel for `IDLE_LEAVE_MS` (default `300000` / 5 minutes), it clears the queue and leaves.

## Commands

| Command | Description |
|---------|-------------|
| `/play` | Play a Spotify track, album, playlist, or search |
| `/pause` | Pause playback |
| `/resume` | Resume playback |
| `/skip` | Skip the current track |
| `/queue` | Show the queue |
| `/stop` | Stop playback, clear the queue, and leave voice |
| `/seek position` | Jump to seconds, `mm:ss`, or `hh:mm:ss` |
| `/remove position` | Remove an upcoming track |
| `/move from to` | Reorder an upcoming track |
| `/clear` | Clear upcoming tracks without stopping |
| `/autoplay enabled` | Toggle ReccoBeats recommendation autoplay |

YouTube and other non-Spotify links are declined.

## Player panel

The bot keeps the now-playing panel at the bottom of the channel by moving it whenever something else is posted below it. Controls: Pause/Play, Skip, Stop, and Autoplay. A new panel is posted when playback starts; the previous one is not reused.

Panel **Stop** matches `/stop`: it clears the queue, deletes the bot’s messages in that text channel, and leaves the voice channel. Progress refreshes about every 5 seconds while playing (not while paused). Failed tracks are skipped automatically with a short channel notice.

## Autoplay

Autoplay is enabled by default. When the queue runs out, the bot asks
[ReccoBeats](https://reccobeats.com/docs/apis/get-recommendation) for tracks
similar to the song the listener originally requested. That anchor stays fixed,
so recommendations do not drift from one autoplay track to the next.

The seed track's Spotify popularity is sent as an explicit recommendation
target. Results more than 10 popularity points away are discarded and the
closest results are queued first. This keeps mainstream tracks with similarly
popular tracks and niche tracks with similarly sized audiences; ReccoBeats does
not expose raw reproduction counts, so Spotify popularity is the available
proxy. Other artists lead the buffer, and the seed artist returns about once
every four songs. If that first list is still mostly the seed artist, one
follow-up request excludes them so the station can fill with neighbors. The
next refill is allowed to include them again. Recently played tracks are
excluded, up to 12 recommendations are queued at a time, and manually queued
tracks always take priority. ReccoBeats requires no API key.

Use `/autoplay enabled:false` or the panel button to disable it for a server.

Albums and playlists queue up to 100 tracks.

## Development

```bash
npm test
```
