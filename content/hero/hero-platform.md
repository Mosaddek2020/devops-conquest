## brief | Platform from code

Lumen Events outgrew its single server. You are building its platform from nothing but code: web servers, a monitoring server, firewalls between them, configuration, and alerts. The test of a platform is the second day: adding a server must be a one-line change that everything else follows.

1. Terraform: web servers (a count you can change), a monitoring server, security groups that only open what is needed, and a generated Ansible inventory.
2. Ansible: nginx and the node exporter on every web server; Prometheus on the monitoring server, scraping every web server from the inventory.
3. Alerting that you have seen fire.
4. Scale from two to three web servers by changing one number, and watch configuration and monitoring follow.
5. Prove everything has converged.

## recap | What this trial proved

- Terraform and Ansible meet at a generated inventory: provisioning feeds configuration.
- Security groups can reference each other (only the monitoring server reaches port 9100).
- Templates that loop over inventory groups make monitoring follow the fleet automatically.
- Idempotent runs and an empty plan are how you know code and reality agree.

## lab | Platform from code

Your laptop has Terraform, Ansible and promtool, an SSH key in `~/.ssh/id_ed25519`, and AWS credentials. Your public IP is `198.51.100.23`. `~/platform` is for Terraform; `~/platform-config` already holds `templates/index.html.j2` and `files/rules.yml` for Ansible.
