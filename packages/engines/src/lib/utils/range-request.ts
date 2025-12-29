import { PdfRequestOptions } from '@embedpdf/models';

export interface RangeRequestCache {
  get(offset: number, length: number): Uint8Array | null;
  set(offset: number, data: Uint8Array): void;
}

export interface RangeRequestCapability {
  supportsRangeRequests: boolean;
  fileSize: number;
}

/**
 * Cache for range request data with async prefetching support
 */
export class ChunkCache implements RangeRequestCache {
  private chunks = new Map<number, Uint8Array>();
  private pendingFetches = new Map<number, Promise<Uint8Array>>();
  private readonly chunkSize: number;
  private readonly url: string;
  private readonly fetcher: typeof fetch;
  private readonly requestOptions?: PdfRequestOptions;

  constructor(
    url: string,
    fetcher: typeof fetch,
    chunkSize = 65536,
    requestOptions?: PdfRequestOptions,
  ) {
    // 64KB default chunk size
    this.chunkSize = chunkSize;
    this.url = url;
    this.fetcher = fetcher;
    this.requestOptions = requestOptions;
  }

  /**
   * Get data from cache (synchronous)
   */
  get(offset: number, length: number): Uint8Array | null {
    const startChunk = Math.floor(offset / this.chunkSize);
    const endChunk = Math.floor((offset + length - 1) / this.chunkSize);

    // Check if all required chunks are available
    for (let i = startChunk; i <= endChunk; i++) {
      if (!this.chunks.has(i)) {
        return null;
      }
    }

    // Combine chunks to get the requested data
    const result = new Uint8Array(length);
    let resultOffset = 0;

    for (let i = startChunk; i <= endChunk; i++) {
      const chunk = this.chunks.get(i)!;
      const chunkStart = i * this.chunkSize;
      const chunkEnd = chunkStart + chunk.length;

      const copyStart = Math.max(offset, chunkStart) - chunkStart;
      const copyEnd = Math.min(offset + length, chunkEnd) - chunkStart;
      const copyLength = copyEnd - copyStart;

      result.set(chunk.subarray(copyStart, copyEnd), resultOffset);
      resultOffset += copyLength;
    }

    return result;
  }

  /**
   * Set data in cache
   */
  set(offset: number, data: Uint8Array): void {
    const chunkIndex = Math.floor(offset / this.chunkSize);
    this.chunks.set(chunkIndex, data);
  }

  /**
   * Prefetch a chunk asynchronously (non-blocking)
   */
  async prefetchChunk(chunkIndex: number, fileSize: number): Promise<void> {
    // Don't refetch if already cached or pending
    if (this.chunks.has(chunkIndex) || this.pendingFetches.has(chunkIndex)) {
      return;
    }

    const offset = chunkIndex * this.chunkSize;
    const end = Math.min(offset + this.chunkSize - 1, fileSize - 1);

    const fetchPromise = this.fetchRangeAsync(offset, end - offset + 1);
    this.pendingFetches.set(chunkIndex, fetchPromise);

    try {
      const data = await fetchPromise;
      this.chunks.set(chunkIndex, data);
      this.pendingFetches.delete(chunkIndex);
    } catch (error) {
      this.pendingFetches.delete(chunkIndex);
      console.error(`Failed to prefetch chunk ${chunkIndex}:`, error);
    }
  }

  /**
   * Prefetch multiple chunks in parallel
   */
  async prefetchRange(startOffset: number, endOffset: number, fileSize: number): Promise<void> {
    const startChunk = Math.floor(startOffset / this.chunkSize);
    const endChunk = Math.floor(endOffset / this.chunkSize);

    const promises: Promise<void>[] = [];
    for (let i = startChunk; i <= endChunk; i++) {
      promises.push(this.prefetchChunk(i, fileSize));
    }

    await Promise.all(promises);
  }

