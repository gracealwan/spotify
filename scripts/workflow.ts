import { buildPlan, type Plan, type Playlist } from "./compare";
import type { SpotifyClient } from "./spotify";

export type PlaylistRef = { id: string; name: string };

export type ReadResult = { targets: Playlist[]; spin: Playlist[]; plan: Plan };

export type ApplyResult = {
  name: string;
  before: number;
  after: number;
  removed: { name: string; artists: string[]; occurrences: number }[];
};

const readAll = async (client: SpotifyClient, refs: PlaylistRef[]): Promise<Playlist[]> => {
  const playlists: Playlist[] = [];
  for (const ref of refs) playlists.push(await client.readPlaylist(ref.id, ref.name));
  return playlists;
};

export const readAndPlan = async (
  client: SpotifyClient,
  targetRefs: PlaylistRef[],
  spinRefs: PlaylistRef[],
  now: Date,
): Promise<ReadResult> => {
  const targets = await readAll(client, targetRefs);
  const spin = await readAll(client, spinRefs);
  return { targets, spin, plan: buildPlan(targets, spin, now.toISOString()) };
};

// Only exact matches are removed unless a review item is explicitly approved by URI.
export const applyPlan = async (
  client: SpotifyClient,
  plan: Plan,
  approvedReviewUris: string[],
): Promise<ApplyResult[]> => {
  const reviewUris = new Set(plan.targets.flatMap((t) => t.review.map((r) => r.uri)));
  const unknown = approvedReviewUris.filter((uri) => !reviewUris.has(uri));
  if (unknown.length > 0) throw new Error(`Not in the plan's review list: ${unknown.join(", ")}`);
  const approved = new Set(approvedReviewUris);

  const current = await readAll(client, plan.targets);
  for (const target of plan.targets) {
    const playlist = current.find((p) => p.id === target.id);
    if (playlist?.snapshotId !== target.snapshotId) {
      throw new Error(`"${target.name}" changed since the plan was made. Run read again. Nothing was removed.`);
    }
  }

  const results: ApplyResult[] = [];
  for (const target of plan.targets) {
    const before = await client.readPlaylist(target.id, target.name);
    const toRemove = new Set([
      ...target.exact.map((match) => match.uri),
      ...target.review.filter((match) => approved.has(match.uri)).map((match) => match.uri),
    ]);
    const matching = before.tracks.filter((track) => toRemove.has(track.uri));
    const uris = [...new Set(matching.map((track) => track.uri))];

    if (uris.length > 0) await client.removeTracks(target.id, uris);

    const after = await client.readPlaylist(target.id, target.name);
    const remaining = after.tracks.filter((track) => toRemove.has(track.uri));
    if (remaining.length > 0 || after.total !== before.total - matching.length) {
      throw new Error(
        `"${target.name}" did not update as expected: ${before.total} before, ${after.total} after, ` +
          `${matching.length} to remove, ${remaining.length} still present.`,
      );
    }

    results.push({
      name: target.name,
      before: before.total,
      after: after.total,
      removed: uris.map((uri) => {
        const occurrences = matching.filter((track) => track.uri === uri);
        const first = occurrences[0];
        return { name: first?.name ?? uri, artists: first?.artists ?? [], occurrences: occurrences.length };
      }),
    });
  }
  return results;
};
