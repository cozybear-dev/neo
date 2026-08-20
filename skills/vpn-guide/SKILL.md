---
name: vpn-guide
description: 'When and how to use WireGuard or OpenVPN from the sandbox for authorized labs.'
---

# VPN

Use a VPN only when the engagement provides a config and the target is otherwise unreachable.

## Setup

Configs live under `/workspace/vpn/` (never commit private keys). From sandbox_exec:

- WireGuard: `wg-quick up /workspace/vpn/wg0.conf`
- OpenVPN: `openvpn --config /workspace/vpn/client.ovpn`

## Rules

- Confirm the tunnel IP is the expected one before scanning.
- Do not route unrelated traffic through the lab VPN.
- Tear down when the task ends. If bring-up fails, record a blocker; do not scan the public IP by mistake.
