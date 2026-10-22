## story | 40 servers and a for-loop

When a critical OpenSSL fix came out, Lumen's ops team updated 40 servers with a shell `for` loop over SSH. Three servers were down at the time and silently missed it. Two had a different Ubuntu version where the command failed half-way. Nobody could say afterwards which servers were in which state.

**Ansible** does the same job (run things on many machines over SSH) but with **modules** that check the current state first, report `ok` or `changed`, stop cleanly on failure, and summarise every host in a recap. It needs no agent: just SSH and Python on the target.

## model | Inventory, modules, idempotence

```diagram
ansible-flow
```

```term
# inventory.ini
[web]
web1 ansible_host=54.170.10.21
web2 ansible_host=54.170.10.22

[db]
db1 ansible_host=54.170.10.30

[all:vars]
ansible_user=ubuntu
```

- The **inventory** lists hosts and groups (`web`, `db`, `all`) plus variables.
- A **module** is a unit of work that knows how to reach a state: `apt` (packages), `copy`/`template` (files), `service` (services), `user`, `file`, `lineinfile`, `ufw`…
- **Idempotence**: `apt: name=nginx state=present` installs nginx only if missing. Run it twice: first `changed`, then `ok`.
- `command`/`shell` just run things: always `changed`, no state check. Use them only when no module exists, and tell Ansible when they change things.
- **become** (`-b`, `become: true`) runs tasks as root via sudo.
- A **playbook** is YAML: plays (which hosts) containing tasks (which modules with which arguments).

```term
- name: Base setup
  hosts: all
  become: true
  tasks:
    - name: Install useful tools
      ansible.builtin.apt:
        name: [htop, curl]
        state: present
        update_cache: true
```

## commands | Ad-hoc and first playbooks

```term
$ ansible-inventory -i inventory.ini --graph
$ ansible all -i inventory.ini -m ping
$ ansible web -i inventory.ini -m command -a "uptime"
$ ansible web -i inventory.ini -b -m apt -a "name=htop state=present"
$ ansible-playbook -i inventory.ini base.yml
$ ansible-playbook -i inventory.ini base.yml --check     # dry run
$ ansible-playbook -i inventory.ini base.yml --limit web1
```

## analogy | A checklist, not a script

A script says "add sugar". Run it twice and the coffee is too sweet. A checklist says "coffee has one sugar": check, add only if missing. Ansible modules are checklist items, which is why running a playbook twice is safe.

## team | Ansible habits

- **Playbooks in git**, run from a pipeline or a controlled bastion, not from random laptops.
- **Modules over shell**; `ansible-lint` catches the shell-for-everything habit (common in AI-written playbooks).
- **`--check --diff` before risky runs**.
- **A second run should be `changed=0`**: if not, something is not idempotent.

## traps | Ansible traps

**`shell: apt-get install -y nginx`**: works, but always reports changed and hides real changes.

**Forgetting `become`**: permission errors on package and service tasks.

**YAML indentation**: a module's arguments must be indented under it.

**Running against `all` by accident**: use `--limit` and check the host list first (`--list-hosts`).

## lab | Your first fleet

Three servers are waiting. Build an inventory, talk to them ad hoc, then write a playbook that installs a base toolset and prove it is idempotent.
