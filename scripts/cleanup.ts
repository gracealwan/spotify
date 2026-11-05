import { mkdir } from "node:fs/promises";
import { createTokenProvider } from "./auth";
import type { Plan, Playlist } from "./compare";
import { API_BASE, createClient } from "./spotify";
import { applyPlan, readAndPlan, type PlaylistRef } from "./workflow";

const TARGETS: PlaylistRef[] = [
  { id: "5mYbFmUgO7tVmZpNhGb7Sw", name: "Pre class songs" },
  { id: "2kOcodS9y9gGQl1Ki6RMrW", name: "Post class songs" },
];

const SPIN: PlaylistRef[] = [
  { id: "71eJc8JYLVsEAbzKrkm3W2", name: "60s RPM (serious hill)" },
  { id: "4S1u1WLsMoCdxiMGR1LPoI", name: "60s (choreo)" },
  { id: "7BBtbkJEe9qZkabpQWM4hd", name: "70s RPM" },
  { id: "3MV5jEUBLziIyg604miYMf", name: "80s RPM" },
  { id: "5QCLNzmd6DZ8MYnGr5MeVr", name: "90s RPM" },
  { id: "34TlzTiosyom66NCUTZYig", name: "100s RPM" },
  { id: "6lYSYGwMoTeSZPIvvauezO", name: "110s RPM" },
  { id: "3v11wVLUdnXZK8456xi9Fk", name: "120s RPM" },
  { id: "0xDxsWQW78bFvecolrLsAH", name: "Rolling Hills" },
  { id: "5zYXOQXuwN6cxA9fw5Faax", name: "Escape Tracks" },
];

const OUTPUT_DIR = "output";
const PLAN_PATH = `${OUTPUT_DIR}/plan.json`;
const TOKEN_PATH = ".spotify/token.json";

const saveBackup = async (playlists: Playlist[], label: string): Promise<string> => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${OUTPUT_DIR}/backup-${label}-${stamp}.json`;
  await Bun.write(path, JSON.stringify(playlists, null, 2));
  return path;
};

const describe = (name: string, artists: string[]): string => `${name} (${artists.join(", ")})`;

const printPlan = (plan: Plan): void => {
  for (const target of plan.targets) {
    console.log(`\n${target.name}: ${target.exact.length} exact, ${target.review.length} to review`);
    for (const match of target.exact) {
      console.log(`  REMOVE  ${describe(match.name, match.artists)}  [in ${match.foundIn.join(", ")}]`);
    }
    for (const match of target.review) {
      console.log(`  REVIEW  ${describe(match.name, match.artists)}  ${match.uri}  (${match.reason})`);
      for (const candidate of match.candidates) {
        console.log(`          vs ${describe(candidate.name, candidate.artists)}  [in ${candidate.playlist}]`);
      }
    }
  }
};

const main = async (): Promise<void> => {
  const [command, ...rest] = Bun.argv.slice(2);
  if (command !== "read" && command !== "apply") {
    throw new Error("Usage: bun run read | bun run apply [--also <spotify:track:uri>]...");
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) throw new Error("Set SPOTIFY_CLIENT_ID in .env at the repo root first");

  const client = createClient({
    apiBase: API_BASE,
    getAccessToken: createTokenProvider(clientId, TOKEN_PATH),
  });
  await mkdir(OUTPUT_DIR, { recursive: true });

  if (command === "read") {
    const { targets, spin, plan } = await readAndPlan(client, TARGETS, SPIN, new Date());
    console.log("Read (nothing was changed):");
    for (const playlist of [...targets, ...spin]) {
      const note = playlist.unreadable > 0 ? `, ${playlist.unreadable} unavailable` : "";
      console.log(`  ${playlist.name}: ${playlist.total} entries, count verified${note}`);
    }
    printPlan(plan);
    await Bun.write(PLAN_PATH, JSON.stringify(plan, null, 2));
    console.log(`\nPlan: ${PLAN_PATH}\nBackup: ${await saveBackup(targets, "read")}`);
    return;
  }

  const approved = rest.flatMap((arg, index) => {
    if (arg !== "--also") return [];
    const uri = rest[index + 1];
    if (!uri) throw new Error("--also needs a Spotify URI");
    return [uri];
  });
  const plan = (await Bun.file(PLAN_PATH).json()) as Plan;
  const backup = await saveBackup(
    await Promise.all(TARGETS.map((ref) => client.readPlaylist(ref.id, ref.name))),
    "apply",
  );
  console.log(`Backup: ${backup}`);

  for (const result of await applyPlan(client, plan, approved)) {
    console.log(`\n${result.name}: ${result.before} -> ${result.after} songs`);
    for (const removed of result.removed) {
      const times = removed.occurrences > 1 ? ` x${removed.occurrences}` : "";
      console.log(`  removed ${describe(removed.name, removed.artists)}${times}`);
    }
  }
};

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
