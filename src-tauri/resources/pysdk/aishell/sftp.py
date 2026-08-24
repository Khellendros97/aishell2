"""SFTP：项目绑定服务器上的远程文件操作。

远程路径支持绝对路径（/ 开头）或相对服务器登录目录的相对路径。
写操作（write_text/upload/rename/delete/mkdir）在 AIShell 自动备份开启时会先保存
原始快照（可在「文件暂存区」面板 diff/还原）。
"""

from aishell.client import rpc


def list(server_id, path="."):
    """列出远端目录：[{name, isDir, size, mtime}]。"""
    return rpc("sftp_list", {"serverId": server_id, "path": path})


def stat(server_id, path):
    """远端条目属性：{exists, isDir, size, mtime}；不存在时 exists=False（不抛异常）。"""
    return rpc("sftp_stat", {"serverId": server_id, "path": path})


def read_text(server_id, path):
    """读取远端文本文件（UTF-8）。大文件（>5MB）/二进制/图片不支持，抛 SdkError。"""
    return rpc("sftp_read", {"serverId": server_id, "path": path})


def write_text(server_id, path, content):
    """写入远端文本文件（父目录不存在自动创建；目录目标拒绝）。返回落地说明字符串。"""
    return rpc("sftp_write", {"serverId": server_id, "path": path, "content": content})


def mkdir(server_id, path):
    """递归创建远端目录（已存在且是目录则跳过）。"""
    return rpc("sftp_mkdir", {"serverId": server_id, "path": path})


def rename(server_id, from_path, to_path):
    """远端重命名/移动（目标已存在会报错）。"""
    return rpc("sftp_rename", {"serverId": server_id, "from": from_path, "to": to_path})


def delete(server_id, path):
    """删除远端文件（仅文件；删除目录请用 ssh.exec 执行 rm -rf，先向用户说明影响）。"""
    return rpc("sftp_delete", {"serverId": server_id, "path": path})


def upload(server_id, local_path, remote_dir, overwrite=False):
    """上传本地文件/目录（目录递归）到远端目录。

    - local_path 必须在当前项目目录内；
    - overwrite=False 时远端同名自动创建副本（name (1).ext），返回的说明含落地文件名。
    """
    return rpc(
        "sftp_upload",
        {
            "serverId": server_id,
            "localPath": local_path,
            "remoteDir": remote_dir,
            "overwrite": bool(overwrite),
        },
    )


def download(server_id, remote_path, local_dir):
    """下载远端文件/目录（目录递归）到本地目录（必须在当前项目目录内且已存在）。"""
    return rpc(
        "sftp_download",
        {"serverId": server_id, "remotePath": remote_path, "localDir": local_dir},
    )
