## brief | Ship the shop

Lumen is launching a small **merch shop** at `shop.lumen.example.com`. You get a fresh Ubuntu server, **shop1**, the app (a Node.js release tarball on your laptop) and a deadline of tonight.

Put it into production the way a professional would: a dedicated user, a release folder with shared config, a systemd service that restarts on failure, nginx in front, HTTPS with an automatically renewing certificate, a firewall that exposes only what is needed, rotated logs and a scheduled backup.

## recap | What the Services realm gave you

- **systemd**: unit files, `enable --now`, `daemon-reload`, `Restart=`, the journal.
- **nginx**: server blocks, locations, `proxy_pass`, static files, `nginx -t`, reload, reading 502s.
- **Releases**: release folders, shared config, an atomic `current` symlink, health checks and rollbacks.
- **Logs and cron**: logrotate, crontab syntax, absolute paths, output you can see.

## lab | Launch night

Work through the launch checklist on shop1. Your SSH key already works for `ubuntu@shop1`, and DNS for `shop.lumen.example.com` already points at it.
