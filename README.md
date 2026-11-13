# music-bot

Private Discord music bot. Playback comes from a [librespot](https://github.com/librespot-org/librespot) engine logged into one Spotify Premium account. The bot keeps the queue, now-playing panel, and slash commands. Autoplay recommendations come from Spotify Soloist, a second client on the same Premium account. It plays into a silent sink so the bot can copy Spotify's own autoplay list.

## Requirements

- Node.js 20+
- Docker (for the Spotify engine and the Soloist sidecar)
- A Spotify Premium account
- A Spotify developer API key (`SOLOIST_API_KEY`) from that account, used only by Soloist

librespot is an unofficial client. Spotify's terms forbid that, and free accounts cannot stream.

## Setup

1. Copy `.env.example` to `.env` and fill in Discord, the Premium account, and `SOLOIST_API_KEY`.
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

Soloist keeps its own login in the `soloist-data` volume. Pair the Spotify app with the device named `music-bot` once before relying on those recommendations. The steps are in [Soloist](#soloist). A harvest that cannot read an autoplay list uses the engine's built-in radio for that gap.

One Premium account can play in one server at a time. A second server is refused while a stream is active. Librespot and Soloist share that account, so the bot stops librespot before a harvest and deactivates Soloist before librespot plays the copied list.

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
| `/autoplay enabled` | Toggle recommendation autoplay for this server |

YouTube and other non-Spotify links are declined.

## Player panel

The bot keeps the now-playing panel at the bottom of the channel by moving it whenever something else is posted below it. Controls: Pause/Play, Skip, Stop, and Autoplay. A new panel is posted when playback starts; the previous one is not reused.

Panel **Stop** matches `/stop`: it clears the queue, deletes the bot’s messages in that text channel, and leaves the voice channel. Progress refreshes about every 5 seconds while playing (not while paused). Failed tracks are skipped automatically with a short channel notice.

## Autoplay

Autoplay is on for every server until `/autoplay enabled:false` or the panel button turns it off. Requested tracks always play first. A new `/play` removes recommendation rows still waiting in the queue and leaves the tracks someone asked for. Albums and playlists queue up to 100 of those requested tracks.

When the queue runs out, the bot asks Soloist for Spotify's autoplay list, then librespot plays that list. Each copied track is marked `Autoplay`. The listener hears a short gap after the song that just finished. The wait stops at `SOLOIST_HARVEST_TIMEOUT_MS` (default `8000`). Soloist's audio stays inside its container. Discord only hears librespot.

### What gets harvested

The bot opens one WebSocket to Soloist (`SOLOIST_WS_URL`, `ws://soloist:9090` inside Compose) and runs this sequence:

1. Stop librespot so the Premium account is idle.
2. Turn off repeat-track and repeat-context, set Soloist's volume to `0`, and play the seed track.
3. Read playback state. `context_enhancement: NONE` means this account or context will not grow an autoplay list, so the harvest stops immediately.
4. Otherwise poll `get_queue`. Keep `upcoming` rows whose `source` is `autoplay`. Drop the seed, anything already in the recent-track list (last 40 Spotify track URIs), duplicates, and rows from `context` or `queue`.
5. After the first autoplay row appears, read the queue once more (waiting at most a second) in case more rows land together, then stop. An empty poll waits 200 ms and tries again until the harvest timeout.
6. Pause Soloist and deactivate it, then close the socket.
7. A row that has a URI but no title is resolved through the engine's `/resolve` endpoint. Rows that are still the seed, or that match a recent URI or a recent title and artist, are dropped.
8. The remaining tracks are appended to the Discord queue and librespot starts the first one.

The seed is the last requested track that started playing. After a harvested list has played through, the next harvest seeds from the autoplay track that just finished, so the station follows what was actually heard. A new requested track replaces the seed, replaces the recent-URI list with that track, and clears the in-memory flag that skips Soloist.

### When the built-in radio is used

The engine's `GET /radio` endpoint is the fallback. It returns a batch of up to 25 tracks for the same seed, skipping URIs already played and artists from the last three autoplay tracks. The bot queues that whole batch.

Radio is used for the current gap when any of these happen:

- `SOLOIST_WS_URL` is empty. That is the default for `npm start` on the host. Compose sets the URL for the bot container.
- The WebSocket fails to connect or a command returns an error. The next empty queue tries Soloist again.
- Spotify reports `context_enhancement: NONE`, the harvest times out with no autoplay rows, or the list is empty. The guild remembers that in memory, so later gaps go straight to radio and do not open Soloist again until the next requested track. A process restart clears the flag; it is not written to the session file.

### Soloist

Soloist is a separate Compose service (`music-bot-soloist`). It is a Spotify Connect device, not an audio source for Discord.

Create an application with the Premium account at the [Spotify developer dashboard](https://developer.spotify.com/) and put its key in `SOLOIST_API_KEY`. Without that key the container stays up and idle (`sleep infinity`) and autoplay uses radio. The key is passed as a process argument and is not printed.

On start the container runs PipeWire and WirePlumber, then creates a null sink named `soloist-null` (`SOLOIST_PIPEWIRE_DEVICE`). Soloist is started with `--pipewire-device soloist-null` and `--ws 0.0.0.0:9090`, so playback is discarded in the container while the bot reads the queue over the WebSocket. Compose does not publish port `9090`. The image is Debian Trixie because the Soloist binary needs glibc 2.38.

The official binary is downloaded on first start from `https://soloist-builds.spotifycdn.com/` for the container architecture (`x86_64`, `arm64`, or `arm32`) into `/opt/soloist`. It is not stored in this repository. Builds expire after 90 days. Exit code `10` deletes the binary, downloads the current build, and starts again inside the same container. Any other exit ends the process; Compose starts the container again unless you stopped it.

`soloist-data` holds the paired session. `soloist-cache` holds the downloaded cache. Both survive container recreation.

Pair once, from a Spotify app on the same LAN as this machine. A container on the Compose bridge advertises an address the phone cannot reach, and the app hides the device, so the one-off `soloist-pair` service uses a macvlan address on the LAN (`192.168.100.50` on `enp4s0` by default). Change `SOLOIST_LAN_PARENT`, `SOLOIST_LAN_SUBNET`, `SOLOIST_LAN_GATEWAY`, and `SOLOIST_LAN_ADDRESS` when that network is different. The address must be free.

```bash
docker compose --profile pair build soloist-pair
docker compose --profile pair run --rm --no-deps soloist-pair
```

Open the Spotify device picker and select `music-bot` (`SOLOIST_DEVICE_NAME`). Later starts of the `soloist` service reuse the session in `soloist-data`; they do not need the pair profile. Stop the `soloist` service before pairing. The pair command uses the same `soloist-data` volume, and two Soloist processes must not hold that session at once.

## Development

```bash
npm test
```
