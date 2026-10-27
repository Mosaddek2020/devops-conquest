## story | "I also updated the AMI to the latest one"

A developer asked an assistant to "resize the web server to t3.medium and add a second one". The Terraform looked great. Buried in the diff, the assistant had also "helpfully" updated the AMI of the existing server to a newer image. `terraform plan` said `-/+ must be replaced`. Nobody read the plan; `apply -auto-approve` replaced the production server and its local data with a fresh one.

AI-written infrastructure code adds two failure modes to the usual ones: **hallucinated options** that do not exist, and **unrequested changes** that look like improvements.

## model | Validate, plan, scan, then apply

- **`terraform validate`** catches arguments and blocks that do not exist (`Unsupported argument`). Hallucinated options fail here, cheaply.
- **`terraform plan`** is the real review: read the summary (`to add, to change, to destroy`) and every `# forces replacement`. A request to *resize* should never destroy anything.
- **Scan** the result (`trivy config`): assistants often open SSH to `0.0.0.0/0` "so you can connect".
- **Diff against what you asked for**: every change in the diff should map to the request. Unrequested changes get removed or become their own reviewed change.
- **Keep generated IaC in git and review it in a pull request**, with the plan attached.

## commands | The review loop for generated IaC

```term
$ git diff
$ terraform validate
$ terraform plan
$ trivy config .
$ terraform apply
```

## analogy | The builder who repainted the house

You asked a builder to add a window. They also repainted the front, because the old colour looked dated. It may even look better, but it was not what you agreed, and you would want to know before they started.

## team | Generated IaC in the team

- **Plans in pull requests**: CI posts the plan; reviewers check for destroys and replacements.
- **`prevent_destroy`** and deletion protection on stateful resources (databases, volumes).
- **No `-auto-approve` against production** from a laptop.
- **Ask the assistant to explain its own diff**, then check the explanation against the plan.

## traps | IaC traps

**Approving the code without reading the plan.**

**Accepting "improvements" you did not ask for.**

**Fixing a validate error by adding more invented options.**

**Open security groups** added for convenience during a debugging session.

## lab | The helpful assistant

The `~/infra` Terraform manages Lumen's web server. Ask the assistant for a change, then validate, plan and scan its work, fix what it got wrong or did without being asked, and apply only what you intended.
