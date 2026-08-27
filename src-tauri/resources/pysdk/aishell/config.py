"""配置导入：项目（含服务器列表）、命令收藏、技能、笔记。

全部是 AIShell 本地配置的写盘操作（不触达远程服务器）：
- 服务器密码只进系统钥匙串（keyring），不会写入任何 JSON 配置；
- 同名/同条目去重语义见各函数文档；导入结果以 dict 返回，失败抛 SdkError。
"""

from aishell.client import rpc


def import_project(name, path=None, folder="", servers=None):
    """导入项目（可选携带服务器列表），返回 {projectId, name, path, existed, servers:[{id,name,host,created}]}。

    - name 必填；已存在同名项目时复用（并入服务器、保留原路径，existed=True）；
    - path 留空时在工作区目录下创建 <workspace>/<name>（含 .aishell/），返回的 path 为最终路径；
    - servers 每项：{name, host, username, port=22, authType="password"|"key",
      keyPath, password, locked=False, isBastion=False, bastion="<堡垒机名称>",
      tags=["细分标签", ...]}（tags 可选，字符串列表，供搜索框 #tag 筛选）；
      按 host+port+username 去重——已存在则复用其 id（created=False，传了 password 会更新凭据，
      tags 取并集合并，其余配置不动）；堡垒机绑定只对新建服务器生效，bastion 按服务器名称引用（本批或已有）。
    """
    params = {"name": name, "folder": folder or ""}
    if path:
        params["path"] = path
    if servers:
        params["servers"] = servers
    return rpc("import_project", params)


def import_commands(commands, project_id=None, project_name=None):
    """导入命令收藏到指定项目，返回 {projectId, projectName, added, skipped}。

    - commands 每项：{title, command, folder="", global=False}；
      title+command 与已有条目完全相同则跳过（skipped 计数）；
    - global=True 的命令在所有项目可见，但仍归属该项目（编辑/删除在原项目）；
    - project_id / project_name 二选一（命令收藏挂在项目记录上，无独立全局存储）。
    """
    if not project_id and not project_name:
        raise ValueError("import_commands 必须提供 project_id 或 project_name")
    params = {"commands": list(commands)}
    if project_id:
        params["projectId"] = project_id
    if project_name:
        params["projectName"] = project_name
    return rpc("import_commands", params)


def import_skill(content, origin="global", scope=None):
    """导入技能（content 为完整 SKILL.md 文本，含 frontmatter），
    返回 {name, origin, path, overwritten}。

    - origin="global"（默认）写入工作区全局技能根，"project" 写入当前项目技能根；
    - 同名技能已存在时整体覆盖 SKILL.md（overwritten=True，附属资源目录保留）；
    - scope 缺省时保留 content frontmatter 里声明的 scope。
    """
    params = {"content": content, "origin": origin}
    if scope is not None:
        params["scope"] = list(scope)
    return rpc("import_skill", params)


def import_note(path, content):
    """导入笔记到工作区全局 .aishell/notes，返回 {path}。

    - path 为笔记根内的相对路径（可用 / 分层，缺 .md 后缀自动补）；父目录自动创建；
    - 同名笔记整体覆盖；内容为 Markdown 文本。
    """
    return rpc("import_note", {"path": path, "content": content})
