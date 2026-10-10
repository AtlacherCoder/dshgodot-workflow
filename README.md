# dsh-godot-workflow

把 `$DSH_HOME/AGENTS.md` 里的 **Godot 工程开发工作流**做成本地 DSH 插件。

## 为什么

原来的做法把工作流放在 `~/.dsh/AGENTS.md`，它和项目链一起受 **65536 字节预算**约束，
且规则的语义是"**超预算时最宽泛的文件先被丢弃**" —— 也就是说工作流随时可能被
`ADD/AGENTS.md`（44 KB）挤掉，静默失效。

本插件走宿主的 `ctx.systemPrompt.section()`，**不占 AGENTS.md 预算**，因此不会被挤掉。

## 两个通道

| 通道 | 内容 | 何时在上下文里 |
|---|---|---|
| **常驻段落** `godot:workflow` | `.dsh/prompt/core.md`（~3 KB）：五条铁律 + 流程骨架 + 崩溃级硬约束 | 每个会话，始终在 |
| **技能** `godot-workflow` | `.dsh/skills/godot-workflow/SKILL.md`（~9.7 KB）：完整流程细则、硬约束全表、四类模板 | 按需 —— agent 用 `skill` 工具加载 |

排序锚点取 `systemPrompt.getSectionOrder("PLAN_POLICY") + 10`（=510），
排在 `PLAN_POLICY`(500) 之后、`TEAM_POLICY`(600) 之前；取不到锚点时回落 550。

## 安装

```sh
dsh plugin --profile web add link:/home/atlaslinux/PluginManager/dsh-godot-workflow
dsh --profile web --dump-config | grep -A2 godot-workflow   # 应看到 id: godot-workflow
```

`link:` 意味着改动源码即时生效，无需重新安装；但**插件内容在激活时读定**，
改 `.md` 后需要重启 `dsh web` 才会重新注入。

## 自检

```sh
node scripts/verify.mjs
node scripts/verify.mjs --against ~/.dsh/AGENTS.md   # 额外做正文漂移比对
```

31 项检查：文件在位、常驻核心体量与关键词、技能 frontmatter、入口导出、
补丁接线、以及与源 AGENTS.md 的行数/字数漂移。

## 修改内容

- `lib/index.js` —— 注册逻辑（零 npm 依赖，只用 Node 内置模块）
- `.dsh/prompt/core.md` —— 常驻核心，**改这里就是改每个会话的默认行为**
- `.dsh/skills/godot-workflow/SKILL.md` —— 完整版；由 `~/.dsh/AGENTS.md` 转换而来
- `scripts/verify.mjs` —— 自检

## 已知边界

- **异常不抛错**：DSH 启动是全有全无，一个插件激活失败会拖死整个 harness。
  因此本插件在文件缺失/损坏时只记 `error` 日志并降级（跳过该项），
  完整性由 `scripts/verify.mjs` 在安装/开发阶段把关。
- **不做**决策日志同步、回退件 `--check`、`godot_ping` 门禁 —— 这些仍由各工程里的
  `tools/` 脚本承担。
- 常驻核心实际 **3038 B**，比设计目标 ~2 KB 大；见 README 的"为什么"一节权衡说明。

## 回退

```sh
dsh plugin --profile web remove dsh-godot-workflow
```

这只是卸载插件，不动 `~/.dsh/AGENTS.md`（本轮刻意未改它）。
