import { afterAll, describe, expect, test } from "bun:test";
import { buildPlan, normalizeTitle, type Playlist, type Track } from "./compare";
import { createClient } from "./spotify";
import { applyPlan, readAndPlan } from "./workflow";

type FakeEntry = { item: Record<string, unknown> | null };
type FakePlaylist = { name: string; snapshot: number; entries: FakeEntry[]; reportedTotal?: number };

const song = (id: string, name: string, artist: string, isrc?: string): FakeEntry => ({
  item: {
    uri: `spotify:track:${id}`,
    name,
    artists: [{ name: artist }],
    external_ids: isrc ? { isrc } : {},
  },
});

const fillers = (prefix: string, count: number): FakeEntry[] =>
  Array.from({ length: count }, (_, i) => song(`${prefix}${i}`, `${prefix} song ${i}`, `${prefix} artist`));

let playlists: Record<string, FakePlaylist> = {};
let deleteBatches: { id: string; uris: string[] }[] = [];
let rateLimitNext = false;

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const [, , id, sub] = url.pathname.split("/");
    const playlist = playlists[id ?? ""];
    if (!playlist) return new Response("missing", { status: 404 });

    if (rateLimitNext) {
      rateLimitNext = false;
      return new Response("slow down", { status: 429, headers: { "Retry-After": "0" } });
    }
    if (!sub) return Response.json({ id, name: playlist.name, snapshot_id: `s${playlist.snapshot}` });

    if (request.method === "DELETE") {
      const body = (await request.json()) as { items: { uri: string }[] };
      const uris = body.items.map((item) => item.uri);
      deleteBatches.push({ id: id ?? "", uris });
      playlist.entries = playlist.entries.filter(
        (entry) => !uris.includes(String(entry.item?.uri)),
      );
      playlist.snapshot++;
      return Response.json({ snapshot_id: `s${playlist.snapshot}` });
    }

    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    return Response.json({
      total: playlist.reportedTotal ?? playlist.entries.length,
      items: playlist.entries.slice(offset, offset + limit),
    });
  },
});
afterAll(() => server.stop(true));

const client = createClient({
  apiBase: `http://127.0.0.1:${server.port}`,
  getAccessToken: async () => "test-token",
});

const reset = (next: Record<string, FakePlaylist>): void => {
  playlists = next;
  deleteBatches = [];
  rateLimitNext = false;
};

const PRE = { id: "pre", name: "Pre class songs" };
const POST = { id: "post", name: "Post class songs" };
const SPIN = [{ id: "spin", name: "80s RPM" }];
const NOW = new Date("2026-11-05T00:00:00Z");

const track = (uri: string, name: string, artist: string, isrc: string | null = null): Track => ({
  uri,
  name,
  artists: [artist],
  isrc,
});

const playlistOf = (name: string, tracks: Track[]): Playlist => ({
  id: name,
  name,
  snapshotId: "s",
  total: tracks.length,
  unreadable: 0,
  tracks,
});

describe("normalizeTitle", () => {
  test("drops version suffixes and accents", () => {
    expect(normalizeTitle("Talk That Talk - Album Version (Edited)")).toBe("talk that talk");
    expect(normalizeTitle("MAGIC (feat. babyidontlikeyou)")).toBe("magic");
    expect(normalizeTitle("Déjà Vu")).toBe("deja vu");
  });
});

describe("buildPlan", () => {
  const target = (tracks: Track[]) => buildPlan(
    [playlistOf("Pre", tracks)],
    [playlistOf("80s", [
      track("u:a", "Rude Boy", "Rihanna", "ISRC1"),
      track("u:b", "Untouched", "The Veronicas", "ISRC2"),
      track("u:c", "Midnight Sun - Remix", "Zara Larsson", "ISRC3"),
    ]), playlistOf("90s", [track("u:a", "Rude Boy", "Rihanna", "ISRC1")])],
    NOW.toISOString(),
  ).targets[0];

  test("same URI is an exact match listing every spin playlist", () => {
    const plan = target([track("u:a", "Rude Boy", "Rihanna", "ISRC1")]);
    expect(plan?.exact.map((m) => m.foundIn)).toEqual([["80s", "90s"]]);
    expect(plan?.review).toEqual([]);
  });

  test("same ISRC under a different URI needs review, not removal", () => {
    const plan = target([track("u:other", "Untouched", "The Veronicas", "ISRC2")]);
    expect(plan?.exact).toEqual([]);
    expect(plan?.review[0]?.reason).toBe("same-recording");
  });

  test("a remix with a shared artist needs review", () => {
    const plan = target([track("u:orig", "Midnight Sun", "Zara Larsson", "ISRC9")]);
    expect(plan?.review[0]?.reason).toBe("similar-title");
  });

  test("the same title by a different artist is not a match", () => {
    const plan = target([track("u:x", "Untouched", "Someone Else", "ISRC8")]);
    expect(plan?.exact).toEqual([]);
    expect(plan?.review).toEqual([]);
  });

  test("a song listed twice in a target is reported once", () => {
    const plan = target([track("u:a", "Rude Boy", "Rihanna"), track("u:a", "Rude Boy", "Rihanna")]);
    expect(plan?.exact).toHaveLength(1);
  });
});

