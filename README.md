# NodeGet-StatusShow

A public page for real-time server status, resource monitoring, and infrastructure overview.

## 配置

页面启动时会读取 `public/config.json`。最小配置示例：

```json
{
  "site_name": "NodeGet Status",
  "site_tokens": [
    {
      "name": "main",
      "backend_url": "wss://your-nodeget.example.com",
      "token": "your-public-status-token"
    }
  ]
}
```

## 延迟显示

状态页会默认读取最近 60 分钟的 `tcp_ping` / `ping` 任务结果，并在卡片、表格和详情页展示延迟。需要 NodeGet 里已经为节点配置并运行 `tcp_ping` 或 `ping` 任务。

可选配置：

```json
{
  "latency": {
    "enabled": true,
    "type": "auto",
    "window_minutes": 60,
    "refresh_interval_ms": 30000
  }
}
```

如果不想展示延迟：

```json
{
  "latency": {
    "enabled": false
  }
}
```
