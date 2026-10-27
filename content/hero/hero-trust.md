## brief | Trust but verify

`notify` is in production and deployed by its pipeline. After the supply-chain incident in another team, the security lead asks for three things before the next audit: **know** what is in every image, **prove** that production only runs images your pipeline built, and **show** that a tampered image in the registry cannot reach the cluster.

1. Every pipeline run produces a CycloneDX SBOM of the image it built, kept as a build artifact.
2. A signing key whose private half only CI holds.
3. The pipeline signs the image **by digest**, verifies the signature, and deploys that exact digest.
4. A tampered image pushed over the tag changes nothing in production, and verification shows the tag can no longer be trusted.

## recap | What this trial proved

- SBOMs can be produced and archived by the pipeline on every build.
- Private signing keys live in CI secrets; only the public key is committed.
- Signing and deploying by digest closes the gap between "what was scanned and signed" and "what runs".
- A moved tag is detectable (verification fails) and harmless when deployments pin digests.

## lab | Trust but verify

`~/notify` holds the service and its working pipeline (`.github/workflows/deliver.yml`). The repository has the secrets `REGISTRY_TOKEN` and `KUBECONFIG_DATA`. `cosign` is installed on your laptop; the Actions `anchore/sbom-action`, `actions/upload-artifact` and `sigstore/cosign-installer` are available to the runner.
