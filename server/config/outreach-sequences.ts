export interface OutreachEmail {
  subject: string;
  body: string;
  delayDays: number;
}

export interface OutreachSequence {
  name: string;
  description: string;
  emails: OutreachEmail[];
}

export const outreachSequences: OutreachSequence[] = [
  {
    name: "cold-contractor-intro",
    description: "3-email cold outreach sequence for construction contractors. Designed for short, personal messages that drive curiosity and clicks.",
    emails: [
      {
        subject: "quick estimate for your last job",
        body: `Hey — quick question.

If I could generate a full construction estimate for one of your jobs in about 30 seconds…

Would you want to see it?

(No catch — just testing something)

– Jesse`,
        delayDays: 0,
      },
      {
        subject: "made one for you",
        body: `I actually ran a sample estimate based on a typical job in your trade.

Breaks down:
- materials
- labor
- total cost

Takes about 30 seconds to generate.

Want me to send it over?`,
        delayDays: 2,
      },
      {
        subject: "worth a look?",
        body: `Last message from me—

This is mainly for contractors who want to quote jobs faster without sitting down for hours.

If that's you, I think you'll like it.

If not, no worries at all.

– Jesse`,
        delayDays: 4,
      },
    ],
  },
];

export function getSequenceByName(name: string): OutreachSequence | undefined {
  return outreachSequences.find((s) => s.name === name);
}

export function getAllSequences(): OutreachSequence[] {
  return outreachSequences;
}
