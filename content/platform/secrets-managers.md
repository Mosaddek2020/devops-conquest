## story | The password in four places

Lumen's database password was in the shop's config repository in plain text, in a Kubernetes Secret created by hand two years ago, in a CI variable, and in a teammate's notes. Rotating it meant finding all four, and someone always found a fifth. The config repo had been cloned onto every developer's laptop, so "rotating" the old one did not undo the leak.

A **secrets manager** (HashiCorp **Vault**, or AWS Secrets Manager, Google Secret Manager, Azure Key Vault) keeps each secret in one place, with access policies, versions and an audit log. Workloads fetch secrets at run time with their own identity. In Kubernetes, the **External Secrets Operator** (ESO) copies them into ordinary Secrets and keeps them up to date. When a secret must live in git (a config repo, a bootstrap value), **SOPS** encrypts its values so the file is safe to commit.

## model | One source, short paths, no copies

```diagram
secrets-flow
```

- **Vault KV v2** stores versioned key/value secrets at paths like `secret/shop/db` (the API path is `secret/data/shop/db`).
- **Policies** grant capabilities on path patterns: `path "secret/data/shop/*" { capabilities = ["read"] }`. Tokens carry policies; anything not granted is denied.
- **Kubernetes auth**: a Vault role trusts a namespace's service account (`bound_service_account_names/namespaces`) and hands it a token with the role's policies. No static Vault token sits in the cluster.
- **ESO**: a **SecretStore** says how to reach Vault and log in; an **ExternalSecret** maps remote keys to a target Kubernetes Secret and refreshes it every `refreshInterval`. Rotate in Vault, and the Secret follows.
- Pods read Secrets at **start**: an env var does not change in a running pod. Roll the Deployment after a rotation (or use a volume, or a reloader).
- **SOPS + age**: `age-keygen` makes a key pair; `sops --encrypt` replaces values with `ENC[AES256_GCM,…]` for the public key (rules in `.sops.yaml`); only holders of the private key can `sops -d`. A MAC detects edits made without SOPS.

## commands | Vault, External Secrets and SOPS

```term
$ export VAULT_ADDR=http://vault.lumen.internal:8200
$ vault login                                    # with an admin token
$ vault kv put secret/shop/db password='…'
$ vault policy write shop-read shop-read.hcl
$ vault auth enable kubernetes
$ vault write auth/kubernetes/role/shop bound_service_account_names=shop \
    bound_service_account_namespaces=shop policies=shop-read ttl=1h
$ kubectl get externalsecret -n shop             # READY True = synced
$ age-keygen -o key.txt
$ sops --encrypt --in-place secrets/db.yaml      # values encrypted, keys readable
$ sops secrets/db.yaml                           # edit decrypted, saved encrypted
```

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: shop-db
  namespace: shop
spec:
  refreshInterval: 1m
  secretStoreRef: { name: vault, kind: SecretStore }
  target: { name: shop-db }
  data:
    - secretKey: password
      remoteRef: { key: shop/db, property: password }
```

## analogy | A bank vault with a teller

You do not keep cash in every drawer of the office. It sits in the bank; each department has an account it can draw from, every withdrawal is logged, and if a card is stolen you cancel that card. ESO is the teller who refills the till each morning; SOPS is the sealed envelope for the few notes that must travel by post.

## team | Secrets in a team

- **One source of truth** per secret; everything else is a reference.
- **Workload identity, not shared tokens**: each service account can read only its own paths.
- **Rotate on a schedule and on suspicion**, and make rotation boring: change it in Vault, let ESO sync, roll the pods.
- **Audit logs on**: who read the payments key, and when?
- **A secret that reached git is leaked.** Encrypting or deleting it later does not remove it from clones and history: rotate it.

## traps | Secrets traps

**base64 is not encryption.** A Kubernetes Secret in git is a plain-text secret.

**One Vault token for everything**, with a policy of `path "*"`.

**Rotating in Vault and forgetting the pods**: they keep the old value until restarted.

**Losing the age private key**: nobody can decrypt the files any more. Keep it in a password manager or in Vault itself.

**Editing a SOPS file with a normal editor**: the MAC no longer matches and decryption fails. Use `sops FILE`.

## lab | One place for the password

The shop's database password sits in plain text in the config repo `lumen/shop-config`, and the shop's pods are waiting for a Secret called `shop-db`. Encrypt the file for git with SOPS, put the real secret in Vault with a least-privilege policy, let External Secrets deliver it to the cluster, rotate it, and prove the shop cannot read anyone else's secrets.
