# Docker Registry Proxy

一个基于 Cloudflare Workers 的轻量级、高性能 Docker 镜像代理服务。它为 Docker Registry 提供稳定的代理访问，具有超时处理、指标收集、访问控制等功能。

## 功能特性

### 核心功能
- Docker Registry API v2 代理支持
- 自动处理 Registry、Auth、Search 服务
- 内置超时和错误处理
- 完整的访问控制系统
- 指标收集和监控

### 性能优化
- 基于 Cloudflare CDN
- 智能的缓存策略
- 连接超时优化
- 响应内容处理

### 安全特性
- 请求头清理和安全加固
- IP、地区、User-Agent 访问控制
- 详细的错误日志记录

## 快速开始

### 部署要求
- Cloudflare Workers 账号
- 已添加到 Cloudflare 的域名

### 安装步骤

1. 克隆项目
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
cp wrangler.toml.example wrangler.toml
```

4. 部署到 Cloudflare Workers
```bash
wrangler deploy
```

## 配置说明

### 必需配置
```toml
PROXY_HOSTNAME = "registry-1.docker.io"  # Docker Registry 主机名
PROXY_PROTOCOL = "https"                 # 代理协议
REQUEST_TIMEOUT = 60000                  # 请求超时时间（毫秒）
```

### 可选配置
```toml
# 访问控制
PATHNAME_REGEX = ""          # 路径过滤正则表达式
UA_WHITELIST_REGEX = ""      # User-Agent 白名单
UA_BLACKLIST_REGEX = ""      # User-Agent 黑名单
IP_WHITELIST_REGEX = ""      # IP 白名单
IP_BLACKLIST_REGEX = ""      # IP 黑名单
REGION_WHITELIST_REGEX = ""  # 地区白名单
REGION_BLACKLIST_REGEX = ""  # 地区黑名单

# 其他选项
DEBUG = false               # 调试模式
URL302 = ""                # 访问被拒绝时的重定向 URL
```

## 使用示例

### 基础配置示例
最小化配置，仅包含必需选项：
```toml
[vars]
PROXY_HOSTNAME = "registry-1.docker.io"
PROXY_PROTOCOL = "https"
REQUEST_TIMEOUT = 60000
```

### 访问控制配置示例
添加基本的访问控制：
```toml
[vars]
PROXY_HOSTNAME = "registry-1.docker.io"
PROXY_PROTOCOL = "https"
REQUEST_TIMEOUT = 60000
PATHNAME_REGEX = "^/v2/"
UA_WHITELIST_REGEX = "^docker/\\d+\\.\\d+\\.\\d+.*$"
IP_BLACKLIST_REGEX = "^(?:10|172\\.(?:1[6-9]|2\\d|3[01])|192\\.168)\\."
```

### 完整配置示例
包含所有可选功能的配置：
```toml
[vars]
# 基础配置
PROXY_HOSTNAME = "registry-1.docker.io"
PROXY_PROTOCOL = "https"
REQUEST_TIMEOUT = 60000

# 访问控制
PATHNAME_REGEX = "^/v2/"
UA_WHITELIST_REGEX = "^docker/\\d+\\.\\d+\\.\\d+.*$"
UA_BLACKLIST_REGEX = ""
IP_WHITELIST_REGEX = ""
IP_BLACKLIST_REGEX = ""
REGION_WHITELIST_REGEX = "^(US|EU)$"
REGION_BLACKLIST_REGEX = ""

# 其他选项
DEBUG = false
URL302 = "https://example.com/blocked"
```

## 监控与日志

### 可用指标
服务自动收集以下指标：
- 请求总数
- 错误数和错误率
- 超时数和超时率
- 传输字节数
- 请求处理时间

### 日志格式
正常请求日志：
```json
{
  "requestId": "uuid",
  "method": "GET",
  "url": "https://example.com/v2/...",
  "status": 200,
  "duration": 150,
  "userAgent": "docker/20.10.21",
  "clientIp": "1.2.3.4",
  "timestamp": "2024-10-25T10:00:00.000Z"
}
```

错误日志：
```json
{
  "requestId": "uuid",
  "message": "Request timeout",
  "type": "REQUEST_TIMEOUT",
  "statusCode": 504,
  "clientIp": "1.2.3.4",
  "userAgent": "docker/20.10.21",
  "url": "https://example.com/v2/...",
  "timestamp": "2024-10-25T10:00:00.000Z"
}
```

## 故障排除

### 常见问题

1. TLS 握手超时
```
问题：failed to do request: Head "xxx": net/http: TLS handshake timeout
解决：增加 REQUEST_TIMEOUT 值，建议设置为 60000（60秒）
```

2. 访问被拒绝
```
问题：Access denied
解决：检查访问控制配置，确保 IP、User-Agent 和地区设置正确
```

3. 代理连接失败
```
问题：Failed to connect to proxy host
解决：确认 PROXY_HOSTNAME 和 PROXY_PROTOCOL 配置正确
```

### 最佳实践

1. 超时设置
- 设置合理的请求超时时间（建议 60 秒）
- 生产环境建议启用重试机制

2. 访问控制
- 谨慎使用 IP 和地区限制
- 设置合适的 User-Agent 白名单

3. 安全建议
- 及时更新 Cloudflare Workers 运行时
- 定期检查访问日志
- 适当配置安全头

4. 性能优化
- 合理使用缓存配置
- 监控并优化慢请求
- 适时调整资源配置

## 许可证

[License Type] - 详见 LICENSE 文件

## 贡献指南

1. Fork 项目
2. 创建特性分支
3. 提交变更
4. 推送到分支
5. 创建 Pull Request

## 支持与帮助

如有问题，请提交 Issue 或通过以下方式获取帮助：
- 提交 Issue
- 查看 Wiki
- 参考示例配置

---
希望这个工具能帮助你更好地管理 Docker Registry 代理！