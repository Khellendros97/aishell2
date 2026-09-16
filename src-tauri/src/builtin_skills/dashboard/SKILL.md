---
name: dashboard
description: 定制项目仪表盘（侧栏「仪表盘」面板）。用户要求新增/修改仪表盘组件（监控服务器负载、展示图表、记录关键信息等）时使用；覆盖 dashboard.py 脚本写法、aishell.dashboard 组件 API、dashboard_reload/dashboard_view 调试工具。
scope:
  - all
enabled: true
---

# 项目仪表盘定制

每个项目的仪表盘 = `<项目根>/.aishell/dashboard/dashboard.py`。AIShell 渲染仪表盘时经 py 工具同款通道执行该脚本（SDK 环境变量已注入，脚本内直接 `from aishell import ...`，**不需要也不允许自己起连接**），脚本用 `aishell.dashboard` 声明组件，组件树自动推送渲染到侧栏「仪表盘」面板。

脚本可用 `servers / ssh / sftp / db` 全部 SDK 能力（用法见 python-script 技能），服务器锁定拦截、数据库命令白名单、凭据代管裁决不变——脚本拿不到任何密码。

## 定制工作流（调试循环）

1. `read` 现有 `.aishell/dashboard/dashboard.py`（不存在则说明是默认模板，可整体重写）；
2. 用 `write` / `edit` 修改脚本（仪表盘目录已加入写白名单）；
3. 调 `dashboard_reload` 执行脚本并重渲染——失败会返回退出码与 stderr 摘要，按它修正后重试；
4. 调 `dashboard_view` 核对组件树（类型/标题/表格行列数）是否符合需求；
5. 完成后用一句话向用户汇报组件构成与刷新方式。

## aishell.dashboard 组件 API

```python
from aishell import dashboard

dashboard.meta(refresh_seconds=30)          # 可选：声明自动刷新间隔（秒），面板可暂停
dashboard.text(id, title, markdown)         # markdown 文本块
dashboard.table(id, title, columns, rows)   # 只读表格：columns=[{"key":…,"title":…}]，rows=[{key:值}]
dashboard.image(id, title, data, mime)      # 图片：data 为 bytes 或 base64 串，mime 如 image/png、image/svg+xml
dashboard.chart(id, title, option)          # 图表：option 为 echarts option 字典（前端支持折线/柱状/饼图）
dashboard.emit()                            # 可选：显式推送；脚本结束未调用会自动兜底推送
```

- 组件按声明顺序渲染；`id` 在组件间唯一，标题展示在组件头部。
- **渐进渲染**：每声明一个组件面板就立即显示它，不用等脚本跑完——采集快、信息重要的组件放前面声明，耗时采集（多台服务器串行 exec）放后面，用户能先看到已完成的部分。
- **备忘录组件固定在最顶部**：顶部是可编辑表格（数据存 `.aishell/dashboard/table.json`，用户记账号/密码等关键信息），下方是备忘文本（`.aishell/dashboard/memo.md`），均可在面板上直接编辑；脚本无法删除它。需要程序化维护这些信息时直接读写 table.json（{"columns":[{"key","title"}],"rows":[{key:值}]}）与 memo.md（都在写白名单内）。
- chart 的 option 直接透传 echarts：折线 `{"xAxis": {"type": "category", "data": [...]}, "yAxis": {"type": "value"}, "series": [{"type": "line", "data": [...]}]}`；柱状/饼图同理（series type 用 bar/pie，前端已按需注册这三类）。

## 示例：服务器负载监控表格

```python
from aishell import dashboard, servers, ssh

dashboard.meta(refresh_seconds=30)

rows = []
for s in servers.list():
    if s["locked"]:
        continue
    r = ssh.exec(s["id"], "uptime | awk -F'load average:' '{print $2}'")
    rows.append({"name": s["name"], "load": r["stdout"].strip() or "—"})

dashboard.table(
    "load", "服务器负载",
    columns=[{"key": "name", "title": "服务器"}, {"key": "load", "title": "1/5/15 分钟负载"}],
    rows=rows,
)
```

## 约束

- 脚本 60 秒超时：采集逻辑要轻，多台服务器串行采集注意总量；单台超时用 `ssh.exec(..., timeout=10)` 卡住上限。
- 表格只读（用户不能编辑）；需要用户维护的信息放备忘录（memo.md）。
- 图片用 base64（svg 可直接传源码串，mime 用 image/svg+xml）。
- 脚本的 print 输出不会进入仪表盘（组件走 dashboard.emit 推送），print 仅用于 dashboard_reload 报错时排查。
- 单台服务器采集失败不要拖垮整个脚本：try/except 跳过并在行内标注「采集失败」。
