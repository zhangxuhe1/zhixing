import { z } from "zod";

export const cardDraftSchema = z.object({
  title: z.string().min(2).max(30),
  blocks: z
    .array(z.object({ type: z.literal("text"), content: z.string().min(50) }))
    .min(1)
    .max(6),
  sources: z.array(z.string().min(2)).min(1).max(8),
});

export type CardDraft = z.infer<typeof cardDraftSchema>;
