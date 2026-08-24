"""SDK 通道核心：环境变量读取 + 一次性 HTTP 桥的 JSON 调用封装（包内模块共用）。"""

import json
import os
import urllib.error
import urllib.request


class SdkError(RuntimeError):
    """AIShell SDK 调用失败（通道未就绪 / 鉴权失败 / 服务端拒绝等），消息为中文。"""


DEFAULT_TIMEOUT = 300  # 远程操作（大文件传输、慢查询）可能较久


def _endpoint():
    url = os.environ.get("AISHELL_SDK_URL", "").strip()
    token = os.environ.get("AISHELL_SDK_TOKEN", "").strip()
    if not url or not token:
        raise SdkError(
            "SDK 通道未就绪：缺少 AISHELL_SDK_URL/AISHELL_SDK_TOKEN 环境变量；"
            "aishell SDK 只能在 AIShell 的 py 工具执行的脚本中使用"
        )
    return url, token


def rpc(method, params=None, timeout=None):
    """调用 SDK 桥：成功返回 result，失败抛 SdkError（服务端中文错误原样抛出）。"""
    url, token = _endpoint()
    body = json.dumps({"method": method, "params": params or {}}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout or DEFAULT_TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # 服务端错误体也是 {ok:false,error} JSON，尽量取出中文原因
        try:
            payload = json.loads(e.read().decode("utf-8"))
            if isinstance(payload, dict) and payload.get("error"):
                raise SdkError(str(payload["error"])) from None
        except (ValueError, UnicodeDecodeError):
            pass
        raise SdkError(f"SDK 通道请求失败：HTTP {e.code}") from None
    except urllib.error.URLError as e:
        raise SdkError(f"SDK 通道连接失败：{e.reason}") from None
    if not isinstance(payload, dict):
        raise SdkError("SDK 通道返回格式异常")
    if payload.get("ok"):
        return payload.get("result")
    raise SdkError(str(payload.get("error") or "未知错误"))
