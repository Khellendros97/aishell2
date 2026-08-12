---
name: skill-management
description: 管理 AIShell 全局与项目 Skill。用户要求创建、修改、启用、禁用、删除或解释 Skill 结构与作用域时使用。
scope:
  - all
enabled: true
---

# Skill instructions

你是 AIShell 的 Skill 管理员。Skill（技能）是 Markdown 文档，通过 frontmatter 元数据描述一个领域的能力与触发场景，由系统在每次会话启动时把「已启用」的 Skill 挂载给 AI（渐进式披露：正文按需读取，不常驻上下文）。本文件描述如何创建、编辑、启用、禁用与删除 Skill。

## 两个技能根目录

- 全局技能根：`{workspace_dir}/.aishell/skills/`（workspace_dir 为设置页配置的工作区目录）。
- 项目技能根：`{项目目录}/.aishell/skills/`（项目目录 = 项目配置的 path；未设置时回退 `{workspace_dir}/{项目名称}`）。

两者结构相同：每个技能占用一个目录 `<根>/<name>/SKILL.md`，名称必须与 frontmatter 的 `name` 一致。

## frontmatter schema

```yaml
---
name: my-skill
description: 说明该 Skill 的能力与触发场景。
scope:
  - all
enabled: true
---

# 正文
```

- `name`（必填，唯一）：只能是小写字母、数字与连字符（形如 `my-skill`），最长 64 字符；目录名必须与它一致。
- `description`（必填，唯一）：非空、最长 1024 字符；用于搜索与触发判断。
- `scope`（AIShell 自定义，可省略）：字符串数组，取值 `local`、`all` 或 `remote:<主机名称>`；省略或空数组按 `["all"]` 处理。主机名称使用界面展示的服务器名称（Server.name），不是地址。
- `enabled`（AIShell 自定义，可省略）：布尔值，省略按 `true`。`false` 时该 Skill 不会挂载给 AI。
- 允许存在其它未知字段与注释，系统忽略它们；重复的 name/description/scope/enabled 顶层键会导致校验失败。

## scope 语义

scope 只是「何时优先使用」的提示，不是权限，也不决定加载：`local` 对应当前工作区域为本地终端，`remote:<主机名称>` 对应当前工作区域为该名称的服务器，`all` 始终适用。只有 `enabled: true` 才决定 Skill 是否挂载给 AI；所有已启用 Skill 都会挂载，切换本地/远程工作区域不会增删挂载。

## 可选附属目录

`<name>/` 下除 `SKILL.md` 外可放 `scripts/`、`references/`、`assets/` 等附属资源，正文通过相对路径引用（如 `references/example.md`）。移动或重命名技能时这些资源随目录一起保留。

## 操作流程

1. 管理前先用 read 读取现有 `<name>/SKILL.md`，在原文基础上修改，不要凭空重建。
2. 新增：用 write 直接写 `<根>/<新名称>/SKILL.md`（write 会自动创建父目录），名称用小写字母、数字与连字符，frontmatter 必须包含 `name`、`description`，并建议显式写出 `scope` 与 `enabled`。
3. 编辑：用 edit 修改正文或 frontmatter；保持未知字段、注释与附属资源不动。修改 `scope` 时按上述 schema 重写整个数组。
4. 启用/禁用：把 frontmatter 顶层 `enabled` 改为 `true`/`false` 并保存即可。
5. 删除：仅删除用户明确指定的技能目录（用 delete_path 删除该 `<根>/<name>/` 目录；delete_path 仅在用户批准的工作/全自动模式下可用），删除前先说明目录路径与原因。
6. 修改完成后，系统会在下一条 AI 消息自动重新加载技能，无需额外操作。
