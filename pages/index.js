import dynamic from "next/dynamic";
const KuroManga = dynamic(() => import("../components/KuroManga"), { ssr: false });
export default function Home() {
  return <KuroManga />;
}
