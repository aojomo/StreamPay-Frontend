/**
 * @jest-environment node
 *
 * Cursor pagination tests for GET /api/streams.
 *
 * The endpoint uses a composite cursor of (created_at, id) for stable
 * ordering across pages. This suite exercises edge cases:
 *   - Multiple streams with the same createdAt timestamp
 *   - Forward pagination across several pages
 *   - Malformed / invalid cursors
 *   - Cursor + status filter interaction
 *   - Cursor at the end of the list (no next page)
 *   - Empty cursor param (422)
 */

import { encodeCompositeCursor, getStore, resetDb } from "@/app/lib/db";
import { resetRateLimitStore, InMemoryRateLimitStore, setRateLimitStore } from "@/app/lib/rate-limit-store";
import { GET as listStreams, POST as createStream } from "@/app/api/streams/route";
import type { Stream } from "@/app/types/openapi";

const STELLAR_KEY = "GDSBCG3OKHCMMWS5EBH2X7XOYTJRWXN2YYQPCNS5OFBU4IDO4X7OFSQA";

function getRequest(query = ""): Request {
  return new Request(`http://localhost/api/streams${query}`);
}

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/streams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Seed streams with explicit timestamps for deterministic ordering.
 * Each entry receives `createdAt` in ascending order.
 * Returns the stream IDs in ascending (oldest-first) order.
 */
async function seedDeterministicStreams(
  count: number,
  baseTimestamp = "2026-06-01T00:00:00.000Z",
): Promise<string[]> {
  const base = new Date(baseTimestamp).getTime();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `stream-${crypto.randomUUID().slice(0, 8)}`;
    const createdAt = new Date(base + i * 1000).toISOString();
    const now = new Date().toISOString();
    const stream: Stream = {
      createdAt,
      id,
      nextAction: "start",
      rate: "50",
      recipient: STELLAR_KEY,
      schedule: "month",
      status: "draft",
      updatedAt: now,
      token: "XLM",
    };
    getStore().streamRepository.streams.set(id, stream);
    ids.push(id);
  }
  return ids;
}

/**
 * Seed streams with explicit timestamps for tie-breaking tests.
 * Timestamps should be in ascending order (oldest first).
 */
