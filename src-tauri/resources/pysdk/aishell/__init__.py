"""AIShell Python SDK —— 在 AIShell 的 py 工具执行的脚本中调用 SSH / SFTP / 数据库管道能力。

仅可由 AIShell 注入环境变量（AISHELL_SDK_URL / AISHELL_SDK_TOKEN）的脚本进程使用；
脱离 py 工具运行时 import 本包并调用会抛 SdkError。

用法::

    from aishell import servers, ssh, sftp, db, config

    for s in servers.list():
        print(s["id"], s["name"], s["host"])

    r = ssh.exec("SERVER_ID", "uname -a")
    print(r["stdout"], r["exitCode"])

    # 配置导入：项目（含服务器）/命令收藏/技能/笔记
    config.import_project("我的项目", servers=[{"name": "web-1", "host": "1.2.3.4", "username": "root"}])

约定：
- serverId / connectionId 一律取 servers.list() / db.connections() 返回的 "id" 字段；
- 远程路径支持绝对路径（/ 开头）或相对服务器登录目录的相对路径，不支持盘符形态；
- 本 SDK 只发起调用，连接复用、锁定服务器拦截、数据库命令白名单等裁决都在 AIShell 端；
- 所有错误以 SdkError 抛出，消息为中文。
"""

from aishell import client as _client
from aishell import config, db, servers, sftp, ssh

SdkError = _client.SdkError

__all__ = ["servers", "ssh", "sftp", "db", "config", "SdkError"]
__version__ = "0.1.0"
