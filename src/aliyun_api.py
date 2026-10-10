# -*- coding: utf-8 -*-
"""
阿里云 CDT 流量守护 - 阿里云接口封装
===================================
把 SDK 的调用、重试、IPv4 强制、SNI 补丁这些脏活统一收拢到这里。
业务脚本只调用几个语义化函数，不直接碰 SDK。
"""
import json
import socket
import time
import warnings

warnings.filterwarnings('ignore')

# ---------------------------------------------------------------------------
# 环境级补丁：必须在导入 SDK 之前完成
# ---------------------------------------------------------------------------
# 补丁 1：部分海外节点 IPv6 路由黑洞，强制只走 IPv4，避免请求永久挂起
_original_getaddrinfo = socket.getaddrinfo


def _getaddrinfo_ipv4_only(host, port, family=0, type=0, proto=0, flags=0):
    results = _original_getaddrinfo(host, port, family, type, proto, flags)
    ipv4 = [item for item in results if item[0] == socket.AF_INET]
    return ipv4 if ipv4 else results


socket.getaddrinfo = _getaddrinfo_ipv4_only

from aliyunsdkcore.client import AcsClient                          # noqa: E402
from aliyunsdkcore.request import CommonRequest                     # noqa: E402
from aliyunsdkecs.request.v20140526.StartInstanceRequest import StartInstanceRequest      # noqa: E402
from aliyunsdkecs.request.v20140526.StopInstanceRequest import StopInstanceRequest        # noqa: E402
from aliyunsdkecs.request.v20140526.RebootInstanceRequest import RebootInstanceRequest    # noqa: E402
from aliyunsdkecs.request.v20140526.DescribeInstancesRequest import DescribeInstancesRequest  # noqa: E402

# 补丁 2：Python 3.12 下 urllib3 会丢失 SNI，导致部分节点 TLS 握手被拒
try:
    from aliyunsdkcore.vendored.requests.packages.urllib3.util import ssl_
    ssl_.HAS_SNI = True
except Exception:
    pass

from common import redact  # noqa: E402

# CDT 流量接口固定走杭州接入点，某些海外地域直连会卡死
CDT_ENDPOINT = 'cdt.aliyuncs.com'
CDT_VERSION = '2021-08-13'
CDT_REGION = 'cn-hangzhou'

# 财务接口双端点（国内站 / 国际站）
BSS_ENDPOINTS = ('business.aliyuncs.com', 'business.ap-southeast-1.aliyuncs.com')
BSS_VERSION = '2017-12-14'

CONNECT_TIMEOUT_MS = 5000
READ_TIMEOUT_MS = 15000
RETRY_TIMES = 3
RETRY_DELAY = 2


class ApiError(Exception):
    """业务层可读的接口错误，保留原因供日志与告警展示。"""


def build_client(ak, sk, region):
    return AcsClient(ak, sk, region)


def _do(client, request, retries=RETRY_TIMES):
    """统一重试：只对瞬态错误重试，业务错误直接抛出。"""
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            return client.do_action_with_exception(request)
        except Exception as error:
            last_error = error
            if not _is_transient(error) or attempt >= retries:
                break
            time.sleep(RETRY_DELAY)
    raise ApiError(redact(last_error))


_TRANSIENT_MARKERS = (
    'connecttimeout', 'connect timeout', 'readtimeout', 'read timed out',
    'remote disconnected', 'remotedisconnected', 'ssl', 'max retries exceeded',
    'maxretryerror', 'connection aborted', 'connection reset', 'connection refused',
    'broken pipe', 'incomplete read', 'newconnectionerror', 'timed out',
)


def _is_transient(error):
    """识别被 SDK 层层包装过的网络类错误。"""
    pending, seen = [error], set()
    while pending:
        current = pending.pop()
        if not isinstance(current, BaseException) or id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, (ConnectionError, TimeoutError)):
            return True
        if any(marker in str(current).lower() for marker in _TRANSIENT_MARKERS):
            return True
        for attr in ('__cause__', '__context__', 'reason', 'original_error'):
            cause = getattr(current, attr, None)
            if isinstance(cause, BaseException):
                pending.append(cause)
    return False


def _common_request(domain, version, action, params=None):
    request = CommonRequest()
    request.set_domain(domain)
    request.set_version(version)
    request.set_action_name(action)
    request.set_method('POST')
    request.set_protocol_type('https')
    request.set_connect_timeout(CONNECT_TIMEOUT_MS)
    request.set_read_timeout(READ_TIMEOUT_MS)
    for key, value in (params or {}).items():
        request.add_query_param(key, value)
    return request


# ---------------------------------------------------------------------------
# 业务接口
# ---------------------------------------------------------------------------
def get_cdt_traffic_gb(ak, sk, region='cn-hangzhou'):
    """查询当月 CDT 公网出流量，单位 GB。查不到时抛 ApiError。"""
    client = build_client(ak, sk, CDT_REGION)
    request = _common_request(CDT_ENDPOINT, CDT_VERSION, 'ListCdtInternetTraffic')
    raw = _do(client, request)
    data = json.loads(raw.decode('utf-8'))
    total_bytes = sum(item.get('Traffic', 0) for item in data.get('TrafficDetails', []))
    return total_bytes / (1024 ** 3)


