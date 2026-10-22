## story | The server nobody could rebuild

Lumen's first production server, `web-legacy`, was set up by hand in the cloud console three years ago. Someone picked an instance size, opened some ports "temporarily", installed packages, edited config files. It worked. Then the company needed a second, identical server for a new region, and nobody could say exactly what was on the first one. The security group still allowed SSH from the whole internet. The person who built it had left.

This is **ClickOps**: infrastructure built by clicking and typing, remembered by nobody, impossible to review, copy or rebuild. **Infrastructure as Code (IaC)** writes the infrastructure down as files in git: reviewed in pull requests, applied by tools, reproducible on demand. Rebuilding the server becomes a command, and so does building ten more.

## model | Declarative, idempotent, versioned

```diagram
provision-configure
```

- **Declarative**: you describe the *end state* ("a t3.small with this security group"), the tool figures out the steps. Imperative scripts describe steps ("create, then attach, then...") and break when the starting point differs.
- **Idempotent**: running it again changes nothing if nothing needs changing. That makes it safe to re-run and lets the tool detect **drift** (reality changed behind its back).
- **Versioned**: infrastructure changes are commits with authors, reviews and history. Rollback is a revert.
- **Provisioning** (Terraform/OpenTofu, Pulumi, CloudFormation) creates cloud resources through APIs. **Configuration management** (Ansible, Chef, Puppet) sets up what runs on machines.
- With **immutable infrastructure** you don't change servers in place at all: you build a new image and replace them (containers push this furthest).

AI assistants write Terraform and Ansible fluently, which makes review more important, not less: a plausible-looking config can open a database to the internet or destroy a bucket.

## commands | First look

```term
$ aws sts get-caller-identity               # which account am I in?
$ aws ec2 describe-instances --output table
$ aws ec2 describe-security-groups --query "SecurityGroups[].IpPermissions"
$ terraform init                             # download providers
$ terraform plan                             # what would change (read-only)
$ terraform apply                            # make it so (asks for "yes")
$ terraform plan                             # again: "No changes" = idempotent
$ terraform destroy                          # remove everything this config created
```

## analogy | A recipe vs a cook's memory

A dish cooked from memory is never quite the same twice, and when the cook leaves, the dish leaves too. A written recipe can be followed by anyone, improved by anyone, and gives the same result every time. IaC is the recipe for your infrastructure.

## team | IaC in a team

- **Everything that can be code, is code**: the console is for looking, not for changing.
- **Changes go through pull requests** that include the `terraform plan` output for reviewers.
- **One pipeline applies**, with credentials humans don't use day to day.
- **Start with new things**: import or rebuild the old snowflakes over time.

## traps | First traps

**"Just this once" in the console.** That change will be undone (or will break) the next time the code is applied.

**Treating IaC as a one-time script.** It is a living description: change the code, not the cloud.

**Copying an AI-generated config without reading the plan.** The plan is where you see what it will really do.

## lab | From snowflake to code

Inspect the hand-built `web-legacy` server with the `aws` CLI, then create your first resource with Terraform and see idempotence for yourself.
