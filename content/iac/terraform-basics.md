## story | Three resources and an order

To replace `web-legacy`, Lumen needs a key pair (so the team can SSH in), a security group (SSH from the office only, HTTP from anywhere) and an instance that installs nginx when it boots. By hand, that's three console pages and some copy-pasted IDs. In Terraform it's one file where the instance simply *refers* to the key pair and security group, and Terraform works out the order.

## model | Providers, resources, references, plans

```term
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}
provider "aws" { region = "eu-west-1" }

resource "aws_security_group" "web" {
  name = "web"
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "web" {
  ami                    = "ami-0a7f1556c36aea1b6"
  instance_type          = "t3.micro"
  vpc_security_group_ids = [aws_security_group.web.id]   # a reference = a dependency
  user_data              = file("cloud-init.sh")          # runs once, at first boot
  tags = { Name = "web" }
}

output "public_ip" { value = aws_instance.web.public_ip }
```

```diagram
tf-graph
```

- A **provider** is the plugin that talks to an API (AWS, Azure, Cloudflare, GitHub…). `terraform init` downloads it and records the version in `.terraform.lock.hcl` (commit that file; ignore `.terraform/`).
- A **resource** block declares one thing to manage: `resource "<type>" "<name>"`. Refer to its attributes as `<type>.<name>.<attribute>`.
- **Plan symbols**: `+` create, `~` update in place, `-/+` destroy and re-create (**replace**), `-` destroy. `(known after apply)` means the value only exists once created.
- Some arguments can be changed in place (instance type, tags, security groups); others **force replacement** (the AMI, the subnet): the plan says `# forces replacement`. Replacing a server means a new IP and a fresh disk.
- After apply, Terraform writes **state** (`terraform.tfstate`): the mapping from your code to real IDs. That's how the next plan knows what exists.

## commands | The core loop

```term
$ terraform init
$ terraform fmt              # canonical formatting
$ terraform validate         # syntax and references
$ terraform plan
$ terraform apply            # shows the plan again, then asks
$ terraform output public_ip
$ terraform state list       # what Terraform manages
$ terraform state show aws_instance.web
```

```replay
title: Plan, apply, change, drift
scenario: cloud
show: cloud
cwd: ~/infra
step: terraform init | Downloads the AWS provider and writes the lock file.
step: terraform apply -auto-approve | Key pair, security group, then the instance that refers to both: the order comes from the references. (-auto-approve only because this is a demo.)
step: curl -s http://$(terraform output -raw public_ip)/ | cloud-init installed nginx at first boot.
step: sed -i 's/t3.micro/t3.small/' main.tf && terraform plan | Instance type can change in place: ~ update.
step: aws ec2 authorize-security-group-ingress --group-id $(aws ec2 describe-security-groups --query "SecurityGroups[?GroupName=='web'].GroupId" --output text) --protocol tcp --port 3306 --cidr 0.0.0.0/0 >/dev/null; terraform plan | Someone opened MySQL to the world in the console. The plan shows the drift, and proposes to remove it.
```

## analogy | A moving checklist

Telling movers "the bed goes in the bedroom, the desk under the window" lets them plan the order themselves: they know the desk can't go in before the room is empty. You describe where things end up; Terraform is the mover who works out the sequence and ticks off the list (state).

## team | Habits

- **Read every plan.** Especially lines with `-` and `forces replacement`.
- **`fmt` and `validate` in CI**, plan on every pull request.
- **Small applies**, often. A plan with 40 changes is hard to review.
- **Tag everything** (Name, Owner, Environment) so the console makes sense.

## traps | Terraform traps

**Hard-coding IDs from the console** instead of referencing resources: no ordering, and they break in another account.

**Editing `user_data` and expecting a running server to change**: it only runs at first boot. Replace the instance (or use configuration management).

**Committing `terraform.tfstate`** to git: it contains secrets and causes conflicts. Use a remote backend (next lessons).

**Approving a plan you didn't read**: "1 to destroy" might be your database.

## lab | Replace the snowflake

Write Terraform for a key pair, a security group and a web server that installs nginx at boot. Then change it two ways and see the difference between an update and a replacement.
