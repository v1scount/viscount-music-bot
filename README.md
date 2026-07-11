# music-bot

Private Discord music bot using Lavalink v4 (with LavaSrc) and Poru.

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

If Lavalink exits with `Permission denied` under `./plugins/`, the plugins volume is not writable by the container user (uid 322). With the default Compose setup this should not happen; if you bind-mount a host directory instead, fix it with:

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
