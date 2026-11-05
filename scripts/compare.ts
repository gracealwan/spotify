export type Track = {
  uri: string;
  name: string;
  artists: string[];
  isrc: string | null;
};

export type Playlist = {
  id: string;
  name: string;
  snapshotId: string;
  total: number;
  unreadable: number;
  tracks: Track[];
};

export type ExactMatch = {
  uri: string;
  name: string;
  artists: string[];
  foundIn: string[];
};

export type ReviewReason = "same-recording" | "similar-title";

export type ReviewMatch = {
  uri: string;
  name: string;
  artists: string[];
  reason: ReviewReason;
  candidates: { playlist: string; uri: string; name: string; artists: string[] }[];
};

export type TargetPlan = {
  id: string;
  name: string;
  snapshotId: string;
  exact: ExactMatch[];
  review: ReviewMatch[];
};

export type Plan = {
  createdAt: string;
  targets: TargetPlan[];
};

const normalizeText = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// Drops version suffixes so "Song - Radio Edit" and "Song (feat. X)" compare as "Song".
export const normalizeTitle = (title: string): string =>
  normalizeText(title.replace(/\s+[-([].*$/, ""));

const sharesArtist = (a: Track, b: Track): boolean => {
  const artists = new Set(a.artists.map(normalizeText));
  return b.artists.some((artist) => artists.has(normalizeText(artist)));
};

type Located = { playlist: string; track: Track };

const groupBy = <K>(items: Located[], keyOf: (item: Located) => K | null): Map<K, Located[]> => {
  const groups = new Map<K, Located[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === null) continue;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
};

const toCandidates = (items: Located[]): ReviewMatch["candidates"] =>
  items.map(({ playlist, track }) => ({
    playlist,
    uri: track.uri,
    name: track.name,
    artists: track.artists,
  }));

export const buildPlan = (targets: Playlist[], spin: Playlist[], createdAt: string): Plan => {
  const located = spin.flatMap((playlist) =>
    playlist.tracks.map((track) => ({ playlist: playlist.name, track })),
  );
  const byUri = groupBy(located, ({ track }) => track.uri);
  const byIsrc = groupBy(located, ({ track }) => track.isrc);
  const byTitle = groupBy(located, ({ track }) => normalizeTitle(track.name) || null);

  return {
    createdAt,
    targets: targets.map((target) => {
      const exact: ExactMatch[] = [];
      const review: ReviewMatch[] = [];
      const seen = new Set<string>();

      for (const track of target.tracks) {
        if (seen.has(track.uri)) continue;
        seen.add(track.uri);
        const base = { uri: track.uri, name: track.name, artists: track.artists };

        const sameUri = byUri.get(track.uri);
        if (sameUri) {
          exact.push({ ...base, foundIn: [...new Set(sameUri.map((item) => item.playlist))] });
          continue;
        }

        const sameIsrc = track.isrc ? byIsrc.get(track.isrc) : undefined;
        if (sameIsrc) {
          review.push({ ...base, reason: "same-recording", candidates: toCandidates(sameIsrc) });
          continue;
        }

        const similar = (byTitle.get(normalizeTitle(track.name)) ?? []).filter((item) =>
          sharesArtist(track, item.track),
        );
        if (similar.length > 0) {
          review.push({ ...base, reason: "similar-title", candidates: toCandidates(similar) });
        }
      }

      return { id: target.id, name: target.name, snapshotId: target.snapshotId, exact, review };
    }),
  };
};
