## brief | Your first day at Lumen

It is your first morning on Lumen's platform team. You have barely set up your laptop when the team chat lights up: **"Checkout feels broken, can someone look?"** Everyone senior is in a planning meeting.

You will not fix the problem today. Your job is to **investigate calmly and report clearly**: what is broken, what the evidence says, and what you think the next step is. That is the most valuable thing a new person can do in an incident.

## recap | What Base Camp gave you

- **DevOps** is shared ownership of the whole loop, with automation and fast feedback; CALMS and the Three Ways describe it, and the four DORA metrics measure it.
- Delivery is a **loop** and a **value stream**: most lead time is waiting, so shrink queues with small batches, less work in progress and automation.
- **AI assistants** draft, explain and summarise; you read, verify, test safely and decide.
- Your first terminal habits: `pwd`, `ls`, `cat`, `head`, `tail`, `grep`, `wc`, `curl`, and `echo … >> file`.

## lab | Checkout feels broken

Investigate the report. Lumen's public status API is at `https://status.lumen.example.com/api`, and the team keeps its runbooks somewhere in your home folder. Collect evidence and write a short incident note in `~/incident.md`.
