// Cloudflare Workers 日志模块
class WorkerLogger {
  constructor(requestId = null) {
    this.requestId = requestId || crypto.randomUUID();
    this.startTime = Date.now();
    this.logCount = 0;
    this.maxLogsPerRequest = 100; // 防止日志洪水
  }

  // 基础日志方法
  _log(level, event, data = {}) {
    // 防止日志洪水攻击
    if (this.logCount >= this.maxLogsPerRequest) {
      if (this.logCount === this.maxLogsPerRequest) {
        console.warn(JSON.stringify({
          timestamp: new Date().toISOString(),
          requestId: this.requestId,
          level: 'warn',
          event: 'log_limit_reached',
          message: 'Log limit reached, suppressing further logs',
          maxLogs: this.maxLogsPerRequest
        }));
        this.logCount++;
      }
      return;
    }
    
    this.logCount++;
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      requestId: this.requestId,
      level,
      event,
      ...data
    };

    // 根据日志级别选择合适的 console 方法
    switch (level) {
      case 'error':
        console.error(JSON.stringify(logEntry));
        break;
      case 'warn':
        console.warn(JSON.stringify(logEntry));
        break;
      case 'debug':
        console.debug(JSON.stringify(logEntry));
        break;
      default:
        console.log(JSON.stringify(logEntry));
    }
  }

  // 请求开始
  requestStart(request) {
    const url = new URL(request.url);
    // 脱敏 URL，避免记录敏感参数
    const safeUrl = `${url.protocol}//${url.host}${url.pathname}`;
    
    this._log('info', 'request_start', {
      method: request.method,
      url: safeUrl,
      pathname: url.pathname,
      clientIp: request.headers.get('cf-connecting-ip'),
      userAgent: request.headers.get('user-agent'),
      cfRay: request.headers.get('cf-ray'),
      referer: request.headers.get('referer'),
      // Cloudflare 特有字段
      cfCountry: request.headers.get('cf-ipcountry'),
      cfColo: request.headers.get('cf-colo')
    });
  }

  // 代理路由决策
  proxyRouting(originalHostname, selectedHostname, reason) {
    this._log('info', 'proxy_routing', {
      originalHostname,
      selectedHostname,
      routingReason: reason
    });
  }

  // 转发请求
  proxyForward(targetUrl, proxyHostname) {
    this._log('info', 'proxy_forward', {
      targetUrl,
      proxyHostname
    });
  }

  // 代理响应
  proxyResponse(response, duration) {
    this._log('info', 'proxy_response', {
      status: response.status,
      statusText: response.statusText,
      duration,
      contentType: response.headers.get('content-type'),
      contentLength: response.headers.get('content-length')
    });
  }

  // 错误响应详情
  errorResponse(response, targetUrl) {
    // 过滤敏感头信息
    const safeHeaders = {};
    for (const [key, value] of response.headers.entries()) {
      // 排除可能包含敏感信息的头
      if (!key.toLowerCase().includes('auth') && 
          !key.toLowerCase().includes('token') &&
          !key.toLowerCase().includes('secret')) {
        safeHeaders[key] = value;
      }
    }
    
    this._log('error', 'error_response', {
      status: response.status,
      statusText: response.statusText,
      headers: safeHeaders,
      targetUrl
    });
  }

  // 请求完成
  requestComplete(status, proxyHostname) {
    const totalDuration = Date.now() - this.startTime;
    this._log('info', 'request_complete', {
      status,
      totalDuration,
      proxyHostname
    });
  }

  // 请求错误
  requestError(error, url) {
    const totalDuration = Date.now() - this.startTime;
    
    // 生产环境可能需要限制堆栈信息
    const errorData = {
      error: error.message,
      errorName: error.name,
      totalDuration,
      url
    };
    
    // 仅在开发环境或调试模式下记录完整堆栈
    if (globalThis.DEBUG || error.name === 'ProxyError') {
      errorData.stack = error.stack;
    }
    
    this._log('error', 'request_error', errorData);
  }

  // 访问控制拒绝
  accessDenied(reason, clientIp, userAgent, pathname) {
    this._log('warn', 'access_denied', {
      reason,
      clientIp,
      userAgent,
      pathname
    });
  }

  // 配置错误
  configError(error) {
    this._log('error', 'config_error', {
      error: error.message,
      errorType: error.errorType
    });
  }

  // 获取请求ID
  getRequestId() {
    return this.requestId;
  }

  // 性能监控
  performance(operation, duration, metadata = {}) {
    this._log('info', 'performance', {
      operation,
      duration,
      ...metadata
    });
  }

  // 调试日志（仅在 DEBUG 模式下输出）
  debug(event, data = {}) {
    if (globalThis.DEBUG) {
      this._log('debug', event, data);
    }
  }

  // 创建子日志器（用于追踪相关操作）
  createChild(suffix = '') {
    const childId = suffix ? `${this.requestId}-${suffix}` : crypto.randomUUID();
    return new WorkerLogger(childId);
  }

  // 获取日志统计
  getStats() {
    return {
      requestId: this.requestId,
      logCount: this.logCount,
      uptime: Date.now() - this.startTime
    };
  }
}

export { WorkerLogger };