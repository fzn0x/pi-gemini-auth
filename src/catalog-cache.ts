// Keeps the model list fresh and on disk, so /v1/models answers even while Google is slow.

import { readJson, writeJsonAtomic } from "./fsutil.ts";
import { type CatalogModel, type CatalogSnapshot, familyDefaults, fetchCatalog } from "./google/catalog.ts";
import type { GoogleConfig } from "./google/constants.ts";
import type { Rotator } from "./rotator.ts";

const MAX_AGE_MS = 15 * 60_000;

export class ModelCatalog {
  snapshot: CatalogSnapshot = { models: [], quotas: {} };
  fetchedAt = 0;
  private inflight: Promise<void> | undefined;
  private readonly google: GoogleConfig;
  private readonly rotator: Rotator;
  private readonly cacheFile: string | undefined;

  constructor(google: GoogleConfig, rotator: Rotator, cacheFile?: string) {
    this.google = google;
    this.rotator = rotator;
    this.cacheFile = cacheFile;
  }

  async loadCache(): Promise<void> {
    if (!this.cacheFile) return;
    const { data } = await readJson(this.cacheFile);
    if (Array.isArray(data.models) && data.models.length) {
      this.snapshot = { models: data.models as CatalogModel[], quotas: {} };
      this.fetchedAt = typeof data.fetchedAt === "number" ? data.fetchedAt : 0;
    }
  }

  refresh(): Promise<void> {
    this.inflight ??= (async () => {
      try {
        const snap = await this.rotator.withAccount((token, s) => fetchCatalog(this.google, token, s.account.projectId));
        if (snap.models.length) {
          this.snapshot = snap;
          this.fetchedAt = Date.now();
          if (this.cacheFile) await writeJsonAtomic(this.cacheFile, { fetchedAt: this.fetchedAt, models: snap.models }).catch(() => {});
        }
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  /** Waits for Google only when there is nothing to show yet; otherwise refreshes in the background. */
  async ensure(): Promise<void> {
    if (!this.snapshot.models.length) {
      await this.refresh();
      return;
    }
    if (Date.now() - this.fetchedAt > MAX_AGE_MS) this.refresh().catch(() => {});
  }

  get(id: string): CatalogModel | undefined {
    const lower = id.toLowerCase();
    return this.snapshot.models.find((m) => m.id.toLowerCase() === lower);
  }

  /** Catalog entry or sensible defaults, so an unlisted model still gets a request. */
  info(id: string): CatalogModel {
    return this.get(id) ?? { id, ...familyDefaults(id) };
  }
}
