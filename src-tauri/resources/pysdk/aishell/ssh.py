"""SSH：在项目绑定的服务器上执行命令（复用 AIShell 的 SSH 连接池，每服务器一条连接）。"""

from aishell.client import rpc


def exec(server_id, command, timeout=None):
    """在服务器上执行 shell 命令，返回 {stdout, stderr, exitCode, timedOut}。

    - server_id：servers.list() 返回的 id；
    - command：按目标服务器默认 shell 执行；前一次调用的 cd 不保留，需要工作目录时
      自己写 ``cd /path && ...``；
    - timeout：秒，1–3600，默认 10；
    - 退出码非 0 不抛异常（属正常结果）；连接失败/服务器锁定/命令为空抛 SdkError；
    - 输出中的凭据已由 AIShell 脱敏（显示为「***已脱敏***」）。
    """
    params = {"serverId": server_id, "command": command}
    if timeout is not None:
        params["timeoutSeconds"] = int(timeout)
    return rpc("ssh_exec", params, timeout=(int(timeout) + 30) if timeout else None)
