import { WorkerLogger } from './logger.js';

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
    this.retries = 0;
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

  recordRetry() {
    this.retries++;
  }

  getMetrics() {
    return {
      requests: this.requests,
      errors: this.errors,
      timeouts: this.timeouts,
      retries: this.retries,
      bytesTransferred: this.bytesTransferred,
      errorRate: (this.errors / this.requests) || 0,
      timeoutRate: (this.timeouts / this.requests) || 0,
      retryRate: (this.retries / this.requests) || 0,
      timestamp: new Date().toISOString()
    };
  }
}

// 配置验证
function validateConfig(env, logger = null) {
  const requiredConfigs = ['PROXY_HOSTNAME'];
  const missingConfigs = requiredConfigs.filter(key => !env[key]);

  if (missingConfigs.length > 0) {
    const error = new ProxyError(
      `Missing required configurations: ${missingConfigs.join(', ')}`,
      500,
      'CONFIG_ERROR'
    );
    if (logger) logger.configError(error);
    throw error;
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
        if (logger) {
          logger.debug('config_validation', { 
            config, 
            status: 'valid',
            pattern: env[config] 
          });
        }
      } catch (e) {
        const error = new ProxyError(
          `Invalid regex in ${config}: ${e.message}`,
          500,
          'CONFIG_ERROR'
        );
        if (logger) logger.configError(error);
        throw error;
      }
    }
  }
}

// 简化创建新请求的函数
function createNewRequest(request, url, proxyHostname, originHostname) {
  const newRequestHeaders = new Headers(request.headers);
  for (const [key, value] of newRequestHeaders) {
    if (value.includes(originHostname)) {
      newRequestHeaders.set(
        key,
        value.replace(
          new RegExp(`(?<!\\.)\\b${originHostname}\\b`, "g"),
          proxyHostname
        )
      );
    }
  }
  
  // 确保SHA256格式正确（Docker blob请求）
  const finalUrl = url.toString();
  if (finalUrl.includes('/blobs/sha256:') && !isValidSHA256Path(finalUrl)) {
    throw new ProxyError('Invalid SHA256 format in blob request', 400, 'INVALID_SHA256');
  }
  
  return new Request(finalUrl, {
    method: request.method,
    headers: newRequestHeaders,
    body: request.body,
    redirect: 'follow'
  });
}

// 验证SHA256格式
function isValidSHA256Path(url) {
  const sha256Match = url.match(/\/blobs\/sha256:([a-f0-9]{64})(?:$|\/|\?)/);
  return sha256Match && sha256Match[1].length === 64;
}

// 简化响应头处理函数
function setResponseHeaders(
  originalResponse,
  proxyHostname,
  originHostname,
  DEBUG
) {
  const newResponseHeaders = new Headers(originalResponse.headers);
  for (const [key, value] of newResponseHeaders) {
    if (value.includes(proxyHostname)) {
      newResponseHeaders.set(
        key,
        value.replace(
          new RegExp(`(?<!\\.)\\b${proxyHostname}\\b`, "g"),
          originHostname
        )
      );
    }
  }
  
  if (DEBUG) {
    newResponseHeaders.delete("content-security-policy");
  }
  
  // 简化 Docker 认证 URL 处理
  let docker_auth_url = newResponseHeaders.get("www-authenticate");
  if (docker_auth_url && docker_auth_url.includes("auth.docker.io/token")) {
    newResponseHeaders.set(
      "www-authenticate",
      docker_auth_url.replace("auth.docker.io/token", originHostname + "/token")
    );
  }
  
  return newResponseHeaders;
}

// 简化响应内容处理函数
async function replaceResponseText(
  originalResponse,
  proxyHostname,
  pathnameRegex,
  originHostname
) {
  let text = await originalResponse.text();
  if (pathnameRegex) {
    pathnameRegex = pathnameRegex.replace(/^\^/, "");
    return text.replace(
      new RegExp(`((?<!\\.)\\b${proxyHostname}\\b)(${pathnameRegex})`, "g"),
      `${originHostname}$2`
    );
  } else {
    return text.replace(
      new RegExp(`(?<!\\.)\\b${proxyHostname}\\b`, "g"),
      originHostname
    );
  }
}

// Nginx 默认页面
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

