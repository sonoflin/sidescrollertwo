import type { Metadata } from "next";
import ArenaGame from "./game/ArenaGame";

export const metadata: Metadata = {
  title: "Riftbound Arena — Online Convergence Duel",
  description: "Race, power up, and defeat your rival in a best-of-three online side-scrolling arena.",
};

export default function Home() {
  return <ArenaGame />;
}
