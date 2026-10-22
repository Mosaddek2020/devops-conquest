## story | The config file nobody could diff

Lumen's nginx configs were edited on each server by hand. When a TLS setting needed changing, someone had to SSH into eight servers and edit eight slightly different files. With Ansible, the config became one **template** in git, filled with per-environment **variables**, deployed by a playbook that reloads nginx only when the file actually changed (a **handler**), and previewable with `--check --diff` before anything is touched.

## model | Templates, variables, handlers, roles, vault

```term
- name: Web servers
  hosts: web
  become: true
  vars:
    site_title: Lumen Events
  tasks:
    - name: Install nginx
      ansible.builtin.apt: { name: nginx, state: present }
    - name: Site config
      ansible.builtin.template:
        src: site.conf.j2
        dest: /etc/nginx/sites-enabled/default
        mode: "0644"
      notify: Reload nginx                 # only if this task changed
    - name: Open HTTP
      community.general.ufw: { rule: allow, port: "80" }
      when: firewall_enabled | default(true)
  handlers:
    - name: Reload nginx
      ansible.builtin.service: { name: nginx, state: reloaded }
```

- **Templates** are Jinja2: `{{ variable }}`, filters (`{{ name | upper }}`, `{{ x | default('a') }}`), loops `{% for %}`, conditions `{% if %}`.
- **Variables** come from many places; the common ones: `group_vars/web.yml` (per group), `host_vars/web1.yml` (per host), play `vars`, and `-e` on the command line (highest).
- **Handlers** run once at the end of the play, only on hosts where a notifying task reported `changed`.
- **`loop`** repeats a task per item (`{{ item }}`); **`when`** makes it conditional; **`register`** saves a result for later tasks.
- **Roles** package tasks, handlers, templates and defaults in `roles/<name>/…` so a playbook just says `roles: [nginx]`.
- **ansible-vault** encrypts files with secrets so they can live in git; playbooks need `--ask-vault-pass` or a password file to read them.
- **`--check --diff`** shows what would change in every file, without changing anything.

## commands | Day-to-day

```term
$ ansible-playbook -i inventory.ini site.yml --check --diff
$ ansible-playbook -i inventory.ini site.yml
$ ansible-playbook -i inventory.ini site.yml -e site_title="Lumen Live"
$ ansible-vault encrypt group_vars/all/vault.yml
$ ansible-vault view group_vars/all/vault.yml
$ ansible-playbook -i inventory.ini site.yml --ask-vault-pass
$ ansible-lint site.yml
```

## analogy | A form letter

A form letter has one template and a mailing list of variables (names, addresses). You fix a typo once, and every letter is right. Handlers are the "send only if the letter changed" rule: nobody gets a duplicate.

## team | Playbook habits

- **Group vars for environments**, templates for config, roles for reusable components.
- **Every secret vaulted** (or pulled from a secret manager), never plain in git.
- **`--check --diff` in pull requests** so reviewers see real changes.
- **Lint in CI**; treat a non-zero second run as a bug.

## traps | Playbook traps

**`restarted` instead of a handler**: services restart on every run, even when nothing changed.

**Undefined variables**: the play fails mid-way. Use `| default(...)` deliberately, not everywhere.

**Secrets in `vars:`** or logged by `debug`. Vault them and use `no_log: true` on tasks that handle them.

**Editing files on servers by hand afterwards**: the next run overwrites them (that's the point).

## lab | Template the events site

Turn the events web servers' hand-edited config into a template with variables and a handler, preview with check/diff, keep the deploy password in a vault, and make the lint pass.