async function seedStreamsWithTimestamps(
  timestamps: string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const ts of timestamps) {
    const id = `stream-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const stream: Stream = {
      createdAt: ts,
      id,
      nextAction: "start",
      rate: "50",
      recipient: STELLAR_KEY,
      schedule: "month",
      status: "draft",
      updatedAt: now,
      token: "XLM",
    };
    getStore().streamRepository.streams.set(id, stream);
    ids.push(id);
  }
  return ids;
}

/** The in-memory store is seeded with 3 fixture streams. We clear those out
 *  so each test starts with a deterministic empty state.
 */
function clearFixtureStreams(): void {
  getStore().streamRepository.streams.clear();
}

let rateLimitStore: InMemoryRateLimitStore;

beforeEach(() => {
  resetDb();
  clearFixtureStreams();
  rateLimitStore = new InMemoryRateLimitStore(10_000);
  setRateLimitStore(rateLimitStore);
});

afterEach(() => {
  rateLimitStore.destroy();
});

afterAll(() => {
  resetRateLimitStore();
});

describe("GET /api/streams — composite cursor pagination", () => {
  it("returns nextCursor when there are more results", async () => {
    const ids = await seedDeterministicStreams(5);
    const res = await listStreams(getRequest("?limit=2"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.meta.hasNext).toBe(true);
    expect(body.meta.nextCursor).toEqual(expect.any(String));
    // First page returns the two oldest streams (deterministic timestamps)
    expect(body.data[0].id).toBe(ids[0]);
    expect(body.data[1].id).toBe(ids[1]);
  });

  it("paginates forward correctly with composite cursor", async () => {
    const ids = await seedDeterministicStreams(5);

    // Page 1 (no cursor → start of list)
    const res1 = await listStreams(getRequest("?limit=2"));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.data).toHaveLength(2);
    expect(body1.data[0].id).toBe(ids[0]);
    expect(body1.data[1].id).toBe(ids[1]);
    expect(body1.meta.hasNext).toBe(true);

    // Page 2 — use cursor from page 1
    const res2 = await listStreams(
      getRequest(`?limit=2&cursor=${encodeURIComponent(body1.meta.nextCursor)}`),
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.data).toHaveLength(2);
    expect(body2.data[0].id).toBe(ids[2]);
    expect(body2.data[1].id).toBe(ids[3]);
    expect(body2.meta.hasNext).toBe(true);

    // Page 3 — use cursor from page 2
    const res3 = await listStreams(
      getRequest(`?limit=2&cursor=${encodeURIComponent(body2.meta.nextCursor)}`),
    );
    expect(res3.status).toBe(200);
    const body3 = await res3.json();
    expect(body3.data).toHaveLength(1);
    expect(body3.data[0].id).toBe(ids[4]);
    expect(body3.meta.hasNext).toBe(false);
    expect(body3.meta.nextCursor).toBeNull();
  });

  it("returns null nextCursor when all results fit on one page", async () => {
    await seedDeterministicStreams(3);
    const res = await listStreams(getRequest("?limit=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(3);
    expect(body.meta.hasNext).toBe(false);
    expect(body.meta.nextCursor).toBeNull();
  });

  it("accepts a cursor that points past the last item (filter yields empty)", async () => {
    const ids = await seedDeterministicStreams(3);
    // A cursor pointing after the last stream should return an empty page
    const allStreams = Array.from(getStore().streamRepository.streams.values());
    const lastStream = allStreams[allStreams.length - 1];
    const futureCursor = encodeCompositeCursor(lastStream.createdAt, `zzzz-${lastStream.id}`);
    const res = await listStreams(
      getRequest(`?limit=10&cursor=${encodeURIComponent(futureCursor)}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(0);
    expect(body.meta.hasNext).toBe(false);
    expect(body.meta.nextCursor).toBeNull();
  });

  it("returns 422 for a malformed cursor", async () => {
    const res = await listStreams(getRequest("?cursor=not-valid-base64!!!"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_CURSOR");
  });

  it("returns 422 for an empty cursor param", async () => {
    const res = await listStreams(getRequest("?cursor="));
    expect(res.status).toBe(422);
  });

  it("paginates correctly when streams share the same createdAt timestamp", async () => {
    const sameTs = "2025-01-01T00:00:00.000Z";
    const ids = await seedStreamsWithTimestamps([sameTs, sameTs, sameTs, sameTs]);
    // Sort expected IDs by string comparison to match the route's tie-breaking sort
    const sortedIds = [...ids].sort((a, b) => a.localeCompare(b));

    const res1 = await listStreams(getRequest("?limit=2"));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.data).toHaveLength(2);
    // When timestamps tie, ordering is by id (ascending)
    expect(body1.data[0].id).toBe(sortedIds[0]);
    expect(body1.data[1].id).toBe(sortedIds[1]);
    expect(body1.meta.hasNext).toBe(true);

    // Page 2
    const res2 = await listStreams(
      getRequest(`?limit=2&cursor=${encodeURIComponent(body1.meta.nextCursor)}`),
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.data).toHaveLength(2);
    expect(body2.data[0].id).toBe(sortedIds[2]);
    expect(body2.data[1].id).toBe(sortedIds[3]);
    expect(body2.meta.hasNext).toBe(false);
    expect(body2.meta.nextCursor).toBeNull();
  });

  it("paginates correctly with status filter", async () => {
    // Create 4 streams with deterministic ordering
    const ids = await seedDeterministicStreams(4);
    // Activate every other stream (ids[0] and ids[2])
    const activeIds = [ids[0], ids[2]];
    const draftIds = [ids[1], ids[3]];
    const stream0 = getStore().streamRepository.streams.get(ids[0])!;
    stream0.status = "active";
    getStore().streamRepository.streams.set(ids[0], stream0);
    const stream2 = getStore().streamRepository.streams.get(ids[2])!;
    stream2.status = "active";
    getStore().streamRepository.streams.set(ids[2], stream2);

    // Query only active streams (limit=1)
    const res1 = await listStreams(getRequest("?status=active&limit=1"));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.data).toHaveLength(1);
    expect(body1.data[0].id).toBe(activeIds[0]);
    expect(body1.meta.hasNext).toBe(true);

    // Page 2 of active streams
    const res2 = await listStreams(
      getRequest(`?status=active&limit=1&cursor=${encodeURIComponent(body1.meta.nextCursor)}`),
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.data).toHaveLength(1);
    expect(body2.data[0].id).toBe(activeIds[1]);
    expect(body2.meta.hasNext).toBe(false);
    expect(body2.meta.nextCursor).toBeNull();
  });

  it("respects limit=1 pagination edge case", async () => {
    const ids = await seedDeterministicStreams(3);

    const res1 = await listStreams(getRequest("?limit=1"));
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.data).toHaveLength(1);
    expect(body1.data[0].id).toBe(ids[0]);
    expect(body1.meta.hasNext).toBe(true);

    const res2 = await listStreams(
      getRequest(`?limit=1&cursor=${encodeURIComponent(body1.meta.nextCursor)}`),
    );
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.data).toHaveLength(1);
    expect(body2.data[0].id).toBe(ids[1]);
    expect(body2.meta.hasNext).toBe(true);

    const res3 = await listStreams(
      getRequest(`?limit=1&cursor=${encodeURIComponent(body2.meta.nextCursor)}`),
    );
    expect(res3.status).toBe(200);
    const body3 = await res3.json();
    expect(body3.data).toHaveLength(1);
    expect(body3.data[0].id).toBe(ids[2]);
    expect(body3.meta.hasNext).toBe(false);
    expect(body3.meta.nextCursor).toBeNull();
  });
});
