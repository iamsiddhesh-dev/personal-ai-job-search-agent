import type { SourceCompany } from "./types";

// Curated India-accelerator portfolio companies. These are the main source of
// India-BASED startup roles — YC's API skews US, and location is the top
// project risk (see PROBE-RESULTS.md). Each entry feeds the SAME ATS resolver
// as YC companies. This is a hand-maintained list, not a live crawl: the
// accelerator portfolio pages are JS-rendered and unreliable to scrape.
//
// To extend: add { name, website } for any India-hiring startup. The resolver
// scans its careers page and finds the ATS automatically.

interface CuratedSeed {
  name: string;
  domain: string;
}

// Axilor Ventures portfolio (India). Domains verified from axilor.com/portfolio.
const AXILOR: CuratedSeed[] = [
  { name: "Wiz Freight", domain: "wizfreight.com" },
  { name: "MetalBook", domain: "metalbook.co.in" },
  { name: "Locofast", domain: "locofast.com" },
  { name: "CapGrid", domain: "capgridsolutions.com" },
  { name: "Solar Ladder", domain: "solarladder.com" },
  { name: "SwitchOn", domain: "switchon.io" },
  { name: "Leucine", domain: "leucine.io" },
  { name: "Twixor", domain: "twixor.com" },
  { name: "Maximl", domain: "maximl.com" },
  { name: "Detect Technologies", domain: "detecttechnologies.com" },
  { name: "Doppelio", domain: "doppelio.com" },
  { name: "FluxGen", domain: "fluxgen.com" },
  { name: "Peer Robotics", domain: "peerrobotics.ai" },
  { name: "UrbanPiper", domain: "urbanpiper.com" },
  { name: "Vyapar", domain: "vyaparapp.in" },
  { name: "SquadStack", domain: "squadstack.com" },
  { name: "Securden", domain: "securden.com" },
  { name: "Emitrr", domain: "emitrr.com" },
  { name: "Delightree", domain: "delightree.com" },
  { name: "eShipz", domain: "eshipz.com" },
  { name: "Knit", domain: "getknit.dev" },
  { name: "EnKash", domain: "enkash.com" },
  { name: "BoxPay", domain: "boxpay.tech" },
  { name: "Medfin", domain: "medfin.in" },
  { name: "5C Network", domain: "5cnetwork.com" },
  { name: "Niramai", domain: "niramai.com" },
  { name: "SigTuple", domain: "sigtuple.com" },
  { name: "Advantage Club", domain: "advantageclub.co" },
  { name: "ePlane", domain: "eplane.ai" },
  { name: "ElectricPe", domain: "electricpe.com" },
];

// Well-known India-hiring startups backed by Surge / Blume / Accel / Antler /
// EF that commonly run a public ATS board.
const INDIA_STARTUPS: CuratedSeed[] = [
  { name: "Bolna AI", domain: "bolna.ai" },
  { name: "Sarvam AI", domain: "sarvam.ai" },
  { name: "Krutrim", domain: "olakrutrim.com" },
  { name: "Zepto", domain: "zeptonow.com" },
  { name: "Groww", domain: "groww.in" },
  { name: "Razorpay", domain: "razorpay.com" },
  { name: "Cred", domain: "cred.club" },
  { name: "Meesho", domain: "meesho.com" },
  { name: "Postman", domain: "postman.com" },
  { name: "Hasura", domain: "hasura.io" },
  { name: "Atlan", domain: "atlan.com" },
  { name: "Zluri", domain: "zluri.com" },
  { name: "Nintee", domain: "nintee.com" },
  { name: "SpotDraft", domain: "spotdraft.com" },
  { name: "Fibr AI", domain: "fibr.ai" },
  { name: "Rocketlane", domain: "rocketlane.com" },
  { name: "Kula", domain: "kula.ai" },
  { name: "Nurture Farm", domain: "nurture.farm" },
  { name: "Plum", domain: "plumhq.com" },
  { name: "Jar", domain: "myjar.app" },
  { name: "InVideo", domain: "invideo.io" },
  { name: "Fam", domain: "fampay.in" },
  { name: "Bharat Agri", domain: "bharatagri.com" },
  { name: "Kutumb", domain: "kutumbapp.com" },
  { name: "Apna", domain: "apna.co" },
  { name: "Classplus", domain: "classplusapp.com" },
  { name: "Toplyne", domain: "toplyne.io" },
  { name: "DevRev", domain: "devrev.ai" },
  { name: "Pixis", domain: "pixis.ai" },
  { name: "Observe AI", domain: "observe.ai" },
  { name: "Whatfix", domain: "whatfix.com" },
  { name: "Yellow AI", domain: "yellow.ai" },
  { name: "Skit", domain: "skit.ai" },
  { name: "Locus", domain: "locus.sh" },
  { name: "Zolve", domain: "zolve.com" },
];

function toCompany(seed: CuratedSeed): SourceCompany {
  return {
    name: seed.name,
    slug: null,
    website: `https://${seed.domain}`,
    source: "curated",
    ycBatch: null,
    teamSize: null,
    industries: [],
    regions: ["India"],
  };
}

export function acceleratorCompanies(): SourceCompany[] {
  const seen = new Set<string>();
  const out: SourceCompany[] = [];
  for (const seed of [...AXILOR, ...INDIA_STARTUPS]) {
    const key = seed.domain.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toCompany(seed));
  }
  return out;
}
