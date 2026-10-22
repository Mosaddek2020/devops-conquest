## story | Copy-paste environments

Lumen's staging and production configs started as one file copied into two folders. Six months later they differed in 23 places, only some on purpose. A fix to the production security group never reached staging; a test setting from staging ended up in production.

Terraform has the tools to avoid this: **variables** for what differs, **locals** for computed values, **outputs** to expose results, **count/for_each** for many similar things, and **modules** to package a pattern once and use it many times.

## model | Inputs, outputs and reuse

```term
variable "env" {
  type        = string
  description = "staging or production"
  validation {
    condition     = contains(["staging", "production"], var.env)
    error_message = "env must be staging or production."
  }
}
variable "web_count" {
  type    = number
  default = 1
}
locals {
  name = "events-${var.env}"
  tags = { Project = "events", Env = var.env }
}
module "web" {
  source        = "./modules/web-server"   # a folder of .tf files
  name          = local.name
  instance_type = var.env == "production" ? "t3.small" : "t3.micro"
  instances     = var.web_count
}
output "ips" { value = module.web.public_ips }
```

- **Variables** get values from (lowest to highest priority) defaults, `terraform.tfvars`, `*.auto.tfvars`, `-var-file`, `-var`. A variable without a value is asked for interactively.
- **`sensitive = true`** hides a value in plan output, but it is still stored in state in plain text.
- **`count`** makes N copies (`aws_instance.web[0]`…); **`for_each`** makes one per map key or set element (`aws_instance.web["api"]`), which is safer when the list changes.
- A **module** is a directory with its own variables (inputs) and outputs. The root calls it with `module "x" { source = ... }`, and `terraform init` installs it.
- One codebase, several environments: **a tfvars file per environment** (`staging.tfvars`, `production.tfvars`), or separate root folders that call the same modules.

## commands | Working with inputs

```term
$ terraform plan -var-file=staging.tfvars
$ terraform apply -var-file=production.tfvars
$ terraform plan -var 'web_count=3'
$ terraform output -json
$ terraform console            # (real Terraform) try expressions
$ terraform state list         # module.web.aws_instance.this[0] …
```

## analogy | A cake recipe with servings

The recipe is the module; the number of servings and the flavour are variables. You don't write a new recipe for twelve people instead of six; you change one input and the quantities follow.

## team | Structure habits

- **Modules for patterns you repeat** (a web server, a service with its database), not for every single resource.
- **Pin module versions** when they come from a registry or another repo.
- **Environments differ only in variables**, ideally few of them.
- **Prefer `for_each` over `count`** for things with identities, so removing one doesn't renumber the rest.

## traps | Input traps

**`count` with a list that changes order**: removing the first element replaces every later one.

**Secrets in tfvars committed to git.** Use environment variables (`TF_VAR_db_password`) or a secret manager.

**Giant "do everything" modules** with 60 variables: nobody understands them.

**Undeclared variables in tfvars**: Terraform only warns, so a typo silently does nothing.

## lab | One module, two environments

Turn a single web server config into a reusable module and use it for staging (1 server) and production (2 servers) with tfvars files.
