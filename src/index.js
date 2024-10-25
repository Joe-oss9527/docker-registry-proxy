// 错误处理
class ProxyError extends Error {
  constructor(message, statusCode, errorType) {
    super(message);
    this.name = 'ProxyError';
    this.statusCode = statusCode;
    this.errorType = errorType;
  }
}

// 指标收集增加超时统计
class Metrics {
  constructor() {
    this.requests = 0;
    this.errors = 0;
    this.timeouts = 0;
    this.bytesTransferred = 0;
    this.requestTimings = new Map();
    this.lastTimeoutTime = null;
  }

  recordTimeout() {
    this.timeouts++;
    this.lastTimeoutTime = Date.now();
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

  getMetrics() {
    return {
      requests: this.requests,
      errors: this.errors,
      timeouts: this.timeouts,
      bytesTransferred: this.bytesTransferred,
      errorRate: (this.errors / this.requests) || 0,
      timeoutRate: (this.timeouts / this.requests) || 0,
      lastTimeoutTime: this.lastTimeoutTime,
      timestamp: new Date().toISOString()
    };
  }
}

// 可靠的镜像列表
const DOCKER_MIRRORS = [
  "registry-1.docker.io",
  "mirror.gcr.io"
];

// 智能镜像选择
async function selectBestMirror() {
  const results = await Promise.all(
    DOCKER_MIRRORS.map(async mirror => {
      const start = Date.now();
      try {
        const response = await fetch(`https://${mirror}/v2/`, {
          method: 'HEAD',
          cf: {
            cacheTtl: 300,
            cacheEverything: true
          },
          timeout: 3000
        });
        return {
          mirror,
          latency: Date.now() - start,
          status: response.status
        };
      } catch (error) {
        return {
          mirror,
          latency: Infinity,
          error: true
        };
      }
    })
  );
  
  // 过滤并排序可用镜像
  const availableMirrors = results
    .filter(r => !r.error && r.status === 200)
    .sort((a, b) => a.latency - b.latency);
    
  // 如果没有可用镜像，返回默认镜像
  return availableMirrors[0]?.mirror || DOCKER_MIRRORS[0];
}

// 改进的重试逻辑
async function fetchWithRetry(request, timeout = 30000, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      // 第一次尝试使用原始超时，后续递增
      const currentTimeout = attempt === 1 ? timeout : timeout * 1.5;
      const timeoutId = setTimeout(() => controller.abort(), currentTimeout);
      
      const response = await fetch(request, {
        signal: controller.signal,
        cf: {
          cacheTtl: 300,
          cacheEverything: true,
          minify: true,
          polish: "lossy",
          retries: 2
        }
      });
      
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
      
      if (error.name === 'AbortError') {
        metrics.recordTimeout();
        console.warn(`Attempt ${attempt} timed out after ${timeout}ms`);
        
        if (attempt < maxRetries) {
          // 使用指数退避，但设置最大等待时间
          const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }
        
        throw new ProxyError(
          `Request timeout after ${maxRetries} attempts`,
          504,
          'REQUEST_TIMEOUT'
        );
      }
      
      throw error;
    }
  }
  
  throw lastError;
}

// 主处理函数
export default {
  async fetch(request, env, ctx) {
    const requestId = crypto.randomUUID();
    metrics.recordRequestStart(requestId);
    
    try {
      validateConfig(env);
      
      let {
        PROXY_HOSTNAME,
        PROXY_PROTOCOL = "https",
        PATHNAME_REGEX,
        REQUEST_TIMEOUT = 30000,
        MAX_RETRIES = 3,
        DEBUG = false
      } = env;
      
      // 如果没有指定代理主机名，使用智能镜像选择
      if (!PROXY_HOSTNAME) {
        PROXY_HOSTNAME = await selectBestMirror();
      }
      
      const url = new URL(request.url);
      const originHostname = url.hostname;

      // 特殊路径处理
      if (url.pathname.includes("/token")) {
        PROXY_HOSTNAME = "auth.docker.io";
      } else if (url.pathname.includes("/search")) {
        PROXY_HOSTNAME = "index.docker.io";
      }

      url.host = PROXY_HOSTNAME;
      url.protocol = PROXY_PROTOCOL;

      const newRequest = createNewRequest(request, url, PROXY_HOSTNAME, originHostname);
      
      // 使用改进的重试逻辑
      const originalResponse = await fetchWithRetry(newRequest, REQUEST_TIMEOUT, MAX_RETRIES);
      
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
      
      const errorResponse = {
        error: error.message,
        requestId,
        type: error.errorType || 'UNKNOWN_ERROR',
        retryAfter: error.errorType === 'REQUEST_TIMEOUT' ? 30 : undefined
      };
      
      return new Response(
        JSON.stringify(errorResponse),
        {
          status: error.statusCode || 500,
          headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': requestId,
            ...(error.errorType === 'REQUEST_TIMEOUT' ? {'Retry-After': '30'} : {})
          }
        }
      );
    }
  }
};