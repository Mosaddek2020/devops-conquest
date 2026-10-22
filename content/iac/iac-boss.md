## brief | Rebuild the events platform from code

The events platform still runs on the hand-made `web-legacy`. Replace it with infrastructure that is entirely code:

1. **Terraform**: a VPC with a public subnet, an internet gateway and route table, a security group (HTTP from anywhere, SSH only from your IP), a key pair and **two** web servers, plus a generated Ansible inventory.
2. **Ansible**: configure both servers with nginx and the events site from a template, with a handler.
3. **Prove it**: both servers serve the site; a second Terraform plan and a second Ansible run both report no changes.
4. **Drift**: someone opens SSH to the world in the console. Detect it and put the code back in charge.

## recap | What the IaC realm gave you

- Declarative, idempotent, versioned infrastructure; provisioning vs configuration.
- Terraform: providers, resources, references, plans (`+ ~ -/+ -`), state, outputs.
- Variables, validation, tfvars, locals, count/for_each, modules.
- Remote state, locking, drift, import, state commands.
- Safe changes: reading plans, saved plans, lifecycle rules, AI-config review.
- Ansible: inventories, modules, idempotence, playbooks, templates, handlers, roles, vault, lint.

## lab | Events, rebuilt

Work in `~/events-infra` (Terraform) and `~/events-config` (Ansible). Your laptop's public IP is `198.51.100.23`. The site template is ready in `~/events-config/templates/index.html.j2`.
