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
    this.denied = 0; // Specific count for denied requests
    this.bytesTransferred = 0; // Note: Accurate tracking requires more complex stream monitoring
    this.requestStartTimes = new Map(); // Track start times for duration
  }

  // Consider using ctx.waitUntil for persisting metrics if needed
  // For simple counters, direct increment might be acceptable in Workers

  recordRequestStart(requestId) {
    this.requests++;
    this.requestStartTimes.set(requestId, performance.now());
  }

  recordRequestEnd(requestId, response) {
    const startTime = this.requestStartTimes.get(requestId);
    const duration = startTime ? performance.now() - startTime : 0;
    this.requestStartTimes.delete(requestId);
    // Approximating bytes transferred from content-length if available
    const length = response?.headers?.get('content-length');
    if (length && !isNaN(parseInt(length, 10))) {
        this.bytesTransferred += parseInt(length, 10);
    }
    // console.log(`Request ${requestId} duration: ${duration.toFixed(2)}ms`); // Optional logging
    return duration;
  }

  recordError(type = 'GENERAL') {
    this.errors++;
    // console.error(`Recorded Error: ${type}`); // Optional logging
  }

  recordDenied() {
      this.denied++;
  }

  getMetrics() {
    // Basic metrics snapshot
    return {
      requests: this.requests,
      errors: this.errors,
      denied: this.denied,
      // bytesTransferred: this.bytesTransferred, // Bytes calculation is approximate
      errorRate: (this.errors / this.requests) || 0,
      denialRate: (this.denied / this.requests) || 0,
      timestamp: new Date().toISOString()
    };
  }
}

// === Regex Cache ===
const regexCache = new Map();
function getCachedRegex(pattern, flags = 'g') {
  if (!pattern) return null; // Handle cases where regex ENV is not set
  const key = `${pattern}|${flags}`;
  if (!regexCache.has(key)) {
    try {
      regexCache.set(key, new RegExp(pattern, flags));
    } catch (e) {
      console.error(`Invalid regex pattern "${pattern}": ${e.message}`);
      // Decide how to handle invalid regex: throw, return null, or log and continue?
      // Returning null here to prevent crashing the worker on bad config.
      return null;
    }
  }
  return regexCache.get(key);
}

// === Configuration Validation ===
function validateConfig(env) {
  const requiredConfigs = ['PROXY_HOSTNAME']; // Base required config
  const missingConfigs = requiredConfigs.filter(key => !env[key]);

  if (missingConfigs.length > 0) {
    throw new ProxyError(
      `Missing required configurations: ${missingConfigs.join(', ')}`,
      500,
      'CONFIG_ERROR'
    );
  }

  // Validate regex patterns if they are provided
  const regexConfigs = [
    'PATHNAME_REGEX',
    'UA_WHITELIST_REGEX',
    'UA_BLACKLIST_REGEX',
    'IP_WHITELIST_REGEX',
    'IP_BLACKLIST_REGEX',
    'REGION_WHITELIST_REGEX',
    'REGION_BLACKLIST_REGEX'
  ];

  for (const configKey of regexConfigs) {
    if (env[configKey]) {
      try {
        new RegExp(env[configKey]); // Attempt to compile
      } catch (e) {
        // Log the error but don't necessarily block startup, maybe return a specific error later if used
        console.error(
          `Configuration Warning: Invalid regex in ${configKey}: ${e.message}. This rule might not function.`
        );
        // Optionally throw an error to enforce correct config:
        // throw new ProxyError(`Invalid regex in ${configKey}: ${e.message}`, 500, 'CONFIG_ERROR');
      }
    }
  }
  // Add validation for PROXY_PROTOCOL if needed (e.g., must be 'http' or 'https')
}

// === Helper Functions ===

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
        ...details
    };
    if (level === 'error') {
        console.error(JSON.stringify(logEntry));
    } else {
        console.log(JSON.stringify(logEntry));
    }
}

