---
name: ssh-toolkit
description: SSH workflows, network discovery, tunnels, remote-debug, and packet inspection inside the opencode-vm sandbox. Use when the task involves SSH'ing to a remote host, mounting a remote filesystem, opening tunnels, scanning a LAN, debugging connectivity, inspecting traffic, or testing TLS endpoints. Covers ssh, sshpass, autossh, mosh, sshfs, rsync, nmap, arp-scan, arping, tcptraceroute, drill, tshark, hping3, gnutls-cli, lftp.
---

# SSH & Network Toolkit

Use this skill for SSH workflows and network diagnostics from inside the
opencode-vm sandbox.

## Prerequisites

```bash
for c in ssh sshpass autossh mosh sshfs rsync expect \
         nmap ncat arp-scan arping tracepath tcptraceroute drill ipcalc telnet \
         ethtool iftop nethogs brctl tshark hping3 gnutls-cli lftp; do
  command -v "$c" >/dev/null && echo "ok: $c" || echo "missing: $c"
done
```

If anything is missing, the base VM may need to be rebuilt
(`opencode-vm init` on the host).

## Security Boundary (read this first)

The VM has **no SSH credentials** by default — `~/.ssh/` is empty, no agent
forwarding, no host key inheritance from the user. The user must provide
credentials per-session if SSH targets require them.

**Never attempt to reach the user's git origin from inside the VM** — that
boundary is enforced at the firewall level (nftables `ocfilter`).

LAN access is **opt-in**: before SSH'ing into a LAN host, the user must run
on the host: `opencode-vm ports lan tcp add 192.168.x.y:22`.

## Use Cases

### 1. SSH with password auth (no key set up)

```bash
# Avoid leaking the password in `ps` output — pass via env var, not -p
SSHPASS="$REMOTE_PW" sshpass -e ssh -o StrictHostKeyChecking=accept-new user@host uptime

# One-off through a jump host (ProxyJump)
ssh -J jumpuser@jump.example.com user@target.internal

# Run a remote command, capture output
ssh user@host "df -h /var" | tee /tmp/disk.txt
```

### 2. Persistent / resilient sessions

```bash
# mosh — survives network drops, NAT changes (UDP-based)
mosh user@host

# autossh tunnel that auto-reconnects (local 8080 → remote 80)
autossh -M 0 -f -N \
  -o "ServerAliveInterval 30" -o "ServerAliveCountMax 3" \
  -L 8080:localhost:80 user@host
```

### 3. Remote filesystem mounts

```bash
mkdir -p /tmp/remote
sshfs user@host:/var/log /tmp/remote -o reconnect,ServerAliveInterval=15
# … work with files under /tmp/remote …
fusermount -u /tmp/remote
```

### 4. File sync over SSH

```bash
# Mirror remote directory into local, delete extras locally
rsync -avz --delete user@host:/srv/data/ ./data/

# Push local changes to remote
rsync -avz ./build/ user@host:/var/www/site/
```

### 5. LAN host discovery

```bash
# ARP scan — fastest, sees devices that don't respond to ICMP
sudo arp-scan --localnet

# Ping sweep with nmap (no port scan)
nmap -sn 192.168.1.0/24

# Single-host ARP probe
sudo arping -c 3 192.168.1.10
```

### 6. Port & service discovery

```bash
# Light TCP scan (avoid -A -T5 on shared/customer networks)
nmap -sT -T2 -p 1-1024 192.168.1.10

# Fingerprint a single service
nmap -sV -p 22 192.168.1.10

# Quick "is this port open?" — netcat is enough
nc -zv host 5432
```

### 7. Connectivity debug

```bash
# When ICMP is blocked, use TCP traceroute
tcptraceroute host 443

# Path MTU discovery without root
tracepath host

# DNS deep trace
drill +trace example.com

# Compare two TLS stacks (sometimes one connects where the other doesn't)
echo | openssl s_client -connect host:443 -servername host 2>/dev/null | head -20
echo | gnutls-cli host:443 2>/dev/null | head -20

# Live link / driver state
ethtool eth0
```

### 8. Packet inspection

```bash
# Fast capture: tcpdump (already installed)
sudo tcpdump -i any -n -c 100 'host 192.168.1.10 and port 443'

# Protocol-level decoding: tshark
sudo tshark -i any -a duration:30 -a filesize:50 \
  -f 'tcp port 443' -Y 'tls.handshake.type == 1' \
  -T fields -e ip.src -e tls.handshake.extensions_server_name

# Live bandwidth views (TUI)
sudo iftop -i eth0
sudo nethogs eth0
```

### 9. Crafted packet probing

```bash
# TCP SYN to a single port (finds firewall behavior fast)
sudo hping3 -S -p 443 -c 3 host

# UDP probe
sudo hping3 --udp -p 53 -c 3 host
```

⚠ `hping3` can stress LANs / trigger IDS. Default to `-c <n>` and never run
`--flood` against shared infrastructure.

### 10. Bulk file transfer over various protocols

```bash
# Mirror a remote sftp tree, parallel transfers
lftp -e "mirror --parallel=4 /remote/path ./local/path; bye" \
     sftp://user@host
```

## Common Pitfalls

- `StrictHostKeyChecking=accept-new` is acceptable for first connect; never
  use `=no` in scripts you would commit.
- `sshpass -p <pw>` puts the password on the command line and into `ps`
  output. Use `sshpass -e` with `SSHPASS` env var instead.
- `arp-scan` and `arping` need raw sockets → run with `sudo`.
- `nmap -A -T5` is **aggressive** — likely to trip IDS on customer networks.
  Default to `-sT -T2` until you know the environment.
- `tshark` capture files balloon fast — bound them with
  `-a duration:30 -a filesize:50` (50 = MB).
- mosh requires the server side to run `mosh-server` and UDP egress on
  60000-61000 — plain SSH if those aren't open.
- `sshfs` mounts can hang if the network drops. Always pass
  `-o reconnect,ServerAliveInterval=15`.
- LAN access requires a host-side firewall opt-in
  (`opencode-vm ports lan tcp add IP:PORT`), or the connection times out
  silently.

## Generating an SSH key inside the VM

If a target requires key-auth and the user hasn't pasted in an existing key,
generate one in the VM and ask the user to install the public half on the
target. The private key lives only in the ephemeral session VM and is
destroyed on session exit.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -C "opencode-vm-session"
cat ~/.ssh/id_ed25519.pub
# → user copies the pubkey to authorized_keys on the target
```

Do **not** copy keys back to the host. Do **not** push them anywhere.
