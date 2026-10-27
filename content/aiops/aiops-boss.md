## brief | The 3 a.m. copilot

03:12. The shop on `web1` is returning errors and orders are failing. You are on call, with the team's AI assistant (through the Lumen AI gateway, which blocks secrets) and an ops agent on your laptop. Both are fast. Both have been wrong before.

1. Declare the incident and take command.
2. Get the assistant to help by giving it the right context, without leaking secrets.
3. Review the fix it proposes before anything runs.
4. Let the agent apply it under a policy that cannot destroy data.
5. Verify, resolve, and write a postmortem that includes how AI was used.

## recap | What the AI-assisted DevOps realm gave you

- Prompting with evidence, redacting secrets, and verifying causes before acting.
- Reviewing generated scripts with shellcheck, safe defaults and dry runs.
- Validating, planning and scanning AI-written infrastructure code; rejecting unrequested changes.
- Prompt injection, and least privilege for AI bots in CI: comment, never approve or merge.
- Agents with allow / ask / deny policies and an audit log.
- Operating LLM services: tokens, cost, rate limits, caching and spend alerts.

## lab | The 3 a.m. copilot

The shop on `web1` is failing. Use the assistant and the agent, safely, to restore it.
