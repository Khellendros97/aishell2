"""数据库管道：在服务器本机执行数据库客户端（mysql/postgres/clickhouse/redis）。

凭据由 AIShell 代管（系统钥匙串），脚本看不到也拿不到密码；只允许执行该连接
配置白名单内的命令（默认只读），白名单外抛 SdkError。
"""

from aishell.client import rpc


def connections(server_id):
    """服务器上启用中的数据库连接：[{id, name, kind, host, port, user, database, allowedCommands}]。

    kind 为 mysql / postgres / clickhouse / redis；allowedCommands 是该连接允许的命令首词白名单。
    """
    return rpc("db_list_connections", {"serverId": server_id})


def query(server_id, connection_id, command, timeout=None):
    """执行一条数据库命令，返回 {stdout, stderr, exitCode, timedOut}。

    - connection_id 取 connections() 返回的 id；
    - command 为单条 SQL 或单条 redis 命令，首词必须在连接白名单内
      （多条用分号拼接会被逐段校验，任何一段越界即整体拒绝）；
    - 连接目标恒为服务器本机（数据库只对 127.0.0.1 开放也天然可达）；
    - 输出中的凭据已由 AIShell 脱敏。
    """
    return rpc(
        "db_query",
        {"serverId": server_id, "connectionId": connection_id, "command": command},
        timeout=timeout,
    )
