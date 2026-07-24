import type { AtsType, NormalizedJob } from "../types";
import { fetchJobs as ashby } from "./ashby";
import { fetchJobs as greenhouse } from "./greenhouse";
import { fetchJobs as lever } from "./lever";
import { fetchJobs as workable } from "./workable";
import { fetchJobs as recruitee } from "./recruitee";

// Each adapter returns NormalizedJob[] when a board exists (possibly empty) or
// null when there is no board at that slug.
export const adapters: Record<
  AtsType,
  (slug: string) => Promise<NormalizedJob[] | null>
> = {
  ashby,
  greenhouse,
  lever,
  workable,
  recruitee,
};

export function fetchJobs(
  type: AtsType,
  slug: string,
): Promise<NormalizedJob[] | null> {
  return adapters[type](slug);
}
