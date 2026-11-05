import type { Playlist, Track } from "./compare";

export const API_BASE = "https://api.spotify.com/v1";
const PAGE_SIZE = 50;
const REMOVE_BATCH_SIZE = 100;
const MAX_ATTEMPTS = 6;

export class SpotifyError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Spotify returned ${status}: ${detail}`);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new Error(`Unexpected Spotify response: ${label} is not a string`);
  return value;
};

const requireNumber = (value: unknown, label: string): number => {
  if (typeof value !== "number") throw new Error(`Unexpected Spotify response: ${label} is not a number`);
  return value;
};

const decodeTrack = (value: unknown): Track | null => {
  if (!isRecord(value)) return null;
  const artists = Array.isArray(value.artists)
    ? value.artists.flatMap((artist) =>
        isRecord(artist) && typeof artist.name === "string" ? [artist.name] : [],
      )
    : [];
  const externalIds = isRecord(value.external_ids) ? value.external_ids : {};
  return {
    uri: requireString(value.uri, "item.uri"),
    name: requireString(value.name, "item.name"),
    artists,
    isrc: typeof externalIds.isrc === "string" ? externalIds.isrc.toUpperCase() : null,
  };
};

const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

export type SpotifyClient = {
  readPlaylist: (id: string, expectedName: string) => Promise<Playlist>;
  removeTracks: (id: string, uris: string[]) => Promise<void>;
};

export const createClient = (options: {
  apiBase: string;
  getAccessToken: () => Promise<string>;
}): SpotifyClient => {
  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(`${options.apiBase}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${await options.getAccessToken()}`,
          "Content-Type": "application/json",
        },
      });

      if (response.ok) return response.json();

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS) {
        const waitSeconds = Number(response.headers.get("Retry-After") ?? attempt);
        await Bun.sleep(waitSeconds * 1000);
        continue;
      }
      throw new SpotifyError(response.status, await response.text());
    }
  };

  const readPlaylist = async (id: string, expectedName: string): Promise<Playlist> => {
    const meta = await request(`/playlists/${id}?fields=id,name,snapshot_id`);
    if (!isRecord(meta)) throw new Error("Unexpected Spotify response: playlist is not an object");
    const name = requireString(meta.name, "playlist.name");
    if (name !== expectedName) {
      throw new Error(`Playlist ${id} is named "${name}", expected "${expectedName}"`);
    }

    const tracks: Track[] = [];
    let entriesRead = 0;
    let total = 0;
    do {
      const page = await request(
        `/playlists/${id}/items?limit=${PAGE_SIZE}&offset=${entriesRead}&additional_types=track,episode`,
      );
      if (!isRecord(page) || !Array.isArray(page.items)) {
        throw new Error(`Unexpected Spotify response: no items for "${name}"`);
      }
      total = requireNumber(page.total, "page.total");
      if (page.items.length === 0) break;
      for (const entry of page.items) {
        const track = isRecord(entry) ? decodeTrack(entry.item) : null;
        if (track) tracks.push(track);
      }
      entriesRead += page.items.length;
    } while (entriesRead < total);

    if (entriesRead !== total) {
      throw new Error(`"${name}": read ${entriesRead} entries but Spotify reports ${total}`);
    }
    if (total > 0 && tracks.length === 0) {
      throw new Error(`"${name}": Spotify returned ${total} entries with no readable songs`);
    }

    return {
      id,
      name,
      snapshotId: requireString(meta.snapshot_id, "playlist.snapshot_id"),
      total,
      unreadable: total - tracks.length,
      tracks,
    };
  };

  const removeTracks = async (id: string, uris: string[]): Promise<void> => {
    for (const batch of chunk(uris, REMOVE_BATCH_SIZE)) {
      await request(`/playlists/${id}/items`, {
        method: "DELETE",
        body: JSON.stringify({ items: batch.map((uri) => ({ uri })) }),
      });
    }
  };

  return { readPlaylist, removeTracks };
};
