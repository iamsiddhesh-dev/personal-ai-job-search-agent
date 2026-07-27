import { redirect } from "next/navigation";

// The hunt experience is now the main UI, served at "/". This route stays
// only so old links to /hunt keep working.
export default function HuntPage() {
  redirect("/");
}
