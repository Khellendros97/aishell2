---
name: python-script
description: 用 py 工具在本机执行 Python 脚本，并通过内置 aishell SDK 批量调用服务器能力（SSH 远程命令、SFTP 远程文件、数据库管道查询）。适合遍历多台服务器、批量传输、结果加工汇总等程序化场景。
scope:
  - all
enabled: true
---

# Python 脚本与 aishell SDK

py 工具在本机执行 Python 脚本（仅工作/全自动模式可用，执行前需用户审批；系统任务上下文中不含 aishell.config 配置写入的探查类脚本自动放行，无需等待批准）。脚本内 `import aishell` 即可调用 AIShell 代管的服务器能力：连接复用、锁定服务器拦截、数据库命令白名单、凭据代管都在 AIShell 端完成——**脚本拿不到任何密码**。

## 何时使用

- 遍历多台服务器执行同一命令并汇总结果；
- 批量上传/下载/整理远程文件；
- 查询数据库并对结果做加工（统计、格式化、落 CSV）；
- 需要循环、条件、文本处理等程序化逻辑的操作。

单次简单操作（一条命令、一次上传、一条 SQL）优先用专用工具：run_command / sftp_upload / sftp_download / db_query。

## py 工具参数

- `code`：内联 Python 脚本源码；与 `path` 二选一（恰传其一）。
- `path`：项目目录内的 .py 文件路径（相对项目根）；与 `code` 二选一。
- `args`：可选，传给脚本的命令行参数（脚本内读 `sys.argv[1:]`）。
- `timeoutSeconds`：可选，1–3600 秒，默认 60。

执行环境：工作目录 = 项目根目录；已强制 UTF-8 模式（PYTHONUTF8=1），print 中文不会乱码；脚本的 stdout/stderr 即工具结果（大输出会截断，保持简洁）。退出码非 0 时结果里会带退出码与 stderr，据此如实说明失败原因。

## aishell SDK 速查

```python
from aishell import servers, ssh, sftp, db
```

- `servers.list()` → `[{id, name, host, port, username, locked}]`：当前项目绑定的服务器。**先调它拿 serverId，不要凭空编造**；`locked=True` 的服务器无权操作。
- `ssh.exec(server_id, command, timeout=None)` → `{stdout, stderr, exitCode, timedOut}`：远程执行命令（按服务器默认 shell；前一次调用的 cd 不保留，需要工作目录时写 `cd /path && ...`）。timeout 秒，1–3600，默认 10。退出码非 0 不抛异常。
- `sftp.list(server_id, path=".")` → `[{name, isDir, size, mtime}]`
- `sftp.stat(server_id, path)` → `{exists, isDir, size, mtime}`（不存在时 exists=False，不抛异常）
- `sftp.read_text(server_id, path)` → 文本内容（限 5MB 内 UTF-8 文本）
- `sftp.write_text(server_id, path, content)`：写远端文件（父目录自动创建）
- `sftp.mkdir(server_id, path)` / `sftp.rename(server_id, from_path, to_path)` / `sftp.delete(server_id, path)`（delete 仅文件）
- `sftp.upload(server_id, local_path, remote_dir, overwrite=False)`：上传项目目录内的文件/目录（目录递归）；不重名覆盖时自动创建副本，返回的说明含落地文件名
- `sftp.download(server_id, remote_path, local_dir)`：下载到项目目录内**已存在**的目录
- `db.connections(server_id)` → `[{id, name, kind, host, port, user, database, allowedCommands}]`：启用中的数据库连接（kind：mysql/postgres/clickhouse/redis）
- `db.query(server_id, connection_id, command)` → `{stdout, stderr, exitCode, timedOut}`：经数据库管道在服务器本机执行客户端；command 首词必须在连接的 allowedCommands 白名单内（默认只读），越界抛错

远程路径：绝对路径（/ 开头）或相对服务器登录目录的相对路径，不支持盘符形态。
所有失败抛 `aishell.SdkError`（中文消息）；本地路径参数（upload 的源、download 的目标目录）必须在当前项目目录内。SDK 只能在 py 工具内使用，其它环境 import 调用会报「SDK 通道未就绪」。

## 配置导入（aishell.config）

`from aishell import config` —— 把外部配置批量导入 AIShell（本地写盘，不触达远程）：

- `config.import_project(name, path=None, folder="", servers=None)`：导入项目，可携带服务器列表。
  - path 留空时在工作区下创建 `<workspace>/<name>`；同名项目已存在则复用（并入服务器）。
  - folder 为项目所属目录（'/' 分隔的相对路径，如 "生产环境/Web"；空串 = 未分类），欢迎页按目录对项目分组。从其他 SSH 工具迁移配置时必须用它保留来源层级（如源工具的「生产/Web」目录 → folder="Xshell/生产"、name="Web"），不要把所有服务器塞进单个项目。
  - servers 每项 `{name, host, username, port=22, authType="password"|"key", keyPath, password, locked=False, isBastion=False, bastion="<堡垒机名称>"}`；按 host+port+username 去重复用已有服务器（created=False），password 只进系统钥匙串；bastion 按名称引用（只对新建服务器生效）。
  - 返回 `{projectId, name, path, existed, servers: [{id, name, host, created}]}`。
