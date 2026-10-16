#!/usr/bin/env python3
"""生成不包含本机部署状态的可分享 ZIP。用法：python tools/pack_share.py 输出.zip"""
from pathlib import Path
import hashlib, re, sys, zipfile
ROOT = Path(__file__).resolve().parents[1]
FILES = ['README.md','分享版说明.md','部署指南.md','启动.bat','安装.ps1','诊断监控配置.bat','menu.sh','deploy.sh','configure.sh','diagnose-config.sh','lib-ui.sh','lib-kv.sh','lib-preflight.sh','wrangler.toml','package.json','package-lock.json','.gitignore']
def build(destination):
    files = [ROOT / name for name in FILES]
    for directory in ['src','tests','tools']:
        files += [p for p in (ROOT / directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix != '.pyc']
    entries = {}
    for path in sorted(files):
        rel = path.relative_to(ROOT).as_posix()
        raw = path.read_bytes()
        if rel == 'wrangler.toml':
            text = raw.decode('utf-8-sig')
            text = re.sub(r'(?m)^(\s*id\s*=\s*)"[^"]*"',r'\1""',text)
            text = re.sub(r'(?m)^\s*account_id\s*=.*\n?','',text)
            raw = text.encode('utf-8')
        if path.suffix == '.bat':
            raw = raw.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
        entries['cdt-guard-worker/' + rel] = raw
    # 部署指南里引用的 RAM 最小权限策略在仓库根目录 docs/ 下，一并放进包里
    policy = ROOT.parent / 'docs' / 'ram-policy-ecs-minimal.json'
    if policy.is_file():
        entries['cdt-guard-worker/docs/ram-policy-ecs-minimal.json'] = policy.read_bytes()
    destination = Path(destination).resolve()
    destination.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED) as z:
        for name, raw in entries.items():
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (0o100755 if name.endswith('.sh') else 0o100644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info,raw)
    with zipfile.ZipFile(destination) as z:
        assert z.testzip() is None
        assert set(z.namelist()) == set(entries)
        for name, raw in entries.items(): assert z.read(name) == raw
    sha = hashlib.sha256(destination.read_bytes()).hexdigest()
    destination.with_suffix(destination.suffix+'.sha256').write_text(sha+'  '+destination.name+'\n',encoding='utf-8')
    print(f'ZIP verified: {len(entries)} files, SHA256 {sha}')
if __name__ == '__main__':
    if len(sys.argv) != 2: raise SystemExit('Usage: python tools/pack_share.py OUTPUT.zip')
    build(sys.argv[1])
