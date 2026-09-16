"""仪表盘组件声明 —— 仅在项目的 .aishell/dashboard/dashboard.py 中使用。

AIShell 渲染仪表盘时经 py 工具通道执行该脚本，脚本用本模块声明组件，
组件树经 SDK 桥推送回 AIShell 渲染到侧栏「仪表盘」面板。

用法::

    from aishell import dashboard, servers, ssh

    dashboard.meta(refresh_seconds=30)  # 可选：声明自动刷新间隔

    dashboard.text("intro", "说明", "**关键链路** 均已纳管")
    dashboard.table(
        "load", "服务器负载",
        columns=[{"key": "name", "title": "服务器"}, {"key": "load", "title": "负载"}],
        rows=[{"name": s["name"], "load": "…"} for s in servers.list()],
    )

组件类型：text（markdown 文本块）/ table（只读表格）/ image（png/svg 等）/ chart（echarts）。
每声明一个组件即推送一帧（渐进渲染，面板边采集边出内容）；脚本结束未推送过时自动兜底。
"""

import atexit
import base64

from aishell import client as _client

_components = []
_meta = {}
_emitted = False


def _push():
    # 渐进渲染：每声明一个组件就把当前组件树推回 AIShell（本机回环，开销可忽略）；
    # 采集慢的组件放在后面声明，用户能先看到已完成的部分
    try:
        emit()
    except _client.SdkError:
        pass


def text(id, title, markdown):
    """markdown 文本块。"""
    _components.append({"type": "text", "id": id, "title": title, "markdown": str(markdown)})
    _push()


def table(id, title, columns, rows):
    """只读表格：columns 为 [{"key":…, "title":…}]，rows 为 dict 列表（按 key 取值）。"""
    _components.append({
        "type": "table",
        "id": id,
        "title": title,
        "columns": list(columns),
        "rows": list(rows),
    })
    _push()


def image(id, title, data, mime):
    """图片：data 为 bytes 或 base64 串，mime 如 image/png、image/svg+xml。"""
    if isinstance(data, (bytes, bytearray)):
        data = base64.b64encode(bytes(data)).decode("ascii")
    _components.append({"type": "image", "id": id, "title": title, "data": data, "mime": mime})
    _push()


def chart(id, title, option):
    """图表：option 为 echarts option 字典，前端按需引入折线/柱状/饼图渲染。"""
    _components.append({"type": "chart", "id": id, "title": title, "option": dict(option)})
    _push()


def meta(refresh_seconds=None):
    """仪表盘元信息：refresh_seconds 声明自动刷新间隔（秒），缺省不自动刷新。"""
    if refresh_seconds is not None:
        _meta["refreshSeconds"] = int(refresh_seconds)
        _push()


def emit():
    """把当前组件树推送回 AIShell（经 SDK 桥）；重复调用以最后一次为准。"""
    global _emitted
    _client.rpc("dashboard_emit", {"spec": {"meta": dict(_meta), "components": list(_components)}})
    _emitted = True


def _auto_emit():
    # 脚本未显式 emit 且声明了组件时兜底推送，避免新手漏写 emit 导致空白
    if not _emitted and (_components or _meta):
        try:
            emit()
        except _client.SdkError:
            pass


atexit.register(_auto_emit)