// Content types that might contain hostnames needing replacement
const REWRITABLE_CONTENT_TYPES = new Set([
  'application/json',
  'application/vnd.docker.distribution.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
  // Add other text-based types if needed, e.g., 'text/plain' for some error messages
]);

// === Stream Transformer for Hostname Replacement ===
function createHostnameReplacingStream(proxyHostname, originHostname) {
  const proxyHostnameRegex = getCachedRegex(`\\b${proxyHostname}\\b`, 'g');
  let buffer = '';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // Basic replacement - might split hostnames across chunks in rare cases
      // More robust handling would involve buffering until a complete potential match boundary
      const processedBuffer = buffer.replace(proxyHostnameRegex, originHostname);

      // Find the last newline or reasonable split point to avoid breaking mid-replacement
      const lastNewline = processedBuffer.lastIndexOf('\n');
      let output = processedBuffer;
      if (lastNewline !== -1 && buffer.length > 512) { // Process reasonably sized chunks
        output = processedBuffer.substring(0, lastNewline + 1);
        buffer = processedBuffer.substring(lastNewline + 1);
      } else if (buffer.length > 1024) { // Avoid unbounded buffer growth
          // If no newline found and buffer is large, just process most of it
          output = processedBuffer.substring(0, 800);
          buffer = processedBuffer.substring(800);
      } else {
        // Not enough data or no clear split point, keep buffering
        return; // Don't enqueue yet
      }

      if (output) {
        controller.enqueue(encoder.encode(output));
      }
    },
    flush(controller) {
      // Process any remaining data in the buffer
      const finalOutput = buffer.replace(proxyHostnameRegex, originHostname);
      if (finalOutput) {
        controller.enqueue(encoder.encode(finalOutput));
      }
    }
  });
}

// === Main Fetch Handler ===
const metrics = new Metrics(); // Global metrics instance