def get_instance_status(ak, sk, region, instance_id, resource_group=''):
    """查询实例状态，返回 Running / Stopped / Starting 等；找不到实例返回 None。"""
    client = build_client(ak, sk, region)
    request = DescribeInstancesRequest()
    request.set_protocol_type('https')
    request.set_connect_timeout(CONNECT_TIMEOUT_MS)
    request.set_read_timeout(READ_TIMEOUT_MS)
    request.set_InstanceIds(json.dumps([instance_id]))
    if resource_group:
        request.set_ResourceGroupId(resource_group)
    raw = _do(client, request)
    data = json.loads(raw.decode('utf-8'))
    instances = data.get('Instances', {}).get('Instance', [])
    if not instances:
        return None
    return instances[0].get('Status')


def get_instance_detail(ak, sk, region, instance_id, resource_group=''):
    """查询实例详情（状态 / 公网 IP / 规格），用于日报。"""
    client = build_client(ak, sk, region)
    request = DescribeInstancesRequest()
    request.set_protocol_type('https')
    request.set_connect_timeout(CONNECT_TIMEOUT_MS)
    request.set_read_timeout(READ_TIMEOUT_MS)
    request.set_InstanceIds(json.dumps([instance_id]))
    if resource_group:
        request.set_ResourceGroupId(resource_group)
    try:
        raw = _do(client, request)
    except ApiError:
        return {'status': 'NotFound', 'ip': 'N/A', 'spec': 'N/A'}

    data = json.loads(raw.decode('utf-8'))
    instances = data.get('Instances', {}).get('Instance', [])
    if not instances:
        return {'status': 'NotFound', 'ip': 'N/A', 'spec': 'N/A'}

    inst = instances[0]
    public_ips = inst.get('PublicIpAddress', {}).get('IpAddress', [])
    eip = inst.get('EipAddress', {}).get('IpAddress', '')
    ip = eip or (public_ips[0] if public_ips else '无公网IP')

    cpu = inst.get('Cpu', 0)
    mem_mb = inst.get('Memory', 0)
    mem = '%d' % (mem_mb / 1024) if mem_mb and mem_mb % 1024 == 0 else '%.1f' % (mem_mb / 1024.0)

    return {
        'status': inst.get('Status', 'Unknown'),
        'ip': ip,
        'spec': '%sC%sG' % (cpu, mem),
    }


def start_instance(ak, sk, region, instance_id):
    client = build_client(ak, sk, region)
    request = StartInstanceRequest()
    request.set_protocol_type('https')
    request.set_connect_timeout(CONNECT_TIMEOUT_MS)
    request.set_read_timeout(READ_TIMEOUT_MS)
    request.set_InstanceId(instance_id)
    return _do(client, request, retries=1)


def stop_instance(ak, sk, region, instance_id):
    client = build_client(ak, sk, region)
    request = StopInstanceRequest()
    request.set_protocol_type('https')
    request.set_connect_timeout(CONNECT_TIMEOUT_MS)
    request.set_read_timeout(READ_TIMEOUT_MS)
    request.set_InstanceId(instance_id)
    return _do(client, request, retries=1)


def reboot_instance(ak, sk, region, instance_id):
    client = build_client(ak, sk, region)
    request = RebootInstanceRequest()
    request.set_protocol_type('https')
    request.set_connect_timeout(CONNECT_TIMEOUT_MS)
    request.set_read_timeout(READ_TIMEOUT_MS)
    request.set_InstanceId(instance_id)
    return _do(client, request, retries=1)


def get_account_balance(ak, sk, region, bill_endpoint=''):
    """查询账户可用余额，返回 (金额, 货币代码)；失败返回 (None, None)。"""
    endpoints = [bill_endpoint] if bill_endpoint else []
    for endpoint in BSS_ENDPOINTS:
        if endpoint not in endpoints:
            endpoints.append(endpoint)

    client = build_client(ak, sk, region)
    for endpoint in endpoints:
        try:
            request = _common_request(endpoint, BSS_VERSION, 'QueryAccountBalance')
            raw = _do(client, request, retries=1)
            data = json.loads(raw.decode('utf-8'))
            if not data.get('Success'):
                continue
            info = data.get('Data') or {}
            raw_amount = info.get('AvailableAmount')
            if raw_amount is None:
                continue
            amount = float(str(raw_amount).replace(',', ''))
            return amount, info.get('Currency') or ''
        except Exception:
            continue
    return None, None


def get_instance_bill(ak, sk, region, instance_id, bill_endpoint=''):
    """查询该实例本月账单金额，返回 (金额, 货币代码)；失败返回 (-1, '')。"""
    client = build_client(ak, sk, region)
    params = {'BillingCycle': _billing_cycle(), 'InstanceID': instance_id}
    endpoint = bill_endpoint or 'business.ap-southeast-1.aliyuncs.com'
    try:
        request = _common_request('business.aliyuncs.com', BSS_VERSION,
                                  'DescribeInstanceBill', params)
        raw = _do(client, request, retries=1)
        data = json.loads(raw.decode('utf-8'))
        if data.get('Success'):
            items = data.get('Data', {}).get('Items', [])
            amount = sum(float(item.get('PretaxAmount', 0)) for item in items)
            currency = items[0].get('Currency', '') if items else ''
            return amount, currency
    except Exception:
        pass

    # 国际站回退到账单总览
    try:
        params2 = {'BillingCycle': _billing_cycle()}
        request2 = _common_request(endpoint, BSS_VERSION, 'QueryBillOverview', params2)
        raw2 = _do(client, request2, retries=1)
        data2 = json.loads(raw2.decode('utf-8'))
        items2 = data2.get('Data', {}).get('Items', {}).get('Item', [])
        amount = sum(float(item.get('PretaxAmount', 0)) for item in items2)
        currency = items2[0].get('Currency', '') if items2 else ''
        return amount, currency
    except Exception:
        return -1, ''


def _billing_cycle():
    from common import current_billing_cycle
    return current_billing_cycle()