  /**
   * Fetch a range asynchronously using fetch API
   */
  private async fetchRangeAsync(offset: number, length: number): Promise<Uint8Array> {
    const response = await this.fetcher(this.url, {
      headers: {
        ...this.requestOptions?.headers,
        Range: `bytes=${offset}-${offset + length - 1}`,
      },
      credentials: this.requestOptions?.credentials,
    });

    if (response.status !== 206 && response.status !== 200) {
      throw new Error(`Range request failed with status ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  clear(): void {
    this.chunks.clear();
    this.pendingFetches.clear();
  }
}

/**
 * Check if server supports range requests for a given URL
 */
export async function checkRangeRequestSupport(
  url: string,
  fetcher: typeof fetch,
  requestOptions?: PdfRequestOptions,
): Promise<RangeRequestCapability> {
  try {
    const response = await fetcher(url, {
      method: 'HEAD',
      headers: requestOptions?.headers,
      credentials: requestOptions?.credentials,
    });

    const acceptRanges = response.headers.get('Accept-Ranges');
    const contentLength = response.headers.get('Content-Length');

    return {
      supportsRangeRequests: acceptRanges === 'bytes',
      fileSize: contentLength ? parseInt(contentLength, 10) : 0,
    };
  } catch (error) {
    // If HEAD request fails, assume no range support
    return {
      supportsRangeRequests: false,
      fileSize: 0,
    };
  }
}

/**
 * Creates a range request loader with async prefetching and caching
 * This loader prefetches the PDF header and initial chunks asynchronously,
 * avoiding main thread blocking.
 */
export async function createRangeRequestLoader(
  url: string,
  fileSize: number,
  fetcher: typeof fetch,
  requestOptions?: PdfRequestOptions,
): Promise<{
  readBlock: (offset: number, length: number) => Uint8Array;
  cache: ChunkCache;
  prefetchNextChunks: (currentOffset: number, lookahead?: number) => void;
}> {
  const cache = new ChunkCache(url, fetcher, 65536, requestOptions);

  // Prefetch critical PDF sections asynchronously (non-blocking)
  // 1. PDF header and initial structure (first 256KB)
  // 2. Cross-reference table is typically at the end (last 64KB)
  const prefetchPromises = [
    cache.prefetchRange(0, Math.min(256 * 1024, fileSize), fileSize), // First 256KB
  ];

  // Also prefetch last 64KB if file is large enough (for xref table)
  if (fileSize > 320 * 1024) {
    const endStart = Math.max(0, fileSize - 64 * 1024);
    prefetchPromises.push(cache.prefetchRange(endStart, fileSize, fileSize));
  }

  // Wait for initial prefetch to complete before opening document
  await Promise.all(prefetchPromises);

  // Callback for PDFium's m_GetBlock - returns cached data
  const readBlock = (offset: number, length: number): Uint8Array => {
    // Try to get from cache
    const cached = cache.get(offset, length);
    if (cached) {
      return cached;
    }

    // Data not in cache - this shouldn't happen often if prefetching is working well
    // Log a warning and return empty data to avoid blocking
    console.warn(
      `PDF chunk at offset ${offset} (length ${length}) not in cache. ` +
        `This may cause rendering issues. Consider increasing prefetch range.`,
    );

    // Return empty array to avoid blocking - PDFium will handle the missing data
    return new Uint8Array(0);
  };

  // Helper function to prefetch upcoming chunks based on current access pattern
  const prefetchNextChunks = (currentOffset: number, lookahead = 5) => {
    const chunkSize = 65536;
    const currentChunk = Math.floor(currentOffset / chunkSize);

    // Prefetch next N chunks asynchronously (fire and forget)
    for (let i = 1; i <= lookahead; i++) {
      cache.prefetchChunk(currentChunk + i, fileSize).catch((err) => {
        // Silently ignore prefetch errors - they're opportunistic
        console.debug(`Prefetch failed for chunk ${currentChunk + i}:`, err);
      });
    }
  };

  return { readBlock, cache, prefetchNextChunks };
}