describe("reading", () => {
  test("reads every page past the 50-song limit", async () => {
    reset({ spin: { name: "80s RPM", snapshot: 1, entries: fillers("x", 123) } });
    const playlist = await client.readPlaylist("spin", "80s RPM");
    expect(playlist.tracks).toHaveLength(123);
    expect(new Set(playlist.tracks.map((t) => t.uri)).size).toBe(123);
  });

  test("retries after a rate limit", async () => {
    reset({ spin: { name: "80s RPM", snapshot: 1, entries: fillers("x", 3) } });
    rateLimitNext = true;
    expect((await client.readPlaylist("spin", "80s RPM")).total).toBe(3);
  });

  test("fails when fewer songs arrive than Spotify reports", async () => {
    reset({ spin: { name: "80s RPM", snapshot: 1, entries: fillers("x", 3), reportedTotal: 5 } });
    await expect(client.readPlaylist("spin", "80s RPM")).rejects.toThrow("read 3 entries");
  });

  test("fails when an ID points at a differently named playlist", async () => {
    reset({ spin: { name: "Something else", snapshot: 1, entries: [] } });
    await expect(client.readPlaylist("spin", "80s RPM")).rejects.toThrow("expected");
  });

  test("counts unavailable entries without treating them as songs", async () => {
    reset({ spin: { name: "80s RPM", snapshot: 1, entries: [...fillers("x", 2), { item: null }] } });
    const playlist = await client.readPlaylist("spin", "80s RPM");
    expect(playlist.total).toBe(3);
    expect(playlist.unreadable).toBe(1);
  });
});

describe("applying", () => {
  const setUp = () =>
    reset({
      pre: {
        name: PRE.name,
        snapshot: 1,
        entries: [
          song("shared", "Rude Boy", "Rihanna"),
          song("keep", "Keep Me", "Someone"),
          song("near", "Untouched", "The Veronicas", "ISRC2"),
          song("shared", "Rude Boy", "Rihanna"),
        ],
      },
      post: { name: POST.name, snapshot: 1, entries: [song("shared", "Rude Boy", "Rihanna"), song("stay", "Stay", "Someone")] },
      spin: {
        name: "80s RPM",
        snapshot: 1,
        entries: [song("shared", "Rude Boy", "Rihanna"), song("near2", "Untouched", "The Veronicas", "ISRC2")],
      },
    });

  test("read never sends a removal", async () => {
    setUp();
    await readAndPlan(client, [PRE, POST], SPIN, NOW);
    expect(deleteBatches).toEqual([]);
  });

  test("removes exact matches from targets only and leaves review items", async () => {
    setUp();
    const { plan } = await readAndPlan(client, [PRE, POST], SPIN, NOW);
    const results = await applyPlan(client, plan, []);

    expect(deleteBatches.map((b) => b.id)).toEqual(["pre", "post"]);
    expect(playlists.spin?.entries).toHaveLength(2);
    expect(playlists.pre?.entries.map((e) => e.item?.name)).toEqual(["Keep Me", "Untouched"]);
    expect(playlists.post?.entries.map((e) => e.item?.name)).toEqual(["Stay"]);
    expect(results[0]).toMatchObject({ before: 4, after: 2 });
    expect(results[0]?.removed[0]?.occurrences).toBe(2);
  });

  test("removes a review item only when approved", async () => {
    setUp();
    const { plan } = await readAndPlan(client, [PRE, POST], SPIN, NOW);
    await applyPlan(client, plan, ["spotify:track:near"]);
    expect(playlists.pre?.entries.map((e) => e.item?.name)).toEqual(["Keep Me"]);
  });

  test("rejects an approval that is not in the review list", async () => {
    setUp();
    const { plan } = await readAndPlan(client, [PRE, POST], SPIN, NOW);
    await expect(applyPlan(client, plan, ["spotify:track:keep"])).rejects.toThrow("Not in the plan");
    expect(deleteBatches).toEqual([]);
  });

  test("removes nothing if a playlist changed after the plan", async () => {
    setUp();
    const { plan } = await readAndPlan(client, [PRE, POST], SPIN, NOW);
    const post = playlists.post;
    if (post) post.snapshot = 99;
    await expect(applyPlan(client, plan, [])).rejects.toThrow("changed since");
    expect(deleteBatches).toEqual([]);
  });

  test("splits large removals into batches of 100", async () => {
    const shared = fillers("s", 230);
    reset({
      pre: { name: PRE.name, snapshot: 1, entries: shared },
      spin: { name: "80s RPM", snapshot: 1, entries: shared },
    });
    const { plan } = await readAndPlan(client, [PRE], SPIN, NOW);
    await applyPlan(client, plan, []);
    expect(deleteBatches.map((b) => b.uris.length)).toEqual([100, 100, 30]);
  });
});