export default {
  async fetch(request, env, ctx) {
    const requestId = request.headers.get('cf-request-id') || crypto.randomUUID(); // Unique ID per request
    metrics.recordRequestStart(requestId);

    let response;
    try {
      // --- 1. Configuration ---
      // Validate config on first access (or ideally at worker startup if possible)
      // Basic validation happens here per request in this model
      validateConfig(env);

      const {
        PROXY_HOSTNAME: DEFAULT_PROXY_HOSTNAME = "registry-1.docker.io", // Default backend
        PROXY_PROTOCOL = "https",
        PATHNAME_REGEX,
        UA_WHITELIST_REGEX,
        UA_BLACKLIST_REGEX,
        URL302, // Redirect URL if blocked
        IP_WHITELIST_REGEX,
        IP_BLACKLIST_REGEX,
        REGION_WHITELIST_REGEX,
        REGION_BLACKLIST_REGEX,
        DEBUG = false, // Enable debug headers/logs
        // Consider adding: AUTH_PROXY_HOSTNAME, INDEX_PROXY_HOSTNAME
      } = env;

      const url = new URL(request.url);
      const originHostname = url.hostname; // The hostname clients use to access the worker
      const pathname = url.pathname;
      const clientIp = request.headers.get("cf-connecting-ip");
      const clientCountry = request.headers.get("cf-ipcountry");
      const userAgent = request.headers.get("user-agent") ?? "";

      // --- 2. Dynamic Backend Routing ---
      let PROXY_HOSTNAME = DEFAULT_PROXY_HOSTNAME;
      let IS_AUTH_REQUEST = false;

      // More robust routing based on Docker API paths
      if (pathname === '/v2/' || pathname === '/v2') {
           // Root ping - usually goes to registry
           PROXY_HOSTNAME = DEFAULT_PROXY_HOSTNAME;
      } else if (pathname.startsWith('/v2/') && (pathname.endsWith('/token') || pathname.includes('/auth'))) {
          // Explicit token/auth endpoints (might vary by registry)
          PROXY_HOSTNAME = env.AUTH_PROXY_HOSTNAME || "auth.docker.io"; // Use specific auth host if defined
          IS_AUTH_REQUEST = true;
      } else if (pathname.startsWith('/v1/search') || pathname.startsWith('/v2/_catalog')) {
          // Search or catalog endpoints
          PROXY_HOSTNAME = env.INDEX_PROXY_HOSTNAME || "index.docker.io"; // Use specific index host if defined
      }
      // Other /v2/ requests (manifests, blobs) go to DEFAULT_PROXY_HOSTNAME

      // --- 3. Access Control ---
      let denied = false;
      let denialReason = "";

      const pathnameRegex = getCachedRegex(PATHNAME_REGEX);
      const uaWhitelistRegex = getCachedRegex(UA_WHITELIST_REGEX);
      const uaBlacklistRegex = getCachedRegex(UA_BLACKLIST_REGEX);
      const ipWhitelistRegex = getCachedRegex(IP_WHITELIST_REGEX);
      const ipBlacklistRegex = getCachedRegex(IP_BLACKLIST_REGEX);
      const regionWhitelistRegex = getCachedRegex(REGION_WHITELIST_REGEX);
      const regionBlacklistRegex = getCachedRegex(REGION_BLACKLIST_REGEX);

      if (pathnameRegex && !pathnameRegex.test(pathname)) {
          denied = true; denialReason = "Pathname mismatch";
      }
      if (!denied && uaWhitelistRegex && !uaWhitelistRegex.test(userAgent)) {
          denied = true; denialReason = "UA not whitelisted";
      }
      if (!denied && uaBlacklistRegex && uaBlacklistRegex.test(userAgent)) {
          denied = true; denialReason = "UA blacklisted";
      }
      if (!denied && ipWhitelistRegex && !ipWhitelistRegex.test(clientIp)) {
          denied = true; denialReason = "IP not whitelisted";
      }
      if (!denied && ipBlacklistRegex && ipBlacklistRegex.test(clientIp)) {
          denied = true; denialReason = "IP blacklisted";
      }
      if (!denied && regionWhitelistRegex && !regionWhitelistRegex.test(clientCountry)) {
          denied = true; denialReason = "Region not whitelisted";
      }
      if (!denied && regionBlacklistRegex && regionBlacklistRegex.test(clientCountry)) {
          denied = true; denialReason = "Region blacklisted";
      }

      if (denied) {
        metrics.recordDenied();
        metrics.recordError('ACCESS_DENIED');
        log('warn', 'Access Denied', request, { reason: denialReason });
        if (URL302) {
          return Response.redirect(URL302, 302);
        } else {
          // Return 403 Forbidden - more appropriate than Nginx page for API clients
          return new Response("Access Denied: " + denialReason, { status: 403 });
        }
      }

      // --- 4. Construct Upstream Request ---
      const upstreamUrl = new URL(request.url);
      upstreamUrl.protocol = PROXY_PROTOCOL;
      upstreamUrl.hostname = PROXY_HOSTNAME;

      // Clone headers, set Host, potentially modify others
      const upstreamHeaders = new Headers(request.headers);
      upstreamHeaders.set('Host', PROXY_HOSTNAME);
      upstreamHeaders.set('X-Forwarded-Proto', url.protocol.slice(0, -1)); // Inform backend of original protocol
      if (clientIp) {
        upstreamHeaders.set('X-Forwarded-For', clientIp); // Standard proxy header
      }
      // Remove Cloudflare-specific headers before sending upstream? Optional.
      // upstreamHeaders.delete('cf-connecting-ip');
      // upstreamHeaders.delete('cf-ipcountry');
      // ... other cf-* headers

      // Replace origin hostname with proxy hostname in header values (e.g., Referer)
      const originHostnameRegex = getCachedRegex(`\\b${originHostname}\\b`, 'g');
      for (const [key, value] of upstreamHeaders) {
          if (originHostnameRegex && value.includes(originHostname)) {
              upstreamHeaders.set(key, value.replace(originHostnameRegex, PROXY_HOSTNAME));
          }
      }

      const upstreamRequest = new Request(upstreamUrl.toString(), {
        method: request.method,
        headers: upstreamHeaders,
        body: request.body, // Stream the body
        redirect: 'manual', // Handle redirects explicitly if needed, 'follow' is usually ok
      });

      // --- 5. Fetch from Upstream ---
      const startTime = performance.now();
      const upstreamResponse = await fetch(upstreamRequest, {
          // Set Cloudflare-specific options if needed, e.g., caching
          // cf: { cacheTtl: 3600 }
      });
      const fetchDuration = performance.now() - startTime;
      log('info', 'Upstream fetch complete', request, { backend: PROXY_HOSTNAME, status: upstreamResponse.status, durationMs: fetchDuration.toFixed(2) });

      // --- 6. Process Upstream Response ---
      const responseHeaders = new Headers(upstreamResponse.headers);

      // Replace proxy hostname with origin hostname in response headers (Location, etc.)
      const proxyHostnameRegex = getCachedRegex(`\\b${PROXY_HOSTNAME}\\b`, 'g');
      for (const [key, value] of responseHeaders) {
          if (proxyHostnameRegex && value.includes(PROXY_HOSTNAME)) {
              responseHeaders.set(key, value.replace(proxyHostnameRegex, originHostname));
          }
      }

      // Handle Docker authentication challenge header specifically
      const wwwAuthHeader = responseHeaders.get("www-authenticate");
      if (wwwAuthHeader) {
          // Example: Bearer realm="https://auth.docker.io/token",service="registry.docker.io"
          // We need to rewrite the realm URL if it points to the auth service
          const realmRegex = /realm="([^"]+)"/;
          const realmMatch = wwwAuthHeader.match(realmRegex);
          if (realmMatch && realmMatch[1]) {
              try {
                  const realmUrl = new URL(realmMatch[1]);
                  // If the realm points to the known auth host (or the one we routed to)
                  if (realmUrl.hostname === (env.AUTH_PROXY_HOSTNAME || "auth.docker.io")) {
                      realmUrl.protocol = url.protocol; // Match incoming protocol
                      realmUrl.hostname = originHostname; // Rewrite host to *our* hostname
                      const rewrittenHeader = wwwAuthHeader.replace(realmRegex, `realm="${realmUrl.toString()}"`);
                      responseHeaders.set("www-authenticate", rewrittenHeader);
                      log('info', 'Rewrote Www-Authenticate realm', request, { original: realmMatch[1], rewritten: realmUrl.toString() });
                  }
              } catch (e) {
                  log('warn', 'Failed to parse or rewrite realm URL in Www-Authenticate', request, { header: wwwAuthHeader, error: e.message });
              }
          }
      }


      // Add custom headers if needed
      responseHeaders.set('X-Proxy-Powered-By', 'Cloudflare-Worker');
      if (DEBUG) {
        responseHeaders.set('X-Debug-Backend-Host', PROXY_HOSTNAME);
        responseHeaders.set('X-Debug-Client-IP', clientIp ?? 'unknown');
        responseHeaders.set('X-Debug-Client-Country', clientCountry ?? 'unknown');
        // Optionally remove CSP in debug mode
        responseHeaders.delete('content-security-policy');
        responseHeaders.delete('content-security-policy-report-only');
      }

      // --- 7. Handle Response Body (Streaming) ---
      let responseBody = upstreamResponse.body; // Default to passthrough streaming

      const contentType = responseHeaders.get('content-type')?.split(';')[0].trim() ?? '';
      if (REWRITABLE_CONTENT_TYPES.has(contentType) && proxyHostnameRegex) {
        log('info', 'Applying hostname replacement stream', request, { contentType });
        responseBody = upstreamResponse.body.pipeThrough(
          createHostnameReplacingStream(PROXY_HOSTNAME, originHostname)
        );
      } else {
          log('info', 'Streaming response body directly', request, { contentType });
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
        metrics.recordRequestEnd(requestId, response);
        // Optional: Persist metrics if needed using ctx.waitUntil
        // ctx.waitUntil(sendMetricsToAnalytics(metrics.getMetrics()));
    }

    return response;
  },
};

// Helper for default Nginx page (kept for potential fallback use if needed)
// async function nginx() { ... } // Same as before
