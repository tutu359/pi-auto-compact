# pi-auto-compact（独立版）

Fork 自 [HenryQW/pi-harness](https://github.com/HenryQW/pi-harness) 的 `extensions/pi-auto-compact`，只保留上下文自动压缩功能，并移除了对 `@henryqw/pi-config-store` 和 `@henryqw/pi-task-models` 的依赖：

- 阈值直接存于 `~/.pi/agent/config/pi-auto-compact/config.json`（零依赖，原原子写改为普通写）
- 压缩始终使用当前会话模型（不再路由到共享的 "fast" 任务模型）

## 安装

```bash
pi install <本目录路径 或 你的 npm 包名>
```

在 `~/.pi/agent/settings.json` 中禁用 Pi 内置自动压缩：

```json
{
  "compaction": { "enabled": false }
}
```

重启 Pi。若设置未禁用内置压缩，本插件会拒绝激活并提示。

## 使用

运行 `/auto-compact` 设置阈值（25–99，默认 70）。上下文用量超过阈值时自动压缩，压缩后自动继续当前任务。

## 指定压缩模型（可选）

默认用当前会话模型压缩。想用别的大窗口模型或便宜模型专门跑压缩，编辑 `~/.pi/agent/config/pi-auto-compact/config.json`：

```json
{
  "autoCompactThreshold": 70,
  "compactionModel": {
    "provider": "google",
    "id": "gemini-2.5-pro",
    "thinkingLevel": "low"
  }
}
```

- `provider` / `id`：与 Pi 模型注册表一致（即 `/model` 列表里的 provider 和模型 id）。该模型需已在 Pi 中配置好认证（API key 或 OAuth）。
- `thinkingLevel`：可选，`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`。压缩任务建议 `low` 或 `off` 省钱。
- 模型不存在或认证不可用时，自动回退到当前会话模型并提示。
- 删除 `compactionModel` 字段即恢复用会话模型。改完重启 Pi 生效。

注意：压缩是把全部上下文发给压缩模型做总结，超大上下文（如 500K）要确认目标模型窗口装得下；便宜模型窗口不够时才会需要大窗口模型。

## 与原版的差异

| 项目 | 原版 | 本版 |
| --- | --- | --- |
| 配置存储 | `@henryqw/pi-config-store`（原子写） | 直接读写 JSON 文件 |
| 压缩模型 | task-models 共享路由（primary/fallback） | 内置的单一 `compactionModel` 配置，回退到会话模型 |
| 依赖 | 2 个 henryqw 包 + pi 本体 | 仅 pi 本体 |
