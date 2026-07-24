// Resume parsing is storage-agnostic: it takes bytes, never a path. Where the
// bytes came from (upload, test fixture) is the caller's problem.

import { getDocumentProxy, extractText } from "unpdf";
import { z } from "zod";
import { extractStructured } from "@/lib/llm";

export const resumeFactsSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  seniority: z
    .string()
    .nullable()
    .describe("e.g. 'entry-level', 'junior', 'mid'; null if not inferable"),
  skills: z.array(z.string()),
  projects: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      technologies: z.array(z.string()),
    }),
  ),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      duration: z.string().nullable(),
      summary: z.string(),
    }),
  ),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string(),
      graduationYear: z.string().nullable(),
    }),
  ),
});
export type ResumeFacts = z.infer<typeof resumeFactsSchema>;

export async function extractResumeText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  if (!text.trim()) {
    throw new Error("PDF produced no extractable text (scanned image, not text-layer PDF?)");
  }
  return text;
}

function buildExtractionPrompt(text: string): string {
  return `You are extracting structured facts from a resume's raw text. Rules:
- Only report what is explicitly stated in the text below. Never infer, guess, or embellish.
- If a field is genuinely absent or ambiguous, use null (for scalar fields) or an empty array — do not invent a plausible-sounding value.
- For "seniority", base it only on years of experience or titles explicitly stated; if you cannot tell, use null.
- Freelance or non-engineering work (e.g. video editing, graphic design) counts as real experience entries — include it, do not drop it or relabel it as something it isn't.

Resume text:
"""
${text}
"""`;
}

export async function extractResumeFacts(text: string): Promise<ResumeFacts> {
  return extractStructured({ prompt: buildExtractionPrompt(text), schema: resumeFactsSchema });
}

export async function parseResume(
  bytes: Uint8Array,
): Promise<{ text: string; facts: ResumeFacts }> {
  const text = await extractResumeText(bytes);
  const facts = await extractResumeFacts(text);
  return { text, facts };
}
