// === Error Handling ===
class ProxyError extends Error {
  constructor(message, statusCode, errorType) {
    super(message);
    this.name = 'ProxyError';
    this.statusCode = statusCode;
    this.errorType = errorType;
  }
}

// === Metrics Collection ===
class Metrics {
  constructor() {
    this.requests = 0;
    this.errors = 0;
    this.denied = 0;
    this.bytesTransferred = 0; // Approximate
    this.requestStartTimes = new Map();
  }

  recordRequestStart(requestId) {
    this.requests++;
    this.requestStartTimes.set(requestId, performance.now());
  }

  recordRequestEnd(requestId, response) {
    const startTime = this.requestStartTimes.get(requestId);
    const duration = startTime ? performance.now() - startTime : 0;
    this.requestStartTimes.delete(requestId);
    const length = response?.headers?.get('content-length');
    if (length && !isNaN(parseInt(length, 10))) {
        this.bytesTransferred += parseInt(length, 10);
    }
    // Optional: Log duration
    // log('debug', `Request ${requestId} duration: ${duration.toFixed(2)}ms`, null);
    return duration;
  }

  recordError(type = 'GENERAL') {
    this.errors++;
    log('error', `Recorded Error: ${type}`, null);
  }

  recordDenied() {
      this.denied++;
  }

  // getMetrics() can be added if needed for analytics endpoint
}

// === Regex Cache ===
const regexCache = new Map();
function getCachedRegex(pattern, flags = 'g') {
  if (!pattern) return null;
  const key = `${pattern}|${flags}`;
  if (!regexCache.has(key)) {
    try {
      regexCache.set(key, new RegExp(pattern, flags));
    } catch (e) {
      console.error(`Invalid regex pattern "${pattern}": ${e.message}`);
      return null; // Prevent worker crash on bad config
    }
  }
  return regexCache.get(key);
}

// === Configuration Validation (Basic) ===
// More robust validation could be added
function validateConfig(env) {
  if (!env.PROXY_HOSTNAME) {
      throw new ProxyError('Missing required configuration: PROXY_HOSTNAME', 500, 'CONFIG_ERROR');
  }
  // Add checks for regex validity if needed, though getCachedRegex handles errors
}

// === Logging ===
function log(level, message, request, details = {}) {
    const logEntry = {
        level: level,
        message: message,
        timestamp: new Date().toISOString(),
        url: request?.url,
        method: request?.method,
        clientIp: request?.headers?.get("cf-connecting-ip"),
        country: request?.headers?.get("cf-ipcountry"),
        userAgent: request?.headers?.get("user-agent"),
        requestId: request?.headers?.get("cf-request-id"), // Log request ID
        ...details
    };
    if (level === 'error') {
        console.error(JSON.stringify(logEntry));
    } else if (level === 'warn') {
        console.warn(JSON.stringify(logEntry));
    } else {
        console.log(JSON.stringify(logEntry));
    }
}

// === Content Types for Body Rewriting ===
const REWRITABLE_CONTENT_TYPES = new Set([
  'application/json',
  'application/vnd.docker.distribution.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
  // Add 'text/plain' if needed for specific error messages
]);

// === Stream Transformer (Simplified Version) ===
// Replaces hostnames in text streams. Handles potential split matches simply.
function createSimpleHostnameReplacingStream(proxyHostname, originHostname) {
  const proxyHostnameRegex = getCachedRegex(`\\b${proxyHostname}\\b`, 'g');
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let bufferedChunk = ''; // Buffer partial chunks

  return new TransformStream({
    transform(chunk, controller) {
      bufferedChunk += decoder.decode(chunk, { stream: true });
      // Process buffer up to the last newline to avoid breaking mid-word/JSON easily
      let processUpToIndex = bufferedChunk.lastIndexOf('\n');
      if (processUpToIndex === -1 && bufferedChunk.length > 1024) {
          processUpToIndex = bufferedChunk.length - 128; // Process most if buffer grows large without newline
      }

      if (processUpToIndex !== -1) {
        let processChunk = bufferedChunk.substring(0, processUpToIndex + 1);
        bufferedChunk = bufferedChunk.substring(processUpToIndex + 1);
        try {
          const replacedText = processChunk.replace(proxyHostnameRegex, originHostname);
          controller.enqueue(encoder.encode(replacedText));
        } catch (e) {
          log('error', 'Error in simple transform stream chunk', null, { error: e.message });
          controller.enqueue(encoder.encode(processChunk)); // Pass original on error
        }
      }
      // Keep buffering if not enough data or no newline
    },
    flush(controller) {
      // Process any remaining data in the buffer
      try {
          const replacedText = bufferedChunk.replace(proxyHostnameRegex, originHostname);
          if (replacedText) {
              controller.enqueue(encoder.encode(replacedText));
          }
      } catch (e) {
          log('error', 'Error in simple transform stream flush', null, { error: e.message });
          if (bufferedChunk) {
              controller.enqueue(encoder.encode(bufferedChunk)); // Pass original on error
          }
      }
    }
  });
}

