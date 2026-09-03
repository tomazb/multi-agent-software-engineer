import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SuspensionReason } from "../../src/github/types.ts";

export interface LegacyAssociationSeed {
  runId: string;
  installationId: number;
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  branch: string;
  suspended?: boolean;
  suspensionReason?: SuspensionReason;
  updatedAt?: string;
}

/**
 * Writes pre-#34, name-keyed `<repository>#<pr>` association records straight
 * into the authoritative index file.
 *
 * After the Issue #34 cutover no production API can create an unresolved
 * legacy record -- the ambiguous name-primary `bind()` is gone -- so the exact
 * pre-#34 on-disk shape is the only honest fixture for unmigrated state.
 * Records are merged into whatever the index already holds and are written in
 * the index's own serialization format so a real read parses them.
 */
export async function seedLegacyAssociations(
  githubRoot: string,
  seeds: readonly LegacyAssociationSeed[],
): Promise<void> {
  await mkdir(githubRoot, { recursive: true, mode: 0o700 });
  const filePath = path.join(githubRoot, "associations.json");
  let records: Record<string, unknown> = {};
  try {
    records = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const seed of seeds) {
    const suspended = seed.suspended ?? false;
    records[`${seed.repository}#${seed.pullRequestNumber}`] = {
      runId: seed.runId,
      installationId: seed.installationId,
      repository: seed.repository,
      pullRequestNumber: seed.pullRequestNumber,
      baseSha: seed.baseSha,
      headSha: seed.headSha,
      branch: seed.branch,
      suspended,
      ...(seed.suspensionReason !== undefined
        ? { suspensionReason: seed.suspensionReason }
        : {}),
      updatedAt: seed.updatedAt ?? new Date().toISOString(),
    };
  }
  await writeFile(filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}
