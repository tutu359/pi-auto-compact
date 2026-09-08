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

在 Pi 里运行 `/auto-compact`，菜单三项：

1. **Compaction owner** — 谁负责自动压缩：
   - **This plugin (pi-auto-compact)**：插件接管，同时自动把 `settings.json` 里的 `compaction.enabled` 设为 `false`
   - **Pi built-in compaction**：用 Pi 原生压缩，插件自动停用（并设 `compaction.enabled` 为 `true`）
   - **Off (no auto compaction)**：两边都停
2. **Threshold** — 设置阈值（25–99，默认 70）
3. **Compaction model** — 选择压缩模型，从 Pi 当前可用的模型列表里直接选，或选第一项恢复用会话模型

选 owner 会直接改写 `~/.pi/agent/settings.json`，无需手动编辑。插件接管时，上下文用量超过阈值自动压缩并继续当前任务。

## 指定压缩模型（可选）

两种方式任选：

### 方式一：菜单配置（推荐）

在 Pi 里运行 `/auto-compact`，会先弹出设置菜单：

1. **Threshold** — 设置阈值（25–99，默认 70）
2. **Compaction model** — 选择压缩模型，从 Pi 当前可用的模型列表里直接选，或选第一项恢复用会话模型

### 方式二：手动编辑配置文件

编辑 `~/.pi/agent/config/pi-auto-compact/config.json`：

```json
{
  "autoCompactThreshold": 70,
  "compactionModel": {
    "provider": "google",
    "model": "gemini-2.5-pro",
    "thinkingLevel": "low"
  }
}
```

- `provider` / `model`：与 Pi 模型注册表一致（即 `/model` 列表里的 provider 和模型 id）。该模型需已在 Pi 中配置好认证（API key 或 OAuth）。
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
