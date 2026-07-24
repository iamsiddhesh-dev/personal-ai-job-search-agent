import { getPrompt, type ChatContext, type StepId } from "@/lib/chat/flow";

const VALID_STEPS: StepId[] = ["name", "sources", "playback", "role", "location", "stage", "run"];

export async function POST(req: Request) {
  const body = (await req.json()) as { step?: string; ctx?: ChatContext };
  const step = body.step as StepId;

  if (!VALID_STEPS.includes(step)) {
    return Response.json({ error: `Unknown step: ${body.step}` }, { status: 400 });
  }

  return Response.json(getPrompt(step, body.ctx ?? {}));
}
