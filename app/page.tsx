export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center min-h-screen px-6">
      <h1
        className="text-4xl font-bold tracking-tight lowercase"
        style={{ fontFamily: "var(--font-display)", color: "var(--text-primary)" }}
      >
        blooming insights
      </h1>
      <p
        className="mt-3 text-base lowercase"
        style={{ color: "var(--text-secondary)" }}
      >
        your thinking, in bloom
      </p>
    </main>
  );
}
