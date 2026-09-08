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

## 与原版的差异

| 项目 | 原版 | 本版 |
| --- | --- | --- |
| 配置存储 | `@henryqw/pi-config-store`（原子写） | 直接读写 JSON 文件 |
| 压缩模型 | task-models 共享路由（primary/fallback） | 当前会话模型 |
| 依赖 | 2 个 henryqw 包 + pi 本体 | 仅 pi 本体 |
