#!/usr/bin/env python3
"""Inventory actual worker executables and explicitly unsupported runtime modes."""
import importlib.util
import json
import shutil
import subprocess

probes = {
    'bash': ['--version'], 'git': ['--version'], 'gh': ['--version'],
    'python3': ['--version'], 'node': ['--version'], 'nuclei': ['-version'],
    'vulnx': ['version'], 'subfinder': ['-version'], 'dnsx': ['-version'],
    'httpx': ['-version'], 'naabu': ['-version'], 'katana': ['-version'],
    'tlsx': ['-version'], 'interactsh-client': ['-version'], 'nmap': ['--version'],
    'sqlmap': ['--version'], 'ffuf': ['-V'], 'semgrep': ['--disable-version-check', '--metrics', 'off', '--version'],
    'gitleaks': ['version'], 'trufflehog': ['--version'], 'hydra': ['-h'],
    'adb': ['version'], 'ssh': ['-V'], 'chisel': ['--version'],
    'kerbrute': ['version'], 'impacket-smbclient': ['-h'], 'nxc': ['--version'],
    'openvpn': ['--version'], 'wg': ['--version'], 'analyzeHeadless': ['-help'],
}
result = {}
for name, args in probes.items():
    path = shutil.which(name)
    version = None
    status = 'missing'
    if path:
        try:
            p = subprocess.run([path, *args], capture_output=True, text=True,
                               timeout=10 if name == 'semgrep' else 2)
            version = (p.stdout + p.stderr)[:512].strip()
            status = 'ok' if p.returncode == 0 else 'nonzero'
        except subprocess.TimeoutExpired:
            status = 'timeout'
        except OSError as error:
            status = 'error'
            version = str(error)
    result[name] = {'available': bool(path), 'path': path, 'probe': version,
                    'probe_status': status}
print(json.dumps({
    'tools': result,
    'python_modules': {'impacket': {'available': importlib.util.find_spec('impacket') is not None}},
    'network': {'external_scanners': False, 'vpn': False, 'task_owned_lab': True},
    'hardware': {'usb_devices': False},
    'optional': {'ghidra': 'unsupported: isolated profile requires verified build and operator file import',
                 'nxc': 'unavailable unless image explicitly provides it'},
}))
