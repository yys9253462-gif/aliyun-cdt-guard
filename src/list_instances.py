# -*- coding: utf-8 -*-
"""实例清单查询工具 —— 给安装脚本调用

用途：安装时把该 AccessKey 能看到的**所有地域**的 ECS 实例列出来，
让小白直接从列表里挑，不用自己去控制台抄地域代码和实例 ID。

调用方式（安装脚本里）：
    python list_instances.py <AK> <SK>
输出：每行一条 JSON，便于 shell 逐行解析：
    {"region":"ap-southeast-6","region_name":"菲律宾(马尼拉) ap-southeast-6","instance_id":"i-xxx","name":"web1","status":"Running"}

设计要点：
  - 地域清单来自 describe_regions()，**不是硬编码**，将来新增地域自动覆盖
  - 逐个地域查（DescribeInstances 必须指定 RegionId），并发跑省时间
  - 单个地域查失败不影响其他地域（权限受限/未开通都要能跳过）
"""
import json
import os
import sys
import concurrent.futures as cf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import aliyun_api  # noqa: E402

# 地域中文名映射（仅用于显示友好；查不到代码时直接显示代码，不影响功能）
REGION_CN = {
    'cn-hangzhou': '华东1(杭州)', 'cn-shanghai': '华东2(上海)',
    'cn-qingdao': '华北1(青岛)', 'cn-beijing': '华北2(北京)',
    'cn-zhangjiakou': '华北3(张家口)', 'cn-huhehaote': '华北5(呼和浩特)',
    'cn-wulanchabu': '华北6(乌兰察布)', 'cn-shenzhen': '华南1(深圳)',
    'cn-guangzhou': '华南3(广州)', 'cn-chengdu': '西南1(成都)',
    'cn-hongkong': '中国香港',
    'ap-southeast-1': '新加坡', 'ap-southeast-2': '澳大利亚(悉尼)',
    'ap-southeast-3': '马来西亚(吉隆坡)', 'ap-southeast-5': '印度尼西亚(雅加达)',
    'ap-southeast-6': '菲律宾(马尼拉)', 'ap-southeast-7': '泰国(曼谷)',
    'ap-southeast-8': '马来西亚(柔佛州)',
    'ap-northeast-1': '日本(东京)', 'ap-northeast-2': '韩国(首尔)',
    'us-west-1': '美国(硅谷)', 'us-east-1': '美国(弗吉尼亚)',
    'eu-central-1': '德国(法兰克福)', 'eu-west-1': '英国(伦敦)',
    'eu-west-2': '法国(巴黎)', 'me-east-1': '阿联酋(迪拜)',
    'me-central-1': '沙特(利雅得)', 'na-south-1': '墨西哥',
    'sa-east-1': '巴西(圣保罗)',
}


def region_label(rid):
    cn = REGION_CN.get(rid)
    return '%s %s' % (cn, rid) if cn else rid


def fetch_one(args):
    """查单个地域的实例；失败静默返回空列表，不影响整体。"""
    ak, sk, rid = args
    try:
        rows = aliyun_api.list_instances(ak, sk, rid)
        return rid, rows or []
    except Exception:
        return rid, []


def main():
    if len(sys.argv) < 3:
        sys.stderr.write('用法: list_instances.py <AK> <SK>\n')
        return 2

    ak, sk = sys.argv[1], sys.argv[2]

    # 1) 拿全部可用地域（接口返回，非硬编码）
    try:
        regions = aliyun_api.describe_regions(ak, sk)
    except Exception as e:
        sys.stderr.write('查询地域列表失败：%s\n' % aliyun_api.redact(e))
        return 1

    if not regions:
        sys.stderr.write('未获取到任何地域\n')
        return 1

    # 2) 并发查各地域的实例，提速
    found = []
    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        tasks = [(ak, sk, rid) for rid in regions]
        for rid, rows in pool.map(fetch_one, tasks):
            for row in rows:
                found.append({
                    'region': rid,
                    'region_name': region_label(rid),
                    'instance_id': row.get('instance_id', ''),
                    'name': row.get('instance_name', '') or '',
                    'status': row.get('status', ''),
                })

    # 3) 稳定排序后逐行输出 JSON
    found.sort(key=lambda x: (x['region'], x['instance_id']))
    for item in found:
        sys.stdout.write(json.dumps(item, ensure_ascii=False) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
