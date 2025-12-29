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
 * Simple cache for range request data
 */
export class ChunkCache implements RangeRequestCache {
  private chunks = new Map<number, Uint8Array>();
  private readonly chunkSize: number;

  constructor(chunkSize = 65536) {
    // 64KB default chunk size
    this.chunkSize = chunkSize;
  }

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

  set(offset: number, data: Uint8Array): void {
    const chunkIndex = Math.floor(offset / this.chunkSize);
    this.chunks.set(chunkIndex, data);
  }

  clear(): void {
    this.chunks.clear();
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
 * Fetch a range of bytes from a URL using synchronous XHR
 * Note: This uses deprecated synchronous XMLHttpRequest, which is necessary
 * for PDFium's synchronous callback interface until JSPI becomes widely available.
 *
 * @deprecated This function uses synchronous XHR which is deprecated. It will block
 * the main thread. Use with caution and only when necessary for progressive PDF loading.
 */
export function fetchRangeSync(
  url: string,
  offset: number,
  length: number,
  requestOptions?: PdfRequestOptions,
): Uint8Array {
  // Create synchronous XMLHttpRequest
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false); // false = synchronous

  // Set range header
  xhr.setRequestHeader('Range', `bytes=${offset}-${offset + length - 1}`);

  // Set custom headers if provided
  if (requestOptions?.headers) {
    Object.entries(requestOptions.headers).forEach(([key, value]) => {
      xhr.setRequestHeader(key, String(value));
    });
  }

  // Set credentials
  if (requestOptions?.credentials === 'include') {
    xhr.withCredentials = true;
  }

  // Set response type to arraybuffer
  xhr.responseType = 'arraybuffer';

  try {
    xhr.send();

    // Check for successful response (206 Partial Content or 200 OK)
    if (xhr.status === 206 || xhr.status === 200) {
      return new Uint8Array(xhr.response);
    } else {
      throw new Error(`Range request failed with status ${xhr.status}`);
    }
  } catch (error) {
    throw new Error(`Failed to fetch range: ${error}`);
  }
}

/**
 * Creates a range request loader with caching
 */
export function createRangeRequestLoader(
  url: string,
  fileSize: number,
  requestOptions?: PdfRequestOptions,
): {
  readBlock: (offset: number, length: number) => Uint8Array;
  cache: ChunkCache;
} {
  const cache = new ChunkCache();

  const readBlock = (offset: number, length: number): Uint8Array => {
    // Check cache first
    const cached = cache.get(offset, length);
    if (cached) {
      return cached;
    }

    // Fetch from server using synchronous request
    const data = fetchRangeSync(url, offset, length, requestOptions);

    // Store in cache
    cache.set(offset, data);

    return data;
  };

  return { readBlock, cache };
}