// 简化主处理函数
export default {
  async fetch(request, env, ctx) {
    try {
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
      } = env;

      const url = new URL(request.url);
      const originHostname = url.hostname;
      
      // 初始化日志器
      const logger = new WorkerLogger();
      logger.requestStart(request);
      
      // 记录指标开始
      metrics.recordRequestStart(logger.getRequestId());
      
      // 设置全局 DEBUG 标志
      if (DEBUG) {
        globalThis.DEBUG = true;
      }
      
      // 验证配置
      try {
        validateConfig(env, logger);
      } catch (configError) {
        metrics.recordError();
        return new Response("Configuration Error", { status: 500 });
      }
      
      // 根据路径调整代理主机名
      const originalProxyHostname = PROXY_HOSTNAME;
      let routingReason = "default";
      
      if (url.pathname.includes("/token")) {
        PROXY_HOSTNAME = "auth.docker.io";
        routingReason = "token_endpoint";
      } else if (url.pathname.includes("/search")) {
        PROXY_HOSTNAME = "index.docker.io";
        routingReason = "search_endpoint";
      }
      
      logger.proxyRouting(originalProxyHostname, PROXY_HOSTNAME, routingReason);

      // 访问控制检查
      if (!PROXY_HOSTNAME ||
          (PATHNAME_REGEX && !new RegExp(PATHNAME_REGEX).test(url.pathname)) ||
          (UA_WHITELIST_REGEX &&
            !new RegExp(UA_WHITELIST_REGEX).test(
              request.headers.get("user-agent")?.toLowerCase() || ''
            )) ||
          (UA_BLACKLIST_REGEX &&
            new RegExp(UA_BLACKLIST_REGEX).test(
              request.headers.get("user-agent")?.toLowerCase() || ''
            )) ||
          (IP_WHITELIST_REGEX &&
            !new RegExp(IP_WHITELIST_REGEX).test(
              request.headers.get("cf-connecting-ip")
            )) ||
          (IP_BLACKLIST_REGEX &&
            new RegExp(IP_BLACKLIST_REGEX).test(
              request.headers.get("cf-connecting-ip")
            )) ||
          (REGION_WHITELIST_REGEX &&
            !new RegExp(REGION_WHITELIST_REGEX).test(
              request.headers.get("cf-ipcountry")
            )) ||
          (REGION_BLACKLIST_REGEX &&
            new RegExp(REGION_BLACKLIST_REGEX).test(
              request.headers.get("cf-ipcountry")
            ))
      ) {
        logger.accessDenied("access_control_failed", 
          request.headers.get("cf-connecting-ip"),
          request.headers.get("user-agent"),
          url.pathname
        );
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

      const targetUrl = url.toString();
      logger.proxyForward(targetUrl, PROXY_HOSTNAME);
      
      const newRequest = createNewRequest(request, url, PROXY_HOSTNAME, originHostname);
      const proxyStart = Date.now();
      
      const originalResponse = await fetch(newRequest);
      const proxyDuration = Date.now() - proxyStart;
      
      logger.proxyResponse(originalResponse, proxyDuration);
      
      // 记录错误响应的详细信息
      if (originalResponse.status >= 400) {
        logger.errorResponse(originalResponse, targetUrl);
        
        // 特别处理blob请求错误
        if (url.pathname.includes('/blobs/sha256:')) {
          logger.debug('blob_request_error', {
            originalUrl: request.url,
            targetUrl: targetUrl,
            sha256: url.pathname.match(/sha256:([a-f0-9]{64})/)?.[1] || 'invalid',
            status: originalResponse.status
          });
        }
      }
      
      const newResponseHeaders = setResponseHeaders(originalResponse, PROXY_HOSTNAME, originHostname, DEBUG);
      
      const contentType = newResponseHeaders.get("content-type") || "";
      let body;
      if (contentType.includes("text/")) {
        body = await replaceResponseText(originalResponse, PROXY_HOSTNAME, PATHNAME_REGEX, originHostname);
      } else {
        body = originalResponse.body;
      }

      // 记录指标
      const contentLength = parseInt(originalResponse.headers.get('content-length')) || 0;
      metrics.recordRequestEnd(logger.getRequestId(), contentLength);
      if (originalResponse.status >= 400) {
        metrics.recordError();
      }
      
      logger.requestComplete(originalResponse.status, PROXY_HOSTNAME);
      
      return new Response(body, {
        status: originalResponse.status,
        headers: newResponseHeaders,
      });
    } catch (error) {
      metrics.recordError();
      logger.requestError(error, request.url);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
