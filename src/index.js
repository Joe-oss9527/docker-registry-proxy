// 错误处理
class ProxyError extends Error {
  constructor(message, statusCode, errorType) {
    super(message);
    this.name = 'ProxyError';
    this.statusCode = statusCode;
    this.errorType = errorType;
  }
}

// 指标收集
class Metrics {
  constructor() {
    this.requests = 0;
    this.errors = 0;
    this.timeouts = 0;
    this.bytesTransferred = 0;
    this.requestTimings = new Map();
  }

  recordRequestStart(requestId) {
    this.requests++;
    this.requestTimings.set(requestId, Date.now());
  }

  recordRequestEnd(requestId, bytes = 0) {
    const startTime = this.requestTimings.get(requestId);
    const duration = startTime ? Date.now() - startTime : 0;
    this.bytesTransferred += bytes;
    this.requestTimings.delete(requestId);
    return duration;
  }

  recordError() {
    this.errors++;
  }

  recordTimeout() {
    this.timeouts++;
  }

  getMetrics() {
    return {
      requests: this.requests,
      errors: this.errors,
      timeouts: this.timeouts,
      bytesTransferred: this.bytesTransferred,
      errorRate: (this.errors / this.requests) || 0,
      timeoutRate: (this.timeouts / this.requests) || 0,
      timestamp: new Date().toISOString()
    };
  }
}

// 正则表达式缓存
const regexCache = new Map();
function getCachedRegex(pattern, flags = 'g') {
  const key = `${pattern}|${flags}`;
  if (!regexCache.has(key)) {
    regexCache.set(key, new RegExp(pattern, flags));
  }
  return regexCache.get(key);
}

// 配置验证
function validateConfig(env) {
  const requiredConfigs = ['PROXY_HOSTNAME'];
  const missingConfigs = requiredConfigs.filter(key => !env[key]);

  if (missingConfigs.length > 0) {
    throw new ProxyError(
      `Missing required configurations: ${missingConfigs.join(', ')}`,
      500,
      'CONFIG_ERROR'
    );
  }

  const regexConfigs = [
    'PATHNAME_REGEX',
    'UA_WHITELIST_REGEX',
    'UA_BLACKLIST_REGEX',
    'IP_WHITELIST_REGEX',
    'IP_BLACKLIST_REGEX',
    'REGION_WHITELIST_REGEX',
    'REGION_BLACKLIST_REGEX'
  ];

  for (const config of regexConfigs) {
    if (env[config]) {
      try {
        new RegExp(env[config]);
      } catch (e) {
        throw new ProxyError(
          `Invalid regex in ${config}: ${e.message}`,
          500,
          'CONFIG_ERROR'
        );
      }
    }
  }
}

// 处理响应内容
async function processResponseBody(response, proxyHostname, pathnameRegex, originHostname) {
  const contentType = response.headers.get('content-type') || '';
  
  if (!contentType.includes('text/')) {
    return response;
  }

  const text = await response.text();
  const regex = pathnameRegex ? 
    getCachedRegex(`((?<!\\.)\\b${proxyHostname}\\b)(${pathnameRegex.replace(/^\^/, "")})`) :
    getCachedRegex(`(?<!\\.)\\b${proxyHostname}\\b`);

  const replacedText = text.replace(
    regex,
    pathnameRegex ? `${originHostname}$2` : originHostname
  );

  return new Response(replacedText, {
    status: response.status,
    headers: response.headers
  });
}

// 安全头处理
function sanitizeHeaders(headers) {
  const sensitiveHeaders = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'];
  const newHeaders = new Headers(headers);
  
  for (const header of sensitiveHeaders) {
    newHeaders.delete(header);
  }
  
  newHeaders.set('X-Content-Type-Options', 'nosniff');
  newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  return newHeaders;
}

// 日志记录
function logError(request, error, requestId) {
  const errorInfo = {
    requestId,
    message: error.message,
    type: error.errorType || 'UNKNOWN_ERROR',
    statusCode: error.statusCode || 500,
    clientIp: request.headers.get("cf-connecting-ip"),
    userAgent: request.headers.get("user-agent"),
    url: request.url,
    timestamp: new Date().toISOString()
  };
  console.error(JSON.stringify(errorInfo));
}

function logRequest(request, requestId, duration, status) {
  console.log(JSON.stringify({
    requestId,
    method: request.method,
    url: request.url,
    status,
    duration,
    userAgent: request.headers.get('user-agent'),
    clientIp: request.headers.get('cf-connecting-ip'),
    timestamp: new Date().toISOString()
  }));
}

// 超时处理的fetch
async function fetchWithTimeout(request, timeout = 60000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(request, { 
      signal: controller.signal,
      cf: {
        cacheTtl: 300,
        cacheEverything: true,
        connectTimeout: 20,
        retries: 2
      }
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      metrics.recordTimeout();
      throw new ProxyError(
        `Request timeout after ${timeout}ms`,
        504,
        'REQUEST_TIMEOUT'
      );
    }
    throw error;
  }
}

