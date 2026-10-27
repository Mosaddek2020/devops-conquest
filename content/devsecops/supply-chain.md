## story | The image that was not ours

Lumen deployed `registry.lumen.dev/shop:1.4` to production every Tuesday. One Tuesday the tag pointed to a different image: a contractor's CI job, with a leaked registry password, had pushed over it. The new image ran the shop and quietly sent card numbers to another server. Nothing in the pipeline asked *who built this image, and from what?*

Your software is mostly other people's software: base images, packages, actions, tools. A **software supply chain** attack hits one of those links instead of your code.

```diagram
supply-chain
```

## model | Know what you ship, and prove who built it

- An **SBOM** (software bill of materials) lists every component and version in an artifact, in a standard format (**CycloneDX** or **SPDX**). `syft` generates one from a directory or an image.
- **Scan the SBOM** (`trivy sbom`) instead of re-analysing the image: when a new CVE appears next month, you can check every SBOM you have ever shipped in seconds.
- **Update dependencies deliberately**: patch the vulnerable ones, rebuild, re-scan. Pin versions with lock files.
- **Sign images** with **cosign** after CI builds them. Production verifies the signature with the public key before it runs anything. A tampered or unsigned image fails verification.
- **Tags move, digests do not.** `shop:1.4` can be re-pushed; `shop@sha256:9d99…` always means the same bytes. Sign and deploy by digest.
- **SLSA** levels describe how trustworthy a build is (scripted, hosted, provenance, hardened). Signing plus provenance is a big step up from "whatever is in the registry".

## commands | SBOM, scan, sign, verify

```term
$ syft registry.lumen.dev/shop:1.4 -o cyclonedx-json=sbom.json
$ trivy sbom sbom.json
$ cosign generate-key-pair
$ cosign sign --key cosign.key registry.lumen.dev/shop@sha256:…
$ cosign verify --key cosign.pub registry.lumen.dev/shop:1.4
```

## analogy | Food labels and tamper seals

An SBOM is the ingredients label: when a supplier recalls an ingredient, you know which products contain it. A signature is the tamper-evident seal on the jar: if it is broken, you do not eat it, however familiar the label looks.

## team | Supply-chain habits

- **Generate and keep an SBOM for every release**, next to the artifact.
- **Only CI holds the signing key** (or uses keyless signing with OIDC); developers' laptops do not sign production images.
- **Verify at deploy time**, and in the cluster with an admission policy, so nothing unsigned can run.
- **Pin third-party actions and base images by digest** and update them on purpose (Dependabot, Renovate).

## traps | Supply-chain traps

**Trusting tags.** Anyone with push access can move them.

**Signing by tag**: you might sign an image that was swapped a second earlier.

**SBOMs nobody scans.** A list is only useful if something checks it against new vulnerabilities.

**Keeping the private key in the repository** next to the code it is meant to protect.

## lab | Know it, sign it, verify it

The shop image lives in `registry.lumen.dev`. Produce its SBOM, find and fix a vulnerable dependency, sign the release by digest, and catch a tampered image before it reaches production.
