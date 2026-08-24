"""服务器清单：当前项目绑定的远程服务器。"""

from aishell.client import rpc


def list():
    """返回项目绑定的服务器列表：[{id, name, host, port, username, locked}]。

    locked=True 的服务器被用户锁定，AI/脚本无权执行远程操作（调用会返回「已锁定」错误）。
    """
    return rpc("list_servers")