// 创建新请求
function createNewRequest(request, url, proxyHostname, originHostname) {
  const newRequestHeaders = sanitizeHeaders(request.headers);
  for (const [key, value] of newRequestHeaders) {
    if (value.includes(originHostname)) {
      newRequestHeaders.set(
        key,
        value.replace(
          getCachedRegex(`(?<!\\.)\\b${originHostname}\\b`),
          proxyHostname
        )
      );
    }
  }
  return new Request(url.toString(), {
    method: request.method,
    headers: newRequestHeaders,
    body: request.body,
  });
}

// 设置响应头
function setResponseHeaders(
  originalResponse,
  proxyHostname,
  originHostname,
  DEBUG
) {
  const newResponseHeaders = sanitizeHeaders(originalResponse.headers);
  for (const [key, value] of newResponseHeaders) {
    if (value.includes(proxyHostname)) {
      newResponseHeaders.set(
        key,
        value.replace(
          getCachedRegex(`(?<!\\.)\\b${proxyHostname}\\b`),
          originHostname
        )
      );
    }
  }
  if (DEBUG) {
    newResponseHeaders.delete("content-security-policy");
  }
  let docker_auth_url = newResponseHeaders.get("www-authenticate");
  if (docker_auth_url && docker_auth_url.includes("auth.docker.io/token")) {
    newResponseHeaders.set(
      "www-authenticate",
      docker_auth_url.replace("auth.docker.io/token", originHostname + "/token")
    );
  }
  return newResponseHeaders;
}

async function nginx() {
  return `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body { width: 35em; margin: 0 auto;
font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>

<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>`;
}

// 全局指标实例
const metrics = new Metrics();

export default {
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();
    metrics.recordRequestStart(requestId);
    
    try {
      validateConfig(env);
      
      let {
        PROXY_HOSTNAME = "registry-1.docker.io",
        PROXY_PROTOCOL = "https",
        PATHNAME_REGEX,
        UA_WHITELIST_REGEX,
        UA_BLACKLIST_REGEX,
        URL302,
        IP_WHITELIST_REGEX,
        IP_BLACKLIST_REGEX,
        REGION_WHITELIST_REGEX,
        REGION_BLACKLIST_REGEX,
        DEBUG = false,
        REQUEST_TIMEOUT = 60000
      } = env;

      const url = new URL(request.url);
      const originHostname = url.hostname;

      // 设置正确的代理主机名
      if (url.pathname.includes("/token")) {
        PROXY_HOSTNAME = "auth.docker.io";
      } else if (url.pathname.includes("/search")) {
        PROXY_HOSTNAME = "index.docker.io";
      }

      // 访问控制检查
      if (
        !PROXY_HOSTNAME ||
        (PATHNAME_REGEX && !getCachedRegex(PATHNAME_REGEX).test(url.pathname)) ||
        (UA_WHITELIST_REGEX &&
          !getCachedRegex(UA_WHITELIST_REGEX).test(
            request.headers.get("user-agent")?.toLowerCase() || ''
          )) ||
        (UA_BLACKLIST_REGEX &&
          getCachedRegex(UA_BLACKLIST_REGEX).test(
            request.headers.get("user-agent")?.toLowerCase() || ''
          )) ||
        (IP_WHITELIST_REGEX &&
          !getCachedRegex(IP_WHITELIST_REGEX).test(
            request.headers.get("cf-connecting-ip")
          )) ||
        (IP_BLACKLIST_REGEX &&
          getCachedRegex(IP_BLACKLIST_REGEX).test(
            request.headers.get("cf-connecting-ip")
          )) ||
        (REGION_WHITELIST_REGEX &&
          !getCachedRegex(REGION_WHITELIST_REGEX).test(
            request.headers.get("cf-ipcountry")
          )) ||
        (REGION_BLACKLIST_REGEX &&
          getCachedRegex(REGION_BLACKLIST_REGEX).test(
            request.headers.get("cf-ipcountry")
          ))
      ) {
        logError(request, new ProxyError("Access denied", 403, "ACCESS_DENIED"), requestId);
        metrics.recordError();
        return URL302
          ? Response.redirect(URL302, 302)
          : new Response(await nginx(), {
              headers: {
                "Content-Type": "text/html; charset=utf-8",
              },
            });
      }

      url.host = PROXY_HOSTNAME;
      url.protocol = PROXY_PROTOCOL;

      const newRequest = createNewRequest(
        request,
        url,
        PROXY_HOSTNAME,
        originHostname
      );

      const originalResponse = await fetchWithTimeout(newRequest, REQUEST_TIMEOUT);
      
      const processedResponse = await processResponseBody(
        originalResponse.clone(),
        PROXY_HOSTNAME,
        PATHNAME_REGEX,
        originHostname
      );

      const newResponseHeaders = setResponseHeaders(
        processedResponse,
        PROXY_HOSTNAME,
        originHostname,
        DEBUG
      );

      const response = new Response(processedResponse.body, {
        status: processedResponse.status,
        headers: newResponseHeaders,
      });

      const duration = metrics.recordRequestEnd(requestId);
      logRequest(request, requestId, duration, response.status);

      return response;
    } catch (error) {
      metrics.recordError();
      metrics.recordRequestEnd(requestId);
      logError(request, error, requestId);
      return new Response(
        JSON.stringify({ 
          error: error.message,
          requestId 
        }),
        { 
          status: error.statusCode || 500,
          headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': requestId
          }
        }
      );
    }
  }
};