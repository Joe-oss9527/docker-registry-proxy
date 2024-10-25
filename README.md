# Docker Registry Proxy

一个基于 Cloudflare Workers 的高性能 Docker 镜像代理服务，提供智能镜像源选择、自动重试、监控指标等功能。

## 功能特性

### 核心功能
- 支持 Docker Registry v2 API
- 智能镜像源选择和故障转移
- 自动重试机制和超时处理
- 完整的指标收集和监控
- 灵活的访问控制

### 性能优化
- Cloudflare CDN 集成
- 响应内容缓存
- 智能超时控制
- 指数退避重试策略

### 安全特性
- 请求头清理和安全加固
- 访问控制和过滤
- 详细的错误处理和日志记录

## 部署要求

- Cloudflare Workers 账号
- 域名已添加到 Cloudflare

## 快速开始

1. 克隆仓库
```bash
git clone <repository-url>
cd docker-registry-proxy
```

2. 安装依赖
```bash
npm install
```

3. 配置环境变量
```bash
cp .env.example .env
```

4. 部署到 Cloudflare Workers
```bash
wrangler deploy
```

## 环境变量配置

### 必需配置
```env
PROXY_HOSTNAME=registry-1.docker.io  # 默认 Docker Registry
PROXY_PROTOCOL=https                 # 代理协议
```

### 可选配置
```env
# 超时和重试设置
REQUEST_TIMEOUT=30000               # 请求超时时间（毫秒）
MAX_RETRIES=3                      # 最大重试次数

# 访问控制
PATHNAME_REGEX=                    # 路径过滤正则表达式
UA_WHITELIST_REGEX=                # User-Agent 白名单
UA_BLACKLIST_REGEX=                # User-Agent 黑名单
IP_WHITELIST_REGEX=                # IP 白名单
IP_BLACKLIST_REGEX=                # IP 黑名单
REGION_WHITELIST_REGEX=            # 地区白名单
REGION_BLACKLIST_REGEX=            # 地区黑名单

# 其他设置
DEBUG=false                        # 调试模式
URL302=                           # 重定向 URL
```

## 使用示例

### 基础配置
最小化配置示例：
```env
PROXY_HOSTNAME=registry-1.docker.io
PROXY_PROTOCOL=https
REQUEST_TIMEOUT=30000
MAX_RETRIES=3
```

### 访问控制配置
限制特定路径和用户代理的示例：
```env
PATHNAME_REGEX=^/v2/
UA_WHITELIST_REGEX=^docker/.+$
IP_BLACKLIST_REGEX=^(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.
```

## 监控和指标

服务提供以下监控指标：
- 请求总数
- 错误数和错误率
- 超时数和超时率
- 传输字节数
- 请求持续时间
- 最后超时时间

可通过日志查看这些指标：
```javascript
{
  "requests": 100,
  "errors": 5,
  "timeouts": 2,
  "bytesTransferred": 1048576,
  "errorRate": 0.05,
  "timeoutRate": 0.02,
  "timestamp": "2024-10-25T10:00:00.000Z"
}
```

## 故障排除

### 常见问题

1. 镜像拉取超时
```
错误：TLS handshake timeout
解决：增加 REQUEST_TIMEOUT 值，建议设置为 60000（60秒）
```

2. 频繁失败
```
错误：Request timeout after X attempts
解决：检查网络连接，增加 MAX_RETRIES 值
```

3. 访问被拒绝
```
错误：Access denied
解决：检查访问控制配置（IP、UA、Region 等）
```

### 建议配置

对于不稳定的网络环境：
```env
REQUEST_TIMEOUT=60000
MAX_RETRIES=5
```

对于生产环境：
```env
DEBUG=false
REQUEST_TIMEOUT=30000
MAX_RETRIES=3
```

## 最佳实践

1. 超时设置
   - 设置合理的初始超时时间（30-60秒）
   - 根据实际网络情况调整重试次数

2. 缓存优化
   - 利用 Cloudflare 的缓存功能
   - 对频繁访问的镜像启用缓存

3. 监控
   - 定期检查错误率和超时率
   - 设置适当的告警阈值

4. 安全性
   - 配置适当的访问控制
   - 定期更新安全配置

## 限制说明

- 仅支持 Docker Registry v2 API
- 需要 Cloudflare Workers 环境
- 部分功能依赖 Cloudflare 特性

## 贡献指南

欢迎提交 Issue 和 Pull Request。提交时请：
1. 清晰描述问题或改进
2. 提供必要的测试用例
3. 遵循现有代码风格

## 许可证

[License Type] - 详见 LICENSE 文件