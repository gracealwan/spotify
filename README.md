# spotify

For now, this repo just has scripts for agents to use on my Spotify account.

## Setup

You need [Bun](https://bun.sh) and a Spotify Premium account, which Spotify requires for developer apps.

1. Create an app in the [Spotify developer dashboard](https://developer.spotify.com/dashboard). Select Web API and add this redirect URI:

   ```
   http://127.0.0.1:8888/callback
   ```

2. Install dependencies and create your `.env`:

   ```bash
   bun install
   cp .env.example .env
   ```

3. Put the app's Client ID in `.env` as `SPOTIFY_CLIENT_ID`. The scripts don't use the Client Secret.

The first run opens a Spotify page to approve access. Run commands from the repo root, since `.env` and the paths below are relative to it.

## Playlist cleanup

`scripts/cleanup.ts` removes songs from "Pre class songs" and "Post class songs" if they are also in one of my spin playlists. The playlist IDs are listed at the top of that file.

Read everything and build a plan. This changes nothing on Spotify:

```bash
bun run read
```

It prints two kinds of match and saves them to `output/plan.json`:

- **Exact (`REMOVE`):** the same Spotify track.
- **Near (`REVIEW`):** the same recording under a different track ID, or a similar title with a shared artist, such as a remix.

Apply the plan. This removes the exact matches, plus any near-matches you name with `--also`:

```bash
bun run apply --also spotify:track:TRACK_ID
```

If a playlist's version ID has changed since the plan was made, `apply` stops without removing anything. Run `read` again and review the new plan. This can happen even when the songs haven't changed.

### Rules for agents

- Show the plan to me and get my approval before running `apply`.
- Never pass `--also` for a near-match I haven't approved.
- `apply` has no undo. It saves a backup to `output/` first, which lists each playlist's songs in order.

## Local files

These stay out of git:

- `.env`: the Client ID
- `.spotify/`: the Spotify access and refresh tokens
- `output/`: plans and playlist backups

## Tests

These run against a fake Spotify server, not your account:

```bash
bun test
bun run typecheck
```