// === Main Fetch Handler ===
const metrics = new Metrics(); // Global metrics instance

export default {
  async fetch(request, env, ctx) {
    const requestId = request.headers.get('cf-request-id') || crypto.randomUUID();
    metrics.recordRequestStart(requestId);

    let response;
    const originUrl = new URL(request.url);
    const originHostname = originUrl.hostname;

    try {
      // --- 1. Configuration & Validation ---
      validateConfig(env); // Basic check

      const {
        PROXY_HOSTNAME: DEFAULT_PROXY_HOSTNAME, // Required, validated above
        PROXY_PROTOCOL = "https",
        AUTH_PROXY_HOSTNAME = "auth.docker.io",
        INDEX_PROXY_HOSTNAME = "index.docker.io",
        PATHNAME_REGEX,
        UA_WHITELIST_REGEX,
        UA_BLACKLIST_REGEX,
        URL302,
        IP_WHITELIST_REGEX,
        IP_BLACKLIST_REGEX,
        REGION_WHITELIST_REGEX,
        REGION_BLACKLIST_REGEX,
        DEBUG = false,
      } = env;

      // --- 2. Dynamic Backend Routing ---
      const pathname = originUrl.pathname;
      let PROXY_HOSTNAME = DEFAULT_PROXY_HOSTNAME;
      if (pathname.startsWith('/v2/') && (pathname.endsWith('/token') || pathname.includes('/auth'))) {
          PROXY_HOSTNAME = AUTH_PROXY_HOSTNAME;
      } else if (pathname.startsWith('/v1/search') || pathname.startsWith('/v2/_catalog')) {
          PROXY_HOSTNAME = INDEX_PROXY_HOSTNAME;
      }

      // --- 3. Access Control ---
      let denied = false;
      let denialReason = "";
      const clientIp = request.headers.get("cf-connecting-ip");
      const clientCountry = request.headers.get("cf-ipcountry");
      const userAgent = request.headers.get("user-agent") ?? "";

      const pathnameRegex = getCachedRegex(PATHNAME_REGEX);
      // ... (Get other regexes using getCachedRegex) ...
      const uaWhitelistRegex = getCachedRegex(UA_WHITELIST_REGEX);
      const uaBlacklistRegex = getCachedRegex(UA_BLACKLIST_REGEX);
      const ipWhitelistRegex = getCachedRegex(IP_WHITELIST_REGEX);
      const ipBlacklistRegex = getCachedRegex(IP_BLACKLIST_REGEX);
      const regionWhitelistRegex = getCachedRegex(REGION_WHITELIST_REGEX);
      const regionBlacklistRegex = getCachedRegex(REGION_BLACKLIST_REGEX);


      if (pathnameRegex && !pathnameRegex.test(pathname)) { denied = true; denialReason = "Pathname mismatch"; }
      if (!denied && uaWhitelistRegex && !uaWhitelistRegex.test(userAgent)) { denied = true; denialReason = "UA not whitelisted"; }
      if (!denied && uaBlacklistRegex && uaBlacklistRegex.test(userAgent)) { denied = true; denialReason = "UA blacklisted"; }
      if (!denied && ipWhitelistRegex && clientIp && !ipWhitelistRegex.test(clientIp)) { denied = true; denialReason = "IP not whitelisted"; }
      if (!denied && ipBlacklistRegex && clientIp && ipBlacklistRegex.test(clientIp)) { denied = true; denialReason = "IP blacklisted"; }
      if (!denied && regionWhitelistRegex && clientCountry && !regionWhitelistRegex.test(clientCountry)) { denied = true; denialReason = "Region not whitelisted"; }
      if (!denied && regionBlacklistRegex && clientCountry && regionBlacklistRegex.test(clientCountry)) { denied = true; denialReason = "Region blacklisted"; }

      if (denied) {
        metrics.recordDenied();
        metrics.recordError('ACCESS_DENIED');
        log('warn', 'Access Denied', request, { reason: denialReason });
        if (URL302) {
          return Response.redirect(URL302, 302);
        } else {
          return new Response("Access Denied: " + denialReason, { status: 403 });
        }
      }

      // --- 4. Construct Upstream Request ---
      const upstreamUrl = new URL(request.url);
      upstreamUrl.protocol = PROXY_PROTOCOL;
      upstreamUrl.hostname = PROXY_HOSTNAME;

      const upstreamHeaders = new Headers(request.headers);
      upstreamHeaders.set('Host', PROXY_HOSTNAME);
      upstreamHeaders.set('X-Forwarded-Proto', originUrl.protocol.slice(0, -1));
      if (clientIp) upstreamHeaders.set('X-Forwarded-For', clientIp);

      // Rewrite origin hostname -> proxy hostname in request headers (e.g., Referer)
      const originHostnameRegexForRequest = getCachedRegex(`\\b${originHostname}\\b`, 'g');
      for (const [key, value] of upstreamHeaders) {
          if (originHostnameRegexForRequest && value.includes(originHostname)) {
              upstreamHeaders.set(key, value.replace(originHostnameRegexForRequest, PROXY_HOSTNAME));
          }
      }

      const upstreamRequest = new Request(upstreamUrl.toString(), {
        method: request.method,
        headers: upstreamHeaders,
        body: request.body,
        // *** CRITICAL CHANGE: Use 'follow' based on user feedback ***
        redirect: 'follow',
      });

      // --- 5. Fetch from Upstream (Redirects Handled Automatically) ---
      log('info', 'Fetching upstream (redirect: follow)', request, { url: upstreamRequest.url, backend: PROXY_HOSTNAME });
      const upstreamResponse = await fetch(upstreamRequest);
      // upstreamResponse is now the FINAL response after redirects
      log('info', 'Upstream fetch complete (redirect: follow)', request, { backend: PROXY_HOSTNAME, status: upstreamResponse.status });

      // --- 6. Process Final Response Headers ---
      const responseHeaders = new Headers(upstreamResponse.headers);
      const proxyHostnameRegex = getCachedRegex(`\\b${PROXY_HOSTNAME}\\b`, 'g');

      // Rewrite proxy hostname -> origin hostname in final response headers
      for (const [key, value] of responseHeaders) {
          if (proxyHostnameRegex && value.includes(PROXY_HOSTNAME)) {
              responseHeaders.set(key, value.replace(proxyHostnameRegex, originHostname));
          }
      }

      // Specific Www-Authenticate rewrite for 401 responses (still needed)
      const wwwAuthHeader = responseHeaders.get("www-authenticate");
      if (wwwAuthHeader && upstreamResponse.status === 401) { // Check status too
          const realmRegex = /realm="([^"]+)"/;
          const realmMatch = wwwAuthHeader.match(realmRegex);
          if (realmMatch && realmMatch[1]) {
              try {
                  const realmUrl = new URL(realmMatch[1]);
                  const authHost = env.AUTH_PROXY_HOSTNAME || "auth.docker.io"; // Use configured auth host
                  if (realmUrl.hostname === authHost) {
                      realmUrl.protocol = originUrl.protocol; // Match incoming protocol
                      realmUrl.hostname = originHostname; // Rewrite host to *our* hostname
                      const rewrittenHeader = wwwAuthHeader.replace(realmRegex, `realm="${realmUrl.toString()}"`);
                      responseHeaders.set("www-authenticate", rewrittenHeader);
                      log('info', 'Rewrote Www-Authenticate realm in 401 response', request, { original: realmMatch[1], rewritten: realmUrl.toString() });
                  }
              } catch (e) {
                  log('warn', 'Failed to parse or rewrite realm URL in Www-Authenticate', request, { header: wwwAuthHeader, error: e.message });
              }
          }
      }

      // Add custom/debug headers
      responseHeaders.set('X-Proxy-Powered-By', 'Cloudflare-Worker-Refactored-Follow');
       if (DEBUG) {
        responseHeaders.set('X-Debug-Backend-Host', PROXY_HOSTNAME);
        responseHeaders.set('X-Debug-Final-Status', upstreamResponse.status.toString());
        // Optionally remove CSP in debug mode
        responseHeaders.delete('content-security-policy');
        responseHeaders.delete('content-security-policy-report-only');
      }

      // --- 7. Handle Final Response Body (Streaming) ---
      // No need for explicit 3xx check here, as redirects were followed.
      let responseBody = upstreamResponse.body; // Default to passthrough

      if (!upstreamResponse.body) {
          // Handle responses with no body (e.g., 204)
           log('info', 'Handling final response with no body', request, { status: upstreamResponse.status });
           responseBody = null;
      } else {
          // Apply streaming replacement if content type matches
          const contentType = responseHeaders.get('content-type')?.split(';')[0].trim() ?? '';
          if (REWRITABLE_CONTENT_TYPES.has(contentType) && proxyHostnameRegex) {
            log('info', 'Applying SIMPLE hostname replacement stream to final response', request, { contentType });
            responseBody = upstreamResponse.body.pipeThrough(
              createSimpleHostnameReplacingStream(PROXY_HOSTNAME, originHostname)
            );
          } else {
            log('info', 'Streaming final response body directly', request, { contentType });
          }
      }

      // --- 8. Construct Final Response ---
      response = new Response(responseBody, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      });

    } catch (error) {
      metrics.recordError('FETCH_EXCEPTION');
      log('error', `Proxy Error: ${error.message}`, request, { stack: error.stack, type: error.name });
      if (error instanceof ProxyError) {
        response = new Response(error.message, { status: error.statusCode });
      } else {
        response = new Response("Internal Server Error", { status: 500 });
      }
    } finally {
      // Record end metrics regardless of success or failure
      // Pass the final response object to recordRequestEnd
      if (response) { // Ensure response exists before accessing headers
           metrics.recordRequestEnd(requestId, response);
      } else {
           metrics.recordRequestEnd(requestId, null); // Or create a minimal Response object for error cases
      }
      // Optional: Persist metrics if needed using ctx.waitUntil
      // ctx.waitUntil(sendMetricsToAnalytics(metrics.getMetrics()));
    }

    return response;
  },
};