- `config.import_commands(commands, project_id=None, project_name=None)`：导入命令收藏到项目（project_id/project_name 二选一）。每项 `{title, command, folder="", global=False}`；title+command 完全相同则跳过。返回 `{projectId, projectName, added, skipped}`。
- `config.import_skill(content, origin="global", scope=None)`：导入技能，content 为完整 SKILL.md（含 frontmatter）；origin="project" 导入当前项目；同名覆盖（overwritten=True）。返回 `{name, origin, path, overwritten}`。
- `config.import_note(path, content)`：导入笔记到工作区 `.aishell/notes`；path 为相对路径（缺 .md 自动补，同名覆盖）。返回 `{path}`。

典型场景：用户给了一批服务器清单/命令清单/文档，让 AI 批量建项目、收藏命令、沉淀技能或笔记——用 py 工具跑一段脚本一次完成，而不是逐个手工配置。

```python
from aishell import config

r = config.import_project("电商生产环境", servers=[
    {"name": "生产-Web-01", "host": "47.102.1.10", "username": "deploy", "port": 22},
    {"name": "生产-DB-01", "host": "47.102.1.11", "username": "root", "bastion": "生产-Web-01"},
])
print(f'项目 {r["projectId"]}，服务器 {len(r["servers"])} 台')
config.import_commands(
    [{"title": "查看日志", "command": "tail -f /var/log/app.log", "global": True}],
    project_id=r["projectId"],
)
config.import_note("电商生产环境/概览", "# 电商生产环境\n\n- Web-01：应用入口（堡垒机）\n- DB-01：数据库\n")
```

从其他 SSH 工具迁移配置：按来源目录逐个建项目，统一挂到以工具名命名的目录下，保留原分组结构（源目录树由前置探查得到）：

```python
from aishell import config

# 键 = 源工具里的目录名，值 = 该目录下的会话；根目录未分组会话归入「未分组」
tree = {
    "浙江大学": [
        {"name": "服务器1", "host": "10.10.1.1", "username": "root"},
        {"name": "服务器2", "host": "10.10.1.2", "username": "root"},
    ],
    "山东大学": [
        {"name": "服务器3", "host": "10.20.1.1", "username": "admin"},
        {"name": "服务器4", "host": "10.20.1.2", "username": "admin"},
    ],
}
for group, servers in tree.items():
    r = config.import_project(group, folder="Xshell", servers=servers)
    print(f'{r["name"]}：服务器 {len(r["servers"])} 台（existed={r["existed"]}）')
# 多级目录把上级路径接进 folder：源结构「生产/Web」→ folder="Xshell/生产"
```

## 示例

批量查看多台服务器负载：

```python
from aishell import servers, ssh, SdkError

for s in servers.list():
    if s["locked"]:
        print(f'== {s["name"]}：已锁定，跳过')
        continue
    try:
        r = ssh.exec(s["id"], "uptime && df -h / | tail -1")
        print(f'== {s["name"]} ({s["host"]}) 退出码 {r["exitCode"]}')
        print(r["stdout"].strip())
    except SdkError as e:
        print(f'== {s["name"]}：失败 - {e}')
```

上传构建产物到服务器：

```python
from aishell import sftp

# 本地路径相对项目根；overwrite=True 覆盖远端同名文件
print(sftp.upload("SERVER_ID", "dist/app.tar.gz", "/opt/apps", overwrite=True))
```

查询数据库并落 CSV：

```python
import csv
from aishell import db

conns = db.connections("SERVER_ID")
conn = next(c for c in conns if c["kind"] == "mysql")
r = db.query("SERVER_ID", conn["id"], "SELECT id, name, created_at FROM users LIMIT 100")
if r["exitCode"] != 0:
    raise SystemExit(f'查询失败：{r["stderr"]}')
with open("users.csv", "w", newline="", encoding="utf-8") as f:
    csv.writer(f).writerows(line.split("\t") for line in r["stdout"].splitlines())
print("已写入 users.csv（项目根目录）")
```

## 约束（务必遵守）

- SDK 的数据库查询走连接白名单（默认只读）；不要试图绕过，也不要尝试读取任何密码/密钥——凭据由系统代管，输出中的「***已脱敏***」是正常现象。
- 批量远程写操作前，先向用户说明影响范围；自动备份开启时系统会自动快照原始文件（「文件暂存区」可还原）。
- 脚本只做任务需要的事；print 只输出关键结果，大段内容写文件而不是刷屏。
