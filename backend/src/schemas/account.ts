import { z } from "zod";

// Deletion is irreversible anonymization, so the client must echo an exact
// confirmation word rather than just sending a flag — the same guard rail as
// GitHub's "type the repository name" delete flows.
export const deleteAccountSchema = z.object({
  confirm: z.string().regex(/^DELETE$/, 'Type "DELETE" to confirm account deletion'),
});
